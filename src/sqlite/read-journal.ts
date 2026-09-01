// SQLite ReadJournal — implements the ReadJournal interface for SQLite

import type Database from "better-sqlite3";
import type { ReadJournal } from "../core/journal.js";
import type { Codec } from "../core/codec.js";
import type { SequenceNr } from "../core/types.js";

/**
 * SQLite implementation of the ReadJournal interface.
 *
 * PersistenceId = string (formatted as "categoryId:entityId")
 * Ordinal = number (sequence_nr)
 *
 * Since SQLite has no LISTEN/NOTIFY, `streamIds()` is equivalent to `fetchIds()`
 * (snapshot, not live). For live updates, use polling with `fetchIds(since)`.
 */
export interface SqliteReadJournal<Event> extends ReadJournal<string, Event, number> {
  /** Poll for new persistence IDs since last check. Useful for polling-based subscriptions. */
  pollIds(sinceTimestamp: number): string[];
}

export function createSqliteReadJournal<Event>(
  db: Database.Database,
  eventCodec: Codec<Event>,
): SqliteReadJournal<Event> {
  const selectDistinctIds = db.prepare(
    "SELECT DISTINCT persistence_id FROM journal ORDER BY persistence_id",
  );

  const selectIdsSince = db.prepare(
    "SELECT DISTINCT persistence_id FROM journal WHERE timestamp > ? ORDER BY persistence_id",
  );

  const selectLastOrdinal = db.prepare(
    "SELECT COALESCE(MAX(sequence_nr), 0) as last_seq FROM journal WHERE persistence_id = ?",
  );

  const selectEventsRange = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM journal WHERE persistence_id = ? AND sequence_nr >= ? ORDER BY sequence_nr",
  );

  const selectEventsRangeBounded = db.prepare(
    "SELECT sequence_nr, manifest, payload FROM journal WHERE persistence_id = ? AND sequence_nr >= ? AND sequence_nr < ? ORDER BY sequence_nr",
  );

  const selectPollIds = db.prepare(
    "SELECT DISTINCT persistence_id FROM journal WHERE timestamp > ? ORDER BY persistence_id",
  );

  return {
    async *fetchIds(since?: Date): AsyncIterable<string> {
      const rows = since
        ? selectIdsSince.all(Math.floor(since.getTime() / 1000)) as Array<{ persistence_id: string }>
        : selectDistinctIds.all() as Array<{ persistence_id: string }>;
      for (const row of rows) {
        yield row.persistence_id;
      }
    },

    async lastOrdinal(persistenceId: string): Promise<number> {
      const row = selectLastOrdinal.get(persistenceId) as { last_seq: number };
      return row.last_seq;
    },

    async *streamIds(): AsyncIterable<string> {
      // SQLite has no LISTEN/NOTIFY, so streamIds is same as fetchIds
      const rows = selectDistinctIds.all() as Array<{ persistence_id: string }>;
      for (const row of rows) {
        yield row.persistence_id;
      }
    },

    async *events(
      persistenceId: string,
      from: number,
      to?: number,
    ): AsyncIterable<[Event, number]> {
      const rows = to !== undefined
        ? selectEventsRangeBounded.all(persistenceId, from, to) as Array<{ sequence_nr: number; manifest: string; payload: string }>
        : selectEventsRange.all(persistenceId, from) as Array<{ sequence_nr: number; manifest: string; payload: string }>;

      for (const row of rows) {
        const event = eventCodec.decode(row.manifest, JSON.parse(row.payload));
        yield [event, row.sequence_nr];
      }
    },

    pollIds(sinceTimestamp: number): string[] {
      const rows = selectPollIds.all(sinceTimestamp) as Array<{ persistence_id: string }>;
      return rows.map((r) => r.persistence_id);
    },
  };
}
