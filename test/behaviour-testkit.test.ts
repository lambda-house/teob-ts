import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, TimerId } from "../src/core/types.js";
import type { Aggregate } from "../src/core/aggregate.js";
import type { Effect } from "../src/core/effect.js";
import type { EffectControl } from "../src/core/effect-control.js";
import { persist, reply, stop, stash, andReply, andStop, andSnapshot, andUnstash, extractEvents, hasReply } from "../src/core/effect.js";

// Simple counter domain for testing the test kit pattern

interface CounterState {
  id: string;
  count: number;
}

type CounterCommand =
  | { tag: "Increment" }
  | { tag: "Decrement" }
  | { tag: "GetCount" }
  | { tag: "Reset" }
  | { tag: "ScheduleIncrement"; delayMs: number }
  | { tag: "StopEntity" };

type CounterEvent = { tag: "Incremented" } | { tag: "Decremented" } | { tag: "WasReset" };

type CounterReply = { tag: "Count"; value: number } | { tag: "Stopped" };

// Aggregate
const counterAggregate: Aggregate<CounterCommand, CounterReply, CounterEvent, CounterState> = {
  category: CategoryId("counter"),

  initial(id: EntityId): CounterState {
    return { id, count: 0 };
  },

  async decide(
    state: CounterState,
    command: CounterCommand,
    ctx: EffectControl<CounterCommand, CounterReply>,
  ): Promise<Effect<CounterEvent, CounterReply>> {
    switch (command.tag) {
      case "Increment":
        return andReply(persist({ tag: "Incremented" }), { tag: "Count", value: state.count + 1 });
      case "Decrement":
        return andReply(persist({ tag: "Decremented" }), { tag: "Count", value: state.count - 1 });
      case "GetCount":
        return reply({ tag: "Count", value: state.count });
      case "Reset":
        return andReply(persist({ tag: "WasReset" }), { tag: "Count", value: 0 });
      case "ScheduleIncrement":
        await ctx.scheduleOnce(TimerId("auto-inc"), { tag: "Increment" }, command.delayMs);
        return reply({ tag: "Count", value: state.count });
      case "StopEntity":
        return andStop(persist({ tag: "WasReset" }));
    }
  },

  apply(state: CounterState, event: CounterEvent): CounterState {
    switch (event.tag) {
      case "Incremented":
        return { ...state, count: state.count + 1 };
      case "Decremented":
        return { ...state, count: state.count - 1 };
      case "WasReset":
        return { ...state, count: 0 };
    }
  },

  async onRecoveryComplete(state: CounterState, ctx: EffectControl<CounterCommand, CounterReply>) {
    ctx.log("info", `Recovered with count=${state.count}`);
  },
};

// AggregateTestKit — synchronous test harness

interface CommandResult<Event, Reply> {
  events: Event[];
  reply: Reply | undefined;
  shouldStop: boolean;
  shouldStash: boolean;
  shouldSnapshot: boolean;
  shouldUnstash: boolean;
}

interface ControlRecord<Command> {
  scheduledTimers: Array<{ timerId: string; command: Command; delayMs: number }>;
  cancelledTimers: string[];
  logMessages: Array<{ level: string; message: string }>;
}

function commandResultFromEffect<Event, Reply>(effect: Effect<Event, Reply>): CommandResult<Event, Reply> {
  const result: CommandResult<Event, Reply> = {
    events: [],
    reply: undefined,
    shouldStop: false,
    shouldStash: false,
    shouldSnapshot: false,
    shouldUnstash: false,
  };

  function walk(e: Effect<Event, Reply>) {
    switch (e.tag) {
      case "Persist":
        result.events.push(...e.events);
        walk(e.andThen);
        break;
      case "Run":
        walk(e.andThen);
        break;
      case "Reply":
        result.reply = e.value;
        break;
      case "Snapshot":
        result.shouldSnapshot = true;
        walk(e.andThen);
        break;
      case "Stop":
        result.shouldStop = true;
        break;
      case "Stash":
        result.shouldStash = true;
        break;
      case "Unstash":
        result.shouldUnstash = true;
        walk(e.andThen);
        break;
      case "Done":
        break;
    }
  }

  walk(effect);
  return result;
}

