import { afterAll, beforeAll } from "vitest";
import { createTestPool, ensureSchema, testPgConfig } from "./fixtures/pg-test-helpers.js";
import {
  createPostgresJournal,
  persistEventsAsync,
  loadEventsAsync,
  persistSnapshotAsync,
  loadSnapshotAsync,
  type PostgresJournal,
} from "../src/postgres/journal.js";
import type pg from "pg";
import {
  describeJournalContract,
  testEventCodec,
  type JournalHarness,
} from "./contracts/journal-contract.js";
import type { Codec } from "../src/core/codec.js";

const CATEGORY = "jc-pg";

type TestState = { total: number };
const stateCodec: Codec<TestState> = {
  manifest: () => "State",
  encode: (s) => s,
  decode: (_m, data) => data as TestState,
};

let pool: pg.Pool;
let journal: PostgresJournal;

beforeAll(async () => {
  pool = createTestPool();
  await ensureSchema(pool);
  journal = createPostgresJournal(testPgConfig);
});

afterAll(async () => {
  await pool.query("DELETE FROM journal WHERE persistence_id LIKE $1", [`${CATEGORY}|%`]);
  await pool.query("DELETE FROM snapshot WHERE persistence_id LIKE $1", [`${CATEGORY}|%`]);
  await journal.close();
  await pool.end();
});

describeJournalContract(
  "postgres",
  async (): Promise<JournalHarness> => ({
    persistEvents: (c, i, ev, s) => persistEventsAsync(journal, c, i, ev, s, testEventCodec),
    loadEvents: (c, i, f) => loadEventsAsync(journal, c, i, f, testEventCodec),
    persistSnapshot: (c, i, st, s) => persistSnapshotAsync(journal, c, i, st, s, stateCodec),
    loadSnapshot: (c, i) => loadSnapshotAsync(journal, c, i, stateCodec),
    close: async () => {},
  }),
  { category: CATEGORY },
);
