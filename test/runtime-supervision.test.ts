// Port of the Scala RuntimeSupervisionSpec (TEO-138) plus the snapshot-recovery
// resilience cases (B3/B4 in SCALA_PORT_PLAN.md).

import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { Aggregate } from "../src/core/aggregate.js";
import type { Effect } from "../src/core/effect.js";
import { persist, reply, andReply, andUnstash, stash, stop, replyDeferred } from "../src/core/effect.js";
import { createDeferredReply } from "../src/core/deferred.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import type { Codec } from "../src/core/codec.js";
import { categoryTypes } from "../src/core/effect-control.js";
import { createSingleRuntime, registration, createInMemoryRuntime } from "../src/inmem/runtime.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { SnapshotDecodeError } from "../src/core/journal-store.js";
import { createSqliteRuntime } from "../src/sqlite/index.js";

// A gate: Inc commands are stashed until Open arrives — the classic
// stash-until-initialized shape, so unstash genuinely replays.
type Cmd =
  | { tag: "Open" }
  | { tag: "Inc" }
  | { tag: "Get" }
  | { tag: "Boom" }
  | { tag: "Halt" }
  | { tag: "Defer" };
type Evt = { tag: "Opened" } | { tag: "Inced" };
type Rep = { tag: "Count"; n: number } | { tag: "Ok" };
type State = { n: number; open: boolean };

function gateAggregate(): Aggregate<Cmd, Rep, Evt, State> {
  return {
    category: CategoryId("sup-gate"),
    initial: () => ({ n: 0, open: false }),
    async decide(state, command): Promise<Effect<Evt, Rep>> {
      switch (command.tag) {
        case "Open":
          // Persist (state becomes open), replay the stash, then answer.
          return andReply(andUnstash(persist<Evt, Rep>({ tag: "Opened" })), { tag: "Ok" });
        case "Inc":
          if (!state.open) return stash();
          return andReply(persist<Evt, Rep>({ tag: "Inced" }), { tag: "Ok" });
        case "Get":
          return reply({ tag: "Count", n: state.n });
        case "Boom":
          throw new Error("decide exploded");
        case "Halt":
          return stop();
        case "Defer":
          // A deferred that is never completed — the ask must be bounded.
          return replyDeferred(createDeferredReply<Rep>());
      }
    },
    apply: (s, e) => (e.tag === "Opened" ? { ...s, open: true } : { ...s, n: s.n + 1 }),
  };
}

const cat = categoryTypes<Cmd, Rep>(CategoryId("sup-gate"));
const evtCodec = tagCodec<Evt>("Opened", "Inced");
const stateCodec = objectCodec<State>("State");
const id = EntityId("e1");

