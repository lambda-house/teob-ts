// projection — declarative read model projections

import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import { tagCodec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";

// Re-export for convenience
export type { Journal } from "../core/journal-store.js";

// --- Projection Definitions ---

/** Single-stream projection: one entity → one view document. */
export interface SingleStreamProjection<Event, View> {
  projectionId: string;
  category: string;
  evolve: (view: View, event: Event, entityId: EntityId) => View;
  initialState: () => View;
}

/** Source descriptor for multi-stream projections. */
export interface ProjectionSource<Event> {
  category: string;
  getViewId: (event: Event, entityId: EntityId) => string;
}

/** Multi-stream projection: events from multiple categories → shared view. */
export interface MultiStreamProjection<Event, View> {
  projectionId: string;
  sources: ProjectionSource<Event>[];
  evolve: (view: View, event: Event, entityId: EntityId) => View;
  initialState: () => View;
}

/** Union of projection types. */
export type Projection<Event, View> =
  | SingleStreamProjection<Event, View>
  | MultiStreamProjection<Event, View>;

/** Type guard: is this a single-stream projection? */
function isSingleStream<E, V>(p: Projection<E, V>): p is SingleStreamProjection<E, V> {
  return "category" in p && !("sources" in p);
}

// --- Projection factory ---

/** Create a single-stream projection (one entity → one view). */
export function projection<Event extends { tag: string }, View>(
  config: SingleStreamProjection<Event, View>,
): SingleStreamProjection<Event, View>;

/** Create a multi-stream projection (events from multiple categories → shared view). */
export function projection<Event extends { tag: string }, View>(
  config: MultiStreamProjection<Event, View>,
): MultiStreamProjection<Event, View>;

export function projection<Event extends { tag: string }, View>(
  config: SingleStreamProjection<Event, View> | MultiStreamProjection<Event, View>,
): Projection<Event, View> {
  return config;
}

// --- Projection Store ---

/** View document with tracked sequence number. */
export interface ViewEnvelope<View> {
  viewId: string;
  view: View;
  sequenceNr: SequenceNr;
}

/** Store for projection view documents. */
export interface ProjectionStore {
  /** Get a view document by projection ID and view ID. */
  get<View>(projectionId: string, viewId: string): ViewEnvelope<View> | undefined;
  /**
   * Put a view document. Monotonic: a write carrying a sequence number at or
   * below the stored view's is ignored — a rebuild racing the live projection
   * must not roll the view back (the row would claim events it no longer
   * reflects, and those events would never be re-applied).
   */
  put<View>(projectionId: string, viewId: string, envelope: ViewEnvelope<View>): void;
  /**
   * Atomically write the view AND advance the per-(category, entityId) offset
   * — the fold's write path. A crash between separate put and setOffset calls
   * re-applies the event on restart and double-folds the view, permanently.
   * A stale write (envelope.sequenceNr at or below the current offset) is a
   * complete no-op on BOTH halves: neither may regress, or an advanced offset
   * over a rolled-back view silently skips everything in between.
   */
  putWithOffset<View>(
    projectionId: string,
    viewId: string,
    envelope: ViewEnvelope<View>,
    category: string,
    entityId: string,
  ): void;
  /** List all view documents for a projection. */
  list<View>(projectionId: string): ViewEnvelope<View>[];
  /** Get the last processed sequence number for a projection+category+entityId. */
  getOffset(projectionId: string, category: string, entityId: string): SequenceNr;
  /**
   * Set the last processed sequence number. Deliberately NOT monotonic — an
   * explicit rewind to force reprocessing is legitimate; the fold path is not.
   */
  setOffset(projectionId: string, category: string, entityId: string, sequenceNr: SequenceNr): void;
  /** Clear all data for a projection (for rebuild). */
  clear(projectionId: string): void;
  /**
   * Observe one view: emits the current envelope immediately (when present),
   * then every effective update. Returns an unsubscribe function. Listeners
   * are process-local.
   */
  subscribe(
    projectionId: string,
    viewId: string,
    listener: (envelope: ViewEnvelope<unknown>) => void,
  ): () => void;
  /** Observe every effective view write of a projection (updates only). */
  subscribeAll(
    projectionId: string,
    listener: (envelope: ViewEnvelope<unknown>) => void,
  ): () => void;
  /**
   * Resolve with the first view satisfying the predicate — immediately when
   * the current view already does, otherwise on a later write. Rejects after
   * `timeoutMs` (default 5000).
   */
  awaitView<View>(
    projectionId: string,
    viewId: string,
    predicate: (view: View) => boolean,
    timeoutMs?: number,
  ): Promise<View>;
}

// Process-local view listeners, shared by both store implementations.
function createViewNotifier() {
  const byKey = new Map<string, Set<(e: ViewEnvelope<unknown>) => void>>();
  const byProjection = new Map<string, Set<(e: ViewEnvelope<unknown>) => void>>();

  function addTo(map: Map<string, Set<(e: ViewEnvelope<unknown>) => void>>, key: string, l: (e: ViewEnvelope<unknown>) => void) {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) map.delete(key);
    };
  }

  return {
    notify(projectionId: string, envelope: ViewEnvelope<unknown>): void {
      byKey.get(`${projectionId}:${envelope.viewId}`)?.forEach((l) => l(envelope));
      byProjection.get(projectionId)?.forEach((l) => l(envelope));
    },
    onKey: (projectionId: string, viewId: string, l: (e: ViewEnvelope<unknown>) => void) =>
      addTo(byKey, `${projectionId}:${viewId}`, l),
    onProjection: (projectionId: string, l: (e: ViewEnvelope<unknown>) => void) =>
      addTo(byProjection, projectionId, l),
  };
}

