// http-views.test.ts — Gap #5 HTTP read side: createReadApi routes + SSE stream/bus.
// Covers contract §6.3: every route incl. pagination nextCursor, chain 404, param
// validation, 501s, fall-through undefined, and sseResponse framing/keepalive/cancel.

import { describe, it, expect, afterEach, vi } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { EventEnvelope, JournalQuery, JournalQueryRow, JournalReader, PersistedBatch } from "../src/core/envelope.js";
import { createInMemoryProjectionStore } from "../src/projection/index.js";
import { createReadApi, type SignalReader } from "../src/http/views.js";
import { createStreamBus, journalFrame, sseResponse, type StreamFrame } from "../src/http/sse.js";

// ---------- fixtures ----------

function makeRow(
  globalSeq: number,
  opts: {
    category?: string;
    entityId?: string;
    sequenceNr?: number;
    ts?: number;
    envelope?: EventEnvelope | null;
    payload?: unknown;
  } = {},
): JournalQueryRow {
  return {
    globalSeq,
    category: opts.category ?? "ha-audit",
    entityId: opts.entityId ?? "nodered",
    sequenceNr: opts.sequenceNr ?? globalSeq,
    manifest: "HaCallServiceObserved",
    payload: opts.payload ?? { tag: "HaCallServiceObserved", n: globalSeq },
    ts: opts.ts ?? 1_700_000_000 + globalSeq,
    envelope: opts.envelope === undefined ? { eventId: `e${globalSeq}`, v: 1 } : opts.envelope,
  };
}

/** Hand-rolled JournalReader over an in-memory row list; records received queries. */
function makeJournalReader(rows: JournalQueryRow[]): { reader: JournalReader; calls: JournalQuery[] } {
  const calls: JournalQuery[] = [];

  function eventByEventId(eventId: string): JournalQueryRow | undefined {
    return rows.find((r) => r.envelope?.eventId === eventId);
  }

  const reader: JournalReader = {
    queryEvents(q: JournalQuery): JournalQueryRow[] {
      calls.push(q);
      const order = q.order ?? "desc";
      let out = rows.filter((r) => {
        if (q.category !== undefined && r.category !== q.category) return false;
        if (q.entityId !== undefined && r.entityId !== q.entityId) return false;
        if (q.sinceMs !== undefined && r.ts < Math.floor(q.sinceMs / 1000)) return false;
        if (q.causationId !== undefined && r.envelope?.causationId !== q.causationId) return false;
        if (q.correlationId !== undefined && r.envelope?.correlationId !== q.correlationId) return false;
        if (q.cursor !== undefined) {
          if (order === "desc" && r.globalSeq >= q.cursor) return false;
          if (order === "asc" && r.globalSeq <= q.cursor) return false;
        }
        return true;
      });
      out = out.sort((a, b) => (order === "desc" ? b.globalSeq - a.globalSeq : a.globalSeq - b.globalSeq));
      return out.slice(0, Math.min(q.limit ?? 100, 1000));
    },
    eventByEventId,
    causationChain(eventId: string, opts?: { maxDepth?: number }): JournalQueryRow[] {
      const maxDepth = opts?.maxDepth ?? 25;
      const chain: JournalQueryRow[] = [];
      let current = eventByEventId(eventId);
      while (current !== undefined && chain.length < maxDepth) {
        chain.push(current);
        const parent = current.envelope?.causationId;
        current = parent === undefined ? undefined : eventByEventId(parent);
      }
      return chain;
    },
  };
  return { reader, calls };
}

// e1 ← e2 ← e3 causation chain; e4 caused by an HA context id (chain terminates there).
const FIXTURE_ROWS: JournalQueryRow[] = [
  makeRow(1, { envelope: { eventId: "e1", v: 1 } }),
  makeRow(2, { envelope: { eventId: "e2", causationId: "e1", v: 1 } }),
  makeRow(3, { envelope: { eventId: "e3", causationId: "e2", v: 1 } }),
  makeRow(4, { envelope: { eventId: "e4", causationId: "ctx-1", origin: "nodered", v: 1 } }),
  makeRow(5, { envelope: { eventId: "e5", correlationId: "cor-1", v: 1 } }),
  makeRow(6, { category: "other", entityId: "x", sequenceNr: 1, envelope: null }),
];

