import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saga, runSaga, createSqliteSagaStore, type SagaOffsetStore } from "../src/saga/index.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { createInMemoryRuntime } from "../src/inmem/runtime.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec } from "../src/core/codec.js";

type OrderEvent = { tag: "OrderPlaced"; total: number };
const orderCodec = tagCodec<OrderEvent>();

describe("createSqliteSagaStore", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let store: SagaOffsetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teob-saga-store-"));
    dbPath = join(dir, "sagas.db");
    db = new Database(dbPath);
    store = createSqliteSagaStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 for unseen offset keys", () => {
    expect(store.getOffset("s1", "order", "e1")).toBe(0);
  });

  it("returns 0 for unseen step keys", () => {
    expect(store.getStep("s1", "corr-1")).toBe(0);
  });

  it("sets and gets offsets, upsert overwrites", () => {
    store.setOffset("s1", "order", "e1", SequenceNr(3));
    expect(store.getOffset("s1", "order", "e1")).toBe(3);

    store.setOffset("s1", "order", "e1", SequenceNr(7));
    expect(store.getOffset("s1", "order", "e1")).toBe(7);

    // Distinct keys stay independent
    store.setOffset("s1", "order", "e2", SequenceNr(1));
    store.setOffset("s2", "order", "e1", SequenceNr(2));
    expect(store.getOffset("s1", "order", "e1")).toBe(7);
    expect(store.getOffset("s1", "order", "e2")).toBe(1);
    expect(store.getOffset("s2", "order", "e1")).toBe(2);
  });

  it("sets and gets steps, upsert overwrites", () => {
    store.setStep("s1", "corr-1", 1);
    expect(store.getStep("s1", "corr-1")).toBe(1);

    store.setStep("s1", "corr-1", 2);
    expect(store.getStep("s1", "corr-1")).toBe(2);

    store.setStep("s1", "corr-2", 5);
    store.setStep("s2", "corr-1", 9);
    expect(store.getStep("s1", "corr-1")).toBe(2);
    expect(store.getStep("s1", "corr-2")).toBe(5);
    expect(store.getStep("s2", "corr-1")).toBe(9);
  });

  it("persists offsets and steps across a store re-create on the same db file", () => {
    store.setOffset("s1", "order", "e1", SequenceNr(42));
    store.setStep("s1", "corr-1", 3);
    db.close();

    db = new Database(dbPath);
    store = createSqliteSagaStore(db);
    expect(store.getOffset("s1", "order", "e1")).toBe(42);
    expect(store.getStep("s1", "corr-1")).toBe(3);
    // Unseen keys still default to 0
    expect(store.getOffset("s1", "order", "other")).toBe(0);
    expect(store.getStep("s1", "other")).toBe(0);
  });

  it("makes runSaga resumable across store re-creates (no reprocessing)", async () => {
    const journal = createInMemoryJournal();
    const { runtime } = createInMemoryRuntime([]);
    const seen: number[] = [];
    const s = saga<OrderEvent>({
      name: "totals",
      on: "OrderPlaced",
      from: "order",
      execute: async (event) => {
        seen.push(event.total);
      },
    });

    journal.persistEvents(CategoryId("order"), EntityId("o-1"), [{ tag: "OrderPlaced", total: 10 }], SequenceNr(0), orderCodec);

    await runSaga(s, journal, runtime, store, { eventCodec: orderCodec });
    expect(seen).toEqual([10]);

    // Re-create the store over the same db file: offsets survive, nothing reprocessed
    db.close();
    db = new Database(dbPath);
    store = createSqliteSagaStore(db);
    await runSaga(s, journal, runtime, store, { eventCodec: orderCodec });
    expect(seen).toEqual([10]);

    // A new event is still picked up
    journal.persistEvents(CategoryId("order"), EntityId("o-1"), [{ tag: "OrderPlaced", total: 20 }], SequenceNr(1), orderCodec);
    await runSaga(s, journal, runtime, store, { eventCodec: orderCodec });
    expect(seen).toEqual([10, 20]);
  });
});
