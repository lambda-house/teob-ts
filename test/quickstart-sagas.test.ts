import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { EntityId, CategoryId } from "../src/core/types.js";
import { categoryTypes } from "../src/core/effect-control.js";
import { persist, reply } from "../src/core/effect.js";
import { aggregate, quickstart, type QuickstartHandle } from "../src/quickstart/index.js";
import { saga } from "../src/saga/index.js";

type OrderCmd = { tag: "Create" } | { tag: "Get" };
type OrderEvt = { tag: "Created" };
type OrderRep = { tag: "Status"; created: boolean };

type MailCmd = { tag: "Send" } | { tag: "Get" };
type MailEvt = { tag: "Sent" };
type MailRep = { tag: "Count"; n: number };

function orderAggregate() {
  return aggregate<OrderCmd, OrderEvt, { created: boolean }, OrderRep>({
    category: "qs-order",
    initialState: () => ({ created: false }),
    decide: async (state, command) =>
      command.tag === "Create"
        ? persist({ tag: "Created" })
        : reply({ tag: "Status", created: state.created }),
    apply: () => ({ created: true }),
  });
}

function mailAggregate() {
  return aggregate<MailCmd, MailEvt, { n: number }, MailRep>({
    category: "qs-mail",
    initialState: () => ({ n: 0 }),
    decide: async (state, command) =>
      command.tag === "Send" ? persist({ tag: "Sent" }) : reply({ tag: "Count", n: state.n }),
    apply: (s) => ({ n: s.n + 1 }),
  });
}

const orderCat = categoryTypes<OrderCmd, OrderRep>(CategoryId("qs-order"));
const mailCat = categoryTypes<MailCmd, MailRep>(CategoryId("qs-mail"));

const mailSaga = () =>
  saga<OrderEvt>({
    name: "send-mail",
    from: "qs-order",
    on: "Created",
    execute: async (_e, entityId, ctx) => {
      await ctx.tell(EntityId(`mail-${entityId}`), { tag: "Send" }, mailCat);
    },
  });

async function mailCount(handle: QuickstartHandle, id: string): Promise<number> {
  const r = await handle.runtime.ask(EntityId(id), { tag: "Get" } as MailCmd, mailCat);
  return r.ok && r.value.reply?.tag === "Count" ? r.value.reply.n : -1;
}

async function eventually(f: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached in time");
}

describe("quickstart sagas", () => {
  const handles: QuickstartHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) await handles.pop()!.stop();
  });

  it("rejects a saga subscribing to a category no aggregate registers", () => {
    expect(() =>
      quickstart({
        aggregates: [orderAggregate()],
        sagas: [saga({ name: "bad", from: "nope", on: "X", execute: async () => {} })],
        port: 19110,
      }),
    ).toThrow("unknown category 'nope'");
  });

  it("runs a stateless saga over the live inmem tail", async () => {
    const handle = quickstart({
      aggregates: [orderAggregate(), mailAggregate()],
      sagas: [mailSaga()],
      port: 19111,
      sagaPollIntervalMs: 10,
    });
    handles.push(handle);

    await handle.runtime.ask(EntityId("o1"), { tag: "Create" } as OrderCmd, orderCat);
    await eventually(async () => (await mailCount(handle, "mail-o1")) === 1);
  });

  it("sqlite persistence: a restart resumes saga offsets instead of re-firing", async () => {
    const path = `/tmp/teob-qs-${Date.now().toString(36)}.db`;
    try {
      {
        const handle = quickstart({
          aggregates: [orderAggregate(), mailAggregate()],
          sagas: [mailSaga()],
          persistence: { mode: "sqlite", path },
          port: 19112,
          sagaPollIntervalMs: 10,
        });
        await handle.runtime.ask(EntityId("o1"), { tag: "Create" } as OrderCmd, orderCat);
        await eventually(async () => (await mailCount(handle, "mail-o1")) === 1);
        await handle.stop();
      }
      {
        const handle = quickstart({
          aggregates: [orderAggregate(), mailAggregate()],
          sagas: [mailSaga()],
          persistence: { mode: "sqlite", path },
          port: 19113,
          sagaPollIntervalMs: 10,
        });
        handles.push(handle);

        // The old Created event must NOT re-fire the saga (durable offsets)…
        await new Promise((r) => setTimeout(r, 300));
        expect(await mailCount(handle, "mail-o1")).toBe(1);

        // …while a new event still does.
        await handle.runtime.ask(EntityId("o2"), { tag: "Create" } as OrderCmd, orderCat);
        await eventually(async () => (await mailCount(handle, "mail-o2")) === 1);
        expect(await mailCount(handle, "mail-o1")).toBe(1);
      }
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
