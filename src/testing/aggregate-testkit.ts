/**
 * AggregateTestKit — synchronous test harness for aggregates.
 *
 * Provides mock EffectControl, effect decomposition, and runAndApply
 * for testing aggregates without a running EntityRuntime.
 */

import type { EntityId, CategoryId } from "../core/types.js";
import type { Aggregate } from "../core/aggregate.js";
import type { Effect } from "../core/effect.js";
import type { EffectControl, LogLevel } from "../core/effect-control.js";
import type { DeferredReply } from "../core/deferred.js";
import { createDeferredReply } from "../core/deferred.js";

/** Decomposed result of a decision. */
export interface CommandResult<Event, Reply> {
  events: Event[];
  reply: Reply | undefined;
  deferredReply: DeferredReply<Reply> | undefined;
  sideEffects: Array<() => Promise<void>>;
  shouldStop: boolean;
  shouldStash: boolean;
  shouldSnapshot: boolean;
  shouldUnstash: boolean;
}

/** Recorded interactions with EffectControl. */
export interface ControlRecord<Command> {
  scheduledTimers: Array<{ timerId: string; command: Command; delayMs: number }>;
  cancelledTimers: string[];
  logMessages: Array<{ level: LogLevel; message: string }>;
  selfCommands: Command[];
  sentMessages: Array<{ entityId: EntityId; command: unknown }>;
}

/** Extract structured result from an Effect chain. */
export function commandResultFromEffect<Event, Reply>(effect: Effect<Event, Reply>): CommandResult<Event, Reply> {
  const result: CommandResult<Event, Reply> = {
    events: [],
    reply: undefined,
    deferredReply: undefined,
    sideEffects: [],
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
        result.sideEffects.push(e.sideEffect);
        walk(e.andThen);
        break;
      case "Reply":
        result.reply = e.value;
        break;
      case "ReplyDeferred":
        result.deferredReply = e.deferred;
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

/** Create a mock EffectControl that records all interactions. */
export function createMockControl<Command, Reply>(
  entityId: EntityId,
  categoryId: CategoryId,
): { ctx: EffectControl<Command, Reply>; record: ControlRecord<Command> } {
  const record: ControlRecord<Command> = {
    scheduledTimers: [],
    cancelledTimers: [],
    logMessages: [],
    selfCommands: [],
    sentMessages: [],
  };

  const ctx: EffectControl<Command, Reply> = {
    entityId,
    categoryId,
    async tellSelf(command: Command) {
      record.selfCommands.push(command);
    },
    async tell(id, command) {
      record.sentMessages.push({ entityId: id, command });
    },
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

/** Test kit for a specific aggregate. */
export interface AggregateTestKit<Command, Reply, Event, State> {
  /** The initial state for the default test entity. */
  initialState: State;

  /** Run a decision and return the decomposed result + control record. */
  run(
    state: State,
    command: Command,
  ): Promise<{ result: CommandResult<Event, Reply>; record: ControlRecord<Command> }>;

  /** Run a decision, apply the resulting events, and return the new state. */
  runAndApply(
    state: State,
    command: Command,
  ): Promise<{
    newState: State;
    result: CommandResult<Event, Reply>;
    record: ControlRecord<Command>;
  }>;
}

/** Create a test kit for an aggregate. */
export function createAggregateTestKit<Command, Reply, Event, State>(
  aggregate: Aggregate<Command, Reply, Event, State>,
  entityId: EntityId = "test-entity" as EntityId,
): AggregateTestKit<Command, Reply, Event, State> {
  const initialState = aggregate.initial(entityId);

  return {
    initialState,

    async run(state, command) {
      const { ctx, record } = createMockControl<Command, Reply>(entityId, aggregate.category);
      const effect = await aggregate.decide(state, command, ctx);
      return { result: commandResultFromEffect(effect), record };
    },

    async runAndApply(state, command) {
      const { ctx, record } = createMockControl<Command, Reply>(entityId, aggregate.category);
      const effect = await aggregate.decide(state, command, ctx);
      const result = commandResultFromEffect(effect);
      const newState = result.events.reduce((s, e) => aggregate.apply(s, e), state);
      return { newState, result, record };
    },
  };
}
