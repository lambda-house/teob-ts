import { describe, it, expect, afterAll } from "vitest";
import { Hono } from "hono";
import { quickstart } from "../src/quickstart/index.js";
import { aggregate } from "../src/quickstart/index.js";
import { persist } from "../src/core/effect.js";
import { buildService, type ServiceTemplate, type RunningService } from "../src/service/index.js";

type Cmd = { tag: "Create" };
type Evt = { tag: "Created" };
type State = { created: boolean };

const example = aggregate<Cmd, Evt, State>({
  category: "mw-example",
  initialState: () => ({ created: false }),
  decide: async () => persist({ tag: "Created" }),
  apply: () => ({ created: true }),
});

function requireToken(routes: Hono): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== "Bearer sesame") {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.route("/", routes);
  return app;
}

describe("quickstart routeMiddleware", () => {
  const servers: Array<{ close(cb: () => void): void }> = [];
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("wraps the whole route tree", async () => {
    const { app, server } = quickstart({
      aggregates: [example],
      port: 19098,
      routeMiddleware: requireToken,
    });
    servers.push(server);

    const denied = await app.request("/api/mw-example/e1", {
      method: "POST",
      body: JSON.stringify({ tag: "Create" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request("/api/mw-example/e1", {
      method: "POST",
      body: JSON.stringify({ tag: "Create" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer sesame" },
    });
    expect(allowed.status).toBeLessThan(300);
  });
});

describe("ServiceTemplate routeMiddleware", () => {
  let svc: RunningService<Record<string, never>> | undefined;
  afterAll(async () => {
    await svc?.shutdown();
  });

  it("is applied to component routes before the server binds them", async () => {
    const routes = new Hono();
    routes.get("/hello", (c) => c.json({ ok: true }));

    const template: ServiceTemplate<Record<string, never>, Record<string, never>, Record<string, never>, Record<string, never>> = {
      config: {
        probeServer: { host: "127.0.0.1", port: 19099 },
        httpServer: { host: "127.0.0.1", port: 19100 },
      },
      infra: async () => ({}),
      outside: async () => ({}),
      entities: async () => ({}),
      context: async () => ({}),
      componentExports: () => ({ healthChecks: [], routes }),
      routeMiddleware: requireToken,
    };

    svc = await buildService(template);

    const denied = await fetch("http://127.0.0.1:19100/hello");
    expect(denied.status).toBe(401);

    const allowed = await fetch("http://127.0.0.1:19100/hello", {
      headers: { Authorization: "Bearer sesame" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });
  });
});