function makeApi(overrides?: {
  signals?: SignalReader;
  recorder?: { statisticsDuringPeriod: (req: any) => Promise<unknown> };
  tiles?: () => unknown;
  bus?: ReturnType<typeof createStreamBus>;
  basePath?: string;
  keepaliveMs?: number;
}) {
  const projectionStore = createInMemoryProjectionStore();
  const { reader, calls } = makeJournalReader(FIXTURE_ROWS);
  const api = createReadApi(
    {
      projectionStore,
      journal: reader,
      signals: overrides?.signals,
      recorder: overrides?.recorder,
      tiles: overrides?.tiles,
      bus: overrides?.bus,
      startedAt: 111,
    },
    {
      ...(overrides?.basePath !== undefined && { basePath: overrides.basePath }),
      ...(overrides?.keepaliveMs !== undefined && { sse: { keepaliveMs: overrides.keepaliveMs } }),
    },
  );
  return { api, projectionStore, journalCalls: calls };
}

function get(api: { handle: (req: Request) => Promise<Response | undefined> }, path: string) {
  return api.handle(new Request(`http://localhost${path}`));
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------- views routes ----------

describe("createReadApi /views", () => {
  it("lists all view envelopes for a projection", async () => {
    const { api, projectionStore } = makeApi();
    projectionStore.put("nodered-timeline", "nodered", {
      viewId: "nodered",
      view: { cards: [], total: 0 },
      sequenceNr: SequenceNr(3),
    });
    projectionStore.put("nodered-timeline", "other", {
      viewId: "other",
      view: { cards: [], total: 2 },
      sequenceNr: SequenceNr(7),
    });

    const res = (await get(api, "/api/views/nodered-timeline"))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectionId).toBe("nodered-timeline");
    expect(body.views).toHaveLength(2);
    expect(body.views.map((v: any) => v.viewId).sort()).toEqual(["nodered", "other"]);
  });

  it("returns a single view envelope, 404 ViewNotFound when missing", async () => {
    const { api, projectionStore } = makeApi();
    projectionStore.put("nodered-timeline", "nodered", {
      viewId: "nodered",
      view: { cards: [{ at: 1 }], total: 1 },
      sequenceNr: SequenceNr(1),
    });

    const ok = (await get(api, "/api/views/nodered-timeline/nodered"))!;
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      viewId: "nodered",
      view: { cards: [{ at: 1 }], total: 1 },
      sequenceNr: 1,
    });

    const missing = (await get(api, "/api/views/nodered-timeline/nope"))!;
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "ViewNotFound" });
  });
});

// ---------- journal routes ----------

describe("createReadApi /journal", () => {
  it("returns rows desc by default with nextCursor null when under limit", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/journal"))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.map((r: any) => r.globalSeq)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(body.nextCursor).toBeNull();
  });

  it("paginates with cursor: nextCursor = last row's globalSeq when page is full", async () => {
    const { api } = makeApi();

    const p1 = await (await get(api, "/api/journal?limit=2"))!.json();
    expect(p1.rows.map((r: any) => r.globalSeq)).toEqual([6, 5]);
    expect(p1.nextCursor).toBe(5);

    const p2 = await (await get(api, `/api/journal?limit=2&cursor=${p1.nextCursor}`))!.json();
    expect(p2.rows.map((r: any) => r.globalSeq)).toEqual([4, 3]);
    expect(p2.nextCursor).toBe(3);

    const p3 = await (await get(api, `/api/journal?limit=4&cursor=${p2.nextCursor}`))!.json();
    expect(p3.rows.map((r: any) => r.globalSeq)).toEqual([2, 1]);
    expect(p3.nextCursor).toBeNull(); // 2 rows < limit 4
  });

  it("maps query params onto JournalQuery (entity→entityId, since→sinceMs, causationOf→causationId)", async () => {
    const { api, journalCalls } = makeApi();
    const res = (await get(
      api,
      "/api/journal?category=ha-audit&entity=nodered&since=1700000003000&causationOf=e2&correlationId=cor-1&order=asc&limit=7",
    ))!;
    expect(res.status).toBe(200);
    expect(journalCalls).toHaveLength(1);
    expect(journalCalls[0]).toEqual({
      category: "ha-audit",
      entityId: "nodered",
      sinceMs: 1_700_000_003_000,
      causationId: "e2",
      correlationId: "cor-1",
      limit: 7,
      order: "asc",
    });
  });

  it("filters by causationOf and correlationId through the reader", async () => {
    const { api } = makeApi();
    const byCause = await (await get(api, "/api/journal?causationOf=e2"))!.json();
    expect(byCause.rows.map((r: any) => r.envelope.eventId)).toEqual(["e3"]);

    const byCorr = await (await get(api, "/api/journal?correlationId=cor-1"))!.json();
    expect(byCorr.rows.map((r: any) => r.envelope.eventId)).toEqual(["e5"]);
  });

  it("clamps limit into [1, 1000] — a negative limit must never reach SQL as LIMIT -1", async () => {
    const { api, journalCalls } = makeApi();
    await get(api, "/api/journal?limit=5000");
    await get(api, "/api/journal?limit=-1");
    expect(journalCalls[0]!.limit).toBe(1000);
    expect(journalCalls[1]!.limit).toBe(1);
  });

  it("400s on entity without category", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/journal?entity=nodered"))!;
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BadRequest");
    expect(body.detail).toContain("category");
  });

  it("400s on bad numeric params", async () => {
    const { api } = makeApi();
    for (const qs of ["cursor=abc", "since=yesterday", "limit=lots", "order=sideways"]) {
      const res = (await get(api, `/api/journal?${qs}`))!;
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("BadRequest");
    }
  });
});

