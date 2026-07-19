import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { Aggregate, Invariant } from "../../src/core/aggregate.js";
import { CategoryId, EntityId } from "../../src/core/types.js";
import { persist, reply } from "../../src/core/effect.js";
import {
  runCommandSequence,
  invariantProperty,
  assertInvariants,
} from "../../src/testing/invariant-testkit.js";

// --- Counter aggregate test fixture ----------------------------------------

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

// Invariant that always passes
const trivialInv: Invariant<CounterState> = { name: "always_true", check: () => true };

describe("runCommandSequence", () => {
  it("empty command list yields no violations and no steps", async () => {
    const trace = await runCommandSequence({
      aggregate: counterAggregate,
      aggregateId: "test",
      commands: [],
    });
    expect(trace.steps).toHaveLength(0);
    expect(trace.totalViolations).toBe(0);
    expect(trace.initialViolations).toHaveLength(0);
  });

  it("non-violating sequence yields no violations", async () => {
    const trace = await runCommandSequence({
      aggregate: counterAggregate,
      aggregateId: "test",
      commands: [
        { tag: "increment", by: 5 },
        { tag: "increment", by: 3 },
        { tag: "decrement", by: 2 },
      ],
    });
    expect(trace.totalViolations).toBe(0);
    expect(trace.steps).toHaveLength(3);
    expect(trace.steps[2].stateAfter.count).toBe(6);
  });

  it("violating sequence records violation at correct step", async () => {
    const trace = await runCommandSequence({
      aggregate: counterAggregate,
      aggregateId: "bad",
      commands: [
        { tag: "increment", by: 1 },
        { tag: "decrement", by: 5 },
      ],
    });
    expect(trace.totalViolations).toBe(1);
    expect(trace.steps[0].violations).toHaveLength(0);
    expect(trace.steps[1].violations).toHaveLength(1);
    expect(trace.steps[1].violations[0].name).toBe("count_non_negative");
    expect(trace.steps[1].violations[0].sequenceNr).toBe(2);
    expect(trace.steps[1].stateAfter.count).toBe(-4);
  });

  it("multiple invariants evaluated independently", async () => {
    const failingInv: Invariant<CounterState> = { name: "always_false", check: () => false };
    const trace = await runCommandSequence({
      aggregate: counterAggregate,
      aggregateId: "x",
      commands: [{ tag: "increment", by: 1 }],
      invariants: [trivialInv, failingInv, counterAggregate.invariants![0]],
    });
    expect(trace.steps[0].violations.map((v) => v.name)).toEqual(["always_false"]);
    // initial state also fails the always_false invariant, so total = 2
    expect(trace.initialViolations.map((v) => v.name)).toEqual(["always_false"]);
    expect(trace.totalViolations).toBe(2);
  });
});

describe("invariantProperty / assertInvariants", () => {
  it("passes for an aggregate that always satisfies invariants", async () => {
    await assertInvariants({
      aggregate: counterAggregate,
      commandArb: fc.record({
        tag: fc.constant("increment" as const),
        by: fc.integer({ min: 0, max: 100 }),
      }),
      invariants: counterAggregate.invariants!,
      numRuns: 25,
    });
  });

  it("fast-check shrinks to a minimal failing sequence", async () => {
    const prop = invariantProperty({
      aggregate: counterAggregate,
      commandArb: fc.oneof(
        fc.record({ tag: fc.constant("increment" as const), by: fc.integer({ min: 1, max: 10 }) }),
        fc.record({ tag: fc.constant("decrement" as const), by: fc.integer({ min: 1, max: 10 }) }),
      ),
      invariants: counterAggregate.invariants!,
      maxCommands: 8,
    });
    const result = await fc.check(prop, { numRuns: 200, seed: 42 });
    expect(result.failed).toBe(true);
    // Counterexample is [aggregateId, commands]
    const counterex = result.counterexample as [string, CounterCmd[]];
    const minimal = counterex[1];
    // Shrunk minimal example should be 1 decrement command (sufficient to violate).
    expect(minimal.length).toBeLessThanOrEqual(2);
    expect(minimal.some((c) => c.tag === "decrement")).toBe(true);
  });

  it("assertInvariants throws when a violating sequence is found", async () => {
    await expect(
      assertInvariants({
        aggregate: counterAggregate,
        commandArb: fc.record({
          tag: fc.constant("decrement" as const),
          by: fc.integer({ min: 1, max: 10 }),
        }),
        invariants: counterAggregate.invariants!,
        numRuns: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("async aggregate decide is awaited", () => {
  it("supports promise-returning decide functions", async () => {
    const asyncAgg: Aggregate<CounterCmd, void, CounterEvent, CounterState> = {
      ...counterAggregate,
      async decide(_state, cmd) {
        await new Promise((res) => setTimeout(res, 1));
        if (cmd.tag === "increment") return persist({ tag: "incremented", by: cmd.by });
        return persist({ tag: "decremented", by: cmd.by });
      },
    };
    const trace = await runCommandSequence({
      aggregate: asyncAgg,
      aggregateId: "x",
      commands: [{ tag: "increment", by: 7 }],
    });
    expect(trace.steps[0].stateAfter.count).toBe(7);
  });
});
