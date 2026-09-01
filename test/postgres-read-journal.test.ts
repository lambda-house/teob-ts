import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  createTestPool,
  ensureSchema,
} from "./fixtures/pg-test-helpers.js";
import {
  createPostgresJournal,
  persistEventsAsync,
  loadEventsAsync,
} from "../src/postgres/journal.js";
import { createPostgresReadJournal } from "../src/postgres/read-journal.js";
import { createReadModel, noopMetrics } from "../src/core/read-model.js";
import { numberConsistency, onGapIgnore } from "../src/core/aggregation.js";
import { startJournalClient } from "../src/core/journal-client.js";
import { testPgConfig } from "./fixtures/pg-test-helpers.js";
import { SequenceNr } from "../src/core/types.js";
import {
  testEventCodec,
  itemAdded,
  itemUpdated,
  metadataUpdated,
  emptyViewEntry,
  updateViewEntry,
  type TestReadModelEvent,
  type TestViewEntry,
} from "./fixtures/read-model-events.js";

describe("PostgresReadJournal", () => {
  let pool: pg.Pool;
  let journal: ReturnType<typeof createPostgresJournal>;
  const testPrefix = `test-read-${Date.now()}`;

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    journal = createPostgresJournal(testPgConfig);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM journal WHERE persistence_id LIKE $1`, [`%${testPrefix}%`]);
    await pool.query(`DELETE FROM snapshot WHERE persistence_id LIKE $1`, [`%${testPrefix}%`]);
    await journal.close();
    await pool.end();
  });

  it("should validate full read model implementation", async () => {
    const pid = `${testPrefix}-full-readmodel`;
    const now = new Date();

    // Persist 4 events: 2 ItemAdded, 1 ItemUpdated, 1 MetadataUpdated
    // Use pid as entityId so eventHasId can extract it
    const events: TestReadModelEvent[] = [
      itemAdded(pid, "item-001", "value1", now),
      itemAdded(pid, "item-002", "value2", new Date(now.getTime() + 1000)),
      itemUpdated(pid, "item-001", "value1-updated", new Date(now.getTime() + 2000)),
      metadataUpdated(pid, { name: "Test Entity", description: "Test Description" }, new Date(now.getTime() + 3000)),
    ];

    await persistEventsAsync(journal, "cat", pid, events, SequenceNr(0), testEventCodec);

    // Verify events in database
    const dbEvents = await loadEventsAsync(journal, "cat", pid, SequenceNr(0), testEventCodec);
    expect(dbEvents).toHaveLength(4);

    // Create ReadModel
    const readModel = createReadModel<string, TestReadModelEvent, number, TestViewEntry>({
      readModelId: "test-read-model",
      cacheTtlMs: 60_000,
      metrics: noopMetrics,
      getState: async (id) => emptyViewEntry(id),
      applyEvent: {
        async apply(state, event, _ordinal) {
          return updateViewEntry(state, event);
        },
      },
      onGap: onGapIgnore(),
      getLastOrdinal: async (_id) => 0,
      eventHasId: (event) => event.entityId, // Extract entity ID from event
      stateHasOrdinal: (state) => state.lastProcessedSeq,
      consistency: numberConsistency,
    });

    // Create read journal
    const readJournal = createPostgresReadJournal(pool, testEventCodec);

    // Start JournalClient with eager preload
    const client = startJournalClient(readJournal, [readModel], {
      eagerPreload: true,
    });

    // Wait for events to be processed (poll until ready)
    let viewEntry: TestViewEntry | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      const entries = readModel.list();
      viewEntry = entries.find((e) => e.entityId === pid);
      if (viewEntry && viewEntry.lastProcessedSeq >= 4) break;
    }
    expect(viewEntry).toBeDefined();

    const entry = viewEntry!;

    // Verify metadata
    expect(entry.metadata).toEqual({ name: "Test Entity", description: "Test Description" });
    expect(entry.incomplete).toBe(false);

    // Verify items
    expect(Object.keys(entry.items)).toHaveLength(2);
    expect(entry.items["item-001"]).toBeDefined();
    expect(entry.items["item-002"]).toBeDefined();
    expect(entry.items["item-001"].value).toBe("value1-updated");
    expect(entry.items["item-002"].value).toBe("value2");

    // Verify sequence: 2 ItemAdded (seq=1,2) + 1 ItemUpdated (no increment) + 1 MetadataUpdated (seq=3)
    expect(entry.seq).toBe(3);

    // Clean up
    client.stop();
    readModel.close();
  }, 15_000);
});
