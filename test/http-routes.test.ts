import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { EntityId } from "../src/core/types.js";
import { createSingleRuntime, createInMemoryRuntime, registration } from "../src/inmem/runtime.js";
import { aggregateRoutes, allAggregateRoutes } from "../src/http/aggregate-routes.js";
import { openApiSchema } from "../src/http/openapi-schema.js";
import { describeAggregate } from "../src/core/describe.js";
import {
  counterAggregate,
  counterEventCodec,
  counterStateCodec,
  counterCommandCodec,
  counterReplyCodec,
  counterCategory,
} from "./example/counter.js";
import {
  giftCardAggregate,
  giftCardEventCodec,
  giftCardStateCodec,
  giftCardCategory,
} from "../showcase/server/domains/gift-card/aggregate.js";
import {
  batchCounterAggregate,
  batchCounterEventCodec,
  batchCounterStateCodec,
  batchCounterCommandCodec,
  batchCounterReplyCodec,
  batchCounterCategory,
} from "./fixtures/batch-counter.js";

// -- helpers --

function post(app: Hono, path: string, body: unknown, headers?: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// -- aggregateRoutes --

describe("aggregateRoutes", () => {
  it("dispatches a command and returns reply", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: "Ok" });
    await runtime.shutdown();
  });

  it("returns query replies", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    await post(app, "/counter/c1", { tag: "Increment", amount: 7 });
    const res = await post(app, "/counter/c1", { tag: "GetValue" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: "Value", value: 7 });
    await runtime.shutdown();
  });

  it("returns 400 for rejected commands", async () => {
    const { runtime } = createSingleRuntime(giftCardAggregate, giftCardEventCodec, giftCardStateCodec);
    const app = new Hono();
    app.route("/gift-card", aggregateRoutes(runtime, giftCardCategory));

    const res = await post(app, "/gift-card/gc1", { tag: "Redeem", amount: 10 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.tag).toBe("Rejected");
    expect(body.reason).toBe("Card is not active");
    await runtime.shutdown();
  });

  it("returns 400 for missing tag field", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await post(app, "/counter/c1", { amount: 5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("tag");
    await runtime.shutdown();
  });

  it("returns 400 for invalid JSON", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await app.request("/counter/c1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    await runtime.shutdown();
  });

  it("returns 400 for empty body", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await app.request("/counter/c1", { method: "POST" });
    expect(res.status).toBe(400);
    await runtime.shutdown();
  });

  it("supports custom rejectTag", async () => {
    const { runtime } = createSingleRuntime(giftCardAggregate, giftCardEventCodec, giftCardStateCodec);
    const app = new Hono();
    app.route("/gift-card", aggregateRoutes(runtime, giftCardCategory, { rejectTag: "Error" }));

    const res = await post(app, "/gift-card/gc1", { tag: "Redeem", amount: 10 });
    expect(res.status).toBe(200); // "Rejected" doesn't match "Error"
    expect((await res.json()).tag).toBe("Rejected");
    await runtime.shutdown();
  });

  it("supports disabling rejectTag", async () => {
    const { runtime } = createSingleRuntime(giftCardAggregate, giftCardEventCodec, giftCardStateCodec);
    const app = new Hono();
    app.route("/gift-card", aggregateRoutes(runtime, giftCardCategory, { rejectTag: false }));

    const res = await post(app, "/gift-card/gc1", { tag: "Redeem", amount: 10 });
    expect(res.status).toBe(200);
    await runtime.shutdown();
  });

  it("returns { status: 'ok' } for commands with no reply (Done effect)", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);
    const app = new Hono();
    app.route("/batch", aggregateRoutes(runtime, batchCounterCategory));

    const res = await post(app, "/batch/b1", { tag: "Noop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    await runtime.shutdown();
  });
});

// -- ETag / If-Match --

