// sqlite-offset-store — SagaOffsetStore persisted in better-sqlite3

import type Database from "better-sqlite3";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { SagaOffsetStore } from "./index.js";

/**
 * SagaOffsetStore on better-sqlite3. Auto-creates tables. Sync API matches
 * the interface. Can share a database file with other stores or use its own.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const db = new Database("./data/sagas.db");
 * const store = createSqliteSagaStore(db);
 * ```
 */
export function createSqliteSagaStore(db: Database.Database): SagaOffsetStore {
  // Auto-migrate schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga_offsets (
      saga_name   TEXT NOT NULL,
      category    TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      sequence_nr INTEGER NOT NULL,
      PRIMARY KEY (saga_name, category, entity_id)
    );

    CREATE TABLE IF NOT EXISTS saga_steps (
      saga_name      TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      step           INTEGER NOT NULL,
      PRIMARY KEY (saga_name, correlation_id)
    );
  `);

  const getOff = db.prepare(
    "SELECT sequence_nr FROM saga_offsets WHERE saga_name = ? AND category = ? AND entity_id = ?",
  );

  const upsertOff = db.prepare(`
    INSERT INTO saga_offsets (saga_name, category, entity_id, sequence_nr)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(saga_name, category, entity_id) DO UPDATE SET
      sequence_nr = excluded.sequence_nr
  `);

  const getStepStmt = db.prepare(
    "SELECT step FROM saga_steps WHERE saga_name = ? AND correlation_id = ?",
  );

  const upsertStep = db.prepare(`
    INSERT INTO saga_steps (saga_name, correlation_id, step)
    VALUES (?, ?, ?)
    ON CONFLICT(saga_name, correlation_id) DO UPDATE SET
      step = excluded.step
  `);

  return {
    getOffset(sagaName, category, entityId) {
      const row = getOff.get(sagaName, category, entityId) as
        | { sequence_nr: number }
        | undefined;
      return mkSeqNr(row?.sequence_nr ?? 0);
    },

    setOffset(sagaName, category, entityId, sequenceNr) {
      upsertOff.run(sagaName, category, entityId, sequenceNr);
    },

    getStep(sagaName, correlationId) {
      const row = getStepStmt.get(sagaName, correlationId) as { step: number } | undefined;
      return row?.step ?? 0;
    },

    setStep(sagaName, correlationId, step) {
      upsertStep.run(sagaName, correlationId, step);
    },
  };
}
