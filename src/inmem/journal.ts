import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import { DuplicateSequenceNrError, SnapshotDecodeError, type Journal } from "../core/journal-store.js";
import type { EventEnvelope } from "../core/envelope.js";
import type { CategoryEventRecord, CategoryEventSource, TailOptions } from "../core/event-source.js";

export type { Journal } from "../core/journal-store.js";

// Stored event entry

interface StoredEvent {
  globalSeq: number;
  sequenceNr: SequenceNr;
  manifest: string;
  data: unknown;
  envelope?: EventEnvelope;
}

/** A stored event broadcast to live tail subscribers. */
interface LiveRecord {
  globalSeq: number;
  category: CategoryId;
  entityId: EntityId;
  stored: StoredEvent;
}

/**
 * In-memory journal with live category tails — the in-memory counterpart of
 * `SqliteJournal.tailAllEvents` (which polls instead of subscribing).
 */
export interface InMemoryJournal extends Journal {
  /**
   * Follow a whole category indefinitely: current contents first
   * (entity-grouped, sequence-ascending), then live events as they are
   * written. An event persisted while the backlog is being emitted reaches
   * both paths; a per-entity sequence-number filter absorbs the overlap, so
   * nothing is lost or double-delivered. Never completes on its own — abort
   * via opts.signal.
   */
  tailAllEvents<E>(
    category: CategoryId,
    codec: Codec<E>,
    opts?: TailOptions,
  ): AsyncIterable<CategoryEventRecord<E>>;

  /** A CategoryEventSource over tailAllEvents with one codec per category. */
  categoryEventSource(codecs: Map<string, Codec<any>>, opts?: TailOptions): CategoryEventSource;
}

interface StoredSnapshot {
  sequenceNr: SequenceNr;
  manifest: string;
  data: unknown;
}

function persistenceKey(categoryId: CategoryId, entityId: EntityId): string {
  return `${categoryId}:${entityId}`;
}

// In-memory journal implementation

