// SQLite journal — persistent event/snapshot storage using better-sqlite3

import Database from "better-sqlite3";
import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";
import type {
  EventEnvelope,
  JournalQuery,
  JournalQueryRow,
  JournalReader,
} from "../core/envelope.js";

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

  const selectEvents = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM journal WHERE persistence_id = ? AND sequence_nr > ? ORDER BY sequence_nr",
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

  const selectAllEvents = db.prepare(
    "SELECT persistence_id, sequence_nr, manifest, payload FROM journal WHERE persistence_id LIKE ? ORDER BY persistence_id, sequence_nr",
  );

  const selectByEventId = db.prepare(
    `SELECT ${QUERY_COLUMNS} FROM journal WHERE event_id = ?`,
  );

  const selectMaxGlobalSeq = db.prepare(
    "SELECT COALESCE(MAX(rowid), 0) AS max_seq FROM journal",
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

      insertManyEvents(rows);
      return mkSeqNr(startSequenceNr + events.length);
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      const pid = persistenceKey(categoryId, entityId);
      const rows = selectEvents.all(pid, fromSequenceNr) as Array<{
        sequence_nr: number;
        manifest: string;
        payload: string;
      }>;

      return rows.map((row) => ({
        sequenceNr: mkSeqNr(row.sequence_nr),
        event: codec.decode(row.manifest, JSON.parse(row.payload)),
      }));
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
      return {
        sequenceNr: mkSeqNr(row.sequence_nr),
        state: codec.decode(row.manifest, JSON.parse(row.payload)),
      };
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      const prefix = `${categoryId}:%`;
      const rows = selectAllEvents.all(prefix) as Array<{
        persistence_id: string;
        sequence_nr: number;
        manifest: string;
        payload: string;
      }>;

      const categoryPrefix = `${categoryId}:`;
      return rows.map((row) => ({
        entityId: row.persistence_id.slice(categoryPrefix.length) as EntityId,
        sequenceNr: mkSeqNr(row.sequence_nr),
        event: codec.decode(row.manifest, JSON.parse(row.payload)),
      }));
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

    close() {
      db.close();
    },
  };
}
