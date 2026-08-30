/**
 * Gift Card aggregate — showcases a stateful TEOB aggregate with invariants.
 *
 * Lifecycle: Empty → Active → (Cancelled | Empty)
 * Operations: Issue (set initial balance), Redeem (debit), Cancel (forfeit)
 */

import { CategoryId, type EntityId } from "../../../../src/core/types.js";
import type { Aggregate } from "../../../../src/core/aggregate.js";
import type { Effect } from "../../../../src/core/effect.js";
import type { EffectControl } from "../../../../src/core/effect-control.js";
import { persist, reply, andReply } from "../../../../src/core/effect.js";
import { categoryTypes } from "../../../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../../../src/core/codec.js";

export type CardStatus = "Active" | "Cancelled" | "Empty";

export interface GiftCardState {
  id: string;
  balance: number;
  status: CardStatus;
}

export type GiftCardCommand =
  | { tag: "Issue"; amount: number }
  | { tag: "Redeem"; amount: number }
  | { tag: "Cancel" }
  | { tag: "GetBalance" };

export type GiftCardEvent =
  | { tag: "Issued"; amount: number }
  | { tag: "Redeemed"; amount: number }
  | { tag: "Cancelled"; remainingBalance: number };

export type GiftCardReply =
  | { tag: "Ok" }
  | { tag: "Balance"; amount: number }
  | { tag: "Rejected"; reason: string };

export const giftCardCategory = categoryTypes<GiftCardCommand, GiftCardReply>(
  CategoryId("gift-card"),
);

export const giftCardAggregate: Aggregate<
  GiftCardCommand,
  GiftCardReply,
  GiftCardEvent,
  GiftCardState
> = {
  category: CategoryId("gift-card"),

  initial(id: EntityId): GiftCardState {
    return { id, balance: 0, status: "Empty" };
  },

  async decide(
    state: GiftCardState,
    command: GiftCardCommand,
    _ctx: EffectControl<GiftCardCommand, GiftCardReply>,
  ): Promise<Effect<GiftCardEvent, GiftCardReply>> {
    switch (command.tag) {
      case "Issue":
        if (state.status !== "Empty") {
          return reply({ tag: "Rejected", reason: "Card already issued" });
        }
        return andReply(persist({ tag: "Issued", amount: command.amount }), { tag: "Ok" });

      case "Redeem":
        if (state.status !== "Active") {
          return reply({ tag: "Rejected", reason: "Card is not active" });
        }
        if (command.amount > state.balance) {
          return reply({ tag: "Rejected", reason: "Insufficient balance" });
        }
        return andReply(persist({ tag: "Redeemed", amount: command.amount }), { tag: "Ok" });

      case "Cancel":
        if (state.status !== "Active") {
          return reply({ tag: "Rejected", reason: "Card is not active" });
        }
        return andReply(
          persist({ tag: "Cancelled", remainingBalance: state.balance }),
          { tag: "Ok" },
        );

      case "GetBalance":
        return reply({ tag: "Balance", amount: state.balance });
    }
  },

  apply(state: GiftCardState, event: GiftCardEvent): GiftCardState {
    switch (event.tag) {
      case "Issued":
        return { ...state, balance: event.amount, status: "Active" };
      case "Redeemed":
        return {
          ...state,
          balance: state.balance - event.amount,
          status: state.balance - event.amount === 0 ? "Empty" : "Active",
        };
      case "Cancelled":
        return { ...state, balance: 0, status: "Cancelled" };
    }
  },

  invariants: [
    { name: "balance is non-negative", check: (state) => state.balance >= 0 },
    {
      name: "cancelled card has zero balance",
      check: (state) => state.status !== "Cancelled" || state.balance === 0,
    },
  ],
};

export const giftCardEventCodec = tagCodec<GiftCardEvent>("Issued", "Redeemed", "Cancelled");
export const giftCardStateCodec = objectCodec<GiftCardState>("GiftCardState");
