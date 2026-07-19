import { describe, it, expect } from "vitest";
import { aggregate, quickstart } from "../src/quickstart/index.js";
import { persist, reply, done, andReply } from "../src/core/effect.js";

// --- Test aggregates ---

type CounterCommand =
  | { tag: "Increment" }
  | { tag: "Decrement" }
  | { tag: "GetCount" };

type CounterEvent =
  | { tag: "Incremented" }
  | { tag: "Decremented" };

type CounterState = { count: number };

type CounterReply = { tag: "Count"; count: number };

const counter = aggregate<CounterCommand, CounterEvent, CounterState, CounterReply>({
  category: "counter",
  initialState: () => ({ count: 0 }),
  decide: async (state, command) => {
    switch (command.tag) {
      case "Increment":
        return andReply(persist({ tag: "Incremented" }), { tag: "Count", count: state.count + 1 });
      case "Decrement":
        return andReply(persist({ tag: "Decremented" }), { tag: "Count", count: state.count - 1 });
      case "GetCount":
        return reply({ tag: "Count", count: state.count });
    }
  },
  apply: (state, event) => {
    switch (event.tag) {
      case "Incremented":
        return { count: state.count + 1 };
      case "Decremented":
        return { count: state.count - 1 };
    }
  },
});

// No-reply aggregate (void reply)
type TodoCommand = { tag: "Add"; text: string };
type TodoEvent = { tag: "Added"; text: string };
type TodoState = { items: string[] };

const todo = aggregate<TodoCommand, TodoEvent, TodoState>({
  category: "todo",
  initialState: () => ({ items: [] }),
  decide: async (_state, command) => {
    switch (command.tag) {
      case "Add":
        return persist({ tag: "Added", text: command.text });
    }
  },
  apply: (state, event) => {
    switch (event.tag) {
      case "Added":
        return { items: [...state.items, event.text] };
    }
  },
});

// --- Tests ---

describe("aggregate() helper", () => {
  it("creates an aggregate config object", () => {
    expect(counter.category).toBe("counter");
    expect(counter.initialState()).toEqual({ count: 0 });
  });

  it("supports void reply aggregates", () => {
    expect(todo.category).toBe("todo");
    expect(todo.initialState()).toEqual({ items: [] });
  });
});

describe("quickstart()", () => {
  it("starts a server and handles commands via HTTP", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0, // let OS pick port
    });

    try {
      // Send increment
      const res1 = await app.request("/api/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1).toEqual({ tag: "Count", count: 1 });

      // Query count
      const res2 = await app.request("/api/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "GetCount" }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2).toEqual({ tag: "Count", count: 1 });
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("supports multiple aggregates", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter, todo],
      port: 0,
    });

    try {
      // Counter
      const res1 = await app.request("/api/counter/c1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res1.status).toBe(200);

      // Todo
      const res2 = await app.request("/api/todo/t1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Add", text: "buy milk" }),
      });
      expect(res2.status).toBe(200);
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("unknown category returns 404", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0,
    });

    try {
      const res = await app.request("/api/unknown/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("invalid JSON body returns 400", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0,
    });

    try {
      const res = await app.request("/api/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("returns ETag headers by default", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0,
    });

    try {
      const res = await app.request("/api/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe('"1"');
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("respects custom basePath", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0,
      basePath: "/v1",
    });

    try {
      const res = await app.request("/v1/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("void-reply aggregate returns ok status", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [todo],
      port: 0,
    });

    try {
      const res = await app.request("/api/todo/t1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Add", text: "hello" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "ok" });
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });

  it("respects routeOptions (etag: false)", async () => {
    const { app, runtime, server } = quickstart({
      aggregates: [counter],
      port: 0,
      routeOptions: { etag: false },
    });

    try {
      const res = await app.request("/api/counter/entity-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "Increment" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBeNull();
    } finally {
      await runtime.shutdown();
      server.close();
    }
  });
});
