import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  createTestPool,
  ensureSchema,
  insertEvent,
  insertSnapshot,
  countJournalEvents,
  countSnapshots,
  minSequenceNr,
} from "./fixtures/pg-test-helpers.js";
import { createCleanJournal } from "../src/postgres/clean-journal.js";
import {
  testEventCodec,
  itemAdded,
} from "./fixtures/read-model-events.js";

describe("PostgresCleanJournal", () => {
  let pool: pg.Pool;
  const testPrefix = `test-clean-${Date.now()}`;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`${testPrefix}%`]);
    await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`${testPrefix}%`]);
    await pool.end();
  });

  const cleanJournal = () => createCleanJournal(pool);

  // Helper to insert N events for a persistence ID
  async function insertEvents(pid: string, count: number, timestamp?: Date) {
    for (let i = 1; i <= count; i++) {
      const event = itemAdded(pid, `item-${i}`, `value-${i}`, timestamp);
      await insertEvent(pool, pid, i, testEventCodec.encode(event), testEventCodec.manifest(event), timestamp);
    }
  }

  describe("deleteJournalEvents", () => {
    it("should delete all journal events for an entity", async () => {
      const pid = `${testPrefix}-delete-all`;
      await insertEvents(pid, 5);
      expect(await countJournalEvents(pool, pid)).toBe(5);

      const count = await cleanJournal().deleteJournalEvents(pid);
      expect(count).toBe(5);
      expect(await countJournalEvents(pool, pid)).toBe(0);
    });

    it("should return 0 when no events exist", async () => {
      const pid = `${testPrefix}-no-events`;
      expect(await countJournalEvents(pool, pid)).toBe(0);

      const count = await cleanJournal().deleteJournalEvents(pid);
      expect(count).toBe(0);
    });
  });

  describe("deleteJournalEventsTo", () => {
    it("should delete events up to a given sequence number", async () => {
      const pid = `${testPrefix}-delete-to-seq`;
      await insertEvents(pid, 10);
      expect(await countJournalEvents(pool, pid)).toBe(10);

      const count = await cleanJournal().deleteJournalEventsTo(pid, 5);
      expect(count).toBe(5);
      expect(await countJournalEvents(pool, pid)).toBe(5);
      expect(await minSequenceNr(pool, pid)).toBe(6);
    });
  });

  describe("deleteJournalEventsBefore", () => {
    it("should delete events before a given timestamp", async () => {
      const pid = `${testPrefix}-delete-before-ts`;

      const now = new Date();
      const oldTime = new Date(now.getTime() - 3600 * 1000); // 1 hour ago
      const cutoffTime = new Date(now.getTime() - 1800 * 1000); // 30 minutes ago

      // Insert 3 old events
      for (let i = 1; i <= 3; i++) {
        const event = itemAdded(pid, `old-item-${i}`, `value-${i}`, oldTime);
        await insertEvent(pool, pid, i, testEventCodec.encode(event), testEventCodec.manifest(event), oldTime);
      }
      // Insert 2 new events
      for (let i = 4; i <= 5; i++) {
        const event = itemAdded(pid, `new-item-${i}`, `value-${i}`, now);
        await insertEvent(pool, pid, i, testEventCodec.encode(event), testEventCodec.manifest(event), now);
      }

      expect(await countJournalEvents(pool, pid)).toBe(5);

      const count = await cleanJournal().deleteJournalEventsBefore(pid, cutoffTime);
      expect(count).toBe(3);
      expect(await countJournalEvents(pool, pid)).toBe(2);
    });
  });

  describe("deleteSnapshots", () => {
    it("should delete all snapshots for an entity", async () => {
      const pid = `${testPrefix}-delete-snapshots`;

      for (let i = 1; i <= 3; i++) {
        await insertSnapshot(pool, pid, i * 10, { state: `state-${i}` }, "TestState");
      }
      expect(await countSnapshots(pool, pid)).toBe(3);

      const count = await cleanJournal().deleteSnapshots(pid);
      expect(count).toBe(3);
      expect(await countSnapshots(pool, pid)).toBe(0);
    });
  });

  describe("deleteSnapshotsTo", () => {
    it("should delete snapshots up to a given sequence number", async () => {
      const pid = `${testPrefix}-delete-snapshots-to`;

      // Insert snapshots at seq 10, 20, 30, 40, 50
      for (let i = 1; i <= 5; i++) {
        await insertSnapshot(pool, pid, i * 10, { state: `state-${i}` }, "TestState");
      }
      expect(await countSnapshots(pool, pid)).toBe(5);

      const count = await cleanJournal().deleteSnapshotsTo(pid, 30);
      expect(count).toBe(3);
      expect(await countSnapshots(pool, pid)).toBe(2); // snapshots at 40 and 50 remain
    });
  });

  describe("deleteAll", () => {
    it("should delete all events and snapshots for an entity", async () => {
      const pid = `${testPrefix}-delete-all-data`;
      await insertEvents(pid, 10);
      for (let i = 1; i <= 3; i++) {
        await insertSnapshot(pool, pid, i * 10, { state: `state-${i}` }, "TestState");
      }

      expect(await countJournalEvents(pool, pid)).toBe(10);
      expect(await countSnapshots(pool, pid)).toBe(3);

      const [eventsDeleted, snapshotsDeleted] = await cleanJournal().deleteAll(pid);
      expect(eventsDeleted).toBe(10);
      expect(snapshotsDeleted).toBe(3);
      expect(await countJournalEvents(pool, pid)).toBe(0);
      expect(await countSnapshots(pool, pid)).toBe(0);
    });
  });

  describe("journal compaction scenario", () => {
    it("should compact journal by keeping only events after snapshot", async () => {
      const pid = `${testPrefix}-compaction`;

      // Insert 100 events
      for (let seq = 1; seq <= 100; seq++) {
        const event = itemAdded(pid, `item-${seq}`, `value-${seq}`);
        await insertEvent(pool, pid, seq, testEventCodec.encode(event), testEventCodec.manifest(event));
      }
      // Insert snapshot at seq 50
      await insertSnapshot(pool, pid, 50, { entityId: pid, itemCount: 50 }, "TestState");

      expect(await countJournalEvents(pool, pid)).toBe(100);
      expect(await countSnapshots(pool, pid)).toBe(1);

      // Delete events covered by snapshot
      const count = await cleanJournal().deleteJournalEventsTo(pid, 50);
      expect(count).toBe(50);
      expect(await countJournalEvents(pool, pid)).toBe(50); // events 51-100 remain
      expect(await minSequenceNr(pool, pid)).toBe(51);
      expect(await countSnapshots(pool, pid)).toBe(1); // snapshot remains
    });

    it("should delete old snapshots while keeping the most recent", async () => {
      const pid = `${testPrefix}-snapshot-cleanup`;

      // Insert snapshots at seq 10, 20, 30, 40, 50
      for (let i = 1; i <= 5; i++) {
        await insertSnapshot(pool, pid, i * 10, { state: `state-${i}` }, "TestState");
      }
      expect(await countSnapshots(pool, pid)).toBe(5);

      // Keep only latest (seq 50), delete up to 40
      const count = await cleanJournal().deleteSnapshotsTo(pid, 40);
      expect(count).toBe(4);
      expect(await countSnapshots(pool, pid)).toBe(1); // only snapshot at 50 remains
    });
  });
});
