import { CategoryId, EntityId } from "../../src/core/types.js";
import type { Aggregate } from "../../src/core/aggregate.js";
import type { Effect } from "../../src/core/effect.js";
import type { EffectControl } from "../../src/core/effect-control.js";
import { persist, reply, andReply } from "../../src/core/effect.js";
import { categoryTypes } from "../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";

// ============ Wallet Entity ============

export interface WalletState {
  id: string;
  balance: number;
}

export type WalletCommand =
  | { tag: "Deposit"; amount: number }
  | { tag: "Withdraw"; amount: number }
  | { tag: "GetBalance" }
  | { tag: "TransferTo"; targetId: string; amount: number }
  | { tag: "ReceiveTransfer"; fromId: string; amount: number };

export type WalletEvent =
  | { tag: "Deposited"; amount: number }
  | { tag: "Withdrawn"; amount: number }
  | { tag: "TransferSent"; toId: string; amount: number }
  | { tag: "TransferReceived"; fromId: string; amount: number };

export type WalletReply =
  | { tag: "Balance"; amount: number }
  | { tag: "Ok" }
  | { tag: "InsufficientFunds" };

export const walletCategory = categoryTypes<WalletCommand, WalletReply>(CategoryId("wallet"));

export const walletAggregate: Aggregate<WalletCommand, WalletReply, WalletEvent, WalletState> = {
  category: CategoryId("wallet"),

  initial(id: EntityId): WalletState {
    return { id, balance: 0 };
  },

  async decide(
    state: WalletState,
    command: WalletCommand,
    ctx: EffectControl<WalletCommand, WalletReply>,
  ): Promise<Effect<WalletEvent, WalletReply>> {
    switch (command.tag) {
      case "Deposit":
        return andReply(persist({ tag: "Deposited", amount: command.amount }), {
          tag: "Balance",
          amount: state.balance + command.amount,
        });

      case "Withdraw":
        if (state.balance >= command.amount) {
          return andReply(persist({ tag: "Withdrawn", amount: command.amount }), {
            tag: "Balance",
            amount: state.balance - command.amount,
          });
        }
        return reply({ tag: "InsufficientFunds" });

      case "GetBalance":
        return reply({ tag: "Balance", amount: state.balance });

      case "TransferTo":
        if (state.balance >= command.amount) {
          await ctx.tell(
            EntityId(command.targetId),
            { tag: "ReceiveTransfer", fromId: state.id, amount: command.amount } as WalletCommand,
            walletCategory,
          );
          return andReply(
            persist({ tag: "TransferSent", toId: command.targetId, amount: command.amount }),
            { tag: "Ok" },
          );
        }
        return reply({ tag: "InsufficientFunds" });

      case "ReceiveTransfer":
        return andReply(
          persist({ tag: "TransferReceived", fromId: command.fromId, amount: command.amount }),
          { tag: "Ok" },
        );
    }
  },

  apply(state: WalletState, event: WalletEvent): WalletState {
    switch (event.tag) {
      case "Deposited":
        return { ...state, balance: state.balance + event.amount };
      case "Withdrawn":
        return { ...state, balance: state.balance - event.amount };
      case "TransferSent":
        return { ...state, balance: state.balance - event.amount };
      case "TransferReceived":
        return { ...state, balance: state.balance + event.amount };
    }
  },
};

export const walletEventCodec = tagCodec<WalletEvent>("Deposited", "Withdrawn", "TransferSent", "TransferReceived");
export const walletCommandCodec = tagCodec<WalletCommand>("Deposit", "Withdraw", "GetBalance", "TransferTo", "ReceiveTransfer");
export const walletReplyCodec = tagCodec<WalletReply>("Balance", "Ok", "InsufficientFunds");
export const walletStateCodec = objectCodec<WalletState>("WalletState");

// ============ Ledger Entity (asks wallet for balance) ============

export interface LedgerState {
  records: Record<string, number>;
}

export type LedgerCommand =
  | { tag: "RecordBalance"; walletId: string }
  | { tag: "GetRecords" };

export type LedgerEvent = { tag: "BalanceRecorded"; walletId: string; balance: number };

export type LedgerReply =
  | { tag: "Ok" }
  | { tag: "Records"; balances: Record<string, number> }
  | { tag: "Failed"; reason: string };

export const ledgerCategory = categoryTypes<LedgerCommand, LedgerReply>(CategoryId("ledger"));

export const ledgerAggregate: Aggregate<LedgerCommand, LedgerReply, LedgerEvent, LedgerState> = {
  category: CategoryId("ledger"),

  initial(_id: EntityId): LedgerState {
    return { records: {} };
  },

  async decide(
    state: LedgerState,
    command: LedgerCommand,
    ctx: EffectControl<LedgerCommand, LedgerReply>,
  ): Promise<Effect<LedgerEvent, LedgerReply>> {
    switch (command.tag) {
      case "RecordBalance": {
        const result = await ctx.ask<WalletCommand, WalletReply>(
          EntityId(command.walletId),
          { tag: "GetBalance" },
          walletCategory,
        );
        if (result.ok) {
          const walletReply = result.value as WalletReply | undefined;
          if (walletReply?.tag === "Balance") {
            return andReply(
              persist({
                tag: "BalanceRecorded",
                walletId: command.walletId,
                balance: walletReply.amount,
              }),
              { tag: "Ok" },
            );
          }
          return reply({ tag: "Failed", reason: "No reply from wallet" });
        }
        return reply({ tag: "Failed", reason: `CategoryNotFound` });
      }

      case "GetRecords":
        return reply({ tag: "Records", balances: state.records });
    }
  },

  apply(state: LedgerState, event: LedgerEvent): LedgerState {
    switch (event.tag) {
      case "BalanceRecorded":
        return { records: { ...state.records, [event.walletId]: event.balance } };
    }
  },
};

export const ledgerEventCodec = tagCodec<LedgerEvent>("BalanceRecorded");
export const ledgerCommandCodec = tagCodec<LedgerCommand>("RecordBalance", "GetRecords");
export const ledgerReplyCodec = tagCodec<LedgerReply>("Ok", "Records", "Failed");
export const ledgerStateCodec = objectCodec<LedgerState>("LedgerState");
