import type {
  AggregationId,
  Aggregation,
  ApplyEvent,
  GetState,
  GetLastOrdinal,
  HasPersistenceId,
  HasOrdinal,
  Consistency,
  OnGap,
} from "./aggregation.js";
import { createAggregation } from "./aggregation.js";

// --- ReadModelMetrics ---

export interface ReadModelMetrics {
  activeEntitiesIncrement(): void;
  activeEntitiesDecrement(): void;
  recordEntryLifetime(seconds: number): void;
  timedApplyEvent<T>(fn: () => Promise<T>): Promise<T>;
}

export const noopMetrics: ReadModelMetrics = {
  activeEntitiesIncrement() {},
  activeEntitiesDecrement() {},
  recordEntryLifetime() {},
  async timedApplyEvent<T>(fn: () => Promise<T>) {
    return fn();
  },
};

// --- ReadModelCache ---

interface CacheEntry<State> {
  /** Left = best-effort, Right = consistent */
  state: State;
  consistent: boolean;
  createdAt: number;
  accessAt: number;
}

interface ReadModelCache<PersistenceId, State> {
  get(id: PersistenceId): State | undefined;
  updateBestEffort(id: PersistenceId, state: State): State;
  updateConsistent(id: PersistenceId, state: State): State;
  remove(id: PersistenceId): void;
  list(): State[];
  stopEviction(): void;
}

function createCache<PersistenceId extends string | number, State>(
  ttlMs: number,
  metrics: ReadModelMetrics,
): ReadModelCache<PersistenceId, State> {
  const entries = new Map<PersistenceId, CacheEntry<State>>();

  const evictionInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.accessAt + ttlMs < now) {
        entries.delete(key);
        metrics.activeEntitiesDecrement();
        metrics.recordEntryLifetime((now - entry.createdAt) / 1000);
      }
    }
  }, ttlMs);
  // Don't keep the process alive just for cache eviction
  if (evictionInterval.unref) evictionInterval.unref();

  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      entry.accessAt = Date.now();
      return entry.state;
    },

    updateBestEffort(id, state) {
      const existing = entries.get(id);
      if (existing) {
        // Don't overwrite consistent state with best-effort
        if (existing.consistent) return existing.state;
        existing.state = state;
        return state;
      }
      const now = Date.now();
      entries.set(id, { state, consistent: false, createdAt: now, accessAt: now });
      metrics.activeEntitiesIncrement();
      return state;
    },

    updateConsistent(id, state) {
      const existing = entries.get(id);
      if (existing) {
        existing.state = state;
        existing.consistent = true;
        return state;
      }
      const now = Date.now();
      entries.set(id, { state, consistent: true, createdAt: now, accessAt: now });
      metrics.activeEntitiesIncrement();
      return state;
    },

    remove(id) {
      const entry = entries.get(id);
      if (entry) {
        entries.delete(id);
        metrics.activeEntitiesDecrement();
        metrics.recordEntryLifetime((Date.now() - entry.createdAt) / 1000);
      }
    },

    list() {
      return Array.from(entries.values()).map((e) => e.state);
    },

    stopEviction() {
      clearInterval(evictionInterval);
    },
  };
}

// --- ReadModel ---

export interface ReadModel<PersistenceId, Event, State, Ordinal>
  extends Aggregation<PersistenceId, Event, Ordinal> {
  /** Get current state for the given persistence id. */
  get(id: PersistenceId): Promise<State>;
  /** List all cached states. */
  list(): State[];
  /** Stop background eviction timer. Call on shutdown. */
  close(): void;
}

export function createReadModel<
  PersistenceId extends string | number,
  Event,
  Ordinal,
  State,
>(opts: {
  readModelId: AggregationId;
  cacheTtlMs: number;
  metrics?: ReadModelMetrics;
  getState: GetState<PersistenceId, State>;
  applyEvent: ApplyEvent<State, Event, Ordinal>;
  onGap: OnGap<PersistenceId, Event, Ordinal, State>;
  getLastOrdinal: GetLastOrdinal<PersistenceId, Ordinal>;
  eventHasId: HasPersistenceId<Event, PersistenceId>;
  stateHasOrdinal: HasOrdinal<State, Ordinal>;
  consistency: Consistency<Ordinal>;
}): ReadModel<PersistenceId, Event, State, Ordinal> {
  const {
    readModelId,
    cacheTtlMs,
    metrics = noopMetrics,
    getState,
    applyEvent,
    onGap,
    getLastOrdinal,
    eventHasId,
    stateHasOrdinal,
    consistency,
  } = opts;

  const cache = createCache<PersistenceId, State>(cacheTtlMs, metrics);

  // Wrap applyEvent to update cache on apply
  const applyAndUpdateCache: ApplyEvent<State, Event, Ordinal> = {
    async apply(state, event, ordinal) {
      const newState = await metrics.timedApplyEvent(() =>
        applyEvent.apply(state, event, ordinal),
      );
      const id = eventHasId(event);
      cache.updateConsistent(id, newState);
      return newState;
    },
  };

  const aggregation = createAggregation({
    aggregationId: readModelId,
    getOrdinalInterval: (persistenceId) =>
      getLastOrdinal(persistenceId).then((ord) => [ord, undefined]),
    getState,
    applyEvent: applyAndUpdateCache,
    onGap,
    eventHasId,
    stateHasOrdinal,
    consistency,
  });

  return {
    aggregationId: readModelId,

    interval(persistenceId) {
      return aggregation.interval(persistenceId);
    },

    subscribe(events) {
      return aggregation.subscribe(events);
    },

    async get(id) {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const state = await getState(id);
      cache.updateBestEffort(id, state);
      return state;
    },

    list() {
      return cache.list();
    },

    close() {
      cache.stopEviction();
    },
  };
}
