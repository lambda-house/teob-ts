import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSignalStore, type SignalRow, type SignalStore } from "../src/ha/signal-store.js";
import { ulid } from "../src/core/ulid.js";

function row(over: Partial<SignalRow> & { entityId: string; at: number }): SignalRow {
  return {
    obsId: ulid(over.at),
    haTimeFired: over.at,
    raw: { entity_id: over.entityId, state: "42" },
    normalized: { value: 42, unit: "W" },
    origin: "ha",
    haVersion: "2026.7.1",
    policyVersion: 1,
    ...over,
  };
}

let dir: string;
let store: SignalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teob-signals-"));
  store = createSignalStore({ path: join(dir, "signals.db") });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("signal store append/query", () => {
  it("round-trips a full row", () => {
    const r = row({ entityId: "sensor.power", at: 1000 });
    store.append(r);
    const got = store.query({ entityId: "sensor.power" });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(r);
  });

  it("round-trips every normalized value type incl. null as SQL NULL", () => {
    const values: Array<SignalRow["normalized"]> = [
      { value: 21.5, unit: "°C" },
      { value: true, unit: null },
      { value: false, unit: null },
      { value: "cleaning", unit: null },
      { value: null, unit: "ppm" },
    ];
    values.forEach((normalized, i) => {
      store.append(row({ entityId: "sensor.x", at: 1000 + i, normalized }));
    });
    const got = store.query({ entityId: "sensor.x" });
    expect(got.map((r) => r.normalized)).toEqual(values);
    // null really is SQL NULL, not the string "null"
    const raw = store.db
      .prepare("SELECT norm_value FROM signals WHERE at = ?")
      .get(1004) as { norm_value: unknown };
    expect(raw.norm_value).toBeNull();
  });

  it("filters by entityId only", () => {
    store.append(row({ entityId: "sensor.a", at: 1 }));
    store.append(row({ entityId: "sensor.b", at: 2 }));
    expect(store.query({ entityId: "sensor.a" })).toHaveLength(1);
    expect(store.query({ entityId: "sensor.nope" })).toHaveLength(0);
  });

  it("sinceMs is inclusive, untilMs is exclusive", () => {
    for (const at of [100, 200, 300, 400]) store.append(row({ entityId: "sensor.a", at }));
    const got = store.query({ entityId: "sensor.a", sinceMs: 200, untilMs: 400 });
    expect(got.map((r) => r.at)).toEqual([200, 300]);
  });

  it("orders asc by default, desc on request, and applies limit", () => {
    for (const at of [30, 10, 20]) store.append(row({ entityId: "sensor.a", at }));
    expect(store.query({ entityId: "sensor.a" }).map((r) => r.at)).toEqual([10, 20, 30]);
    expect(store.query({ entityId: "sensor.a", order: "desc" }).map((r) => r.at)).toEqual([
      30, 20, 10,
    ]);
    expect(store.query({ entityId: "sensor.a", limit: 2 }).map((r) => r.at)).toEqual([10, 20]);
    expect(
      store.query({ entityId: "sensor.a", order: "desc", limit: 2 }).map((r) => r.at),
    ).toEqual([30, 20]);
  });

  it("clamps limit into [1, 5000]", () => {
    for (const at of [1, 2, 3]) store.append(row({ entityId: "sensor.a", at }));
    // A huge limit must not blow up — it is clamped, query still works.
    expect(store.query({ entityId: "sensor.a", limit: 1_000_000 })).toHaveLength(3);
    // SQLite treats LIMIT -1 as "no limit" — negative/zero must clamp to 1, not dump the ring.
    expect(store.query({ entityId: "sensor.a", limit: -1 })).toHaveLength(1);
    expect(store.query({ entityId: "sensor.a", limit: 0 })).toHaveLength(1);
  });
});

describe("latest", () => {
  it("returns the newest row by at", () => {
    for (const at of [100, 300, 200]) {
      store.append(row({ entityId: "sensor.a", at, normalized: { value: at, unit: null } }));
    }
    expect(store.latest("sensor.a")?.normalized.value).toBe(300);
  });

  it("returns undefined for an unknown entity", () => {
    expect(store.latest("sensor.ghost")).toBeUndefined();
  });
});

describe("prune", () => {
  it("deletes only rows older than the retention window and returns the count", () => {
    const now = Date.now();
    store.append(row({ entityId: "sensor.a", at: now - 40 * 864e5 })); // 40 days old
    store.append(row({ entityId: "sensor.a", at: now - 31 * 864e5 })); // 31 days old
    store.append(row({ entityId: "sensor.a", at: now - 864e5 }));      // 1 day old
    store.append(row({ entityId: "sensor.b", at: now }));

    const deleted = store.prune(30);
    expect(deleted).toBe(2);
    expect(store.query({ entityId: "sensor.a" }).map((r) => r.at)).toEqual([now - 864e5]);
    expect(store.query({ entityId: "sensor.b" })).toHaveLength(1);
    // Idempotent: nothing left to prune.
    expect(store.prune(30)).toBe(0);
  });
});

describe("stats", () => {
  it("reports rows, oldest/newest and db size", () => {
    expect(store.stats()).toEqual({ rows: 0, oldestAt: null, newestAt: null, dbBytes: expect.any(Number) });
    store.append(row({ entityId: "sensor.a", at: 500 }));
    store.append(row({ entityId: "sensor.a", at: 100 }));
    const s = store.stats();
    expect(s.rows).toBe(2);
    expect(s.oldestAt).toBe(100);
    expect(s.newestAt).toBe(500);
    expect(s.dbBytes).toBeGreaterThan(0);
  });
});
