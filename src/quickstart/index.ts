// quickstart — zero-config wiring for getting started fast

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { CategoryId, type EntityId } from "../core/types.js";
import type { Effect } from "../core/effect.js";
import type { EffectControl } from "../core/effect-control.js";
import { categoryTypes } from "../core/effect-control.js";
import type { Aggregate } from "../core/aggregate.js";
import type { Codec } from "../core/codec.js";
import { tagCodec, objectCodec } from "../core/codec.js";
import type { EntityRuntime } from "../core/runtime.js";
import type { CategoryEventSource } from "../core/event-source.js";
import { createInMemoryRuntime, registration } from "../inmem/runtime.js";
import { createInMemoryJournal, type InMemoryJournal } from "../inmem/journal.js";
import { createSqliteRuntime } from "../sqlite/index.js";
import type { SqliteJournal } from "../sqlite/journal.js";
import { allAggregateRoutes, type AggregateRouteOptions } from "../http/aggregate-routes.js";
import {
  createInMemorySagaStore,
  createSqliteSagaStore,
  runTailingSaga,
  runTailingStatefulSaga,
  type SagaDefinition,
  type StatefulSagaDefinition,
} from "../saga/index.js";

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

/** Where quickstart persists events: in memory (lost on restart) or SQLite. */
export type QuickstartPersistence = { mode: "inmem" } | { mode: "sqlite"; path: string };

/** A saga registered with quickstart — stateless or stateful. */
export type QuickSaga = SagaDefinition<any> | StatefulSagaDefinition<any>;

/** Options for the quickstart server. */
export interface QuickstartOptions {
  /** Aggregate definitions created via `aggregate()`. */
  aggregates: AggregateConfig<any, any, any, any>[];
  /**
   * Sagas run as supervised background loops over a live event source and an
   * offset store MATCHED to the persistence mode: in-memory tail + ephemeral
   * offsets (a restart re-processes), or sqlite tail + durable offsets in the
   * same database file (a restart resumes rather than re-firing).
   */
  sagas?: QuickSaga[];
  /** Persistence mode. Defaults to in-memory. */
  persistence?: QuickstartPersistence;
  /** Port to listen on. Defaults to 3000. */
  port?: number;
  /** Host to bind to. Defaults to "localhost". */
  host?: string;
  /** Base path for routes. Defaults to "/api". */
  basePath?: string;
  /** Route options (rejectTag, etag). */
  routeOptions?: AggregateRouteOptions;
  /**
   * Wrap the whole route tree before the server binds it — the generated
   * command routes are unauthenticated by default, and this is the seam to
   * change that (mirror of ServiceTemplate.routeMiddleware).
   */
  routeMiddleware?: (app: Hono) => Hono;
  /** Poll interval for the saga event tails (sqlite mode). Default 250ms. */
  sagaPollIntervalMs?: number;
}

export interface QuickstartHandle {
  app: Hono;
  runtime: EntityRuntime;
  journal: InMemoryJournal | SqliteJournal;
  server: ReturnType<typeof serve>;
  /** Stop sagas, close the server, shut down the runtime, close the journal. */
  stop(): Promise<void>;
}

function isStateful(s: QuickSaga): s is StatefulSagaDefinition<any> {
  return "steps" in s;
}

function sagaCategories(s: QuickSaga): string[] {
  return isStateful(s) ? s.steps.map((step) => step.from) : [s.from];
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
export function quickstart(opts: QuickstartOptions): QuickstartHandle {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "localhost";
  const basePath = opts.basePath ?? "/api";
  const persistence = opts.persistence ?? { mode: "inmem" as const };

  // Build registrations with auto-derived codecs; the same codec instances
  // feed the saga event source.
  const eventCodecs = new Map<string, Codec<any>>();
  const registrations = opts.aggregates.map((config) => {
    const agg: Aggregate<any, any, any, any> = {
      category: CategoryId(config.category),
      initial: (_id: EntityId) => config.initialState(),
      decide: config.decide as any,
      apply: config.apply,
    };
    const eventCodec = tagCodec();
    eventCodecs.set(config.category, eventCodec);
    return registration(agg, eventCodec, objectCodec("State"));
  });

  // Validate saga subscriptions at wiring time — an unknown category would
  // otherwise fail only when its first event never arrives.
  for (const s of opts.sagas ?? []) {
    for (const category of sagaCategories(s)) {
      if (!eventCodecs.has(category)) {
        throw new Error(
          `Saga '${s.name}' subscribes to unknown category '${category}' — no aggregate registers it`,
        );
      }
    }
  }

  // Persistence-matched runtime, journal, and saga offset store.
  let runtime: EntityRuntime;
  let journal: InMemoryJournal | SqliteJournal;
  let sagaStore = createInMemorySagaStore();
  if (persistence.mode === "sqlite") {
    const handle = createSqliteRuntime({ path: persistence.path }, registrations);
    runtime = handle.runtime;
    journal = handle.journal;
    // Durable offsets in the same file: a restart resumes, never re-fires.
    sagaStore = createSqliteSagaStore(handle.journal.db);
  } else {
    const inmemJournal = createInMemoryJournal();
    runtime = createInMemoryRuntime(registrations, { journal: inmemJournal }).runtime;
    journal = inmemJournal;
  }

  // Build category registrations for HTTP routes
  const categories = opts.aggregates.map((config) =>
    categoryTypes(CategoryId(config.category)),
  );

  // Wire Hono app
  let app = new Hono();
  app.route(basePath, allAggregateRoutes(runtime, categories, opts.routeOptions));
  app = opts.routeMiddleware?.(app) ?? app;

  // Saga background loops over a live tail of the same journal.
  const sagaAbort = new AbortController();
  const sagaRuns: Promise<void>[] = [];
  if ((opts.sagas ?? []).length > 0) {
    const source: CategoryEventSource = journal.categoryEventSource(eventCodecs, {
      pollIntervalMs: opts.sagaPollIntervalMs ?? 250,
      signal: sagaAbort.signal,
    });
    for (const s of opts.sagas ?? []) {
      const run = isStateful(s)
        ? runTailingStatefulSaga(s, source, runtime, sagaStore, { signal: sagaAbort.signal })
        : runTailingSaga(s, source, runtime, sagaStore, { signal: sagaAbort.signal });
      // A crashed saga loop must not surface as an unhandled rejection.
      sagaRuns.push(run.catch((err) => console.error(`[quickstart] saga '${s.name}' crashed:`, err)));
    }
  }

  // Log available routes and wiring
  const routes = opts.aggregates.map(
    (config) => `  POST ${basePath}/${config.category}/:entityId`,
  );
  const sagaLine =
    (opts.sagas ?? []).length > 0 ? `\nSagas: ${(opts.sagas ?? []).map((s) => s.name).join(", ")}` : "";
  console.log(
    `\nTEOB Quickstart [persistence: ${persistence.mode}] — available routes:\n${routes.join("\n")}${sagaLine}\n`,
  );

  // Start server
  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`Listening on http://${host}:${port}`);
  });

  return {
    app,
    runtime,
    journal,
    server,
    async stop() {
      sagaAbort.abort();
      await Promise.all(sagaRuns);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
      if ("close" in journal && typeof journal.close === "function") journal.close();
    },
  };
}
