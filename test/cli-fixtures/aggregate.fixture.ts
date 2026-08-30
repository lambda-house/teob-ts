import { CategoryId, type EntityId } from "@lambda-house/teob-ts/core";
import type { Aggregate } from "@lambda-house/teob-ts/core";
import type { Effect } from "@lambda-house/teob-ts/core";
import type { EffectControl } from "@lambda-house/teob-ts/core";
import { persist, reply } from "@lambda-house/teob-ts/core";
import { categoryTypes } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";

// Commands
export type GiftCardCommand =
  | { tag: "Create" }; // TODO: add fields

// Events
export type GiftCardEvent =
  | { tag: "GiftCardCreated" }; // TODO: add fields

// State
export interface GiftCardState {
  created: boolean;
  // TODO: add state fields
}

// Reply
export type GiftCardReply =
  | { tag: "Ok" }
  | { tag: "Rejected"; reason: string };

// Category registration (for cross-entity communication)
export const giftCardCategory = categoryTypes<GiftCardCommand, GiftCardReply>(
  CategoryId("gift-card"),
);

// Aggregate
export const giftCardAggregate: Aggregate<
  GiftCardCommand,
  GiftCardReply,
  GiftCardEvent,
  GiftCardState
> = {
  category: CategoryId("gift-card"),

  initial(_id: EntityId): GiftCardState {
    return { created: false };
  },

  async decide(
    state: GiftCardState,
    command: GiftCardCommand,
    _ctx: EffectControl<GiftCardCommand, GiftCardReply>,
  ): Promise<Effect<GiftCardEvent, GiftCardReply>> {
    switch (command.tag) {
      case "Create":
        if (state.created) {
          return reply({ tag: "Rejected", reason: "Already created" });
        }
        return persist({ tag: "GiftCardCreated" });
    }
  },

  apply(state: GiftCardState, event: GiftCardEvent): GiftCardState {
    switch (event.tag) {
      case "GiftCardCreated":
        return { ...state, created: true };
    }
  },
};

// Codecs
export const giftCardEventCodec = tagCodec<GiftCardEvent>("GiftCardCreated");
export const giftCardStateCodec = objectCodec<GiftCardState>("GiftCardState");
export const giftCardCommandCodec = tagCodec<GiftCardCommand>("Create");
export const giftCardReplyCodec = tagCodec<GiftCardReply>("Ok", "Rejected");
