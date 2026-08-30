import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CategoryId, EntityId } from "../src/core/types.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { persist, andReply } from "../src/core/effect.js";
import { categoryTypes } from "../src/core/effect-control.js";
import type { Aggregate } from "../src/core/aggregate.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import type { EntityRuntime } from "../src/core/runtime.js";
import { ulid, ulidTime } from "../src/core/ulid.js";
import {
  ENVELOPE,
  stampEnvelope,
  envelopeStampOf,
  type PersistedBatch,
} from "../src/core/envelope.js";

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

// --- ULID ---

describe("ulid", () => {
  it("produces 26-char Crockford base32 ids", () => {
    const id = ulid();
    expect(id).toMatch(ULID_RE);
  });

  it("is strictly monotonic over 1000 ids", () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it("increments the random part on same-ms calls (time prefix stable)", () => {
    // Future timestamp so process-global monotonic state takes the fresh-time branch first.
    const t = Date.now() + 60_000_000;
    const a = ulid(t);
    const b = ulid(t);
    expect(b > a).toBe(true);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it("ulidTime extracts the ms timestamp", () => {
    const t = Date.now() + 120_000_000;
    const id = ulid(t);
    expect(ulidTime(id)).toBe(t);
  });

  it("ulidTime rejects invalid input", () => {
    expect(() => ulidTime("!!!")).toThrow(); // too short
    expect(() => ulidTime("012345678U0123456789ABCDEF")).toThrow(); // U (not in alphabet) inside time part
  });
});

// --- stampEnvelope / envelopeStampOf ---

describe("stampEnvelope", () => {
  it("attaches a non-enumerable symbol property and returns the same object", () => {
    const event = { tag: "X", n: 1 };
    const stamped = stampEnvelope(event, { causationId: "c-1", origin: "ha" });
    expect(stamped).toBe(event);
    expect(envelopeStampOf(event)).toEqual({ causationId: "c-1", origin: "ha" });
    const desc = Object.getOwnPropertyDescriptor(event, ENVELOPE);
    expect(desc?.enumerable).toBe(false);
  });

  it("is invisible to JSON.stringify and Object.keys", () => {
    const event = stampEnvelope({ tag: "X", n: 1 }, { causationId: "c-1" });
    expect(JSON.stringify(event)).toBe(JSON.stringify({ tag: "X", n: 1 }));
    expect(Object.keys(event)).toEqual(["tag", "n"]);
  });

  it("envelopeStampOf returns undefined for unstamped and non-object values", () => {
    expect(envelopeStampOf({ tag: "X" })).toBeUndefined();
    expect(envelopeStampOf(null)).toBeUndefined();
    expect(envelopeStampOf(42)).toBeUndefined();
    expect(envelopeStampOf("s")).toBeUndefined();
  });
});

// --- Test aggregate ---

type Cmd =
  | { tag: "Stamped"; causationId: string; correlationId?: string }
  | { tag: "Unstamped" }
  | { tag: "WithEventId"; eventId: string }
  | { tag: "Multi" };
type Evt = { tag: "Happened"; n: number };
type Reply = { tag: "Ok" };
type State = { count: number };

const appliedEvents: Evt[] = [];

const testAggregate: Aggregate<Cmd, Reply, Evt, State> = {
  category: CategoryId("env-test"),
  initial: () => ({ count: 0 }),
  async decide(state, command) {
    const next = (): Evt => ({ tag: "Happened", n: state.count + 1 });
    switch (command.tag) {
      case "Stamped":
        return andReply(
          persist(
            stampEnvelope(next(), {
              causationId: command.causationId,
              ...(command.correlationId !== undefined && { correlationId: command.correlationId }),
              origin: "ha",
            }),
          ),
          { tag: "Ok" },
        );
      case "Unstamped":
        return andReply(persist(next()), { tag: "Ok" });
      case "WithEventId":
        return andReply(persist(stampEnvelope(next(), { eventId: command.eventId })), { tag: "Ok" });
      case "Multi":
        return andReply(
          persist<Evt, Reply>(
            stampEnvelope({ tag: "Happened", n: state.count + 1 }, { causationId: "multi-cause" }),
            { tag: "Happened", n: state.count + 2 },
          ),
          { tag: "Ok" },
        );
    }
  },
  apply(state, event) {
    appliedEvents.push(event);
    return { count: state.count + 1 };
  },
};

const eventCodec = tagCodec<Evt>("Happened");
const stateCodec = objectCodec<State>("EnvTestState");
const category = categoryTypes<Cmd, Reply>(CategoryId("env-test"));

// --- inmem persist path ---

describe("inmem persist path envelopes", () => {
  let runtime: EntityRuntime;
  let batches: PersistedBatch[];

  beforeEach(() => {
    appliedEvents.length = 0;
    batches = [];
    ({ runtime } = createSingleRuntime(testAggregate, eventCodec, stateCodec, {
      onPersisted: (batch) => batches.push(batch),
    }));
  });

  afterEach(async () => {
    await runtime.shutdown();
  });

  it("stamped event: hook receives stamped causationId/origin plus generated eventId", async () => {
    const before = Date.now();
    const result = await runtime.ask(EntityId("e1"), { tag: "Stamped", causationId: "ctx-1" }, category);
    expect(result.ok).toBe(true);

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.category).toBe("env-test");
    expect(batch.entityId).toBe("e1");
    expect(batch.at).toBeGreaterThanOrEqual(before);
    expect(batch.at).toBeLessThanOrEqual(Date.now());

    expect(batch.records).toHaveLength(1);
    const rec = batch.records[0];
    expect(rec.sequenceNr).toBe(1);
    expect(rec.manifest).toBe("Happened");
    expect(rec.encoded).toEqual({ tag: "Happened", n: 1 });
    expect(rec.envelope.eventId).toMatch(ULID_RE);
    expect(rec.envelope.causationId).toBe("ctx-1");
    expect(rec.envelope.origin).toBe("ha");
    expect(rec.envelope.v).toBe(1);
    expect(rec.envelope.correlationId).toBeUndefined();
  });

  it("stamped correlationId is carried through", async () => {
    await runtime.ask(
      EntityId("e1"),
      { tag: "Stamped", causationId: "ctx-2", correlationId: "flow-9" },
      category,
    );
    expect(batches[0].records[0].envelope.correlationId).toBe("flow-9");
  });

  it("unstamped event: envelope has eventId and v only", async () => {
    await runtime.ask(EntityId("e1"), { tag: "Unstamped" }, category);
    const env = batches[0].records[0].envelope;
    expect(Object.keys(env).sort()).toEqual(["eventId", "v"]);
    expect(env.eventId).toMatch(ULID_RE);
    expect(env.v).toBe(1);
  });

  it("pre-stamped eventId is respected, not regenerated", async () => {
    const fixed = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await runtime.ask(EntityId("e1"), { tag: "WithEventId", eventId: fixed }, category);
    expect(batches[0].records[0].envelope.eventId).toBe(fixed);
  });

  it("multi-event persist: parallel envelopes with distinct eventIds and correct sequenceNrs", async () => {
    await runtime.ask(EntityId("e1"), { tag: "Multi" }, category);
    expect(batches).toHaveLength(1);
    const [r1, r2] = batches[0].records;
    expect(r1.sequenceNr).toBe(1);
    expect(r2.sequenceNr).toBe(2);
    expect(r1.envelope.causationId).toBe("multi-cause");
    expect(r2.envelope.causationId).toBeUndefined();
    expect(r1.envelope.eventId).not.toBe(r2.envelope.eventId);
    expect(r1.encoded).toEqual({ tag: "Happened", n: 1 });
    expect(r2.encoded).toEqual({ tag: "Happened", n: 2 });
  });

  it("hook fires once per persist across commands with advancing sequenceNrs", async () => {
    await runtime.ask(EntityId("e1"), { tag: "Unstamped" }, category);
    await runtime.ask(EntityId("e1"), { tag: "Unstamped" }, category);
    expect(batches).toHaveLength(2);
    expect(batches[0].records[0].sequenceNr).toBe(1);
    expect(batches[1].records[0].sequenceNr).toBe(2);
  });

  it("stamp is invisible to apply and to JSON round-trips of the event", async () => {
    await runtime.ask(EntityId("e1"), { tag: "Stamped", causationId: "ctx-3" }, category);
    expect(appliedEvents).toHaveLength(1);
    const seen = appliedEvents[0];
    // Structurally just the payload
    expect(Object.keys(seen)).toEqual(["tag", "n"]);
    expect(JSON.stringify(seen)).toBe(JSON.stringify({ tag: "Happened", n: 1 }));
    expect(JSON.parse(JSON.stringify(seen))).toEqual({ tag: "Happened", n: 1 });
    // The symbol stamp exists on the same object but is non-enumerable
    expect(envelopeStampOf(seen)).toEqual({ causationId: "ctx-3", origin: "ha" });
    expect(Object.getOwnPropertyDescriptor(seen, ENVELOPE)?.enumerable).toBe(false);
  });

  it("runtime without onPersisted still works (hook optional)", async () => {
    const { runtime: plain } = createSingleRuntime(testAggregate, eventCodec, stateCodec);
    const result = await plain.ask(EntityId("e9"), { tag: "Unstamped" }, category);
    expect(result.ok).toBe(true);
    await plain.shutdown();
  });
});