// awaitView in terms of get + subscribe — identical for every store.
function awaitViewOn<View>(
  store: Pick<ProjectionStore, "get" | "subscribe">,
  projectionId: string,
  viewId: string,
  predicate: (view: View) => boolean,
  timeoutMs = 5_000,
): Promise<View> {
  return new Promise<View>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe?.();
        reject(new Error(`awaitView timed out after ${timeoutMs}ms for ${projectionId}/${viewId}`));
      }
    }, timeoutMs);
    const check = (view: View) => {
      if (!settled && predicate(view)) {
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(view);
      }
    };
    unsubscribe = store.subscribe(projectionId, viewId, (e) => check(e.view as View));
    // subscribe emits the current view synchronously when present; if that
    // already settled us, drop the subscription right away.
    if (settled) unsubscribe();
  });
}

/** Create an in-memory projection store. */
export function createInMemoryProjectionStore(): ProjectionStore {
  // views: Map<`${projectionId}:${viewId}`, ViewEnvelope>
  const views = new Map<string, ViewEnvelope<any>>();
  // offsets: Map<`${projectionId}:${category}:${entityId}`, SequenceNr>
  const offsets = new Map<string, SequenceNr>();

  function viewKey(projectionId: string, viewId: string): string {
    return `${projectionId}:${viewId}`;
  }

  function offsetKey(projectionId: string, category: string, entityId: string): string {
    return `${projectionId}:${category}:${entityId}`;
  }

  const notifier = createViewNotifier();

  const store: ProjectionStore = {
    get<View>(projectionId: string, viewId: string): ViewEnvelope<View> | undefined {
      return views.get(viewKey(projectionId, viewId));
    },
    put<View>(projectionId: string, viewId: string, envelope: ViewEnvelope<View>): void {
      const existing = views.get(viewKey(projectionId, viewId));
      if (existing !== undefined && envelope.sequenceNr <= existing.sequenceNr) return;
      views.set(viewKey(projectionId, viewId), envelope);
      notifier.notify(projectionId, envelope);
    },
    putWithOffset<View>(
      projectionId: string,
      viewId: string,
      envelope: ViewEnvelope<View>,
      category: string,
      entityId: string,
    ): void {
      const currentOffset = offsets.get(offsetKey(projectionId, category, entityId)) ?? mkSeqNr(0);
      if (envelope.sequenceNr <= currentOffset) return; // stale — complete no-op
      const existing = views.get(viewKey(projectionId, viewId));
      // Under multi-source folds different entities feed one view; the stored
      // view seqNr only ever moves forward.
      const effective: ViewEnvelope<View> = {
        ...envelope,
        sequenceNr: mkSeqNr(Math.max(envelope.sequenceNr, existing?.sequenceNr ?? 0)),
      };
      views.set(viewKey(projectionId, viewId), effective);
      offsets.set(offsetKey(projectionId, category, entityId), envelope.sequenceNr);
      notifier.notify(projectionId, effective);
    },
    list<View>(projectionId: string): ViewEnvelope<View>[] {
      const prefix = `${projectionId}:`;
      const result: ViewEnvelope<View>[] = [];
      for (const [key, envelope] of views) {
        if (key.startsWith(prefix)) result.push(envelope);
      }
      return result;
    },
    getOffset(projectionId: string, category: string, entityId: string): SequenceNr {
      return offsets.get(offsetKey(projectionId, category, entityId)) ?? mkSeqNr(0);
    },
    setOffset(projectionId: string, category: string, entityId: string, sequenceNr: SequenceNr): void {
      offsets.set(offsetKey(projectionId, category, entityId), sequenceNr);
    },
    clear(projectionId: string): void {
      const viewPrefix = `${projectionId}:`;
      for (const key of [...views.keys()]) {
        if (key.startsWith(viewPrefix)) views.delete(key);
      }
      for (const key of [...offsets.keys()]) {
        if (key.startsWith(viewPrefix)) offsets.delete(key);
      }
    },
    subscribe(projectionId, viewId, listener) {
      const unsubscribe = notifier.onKey(projectionId, viewId, listener);
      const current = views.get(viewKey(projectionId, viewId));
      if (current !== undefined) listener(current);
      return unsubscribe;
    },
    subscribeAll(projectionId, listener) {
      return notifier.onProjection(projectionId, listener);
    },
    awaitView<View>(projectionId: string, viewId: string, predicate: (v: View) => boolean, timeoutMs?: number) {
      return awaitViewOn<View>(store, projectionId, viewId, predicate, timeoutMs);
    },
  };
  return store;
}