describe("createReadApi /journal/chain", () => {
  it("returns the causation chain, self first", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/journal/chain/e3"))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chain.map((r: any) => r.envelope.eventId)).toEqual(["e3", "e2", "e1"]);
  });

  it("terminates at a non-event causation id (HA context id)", async () => {
    const { api } = makeApi();
    const body = await (await get(api, "/api/journal/chain/e4"))!.json();
    expect(body.chain.map((r: any) => r.envelope.eventId)).toEqual(["e4"]);
  });

  it("404s for an unknown eventId", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/journal/chain/nope"))!;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("EventNotFound");
  });
});

// ---------- signals ----------

describe("createReadApi /signals", () => {
  /** Order- and limit-honoring fixture over rows at 1000/2000/3000 (like the real store). */
  function makeSignals() {
    const calls: any[] = [];
    const all = [
      { obsId: "o1", at: 1000, normalized: { value: 21.5, unit: "°C" as string | null } },
      { obsId: "o2", at: 2000, normalized: { value: null, unit: null } },
      { obsId: "o3", at: 3000, normalized: { value: 22.0, unit: "°C" as string | null } },
    ];
    const signals: SignalReader = {
      query(q) {
        calls.push(q);
        const sorted = q.order === "desc" ? [...all].reverse() : [...all];
        return sorted.slice(0, Math.max(1, Math.min(q.limit ?? 500, 5000)));
      },
    };
    return { signals, calls };
  }

  it("maps rows to sparkline shape and applies defaults (since=now-3h, chronological, limit 500)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000_000);
    const { signals, calls } = makeSignals();
    const { api } = makeApi({ signals });

    const res = (await get(api, "/api/signals/sensor.co2_intensity"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entityId: "sensor.co2_intensity",
      rows: [
        { at: 1000, value: 21.5, unit: "°C" },
        { at: 2000, value: null, unit: null },
        { at: 3000, value: 22.0, unit: "°C" },
      ],
    });
    // The store is always queried desc so the limit keeps the NEWEST rows;
    // the asc (default) response is reversed back to chronological order.
    expect(calls).toEqual([
      {
        entityId: "sensor.co2_intensity",
        sinceMs: 50_000_000 - 3 * 3600e3,
        limit: 500,
        order: "desc",
      },
    ]);
  });

  it("passes explicit since/until/limit/order through", async () => {
    const { signals, calls } = makeSignals();
    const { api } = makeApi({ signals });
    await get(api, "/api/signals/person.tim?since=100&until=900&limit=9&order=desc");
    expect(calls[0]).toEqual({ entityId: "person.tim", sinceMs: 100, untilMs: 900, limit: 9, order: "desc" });
  });

  it("returns the NEWEST rows of the window when it exceeds the limit, still chronological", async () => {
    const { signals } = makeSignals();
    const { api } = makeApi({ signals });
    const body = await (await get(api, "/api/signals/sensor.co2_intensity?since=0&limit=2&order=asc"))!.json();
    // Window has 3 rows, limit 2 ⇒ newest two (2000, 3000) in sparkline order —
    // NOT the oldest two that a naive asc LIMIT would return.
    expect(body.rows.map((r: any) => r.at)).toEqual([2000, 3000]);
  });

  it("clamps limit into [1, 5000]", async () => {
    const { signals, calls } = makeSignals();
    const { api } = makeApi({ signals });
    await get(api, "/api/signals/person.tim?limit=-1");
    await get(api, "/api/signals/person.tim?limit=999999");
    expect(calls[0]!.limit).toBe(1);
    expect(calls[1]!.limit).toBe(5000);
  });

  it("400s on bad numeric params", async () => {
    const { signals } = makeSignals();
    const { api } = makeApi({ signals });
    const res = (await get(api, "/api/signals/person.tim?since=noon"))!;
    expect(res.status).toBe(400);
  });

  it("501s when no signal store is configured", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/signals/person.tim"))!;
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("NotImplemented");
  });
});

