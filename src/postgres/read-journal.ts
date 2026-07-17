import pg from "pg";
import type { ReadJournal } from "../core/journal.js";
import type { Codec } from "../core/codec.js";

/** Decode a bytea (Buffer) column back to a parsed JSON value. */
function fromBytea(data: Buffer | string | unknown): unknown {
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf-8"));
  if (typeof data === "string") return JSON.parse(data);
  return data;
}

/**
 * Snapshot data loaded from the database.
 */
export interface SnapshotData<State> {
  state: State;
  sequenceNr: number;
  timestamp: Date;
}

/**
 * Recovery result: optional snapshot + events after it.
 */
export interface RecoveryData<State, Event> {
  snapshot: SnapshotData<State> | undefined;
  events: Array<{ sequenceNr: number; event: Event }>;
}

/**
 * PostgresReadJournal implements the ReadJournal interface for PostgreSQL,
 * using direct SQL queries for event/snapshot retrieval.
 *
 * PersistenceId = string (formatted as "categoryId|entityId")
 * Ordinal = number (sequence_nr)
 */
export interface PostgresReadJournal<Event> extends ReadJournal<string, Event, number> {
  /** Load the latest snapshot for a persistence id. */
  loadSnapshot<State>(
    persistenceId: string,
    stateCodec: Codec<State>,
  ): Promise<SnapshotData<State> | undefined>;

  /** Load snapshot + events after it for full recovery. */
  eventsWithSnapshot<State>(
    persistenceId: string,
    eventCodec: Codec<Event>,
    stateCodec: Codec<State>,
  ): Promise<RecoveryData<State, Event>>;
}

export function createPostgresReadJournal<Event>(
  pool: pg.Pool,
  eventCodec: Codec<Event>,
): PostgresReadJournal<Event> {
  return {
    async *fetchIds(since?: Date): AsyncIterable<string> {
      let result: pg.QueryResult;
      if (since) {
        result = await pool.query(
          `SELECT DISTINCT persistence_id FROM journal WHERE timestamp > $1 ORDER BY persistence_id`,
          [since],
        );
      } else {
        // Recursive index skip scan for efficiency on large tables
        result = await pool.query(
          `WITH RECURSIVE skip AS (
            (SELECT persistence_id FROM journal ORDER BY persistence_id LIMIT 1)
            UNION ALL
            SELECT (SELECT persistence_id FROM journal WHERE persistence_id > skip.persistence_id ORDER BY persistence_id LIMIT 1)
            FROM skip
            WHERE skip.persistence_id IS NOT NULL
          )
          SELECT persistence_id FROM skip WHERE persistence_id IS NOT NULL ORDER BY persistence_id`,
        );
      }
      for (const row of result.rows) {
        yield row.persistence_id;
      }
    },

    async lastOrdinal(persistenceId: string): Promise<number> {
      const result = await pool.query(
        `SELECT COALESCE(MAX(sequence_nr), 0) as last_seq FROM journal WHERE persistence_id = $1`,
        [persistenceId],
      );
      return Number(result.rows[0].last_seq);
    },

    async *streamIds(): AsyncIterable<string> {
      // Same as fetchIds for non-live usage; live streaming is handled by LISTEN
      const result = await pool.query(
        `WITH RECURSIVE skip AS (
          (SELECT persistence_id FROM journal ORDER BY persistence_id LIMIT 1)
          UNION ALL
          SELECT (SELECT persistence_id FROM journal WHERE persistence_id > skip.persistence_id ORDER BY persistence_id LIMIT 1)
          FROM skip
          WHERE skip.persistence_id IS NOT NULL
        )
        SELECT persistence_id FROM skip WHERE persistence_id IS NOT NULL ORDER BY persistence_id`,
      );
      for (const row of result.rows) {
        yield row.persistence_id;
      }
    },

    async *events(
      persistenceId: string,
      from: number,
      to?: number,
    ): AsyncIterable<[Event, number]> {
      let result: pg.QueryResult;
      if (to !== undefined) {
        result = await pool.query(
          `SELECT sequence_nr, event, event_manifest FROM journal
           WHERE persistence_id = $1 AND sequence_nr >= $2 AND sequence_nr < $3
           ORDER BY sequence_nr`,
          [persistenceId, from, to],
        );
      } else {
        result = await pool.query(
          `SELECT sequence_nr, event, event_manifest FROM journal
           WHERE persistence_id = $1 AND sequence_nr >= $2
           ORDER BY sequence_nr`,
          [persistenceId, from],
        );
      }
      for (const row of result.rows) {
        const seqNr = Number(row.sequence_nr);
        const event = eventCodec.decode(row.event_manifest, fromBytea(row.event));
        yield [event, seqNr];
      }
    },

    async loadSnapshot<State>(
      persistenceId: string,
      stateCodec: Codec<State>,
    ): Promise<SnapshotData<State> | undefined> {
      const result = await pool.query(
        `SELECT sequence_nr, timestamp, snapshot, snapshot_manifest FROM snapshot
         WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT 1`,
        [persistenceId],
      );
      if (result.rows.length === 0) return undefined;
      const row = result.rows[0];
      return {
        state: stateCodec.decode(row.snapshot_manifest, fromBytea(row.snapshot)),
        sequenceNr: Number(row.sequence_nr),
        timestamp: new Date(row.timestamp),
      };
    },

    async eventsWithSnapshot<State>(
      persistenceId: string,
      evCodec: Codec<Event>,
      stateCodec: Codec<State>,
    ): Promise<RecoveryData<State, Event>> {
      const snapshot = await this.loadSnapshot(persistenceId, stateCodec);
      const fromSeqNr = snapshot ? snapshot.sequenceNr + 1 : 1;

      const result = await pool.query(
        `SELECT sequence_nr, event, event_manifest FROM journal
         WHERE persistence_id = $1 AND sequence_nr >= $2
         ORDER BY sequence_nr`,
        [persistenceId, fromSeqNr],
      );

      const events = result.rows.map((row) => ({
        sequenceNr: Number(row.sequence_nr),
        event: evCodec.decode(row.event_manifest, fromBytea(row.event)),
      }));

      return { snapshot, events };
    },
  };
}
