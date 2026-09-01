import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createTestPool, ensureSchema, cleanupTestData } from "./fixtures/pg-test-helpers.js";
import { testPgConfig } from "./fixtures/pg-test-helpers.js";
import { createPostgresJournal, persistEventsAsync } from "../src/postgres/journal.js";
import { createPostgresReadJournal } from "../src/postgres/read-journal.js";
import { startJournalClient } from "../src/core/journal-client.js";
import { createReadModel, noopMetrics } from "../src/core/read-model.js";
import { onGapIgnore } from "../src/core/aggregation.js";
import { numberConsistency } from "../src/core/aggregation.js";
import type { Codec } from "../src/core/codec.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { JournalClientHandle } from "../src/core/journal-client.js";
import type { ReadModel } from "../src/core/read-model.js";

// --- Counter event types (simpler than TestReadModelEvent, optimized for mass counting) ---

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

const MassCategory = CategoryId("mass-read-test");
const MassEntityPrefix = "mass-entity-";

/** Persist events for a single entity in a batch. */
async function persistEntityEvents(
  journal: ReturnType<typeof createPostgresJournal>,
  entityId: string,
  updatesPerEntity: number,
): Promise<void> {
  const events = Array.from({ length: updatesPerEntity }, (_, i) =>
    counterEvent(entityId, i + 1),
  );
  await persistEventsAsync(
    journal, MassCategory, EntityId(entityId),
    events, SequenceNr(0), counterEventCodec,
  );
}

/** Poll until a condition is met, with timeout. */
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

