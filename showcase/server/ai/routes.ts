import { Hono } from "hono";
import type { ChatService } from "./chat-service.js";

export function chatRoutes(chatService: ChatService): Hono {
  const app = new Hono();

  app.post("/chat/sessions", async (c) => {
    const body = await c.req.json<{ systemPrompt?: string }>().catch(() => ({ systemPrompt: undefined }));
    const sessionId = chatService.createSession(body.systemPrompt);
    return c.json({ sessionId }, 201);
  });

  app.post("/chat/sessions/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const { message } = await c.req.json<{ message: string }>();
    try {
      const response = await chatService.sendMessage(sessionId, message);
      return c.json(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Session not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  app.get("/chat/sessions/:id/messages", (c) => {
    const sessionId = c.req.param("id");
    try {
      const messages = chatService.getMessages(sessionId);
      return c.json({ messages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Session not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  app.delete("/chat/sessions/:id", (c) => {
    const sessionId = c.req.param("id");
    const deleted = chatService.deleteSession(sessionId);
    if (!deleted) return c.json({ error: "Session not found" }, 404);
    return c.json({ status: "ok" });
  });

  return app;
}
