import type { HealthCheck } from "./health-check.js";
import type { LifecycleLogger, LifecyclePhase } from "./lifecycle.js";
import { createLifecycleLogger } from "./lifecycle.js";
import type { ProbeServerConfig, ProbeServerControl } from "./probe-server.js";
import { createProbeServer, defaultProbeServerConfig } from "./probe-server.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

/** Configuration for the service template. */
export interface ServiceConfig {
  probeServer: ProbeServerConfig;
  httpServer?: HttpServerConfig;
}

/** Configuration for the component HTTP server (separate from probe server). */
export interface HttpServerConfig {
  host: string;
  port: number;
}

export const defaultServiceConfig: ServiceConfig = {
  probeServer: defaultProbeServerConfig,
};

/** Running service with access to context and probe control. */
export interface RunningService<Context> {
  context: Context;
  probeControl: ProbeServerControl;
  /** Shut down the service in reverse layer order. */
  shutdown(): Promise<void>;
}

/** Component exports collected during service build. */
export interface ComponentExports {
  healthChecks: HealthCheck[];
  routes?: Hono;
}

export const emptyComponentExports: ComponentExports = { healthChecks: [] };

/**
 * Service template with layered lifecycle management.
 *
 * Layers are initialized in order:
 *   1. Infra — persistence connections, metrics registry
 *   2. Outside — views and external dependencies
 *   3. Entities — primary entity runtime
 *   4. Context — final composition
 *
 * Shutdown happens in reverse order.
 */
export interface ServiceTemplate<Infra, Outside, Entities, Context> {
  config?: ServiceConfig;

  /** Infrastructure layer. */
  infra(): Promise<Infra>;
  /** Outside layer. */
  outside(infra: Infra): Promise<Outside>;
  /** Entities layer. */
  entities(infra: Infra, outside: Outside): Promise<Entities>;
  /** Context layer. */
  context(infra: Infra, outside: Outside, entities: Entities): Promise<Context>;

  /** Collect health checks and routes from components. */
  componentExports?(
    infra: Infra,
    outside: Outside,
    entities: Entities,
    context: Context,
  ): ComponentExports;

  /**
   * Wrap the entire component route tree before it is bound to the HTTP
   * server. The routes the framework generates — command dispatch and any
   * journal-exposing read routes the application mounts — are served with NO
   * authentication by default; this is the seam to add it:
   *
   * ```ts
   * routeMiddleware(routes) {
   *   const app = new Hono();
   *   app.use("*", myAuthMiddleware);
   *   app.route("/", routes);
   *   return app;
   * }
   * ```
   *
   * To apply a stricter policy to a subset only, wrap that subset where it is
   * composed in `componentExports` instead.
   */
  routeMiddleware?(routes: Hono): Hono;

  /** Provide health checks from the infra layer. */
  infraHealthChecks?(infra: Infra): HealthCheck[];

  /** Provide a metrics export function for the probe server. */
  metricsExporter?(infra: Infra): () => Promise<string>;

  /** Teardown functions per layer (called in reverse order on shutdown). */
  teardownInfra?(infra: Infra): Promise<void>;
  teardownOutside?(outside: Outside): Promise<void>;
  teardownEntities?(entities: Entities): Promise<void>;
  teardownContext?(context: Context): Promise<void>;
}

/**
 * Build and start a service from a template.
 *
 * Returns a RunningService with the context and a shutdown function.
 */
export async function buildService<Infra, Outside, Entities, Context>(
  template: ServiceTemplate<Infra, Outside, Entities, Context>,
  logger?: LifecycleLogger,
): Promise<RunningService<Context>> {
  const log = logger ?? createLifecycleLogger();
  const config = template.config ?? defaultServiceConfig;
  const teardowns: Array<() => Promise<void>> = [];

  async function initPhase<T>(
    phase: LifecyclePhase,
    init: () => Promise<T>,
    teardown?: (val: T) => Promise<void>,
  ): Promise<T> {
    log.starting(phase);
    const start = Date.now();
    const value = await init();
    log.started(phase, Date.now() - start);
    if (teardown) {
      teardowns.unshift(async () => {
        log.stopping(phase);
        await teardown(value);
        log.stopped(phase);
      });
    }
    return value;
  }

  // Layer 1: Infra
  const infra = await initPhase("Infra", () => template.infra(), template.teardownInfra);

  // Start probe server immediately (available during startup)
  const infraChecks = template.infraHealthChecks?.(infra) ?? [];
  let allHealthChecks = [...infraChecks];
  const metricsExporter = template.metricsExporter?.(infra);
  const probeControl = createProbeServer(config.probeServer, allHealthChecks, metricsExporter);
  teardowns.unshift(() => probeControl.close());

  // Layer 2: Outside
  const outside = await initPhase("Outside", () => template.outside(infra), template.teardownOutside);

  // Layer 3: Entities
  const entities = await initPhase(
    "Entities",
    () => template.entities(infra, outside),
    template.teardownEntities,
  );

  // Layer 4: Context
  const context = await initPhase(
    "Context",
    () => template.context(infra, outside, entities),
    template.teardownContext,
  );

  // Collect component exports
  const exports = template.componentExports?.(infra, outside, entities, context) ?? emptyComponentExports;
  allHealthChecks = [...infraChecks, ...exports.healthChecks];

  // Update probe server health checks (mutate the array the probe server references)
  // Since we passed the array reference, we need to rebuild the probe server or update
  // We'll update the health checks list in place
  allHealthChecks.splice(0, allHealthChecks.length, ...infraChecks, ...exports.healthChecks);

  // Start component HTTP server if configured
  let httpServer: ReturnType<typeof serve> | undefined;
  if (config.httpServer && exports.routes) {
    const routes = template.routeMiddleware?.(exports.routes) ?? exports.routes;
    httpServer = serve({
      fetch: routes.fetch,
      hostname: config.httpServer.host,
      port: config.httpServer.port,
    });
    teardowns.unshift(() => new Promise<void>((resolve) => httpServer!.close(() => resolve())));
  }

  // Mark ready
  probeControl.markReady();
  log.serviceReady();

  return {
    context,
    probeControl,
    async shutdown() {
      probeControl.markShuttingDown();
      for (const teardown of teardowns) {
        await teardown();
      }
      log.serviceShutdown();
    },
  };
}