describe("PostgresMassReadJournal", { timeout: 120_000 }, () => {
  let pool: pg.Pool;
  let journal: ReturnType<typeof createPostgresJournal>;
  const testRunId = Date.now();

  beforeAll(async () => {
    pool = createTestPool();
    await ensureSchema(pool);
    // Clean up any stale data from previous runs
    await cleanupTestData(pool, `${MassCategory}|${MassEntityPrefix}`);
    journal = createPostgresJournal({ ...testPgConfig, maxPoolSize: 10 });
  });

  afterAll(async () => {
    await cleanupTestData(pool, `${MassCategory}|${MassEntityPrefix}`);
    await journal.close();
    await pool.end();
  });

  it("should handle many entities with many updates and verify DB integrity", async () => {
    const numEntities = 50;
    const updatesPerEntity = 500;
    const totalExpected = numEntities * updatesPerEntity;

    console.log(`[MassTest] Phase 1: ${numEntities} entities × ${updatesPerEntity} updates = ${totalExpected} events`);

    // Generate entity IDs
    const entityIds = Array.from({ length: numEntities }, (_, i) =>
      `${MassEntityPrefix}${testRunId}-${i}`,
    );

    // Persist events for all entities concurrently (batches of 10)
    const batchSize = 10;
    for (let i = 0; i < entityIds.length; i += batchSize) {
      const batch = entityIds.slice(i, i + batchSize);
      await Promise.all(batch.map((eid) => persistEntityEvents(journal, eid, updatesPerEntity)));
      console.log(`[MassTest] Persisted: ${Math.min(i + batchSize, numEntities)} / ${numEntities} entities`);
    }

    console.log("[MassTest] All events persisted, verifying DB integrity...");

    // Verify total event count
    const totalResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM journal WHERE persistence_id LIKE $1`,
      [`${MassCategory}|${MassEntityPrefix}${testRunId}-%`],
    );
    const totalEvents = Number(totalResult.rows[0].cnt);
    console.log(`[MassTest] Total events in DB: ${totalEvents} (expected: ${totalExpected})`);
    expect(totalEvents).toBe(totalExpected);

    // Verify distinct persistence IDs
    const distinctResult = await pool.query(
      `SELECT COUNT(DISTINCT persistence_id) as cnt FROM journal WHERE persistence_id LIKE $1`,
      [`${MassCategory}|${MassEntityPrefix}${testRunId}-%`],
    );
    const distinctIds = Number(distinctResult.rows[0].cnt);
    console.log(`[MassTest] Distinct persistence IDs: ${distinctIds} (expected: ${numEntities})`);
    expect(distinctIds).toBe(numEntities);

    // Check for sequence gaps per entity
    const gapResult = await pool.query(
      `SELECT persistence_id, COUNT(*) as event_count,
              MIN(sequence_nr) as min_seq, MAX(sequence_nr) as max_seq
       FROM journal
       WHERE persistence_id LIKE $1
       GROUP BY persistence_id
       HAVING COUNT(*) != MAX(sequence_nr)`,
      [`${MassCategory}|${MassEntityPrefix}${testRunId}-%`],
    );
    if (gapResult.rows.length > 0) {
      console.log(`[MassTest] WARNING: Found ${gapResult.rows.length} entities with sequence gaps!`);
      gapResult.rows.slice(0, 10).forEach((row) => {
        console.log(`  - ${row.persistence_id}: count=${row.event_count}, min=${row.min_seq}, max=${row.max_seq}`);
      });
    } else {
      console.log("[MassTest] No sequence gaps — all entities have contiguous sequences");
    }
    expect(gapResult.rows).toHaveLength(0);

    // Set up ReadModel and JournalClient, verify counters
    const readJournal = createPostgresReadJournal<CounterEvent>(pool, counterEventCodec);
    const readModel = createReadModel<string, CounterEvent, number, CounterViewEntry>({
      readModelId: "mass-read-model",
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

    const clientHandle = startJournalClient(readJournal, [readModel], {
      eagerPreload: true,
      maxConcurrentSubscriptionStarts: 20,
    });

    try {
      // Wait for ReadModel to process all events (filter to our entities only)
      const entityIdSet = new Set(entityIds);
      const ourEntries = () => readModel.list().filter((e) => entityIdSet.has(e.entityId));

      console.log("[MassTest] Waiting for ReadModel to catch up...");
      await pollUntil(
        () => {
          const entries = ourEntries();
          const done = entries.filter((e) => e.counter === updatesPerEntity).length;
          if (done < numEntities) {
            console.log(`[MassTest] ReadModel: ${done}/${numEntities} entities complete (${entries.length} found)`);
            return false;
          }
          return true;
        },
        90_000, 2000, "ReadModel to process all events",
      );

      const entries = ourEntries();
      console.log(`[MassTest] ReadModel entries: ${entries.length}`);
      expect(entries).toHaveLength(numEntities);

      // Verify counters
      const incorrectCounters = entries.filter((e) => e.counter !== updatesPerEntity);
      if (incorrectCounters.length > 0) {
        incorrectCounters.slice(0, 10).forEach((e) => {
          console.log(`  - ${e.entityId}: counter=${e.counter} (expected=${updatesPerEntity})`);
        });
      }
      expect(incorrectCounters).toHaveLength(0);

      // Verify totalSum: sum of 1..updatesPerEntity
      const expectedSumPerEntity = (updatesPerEntity * (updatesPerEntity + 1)) / 2;
      for (const entry of entries) {
        expect(entry.totalSum).toBe(expectedSumPerEntity);
      }

      console.log(`[MassTest] Phase 1 complete: all ${numEntities} entities verified with ${updatesPerEntity} updates each`);
    } finally {
      clientHandle.stop();
      readModel.close();
    }
  });

  it("should verify fetchIds returns all IDs under concurrent inserts", async () => {
    const numNewEntities = 200;
    const phase2RunId = Date.now();

    console.log(`[MassTest] Phase 2: Creating ${numNewEntities} entities concurrently`);

    const entityIds = Array.from({ length: numNewEntities }, (_, i) =>
      `${MassEntityPrefix}${phase2RunId}-phase2-${i}`,
    );

    // Persist one event per entity, concurrently in batches of 50
    const batchSize = 50;
    for (let i = 0; i < entityIds.length; i += batchSize) {
      const batch = entityIds.slice(i, i + batchSize);
      await Promise.all(batch.map((eid) =>
        persistEventsAsync(
          journal, MassCategory, EntityId(eid),
          [counterEvent(eid, 1)], SequenceNr(0), counterEventCodec,
        ),
      ));
      console.log(`[MassTest] Phase 2: Created ${Math.min(i + batchSize, numNewEntities)} / ${numNewEntities}`);
    }

    // Fetch all IDs and verify none are missing
    const readJournal = createPostgresReadJournal<CounterEvent>(pool, counterEventCodec);
    const seenIds = new Set<string>();
    for await (const pid of readJournal.fetchIds()) {
      seenIds.add(pid);
    }

    const expectedIds = new Set(entityIds.map((eid) => `${MassCategory}|${eid}`));
    const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));

    console.log(`[MassTest] Phase 2: fetchIds returned ${seenIds.size} total IDs`);
    if (missingIds.length > 0) {
      console.log(`[MassTest] Phase 2: WARNING - missing ${missingIds.length} IDs:`);
      missingIds.slice(0, 20).forEach((id) => console.log(`  - ${id}`));
    }
    expect(missingIds).toHaveLength(0);
    console.log(`[MassTest] Phase 2: All ${numNewEntities} IDs found!`);

    // Cleanup phase 2 data
    await cleanupTestData(pool, `${MassCategory}|${MassEntityPrefix}${phase2RunId}-phase2-`);
  });
});
