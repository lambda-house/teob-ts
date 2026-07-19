import { describe, it, expect, afterAll } from "vitest";
import {
  HealthStatus,
  simpleHealthCheck,
  aggregateHealth,
  createLifecycleLogger,
  noopLifecycleLogger,
  buildService,
} from "../src/service/index.js";
import type { ServiceTemplate, RunningService } from "../src/service/index.js";

describe("HealthStatus", () => {
  it("should identify healthy statuses", () => {
    expect(HealthStatus.isHealthy(HealthStatus.Healthy)).toBe(true);
    expect(HealthStatus.isHealthy(HealthStatus.Degraded("slow"))).toBe(true);
    expect(HealthStatus.isHealthy(HealthStatus.Unhealthy("down"))).toBe(false);
    expect(HealthStatus.isHealthy(HealthStatus.Unknown("?"))).toBe(false);
  });

  it("should combine statuses — worst wins", () => {
    expect(HealthStatus.combine([HealthStatus.Healthy, HealthStatus.Healthy])).toEqual(HealthStatus.Healthy);

    const combined = HealthStatus.combine([HealthStatus.Healthy, HealthStatus.Degraded("slow")]);
    expect(combined.tag).toBe("Degraded");

    const combined2 = HealthStatus.combine([HealthStatus.Degraded("slow"), HealthStatus.Unhealthy("down")]);
    expect(combined2.tag).toBe("Unhealthy");
  });

  it("should produce correct labels", () => {
    expect(HealthStatus.label(HealthStatus.Healthy)).toBe("healthy");
    expect(HealthStatus.label(HealthStatus.Degraded("x"))).toBe("degraded");
    expect(HealthStatus.label(HealthStatus.Unhealthy("x"))).toBe("unhealthy");
    expect(HealthStatus.label(HealthStatus.Unknown("x"))).toBe("unknown");
  });
});

describe("simpleHealthCheck", () => {
  it("should create a health check that returns status", async () => {
    const hc = simpleHealthCheck("test-db", async () => HealthStatus.Healthy);
    const result = await hc.check();
    expect(result.name).toBe("test-db");
    expect(result.status).toEqual(HealthStatus.Healthy);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});

describe("aggregateHealth", () => {
  it("should aggregate multiple checks", async () => {
    const checks = [
      simpleHealthCheck("db", async () => HealthStatus.Healthy),
      simpleHealthCheck("cache", async () => HealthStatus.Degraded("slow")),
    ];

    const health = await aggregateHealth(checks);
    expect(health.overall.tag).toBe("Degraded");
    expect(health.components["db"]).toEqual(HealthStatus.Healthy);
    expect(health.components["cache"].tag).toBe("Degraded");
  });

  it("should return healthy for empty checks", async () => {
    const health = await aggregateHealth([]);
    expect(health.overall).toEqual(HealthStatus.Healthy);
  });
});

describe("LifecycleLogger", () => {
  it("should create console logger without errors", () => {
    const logger = createLifecycleLogger("TEST");
    // Just verify it doesn't throw
    logger.starting("Infra");
    logger.started("Infra", 42);
    logger.stopping("Infra");
    logger.stopped("Infra");
    logger.serviceReady();
    logger.serviceShutdown();
  });

  it("should create noop logger", () => {
    const logger = noopLifecycleLogger();
    logger.starting("Infra");
    logger.serviceReady();
  });
});

describe("ServiceTemplate", () => {
  const services: Array<RunningService<unknown>> = [];

  afterAll(async () => {
    for (const svc of services) {
      await svc.shutdown();
    }
  });

  it("should build service with layered lifecycle", async () => {
    const order: string[] = [];

    const template: ServiceTemplate<string, string, string, string> = {
      config: {
        probeServer: { host: "127.0.0.1", port: 19095 },
      },
      async infra() {
        order.push("infra:init");
        return "infra-value";
      },
      async outside(infra) {
        order.push(`outside:init(${infra})`);
        return "outside-value";
      },
      async entities(infra, outside) {
        order.push(`entities:init(${infra},${outside})`);
        return "entities-value";
      },
      async context(infra, outside, entities) {
        order.push(`context:init(${infra},${outside},${entities})`);
        return "context-value";
      },
      async teardownContext() { order.push("context:teardown"); },
      async teardownEntities() { order.push("entities:teardown"); },
      async teardownOutside() { order.push("outside:teardown"); },
      async teardownInfra() { order.push("infra:teardown"); },
    };

    const svc = await buildService(template, noopLifecycleLogger());
    services.push(svc);

    expect(svc.context).toBe("context-value");
    expect(svc.probeControl.phase()).toBe("Ready");

    // Verify init order
    expect(order).toEqual([
      "infra:init",
      "outside:init(infra-value)",
      "entities:init(infra-value,outside-value)",
      "context:init(infra-value,outside-value,entities-value)",
    ]);

    // Shutdown and verify reverse order
    await svc.shutdown();
    services.pop();

    expect(order.slice(4)).toEqual([
      "context:teardown",
      "entities:teardown",
      "outside:teardown",
      "infra:teardown",
    ]);
  });

  it("should include health checks from infra and components", async () => {
    const template: ServiceTemplate<string, string, string, string> = {
      config: {
        probeServer: { host: "127.0.0.1", port: 19096 },
      },
      async infra() { return "infra"; },
      async outside() { return "outside"; },
      async entities() { return "entities"; },
      async context() { return "context"; },
      infraHealthChecks() {
        return [simpleHealthCheck("db", async () => HealthStatus.Healthy)];
      },
      componentExports() {
        return {
          healthChecks: [simpleHealthCheck("cache", async () => HealthStatus.Healthy)],
        };
      },
    };

    const svc = await buildService(template, noopLifecycleLogger());
    services.push(svc);

    // Probe server should be ready
    expect(svc.probeControl.phase()).toBe("Ready");

    // Verify probe endpoints work
    const startupResp = await fetch("http://127.0.0.1:19096/startup");
    expect(startupResp.status).toBe(200);

    const aliveResp = await fetch("http://127.0.0.1:19096/alive");
    expect(aliveResp.status).toBe(200);
    const aliveBody = await aliveResp.json() as Record<string, unknown>;
    expect(aliveBody.status).toBe("healthy");

    await svc.shutdown();
    services.pop();
  });

  it("should return 503 before ready", async () => {
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const template: ServiceTemplate<string, string, string, string> = {
      config: {
        probeServer: { host: "127.0.0.1", port: 19097 },
      },
      async infra() { return "infra"; },
      async outside() { return "outside"; },
      async entities() { return "entities"; },
      async context() {
        await readyPromise;
        return "context";
      },
    };

    // Start building in background
    const buildPromise = buildService(template, noopLifecycleLogger());

    // Give the probe server time to start (infra completes quickly)
    await new Promise((r) => setTimeout(r, 100));

    // Probe should return 503 while context is pending
    const resp = await fetch("http://127.0.0.1:19097/startup");
    expect(resp.status).toBe(503);

    // Let context complete
    resolveReady!();
    const svc = await buildPromise;
    services.push(svc);

    // Now probe should return 200
    const resp2 = await fetch("http://127.0.0.1:19097/startup");
    expect(resp2.status).toBe(200);

    await svc.shutdown();
    services.pop();
  });
});
