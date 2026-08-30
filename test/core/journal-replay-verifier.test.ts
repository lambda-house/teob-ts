import { describe, it, expect } from "vitest";
import type { Aggregate } from "../../src/core/aggregate.js";
import { CategoryId, EntityId } from "../../src/core/types.js";
import { persist } from "../../src/core/effect.js";
import type { ReadJournal } from "../../src/core/journal.js";
import {
  verifyEntity,
  verifyAll,
  verifyEventStream,
  replayAndVerify,
} from "../../src/core/journal-replay-verifier.js";

// --- Test fixtures ---------------------------------------------------------

type CounterCmd =
  | { tag: "increment"; by: number }
  | { tag: "decrement"; by: number };
type CounterEvent =
  | { tag: "incremented"; by: number }
  | { tag: "decremented"; by: number };
interface CounterState {
  count: number;
}

const counterAggregate: Aggregate<CounterCmd, void, CounterEvent, CounterState> = {
  category: CategoryId("counter"),
  initial: () => ({ count: 0 }),
  async decide(_state, cmd) {
    if (cmd.tag === "increment") return persist({ tag: "incremented", by: cmd.by });
    return persist({ tag: "decremented", by: cmd.by });
  },
  apply(state, e) {
    if (e.tag === "incremented") return { count: state.count + e.by };
    return { count: state.count - e.by };
  },
  invariants: [{ name: "count_non_negative", check: (s) => s.count >= 0 }],
};

// --- Tiny in-memory ReadJournal --------------------------------------------

class FakeReadJournal implements ReadJournal<string, CounterEvent, number> {
  private streams = new Map<string, CounterEvent[]>();

  put(id: string, events: CounterEvent[]): void {
    this.streams.set(id, events);
  }

  async *fetchIds(): AsyncIterable<string> {
    for (const id of this.streams.keys()) yield id;
  }
  async *streamIds(): AsyncIterable<string> {
    for (const id of this.streams.keys()) yield id;
  }
  async lastOrdinal(id: string): Promise<number> {
    return this.streams.get(id)?.length ?? 0;
  }
  async *events(
    id: string,
    from: number,
    to?: number,
  ): AsyncIterable<[CounterEvent, number]> {
    const evs = this.streams.get(id) ?? [];
    const upper = to ?? evs.length;
    for (let i = 0; i < evs.length; i++) {
      const seq = i + 1;
      if (seq <= from) continue;
      if (seq >= upper && to !== undefined) break;
      yield [evs[i], seq];
    }
  }
}

// --- replayAndVerify (legacy) ---------------------------------------------

describe("replayAndVerify (legacy)", () => {
  it("flags violations after specific events", () => {
    const r = replayAndVerify(counterAggregate, EntityId("x"), [
      { tag: "incremented", by: 3 },
      { tag: "decremented", by: 5 },
      { tag: "incremented", by: 10 },
    ]);
    expect(r.eventsReplayed).toBe(3);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].afterEvent).toBe(2);
  });
});

// --- verifyEntity ---------------------------------------------------------

describe("verifyEntity", () => {
  it("verifies a clean entity", async () => {
    const j = new FakeReadJournal();
    j.put("good", [
      { tag: "incremented", by: 3 },
      { tag: "incremented", by: 2 },
    ]);
    const v = await verifyEntity({
      journal: j,
      aggregate: counterAggregate,
      aggregateId: "good",
      fromOrdinal: 0,
    });
    expect(v.isValid).toBe(true);
    expect(v.eventsProcessed).toBe(2);
    expect(v.violations).toHaveLength(0);
    expect(v.finalState.count).toBe(5);
  });

  it("flags a violation with sequenceNr and stateSnippet", async () => {
    const j = new FakeReadJournal();
    j.put("bad", [
      { tag: "incremented", by: 1 },
      { tag: "decremented", by: 5 },
    ]);
    const v = await verifyEntity({
      journal: j,
      aggregate: counterAggregate,
      aggregateId: "bad",
      fromOrdinal: 0,
    });
    expect(v.isValid).toBe(false);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0].sequenceNr).toBe(2);
    expect(v.violations[0].name).toBe("count_non_negative");
    expect(v.violations[0].stateSnippet).toContain("-4");
  });

  it("respects fromOrdinal/toOrdinal bounds", async () => {
    const j = new FakeReadJournal();
    j.put("x", [
      { tag: "incremented", by: 5 },
      { tag: "decremented", by: 100 },
      { tag: "incremented", by: 50 },
    ]);
    const v = await verifyEntity({
      journal: j,
      aggregate: counterAggregate,
      aggregateId: "x",
      fromOrdinal: 0,
      toOrdinal: 2,
    });
    expect(v.eventsProcessed).toBe(1);
    expect(v.isValid).toBe(true);
    expect(v.finalState.count).toBe(5);
  });
});

// --- verifyAll ------------------------------------------------------------

describe("verifyAll", () => {
  it("verifies multiple entities and aggregates the report", async () => {
    const j = new FakeReadJournal();
    j.put("a", [{ tag: "incremented", by: 1 }]);
    j.put("b", [
      { tag: "incremented", by: 1 },
      { tag: "decremented", by: 5 },
    ]);
    j.put("c", [{ tag: "incremented", by: 10 }]);

    const report = await verifyAll({
      journal: j,
      aggregate: counterAggregate,
      fromOrdinal: 0,
    });
    expect(report.entities).toHaveLength(3);
    expect(report.totalEvents).toBe(4);
    expect(report.totalViolations).toBe(1);
    expect(report.isValid).toBe(false);

    const summary = report.summary();
    expect(summary).toContain("3 entities");
    expect(summary).toContain("4 events");
    expect(summary).toContain("1 violations");
    expect(summary).toContain("b (");
    expect(summary).toContain("count_non_negative");
    expect(summary).toContain("2 other entities: ✓");
  });

  it("empty journal yields empty report", async () => {
    const j = new FakeReadJournal();
    const report = await verifyAll({
      journal: j,
      aggregate: counterAggregate,
      fromOrdinal: 0,
    });
    expect(report.entities).toHaveLength(0);
    expect(report.totalEvents).toBe(0);
    expect(report.totalViolations).toBe(0);
    expect(report.isValid).toBe(true);
  });
});

// --- verifyEventStream ----------------------------------------------------

describe("verifyEventStream", () => {
  it("verifies from a sync iterable of events", async () => {
    const v = await verifyEventStream({
      aggregate: counterAggregate,
      aggregateId: "y",
      events: [
        { tag: "incremented", by: 3 },
        { tag: "decremented", by: 5 },
      ] satisfies CounterEvent[],
    });
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0].sequenceNr).toBe(2);
  });
});
