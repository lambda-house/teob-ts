import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  createTestPool,
  ensureSchema,
  insertEvent,
  insertSnapshot,
} from "./fixtures/pg-test-helpers.js";
import { createPostgresReadJournal } from "../src/postgres/read-journal.js";
import { persistEventsAsync, createPostgresJournal } from "../src/postgres/journal.js";
import { testPgConfig } from "./fixtures/pg-test-helpers.js";
import { SequenceNr } from "../src/core/types.js";
import {
  testEventCodec,
  testViewEntryCodec,
  itemAdded,
  itemUpdated,
  metadataUpdated,
  type TestReadModelEvent,
  type TestViewEntry,
} from "./fixtures/read-model-events.js";

describe("PostgresReadJournal snapshot recovery", () => {
  let pool: pg.Pool;
  const testPrefix = `test-snapshot-${Date.now()}`;
  const cat = "cat";

  /** Full persistence_id as stored in DB by persistEventsAsync. */
  function dbPid(entityId: string): string {
    return `${cat}|${entityId}`;
  }

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
  });

  afterAll(async () => {
    // Clean up both raw prefix (snapshot-only tests) and cat-prefixed (eventsWithSnapshot tests)
    await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`${testPrefix}%`]);
    await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`${cat}|${testPrefix}%`]);
    await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`${testPrefix}%`]);
    await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`${cat}|${testPrefix}%`]);
    await pool.end();
  });

  const readJournal = () => createPostgresReadJournal(pool, testEventCodec);

  it("should load snapshot when available", async () => {
    const pid = `${testPrefix}-load`;
    const now = new Date();

    const snapshotState: TestViewEntry = {
      entityId: "entity-1",
      metadata: { name: "Test Entity", description: "Test Description" },
      items: {
        "item-001": { itemId: "item-001", value: "value1", lastUpdated: now.toISOString() },
        "item-002": { itemId: "item-002", value: "value2", lastUpdated: now.toISOString() },
      },
      lastUpdated: now.toISOString(),
      seq: 5,
      lastProcessedSeq: 10,
      incomplete: false,
    };

    await insertSnapshot(pool, pid, 10, testViewEntryCodec.encode(snapshotState), "TestViewEntry");

    const snapshot = await readJournal().loadSnapshot(pid, testViewEntryCodec);
    expect(snapshot).toBeDefined();
    expect(snapshot!.sequenceNr).toBe(10);
    expect(snapshot!.state.entityId).toBe("entity-1");
    expect(snapshot!.state.seq).toBe(5);
    expect(Object.keys(snapshot!.state.items)).toHaveLength(2);
    expect(snapshot!.state.metadata).toEqual({ name: "Test Entity", description: "Test Description" });
  });

  it("should return undefined when no snapshot exists", async () => {
    const pid = `${testPrefix}-no-snapshot`;

    const snapshot = await readJournal().loadSnapshot(pid, testViewEntryCodec);
    expect(snapshot).toBeUndefined();
  });

  it("should load latest snapshot when multiple exist", async () => {
    const pid = `${testPrefix}-multi-snapshot`;
    const now = new Date();

    // Insert 3 snapshots at seq 5, 10, 15
    for (const [seqNr, name, itemCount] of [
      [5, "First", 1],
      [10, "Second", 2],
      [15, "Latest", 3],
    ] as [number, string, number][]) {
      const items: Record<string, { itemId: string; value: string; lastUpdated: string }> = {};
      for (let i = 1; i <= itemCount; i++) {
        items[`item-00${i}`] = { itemId: `item-00${i}`, value: `v${i}`, lastUpdated: now.toISOString() };
      }

      const state: TestViewEntry = {
        entityId: "entity-1",
        metadata: { name, description: seqNr === 15 ? "Final snapshot" : undefined },
        items,
        lastUpdated: now.toISOString(),
        seq: seqNr === 5 ? 1 : seqNr === 10 ? 3 : 6,
        lastProcessedSeq: seqNr,
        incomplete: false,
      };

      await insertSnapshot(
        pool,
        pid,
        seqNr,
        testViewEntryCodec.encode(state),
        "TestViewEntry",
        new Date(now.getTime() - (15 - seqNr) * 1000),
      );
    }

    const snapshot = await readJournal().loadSnapshot(pid, testViewEntryCodec);
    expect(snapshot).toBeDefined();
    expect(snapshot!.sequenceNr).toBe(15);
    expect(snapshot!.state.metadata).toEqual({ name: "Latest", description: "Final snapshot" });
    expect(Object.keys(snapshot!.state.items)).toHaveLength(3);
    expect(snapshot!.state.seq).toBe(6);
  });

  it("should recover with eventsWithSnapshot - snapshot exists with events after", async () => {
    const pid = `${testPrefix}-recovery-with-snap`;
    const fullPid = dbPid(pid);
    const journal = createPostgresJournal(testPgConfig);
    const now = new Date();

    // Persist 5 events (stored as cat|pid in DB)
    const events: TestReadModelEvent[] = [
      itemAdded("e1", "item-001", "v1", now),
      itemAdded("e1", "item-002", "v2", new Date(now.getTime() + 1000)),
      itemUpdated("e1", "item-001", "v1-updated", new Date(now.getTime() + 2000)),
      metadataUpdated("e1", { name: "Meta" }, new Date(now.getTime() + 3000)),
      itemAdded("e1", "item-003", "v3", new Date(now.getTime() + 4000)),
    ];

    await persistEventsAsync(journal, cat, pid, events, SequenceNr(0), testEventCodec);

    // Insert snapshot at sequence 3 — must use full persistence_id to match events
    const snapshotState: TestViewEntry = {
      entityId: "e1",
      metadata: undefined,
      items: {
        "item-001": { itemId: "item-001", value: "v1-updated", lastUpdated: new Date(now.getTime() + 2000).toISOString() },
        "item-002": { itemId: "item-002", value: "v2", lastUpdated: new Date(now.getTime() + 1000).toISOString() },
      },
      lastUpdated: new Date(now.getTime() + 2000).toISOString(),
      seq: 2,
      lastProcessedSeq: 3,
      incomplete: false,
    };
    await insertSnapshot(pool, fullPid, 3, testViewEntryCodec.encode(snapshotState), "TestViewEntry");

    // Recover with eventsWithSnapshot — use full persistence_id
    const recovery = await readJournal().eventsWithSnapshot(fullPid, testEventCodec, testViewEntryCodec);

    // Verify snapshot was loaded
    expect(recovery.snapshot).toBeDefined();
    expect(recovery.snapshot!.sequenceNr).toBe(3);
    expect(Object.keys(recovery.snapshot!.state.items)).toHaveLength(2);

    // Should get events 4 and 5 (after snapshot)
    expect(recovery.events).toHaveLength(2);
    expect(recovery.events[0].sequenceNr).toBe(4);
    expect(recovery.events[0].event.tag).toBe("MetadataUpdated");
    expect(recovery.events[1].sequenceNr).toBe(5);
    expect(recovery.events[1].event.tag).toBe("ItemAdded");
    expect((recovery.events[1].event as Extract<TestReadModelEvent, { tag: "ItemAdded" }>).itemId).toBe("item-003");

    await journal.close();
  });

  it("should recover with eventsWithSnapshot - no snapshot exists", async () => {
    const pid = `${testPrefix}-recovery-no-snap`;
    const fullPid = dbPid(pid);
    const journal = createPostgresJournal(testPgConfig);
    const now = new Date();

    // Persist 3 events without snapshot (stored as cat|pid in DB)
    const events: TestReadModelEvent[] = [
      itemAdded("e1", "item-001", "v1", now),
      itemAdded("e1", "item-002", "v2", new Date(now.getTime() + 1000)),
      metadataUpdated("e1", { name: "Meta" }, new Date(now.getTime() + 2000)),
    ];

    await persistEventsAsync(journal, cat, pid, events, SequenceNr(0), testEventCodec);

    // Use full persistence_id for query
    const recovery = await readJournal().eventsWithSnapshot(fullPid, testEventCodec, testViewEntryCodec);

    // No snapshot
    expect(recovery.snapshot).toBeUndefined();

    // All 3 events from the beginning
    expect(recovery.events).toHaveLength(3);
    expect(recovery.events.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);

    await journal.close();
  });
});
