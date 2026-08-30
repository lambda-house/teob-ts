import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { HealthCheck, AggregatedHealth } from "./health-check.js";
import { HealthStatus, aggregateHealth } from "./health-check.js";

/** Startup phase for probe gating. */
export type StartupPhase = "Starting" | "Ready" | "ShuttingDown";

/** Configuration for probe server. */
export interface ProbeServerConfig {
  host: string;
  port: number;
}

export const defaultProbeServerConfig: ProbeServerConfig = {
  host: "0.0.0.0",
  port: 9095,
};

/** Probe server state and control. */
export interface ProbeServerControl {
  markReady(): void;
  markShuttingDown(): void;
  phase(): StartupPhase;
  close(): Promise<void>;
}

/**
 * Create a probe server with Kubernetes-compatible health endpoints:
 *   /startup  — 200 once ready, 503 while starting
 *   /alive    — Liveness probe with health checks
 *   /ready    — Readiness probe with health checks
 *   /metrics  — Metrics export (if metricsExporter provided)
 */
export function createProbeServer(
  config: ProbeServerConfig,
  healthChecks: HealthCheck[],
  metricsExporter?: () => Promise<string>,
): ProbeServerControl {
  let currentPhase: StartupPhase = "Starting";

  const app = new Hono();

  function healthToJson(health: AggregatedHealth): unknown {
    const components: Record<string, unknown> = {};
    for (const [name, status] of Object.entries(health.components)) {
      const entry: Record<string, unknown> = { status: HealthStatus.label(status) };
      if ("reason" in status) entry.reason = status.reason;
      components[name] = entry;
    }
    return {
      status: HealthStatus.label(health.overall),
      components,
    };
  }

  app.get("/startup", (c) => {
    if (currentPhase === "Ready") {
      return c.json({ status: "ready" }, 200);
    }
    return c.json({ status: currentPhase === "Starting" ? "starting" : "shutting_down" }, 503);
  });

  app.get("/alive", async (c) => {
    if (currentPhase !== "Ready") {
      return c.json({ status: currentPhase === "Starting" ? "starting" : "shutting_down" }, 503);
    }
    const health = await aggregateHealth(healthChecks);
    const status = HealthStatus.isHealthy(health.overall) ? 200 : 503;
    return c.json(healthToJson(health), status);
  });

  app.get("/ready", async (c) => {
    if (currentPhase !== "Ready") {
      return c.json({ status: currentPhase === "Starting" ? "starting" : "shutting_down" }, 503);
    }
    const health = await aggregateHealth(healthChecks);
    const status = HealthStatus.isReady(health.overall) ? 200 : 503;
    return c.json(healthToJson(health), status);
  });

  if (metricsExporter) {
    app.get("/metrics", async (c) => {
      const text = await metricsExporter();
      return c.text(text);
    });
  }

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  return {
    markReady() {
      currentPhase = "Ready";
    },
    markShuttingDown() {
      currentPhase = "ShuttingDown";
    },
    phase() {
      return currentPhase;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