describe("ETag support", () => {
  it("returns ETag header on response", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 5 });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    await runtime.shutdown();
  });

  it("ETag increments with events", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const r1 = await post(app, "/counter/c1", { tag: "Increment", amount: 1 });
    expect(r1.headers.get("ETag")).toBe('"1"');

    const r2 = await post(app, "/counter/c1", { tag: "Increment", amount: 2 });
    expect(r2.headers.get("ETag")).toBe('"2"');

    const r3 = await post(app, "/counter/c1", { tag: "Decrement", amount: 1 });
    expect(r3.headers.get("ETag")).toBe('"3"');
    await runtime.shutdown();
  });

  it("ETag jumps by event count for multi-event persist", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);
    const app = new Hono();
    app.route("/batch", aggregateRoutes(runtime, batchCounterCategory));

    // IncrementTwice emits 2 events → seqNr jumps to 2
    const r1 = await post(app, "/batch/b1", { tag: "IncrementTwice", amount: 5 });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("ETag")).toBe('"2"');

    // IncrementThrice emits 3 events → seqNr jumps to 5
    const r2 = await post(app, "/batch/b1", { tag: "IncrementThrice", amount: 3 });
    expect(r2.headers.get("ETag")).toBe('"5"');

    // Verify state: 2*5 + 3*3 = 19
    const r3 = await post(app, "/batch/b1", { tag: "GetValue" });
    expect(await r3.json()).toEqual({ tag: "Value", value: 19 });
    expect(r3.headers.get("ETag")).toBe('"5"'); // no new events
    await runtime.shutdown();
  });

  it("read-only query returns ETag at current sequence", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    await post(app, "/counter/c1", { tag: "Increment", amount: 5 });
    await post(app, "/counter/c1", { tag: "Increment", amount: 3 });

    const res = await post(app, "/counter/c1", { tag: "GetValue" });
    expect(res.headers.get("ETag")).toBe('"2"');
    expect(await res.json()).toEqual({ tag: "Value", value: 8 });
    await runtime.shutdown();
  });

  it("rejected command does not advance ETag", async () => {
    const { runtime } = createSingleRuntime(giftCardAggregate, giftCardEventCodec, giftCardStateCodec);
    const app = new Hono();
    app.route("/gift-card", aggregateRoutes(runtime, giftCardCategory));

    // Issue card → seqNr = 1
    const r1 = await post(app, "/gift-card/gc1", { tag: "Issue", amount: 100 });
    expect(r1.headers.get("ETag")).toBe('"1"');

    // Reject: issue again → no events, seqNr stays 1
    const r2 = await post(app, "/gift-card/gc1", { tag: "Issue", amount: 50 });
    expect(r2.status).toBe(400);
    expect(r2.headers.get("ETag")).toBe('"1"');
    await runtime.shutdown();
  });

  it("ETag on Done effect (no reply, no events)", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);
    const app = new Hono();
    app.route("/batch", aggregateRoutes(runtime, batchCounterCategory));

    const res = await post(app, "/batch/b1", { tag: "Noop" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"0"'); // no events ever persisted
    await runtime.shutdown();
  });

  it("If-Match succeeds when version matches", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    await post(app, "/counter/c1", { tag: "Increment", amount: 5 });

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 3 }, { "If-Match": '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"2"');
    await runtime.shutdown();
  });

  it("If-Match returns 409 when version mismatches", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    await post(app, "/counter/c1", { tag: "Increment", amount: 5 });

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 3 }, { "If-Match": '"0"' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Conflict");
    expect(body.expected).toBe(0);
    expect(body.actual).toBe(1);
    await runtime.shutdown();
  });

  it("If-Match: '0' on fresh entity succeeds", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    // First command with If-Match: "0" — entity is fresh, preSequenceNr = 0
    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 1 }, { "If-Match": '"0"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    await runtime.shutdown();
  });

  it("If-Match with unquoted value works", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    await post(app, "/counter/c1", { tag: "Increment", amount: 5 });

    // Unquoted "1" — parseIfMatch strips quotes if present, parseInt handles raw numbers
    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 3 }, { "If-Match": "1" });
    expect(res.status).toBe(200);
    await runtime.shutdown();
  });

  it("If-Match with non-numeric value returns 400", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 1 }, { "If-Match": '"abc"' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("If-Match");
    await runtime.shutdown();
  });

  it("If-Match with wildcard * returns 400", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory));

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 1 }, { "If-Match": "*" });
    expect(res.status).toBe(400);
    await runtime.shutdown();
  });

  it("If-Match with multi-event command uses correct preSequenceNr", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);
    const app = new Hono();
    app.route("/batch", aggregateRoutes(runtime, batchCounterCategory));

    // IncrementTwice → seqNr goes from 0 to 2
    await post(app, "/batch/b1", { tag: "IncrementTwice", amount: 1 });

    // If-Match: "2" — preSequenceNr should be 2
    const res = await post(app, "/batch/b1", { tag: "IncrementThrice", amount: 1 }, { "If-Match": '"2"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"5"'); // 2 + 3 events

    // Wrong If-Match
    const res2 = await post(app, "/batch/b1", { tag: "IncrementTwice", amount: 1 }, { "If-Match": '"3"' });
    expect(res2.status).toBe(409);
    await runtime.shutdown();
  });

  it("ETag disabled when etag: false", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory, { etag: false }));

    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 5 });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    await runtime.shutdown();
  });

  it("If-Match ignored when etag is disabled", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/counter", aggregateRoutes(runtime, counterCategory, { etag: false }));

    await post(app, "/counter/c1", { tag: "Increment", amount: 5 });

    // If-Match is present but etag is disabled — should succeed
    const res = await post(app, "/counter/c1", { tag: "Increment", amount: 3 }, { "If-Match": '"999"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeNull();
    await runtime.shutdown();
  });
});

