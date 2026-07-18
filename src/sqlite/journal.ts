// SQLite journal — persistent event/snapshot storage using better-sqlite3

import Database from "better-sqlite3";
import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";

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

export interface SqliteJournal extends Journal {
  /** Close the database connection. */
  close(): void;
  /** The underlying better-sqlite3 Database instance. */
  readonly db: Database.Database;
}

export function createSqliteJournal(opts: SqliteJournalOptions): SqliteJournal {
  const db = new Database(opts.path);

  // Enable WAL mode for better concurrent read performance
  if (opts.wal !== false) {
    db.pragma("journal_mode = WAL");
  }

  // Auto-migrate schema
  db.exec(SCHEMA_SQL);

  // Prepared statements
  const insertEvent = db.prepare(
    "INSERT INTO journal (persistence_id, sequence_nr, manifest, payload) VALUES (?, ?, ?, ?)",
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

  const insertManyEvents = db.transaction(
    (rows: Array<{ pid: string; seqNr: number; manifest: string; payload: string }>) => {
      for (const row of rows) {
        insertEvent.run(row.pid, row.seqNr, row.manifest, row.payload);
      }
    },
  );

  return {
    db,

    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      events: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): SequenceNr {
      if (events.length === 0) return startSequenceNr;

      const pid = persistenceKey(categoryId, entityId);
      const rows = events.map((event, idx) => ({
        pid,
        seqNr: startSequenceNr + idx + 1,
        manifest: codec.manifest(event),
        payload: JSON.stringify(codec.encode(event)),
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

    close() {
      db.close();
    },
  };
}
