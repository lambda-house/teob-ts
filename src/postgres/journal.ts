import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import { DuplicateSequenceNrError, SnapshotDecodeError, type Journal } from "../core/journal-store.js";
import type { PostgresConfig } from "./config.js";
import { withRetry, type RetryConfig, defaultRetryConfig } from "./retry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function persistenceId(categoryId: CategoryId, entityId: EntityId): string {
  return `${categoryId}|${entityId}`;
}

/** Encode a value as bytea (Buffer) for Pekko-compatible storage. */
function toBytea(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf-8");
}

/** Decode a bytea (Buffer) column back to a parsed JSON value. */
function fromBytea(data: Buffer | string | unknown): unknown {
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf-8"));
  if (typeof data === "string") return JSON.parse(data);
  // Already parsed (e.g. jsonb fallback)
  return data;
}

export interface PostgresJournal extends Journal {
  pool: pg.Pool;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresJournal(
  config: PostgresConfig,
  retryConfig: RetryConfig = defaultRetryConfig,
): PostgresJournal {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxPoolSize,
    application_name: config.applicationName,
  });

  async function query<T extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    return withRetry(() => pool.query<T>(text, values), retryConfig);
  }

  return {
    pool,

    async migrate(): Promise<void> {
      const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
      await pool.query(schema);
    },

    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      events: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): SequenceNr {
      // This is sync in the Journal interface — we need to fire async and return immediately
      // For postgres we provide an async version; the sync signature is for interface compat
      throw new Error("Use persistEventsAsync for PostgresJournal");
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      throw new Error("Use loadEventsAsync for PostgresJournal");
    },

    persistSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      state: S,
      sequenceNr: SequenceNr,
      codec: Codec<S>,
    ): void {
      throw new Error("Use persistSnapshotAsync for PostgresJournal");
    },

    loadSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      codec: Codec<S>,
    ): { sequenceNr: SequenceNr; state: S } | undefined {
      throw new Error("Use loadSnapshotAsync for PostgresJournal");
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      throw new Error("Use allEventsAsync for PostgresJournal");
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// Async journal operations — the real postgres implementations

export async function persistEventsAsync<E>(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  events: E[],
  startSequenceNr: SequenceNr,
  codec: Codec<E>,
): Promise<SequenceNr> {
  if (events.length === 0) return startSequenceNr;

  const pid = persistenceId(categoryId, entityId);
  const client = await journal.pool.connect();

  const insertSql = `INSERT INTO journal (persistence_id, sequence_nr, timestamp, event, event_manifest, serializer_id, writer_uuid)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`;

  // Translate a unique violation (pg code 23505) into the typed cross-backend
  // error, reporting the first colliding sequence number of the batch. The
  // journal is unchanged: the single insert failed whole, the batch rolled back.
  async function duplicateError(e: unknown): Promise<Error> {
    if ((e as { code?: string }).code !== "23505") return e as Error;
    const res = await client.query(
      "SELECT sequence_nr FROM journal WHERE persistence_id = $1 AND sequence_nr BETWEEN $2 AND $3 ORDER BY sequence_nr LIMIT 1",
      [pid, (startSequenceNr as number) + 1, (startSequenceNr as number) + events.length],
    );
    const seqNr =
      res.rows.length > 0 ? Number(res.rows[0].sequence_nr) : (startSequenceNr as number) + 1;
    return new DuplicateSequenceNrError(categoryId, entityId, mkSeqNr(seqNr));
  }

  try {
    if (events.length === 1) {
      const event = events[0];
      const seqNr = mkSeqNr(startSequenceNr + 1);
      try {
        await client.query(insertSql, [
          pid, seqNr as number, new Date(), toBytea(codec.encode(event)),
          codec.manifest(event), 0, `ts-writer-${pid}`,
        ]);
      } catch (e) {
        throw await duplicateError(e);
      }
      return seqNr;
    }

    // Batch insert
    await client.query("BEGIN");
    try {
      const now = new Date();
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const seqNr = mkSeqNr(startSequenceNr + i + 1);
        await client.query(insertSql, [
          pid, seqNr as number, now, toBytea(codec.encode(event)),
          codec.manifest(event), 0, `ts-writer-${pid}`,
        ]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw await duplicateError(e);
    }
  } finally {
    client.release();
  }

  return mkSeqNr(startSequenceNr + events.length);
}

export async function loadEventsAsync<E>(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  fromSequenceNr: SequenceNr,
  codec: Codec<E>,
  toSequenceNr?: SequenceNr,
): Promise<Array<{ sequenceNr: SequenceNr; event: E }>> {
  const pid = persistenceId(categoryId, entityId);

  const result = toSequenceNr
    ? await journal.pool.query(
        `SELECT sequence_nr, event, event_manifest FROM journal
         WHERE persistence_id = $1 AND sequence_nr > $2 AND sequence_nr <= $3
         ORDER BY sequence_nr`,
        [pid, fromSequenceNr as number, toSequenceNr as number],
      )
    : await journal.pool.query(
        `SELECT sequence_nr, event, event_manifest FROM journal
         WHERE persistence_id = $1 AND sequence_nr > $2
         ORDER BY sequence_nr`,
        [pid, fromSequenceNr as number],
      );

  return result.rows.map((row) => ({
    sequenceNr: mkSeqNr(Number(row.sequence_nr)),
    event: codec.decode(row.event_manifest, fromBytea(row.event)),
  }));
}

export async function persistSnapshotAsync<S>(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  state: S,
  sequenceNr: SequenceNr,
  codec: Codec<S>,
): Promise<void> {
  const pid = persistenceId(categoryId, entityId);
  await journal.pool.query(
    `INSERT INTO snapshot (persistence_id, sequence_nr, timestamp, snapshot, snapshot_manifest, serializer_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (persistence_id, sequence_nr)
     DO UPDATE SET snapshot = EXCLUDED.snapshot, snapshot_manifest = EXCLUDED.snapshot_manifest, timestamp = EXCLUDED.timestamp`,
    [pid, sequenceNr as number, new Date(), toBytea(codec.encode(state)), codec.manifest(state), 0],
  );
}

export async function loadSnapshotAsync<S>(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  codec: Codec<S>,
): Promise<{ sequenceNr: SequenceNr; state: S } | undefined> {
  const pid = persistenceId(categoryId, entityId);
  const result = await journal.pool.query(
    `SELECT sequence_nr, snapshot, snapshot_manifest FROM snapshot
     WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT 1`,
    [pid],
  );

  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  try {
    return {
      sequenceNr: mkSeqNr(Number(row.sequence_nr)),
      state: codec.decode(row.snapshot_manifest, fromBytea(row.snapshot)),
    };
  } catch (e) {
    throw new SnapshotDecodeError(categoryId, entityId, e);
  }
}

export async function highestSequenceNr(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
): Promise<SequenceNr> {
  const pid = persistenceId(categoryId, entityId);
  const result = await journal.pool.query(
    `SELECT COALESCE(MAX(sequence_nr), 0) as max_seq FROM journal WHERE persistence_id = $1`,
    [pid],
  );
  return mkSeqNr(Number(result.rows[0].max_seq));
}

export async function fetchPersistenceIds(
  journal: PostgresJournal,
): Promise<string[]> {
  const result = await journal.pool.query(
    `SELECT DISTINCT persistence_id FROM journal ORDER BY persistence_id`,
  );
  return result.rows.map((r) => r.persistence_id);
}

export async function deleteEvents(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  toSequenceNr: SequenceNr,
): Promise<void> {
  const pid = persistenceId(categoryId, entityId);
  await journal.pool.query(
    `DELETE FROM journal WHERE persistence_id = $1 AND sequence_nr <= $2`,
    [pid, toSequenceNr as number],
  );
}

export async function deleteSnapshots(
  journal: PostgresJournal,
  categoryId: CategoryId,
  entityId: EntityId,
  olderThanSequenceNr: SequenceNr,
): Promise<void> {
  const pid = persistenceId(categoryId, entityId);
  await journal.pool.query(
    `DELETE FROM snapshot WHERE persistence_id = $1 AND sequence_nr < $2`,
    [pid, olderThanSequenceNr as number],
  );
}