function createMockControl<Command, Reply>(
  entityId: EntityId,
  categoryId: CategoryId,
): { ctx: EffectControl<Command, Reply>; record: ControlRecord<Command> } {
  const record: ControlRecord<Command> = {
    scheduledTimers: [],
    cancelledTimers: [],
    logMessages: [],
  };

  const ctx: EffectControl<Command, Reply> = {
    entityId,
    categoryId,
    async tellSelf(_command: Command) {},
    async tell() {},
    async ask() {
      return { ok: true, value: undefined };
    },
    async scheduleOnce(timerId, command, delayMs) {
      record.scheduledTimers.push({ timerId, command, delayMs });
    },
    async schedulePeriodic() {},
    async cancelTimer(timerId) {
      record.cancelledTimers.push(timerId);
    },
    log(level, message) {
      record.logMessages.push({ level, message });
    },
    async sync() {},
  };

  return { ctx, record };
}

// Test kit helper

const entityId = EntityId("test-entity");

async function runCommand(
  state: CounterState,
  command: CounterCommand,
): Promise<{ result: CommandResult<CounterEvent, CounterReply>; record: ControlRecord<CounterCommand> }> {
  const { ctx, record } = createMockControl<CounterCommand, CounterReply>(entityId, counterAggregate.category);
  const effect = await counterAggregate.decide(state, command, ctx);
  return { result: commandResultFromEffect(effect), record };
}

function applyEvents(state: CounterState, events: CounterEvent[]): CounterState {
  return events.reduce((s, e) => counterAggregate.apply(s, e), state);
}

async function runAndApply(
  state: CounterState,
  command: CounterCommand,
): Promise<{
  newState: CounterState;
  result: CommandResult<CounterEvent, CounterReply>;
  record: ControlRecord<CounterCommand>;
}> {
  const { result, record } = await runCommand(state, command);
  const newState = applyEvents(state, result.events);
  return { newState, result, record };
}

// Tests

describe("AggregateTestKit", () => {
  describe("initial state", () => {
    it("should create correct initial state", () => {
      const state = counterAggregate.initial(entityId);
      expect(state.count).toBe(0);
      expect(state.id).toBe(entityId);
    });
  });

  describe("command handling", () => {
    it("should handle increment command", async () => {
      const state = counterAggregate.initial(entityId);
      const { result } = await runCommand(state, { tag: "Increment" });

      expect(result.events).toEqual([{ tag: "Incremented" }]);
      expect(result.reply).toEqual({ tag: "Count", value: 1 });
      expect(result.shouldStop).toBe(false);
      expect(result.shouldStash).toBe(false);
    });

    it("should handle decrement command", async () => {
      const state = { id: entityId as string, count: 5 };
      const { result } = await runCommand(state, { tag: "Decrement" });

      expect(result.events).toEqual([{ tag: "Decremented" }]);
      expect(result.reply).toEqual({ tag: "Count", value: 4 });
    });

    it("should handle get count (read-only)", async () => {
      const state = { id: entityId as string, count: 42 };
      const { result } = await runCommand(state, { tag: "GetCount" });

      expect(result.events).toEqual([]);
      expect(result.reply).toEqual({ tag: "Count", value: 42 });
    });

    it("should handle reset command", async () => {
      const state = { id: entityId as string, count: 100 };
      const { result } = await runCommand(state, { tag: "Reset" });

      expect(result.events).toEqual([{ tag: "WasReset" }]);
      expect(result.reply).toEqual({ tag: "Count", value: 0 });
    });

    it("should handle stop command", async () => {
      const state = counterAggregate.initial(entityId);
      const { result } = await runCommand(state, { tag: "StopEntity" });

      expect(result.events).toEqual([{ tag: "WasReset" }]);
      expect(result.shouldStop).toBe(true);
    });
  });

  describe("state transitions", () => {
    it("applyEvent should apply single event", () => {
      const state = { id: entityId as string, count: 0 };
      const newState = counterAggregate.apply(state, { tag: "Incremented" });
      expect(newState.count).toBe(1);
    });

    it("applyEvents should apply multiple events", () => {
      const state = { id: entityId as string, count: 0 };
      const events: CounterEvent[] = [
        { tag: "Incremented" },
        { tag: "Incremented" },
        { tag: "Decremented" },
        { tag: "Incremented" },
      ];
      const newState = applyEvents(state, events);
      expect(newState.count).toBe(2);
    });

    it("runAndApply should run command and apply events", async () => {
      const state = counterAggregate.initial(entityId);
      const { newState, result } = await runAndApply(state, { tag: "Increment" });

      expect(newState.count).toBe(1);
      expect(result.events).toEqual([{ tag: "Incremented" }]);
      expect(result.reply).toEqual({ tag: "Count", value: 1 });
    });
  });

  describe("control interactions", () => {
    it("should record timer scheduling", async () => {
      const state = counterAggregate.initial(entityId);
      const { record } = await runCommand(state, { tag: "ScheduleIncrement", delayMs: 5000 });

      expect(record.scheduledTimers).toHaveLength(1);
      expect(record.scheduledTimers[0].timerId).toBe("auto-inc");
      expect(record.scheduledTimers[0].command).toEqual({ tag: "Increment" });
      expect(record.scheduledTimers[0].delayMs).toBe(5000);
    });

    it("should record log messages on recovery", async () => {
      const state = { id: entityId as string, count: 42 };
      const { ctx, record } = createMockControl<CounterCommand, CounterReply>(
        entityId,
        counterAggregate.category,
      );
      await counterAggregate.onRecoveryComplete!(state, ctx);

      expect(record.logMessages).toHaveLength(1);
      expect(record.logMessages[0].level).toBe("info");
      expect(record.logMessages[0].message).toContain("count=42");
    });
  });

  describe("multi-step scenarios", () => {
    it("should track state through multiple commands", async () => {
      let state = counterAggregate.initial(entityId);

      for (let i = 0; i < 3; i++) {
        const { newState, result } = await runAndApply(state, { tag: "Increment" });
        state = newState;
        expect(result.events).toHaveLength(1);
      }
      expect(state.count).toBe(3);

      const { newState: finalState, result } = await runAndApply(state, { tag: "Decrement" });
      expect(finalState.count).toBe(2);
      expect(result.reply).toEqual({ tag: "Count", value: 2 });
    });

    it("should handle reset correctly in sequence", async () => {
      let state = counterAggregate.initial(entityId);

      for (let i = 0; i < 5; i++) {
        const { newState } = await runAndApply(state, { tag: "Increment" });
        state = newState;
      }
      expect(state.count).toBe(5);

      const { newState: resetState, result } = await runAndApply(state, { tag: "Reset" });
      expect(resetState.count).toBe(0);
      expect(result.reply).toEqual({ tag: "Count", value: 0 });
    });
  });
});