describe("runtime supervision", () => {
  it("a crashed entity fails the ask with the cause instead of timing out, and re-activates on the next command", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec);
    await runtime.ask(id, { tag: "Open" }, cat);
    await runtime.ask(id, { tag: "Inc" }, cat);

    const boom = await runtime.ask(id, { tag: "Boom" }, cat);
    expect(boom.ok).toBe(false);
    if (!boom.ok) {
      expect(boom.error).toEqual({ tag: "General", message: "decide exploded" });
    }

    // Fresh incarnation recovers the persisted state.
    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 1 });
  });

  it("Effect.stop passivates: the next command re-activates the entity with its persisted state", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec);
    await runtime.ask(id, { tag: "Open" }, cat);
    await runtime.ask(id, { tag: "Inc" }, cat);
    await runtime.ask(id, { tag: "Inc" }, cat);
    await runtime.tell(id, { tag: "Halt" }, cat);
    await new Promise((r) => setTimeout(r, 10));

    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 2 });
  });

  it("a failed persist crashes the entity instead of leaving it half-applied", async () => {
    const journal = createInMemoryJournal();
    let failOnce = false;
    const failing = {
      ...journal,
      persistEvents<E>(c: CategoryId, e: EntityId, ev: E[], s: SequenceNr, codec: Codec<E>, env?: any) {
        if (failOnce) {
          failOnce = false;
          throw new Error("disk full");
        }
        return journal.persistEvents(c, e, ev, s, codec, env);
      },
    };
    const { runtime } = createInMemoryRuntime(
      [registration(gateAggregate(), evtCodec, stateCodec)],
      { journal: failing },
    );
    await runtime.ask(id, { tag: "Open" }, cat);

    failOnce = true;
    const failed = await runtime.ask(id, { tag: "Inc" }, cat);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toEqual({ tag: "General", message: "disk full" });

    // Nothing was applied; the fresh incarnation recovers from the journal.
    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 0 });

    const inc = await runtime.ask(id, { tag: "Inc" }, cat);
    expect(inc.ok).toBe(true);
    const now = await runtime.ask(id, { tag: "Get" }, cat);
    expect(now.ok && now.value.reply).toEqual({ tag: "Count", n: 1 });
  });

  it("stashed tells replay on unstash", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec);
    await runtime.tell(id, { tag: "Inc" }, cat);
    await runtime.tell(id, { tag: "Inc" }, cat);
    await runtime.ask(id, { tag: "Open" }, cat);

    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 2 });
  });

  it("a stashed ask keeps its reply handle and answers after unstash", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec);
    // This ask is stashed — its promise stays pending, not timed out, not dropped.
    const held = runtime.ask(id, { tag: "Inc" }, cat);
    const raced = await Promise.race([held, new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(raced).toBe("pending");

    const open = await runtime.ask(id, { tag: "Open" }, cat);
    expect(open.ok && open.value.reply).toEqual({ tag: "Ok" });

    // The replayed Inc answered the ORIGINAL asker.
    const heldResult = await held;
    expect(heldResult.ok).toBe(true);
    if (heldResult.ok) expect(heldResult.value.reply).toEqual({ tag: "Ok" });

    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 1 });
  });

  it("a queued ask does not hang when the entity crashes mid-queue", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec, {
      askTimeoutMs: 5_000,
    });
    await runtime.ask(id, { tag: "Open" }, cat);
    // Queue Boom and a Get behind it in the same mailbox generation.
    const start = Date.now();
    const [boom, get] = await Promise.all([
      runtime.ask(id, { tag: "Boom" }, cat),
      runtime.ask(id, { tag: "Get" }, cat),
    ]);
    expect(boom.ok).toBe(false);
    expect(get.ok).toBe(false); // drained with a General error, not a 5s timeout
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("concurrent first commands create exactly one runner", async () => {
    const { runtime, journal } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec);
    await runtime.ask(id, { tag: "Open" }, cat);
    const [a, b] = await Promise.all([
      runtime.ask(id, { tag: "Inc" }, cat),
      runtime.ask(id, { tag: "Inc" }, cat),
    ]);
    expect(a.ok && b.ok).toBe(true);
    // One runner ⇒ strictly sequential seqNrs, no duplicate-seqnr crash.
    const events = journal.loadEvents(CategoryId("sup-gate"), id, SequenceNr(0), evtCodec);
    expect(events.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
  });

  it("the ask timeout is configurable", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec, {
      askTimeoutMs: 100,
    });
    const start = Date.now();
    const held = await runtime.ask(id, { tag: "Inc" }, cat); // stashed, never answered
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.error).toEqual({ tag: "Timeout" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("an abandoned deferred reply is bounded by the ask timeout", async () => {
    const { runtime } = createSingleRuntime(gateAggregate(), evtCodec, stateCodec, {
      askTimeoutMs: 100,
    });
    const res = await runtime.ask(id, { tag: "Defer" }, cat);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ tag: "Timeout" });
  });
});

describe("snapshot recovery resilience", () => {
  it("loadSnapshot raises the typed error when the stored snapshot does not decode", () => {
    const journal = createInMemoryJournal();
    journal.persistSnapshot(CategoryId("c"), id, { n: 1, open: true }, SequenceNr(1), stateCodec);
    const poison: Codec<State> = {
      manifest: () => "State",
      encode: (s) => s,
      decode: () => {
        throw new Error("schema drift");
      },
    };
    expect(() => journal.loadSnapshot(CategoryId("c"), id, poison)).toThrow(SnapshotDecodeError);
  });

  it("an undecodable snapshot falls back to full event replay (sqlite)", async () => {
    const path = `/tmp/teob-snapfall-${Date.now()}.db`;
    const snappy = { ...gateAggregate(), snapshotEvery: 1 };
    {
      const { runtime, journal } = createSqliteRuntime({ path }, [
        registration(snappy, evtCodec, stateCodec),
      ]);
      await runtime.ask(id, { tag: "Open" }, cat);
      await runtime.ask(id, { tag: "Inc" }, cat);
      await runtime.ask(id, { tag: "Inc" }, cat);
      await runtime.shutdown();
      // Corrupt the snapshot payload in place.
      journal.db.exec("UPDATE snapshots SET payload = 'not json'");
      journal.close();
    }
    const { runtime, journal } = createSqliteRuntime({ path }, [
      registration(snappy, evtCodec, stateCodec),
    ]);
    const after = await runtime.ask(id, { tag: "Get" }, cat);
    expect(after.ok && after.value.reply).toEqual({ tag: "Count", n: 2 });
    await runtime.shutdown();
    journal.close();
  });

  it("ignoreSnapshotsOnRecovery replays events only, past a decodable-but-wrong snapshot", async () => {
    const journal = createInMemoryJournal();
    journal.persistEvents(
      CategoryId("sup-gate"), id,
      [{ tag: "Opened" }, { tag: "Inced" }, { tag: "Inced" }] as Evt[],
      SequenceNr(0), evtCodec,
    );
    // A stale snapshot claiming n=99 — with the flag it is skipped.
    journal.persistSnapshot(CategoryId("sup-gate"), id, { n: 99, open: true }, SequenceNr(3), stateCodec);

    const { runtime } = createInMemoryRuntime([registration(gateAggregate(), evtCodec, stateCodec)], {
      journal,
      ignoreSnapshotsOnRecovery: true,
    });
    const res = await runtime.ask(id, { tag: "Get" }, cat);
    expect(res.ok && res.value.reply).toEqual({ tag: "Count", n: 2 });
  });
});
