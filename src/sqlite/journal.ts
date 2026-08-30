// SQLite journal — persistent event/snapshot storage using better-sqlite3

import Database from "better-sqlite3";
import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import { DuplicateSequenceNrError, SnapshotDecodeError, type Journal } from "../core/journal-store.js";
import type {
  EventEnvelope,
  JournalQuery,
  JournalQueryRow,
  JournalReader,
} from "../core/envelope.js";
import {
  abortableSleep,
  type CategoryEventRecord,
  type CategoryEventSource,
  type TailOptions,
} from "../core/event-source.js";

const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_POLL_INTERVAL_MS = 250;

function persistenceKey(categoryId: CategoryId, entityId: EntityId): string {
  return `${categoryId}:${entityId}`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal (
  persistence_id TEXT NOT NULL,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (persistence_id, sequence_nr)
);

CREATE TABLE IF NOT EXISTS snapshots (
  persistence_id TEXT NOT NULL PRIMARY KEY,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export interface SqliteJournalOptions {
  /** Database file path, or ":memory:" for in-memory. */
  path: string;
  /** Enable WAL mode. Defaults to true. */
  wal?: boolean;
}

/**
 * SQLite journal with envelope metadata columns and a read-side query API.
 *
 * NOTE: never VACUUM the journal database — `rowid` is the global cursor
 * (`globalSeq`) and VACUUM may renumber it.
 */
export interface SqliteJournal extends Journal, JournalReader {
  /** Close the database connection. */
  close(): void;
  /** The underlying better-sqlite3 Database instance. */
  readonly db: Database.Database;
  /** MAX(rowid) of the journal table, 0 when empty. */
  lastGlobalSeq(): number;

  // ---- streaming reads (B5) ----

  /**
   * Follow one entity indefinitely: backlog first (keyset-paged on
   * sequence_nr), then live events as they are written. Never completes on
   * its own — abort via opts.signal.
   */
  tailEvents<E>(
    category: CategoryId,
    entityId: EntityId,
    codec: Codec<E>,
    opts?: { afterSequenceNr?: number; pollIntervalMs?: number; pageSize?: number; signal?: AbortSignal },
  ): AsyncIterable<{ sequenceNr: SequenceNr; event: E }>;

  /**
   * Follow a whole category indefinitely, in INSERTION order (rowid), not
   * entity-grouped order — the only cursor that can follow live writes.
   * Caveat: SQLite may reuse a rowid after the highest rows are deleted;
   * retention deletes the oldest events, which never disturbs the tail head.
   */
  tailAllEvents<E>(
    category: CategoryId,
    codec: Codec<E>,
    opts?: TailOptions,
  ): AsyncIterable<CategoryEventRecord<E>>;

  /** A CategoryEventSource over tailAllEvents with one codec per category. */
  categoryEventSource(codecs: Map<string, Codec<any>>, opts?: TailOptions): CategoryEventSource;

  // ---- raw inspection (B6) ----

  /** Distinct entity ids stored for a category. */
  entityIds(category: CategoryId): EntityId[];
  /** Events exactly as stored (payload as JSON text), sequence-ascending. */
  rawEvents(
    category: CategoryId,
    entityId: EntityId,
    opts?: { fromSequenceNr?: number; limit?: number },
  ): Array<{ sequenceNr: number; manifest: string; payload: string }>;
  /** The stored snapshot exactly as stored, if any. */
  snapshotRaw(
    category: CategoryId,
    entityId: EntityId,
  ): { sequenceNr: number; manifest: string; payload: string } | undefined;
  /** Per-entity time of the newest event (ms epoch) — what retention keys on. */
  lastWrittenAt(category: CategoryId): Array<{ entityId: EntityId; atMs: number }>;
  /**
   * Follow ALL categories in insertion order, raw rows, live only from the
   * current end of the journal (no backlog replay).
   */
  liveRawEvents(opts?: TailOptions): AsyncIterable<{
    globalSeq: number;
    category: string;
    entityId: string;
    sequenceNr: number;
    manifest: string;
    payload: string;
  }>;
}

interface RawJournalRow {
  global_seq: number;
  persistence_id: string;
  sequence_nr: number;
  manifest: string;
  payload: string;
  timestamp: number;
  event_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  origin: string | null;
  env_v: number | null;
}

const QUERY_COLUMNS =
  "rowid AS global_seq, persistence_id, sequence_nr, manifest, payload, timestamp, event_id, causation_id, correlation_id, origin, env_v";

function mapRow(row: RawJournalRow): JournalQueryRow {
  // Categories contain no ":"; entity ids may — split on the FIRST ":".
  const sep = row.persistence_id.indexOf(":");
  const category = sep === -1 ? row.persistence_id : row.persistence_id.slice(0, sep);
  const entityId = sep === -1 ? "" : row.persistence_id.slice(sep + 1);

  let envelope: EventEnvelope | null = null;
  if (row.event_id !== null) {
    envelope = {
      eventId: row.event_id,
      v: row.env_v ?? 1,
      ...(row.causation_id !== null && { causationId: row.causation_id }),
      ...(row.correlation_id !== null && { correlationId: row.correlation_id }),
      ...(row.origin !== null && { origin: row.origin }),
    };
  }

  return {
    globalSeq: row.global_seq,
    category,
    entityId,
    sequenceNr: row.sequence_nr,
    manifest: row.manifest,
    payload: JSON.parse(row.payload),
    ts: row.timestamp,
    envelope,
  };
}

export function createSqliteJournal(opts: SqliteJournalOptions): SqliteJournal {
  const db = new Database(opts.path);

  // Enable WAL mode for better concurrent read performance
  if (opts.wal !== false) {
    db.pragma("journal_mode = WAL");
  }

  // Auto-migrate schema
  db.exec(SCHEMA_SQL);

  // Envelope columns migration — existing (pre-envelope) DBs get the five
  // nullable columns added in place; old rows read back with envelope: null.
  // Idempotent PER COLUMN: each ALTER is a separate autocommit statement, so a
  // crash mid-migration leaves a half-migrated schema — checking every column
  // (not just a sentinel) both survives that crash and repairs DBs already left
  // half-migrated by earlier versions.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const envelopeColumns: ReadonlyArray<readonly [name: string, type: string]> = [
    ["event_id", "TEXT"],
    ["causation_id", "TEXT"],
    ["correlation_id", "TEXT"],
    ["origin", "TEXT"],
    ["env_v", "INTEGER"],
  ];
  for (const [name, type] of envelopeColumns) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE journal ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_event_id ON journal(event_id) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_journal_causation ON journal(causation_id) WHERE causation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal(timestamp);
  `);

  // Prepared statements
  const insertEvent = db.prepare(
    `INSERT INTO journal (persistence_id, sequence_nr, manifest, payload, event_id, causation_id, correlation_id, origin, env_v)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const upsertSnapshot = db.prepare(`
    INSERT INTO snapshots (persistence_id, sequence_nr, manifest, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(persistence_id) DO UPDATE SET
      sequence_nr = excluded.sequence_nr,
      manifest = excluded.manifest,
      payload = excluded.payload,
      timestamp = unixepoch()
  `);

  const selectSnapshot = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM snapshots WHERE persistence_id = ?",
  );

  const selectByEventId = db.prepare(
    `SELECT ${QUERY_COLUMNS} FROM journal WHERE event_id = ?`,
  );

  const selectEventExists = db.prepare(
    "SELECT 1 FROM journal WHERE persistence_id = ? AND sequence_nr = ?",
  );

  const selectMaxGlobalSeq = db.prepare(
    "SELECT COALESCE(MAX(rowid), 0) AS max_seq FROM journal",
  );

  // Keyset pages — every scan reads at most pageSize rows per statement, so
  // no cursor is held across a long replay and writers are never blocked
  // between pages.
  const pageEventsStmt = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM journal WHERE persistence_id = ? AND sequence_nr > ? ORDER BY sequence_nr LIMIT ?",
  );
  const pageAllEventsStmt = db.prepare(
    `SELECT persistence_id, sequence_nr, manifest, payload FROM journal
     WHERE persistence_id LIKE ? AND (persistence_id > ? OR (persistence_id = ? AND sequence_nr > ?))
     ORDER BY persistence_id, sequence_nr LIMIT ?`,
  );
  const tailCategoryStmt = db.prepare(
    `SELECT ${QUERY_COLUMNS} FROM journal WHERE persistence_id LIKE ? AND rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const tailAllStmt = db.prepare(
    "SELECT rowid AS global_seq, persistence_id, sequence_nr, manifest, payload FROM journal WHERE rowid > ? ORDER BY rowid LIMIT ?",
  );
  const selectEntityIds = db.prepare(
    "SELECT DISTINCT persistence_id FROM journal WHERE persistence_id LIKE ? ORDER BY persistence_id",
  );
  const selectRawEvents = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM journal WHERE persistence_id = ? AND sequence_nr > ? ORDER BY sequence_nr LIMIT ?",
  );
  const selectLastWritten = db.prepare(
    "SELECT persistence_id, MAX(timestamp) AS ts FROM journal WHERE persistence_id LIKE ? GROUP BY persistence_id",
  );

  const insertManyEvents = db.transaction(
    (
      rows: Array<{
        pid: string;
        seqNr: number;
        manifest: string;
        payload: string;
        envelope: EventEnvelope | undefined;
      }>,
    ) => {
      for (const row of rows) {
        insertEvent.run(
          row.pid,
          row.seqNr,
          row.manifest,
          row.payload,
          row.envelope?.eventId ?? null,
          row.envelope?.causationId ?? null,
          row.envelope?.correlationId ?? null,
          row.envelope?.origin ?? null,
          row.envelope !== undefined ? row.envelope.v : null,
        );
      }
    },
  );

  function eventByEventId(eventId: string): JournalQueryRow | undefined {
    const row = selectByEventId.get(eventId) as RawJournalRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  return {
    db,

    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      events: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
      envelopes?: EventEnvelope[],
    ): SequenceNr {
      if (events.length === 0) return startSequenceNr;

      const pid = persistenceKey(categoryId, entityId);
      const rows = events.map((event, idx) => ({
        pid,
        seqNr: startSequenceNr + idx + 1,
        manifest: codec.manifest(event),
        payload: JSON.stringify(codec.encode(event)),
        envelope: envelopes?.[idx],
      }));

      try {
        insertManyEvents(rows);
      } catch (e) {
        // The transaction rolled back, so the journal is unchanged. Translate
        // the PK violation into the typed cross-backend error, reporting the
        // first colliding sequence number in event order.
        if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          const duplicate = rows.find((r) => selectEventExists.get(pid, r.seqNr) !== undefined);
          if (duplicate !== undefined) {
            throw new DuplicateSequenceNrError(categoryId, entityId, mkSeqNr(duplicate.seqNr));
          }
        }
        throw e;
      }
      return mkSeqNr(startSequenceNr + events.length);
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      // Keyset-paged: at most a page of rows per statement, so a long replay
      // never holds one cursor over the whole result set.
      const pid = persistenceKey(categoryId, entityId);
      const out: Array<{ sequenceNr: SequenceNr; event: E }> = [];
      let cursor = fromSequenceNr as number;
      for (;;) {
        const rows = pageEventsStmt.all(pid, cursor, DEFAULT_PAGE_SIZE) as Array<{
          sequence_nr: number;
          manifest: string;
          payload: string;
        }>;
        for (const row of rows) {
          out.push({
            sequenceNr: mkSeqNr(row.sequence_nr),
            event: codec.decode(row.manifest, JSON.parse(row.payload)),
          });
        }
        if (rows.length < DEFAULT_PAGE_SIZE) return out;
        cursor = rows[rows.length - 1].sequence_nr;
      }
    },

    persistSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      state: S,
      sequenceNr: SequenceNr,
      codec: Codec<S>,
    ): void {
      const pid = persistenceKey(categoryId, entityId);
      upsertSnapshot.run(pid, sequenceNr, codec.manifest(state), JSON.stringify(codec.encode(state)));
    },

    loadSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      codec: Codec<S>,
    ): { sequenceNr: SequenceNr; state: S } | undefined {
      const pid = persistenceKey(categoryId, entityId);
      const row = selectSnapshot.get(pid) as
        | { sequence_nr: number; manifest: string; payload: string }
        | undefined;

      if (!row) return undefined;
      try {
        return {
          sequenceNr: mkSeqNr(row.sequence_nr),
          state: codec.decode(row.manifest, JSON.parse(row.payload)),
        };
      } catch (e) {
        throw new SnapshotDecodeError(categoryId, entityId, e);
      }
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      // Keyset-paged on the composite (persistence_id, sequence_nr) key.
      const like = `${categoryId}:%`;
      const categoryPrefix = `${categoryId}:`;
      const out: Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> = [];
      let curPid = "";
      let curSeq = 0;
      for (;;) {
        const rows = pageAllEventsStmt.all(like, curPid, curPid, curSeq, DEFAULT_PAGE_SIZE) as Array<{
          persistence_id: string;
          sequence_nr: number;
          manifest: string;
          payload: string;
        }>;
        for (const row of rows) {
          out.push({
            entityId: row.persistence_id.slice(categoryPrefix.length) as EntityId,
            sequenceNr: mkSeqNr(row.sequence_nr),
            event: codec.decode(row.manifest, JSON.parse(row.payload)),
          });
        }
        if (rows.length < DEFAULT_PAGE_SIZE) return out;
        const last = rows[rows.length - 1];
        curPid = last.persistence_id;
        curSeq = last.sequence_nr;
      }
    },

    // ---- JournalReader ----

    queryEvents(q: JournalQuery): JournalQueryRow[] {
      const where: string[] = [];
      const params: Array<string | number> = [];
      const order = q.order ?? "desc";

      if (q.entityId !== undefined) {
        if (q.category === undefined) {
          throw new Error("JournalQuery: entityId filter requires category");
        }
        where.push("persistence_id = ?");
        params.push(`${q.category}:${q.entityId}`);
      } else if (q.category !== undefined) {
        where.push("persistence_id LIKE ?");
        params.push(`${q.category}:%`);
      }
      if (q.cursor !== undefined) {
        where.push(order === "desc" ? "rowid < ?" : "rowid > ?");
        params.push(q.cursor);
      }
      if (q.sinceMs !== undefined) {
        where.push("timestamp >= ?");
        params.push(Math.floor(q.sinceMs / 1000));
      }
      if (q.causationId !== undefined) {
        where.push("causation_id = ?");
        params.push(q.causationId);
      }
      if (q.correlationId !== undefined) {
        where.push("correlation_id = ?");
        params.push(q.correlationId);
      }

      // Clamp BOTH ends: SQLite treats a negative LIMIT as "no limit".
      const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
      const sql =
        `SELECT ${QUERY_COLUMNS} FROM journal` +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY rowid ${order === "desc" ? "DESC" : "ASC"} LIMIT ?`;

      const rows = db.prepare(sql).all(...params, limit) as RawJournalRow[];
      return rows.map(mapRow);
    },

    eventByEventId,

    causationChain(eventId: string, chainOpts?: { maxDepth?: number }): JournalQueryRow[] {
      const maxDepth = chainOpts?.maxDepth ?? 25;
      const chain: JournalQueryRow[] = [];
      let current = eventByEventId(eventId);
      while (current !== undefined && chain.length < maxDepth) {
        chain.push(current);
        const causationId = current.envelope?.causationId;
        if (causationId === undefined) break;
        // Causation ids that are not event ids (obsIds, HA context ids)
        // simply terminate the chain here.
        current = eventByEventId(causationId);
      }
      return chain;
    },

    lastGlobalSeq(): number {
      const row = selectMaxGlobalSeq.get() as { max_seq: number };
      return row.max_seq;
    },

    // ---- streaming reads (B5) ----

    async *tailEvents<E>(
      category: CategoryId,
      entityId: EntityId,
      codec: Codec<E>,
      opts?: { afterSequenceNr?: number; pollIntervalMs?: number; pageSize?: number; signal?: AbortSignal },
    ): AsyncIterable<{ sequenceNr: SequenceNr; event: E }> {
      const pid = persistenceKey(category, entityId);
      const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
      const poll = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      let cursor = opts?.afterSequenceNr ?? 0;
      let caughtUp = false;
      while (!opts?.signal?.aborted) {
        // The wait happens before the next fetch, not after a page — rows are
        // emitted as soon as they are read, and an idle tail aborts promptly.
        if (caughtUp) await abortableSleep(poll, opts?.signal);
        if (opts?.signal?.aborted) return;
        const rows = pageEventsStmt.all(pid, cursor, pageSize) as Array<{
          sequence_nr: number;
          manifest: string;
          payload: string;
        }>;
        for (const row of rows) {
          cursor = row.sequence_nr;
          yield { sequenceNr: mkSeqNr(row.sequence_nr), event: codec.decode(row.manifest, JSON.parse(row.payload)) };
          if (opts?.signal?.aborted) return;
        }
        caughtUp = rows.length < pageSize;
      }
    },

    async *tailAllEvents<E>(
      category: CategoryId,
      codec: Codec<E>,
      opts?: TailOptions,
    ): AsyncIterable<CategoryEventRecord<E>> {
      const like = `${category}:%`;
      const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
      const poll = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      let cursor = opts?.afterGlobalSeq ?? 0;
      let caughtUp = false;
      while (!opts?.signal?.aborted) {
        if (caughtUp) await abortableSleep(poll, opts?.signal);
        if (opts?.signal?.aborted) return;
        const rows = tailCategoryStmt.all(like, cursor, pageSize) as RawJournalRow[];
        for (const raw of rows) {
          cursor = raw.global_seq;
          const mapped = mapRow(raw);
          yield {
            globalSeq: mapped.globalSeq,
            category,
            entityId: mapped.entityId as EntityId,
            sequenceNr: mkSeqNr(mapped.sequenceNr),
            event: codec.decode(mapped.manifest, mapped.payload),
            envelope: mapped.envelope,
          };
          if (opts?.signal?.aborted) return;
        }
        caughtUp = rows.length < pageSize;
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

    // ---- raw inspection (B6) ----

    entityIds(category: CategoryId): EntityId[] {
      const prefix = `${category}:`;
      const rows = selectEntityIds.all(`${category}:%`) as Array<{ persistence_id: string }>;
      return rows.map((r) => r.persistence_id.slice(prefix.length) as EntityId);
    },

    rawEvents(
      category: CategoryId,
      entityId: EntityId,
      opts?: { fromSequenceNr?: number; limit?: number },
    ): Array<{ sequenceNr: number; manifest: string; payload: string }> {
      const rows = selectRawEvents.all(
        persistenceKey(category, entityId),
        opts?.fromSequenceNr ?? 0,
        Math.min(opts?.limit ?? 1000, 10_000),
      ) as Array<{ sequence_nr: number; manifest: string; payload: string }>;
      return rows.map((r) => ({ sequenceNr: r.sequence_nr, manifest: r.manifest, payload: r.payload }));
    },

    snapshotRaw(
      category: CategoryId,
      entityId: EntityId,
    ): { sequenceNr: number; manifest: string; payload: string } | undefined {
      const row = selectSnapshot.get(persistenceKey(category, entityId)) as
        | { sequence_nr: number; manifest: string; payload: string }
        | undefined;
      if (!row) return undefined;
      return { sequenceNr: row.sequence_nr, manifest: row.manifest, payload: row.payload };
    },

    lastWrittenAt(category: CategoryId): Array<{ entityId: EntityId; atMs: number }> {
      const prefix = `${category}:`;
      const rows = selectLastWritten.all(`${category}:%`) as Array<{ persistence_id: string; ts: number }>;
      return rows.map((r) => ({
        entityId: r.persistence_id.slice(prefix.length) as EntityId,
        atMs: r.ts * 1000, // timestamp column is unix seconds
      }));
    },

    async *liveRawEvents(opts?: TailOptions) {
      const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
      const poll = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      // Live only: start at the journal's current end, no backlog replay.
      let cursor = opts?.afterGlobalSeq ?? (selectMaxGlobalSeq.get() as { max_seq: number }).max_seq;
      let caughtUp = false;
      while (!opts?.signal?.aborted) {
        if (caughtUp) await abortableSleep(poll, opts?.signal);
        if (opts?.signal?.aborted) return;
        const rows = tailAllStmt.all(cursor, pageSize) as Array<{
          global_seq: number;
          persistence_id: string;
          sequence_nr: number;
          manifest: string;
          payload: string;
        }>;
        for (const row of rows) {
          cursor = row.global_seq;
          const sep = row.persistence_id.indexOf(":");
          yield {
            globalSeq: row.global_seq,
            category: sep === -1 ? row.persistence_id : row.persistence_id.slice(0, sep),
            entityId: sep === -1 ? "" : row.persistence_id.slice(sep + 1),
            sequenceNr: row.sequence_nr,
            manifest: row.manifest,
            payload: row.payload,
          };
          if (opts?.signal?.aborted) return;
        }
        caughtUp = rows.length < pageSize;
      }
    },

    close() {
      db.close();
    },
  };
}
