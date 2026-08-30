// Shared aggregate-runtime behaviors — inmem and sqlite runtimes run the same
// cases, including recovery across a restart (port of Scala
// AggregateRuntimeBehaviors, TEO-143).

import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, TimerId } from "../../src/core/types.js";
import type { Aggregate } from "../../src/core/aggregate.js";
import type { Effect } from "../../src/core/effect.js";
import { persist, reply, andReply } from "../../src/core/effect.js";
import { tagCodec, objectCodec } from "../../src/core/codec.js";
import { categoryTypes } from "../../src/core/effect-control.js";
import type { EntityRuntime } from "../../src/core/runtime.js";
import { registration, type AggregateRegistration } from "../../src/inmem/runtime.js";

export type CounterCmd =
  | { tag: "Inc" }
  | { tag: "Dec" }
  | { tag: "Get" }
  | { tag: "ScheduleInc"; key: string; delayMs: number }
  | { tag: "CancelInc"; key: string };
export type CounterEvt = { tag: "Inced" } | { tag: "Deced" };
export type CounterRep = { tag: "Count"; n: number } | { tag: "Ok" };
export type CounterState = { n: number };

export const COUNTER_CATEGORY = CategoryId("rb-counter");
export const counterCat = categoryTypes<CounterCmd, CounterRep>(COUNTER_CATEGORY);
export const counterEvtCodec = tagCodec<CounterEvt>("Inced", "Deced");
export const counterStateCodec = objectCodec<CounterState>("State");

export function counterAggregate(snapshotEvery?: number): Aggregate<CounterCmd, CounterRep, CounterEvt, CounterState> {
  return {
    category: COUNTER_CATEGORY,
    ...(snapshotEvery !== undefined && { snapshotEvery }),
    initial: () => ({ n: 0 }),
    async decide(state, command, ctx): Promise<Effect<CounterEvt, CounterRep>> {
      switch (command.tag) {
        case "Inc":
          return andReply(persist<CounterEvt, CounterRep>({ tag: "Inced" }), { tag: "Ok" });
        case "Dec":
          return andReply(persist<CounterEvt, CounterRep>({ tag: "Deced" }), { tag: "Ok" });
        case "Get":
          return reply({ tag: "Count", n: state.n });
        case "ScheduleInc":
          await ctx.scheduleOnce(TimerId(command.key), { tag: "Inc" }, command.delayMs);
          return reply({ tag: "Ok" });
        case "CancelInc":
          await ctx.cancelTimer(TimerId(command.key));
          return reply({ tag: "Ok" });
      }
    },
    apply: (s, e) => ({ n: e.tag === "Inced" ? s.n + 1 : s.n - 1 }),
  };
}

export function counterRegistration(snapshotEvery?: number): AggregateRegistration<CounterCmd, CounterRep, CounterEvt, CounterState> {
  return registration(counterAggregate(snapshotEvery), counterEvtCodec, counterStateCodec);
}

/** A runtime under test plus the ability to restart it over the same history. */
export interface RuntimeHarness {
  runtime: EntityRuntime;
  /** Shut the runtime down and hand back a fresh one over the SAME journal. */
  restart(): Promise<EntityRuntime>;
  close(): Promise<void>;
}

async function getCount(runtime: EntityRuntime, id: EntityId): Promise<number> {
  const r = await runtime.ask(id, { tag: "Get" } as CounterCmd, counterCat);
  if (!r.ok || r.value.reply?.tag !== "Count") throw new Error(`unexpected: ${JSON.stringify(r)}`);
  return r.value.reply.n;
}

function eventually(f: () => Promise<void>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  return (async function attempt(): Promise<void> {
    try {
      await f();
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 20));
      return attempt();
    }
  })();
}

export function describeRuntimeBehaviors(
  name: string,
  makeHarness: (snapshotEvery?: number) => Promise<RuntimeHarness>,
): void {
  describe(`${name} runtime behaviors`, () => {
    it("increments", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("e1");
        await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        expect(await getCount(h.runtime, id)).toBe(2);
      } finally {
        await h.close();
      }
    });

    it("decrements", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("e1");
        await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "Dec" } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "Dec" } as CounterCmd, counterCat);
        expect(await getCount(h.runtime, id)).toBe(-1);
      } finally {
        await h.close();
      }
    });

    it("maintains separate state per entity", async () => {
      const h = await makeHarness();
      try {
        await h.runtime.ask(EntityId("a"), { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(EntityId("b"), { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(EntityId("b"), { tag: "Inc" } as CounterCmd, counterCat);
        expect(await getCount(h.runtime, EntityId("a"))).toBe(1);
        expect(await getCount(h.runtime, EntityId("b"))).toBe(2);
      } finally {
        await h.close();
      }
    });

    it("scheduleOnce delivers the command after the delay", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("t1");
        await h.runtime.ask(id, { tag: "ScheduleInc", key: "k", delayMs: 30 } as CounterCmd, counterCat);
        expect(await getCount(h.runtime, id)).toBe(0);
        await eventually(async () => {
          expect(await getCount(h.runtime, id)).toBe(1);
        });
      } finally {
        await h.close();
      }
    });

    it("multiple scheduled timers all fire", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("t2");
        await h.runtime.ask(id, { tag: "ScheduleInc", key: "k1", delayMs: 20 } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "ScheduleInc", key: "k2", delayMs: 30 } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "ScheduleInc", key: "k3", delayMs: 40 } as CounterCmd, counterCat);
        await eventually(async () => {
          expect(await getCount(h.runtime, id)).toBe(3);
        });
      } finally {
        await h.close();
      }
    });

    it("cancelTimer prevents the scheduled command", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("t3");
        await h.runtime.ask(id, { tag: "ScheduleInc", key: "k", delayMs: 60 } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "CancelInc", key: "k" } as CounterCmd, counterCat);
        await new Promise((r) => setTimeout(r, 120));
        expect(await getCount(h.runtime, id)).toBe(0);
      } finally {
        await h.close();
      }
    });

    it("state survives a restart via journal replay", async () => {
      const h = await makeHarness();
      try {
        const id = EntityId("r1");
        await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        await h.runtime.ask(id, { tag: "Dec" } as CounterCmd, counterCat);

        const restarted = await h.restart();
        expect(await getCount(restarted, id)).toBe(1);

        // And keeps accepting writes at the right sequence numbers.
        const inc = await restarted.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        expect(inc.ok).toBe(true);
        expect(await getCount(restarted, id)).toBe(2);
      } finally {
        await h.close();
      }
    });

    it("recovers through a snapshot plus trailing events", async () => {
      const h = await makeHarness(2); // snapshot every 2 events
      try {
        const id = EntityId("r2");
        for (let i = 0; i < 5; i++) {
          await h.runtime.ask(id, { tag: "Inc" } as CounterCmd, counterCat);
        }
        const restarted = await h.restart();
        expect(await getCount(restarted, id)).toBe(5);
      } finally {
        await h.close();
      }
    });
  });
}
