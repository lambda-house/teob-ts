import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createTestPool, ensureSchema, cleanupTestData } from "./fixtures/pg-test-helpers.js";
import { testPgConfig } from "./fixtures/pg-test-helpers.js";
import { createPostgresJournal, persistEventsAsync } from "../src/postgres/journal.js";
import { createPostgresReadJournal } from "../src/postgres/read-journal.js";
import { startJournalClient } from "../src/core/journal-client.js";
import { createReadModel, noopMetrics } from "../src/core/read-model.js";
import { onGapIgnore, numberConsistency } from "../src/core/aggregation.js";
import type { Codec } from "../src/core/codec.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";

// --- Counter event types ---

interface CounterEvent {
  tag: "Updated";
  entityId: string;
  updateNum: number;
  timestamp: string;
}

interface CounterViewEntry {
  entityId: string;
  counter: number;
  totalSum: number;
  lastProcessedSeq: number;
}

function counterEvent(entityId: string, updateNum: number): CounterEvent {
  return { tag: "Updated", entityId, updateNum, timestamp: new Date().toISOString() };
}

function emptyCounterEntry(entityId: string): CounterViewEntry {
  return { entityId, counter: 0, totalSum: 0, lastProcessedSeq: 0 };
}

function applyCounterEvent(entry: CounterViewEntry, event: CounterEvent, ordinal: number): CounterViewEntry {
  return {
    ...entry,
    counter: entry.counter + 1,
    totalSum: entry.totalSum + event.updateNum,
    lastProcessedSeq: ordinal,
  };
}

const counterEventCodec: Codec<CounterEvent> = {
  manifest(_event: CounterEvent): string { return "Updated"; },
  encode(event: CounterEvent): unknown { return event; },
  decode(manifest: string, data: unknown): CounterEvent {
    const obj = data as Record<string, unknown>;
    return { ...obj, tag: manifest } as CounterEvent;
  },
};

// --- Helpers ---

const HeavyCategory = CategoryId("heavy-load-test");
const HeavyEntityPrefix = "heavy-entity-";

