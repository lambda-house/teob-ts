import { Hono } from "hono";
import { EntityId } from "../../../../src/core/types.js";
import type { EntityRuntime } from "../../../../src/core/runtime.js";
import { todoCategory, type TodoCommand, type TodoReply } from "./aggregate.js";

export function todoRoutes(runtime: EntityRuntime): Hono {
  const app = new Hono();

  app.post("/todos/:listId/items", async (c) => {
    const listId = EntityId(c.req.param("listId"));
    const { title } = await c.req.json<{ title: string }>();
    const itemId = crypto.randomUUID();
    const command: TodoCommand = { tag: "AddItem", itemId, title };
    const result = await runtime.ask(listId, command, todoCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as TodoReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ itemId }, 201);
  });

  app.patch("/todos/:listId/items/:itemId/complete", async (c) => {
    const listId = EntityId(c.req.param("listId"));
    const command: TodoCommand = { tag: "CompleteItem", itemId: c.req.param("itemId") };
    const result = await runtime.ask(listId, command, todoCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as TodoReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.patch("/todos/:listId/items/:itemId/uncomplete", async (c) => {
    const listId = EntityId(c.req.param("listId"));
    const command: TodoCommand = { tag: "UncompleteItem", itemId: c.req.param("itemId") };
    const result = await runtime.ask(listId, command, todoCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as TodoReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.delete("/todos/:listId/items/:itemId", async (c) => {
    const listId = EntityId(c.req.param("listId"));
    const command: TodoCommand = { tag: "RemoveItem", itemId: c.req.param("itemId") };
    const result = await runtime.ask(listId, command, todoCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as TodoReply;
    if (reply.tag === "Rejected") return c.json({ error: reply.reason }, 400);
    return c.json({ status: "ok" });
  });

  app.get("/todos/:listId", async (c) => {
    const listId = EntityId(c.req.param("listId"));
    const command: TodoCommand = { tag: "GetList" };
    const result = await runtime.ask(listId, command, todoCategory);
    if (!result.ok) return c.json({ error: result.error }, 500);
    const reply = result.value.reply as TodoReply;
    if (reply.tag === "TodoList") {
      return c.json({ listId: c.req.param("listId"), items: reply.items });
    }
    return c.json({ listId: c.req.param("listId"), items: [] });
  });

  return app;
}
