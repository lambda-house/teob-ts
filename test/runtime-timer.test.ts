import { describe, it, expect } from "vitest";
import { EntityId } from "../src/core/types.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
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

describe("Timer entity through runtime", () => {
  it("scheduleOnce should deliver after delay", async () => {
    const { runtime } = createSingleRuntime(timerAggregate, timerEventCodec, timerStateCodec);
    const id = EntityId("timer-1");

    await runtime.ask<TimerCommand, TimerReply>(id, { tag: "ScheduleDelayed", delayMs: 50 }, timerCategory);
    await delay(100);

    const result = await runtime.ask<TimerCommand, TimerReply>(id, { tag: "GetCount" }, timerCategory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reply).toEqual({ tag: "Count", value: 1 });
    }

    await runtime.shutdown();
  });

  it("multiple scheduled timers should fire", async () => {
    const { runtime } = createSingleRuntime(timerAggregate, timerEventCodec, timerStateCodec);
    const id = EntityId("timer-2");

    // Schedule two delayed ticks
    await runtime.ask<TimerCommand, TimerReply>(id, { tag: "ScheduleDelayed", delayMs: 30 }, timerCategory);
    await delay(60);
    await runtime.ask<TimerCommand, TimerReply>(id, { tag: "ScheduleDelayed", delayMs: 30 }, timerCategory);
    await delay(60);

    const result = await runtime.ask<TimerCommand, TimerReply>(id, { tag: "GetCount" }, timerCategory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reply).toEqual({ tag: "Count", value: 2 });
    }

    await runtime.shutdown();
  });

  it("cancelTimer should prevent scheduled command", async () => {
    const { runtime } = createSingleRuntime(timerAggregate, timerEventCodec, timerStateCodec);
    const id = EntityId("timer-3");

    await runtime.ask<TimerCommand, TimerReply>(id, { tag: "ScheduleDelayed", delayMs: 100 }, timerCategory);
    await runtime.ask<TimerCommand, TimerReply>(id, { tag: "CancelScheduled" }, timerCategory);
    await delay(150);

    const result = await runtime.ask<TimerCommand, TimerReply>(id, { tag: "GetCount" }, timerCategory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reply).toEqual({ tag: "Count", value: 0 });
    }

    await runtime.shutdown();
  });
});
