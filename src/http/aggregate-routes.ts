// aggregate-routes.ts — Auto-generate Hono routes from aggregate CategoryRegistrations

import { Hono } from "hono";
import type { Context } from "hono";
import { EntityId, type SequenceNr } from "../core/types.js";
import type { EntityRuntime } from "../core/runtime.js";
import type { CategoryRegistration, ReplyError } from "../core/effect-control.js";

/** Options for configuring aggregate HTTP routes. */
export interface AggregateRouteOptions {
  /**
   * Reply tag that maps to HTTP 400 Bad Request.
   * Defaults to "Rejected". Set to `false` to disable.
   */
  rejectTag?: string | false;
  /**
   * Enable ETag/If-Match optimistic concurrency.
   * When enabled, responses include an ETag header (entity sequence number),
   * and requests with If-Match are validated against the current version.
   * Defaults to true.
   */
  etag?: boolean;
}

function mapReplyError(error: ReplyError): { status: number; body: unknown } {
  switch (error.tag) {
    case "Timeout":
      return { status: 504, body: { error: "Timeout" } };
    case "CategoryNotFound":
      return { status: 404, body: { error: "CategoryNotFound", categoryId: error.categoryId } };
    case "General":
      return { status: 500, body: { error: error.message } };
  }
}

/** Parse If-Match header. Returns { value } for valid, { invalid: true } for unparseable, undefined if absent. */
function parseIfMatch(c: Context): { value: number } | { invalid: true } | undefined {
  const header = c.req.header("If-Match");
  if (!header) return undefined;
  // Strip quotes: "42" → 42
  const raw = header.replace(/^"(.*)"$/, "$1");
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return { invalid: true };
  return { value: n };
}

function setETag(c: Context, sequenceNr: SequenceNr): void {
  c.header("ETag", `"${sequenceNr}"`);
}

async function handleCommand(
  c: Context,
  runtime: EntityRuntime,
  category: CategoryRegistration<any, any>,
  entityId: string,
  rejectTag: string | false,
  useEtag: boolean,
): Promise<Response> {
  const eid = EntityId(entityId);

  let command: unknown;
  try {
    command = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!command || typeof command !== "object" || !("tag" in command)) {
    return c.json({ error: 'Command must have a "tag" field' }, 400);
  }

  const result = await runtime.ask(eid, command, category);

  if (!result.ok) {
    const { status, body } = mapReplyError(result.error);
    return c.json(body, status as any);
  }

  const { reply, meta } = result.value;

  if (useEtag && meta) {
    const ifMatch = parseIfMatch(c);

    if (ifMatch && "invalid" in ifMatch) {
      return c.json({ error: "Invalid If-Match header" }, 400);
    }

    // If-Match check: client expected a specific pre-command version
    if (ifMatch && ifMatch.value !== meta.preSequenceNr) {
      return c.json(
        { error: "Conflict", expected: ifMatch.value, actual: meta.preSequenceNr },
        409,
      );
    }

    setETag(c, meta.sequenceNr);
  }

  if (reply === undefined) {
    return c.json({ status: "ok" }, 200);
  }

  if (rejectTag !== false && typeof reply === "object" && reply !== null && "tag" in reply) {
    if ((reply as any).tag === rejectTag) {
      return c.json(reply, 400);
    }
  }

  return c.json(reply, 200);
}

/**
 * Generate Hono routes for a single aggregate category.
 *
 * Creates:
 * - `POST /:entityId` — send a command (body: `{ tag: "CommandName", ...fields }`)
 *
 * Mount under your desired prefix:
 * ```ts
 * app.route('/api/gift-card', aggregateRoutes(runtime, giftCardCategory))
 * ```
 */
export function aggregateRoutes<C, R>(
  runtime: EntityRuntime,
  category: CategoryRegistration<C, R>,
  opts?: AggregateRouteOptions,
): Hono {
  const rejectTag = opts?.rejectTag ?? "Rejected";
  const useEtag = opts?.etag ?? true;
  const app = new Hono();

  app.post("/:entityId", async (c) => {
    return handleCommand(c, runtime, category, c.req.param("entityId"), rejectTag, useEtag);
  });

  return app;
}

/**
 * Generate Hono routes for multiple aggregate categories.
 *
 * Creates:
 * - `POST /:category/:entityId` — send a command (category matched by categoryId)
 *
 * ```ts
 * app.route('/api', allAggregateRoutes(runtime, [giftCardCategory, todoCategory]))
 * ```
 */
export function allAggregateRoutes(
  runtime: EntityRuntime,
  categories: CategoryRegistration<any, any>[],
  opts?: AggregateRouteOptions,
): Hono {
  const rejectTag = opts?.rejectTag ?? "Rejected";
  const useEtag = opts?.etag ?? true;
  const app = new Hono();

  const categoryMap = new Map<string, CategoryRegistration<any, any>>();
  for (const cat of categories) {
    categoryMap.set(cat.categoryId, cat);
  }

  app.post("/:category/:entityId", async (c) => {
    const categoryId = c.req.param("category");
    const category = categoryMap.get(categoryId);

    if (!category) {
      return c.json({ error: "CategoryNotFound", categoryId }, 404);
    }

    return handleCommand(c, runtime, category, c.req.param("entityId"), rejectTag, useEtag);
  });

  return app;
}
