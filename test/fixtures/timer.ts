import { CategoryId, EntityId, TimerId } from "../../src/core/types.js";
import type { Aggregate } from "../../src/core/aggregate.js";
import type { Effect } from "../../src/core/effect.js";
import type { EffectControl } from "../../src/core/effect-control.js";
import { persist, reply, andReply } from "../../src/core/effect.js";
import { categoryTypes } from "../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";

export interface TimerState {
  tickCount: number;
}

export type TimerCommand =
  | { tag: "Start" }
  | { tag: "Tick" }
  | { tag: "GetCount" }
  | { tag: "ScheduleDelayed"; delayMs: number }
  | { tag: "CancelScheduled" };

export type TimerEvent = { tag: "Started" } | { tag: "Ticked" };

export type TimerReply = { tag: "Ok" } | { tag: "Count"; value: number };

export const timerCategory = categoryTypes<TimerCommand, TimerReply>(CategoryId("timer-entity"));

const DelayedTickTimerId = TimerId("delayed-tick");

export const timerAggregate: Aggregate<TimerCommand, TimerReply, TimerEvent, TimerState> = {
  category: CategoryId("timer-entity"),

  initial(_id: EntityId): TimerState {
    return { tickCount: 0 };
  },

  async decide(
    state: TimerState,
    command: TimerCommand,
    ctx: EffectControl<TimerCommand, TimerReply>,
  ): Promise<Effect<TimerEvent, TimerReply>> {
    switch (command.tag) {
      case "Start":
        return andReply(persist({ tag: "Started" }), { tag: "Ok" });

      case "Tick":
        return andReply(persist({ tag: "Ticked" }), {
          tag: "Count",
          value: state.tickCount + 1,
        });

      case "GetCount":
        return reply({ tag: "Count", value: state.tickCount });

      case "ScheduleDelayed":
        await ctx.scheduleOnce(DelayedTickTimerId, { tag: "Tick" }, command.delayMs);
        return reply({ tag: "Ok" });

      case "CancelScheduled":
        await ctx.cancelTimer(DelayedTickTimerId);
        return reply({ tag: "Ok" });
    }
  },

  apply(state: TimerState, event: TimerEvent): TimerState {
    switch (event.tag) {
      case "Started":
        return state;
      case "Ticked":
        return { tickCount: state.tickCount + 1 };
    }
  },
};

export const timerEventCodec = tagCodec<TimerEvent>("Started", "Ticked");
export const timerCommandCodec = tagCodec<TimerCommand>("Start", "Tick", "GetCount", "ScheduleDelayed", "CancelScheduled");
export const timerReplyCodec = tagCodec<TimerReply>("Ok", "Count");
export const timerStateCodec = objectCodec<TimerState>("TimerState");
