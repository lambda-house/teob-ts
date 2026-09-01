import { describe, it, expect } from "vitest";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { describeAggregate } from "../src/core/describe.js";
import {
  counterAggregate,
  counterEventCodec,
  counterCommandCodec,
  counterReplyCodec,
  counterStateCodec,
} from "./example/counter.js";
import {
  walletAggregate,
  walletEventCodec,
  walletCommandCodec,
  walletReplyCodec,
  walletStateCodec,
} from "./fixtures/wallet-ledger.js";

describe("codec manifests", () => {
  it("tagCodec with tags exposes manifests", () => {
    type E = { tag: "A" } | { tag: "B" };
    const codec = tagCodec<E>("A", "B");
    expect(codec.manifests).toEqual(["A", "B"]);
  });

  it("tagCodec without tags has no manifests", () => {
    type E = { tag: "A" };
    const codec = tagCodec<E>();
    expect(codec.manifests).toBeUndefined();
  });

  it("objectCodec always exposes manifests", () => {
    const codec = objectCodec<{ x: number }>("MyState");
    expect(codec.manifests).toEqual(["MyState"]);
  });
});

describe("describeAggregate", () => {
  it("describes counter with all codecs", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    expect(desc).toEqual({
      category: "counter",
      events: ["Incremented", "Decremented"],
      state: ["CounterState"],
      commands: ["Increment", "Decrement", "GetValue"],
      replies: ["Ok", "Value"],
      snapshotEvery: 100,
    });
  });

  it("describes wallet with all codecs", () => {
    const desc = describeAggregate({
      aggregate: walletAggregate,
      eventCodec: walletEventCodec,
      stateCodec: walletStateCodec,
      commandCodec: walletCommandCodec,
      replyCodec: walletReplyCodec,
    });

    expect(desc.category).toBe("wallet");
    expect(desc.events).toEqual(["Deposited", "Withdrawn", "TransferSent", "TransferReceived"]);
    expect(desc.commands).toEqual(["Deposit", "Withdraw", "GetBalance", "TransferTo", "ReceiveTransfer"]);
    expect(desc.replies).toEqual(["Balance", "Ok", "InsufficientFunds"]);
  });

  it("works without optional codecs", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
    });

    expect(desc.category).toBe("counter");
    expect(desc.events).toEqual(["Incremented", "Decremented"]);
    expect(desc.commands).toBeUndefined();
    expect(desc.replies).toBeUndefined();
  });

  it("output is JSON-serializable", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const json = JSON.stringify(desc);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(desc);
  });
});
