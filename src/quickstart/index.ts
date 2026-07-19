// quickstart — zero-config wiring for getting started fast

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CategoryId, type EntityId } from "../core/types.js";
import type { Effect } from "../core/effect.js";
import type { EffectControl } from "../core/effect-control.js";
import { categoryTypes } from "../core/effect-control.js";
import type { Aggregate } from "../core/aggregate.js";
import { tagCodec, objectCodec } from "../core/codec.js";
import { createInMemoryRuntime, registration } from "../inmem/runtime.js";
import { allAggregateRoutes, type AggregateRouteOptions } from "../http/aggregate-routes.js";

// --- Simplified aggregate definition ---

/** Simplified aggregate config — no separate codec definitions needed. */
export interface AggregateConfig<
  Command extends { tag: string },
  Event extends { tag: string },
  State,
  Reply extends { tag: string } | void = void,
> {
  category: string;
  initialState: () => State;
  decide: (
    state: State,
    command: Command,
    ctx: EffectControl<Command, Reply extends void ? never : Reply>,
  ) => Promise<Effect<Event, Reply extends void ? never : Reply>>;
  apply: (state: State, event: Event) => State;
}

/**
 * Define an aggregate with minimal boilerplate.
 * Codecs are auto-derived from `tag` fields — no manual codec wiring.
 */
export function aggregate<
  Command extends { tag: string },
  Event extends { tag: string },
  State,
  Reply extends { tag: string } | void = void,
>(config: AggregateConfig<Command, Event, State, Reply>) {
  return config;
}

// --- Quickstart server ---

/** Options for the quickstart server. */
export interface QuickstartOptions {
  /** Aggregate definitions created via `aggregate()`. */
  aggregates: AggregateConfig<any, any, any, any>[];
  /** Port to listen on. Defaults to 3000. */
  port?: number;
  /** Host to bind to. Defaults to "localhost". */
  host?: string;
  /** Base path for routes. Defaults to "/api". */
  basePath?: string;
  /** Route options (rejectTag, etag). */
  routeOptions?: AggregateRouteOptions;
}

/**
 * Start a fully wired event-sourced HTTP API with zero infrastructure.
 *
 * - Creates an in-memory runtime
 * - Auto-derives codecs from `tag` fields
 * - Generates REST endpoints: `POST {basePath}/{category}/{entityId}`
 * - Starts an HTTP server
 *
 * ```ts
 * quickstart({ aggregates: [counter], port: 3000 })
 * ```
 */
export function quickstart(opts: QuickstartOptions) {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "localhost";
  const basePath = opts.basePath ?? "/api";

  // Build registrations with auto-derived codecs
  const registrations = opts.aggregates.map((config) => {
    const agg: Aggregate<any, any, any, any> = {
      category: CategoryId(config.category),
      initial: (_id: EntityId) => config.initialState(),
      decide: config.decide as any,
      apply: config.apply,
    };
    return registration(agg, tagCodec(), objectCodec("State"));
  });

  const { runtime } = createInMemoryRuntime(registrations);

  // Build category registrations for HTTP routes
  const categories = opts.aggregates.map((config) =>
    categoryTypes(CategoryId(config.category)),
  );

  // Wire Hono app
  const app = new Hono();
  app.route(basePath, allAggregateRoutes(runtime, categories, opts.routeOptions));

  // Log available routes
  const routes = opts.aggregates.map(
    (config) => `  POST ${basePath}/${config.category}/:entityId`,
  );
  console.log(`\nTEOB Quickstart — available routes:\n${routes.join("\n")}\n`);

  // Start server
  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`Listening on http://${host}:${port}`);
  });

  return { app, runtime, server };
}