// --- Projection Runner ---

/** Options for running projections. */
export interface RunProjectionOptions {
  /** Event codec. If not provided, uses a default tagCodec. */
  eventCodec?: Codec<any>;
}

/**
 * The one fold shared by every projection runner: skip already-processed
 * events, evolve the view, and commit view + offset in ONE atomic
 * `putWithOffset` — never as separate put/setOffset calls, whose crash window
 * double-folds the view on restart (port of Scala's OffsetGuardedFold).
 *
 * Returns true when the event was applied, false when it was already folded.
 */
export function offsetGuardedFold<Event, View>(
  store: ProjectionStore,
  opts: {
    projectionId: string;
    category: string;
    entityId: EntityId;
    sequenceNr: SequenceNr;
    viewId: string;
    initialState: () => View;
    evolve: (view: View, event: Event, entityId: EntityId) => View;
    event: Event;
  },
): boolean {
  const lastSeqNr = store.getOffset(opts.projectionId, opts.category, opts.entityId);
  if (opts.sequenceNr <= lastSeqNr) return false; // already processed

  const existing = store.get<View>(opts.projectionId, opts.viewId);
  const currentView = existing?.view ?? opts.initialState();
  const newView = opts.evolve(currentView, opts.event, opts.entityId);
  store.putWithOffset(
    opts.projectionId,
    opts.viewId,
    { viewId: opts.viewId, view: newView, sequenceNr: opts.sequenceNr },
    opts.category,
    opts.entityId,
  );
  return true;
}

/**
 * Run a single-stream projection against a journal, updating the store.
 *
 * Processes all events for the projection's category from the journal,
 * applying the `evolve` function to build view documents.
 * Tracks sequence numbers for resumability — subsequent calls only process new events.
 */
export function runProjection<Event extends { tag: string }, View>(
  proj: SingleStreamProjection<Event, View>,
  journal: Journal,
  store: ProjectionStore,
  opts?: RunProjectionOptions,
): void {
  const codec = (opts?.eventCodec ?? tagCodec<Event>()) as Codec<Event>;
  const categoryId = proj.category as CategoryId;

  const allEvents = journal.allEvents<Event>(categoryId, codec);

  for (const { entityId, sequenceNr, event } of allEvents) {
    offsetGuardedFold(store, {
      projectionId: proj.projectionId,
      category: proj.category,
      entityId,
      sequenceNr,
      viewId: entityId,
      initialState: proj.initialState,
      evolve: proj.evolve,
      event,
    });
  }
}

