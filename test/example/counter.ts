import { CategoryId, type EntityId } from "../../src/core/types.js";
import type { Aggregate } from "../../src/core/aggregate.js";
import type { Effect } from "../../src/core/effect.js";
import type { EffectControl } from "../../src/core/effect-control.js";
import { persist, reply, done, andReply } from "../../src/core/effect.js";
import { categoryTypes } from "../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";

// State

export interface CounterState {
  value: number;
}

// Commands (discriminated union)

export type CounterCommand =
  | { tag: "Increment"; amount: number }
  | { tag: "Decrement"; amount: number }
  | { tag: "GetValue" };

// Events

export type CounterEvent =
  | { tag: "Incremented"; amount: number }
  | { tag: "Decremented"; amount: number };

// Replies

export type CounterReply =
  | { tag: "Ok" }
  | { tag: "Value"; value: number };

// Category registration for cross-entity communication

export const counterCategory = categoryTypes<CounterCommand, CounterReply>(
  CategoryId("counter"),
);

// Aggregate definition — pure functions

export const counterAggregate: Aggregate<CounterCommand, CounterReply, CounterEvent, CounterState> =
  {
    category: CategoryId("counter"),

    initial(_id: EntityId): CounterState {
      return { value: 0 };
    },

    async decide(
      state: CounterState,
      command: CounterCommand,
      _ctx: EffectControl<CounterCommand, CounterReply>,
    ): Promise<Effect<CounterEvent, CounterReply>> {
      switch (command.tag) {
        case "Increment":
          return andReply(persist({ tag: "Incremented", amount: command.amount }), { tag: "Ok" });

        case "Decrement":
          return andReply(persist({ tag: "Decremented", amount: command.amount }), { tag: "Ok" });

        case "GetValue":
          return reply({ tag: "Value", value: state.value });
      }
    },

    apply(state: CounterState, event: CounterEvent): CounterState {
      switch (event.tag) {
        case "Incremented":
          return { value: state.value + event.amount };
        case "Decremented":
          return { value: state.value - event.amount };
      }
    },
  };

// Codecs

export const counterEventCodec = tagCodec<CounterEvent>("Incremented", "Decremented");
export const counterCommandCodec = tagCodec<CounterCommand>("Increment", "Decrement", "GetValue");
export const counterReplyCodec = tagCodec<CounterReply>("Ok", "Value");
export const counterStateCodec = objectCodec<CounterState>("CounterState");
