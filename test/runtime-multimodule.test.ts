import { describe, it, expect } from "vitest";
import { EntityId } from "../src/core/types.js";
import { createInMemoryRuntime, createSingleRuntime, registration } from "../src/inmem/runtime.js";
import {
  walletAggregate,
  walletEventCodec,
  walletStateCodec,
  walletCategory,
  ledgerAggregate,
  ledgerEventCodec,
  ledgerStateCodec,
  ledgerCategory,
  type WalletCommand,
  type WalletReply,
  type LedgerCommand,
  type LedgerReply,
} from "./fixtures/wallet-ledger.js";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Multi-module communication", () => {
  it("tell should send command to another entity", async () => {
    const { runtime } = createSingleRuntime(walletAggregate, walletEventCodec, walletStateCodec);

    const walletA = EntityId("wallet-a");
    const walletB = EntityId("wallet-b");

    // Deposit into wallet A
    await runtime.ask<WalletCommand, WalletReply>(walletA, { tag: "Deposit", amount: 100 }, walletCategory);

    // Transfer from A to B using tell
    await runtime.ask<WalletCommand, WalletReply>(
      walletA,
      { tag: "TransferTo", targetId: "wallet-b", amount: 30 },
      walletCategory,
    );

    // Give time for the tell to be processed
    await delay(100);

    // Check balances
    const balanceA = await runtime.ask<WalletCommand, WalletReply>(walletA, { tag: "GetBalance" }, walletCategory);
    const balanceB = await runtime.ask<WalletCommand, WalletReply>(walletB, { tag: "GetBalance" }, walletCategory);

    expect(balanceA.ok).toBe(true);
    if (balanceA.ok) expect(balanceA.value.reply).toEqual({ tag: "Balance", amount: 70 });

    expect(balanceB.ok).toBe(true);
    if (balanceB.ok) expect(balanceB.value.reply).toEqual({ tag: "Balance", amount: 30 });

    await runtime.shutdown();
  });

  it("ask should query another entity and get response", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(walletAggregate, walletEventCodec, walletStateCodec),
      registration(ledgerAggregate, ledgerEventCodec, ledgerStateCodec),
    ]);

    const walletId = EntityId("test-wallet");
    const ledgerId = EntityId("test-ledger");

    // Deposit into wallet
    await runtime.ask<WalletCommand, WalletReply>(walletId, { tag: "Deposit", amount: 500 }, walletCategory);

    // Ledger queries wallet balance via ask
    const result = await runtime.ask<LedgerCommand, LedgerReply>(
      ledgerId,
      { tag: "RecordBalance", walletId: "test-wallet" },
      ledgerCategory,
    );

    // Check ledger recorded the balance
    const records = await runtime.ask<LedgerCommand, LedgerReply>(ledgerId, { tag: "GetRecords" }, ledgerCategory);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toEqual({ tag: "Ok" });

    expect(records.ok).toBe(true);
    if (records.ok) expect(records.value.reply).toEqual({ tag: "Records", balances: { "test-wallet": 500 } });

    await runtime.shutdown();
  });

  it("ask to unknown category should return error", async () => {
    const { runtime } = createSingleRuntime(ledgerAggregate, ledgerEventCodec, ledgerStateCodec);

    const ledgerId = EntityId("test-ledger");

    // Try to query non-existent wallet module
    const result = await runtime.ask<LedgerCommand, LedgerReply>(
      ledgerId,
      { tag: "RecordBalance", walletId: "ghost-wallet" },
      ledgerCategory,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const reply = result.value.reply as LedgerReply;
      expect(reply.tag).toBe("Failed");
      if (reply.tag === "Failed") {
        expect(reply.reason).toContain("CategoryNotFound");
      }
    }

    await runtime.shutdown();
  });

  it("multiple transfers between entities", async () => {
    const { runtime } = createSingleRuntime(walletAggregate, walletEventCodec, walletStateCodec);

    const alice = EntityId("alice");
    const bob = EntityId("bob");
    const charlie = EntityId("charlie");

    // Initial deposits
    await runtime.ask<WalletCommand, WalletReply>(alice, { tag: "Deposit", amount: 100 }, walletCategory);
    await runtime.ask<WalletCommand, WalletReply>(bob, { tag: "Deposit", amount: 50 }, walletCategory);

    // Chain of transfers: Alice -> Bob -> Charlie
    await runtime.ask<WalletCommand, WalletReply>(
      alice,
      { tag: "TransferTo", targetId: "bob", amount: 40 },
      walletCategory,
    );
    await delay(50);
    await runtime.ask<WalletCommand, WalletReply>(
      bob,
      { tag: "TransferTo", targetId: "charlie", amount: 60 },
      walletCategory,
    );
    await delay(50);

    // Check final balances
    const aliceBalance = await runtime.ask<WalletCommand, WalletReply>(
      alice,
      { tag: "GetBalance" },
      walletCategory,
    );
    const bobBalance = await runtime.ask<WalletCommand, WalletReply>(bob, { tag: "GetBalance" }, walletCategory);
    const charlieBalance = await runtime.ask<WalletCommand, WalletReply>(
      charlie,
      { tag: "GetBalance" },
      walletCategory,
    );

    expect(aliceBalance.ok).toBe(true);
    if (aliceBalance.ok) expect(aliceBalance.value.reply).toEqual({ tag: "Balance", amount: 60 }); // 100 - 40

    expect(bobBalance.ok).toBe(true);
    if (bobBalance.ok) expect(bobBalance.value.reply).toEqual({ tag: "Balance", amount: 30 }); // 50 + 40 - 60

    expect(charlieBalance.ok).toBe(true);
    if (charlieBalance.ok) expect(charlieBalance.value.reply).toEqual({ tag: "Balance", amount: 60 }); // 0 + 60

    await runtime.shutdown();
  });
});