// ---------- tiles ----------

describe("createReadApi /tiles", () => {
  it("passes the tiles snapshot through", async () => {
    const { api } = makeApi({ tiles: () => ({ at: 42, tiles: [{ entityId: "person.tim", value: "home" }] }) });
    const res = (await get(api, "/api/tiles"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ at: 42, tiles: [{ entityId: "person.tim", value: "home" }] });
  });

  it("501s when no tiles source is configured", async () => {
    const { api } = makeApi();
    expect((await get(api, "/api/tiles"))!.status).toBe(501);
  });
});

// ---------- recorder ----------

describe("createReadApi /recorder/statistics", () => {
  it("maps params and passes the recorder response through", async () => {
    const reqs: any[] = [];
    const { api } = makeApi({
      recorder: {
        statisticsDuringPeriod: async (req) => {
          reqs.push(req);
          return { "sensor.a": [{ start: 1, end: 2, sum: 3 }] };
        },
      },
    });
    const res = (await get(
      api,
      "/api/recorder/statistics?ids=sensor.a,sensor.b&start=2026-07-18T00:00:00Z&end=2026-07-19T00:00:00Z&period=hour&types=sum,mean",
    ))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "sensor.a": [{ start: 1, end: 2, sum: 3 }] });
    expect(reqs).toEqual([
      {
        statisticIds: ["sensor.a", "sensor.b"],
        startTime: "2026-07-18T00:00:00Z",
        endTime: "2026-07-19T00:00:00Z",
        period: "hour",
        types: ["sum", "mean"],
      },
    ]);
  });

  it("omits endTime when end is absent", async () => {
    const reqs: any[] = [];
    const { api } = makeApi({
      recorder: { statisticsDuringPeriod: async (req) => (reqs.push(req), {}) },
    });
    await get(api, "/api/recorder/statistics?ids=sensor.a&start=2026-07-18T00:00:00Z&period=day&types=sum");
    expect(reqs[0]).not.toHaveProperty("endTime");
  });

  it("400s on missing required params", async () => {
    const { api } = makeApi({ recorder: { statisticsDuringPeriod: async () => ({}) } });
    for (const qs of [
      "start=2026-07-18T00:00:00Z&period=hour&types=sum", // no ids
      "ids=sensor.a&period=hour&types=sum", // no start
      "ids=sensor.a&start=2026-07-18T00:00:00Z&types=sum", // no period
      "ids=sensor.a&start=2026-07-18T00:00:00Z&period=hour", // no types
    ]) {
      const res = (await get(api, `/api/recorder/statistics?${qs}`))!;
      expect(res.status).toBe(400);
    }
  });

  it("501s when no recorder is configured", async () => {
    const { api } = makeApi();
    expect((await get(api, "/api/recorder/statistics?ids=a&start=x&period=hour&types=sum"))!.status).toBe(501);
  });
});

// ---------- routing edges ----------

