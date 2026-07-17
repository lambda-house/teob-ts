/**
 * Batch counter — a test aggregate that emits multiple events per command.
 * Used to test ETag behavior when persist() is called with multiple events.
 */

import { CategoryId, type EntityId } from "../../src/core/types.js";
import type { Aggregate } from "../../src/core/aggregate.js";
import type { Effect } from "../../src/core/effect.js";
import type { EffectControl } from "../../src/core/effect-control.js";
import { persist, reply, done, andReply } from "../../src/core/effect.js";
import { categoryTypes } from "../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";

export interface BatchCounterState {
  value: number;
}

export type BatchCounterCommand =
  | { tag: "IncrementTwice"; amount: number } // emits 2 events
  | { tag: "IncrementThrice"; amount: number } // emits 3 events
  | { tag: "GetValue" }
  | { tag: "Noop" }; // returns Done (no reply)

export type BatchCounterEvent = { tag: "Incremented"; amount: number };

export type BatchCounterReply =
  | { tag: "Ok" }
  | { tag: "Value"; value: number };

export const batchCounterCategory = categoryTypes<BatchCounterCommand, BatchCounterReply>(
  CategoryId("batch-counter"),
);

export const batchCounterAggregate: Aggregate<
  BatchCounterCommand,
  BatchCounterReply,
  BatchCounterEvent,
  BatchCounterState
> = {
  category: CategoryId("batch-counter"),

  initial(_id: EntityId): BatchCounterState {
    return { value: 0 };
  },

  async decide(
    state: BatchCounterState,
    command: BatchCounterCommand,
    _ctx: EffectControl<BatchCounterCommand, BatchCounterReply>,
  ): Promise<Effect<BatchCounterEvent, BatchCounterReply>> {
    switch (command.tag) {
      case "IncrementTwice":
        return andReply(
          persist(
            { tag: "Incremented", amount: command.amount },
            { tag: "Incremented", amount: command.amount },
          ),
          { tag: "Ok" },
        );
      case "IncrementThrice":
        return andReply(
          persist(
            { tag: "Incremented", amount: command.amount },
            { tag: "Incremented", amount: command.amount },
            { tag: "Incremented", amount: command.amount },
          ),
          { tag: "Ok" },
        );
      case "GetValue":
        return reply({ tag: "Value", value: state.value });
      case "Noop":
        return done();
    }
  },

  apply(state: BatchCounterState, event: BatchCounterEvent): BatchCounterState {
    return { value: state.value + event.amount };
  },
};

export const batchCounterEventCodec = tagCodec<BatchCounterEvent>("Incremented");
export const batchCounterStateCodec = objectCodec<BatchCounterState>("BatchCounterState");
export const batchCounterCommandCodec = tagCodec<BatchCounterCommand>("IncrementTwice", "IncrementThrice", "GetValue", "Noop");
export const batchCounterReplyCodec = tagCodec<BatchCounterReply>("Ok", "Value");