export function createInMemoryJournal(): InMemoryJournal {
  const events = new Map<string, StoredEvent[]>();
  const snapshots = new Map<string, StoredSnapshot>();
  let globalSeq = 0;
  const listeners = new Set<(r: LiveRecord) => void>();

  return {
    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      newEvents: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
      envelopes?: EventEnvelope[],
    ): SequenceNr {
      if (newEvents.length === 0) return startSequenceNr;

      const key = persistenceKey(categoryId, entityId);
      const existing = events.get(key) ?? [];

      const stored = newEvents.map((event, idx): StoredEvent => ({
        globalSeq: globalSeq + idx + 1,
        sequenceNr: mkSeqNr(startSequenceNr + idx + 1),
        manifest: codec.manifest(event),
        data: codec.encode(event),
        ...(envelopes?.[idx] !== undefined && { envelope: envelopes[idx] }),
      }));

      // Reject before mutating: the whole batch is all-or-nothing, matching
      // the constraint SQLite's primary key enforces.
      const taken = new Set<number>(existing.map((e) => e.sequenceNr));
      const duplicate = stored.find((s) => taken.has(s.sequenceNr));
      if (duplicate !== undefined) {
        throw new DuplicateSequenceNrError(categoryId, entityId, duplicate.sequenceNr);
      }

      globalSeq += stored.length;
      events.set(key, [...existing, ...stored]);
      for (const s of stored) {
        for (const listener of listeners) {
          listener({ globalSeq: s.globalSeq, category: categoryId, entityId, stored: s });
        }
      }
      return mkSeqNr(startSequenceNr + newEvents.length);
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      const key = persistenceKey(categoryId, entityId);
      const stored = events.get(key) ?? [];
      return stored
        .filter((e) => e.sequenceNr > fromSequenceNr)
        .map((e) => ({
          sequenceNr: e.sequenceNr,
          event: codec.decode(e.manifest, e.data),
        }));
    },

    persistSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      state: S,
      sequenceNr: SequenceNr,
      codec: Codec<S>,
    ): void {
      const key = persistenceKey(categoryId, entityId);
      snapshots.set(key, {
        sequenceNr,
        manifest: codec.manifest(state),
        data: codec.encode(state),
      });
    },

    loadSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      codec: Codec<S>,
    ): { sequenceNr: SequenceNr; state: S } | undefined {
      const key = persistenceKey(categoryId, entityId);
      const snap = snapshots.get(key);
      if (!snap) return undefined;
      try {
        return {
          sequenceNr: snap.sequenceNr,
          state: codec.decode(snap.manifest, snap.data),
        };
      } catch (e) {
        throw new SnapshotDecodeError(categoryId, entityId, e);
      }
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      const result: Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> = [];
      const prefix = `${categoryId}:`;
      for (const [key, stored] of events) {
        if (!key.startsWith(prefix)) continue;
        const entityId = key.slice(prefix.length) as EntityId;
        for (const e of stored) {
          result.push({
            entityId,
            sequenceNr: e.sequenceNr,
            event: codec.decode(e.manifest, e.data),
          });
        }
      }
      return result;
    },

    async *tailAllEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
      opts?: TailOptions,
    ): AsyncIterable<CategoryEventRecord<E>> {
      const signal = opts?.signal;
      const queue: LiveRecord[] = [];
      let wake: (() => void) | undefined;
      // Subscribe FIRST, then snapshot the backlog — no event can fall
      // between the two (both happen synchronously before the first await).
      const listener = (r: LiveRecord) => {
        if (r.category === categoryId) {
          queue.push(r);
          wake?.();
        }
      };
      listeners.add(listener);
      const onAbort = () => wake?.();
      signal?.addEventListener("abort", onAbort, { once: true });

      const toRecord = (entityId: EntityId, s: StoredEvent): CategoryEventRecord<E> => ({
        globalSeq: s.globalSeq,
        category: categoryId,
        entityId,
        sequenceNr: s.sequenceNr,
        event: codec.decode(s.manifest, s.data),
        envelope: s.envelope ?? null,
      });

      try {
        // Backlog snapshot (entity-grouped, sequence-ascending) with the
        // per-entity high-water mark used to absorb the live-overlap seam.
        const prefix = `${categoryId}:`;
        const backlog: Array<{ entityId: EntityId; stored: StoredEvent }> = [];
        for (const [key, stored] of events) {
          if (!key.startsWith(prefix)) continue;
          const entityId = key.slice(prefix.length) as EntityId;
          for (const s of stored) backlog.push({ entityId, stored: s });
        }
        const emitted = new Map<string, number>();
        const after = opts?.afterGlobalSeq ?? 0;
        for (const { entityId, stored } of backlog) {
          emitted.set(entityId, Math.max(emitted.get(entityId) ?? 0, stored.sequenceNr));
          if (stored.globalSeq <= after) continue;
          yield toRecord(entityId, stored);
          if (signal?.aborted) return;
        }

        // Live phase: drain the queue, skipping anything the backlog already
        // covered (an event persisted mid-backlog reaches both paths).
        while (!signal?.aborted) {
          while (queue.length > 0) {
            const r = queue.shift()!;
            const last = emitted.get(r.entityId) ?? 0;
            if (r.stored.sequenceNr <= last) continue;
            emitted.set(r.entityId, r.stored.sequenceNr);
            if (r.globalSeq <= (opts?.afterGlobalSeq ?? 0)) continue;
            yield toRecord(r.entityId, r.stored);
            if (signal?.aborted) return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (signal?.aborted || queue.length > 0) resolve();
          });
          wake = undefined;
        }
      } finally {
        listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    categoryEventSource(codecs: Map<string, Codec<any>>, opts?: TailOptions): CategoryEventSource {
      const self = this;
      return {
        tailCategoryEvents(category: CategoryId): AsyncIterable<CategoryEventRecord> {
          const codec = codecs.get(category);
          if (codec === undefined) {
            throw new Error(`No event codec registered for category '${category}'`);
          }
          return self.tailAllEvents(category, codec, opts);
        },
      };
    },
  };
}