// -- ask with meta direct tests --

describe("ask with meta", () => {
  it("returns correct preSequenceNr and sequenceNr on first command", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);

    const result = await runtime.ask(
      EntityId("c1"),
      { tag: "Increment", amount: 5 },
      counterCategory,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta!.preSequenceNr).toBe(0);
      expect(result.value.meta!.sequenceNr).toBe(1);
      expect(result.value.reply).toEqual({ tag: "Ok" });
    }
    await runtime.shutdown();
  });

  it("tracks preSequenceNr across multiple commands", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const id = EntityId("c1");

    const r1 = await runtime.ask(id, { tag: "Increment", amount: 1 }, counterCategory);
    expect(r1.ok && r1.value.meta).toEqual({ preSequenceNr: 0, sequenceNr: 1 });

    const r2 = await runtime.ask(id, { tag: "Increment", amount: 2 }, counterCategory);
    expect(r2.ok && r2.value.meta).toEqual({ preSequenceNr: 1, sequenceNr: 2 });

    const r3 = await runtime.ask(id, { tag: "Decrement", amount: 1 }, counterCategory);
    expect(r3.ok && r3.value.meta).toEqual({ preSequenceNr: 2, sequenceNr: 3 });
    await runtime.shutdown();
  });

  it("read-only query has equal pre and post sequenceNr", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const id = EntityId("c1");

    await runtime.ask(id, { tag: "Increment", amount: 5 }, counterCategory);
    await runtime.ask(id, { tag: "Increment", amount: 3 }, counterCategory);

    const r = await runtime.ask(id, { tag: "GetValue" }, counterCategory);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.meta!.preSequenceNr).toBe(2);
      expect(r.value.meta!.sequenceNr).toBe(2); // no new events
      expect(r.value.reply).toEqual({ tag: "Value", value: 8 });
    }
    await runtime.shutdown();
  });

  it("multi-event command reflects correct sequenceNr", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);
    const id = EntityId("b1");

    const r = await runtime.ask(id, { tag: "IncrementTwice", amount: 10 }, batchCounterCategory);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.meta!.preSequenceNr).toBe(0);
      expect(r.value.meta!.sequenceNr).toBe(2);
    }
    await runtime.shutdown();
  });

  it("returns CategoryNotFound for unknown category", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);

    const result = await runtime.ask(
      EntityId("x"),
      { tag: "Something" },
      { categoryId: "nonexistent" as any },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("CategoryNotFound");
    }
    await runtime.shutdown();
  });

  it("Done effect returns undefined reply with meta", async () => {
    const { runtime } = createSingleRuntime(batchCounterAggregate, batchCounterEventCodec, batchCounterStateCodec);

    const r = await runtime.ask(EntityId("b1"), { tag: "Noop" }, batchCounterCategory);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.reply).toBeUndefined();
      expect(r.value.meta!.preSequenceNr).toBe(0);
      expect(r.value.meta!.sequenceNr).toBe(0);
    }
    await runtime.shutdown();
  });
});

// -- allAggregateRoutes --

