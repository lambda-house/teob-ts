import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresConfig } from "../../src/postgres/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const testPgConfig: PostgresConfig = {
  host: "localhost",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  maxPoolSize: 5,
  applicationName: "teob-ts-test",
};

/** Create a pool for direct queries in tests. */
export function createTestPool(): pg.Pool {
  return new pg.Pool({
    host: testPgConfig.host,
    port: testPgConfig.port,
    database: testPgConfig.database,
    user: testPgConfig.user,
    password: testPgConfig.password,
    max: testPgConfig.maxPoolSize,
    application_name: testPgConfig.applicationName,
  });
}

/** Ensure schema exists. Safe to run against an existing Pekko-managed DB. */
export async function ensureSchema(pool: pg.Pool): Promise<void> {
  const tableCheck = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal') as exists`,
  );
  if (tableCheck.rows[0].exists) {
    // Tables already exist (Pekko-managed), nothing to do
    return;
  }
  // Fresh DB — run full schema
  const schema = readFileSync(join(__dirname, "../../src/postgres/schema.sql"), "utf-8");
  await pool.query(schema);
}

/** Insert a journal event directly (Pekko-compatible bytea format). */
export async function insertEvent(
  pool: pg.Pool,
  persistenceId: string,
  sequenceNr: number,
  event: unknown,
  manifest: string,
  timestamp?: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO journal (persistence_id, sequence_nr, timestamp, event, event_manifest, serializer_id, writer_uuid)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      persistenceId, sequenceNr, timestamp ?? new Date(),
      Buffer.from(JSON.stringify(event), "utf-8"), manifest,
      0, `ts-test-writer-${persistenceId}`,
    ],
  );
}

/** Insert a snapshot directly (Pekko-compatible bytea format). */
export async function insertSnapshot(
  pool: pg.Pool,
  persistenceId: string,
  sequenceNr: number,
  snapshot: unknown,
  manifest: string,
  timestamp?: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO snapshot (persistence_id, sequence_nr, timestamp, snapshot, snapshot_manifest, serializer_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (persistence_id, sequence_nr)
     DO UPDATE SET timestamp = EXCLUDED.timestamp, snapshot = EXCLUDED.snapshot, snapshot_manifest = EXCLUDED.snapshot_manifest`,
    [
      persistenceId, sequenceNr, timestamp ?? new Date(),
      Buffer.from(JSON.stringify(snapshot), "utf-8"), manifest, 0,
    ],
  );
}

/** Count journal events for a persistence id. */
export async function countJournalEvents(pool: pg.Pool, persistenceId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as cnt FROM journal WHERE persistence_id = $1`,
    [persistenceId],
  );
  return Number(result.rows[0].cnt);
}

/** Count snapshots for a persistence id. */
export async function countSnapshots(pool: pg.Pool, persistenceId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as cnt FROM snapshot WHERE persistence_id = $1`,
    [persistenceId],
  );
  return Number(result.rows[0].cnt);
}

/** Get minimum sequence number for a persistence id. */
export async function minSequenceNr(pool: pg.Pool, persistenceId: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT MIN(sequence_nr) as min_seq FROM journal WHERE persistence_id = $1`,
    [persistenceId],
  );
  const val = result.rows[0].min_seq;
  return val === null ? null : Number(val);
}

/** Get active idle connection count. */
export async function getIdleConnections(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `SELECT count(*) as cnt FROM pg_stat_activity WHERE datname = 'postgres' AND state = 'idle'`,
  );
  return Number(result.rows[0].cnt);
}

/** Clean up test data (delete events and snapshots matching a prefix). */
export async function cleanupTestData(pool: pg.Pool, persistenceIdPrefix: string): Promise<void> {
  await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`${persistenceIdPrefix}%`]);
  await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`${persistenceIdPrefix}%`]);
}
