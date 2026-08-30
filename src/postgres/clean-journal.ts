import type pg from "pg";

/**
 * CleanJournal provides delete operations for journal housekeeping.
 * All delete methods return the number of rows deleted.
 */
export interface CleanJournal {
  /** Delete all journal events for a persistence id. */
  deleteJournalEvents(persistenceId: string): Promise<number>;
  /** Delete journal events up to a sequence number (inclusive). */
  deleteJournalEventsTo(persistenceId: string, toSequenceNr: number): Promise<number>;
  /** Delete journal events before a timestamp. */
  deleteJournalEventsBefore(persistenceId: string, before: Date): Promise<number>;
  /** Delete all snapshots for a persistence id. */
  deleteSnapshots(persistenceId: string): Promise<number>;
  /** Delete snapshots up to a sequence number (inclusive). */
  deleteSnapshotsTo(persistenceId: string, toSequenceNr: number): Promise<number>;
  /** Delete all journal events and snapshots. Returns [eventsDeleted, snapshotsDeleted]. */
  deleteAll(persistenceId: string): Promise<[number, number]>;
}

export function createCleanJournal(pool: pg.Pool): CleanJournal {
  async function execDelete(text: string, values: unknown[]): Promise<number> {
    const result = await pool.query(text, values);
    return result.rowCount ?? 0;
  }

  return {
    deleteJournalEvents(persistenceId) {
      return execDelete(
        `DELETE FROM journal WHERE persistence_id = $1`,
        [persistenceId],
      );
    },

    deleteJournalEventsTo(persistenceId, toSequenceNr) {
      return execDelete(
        `DELETE FROM journal WHERE persistence_id = $1 AND sequence_nr <= $2`,
        [persistenceId, toSequenceNr],
      );
    },

    deleteJournalEventsBefore(persistenceId, before) {
      return execDelete(
        `DELETE FROM journal WHERE persistence_id = $1 AND timestamp < $2`,
        [persistenceId, before],
      );
    },

    deleteSnapshots(persistenceId) {
      return execDelete(
        `DELETE FROM snapshot WHERE persistence_id = $1`,
        [persistenceId],
      );
    },

    deleteSnapshotsTo(persistenceId, toSequenceNr) {
      return execDelete(
        `DELETE FROM snapshot WHERE persistence_id = $1 AND sequence_nr <= $2`,
        [persistenceId, toSequenceNr],
      );
    },

    async deleteAll(persistenceId) {
      const eventsDeleted = await this.deleteJournalEvents(persistenceId);
      const snapshotsDeleted = await this.deleteSnapshots(persistenceId);
      return [eventsDeleted, snapshotsDeleted];
    },
  };
}
