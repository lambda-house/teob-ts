// clean-journal.ts — maintenance deletes for the SQLite journal (port of the
// Scala SqliteCleanJournal; the sqlite counterpart of postgres/clean-journal).
//
// All operations run on the journal's own connection, so a delete never
// interleaves with a replay or a tail mid-page (better-sqlite3 serializes),
// and every method reports the real number of affected rows.

import type { CategoryId, EntityId } from "../core/types.js";
import type { SqliteJournal } from "./journal.js";

export interface SqliteCleanJournal {
  /** Delete every event of one entity. */
  deleteJournalEvents(category: CategoryId, entityId: EntityId): number;
  /** Delete events up to and including `toSequenceNr` (a post-snapshot trim). */
  deleteJournalEventsTo(category: CategoryId, entityId: EntityId, toSequenceNr: number): number;
  /** Time-based retention: delete a category's events older than `beforeMs`. */
  deleteJournalEventsBefore(category: CategoryId, beforeMs: number): number;
  /** Delete the snapshot of one entity. */
  deleteSnapshots(category: CategoryId, entityId: EntityId): number;
  /** Delete the snapshot when its sequence number is at or below `toSequenceNr`. */
  deleteSnapshotsTo(category: CategoryId, entityId: EntityId, toSequenceNr: number): number;
  /** Time-based retention over a category's snapshots. */
  deleteSnapshotsBefore(category: CategoryId, beforeMs: number): number;
  /**
   * Purge one entity entirely — events BEFORE snapshots: a stale snapshot
   * with no events after it still recovers to a consistent state, while the
   * reverse order would replay the entity from zero.
   */
  deleteAll(category: CategoryId, entityId: EntityId): { events: number; snapshots: number };
}

function pid(category: CategoryId, entityId: EntityId): string {
  return `${category}:${entityId}`;
}

export function createSqliteCleanJournal(journal: SqliteJournal): SqliteCleanJournal {
  const db = journal.db;

  const delEvents = db.prepare("DELETE FROM journal WHERE persistence_id = ?");
  const delEventsTo = db.prepare(
    "DELETE FROM journal WHERE persistence_id = ? AND sequence_nr <= ?",
  );
  const delEventsBefore = db.prepare(
    "DELETE FROM journal WHERE persistence_id LIKE ? AND timestamp < ?",
  );
  const delSnapshots = db.prepare("DELETE FROM snapshots WHERE persistence_id = ?");
  const delSnapshotsTo = db.prepare(
    "DELETE FROM snapshots WHERE persistence_id = ? AND sequence_nr <= ?",
  );
  const delSnapshotsBefore = db.prepare(
    "DELETE FROM snapshots WHERE persistence_id LIKE ? AND timestamp < ?",
  );

  return {
    deleteJournalEvents(category, entityId) {
      return delEvents.run(pid(category, entityId)).changes;
    },
    deleteJournalEventsTo(category, entityId, toSequenceNr) {
      return delEventsTo.run(pid(category, entityId), toSequenceNr).changes;
    },
    deleteJournalEventsBefore(category, beforeMs) {
      // timestamp column is unix seconds
      return delEventsBefore.run(`${category}:%`, Math.floor(beforeMs / 1000)).changes;
    },
    deleteSnapshots(category, entityId) {
      return delSnapshots.run(pid(category, entityId)).changes;
    },
    deleteSnapshotsTo(category, entityId, toSequenceNr) {
      return delSnapshotsTo.run(pid(category, entityId), toSequenceNr).changes;
    },
    deleteSnapshotsBefore(category, beforeMs) {
      return delSnapshotsBefore.run(`${category}:%`, Math.floor(beforeMs / 1000)).changes;
    },
    deleteAll(category, entityId) {
      const events = delEvents.run(pid(category, entityId)).changes;
      const snapshots = delSnapshots.run(pid(category, entityId)).changes;
      return { events, snapshots };
    },
  };
}
