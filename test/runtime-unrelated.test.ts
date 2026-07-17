import { describe, it, expect } from "vitest";
import { CategoryId, EntityId } from "../src/core/types.js";
import { createInMemoryRuntime, registration, createSingleRuntime } from "../src/inmem/runtime.js";
import {
  counterAggregate,
  counterEventCodec,
  counterStateCodec,
  counterCategory,
  type CounterCommand,
  type CounterReply,
} from "./example/counter.js";
import {
  timerAggregate,
  timerEventCodec,
  timerStateCodec,
  timerCategory,
  type TimerCommand,
  type TimerReply,
} from "./fixtures/timer.js";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("InMemoryRuntime with unrelated types", () => {
  it("should run Counter and Timer aggregates in a single runtime", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(timerAggregate, timerEventCodec, timerStateCodec),
    ]);

    const counterId = EntityId("counter-1");
    const timerId = EntityId("timer-1");

    // Counter operations
    await runtime.ask<CounterCommand, CounterReply>(counterId, { tag: "Increment", amount: 1 }, counterCategory);
    const counterResult = await runtime.ask<CounterCommand, CounterReply>(
      counterId,
      { tag: "GetValue" },
      counterCategory,
    );

    // Timer operations on same runtime
    await runtime.ask<TimerCommand, TimerReply>(timerId, { tag: "ScheduleDelayed", delayMs: 50 }, timerCategory);
    await delay(100);
    const timerResult = await runtime.ask<TimerCommand, TimerReply>(timerId, { tag: "GetCount" }, timerCategory);

    expect(counterResult.ok).toBe(true);
    if (counterResult.ok) expect(counterResult.value.reply).toEqual({ tag: "Value", value: 1 });

    expect(timerResult.ok).toBe(true);
    if (timerResult.ok) expect(timerResult.value.reply).toEqual({ tag: "Count", value: 1 });

    await runtime.shutdown();
  });

  it("should handle interleaved operations on both types", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(timerAggregate, timerEventCodec, timerStateCodec),
    ]);

    const counterId = EntityId("counter-cross");
    const timerId = EntityId("timer-cross");

    await runtime.ask<CounterCommand, CounterReply>(counterId, { tag: "Increment", amount: 1 }, counterCategory);
    await runtime.ask<TimerCommand, TimerReply>(timerId, { tag: "ScheduleDelayed", delayMs: 50 }, timerCategory);
    await runtime.ask<CounterCommand, CounterReply>(counterId, { tag: "Increment", amount: 1 }, counterCategory);
    await delay(100);

    const counterCount = await runtime.ask<CounterCommand, CounterReply>(
      counterId,
      { tag: "GetValue" },
      counterCategory,
    );
    const timerCount = await runtime.ask<TimerCommand, TimerReply>(timerId, { tag: "GetCount" }, timerCategory);

    expect(counterCount.ok).toBe(true);
    if (counterCount.ok) expect(counterCount.value.reply).toEqual({ tag: "Value", value: 2 });

    expect(timerCount.ok).toBe(true);
    if (timerCount.ok) expect(timerCount.value.reply).toEqual({ tag: "Count", value: 1 });

    await runtime.shutdown();
  });

  it("should report categories from all registered aggregates", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(timerAggregate, timerEventCodec, timerStateCodec),
    ]);

    const cats = runtime.categories();
    expect(cats.has(CategoryId("counter"))).toBe(true);
    expect(cats.has(CategoryId("timer-entity"))).toBe(true);

    await runtime.shutdown();
  });

  it("should reject commands for unregistered categories", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);

    const result = await runtime.ask<TimerCommand, TimerReply>(
      EntityId("ghost-timer"),
      { tag: "GetCount" },
      timerCategory,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("CategoryNotFound");
    }

    await runtime.shutdown();
  });
});
