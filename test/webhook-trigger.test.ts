import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { tagCodec } from "../src/core/codec.js";
import { EntityId } from "../src/core/types.js";
import { categoryTypes } from "../src/core/effect-control.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import {
  createNodeFlowAggregate,
  type NodeFlowCommand,
  type NodeFlowEvent,
  type NodeFlowReply,
  type NodeFlowState,
} from "../src/ai/node-flow/aggregate.js";
import type { NodeFlowDef } from "../src/ai/node-flow/def.js";
import type { NodeDef } from "../src/ai/node-flow/nodes.js";
import {
  webhookTriggerRoutes,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookConfig,
} from "../src/ai/node-flow/webhook-trigger.js";

function flow(): NodeFlowDef {
  const nodes = new Map<string, NodeDef>([
    ["seed", { kind: "attribute_op", reads: [], writes: { greeting: "greeting" } }],
  ]);
  return {
    id: "wh-flow",
    description: "webhook-started flow",
    nodes,
    edges: [],
    tags: new Set(),
    initialContext: { greeting: "hello" },
    trigger: { kind: "webhook", path: "/hooks/test" },
  };
}

const cat = categoryTypes<NodeFlowCommand, NodeFlowReply>(
  "node-flow" as unknown as ReturnType<typeof categoryTypes>["categoryId"],
);

const SECRET = "topsecret";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

function setup() {
  const { runtime } = createSingleRuntime(
    createNodeFlowAggregate(),
    tagCodec<NodeFlowEvent>(
      "flow_started", "node_started", "node_succeeded", "node_failed",
      "flow_completed", "flow_failed", "waiting_for_input",
      "child_flow_started", "child_flow_done", "message_received", "message_sent",
    ),
    tagCodec<NodeFlowState>("State") as unknown as ReturnType<typeof tagCodec<NodeFlowState>>,
  );

  const configs = new Map<string, WebhookConfig>([
    ["secured", { resourceId: "secured", flowDef: flow(), secret: SECRET, metadata: { source: "test" } }],
    ["open", { resourceId: "open", flowDef: flow() }],
  ]);

  const app = new Hono();
  app.route(
    "/api/webhooks",
    webhookTriggerRoutes({
      runtime,
      cat,
      resolve: async (id) => configs.get(id),
    }),
  );
  return { app, runtime };
}

function post(app: Hono, path: string, body: string, signature?: string) {
  return app.request(path, {
    method: "POST",
    body,
    headers: signature !== undefined ? { [WEBHOOK_SIGNATURE_HEADER]: signature } : {},
  });
}

describe("webhookTriggerRoutes", () => {
  it("404s an unknown resource", async () => {
    const { app } = setup();
    const res = await post(app, "/api/webhooks/nope", "{}");
    expect(res.status).toBe(404);
  });

  it("rejects a missing signature with 401 before parsing the body", async () => {
    const { app } = setup();
    // Body is not even valid JSON — the 401 must come first.
    const res = await post(app, "/api/webhooks/secured", "not json");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong signature in 401", async () => {
    const { app } = setup();
    const body = JSON.stringify({ hello: true });
    const res = await post(app, "/api/webhooks/secured", body, sign(body, "other-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects malformed signatures (empty, odd length, non-hex) without comparing", async () => {
    const { app } = setup();
    const body = "{}";
    for (const bad of ["", "abc", "zz".repeat(32)]) {
      const res = await post(app, "/api/webhooks/secured", body, bad);
      expect(res.status).toBe(401);
    }
  });

  it("accepts a correctly signed request and starts the flow", async () => {
    const { app, runtime } = setup();
    const body = JSON.stringify({ orderId: 42 });
    const res = await post(app, "/api/webhooks/secured", body, sign(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { flowId: string; status: string };
    expect(json.status).toBe("triggered");
    expect(json.flowId).toMatch(/^wh-secured-/);

    // The flow's context carries the webhook payload and the config metadata.
    const state = await runtime.ask(EntityId(json.flowId), { tag: "get_state" }, cat);
    expect(state.ok).toBe(true);
    if (state.ok && state.value.reply?.tag === "state_snapshot") {
      const ctx = state.value.reply.state.context as Record<string, any>;
      expect(ctx.webhook).toEqual({ resourceId: "secured", payload: { orderId: 42 } });
      expect(ctx.source).toBe("test");
    } else {
      throw new Error("expected state snapshot");
    }
  });

  it("400s invalid JSON only after the signature passes", async () => {
    const { app } = setup();
    const body = "not json";
    const res = await post(app, "/api/webhooks/secured", body, sign(body));
    expect(res.status).toBe(400);
  });

  it("serves an unsecured config without any signature", async () => {
    const { app } = setup();
    const res = await post(app, "/api/webhooks/open", JSON.stringify({ ping: 1 }));
    expect(res.status).toBe(200);
  });
});