describe("createReadApi routing", () => {
  it("returns undefined for paths outside basePath (fall-through), incl. prefix collisions", async () => {
    const { api } = makeApi();
    expect(await get(api, "/health")).toBeUndefined();
    expect(await get(api, "/")).toBeUndefined();
    expect(await get(api, "/apifoo/journal")).toBeUndefined();
  });

  it("respects a custom basePath", async () => {
    const { api } = makeApi({ basePath: "/read" });
    expect(await get(api, "/api/journal")).toBeUndefined();
    expect((await get(api, "/read/journal"))!.status).toBe(200);
  });

  it("405s non-GET under basePath", async () => {
    const { api } = makeApi();
    const res = (await api.handle(new Request("http://localhost/api/journal", { method: "POST" })))!;
    expect(res.status).toBe(405);
  });

  it("404s unmatched paths under basePath with a JSON body", async () => {
    const { api } = makeApi();
    const res = (await get(api, "/api/nope"))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NotFound" });
  });

  it("501s /stream without a bus, serves SSE with one", async () => {
    const { api: without } = makeApi();
    expect((await get(without, "/api/stream"))!.status).toBe(501);

    const bus = createStreamBus();
    const { api } = makeApi({ bus, keepaliveMs: 10_000 });
    const res = (await get(api, "/api/stream"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(bus.subscriberCount()).toBe(1);
    await res.body!.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });
});

// ---------- SSE: bus + response framing ----------

describe("createStreamBus", () => {
  it("fans out frames to all subscribers and honors unsubscribe", () => {
    const bus = createStreamBus();
    const a: StreamFrame[] = [];
    const b: StreamFrame[] = [];
    const offA = bus.subscribe((f) => a.push(f));
    bus.subscribe((f) => b.push(f));
    expect(bus.subscriberCount()).toBe(2);

    const frame: StreamFrame = { type: "signal", row: { entityId: "person.tim" } };
    bus.publish(frame);
    expect(a).toEqual([frame]);
    expect(b).toEqual([frame]);

    offA();
    expect(bus.subscriberCount()).toBe(1);
    bus.publish(frame);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("a throwing subscriber does not break fan-out", () => {
    const bus = createStreamBus();
    const seen: StreamFrame[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((f) => seen.push(f));
    expect(() => bus.publish({ type: "signal", row: 1 })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("journalFrame", () => {
  it("maps a PersistedBatch to a journal frame", () => {
    const batch: PersistedBatch = {
      category: CategoryId("ha-audit"),
      entityId: EntityId("nodered"),
      at: 12345,
      records: [
        {
          sequenceNr: SequenceNr(3),
          manifest: "HaCallServiceObserved",
          encoded: { tag: "HaCallServiceObserved", domain: "light" },
          envelope: { eventId: "e9", causationId: "ctx-9", origin: "nodered", v: 1 },
        },
      ],
    };
    expect(journalFrame(batch)).toEqual({
      type: "journal",
      category: "ha-audit",
      entityId: "nodered",
      at: 12345,
      records: [
        {
          sequenceNr: 3,
          manifest: "HaCallServiceObserved",
          encoded: { tag: "HaCallServiceObserved", domain: "light" },
          envelope: { eventId: "e9", causationId: "ctx-9", origin: "nodered", v: 1 },
        },
      ],
    });
  });
});

describe("sseResponse", () => {
  const decoder = new TextDecoder();

  async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    return decoder.decode(value);
  }

  it("sets SSE headers", () => {
    const res = sseResponse(createStreamBus(), { keepaliveMs: 60_000 });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    void res.body!.cancel();
  });

  it("streams retry + hello, fans out bus frames, sends keepalives, cleans up on cancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const bus = createStreamBus();

    const res = sseResponse(bus, { keepaliveMs: 20, startedAt: 777 });
    const reader = res.body!.getReader();

    expect(await readChunk(reader)).toBe("retry: 3000\n\n");
    expect(await readChunk(reader)).toBe(
      `event: hello\ndata: ${JSON.stringify({ type: "hello", startedAt: 777, now: 1_000_000 })}\n\n`,
    );
    expect(bus.subscriberCount()).toBe(1);

    const jf: StreamFrame = {
      type: "journal",
      category: "ha-audit",
      entityId: "nodered",
      records: [{ sequenceNr: 1, manifest: "M", encoded: { a: 1 }, envelope: { eventId: "e1", v: 1 } }],
      at: 5,
    };
    bus.publish(jf);
    expect(await readChunk(reader)).toBe(`event: journal\ndata: ${JSON.stringify(jf)}\n\n`);

    const sf: StreamFrame = { type: "signal", row: { entityId: "person.tim", at: 6 } };
    bus.publish(sf);
    expect(await readChunk(reader)).toBe(`event: signal\ndata: ${JSON.stringify(sf)}\n\n`);

    vi.advanceTimersByTime(20);
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    vi.advanceTimersByTime(40);
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    expect(await readChunk(reader)).toBe(": keepalive\n\n");

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0); // unsubscribed
    expect(() => {
      bus.publish(sf); // no dead subscriber left behind
      vi.advanceTimersByTime(100); // keepalive timer cleared — writes would throw into cleanup
    }).not.toThrow();
  });

  it("drops a subscriber whose unread queue exceeds the backpressure cap (stalled client)", async () => {
    const bus = createStreamBus();
    const res = sseResponse(bus, { keepaliveMs: 60_000 });
    const reader = res.body!.getReader();
    expect(bus.subscriberCount()).toBe(1);

    // Never read: simulates a client socket that stalls without closing
    // (sleeping tablet, dead Wi-Fi with no RST) — frames pile up in the queue.
    const big = "x".repeat(100_000);
    for (let i = 0; i < 30 && bus.subscriberCount() > 0; i++) {
      bus.publish({ type: "signal", row: { big } });
    }
    // ~12 × 100KB frames exceed the 64KB highWaterMark + 1MB allowance ⇒ dropped.
    expect(bus.subscriberCount()).toBe(0);

    // The stream was closed: draining the queued chunks terminates with done.
    let done = false;
    for (let guard = 0; !done && guard < 100; guard++) {
      ({ done } = await reader.read());
    }
    expect(done).toBe(true);
  });
});