describe("allAggregateRoutes", () => {
  it("routes commands to correct category by path", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory, giftCardCategory]));

    const r1 = await post(app, "/api/counter/c1", { tag: "Increment", amount: 3 });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ tag: "Ok" });

    const r2 = await post(app, "/api/gift-card/gc1", { tag: "Issue", amount: 100 });
    expect(r2.status).toBe(200);

    const r3 = await post(app, "/api/gift-card/gc1", { tag: "GetBalance" });
    expect(r3.status).toBe(200);
    expect(await r3.json()).toEqual({ tag: "Balance", amount: 100 });
    await runtime.shutdown();
  });

  it("returns 404 for unknown category", async () => {
    const { runtime } = createSingleRuntime(counterAggregate, counterEventCodec, counterStateCodec);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory]));

    const res = await post(app, "/api/nonexistent/e1", { tag: "Foo" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("CategoryNotFound");
    await runtime.shutdown();
  });

  it("returns 400 for rejected commands", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [giftCardCategory]));

    const res = await post(app, "/api/gift-card/gc1", { tag: "Cancel" });
    expect(res.status).toBe(400);
    expect((await res.json()).tag).toBe("Rejected");
    await runtime.shutdown();
  });

  it("includes ETag headers", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory]));

    const res = await post(app, "/api/counter/c1", { tag: "Increment", amount: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    await runtime.shutdown();
  });

  it("If-Match works through allAggregateRoutes", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory]));

    await post(app, "/api/counter/c1", { tag: "Increment", amount: 1 });

    const ok = await post(app, "/api/counter/c1", { tag: "Increment", amount: 2 }, { "If-Match": '"1"' });
    expect(ok.status).toBe(200);

    const conflict = await post(app, "/api/counter/c1", { tag: "Increment", amount: 3 }, { "If-Match": '"1"' });
    expect(conflict.status).toBe(409);
    await runtime.shutdown();
  });

  it("etag: false disables ETag for all categories", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory, giftCardCategory], { etag: false }));

    const r1 = await post(app, "/api/counter/c1", { tag: "Increment", amount: 1 });
    expect(r1.headers.get("ETag")).toBeNull();

    const r2 = await post(app, "/api/gift-card/gc1", { tag: "Issue", amount: 100 });
    expect(r2.headers.get("ETag")).toBeNull();
    await runtime.shutdown();
  });

  it("custom rejectTag applies to all categories", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [giftCardCategory], { rejectTag: "CustomError" }));

    // "Rejected" no longer maps to 400
    const res = await post(app, "/api/gift-card/gc1", { tag: "Cancel" });
    expect(res.status).toBe(200);
    expect((await res.json()).tag).toBe("Rejected");
    await runtime.shutdown();
  });

  it("handles full lifecycle across categories", async () => {
    const { runtime } = createInMemoryRuntime([
      registration(counterAggregate, counterEventCodec, counterStateCodec),
      registration(giftCardAggregate, giftCardEventCodec, giftCardStateCodec),
    ]);
    const app = new Hono();
    app.route("/api", allAggregateRoutes(runtime, [counterCategory, giftCardCategory]));

    await post(app, "/api/gift-card/gc1", { tag: "Issue", amount: 50 });
    await post(app, "/api/gift-card/gc1", { tag: "Redeem", amount: 20 });
    const balRes = await post(app, "/api/gift-card/gc1", { tag: "GetBalance" });
    expect(await balRes.json()).toEqual({ tag: "Balance", amount: 30 });

    await post(app, "/api/counter/c1", { tag: "Increment", amount: 100 });
    const valRes = await post(app, "/api/counter/c1", { tag: "GetValue" });
    expect(await valRes.json()).toEqual({ tag: "Value", value: 100 });
    await runtime.shutdown();
  });
});

// -- OpenAPI schema --

