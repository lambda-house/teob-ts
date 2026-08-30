import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  createTestPool,
  ensureSchema,
  countJournalEvents,
  getIdleConnections,
} from "./fixtures/pg-test-helpers.js";
import {
  createPostgresJournal,
  persistEventsAsync,
  loadEventsAsync,
  persistSnapshotAsync,
  loadSnapshotAsync,
  highestSequenceNr,
  fetchPersistenceIds,
} from "../src/postgres/journal.js";
import { createPostgresReadJournal } from "../src/postgres/read-journal.js";
import { testPgConfig } from "./fixtures/pg-test-helpers.js";
import { SequenceNr } from "../src/core/types.js";
import type { Codec } from "../src/core/codec.js";

// Simple test event
type TestEvent = { tag: "TestEvent"; data: string };
const testEventCodec: Codec<TestEvent> = {
  manifest: () => "TestEvent",
  encode: (e) => e,
  decode: (_m, d) => d as TestEvent,
};

describe("PostgresJournalPlugin", () => {
  let pool: pg.Pool;
  let journal: ReturnType<typeof createPostgresJournal>;
  const ts = Date.now();
  // categoryId used for all tests — persistence_id in DB will be "tcat|<entityId>"
  const cat = "tcat";

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    journal = createPostgresJournal(testPgConfig);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`${cat}|%`]);
    await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`${cat}|%`]);
    await journal.close();
    await pool.end();
  });

  /** Full persistence_id as stored in the DB. */
  function dbPid(entityId: string): string {
    return `${cat}|${entityId}`;
  }

  it("should persist and recover events", async () => {
    const eid = `persist-recover-${ts}`;

    const events: TestEvent[] = [
      { tag: "TestEvent", data: "Event1" },
      { tag: "TestEvent", data: "Event2" },
    ];

    const seqNr = await persistEventsAsync(
      journal, cat, eid, events, SequenceNr(0), testEventCodec,
    );
    expect(seqNr).toBe(2);

    const loaded = await loadEventsAsync(journal, cat, eid, SequenceNr(0), testEventCodec);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].event.data).toBe("Event1");
    expect(loaded[0].sequenceNr).toBe(1);
    expect(loaded[1].event.data).toBe("Event2");
    expect(loaded[1].sequenceNr).toBe(2);
  });

  it("should handle multiple persistence IDs independently", async () => {
    const eid1 = `multi-1-${ts}`;
    const eid2 = `multi-2-${ts}`;

    await persistEventsAsync(journal, cat, eid1, [
      { tag: "TestEvent", data: "Actor1-Event1" },
      { tag: "TestEvent", data: "Actor1-Event2" },
    ], SequenceNr(0), testEventCodec);

    await persistEventsAsync(journal, cat, eid2, [
      { tag: "TestEvent", data: "Actor2-Event1" },
    ], SequenceNr(0), testEventCodec);

    const events1 = await loadEventsAsync(journal, cat, eid1, SequenceNr(0), testEventCodec);
    const events2 = await loadEventsAsync(journal, cat, eid2, SequenceNr(0), testEventCodec);

    expect(events1).toHaveLength(2);
    expect(events1.map((e) => e.event.data)).toEqual(["Actor1-Event1", "Actor1-Event2"]);

    expect(events2).toHaveLength(1);
    expect(events2[0].event.data).toBe("Actor2-Event1");
  });

  it("should store events in database with correct structure", async () => {
    const eid = `db-verify-${ts}`;
    const pid = dbPid(eid);

    await persistEventsAsync(journal, cat, eid, [
      { tag: "TestEvent", data: "DbEvent1" },
      { tag: "TestEvent", data: "DbEvent2" },
    ], SequenceNr(0), testEventCodec);

    // Query database directly using the full persistence_id
    const result = await pool.query(
      `SELECT persistence_id, sequence_nr, event_manifest FROM journal
       WHERE persistence_id = $1 ORDER BY sequence_nr`,
      [pid],
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].persistence_id).toBe(pid);
    expect(Number(result.rows[0].sequence_nr)).toBe(1);
    expect(result.rows[0].event_manifest).toBe("TestEvent");
    expect(Number(result.rows[1].sequence_nr)).toBe(2);
  });

  it("should read events and list persistence IDs via PostgresReadJournal", async () => {
    const readJournal = createPostgresReadJournal(pool, testEventCodec);

    // Test 1: Read all events
    const eid1 = `read-journal-${ts}`;
    const pid1 = dbPid(eid1);
    await persistEventsAsync(journal, cat, eid1, [
      { tag: "TestEvent", data: "ReadJournalEvent1" },
      { tag: "TestEvent", data: "ReadJournalEvent2" },
      { tag: "TestEvent", data: "ReadJournalEvent3" },
    ], SequenceNr(0), testEventCodec);

    const events: Array<[TestEvent, number]> = [];
    for await (const item of readJournal.events(pid1, 1)) {
      events.push(item);
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual([{ tag: "TestEvent", data: "ReadJournalEvent1" }, 1]);
    expect(events[1]).toEqual([{ tag: "TestEvent", data: "ReadJournalEvent2" }, 2]);
    expect(events[2]).toEqual([{ tag: "TestEvent", data: "ReadJournalEvent3" }, 3]);

    // Test 2: Read events with bounded range [2, 5) → events at seq 2, 3, 4
    const eid2 = `read-bounded-${ts}`;
    const pid2 = dbPid(eid2);
    await persistEventsAsync(journal, cat, eid2, [
      { tag: "TestEvent", data: "Event1" },
      { tag: "TestEvent", data: "Event2" },
      { tag: "TestEvent", data: "Event3" },
      { tag: "TestEvent", data: "Event4" },
      { tag: "TestEvent", data: "Event5" },
    ], SequenceNr(0), testEventCodec);

    const bounded: Array<[TestEvent, number]> = [];
    for await (const item of readJournal.events(pid2, 2, 5)) {
      bounded.push(item);
    }
    expect(bounded).toHaveLength(3);
    expect(bounded.map(([_, seq]) => seq)).toEqual([2, 3, 4]);

    // Test 3: List persistence IDs
    const ids: string[] = [];
    for await (const id of readJournal.fetchIds()) {
      ids.push(id);
    }
    expect(ids).toContain(pid1);
    expect(ids).toContain(pid2);
  });

  it("should not leak database connections after multiple operations", async () => {
    const baselineConnections = await getIdleConnections(pool);

    const iterations = 50;
    for (let i = 0; i < iterations; i++) {
      const eid = `conn-leak-${ts}-${i}`;
      await persistEventsAsync(journal, cat, eid, [
        { tag: "TestEvent", data: `Event-${i}` },
      ], SequenceNr(0), testEventCodec);
    }

    await new Promise((r) => setTimeout(r, 1000));

    const finalConnections = await getIdleConnections(pool);
    const connectionGrowth = finalConnections - baselineConnections;
    expect(connectionGrowth).toBeLessThan(10);
  });
});
