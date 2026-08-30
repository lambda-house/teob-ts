import { Hono } from "hono";
import { EntityId } from "../../../../src/core/types.js";
import { categoryTypes } from "../../../../src/core/effect-control.js";
import type { EntityRuntime } from "../../../../src/core/runtime.js";
import type { FlowCommand, FlowReply } from "../../../../src/petrinet/flow-aggregate.js";
import { SignupFlowCategory, signupRequested } from "./flow.js";

const flowCat = categoryTypes<FlowCommand, FlowReply>(SignupFlowCategory);

export function signupRoutes(runtime: EntityRuntime): Hono {
  const app = new Hono();

  app.post("/signup", async (c) => {
    const { email, password } = await c.req.json<{ email: string; password: string }>();
    const flowId = `signup-${crypto.randomUUID()}`;
    const spanId = crypto.randomUUID();

    const command: FlowCommand = {
      tag: "InboundToken",
      token: signupRequested(email, password),
      expectsRepliesAt: ["Completed", "Rejected"],
      spanId,
    };

    // Fire and forget — the flow runs asynchronously via transitions
    await runtime.tell(EntityId(flowId), command, flowCat);

    return c.json({ flowId, status: "processing" }, 202);
  });

  app.get("/signup/:flowId", async (c) => {
    const flowId = EntityId(c.req.param("flowId"));
    const command: FlowCommand = { tag: "GetFlowInstanceView" };
    const result = await runtime.ask(flowId, command, flowCat);

    if (!result.ok) return c.json({ error: result.error }, 500);

    const view = result.value.reply as FlowReply & { tag: "FlowInstanceView" };
    if (view.tag !== "FlowInstanceView") {
      return c.json({ flowId: c.req.param("flowId"), status: "unknown" });
    }

    // Determine outcome from outbound places
    const completedTokens = view.places.get("Completed") ?? [];
    const rejectedTokens = view.places.get("Rejected") ?? [];
    let outcome: string | undefined;
    if (completedTokens.length > 0) outcome = "completed";
    else if (rejectedTokens.length > 0) outcome = "rejected";

    // Serialize Maps to plain objects for JSON
    const places: Record<string, unknown[]> = {};
    for (const [pid, tokens] of view.places) {
      places[pid] = tokens;
    }
    const transitions: Record<string, string> = {};
    for (const [tid, state] of view.transitions) {
      transitions[tid] = state;
    }

    return c.json({
      flowId: c.req.param("flowId"),
      places,
      transitions,
      outcome,
    });
  });

  return app;
}
