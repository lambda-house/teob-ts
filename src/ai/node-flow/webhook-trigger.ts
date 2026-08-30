// webhook-trigger.ts — generic "webhook payload → start node flow" HTTP trigger.
//
// The application provides a `resolve` function mapping a resource id to a
// WebhookConfig. The trigger handles routing, signature verification (when
// the config carries a secret), context building, and flow creation.

import { Hono } from "hono";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { EntityId } from "../../core/types.js";
import type { EntityRuntime } from "../../core/runtime.js";
import type { CategoryRegistration } from "../../core/effect-control.js";
import type { NodeFlowCommand, NodeFlowReply } from "./aggregate.js";
import type { NodeFlowDef } from "./def.js";

/** Header carrying the lowercase-hex HMAC-SHA256 signature of the raw request body. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature";

/**
 * Webhook configuration resolved by the application.
 *
 * When `secret` is set, incoming requests must carry an `X-Webhook-Signature`
 * header containing the lowercase-hex HMAC-SHA256 of the raw request body
 * computed with this secret. Requests with a missing or invalid signature are
 * rejected with 401 BEFORE the body is parsed or a flow is started. When
 * absent, no verification is performed — the endpoint is unauthenticated.
 */
export interface WebhookConfig {
  resourceId: string;
  /** The flow started for each accepted delivery. */
  flowDef: NodeFlowDef;
  /** Merged into the flow's initial context beside the `webhook` entry. */
  metadata?: Record<string, unknown>;
  secret?: string;
}

export interface WebhookTriggerOptions {
  runtime: EntityRuntime;
  cat: CategoryRegistration<NodeFlowCommand, NodeFlowReply>;
  /** Map a resource id to its webhook config; undefined ⇒ 404. */
  resolve: (resourceId: string) => Promise<WebhookConfig | undefined>;
  /** Prefix for generated flow entity ids. Defaults to "wh". */
  flowIdPrefix?: string;
}

/** Decode a hex string to bytes. Undefined on empty input, odd length, or non-hex characters. */
function decodeHex(s: string): Buffer | undefined {
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return undefined;
  return Buffer.from(s, "hex");
}

/** Constant-time verification of the signature header against the raw body. */
function signatureValid(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const provided = decodeHex(header);
  if (provided === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Routes for webhook-triggered node flows: `POST /:resourceId`.
 *
 * Mount under the path of your choice: `app.route("/api/webhooks", webhookTriggerRoutes(...))`.
 */
export function webhookTriggerRoutes(opts: WebhookTriggerOptions): Hono {
  const flowIdPrefix = opts.flowIdPrefix ?? "wh";
  const app = new Hono();

  app.post("/:resourceId", async (c) => {
    const resourceId = c.req.param("resourceId");
    const config = await opts.resolve(resourceId);
    if (config === undefined) {
      return c.json({ error: `Webhook not found: ${resourceId}` }, 404);
    }

    // Read the raw body exactly once — the same bytes are used for signature
    // verification and (only after it passes) JSON parsing.
    const bodyBytes = Buffer.from(await c.req.arrayBuffer());

    if (config.secret !== undefined && !signatureValid(config.secret, bodyBytes, c.req.header(WEBHOOK_SIGNATURE_HEADER))) {
      return c.json({ error: "Missing or invalid webhook signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyBytes.toString("utf-8"));
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const initialContext: Record<string, unknown> = {
      webhook: { resourceId: config.resourceId, payload },
      ...config.metadata,
    };

    const flowId = `${flowIdPrefix}-${config.resourceId}-${randomUUID().slice(0, 8)}`;
    const result = await opts.runtime.ask(
      EntityId(flowId),
      { tag: "start_flow", flowDef: config.flowDef, initialContext } satisfies NodeFlowCommand,
      opts.cat,
    );

    if (result.ok) {
      const reply = result.value.reply;
      if (reply?.tag === "acknowledged") {
        // The generated entity id, not reply.flowId (the flow DEFINITION id) —
        // this is the handle a caller can query state with.
        return c.json({ flowId, status: "triggered" });
      }
      if (reply?.tag === "error") {
        return c.json({ error: reply.message }, 400);
      }
    }
    return c.json({ error: "Unexpected reply" }, 500);
  });

  return app;
}
