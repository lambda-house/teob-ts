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
  /** Put a view document. */
  put<View>(projectionId: string, viewId: string, envelope: ViewEnvelope<View>): void;
  /** List all view documents for a projection. */
  list<View>(projectionId: string): ViewEnvelope<View>[];
  /** Get the last processed sequence number for a projection+category+entityId. */
  getOffset(projectionId: string, category: string, entityId: string): SequenceNr;
  /** Set the last processed sequence number. */
  setOffset(projectionId: string, category: string, entityId: string, sequenceNr: SequenceNr): void;
  /** Clear all data for a projection (for rebuild). */
  clear(projectionId: string): void;
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

  return {
    get<View>(projectionId: string, viewId: string): ViewEnvelope<View> | undefined {
      return views.get(viewKey(projectionId, viewId));
    },
    put<View>(projectionId: string, viewId: string, envelope: ViewEnvelope<View>): void {
      views.set(viewKey(projectionId, viewId), envelope);
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
  };
}

// --- Projection Runner ---

/** Options for running projections. */
export interface RunProjectionOptions {
  /** Event codec. If not provided, uses a default tagCodec. */
  eventCodec?: Codec<any>;
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
    const lastSeqNr = store.getOffset(proj.projectionId, proj.category, entityId);
    if (sequenceNr <= lastSeqNr) continue; // already processed

    const viewId = entityId;
    const existing = store.get<View>(proj.projectionId, viewId);
    const currentView = existing?.view ?? proj.initialState();

    const newView = proj.evolve(currentView, event, entityId);
    store.put(proj.projectionId, viewId, {
      viewId,
      view: newView,
      sequenceNr,
    });
    store.setOffset(proj.projectionId, proj.category, entityId, sequenceNr);
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
      const lastSeqNr = store.getOffset(proj.projectionId, source.category, entityId);
      if (sequenceNr <= lastSeqNr) continue;

      const viewId = source.getViewId(event, entityId);
      const existing = store.get<View>(proj.projectionId, viewId);
      const currentView = existing?.view ?? proj.initialState();

      const newView = proj.evolve(currentView, event, entityId);
      store.put(proj.projectionId, viewId, {
        viewId,
        view: newView,
        sequenceNr,
      });
      store.setOffset(proj.projectionId, source.category, entityId, sequenceNr);
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

  const upsertView = db.prepare(`
    INSERT INTO projection_views (projection_id, view_id, view_data, sequence_nr)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(projection_id, view_id) DO UPDATE SET
      view_data = excluded.view_data,
      sequence_nr = excluded.sequence_nr
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

  return {
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
      upsertView.run(projectionId, viewId, JSON.stringify(envelope.view), envelope.sequenceNr);
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
  };
}

// --- Poll/nudge runner ---

export * from "./runner.js";