describe("openApiSchema", () => {
  it("generates valid OpenAPI 3.1 spec", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("TEOB API");
    expect(spec.paths["/api/counter/{entityId}"]).toBeDefined();
    expect(spec.paths["/api/counter/{entityId}"].post).toBeDefined();
  });

  it("generates command schemas with discriminator", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const schemas = spec.components.schemas;

    expect(schemas.CounterCommand_Increment).toBeDefined();
    expect(schemas.CounterCommand_Increment.properties.tag.const).toBe("Increment");
    expect(schemas.CounterCommand_Decrement).toBeDefined();
    expect(schemas.CounterCommand_GetValue).toBeDefined();

    expect(schemas.CounterCommand).toBeDefined();
    expect(schemas.CounterCommand.oneOf).toHaveLength(3);
    expect(schemas.CounterCommand.discriminator.propertyName).toBe("tag");
  });

  it("generates reply schemas", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const schemas = spec.components.schemas;

    expect(schemas.CounterReply_Ok).toBeDefined();
    expect(schemas.CounterReply_Value).toBeDefined();
    expect(schemas.CounterReply.oneOf).toHaveLength(2);
  });

  it("supports multiple aggregates", () => {
    const counterDesc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const giftCardDesc = describeAggregate({
      aggregate: giftCardAggregate,
      eventCodec: giftCardEventCodec,
      stateCodec: giftCardStateCodec,
    });

    const spec = openApiSchema([counterDesc, giftCardDesc]) as any;
    expect(spec.paths["/api/counter/{entityId}"]).toBeDefined();
    expect(spec.paths["/api/gift-card/{entityId}"]).toBeDefined();
  });

  it("supports custom options", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc], {
      title: "My API",
      version: "2.0.0",
      description: "Custom description",
      basePath: "/v2",
    }) as any;

    expect(spec.info.title).toBe("My API");
    expect(spec.info.version).toBe("2.0.0");
    expect(spec.info.description).toBe("Custom description");
    expect(spec.paths["/v2/counter/{entityId}"]).toBeDefined();
  });

  it("includes error responses", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const responses = spec.paths["/api/counter/{entityId}"].post.responses;
    expect(responses["400"]).toBeDefined();
    expect(responses["404"]).toBeDefined();
    expect(responses["409"]).toBeDefined();
    expect(responses["504"]).toBeDefined();
  });

  it("includes If-Match and ETag in spec", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const params = spec.paths["/api/counter/{entityId}"].post.parameters;
    const ifMatch = params.find((p: any) => p.name === "If-Match");
    expect(ifMatch).toBeDefined();
    expect(ifMatch.in).toBe("header");
    expect(spec.paths["/api/counter/{entityId}"].post.responses["200"].headers.ETag).toBeDefined();
  });

  it("is JSON-serializable", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]);
    const json = JSON.stringify(spec);
    expect(JSON.parse(json)).toEqual(spec);
  });

  it("handles kebab-case category names", () => {
    const desc = describeAggregate({
      aggregate: giftCardAggregate,
      eventCodec: giftCardEventCodec,
      stateCodec: giftCardStateCodec,
    });

    const spec = openApiSchema([desc]) as any;
    expect(spec.paths["/api/gift-card/{entityId}"]).toBeDefined();
    expect(spec.paths["/api/gift-card/{entityId}"].post.tags).toEqual(["gift-card"]);
    expect(spec.paths["/api/gift-card/{entityId}"].post.operationId).toBe("giftCard_command");
  });

  it("aggregate without command codec has no requestBody", () => {
    const desc = describeAggregate({
      aggregate: giftCardAggregate,
      eventCodec: giftCardEventCodec,
      stateCodec: giftCardStateCodec,
      // no commandCodec
    });

    const spec = openApiSchema([desc]) as any;
    const post = spec.paths["/api/gift-card/{entityId}"].post;
    expect(post.requestBody).toBeUndefined();
  });

  it("aggregate without reply codec has no response content for 200", () => {
    const desc = describeAggregate({
      aggregate: giftCardAggregate,
      eventCodec: giftCardEventCodec,
      stateCodec: giftCardStateCodec,
      // no replyCodec
    });

    const spec = openApiSchema([desc]) as any;
    const response200 = spec.paths["/api/gift-card/{entityId}"].post.responses["200"];
    expect(response200.description).toBeDefined();
    expect(response200.content).toBeUndefined();
  });

  it("empty descriptions produces valid empty spec", () => {
    const spec = openApiSchema([]) as any;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths).toEqual({});
    expect(spec.components.schemas).toEqual({});
  });

  it("empty basePath produces paths without prefix", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc], { basePath: "" }) as any;
    expect(spec.paths["/counter/{entityId}"]).toBeDefined();
  });

  it("discriminator mapping points to correct schema refs", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const mapping = spec.components.schemas.CounterCommand.discriminator.mapping;
    expect(mapping.Increment).toBe("#/components/schemas/CounterCommand_Increment");
    expect(mapping.Decrement).toBe("#/components/schemas/CounterCommand_Decrement");
    expect(mapping.GetValue).toBe("#/components/schemas/CounterCommand_GetValue");
  });

  it("individual command schemas require tag and allow additional properties", () => {
    const desc = describeAggregate({
      aggregate: counterAggregate,
      eventCodec: counterEventCodec,
      stateCodec: counterStateCodec,
      commandCodec: counterCommandCodec,
      replyCodec: counterReplyCodec,
    });

    const spec = openApiSchema([desc]) as any;
    const schema = spec.components.schemas.CounterCommand_Increment;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["tag"]);
    expect(schema.additionalProperties).toBe(true);
  });
});
