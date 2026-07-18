import { describe, it, expect } from "vitest";
import { EntityId, CategoryId, SequenceNr } from "../src/core/types.js";
import {
  counterAggregate,
  counterEventCodec,
  counterStateCodec,
  counterCategory,
  type CounterCommand,
  type CounterReply,
} from "./example/counter.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";

describe("Counter Aggregate", () => {
  it("applies increment event", () => {
    const state = counterAggregate.initial(EntityId("test"));
    const next = counterAggregate.apply(state, { tag: "Incremented", amount: 5 });
    expect(next.value).toBe(5);
  });

  it("applies decrement event", () => {
    const state = { value: 10 };
    const next = counterAggregate.apply(state, { tag: "Decremented", amount: 3 });
    expect(next.value).toBe(7);
  });
});

describe("In-Memory Runtime", () => {
  it("processes increment and reads value", async () => {
    const { runtime } = createSingleRuntime(
      counterAggregate,
      counterEventCodec,
      counterStateCodec,
    );

    const id = EntityId("c1");

    const r1 = await runtime.ask<CounterCommand, CounterReply>(
      id,
      { tag: "Increment", amount: 5 },
      counterCategory,
    );
    expect(r1.ok).toBe(true);

    await runtime.ask<CounterCommand, CounterReply>(
      id,
      { tag: "Increment", amount: 3 },
      counterCategory,
    );

    const r3 = await runtime.ask<CounterCommand, CounterReply>(
      id,
      { tag: "GetValue" },
      counterCategory,
    );
    expect(r3.ok).toBe(true);
    if (r3.ok) {
      const reply = r3.value.reply as CounterReply;
      expect(reply).toEqual({ tag: "Value", value: 8 });
    }

    await runtime.shutdown();
  });

  it("persists events in journal", async () => {
    const { runtime, journal } = createSingleRuntime(
      counterAggregate,
      counterEventCodec,
      counterStateCodec,
    );

    const id = EntityId("c2");

    await runtime.ask(id, { tag: "Increment", amount: 1 } as CounterCommand, counterCategory);
    await runtime.ask(id, { tag: "Decrement", amount: 2 } as CounterCommand, counterCategory);

    const events = journal.loadEvents(
      CategoryId("counter"),
      id,
      SequenceNr(0),
      counterEventCodec,
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toEqual({ tag: "Incremented", amount: 1 });
    expect(events[1].event).toEqual({ tag: "Decremented", amount: 2 });

    await runtime.shutdown();
  });

  it("handles multiple entities independently", async () => {
    const { runtime } = createSingleRuntime(
      counterAggregate,
      counterEventCodec,
      counterStateCodec,
    );

    const a = EntityId("a");
    const b = EntityId("b");

    await runtime.ask(a, { tag: "Increment", amount: 10 } as CounterCommand, counterCategory);
    await runtime.ask(b, { tag: "Increment", amount: 20 } as CounterCommand, counterCategory);

    const ra = await runtime.ask<CounterCommand, CounterReply>(
      a,
      { tag: "GetValue" },
      counterCategory,
    );
    const rb = await runtime.ask<CounterCommand, CounterReply>(
      b,
      { tag: "GetValue" },
      counterCategory,
    );

    expect(ra.ok && ra.value.reply).toEqual({ tag: "Value", value: 10 });
    expect(rb.ok && rb.value.reply).toEqual({ tag: "Value", value: 20 });

    await runtime.shutdown();
  });

  it("returns CategoryNotFound for unknown category", async () => {
    const { runtime } = createSingleRuntime(
      counterAggregate,
      counterEventCodec,
      counterStateCodec,
    );

    const result = await runtime.ask(
      EntityId("x"),
      { tag: "Something" },
      { categoryId: CategoryId("nonexistent") },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("CategoryNotFound");
    }

    await runtime.shutdown();
  });
});

describe("Journal", () => {
  it("snapshot and recovery", async () => {
    const { runtime: r1, journal } = createSingleRuntime(
      counterAggregate,
      counterEventCodec,
      counterStateCodec,
    );

    const id = EntityId("snap1");
    await r1.ask(id, { tag: "Increment", amount: 42 } as CounterCommand, counterCategory);

    journal.persistSnapshot(
      CategoryId("counter"),
      id,
      { value: 42 },
      SequenceNr(1),
      counterStateCodec,
    );

    await r1.shutdown();

    const snap = journal.loadSnapshot(CategoryId("counter"), id, counterStateCodec);
    expect(snap).toBeDefined();
    expect(snap!.state.value).toBe(42);
  });
});