/**
 * Run a multi-stream projection against a journal, updating the store.
 *
 * Processes events from all source categories, routing each event to a view
 * determined by the source's `getViewId` function.
 */
export function runMultiStreamProjection<Event extends { tag: string }, View>(
  proj: MultiStreamProjection<Event, View>,
  journal: Journal,
  store: ProjectionStore,
  opts?: RunProjectionOptions,
): void {
  const codec = (opts?.eventCodec ?? tagCodec<Event>()) as Codec<Event>;

  for (const source of proj.sources) {
    const categoryId = source.category as CategoryId;
    const allEvents = journal.allEvents<Event>(categoryId, codec);

    for (const { entityId, sequenceNr, event } of allEvents) {
      offsetGuardedFold(store, {
        projectionId: proj.projectionId,
        category: source.category,
        entityId,
        sequenceNr,
        viewId: source.getViewId(event, entityId),
        initialState: proj.initialState,
        evolve: proj.evolve,
        event,
      });
    }
  }
}

/**
 * Rebuild a projection from scratch by clearing the store and reprocessing all events.
 */
export function rebuildProjection<Event extends { tag: string }, View>(
  proj: SingleStreamProjection<Event, View>,
  journal: Journal,
  store: ProjectionStore,
  opts?: RunProjectionOptions,
): void {
  store.clear(proj.projectionId);
  runProjection(proj, journal, store, opts);
}

/**
 * Rebuild a multi-stream projection from scratch.
 */
export function rebuildMultiStreamProjection<Event extends { tag: string }, View>(
  proj: MultiStreamProjection<Event, View>,
  journal: Journal,
  store: ProjectionStore,
  opts?: RunProjectionOptions,
): void {
  store.clear(proj.projectionId);
  runMultiStreamProjection(proj, journal, store, opts);
}

// --- SQLite Projection Store ---

/**
 * Create a ProjectionStore backed by a SQLite database (better-sqlite3).
 *
 * Auto-creates the required tables on first use. Can share a database
 * file with SqliteJournal, or use a separate one.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const db = new Database("./data/projections.db");
 * const store = createSqliteProjectionStore(db);
 * ```
 */
