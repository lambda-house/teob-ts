import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { EntityId } from "../src/core/types.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import {
  counterAggregate,
  counterEventCodec,
  counterStateCodec,
  counterCategory,
  type CounterCommand,
  type CounterReply,
} from "./example/counter.js";

const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/counter/:id/increment", async (c) => {
  const id = EntityId(c.req.param("id"));
  const body = await c.req.json<{ amount?: number }>();
  const command: CounterCommand = { tag: "Increment", amount: body.amount ?? 1 };
  const result = await runtime.ask(id, command, counterCategory);
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ status: "ok" });
});

app.post("/counter/:id/decrement", async (c) => {
  const id = EntityId(c.req.param("id"));
  const body = await c.req.json<{ amount?: number }>();
  const command: CounterCommand = { tag: "Decrement", amount: body.amount ?? 1 };
  const result = await runtime.ask(id, command, counterCategory);
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ status: "ok" });
});

app.get("/counter/:id", async (c) => {
  const id = EntityId(c.req.param("id"));
  const command: CounterCommand = { tag: "GetValue" };
  const result = await runtime.ask(id, command, counterCategory);
  if (!result.ok) return c.json({ error: result.error }, 500);
  const reply = result.value.reply as CounterReply | undefined;
  if (reply?.tag === "Value") return c.json({ value: reply.value });
  return c.json({ value: null });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Starting TEOB-TS on port ${port}`);
serve({ fetch: app.fetch, port });
