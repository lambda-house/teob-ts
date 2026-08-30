import { Hono } from "hono";
import { EntityId } from "../../../../src/core/types.js";
import type { EntityRuntime } from "../../../../src/core/runtime.js";
import { giftCardCategory, type GiftCardCommand, type GiftCardReply } from "./aggregate.js";

export function giftCardRoutes(runtime: EntityRuntime): Hono {
  const app = new Hono();

  app.post("/gift-cards/:id/issue", async (c) => {
    const id = EntityId(c.req.param("id"));
    const { amount } = await c.req.json<{ amount: number }>();
    const command: GiftCardCommand = { tag: "Issue", amount };
    const result = await runtime.ask(id, command, giftCardCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as GiftCardReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.post("/gift-cards/:id/redeem", async (c) => {
    const id = EntityId(c.req.param("id"));
    const { amount } = await c.req.json<{ amount: number }>();
    const command: GiftCardCommand = { tag: "Redeem", amount };
    const result = await runtime.ask(id, command, giftCardCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as GiftCardReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.post("/gift-cards/:id/cancel", async (c) => {
    const id = EntityId(c.req.param("id"));
    const command: GiftCardCommand = { tag: "Cancel" };
    const result = await runtime.ask(id, command, giftCardCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as GiftCardReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.get("/gift-cards/:id", async (c) => {
    const id = EntityId(c.req.param("id"));
    const command: GiftCardCommand = { tag: "GetBalance" };
    const result = await runtime.ask(id, command, giftCardCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as GiftCardReply;
    if (reply.tag === "Balance") {
      return c.json({ id: c.req.param("id"), balance: reply.amount, status: "Active" });
    }
    return c.json({ id: c.req.param("id"), balance: 0, status: "Unknown" });
  });

  return app;
}