export function createSqliteProjectionStore(db: any): ProjectionStore {
  // Auto-migrate schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_views (
      projection_id TEXT NOT NULL,
      view_id       TEXT NOT NULL,
      view_data     TEXT NOT NULL,
      sequence_nr   INTEGER NOT NULL,
      PRIMARY KEY (projection_id, view_id)
    );

    CREATE TABLE IF NOT EXISTS projection_offsets (
      projection_id TEXT NOT NULL,
      category      TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      sequence_nr   INTEGER NOT NULL,
      PRIMARY KEY (projection_id, category, entity_id)
    );
  `);

  const getView = db.prepare(
    "SELECT view_id, view_data, sequence_nr FROM projection_views WHERE projection_id = ? AND view_id = ?",
  );

  // Monotonic upsert: the update half only fires for a strictly newer write.
  const upsertView = db.prepare(`
    INSERT INTO projection_views (projection_id, view_id, view_data, sequence_nr)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(projection_id, view_id) DO UPDATE SET
      view_data = excluded.view_data,
      sequence_nr = excluded.sequence_nr
    WHERE excluded.sequence_nr > projection_views.sequence_nr
  `);

  // Fold-path upsert: view data always applies (the offset guard already
  // decided this event is new for its source entity), but the stored view
  // seqNr only ever moves forward — multi-source folds feed one view from
  // entities at unrelated sequence numbers.
  const upsertViewForFold = db.prepare(`
    INSERT INTO projection_views (projection_id, view_id, view_data, sequence_nr)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(projection_id, view_id) DO UPDATE SET
      view_data = excluded.view_data,
      sequence_nr = MAX(excluded.sequence_nr, projection_views.sequence_nr)
  `);

  const listViews = db.prepare(
    "SELECT view_id, view_data, sequence_nr FROM projection_views WHERE projection_id = ?",
  );

  const getOff = db.prepare(
    "SELECT sequence_nr FROM projection_offsets WHERE projection_id = ? AND category = ? AND entity_id = ?",
  );

  const upsertOff = db.prepare(`
    INSERT INTO projection_offsets (projection_id, category, entity_id, sequence_nr)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(projection_id, category, entity_id) DO UPDATE SET
      sequence_nr = excluded.sequence_nr
  `);

  const clearViews = db.prepare("DELETE FROM projection_views WHERE projection_id = ?");
  const clearOffsets = db.prepare("DELETE FROM projection_offsets WHERE projection_id = ?");

  const notifier = createViewNotifier();

  // One transaction for the fold path: offset guard, view write and offset
  // advance commit or skip together — a crash cannot leave a new offset over
  // an old view (skipping events forever) or an updated view that will be
  // double-folded on restart.
  const foldTxn = db.transaction(
    (
      projectionId: string,
      viewId: string,
      viewJson: string,
      sequenceNr: number,
      category: string,
      entityId: string,
    ): boolean => {
      const row = getOff.get(projectionId, category, entityId) as { sequence_nr: number } | undefined;
      if (sequenceNr <= (row?.sequence_nr ?? 0)) return false;
      upsertViewForFold.run(projectionId, viewId, viewJson, sequenceNr);
      upsertOff.run(projectionId, category, entityId, sequenceNr);
      return true;
    },
  );

  const store: ProjectionStore = {
    get<View>(projectionId: string, viewId: string): ViewEnvelope<View> | undefined {
      const row = getView.get(projectionId, viewId) as
        | { view_id: string; view_data: string; sequence_nr: number }
        | undefined;
      if (!row) return undefined;
      return {
        viewId: row.view_id,
        view: JSON.parse(row.view_data),
        sequenceNr: mkSeqNr(row.sequence_nr),
      };
    },

    put<View>(projectionId: string, viewId: string, envelope: ViewEnvelope<View>): void {
      const result = upsertView.run(
        projectionId,
        viewId,
        JSON.stringify(envelope.view),
        envelope.sequenceNr,
      );
      if (result.changes > 0) notifier.notify(projectionId, envelope);
    },

    putWithOffset<View>(
      projectionId: string,
      viewId: string,
      envelope: ViewEnvelope<View>,
      category: string,
      entityId: string,
    ): void {
      const applied = foldTxn(
        projectionId,
        viewId,
        JSON.stringify(envelope.view),
        envelope.sequenceNr,
        category,
        entityId,
      ) as boolean;
      if (applied) {
        const effective = store.get<View>(projectionId, viewId);
        if (effective !== undefined) notifier.notify(projectionId, effective);
      }
    },

    list<View>(projectionId: string): ViewEnvelope<View>[] {
      const rows = listViews.all(projectionId) as Array<{
        view_id: string;
        view_data: string;
        sequence_nr: number;
      }>;
      return rows.map((row) => ({
        viewId: row.view_id,
        view: JSON.parse(row.view_data),
        sequenceNr: mkSeqNr(row.sequence_nr),
      }));
    },

    getOffset(projectionId: string, category: string, entityId: string): SequenceNr {
      const row = getOff.get(projectionId, category, entityId) as { sequence_nr: number } | undefined;
      return mkSeqNr(row?.sequence_nr ?? 0);
    },

    setOffset(projectionId: string, category: string, entityId: string, sequenceNr: SequenceNr): void {
      upsertOff.run(projectionId, category, entityId, sequenceNr);
    },

    clear(projectionId: string): void {
      clearViews.run(projectionId);
      clearOffsets.run(projectionId);
    },

    subscribe(projectionId, viewId, listener) {
      const unsubscribe = notifier.onKey(projectionId, viewId, listener);
      const current = store.get(projectionId, viewId);
      if (current !== undefined) listener(current);
      return unsubscribe;
    },

    subscribeAll(projectionId, listener) {
      return notifier.onProjection(projectionId, listener);
    },

    awaitView<View>(projectionId: string, viewId: string, predicate: (v: View) => boolean, timeoutMs?: number) {
      return awaitViewOn<View>(store, projectionId, viewId, predicate, timeoutMs);
    },
  };
  return store;
}

// --- Poll/nudge runner ---

export * from "./runner.js";

// --- Tailing runner (endless sources) ---

export * from "./tailing.js";