async function pollUntil(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs: number = 500,
  label: string = "condition",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

// --- Tests ---

describe("PostgresHeavyLoadReadJournal", { timeout: 120_000 }, () => {
  const NumEntities = 80;
  const UpdatesPerEntity = 250;
  const TotalExpectedEvents = NumEntities * UpdatesPerEntity;

  let pool: pg.Pool;
  let journal: ReturnType<typeof createPostgresJournal>;
  const testRunId = Date.now();

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    await cleanupTestData(pool, `${HeavyCategory}|${HeavyEntityPrefix}`);
    journal = createPostgresJournal({ ...testPgConfig, maxPoolSize: 10 });
  });

  afterAll(async () => {
    await cleanupTestData(pool, `${HeavyCategory}|${HeavyEntityPrefix}`);
    await journal.close();
    await pool.end();
  });

  it("should continue making progress under load even when table is locked", async () => {
    console.log(`[HeavyLoadTest] Starting: ${NumEntities} entities × ${UpdatesPerEntity} updates = ${TotalExpectedEvents} events`);

    const entityIds = Array.from({ length: NumEntities }, (_, i) =>
      `${HeavyEntityPrefix}${testRunId}-${i}`,
    );

    // Phase 1: Persist ALL events for all entities
    console.log("[HeavyLoadTest] Phase 1: Persisting all events...");
    const batchSize = 10;
    for (let i = 0; i < entityIds.length; i += batchSize) {
      const batch = entityIds.slice(i, i + batchSize);
      await Promise.all(batch.map((eid) => {
        const events = Array.from({ length: UpdatesPerEntity }, (_, j) =>
          counterEvent(eid, j + 1),
        );
        return persistEventsAsync(
          journal, HeavyCategory, EntityId(eid),
          events, SequenceNr(0), counterEventCodec,
        );
      }));
      console.log(`[HeavyLoadTest] Persisted: ${Math.min(i + batchSize, NumEntities)} / ${NumEntities} entities`);
    }
    console.log(`[HeavyLoadTest] All ${TotalExpectedEvents} events persisted`);

    // Phase 2: Lock the table for 3 seconds, then start JournalClient
    // This forces read timeouts during event processing
    console.log("[HeavyLoadTest] Phase 2: Locking table + starting JournalClient concurrently...");

    const readJournal = createPostgresReadJournal<CounterEvent>(pool, counterEventCodec);
    const readModel = createReadModel<string, CounterEvent, number, CounterViewEntry>({
      readModelId: "heavy-load-read-model",
      cacheTtlMs: 120_000,
      metrics: noopMetrics,
      getState: async (id) => emptyCounterEntry(id),
      applyEvent: {
        async apply(state, event, ordinal) {
          return applyCounterEvent(state, event, ordinal);
        },
      },
      onGap: onGapIgnore(),
      getLastOrdinal: async () => 0,
      eventHasId: (event) => event.entityId,
      stateHasOrdinal: (state) => state.lastProcessedSeq,
      consistency: numberConsistency,
    });

    // Lock table in background — forces read failures while JournalClient starts
    const lockPromise = (async () => {
      const lockClient = await pool.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query("LOCK TABLE journal IN ACCESS EXCLUSIVE MODE");
        console.log("[HeavyLoadTest] Table locked for 3 seconds...");
        await new Promise((r) => setTimeout(r, 3000));
        await lockClient.query("COMMIT");
        console.log("[HeavyLoadTest] Table lock released");
      } finally {
        lockClient.release();
      }
    })();

    // Start JournalClient while table is locked — it should retry and eventually succeed
    const clientHandle = startJournalClient(readJournal, [readModel], {
      eagerPreload: true,
      maxConcurrentSubscriptionStarts: 20,
      subscriptionRestartInitialDelayMs: 500,
      subscriptionRestartMaxDelayMs: 5000,
    });

    const entityIdSet = new Set(entityIds);
    const ourEntries = () => readModel.list().filter((e) => entityIdSet.has(e.entityId));

    try {
      // Wait for lock to release
      await lockPromise;

      // Wait for ReadModel to process all events
      console.log("[HeavyLoadTest] Waiting for ReadModel to catch up...");
      await pollUntil(
        () => {
          const entries = ourEntries();
          const done = entries.filter((e) => e.counter === UpdatesPerEntity).length;
          if (done < NumEntities) {
            console.log(`[HeavyLoadTest] ReadModel: ${done}/${NumEntities} entities complete (${entries.length} found)`);
            return false;
          }
          return true;
        },
        60_000, 2000, "ReadModel to process all events despite lock",
      );

      const entries = ourEntries();
      expect(entries).toHaveLength(NumEntities);

      // Verify counters
      const incorrectCounters = entries.filter((e) => e.counter !== UpdatesPerEntity);
      if (incorrectCounters.length > 0) {
        console.log(`[HeavyLoadTest] Entries with wrong counter: ${incorrectCounters.length}`);
        incorrectCounters.slice(0, 10).forEach((e) => {
          console.log(`  - ${e.entityId}: counter=${e.counter} (expected=${UpdatesPerEntity})`);
        });
      }
      expect(incorrectCounters).toHaveLength(0);

      // Verify totalSum: sum of 1..UpdatesPerEntity
      const expectedSum = (UpdatesPerEntity * (UpdatesPerEntity + 1)) / 2;
      const totalSum = entries.reduce((sum, e) => sum + e.totalSum, 0);
      const expectedTotalSum = NumEntities * expectedSum;
      console.log(`[HeavyLoadTest] Total sum: ${totalSum} (expected: ${expectedTotalSum})`);
      expect(totalSum).toBe(expectedTotalSum);

      // Phase 3: Verify DB integrity
      const totalResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM journal WHERE persistence_id LIKE $1`,
        [`${HeavyCategory}|${HeavyEntityPrefix}${testRunId}-%`],
      );
      const totalEvents = Number(totalResult.rows[0].cnt);
      console.log(`[HeavyLoadTest] DB event count: ${totalEvents} (expected: ${TotalExpectedEvents})`);
      expect(totalEvents).toBe(TotalExpectedEvents);

      // Check for sequence gaps
      const gapResult = await pool.query(
        `SELECT persistence_id, COUNT(*) as event_count,
                MIN(sequence_nr) as min_seq, MAX(sequence_nr) as max_seq
         FROM journal
         WHERE persistence_id LIKE $1
         GROUP BY persistence_id
         HAVING COUNT(*) != MAX(sequence_nr)`,
        [`${HeavyCategory}|${HeavyEntityPrefix}${testRunId}-%`],
      );
      if (gapResult.rows.length > 0) {
        console.log(`[HeavyLoadTest] WARNING: ${gapResult.rows.length} entities with sequence gaps!`);
      } else {
        console.log("[HeavyLoadTest] No sequence gaps — all contiguous");
      }
      expect(gapResult.rows).toHaveLength(0);

      console.log("[HeavyLoadTest] All assertions passed!");
    } finally {
      clientHandle.stop();
      readModel.close();
    }
  });
});