describe("commandResultFromEffect", () => {
  it("should extract events from Persist", () => {
    const effect = persist<CounterEvent, CounterReply>({ tag: "Incremented" });
    const result = commandResultFromEffect(effect);
    expect(result.events).toEqual([{ tag: "Incremented" }]);
  });

  it("should extract reply", () => {
    const effect = reply<CounterEvent, CounterReply>({ tag: "Count", value: 5 });
    const result = commandResultFromEffect(effect);
    expect(result.reply).toEqual({ tag: "Count", value: 5 });
  });

  it("should handle chained effects", () => {
    const effect = andReply(persist<CounterEvent, CounterReply>({ tag: "Incremented" }), {
      tag: "Count",
      value: 1,
    });
    const result = commandResultFromEffect(effect);
    expect(result.events).toEqual([{ tag: "Incremented" }]);
    expect(result.reply).toEqual({ tag: "Count", value: 1 });
  });

  it("should detect stop", () => {
    const effect = stop<CounterEvent, CounterReply>();
    const result = commandResultFromEffect(effect);
    expect(result.shouldStop).toBe(true);
  });

  it("should detect stash", () => {
    const effect = stash<CounterEvent, CounterReply>();
    const result = commandResultFromEffect(effect);
    expect(result.shouldStash).toBe(true);
  });

  it("should detect snapshot", () => {
    const effect = andSnapshot(persist<CounterEvent, CounterReply>({ tag: "Incremented" }));
    const result = commandResultFromEffect(effect);
    expect(result.shouldSnapshot).toBe(true);
    expect(result.events).toEqual([{ tag: "Incremented" }]);
  });

  it("should detect unstash", () => {
    const effect = andUnstash(persist<CounterEvent, CounterReply>({ tag: "Incremented" }));
    const result = commandResultFromEffect(effect);
    expect(result.shouldUnstash).toBe(true);
  });
});
