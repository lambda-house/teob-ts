import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHaBridge, type HaBridgeOptions } from "../src/ha/bridge.js";
import { createSignalStore, type SignalRow, type SignalStore } from "../src/ha/signal-store.js";
import type { HaEntityState, HaStateChangedEvent, HaStatesSnapshot } from "../src/ha/types.js";
import { ulid } from "../src/core/ulid.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeClient(haVersion: string | null = "2026.7.1") {
  const stateHandlers: Array<(e: HaStateChangedEvent) => void> = [];
  const snapHandlers: Array<(s: HaStatesSnapshot) => void> = [];
  const client: HaBridgeOptions["client"] = {
    onStateChanged(h) {
      stateHandlers.push(h);
      return () => {
        const i = stateHandlers.indexOf(h);
        if (i >= 0) stateHandlers.splice(i, 1);
      };
    },
    onStatesSnapshot(h) {
      snapHandlers.push(h);
      return () => {
        const i = snapHandlers.indexOf(h);
        if (i >= 0) snapHandlers.splice(i, 1);
      };
    },
    stats: {
      connected: true,
      haVersion,
      connectedSince: 0,
      reconnects: 0,
      eventsSeen: 0,
      lastEventAt: null,
      pendingCommands: 0,
      subscriptions: 0,
    },
  };
  return {
    client,
    handlerCount: () => stateHandlers.length + snapHandlers.length,
    fireState(e: HaStateChangedEvent) {
      for (const h of [...stateHandlers]) h(e);
    },
    fireSnapshot(s: HaStatesSnapshot) {
      for (const h of [...snapHandlers]) h(s);
    },
  };
}

function haState(
  entityId: string,
  state: string,
  attributes: Record<string, unknown> = {},
  lastUpdated = new Date().toISOString(),
): HaEntityState {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: lastUpdated,
    last_updated: lastUpdated,
    context: { id: "ctx1", parent_id: null, user_id: null },
  };
}

function changed(entityId: string, state: string, attributes: Record<string, unknown> = {}): HaStateChangedEvent {
  return {
    entityId,
    newState: haState(entityId, state, attributes),
    oldState: null,
    timeFired: Date.now(),
    context: { id: "ctx1", parent_id: null, user_id: null },
  };
}

// ---------------------------------------------------------------------------

let fc: ReturnType<typeof fakeClient>;
let store: SignalStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  fc = fakeClient();
  store = createSignalStore({ path: ":memory:" });
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

function makeBridge(over: Partial<HaBridgeOptions> = {}) {
  return createHaBridge({
    client: fc.client,
    store,
    routes: [
      { entityId: "binary_sensor.door", debounce: "on-change" },
      { entityId: "sensor.co2", debounce: "deadband", params: { deadband: 25 } },
      {
        entityId: "sensor.power",
        debounce: "throttle-ema",
        params: { emaHalflifeMs: 10_000, emitIntervalMs: 10_000 },
      },
      { entityId: "sensor.grid_co2", debounce: "slow-context" },
    ],
    ...over,
  });
}

describe("construction", () => {
  it("throws on duplicate routed entity ids", () => {
    expect(() =>
      createHaBridge({
        client: fc.client,
        store,
        routes: [
          { entityId: "sensor.a", debounce: "on-change" },
          { entityId: "sensor.a", debounce: "deadband", params: { deadband: 1 } },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("start is idempotent", () => {
    const bridge = makeBridge();
    bridge.start();
    bridge.start();
    expect(fc.handlerCount()).toBe(2); // one state + one snapshot handler
    fc.fireState(changed("binary_sensor.door", "on"));
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(1);
    bridge.stop();
    expect(fc.handlerCount()).toBe(0);
  });
});

describe("routing allowlist + live cache", () => {
  it("unrouted entities update the live cache but never produce rows", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("light.kitchen", "on"));
    expect(bridge.liveState("light.kitchen")?.state).toBe("on");
    expect(store.query({ entityId: "light.kitchen" })).toHaveLength(0);
    expect(bridge.stats().received).toBe(0); // received counts routed only
    expect(bridge.stats().cacheSize).toBe(1);
    bridge.stop();
  });

  it("routed entities update the cache AND the store", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("binary_sensor.door", "on"));
    expect(bridge.liveState("binary_sensor.door")?.state).toBe("on");
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(1);
    expect(bridge.stats().received).toBe(1);
    expect(bridge.routedEntities()).toContain("binary_sensor.door");
    bridge.stop();
  });

  it("a null newState removes the entity from the live cache", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("light.kitchen", "on"));
    fc.fireState({
      entityId: "light.kitchen",
      newState: null,
      oldState: haState("light.kitchen", "on"),
      timeFired: Date.now(),
      context: null,
    });
    expect(bridge.liveState("light.kitchen")).toBeUndefined();
    bridge.stop();
  });
});

describe("debounce: on-change / slow-context", () => {
  it("emits only when the normalized value changes", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("binary_sensor.door", "on"));  // first ⇒ emit true
    fc.fireState(changed("binary_sensor.door", "on"));  // same ⇒ suppressed
    fc.fireState(changed("binary_sensor.door", "off")); // change ⇒ emit false
    const rows = store.query({ entityId: "binary_sensor.door" });
    expect(rows.map((r) => r.normalized.value)).toEqual([true, false]);
    expect(bridge.stats()).toMatchObject({ received: 3, appended: 2, suppressed: 1 });
    bridge.stop();
  });

  it("slow-context stores like on-change", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("sensor.grid_co2", "220", { unit_of_measurement: "g/kWh" }));
    fc.fireState(changed("sensor.grid_co2", "220", { unit_of_measurement: "g/kWh" }));
    fc.fireState(changed("sensor.grid_co2", "221", { unit_of_measurement: "g/kWh" }));
    const rows = store.query({ entityId: "sensor.grid_co2" });
    expect(rows.map((r) => r.normalized.value)).toEqual([220, 221]);
    expect(rows[0].normalized.unit).toBe("g/kWh");
    bridge.stop();
  });
});

describe("debounce: deadband", () => {
  it("emits only when |delta| >= deadband", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("sensor.co2", "400", { unit_of_measurement: "ppm" })); // first ⇒ emit
    fc.fireState(changed("sensor.co2", "410", { unit_of_measurement: "ppm" })); // Δ10 ⇒ suppressed
    fc.fireState(changed("sensor.co2", "424", { unit_of_measurement: "ppm" })); // Δ24 ⇒ suppressed
    fc.fireState(changed("sensor.co2", "430", { unit_of_measurement: "ppm" })); // Δ30 ⇒ emit
    fc.fireState(changed("sensor.co2", "410", { unit_of_measurement: "ppm" })); // Δ20 vs 430 ⇒ suppressed
    fc.fireState(changed("sensor.co2", "405", { unit_of_measurement: "ppm" })); // Δ25 vs 430 ⇒ emit
    const rows = store.query({ entityId: "sensor.co2" });
    expect(rows.map((r) => r.normalized.value)).toEqual([400, 430, 405]);
    bridge.stop();
  });

  it("a transition to/from null always emits", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("sensor.co2", "400"));
    fc.fireState(changed("sensor.co2", "unavailable")); // ⇒ null, always emits
    fc.fireState(changed("sensor.co2", "401"));         // null ⇒ number, always emits
    const rows = store.query({ entityId: "sensor.co2" });
    expect(rows.map((r) => r.normalized.value)).toEqual([400, null, 401]);
    bridge.stop();
  });
});

describe("debounce: throttle-ema", () => {
  it("first sample emits immediately; EMA math and throttle window are honored", () => {
    const bridge = makeBridge();
    bridge.start();

    vi.setSystemTime(0);
    fc.fireState(changed("sensor.power", "100", { unit_of_measurement: "W" }));
    // First sample: immediate emit, value = EMA = 100.

    vi.setSystemTime(5_000);
    fc.fireState(changed("sensor.power", "200", { unit_of_measurement: "W" }));
    // dt=5000, halflife=10000 ⇒ alpha = 1 - 2^-0.5; EMA ≈ 129.289. Throttled (5s < 10s).

    vi.setSystemTime(10_000);
    fc.fireState(changed("sensor.power", "200", { unit_of_measurement: "W" }));
    // Two 5s steps toward 200 ≡ one halflife ⇒ EMA = 150 exactly. 10s elapsed ⇒ emit.

    const rows = store.query({ entityId: "sensor.power" });
    expect(rows.map((r) => r.normalized.value)).toEqual([100, 150]);
    expect(rows[1].normalized.unit).toBe("W");
    expect(bridge.stats()).toMatchObject({ received: 3, appended: 2, suppressed: 1 });
    bridge.stop();
  });

  it("suppressed samples still feed the EMA", () => {
    const bridge = makeBridge();
    bridge.start();
    vi.setSystemTime(0);
    fc.fireState(changed("sensor.power", "0"));
    // Feed a burst inside the throttle window: EMA keeps moving.
    for (const t of [2_000, 4_000, 6_000, 8_000]) {
      vi.setSystemTime(t);
      fc.fireState(changed("sensor.power", "1000"));
    }
    vi.setSystemTime(10_000);
    fc.fireState(changed("sensor.power", "1000"));
    const rows = store.query({ entityId: "sensor.power" });
    expect(rows).toHaveLength(2);
    // After 10s = one halflife of pull toward 1000 from 0 the EMA is 500.
    expect(rows[1].normalized.value).toBe(500);
    bridge.stop();
  });

  it("non-numeric transitions fall back to always-emit and reset the EMA", () => {
    const bridge = makeBridge();
    bridge.start();
    vi.setSystemTime(0);
    fc.fireState(changed("sensor.power", "100"));
    vi.setSystemTime(1_000);
    fc.fireState(changed("sensor.power", "unavailable")); // type change ⇒ emit null
    vi.setSystemTime(2_000);
    fc.fireState(changed("sensor.power", "300")); // type change ⇒ emit, EMA restarts at 300
    vi.setSystemTime(20_000);
    fc.fireState(changed("sensor.power", "300"));
    const rows = store.query({ entityId: "sensor.power" });
    expect(rows.map((r) => r.normalized.value)).toEqual([100, null, 300, 300]);
    bridge.stop();
  });
});

describe("snapshots (initial + resync)", () => {
  it("initial snapshot with an empty store synthesizes baseline rows with origin ha", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireSnapshot({
      states: [haState("binary_sensor.door", "off"), haState("light.unrouted", "on")],
      reason: "initial",
      at: Date.now(),
    });
    const rows = store.query({ entityId: "binary_sensor.door" });
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("ha");
    expect(rows[0].normalized.value).toBe(false);
    expect(store.query({ entityId: "light.unrouted" })).toHaveLength(0);
    expect(bridge.stats().resyncSynthesized).toBe(0); // initial rows are not "resync"
    // cache replaced wholesale
    expect(bridge.stats().cacheSize).toBe(2);
    bridge.stop();
  });

  it("initial snapshot appends nothing when store.latest matches (pure-boot baseline)", () => {
    // Simulate a previous run that already recorded door=off.
    store.append({
      obsId: ulid(),
      entityId: "binary_sensor.door",
      at: Date.now() - 60_000,
      haTimeFired: Date.now() - 60_000,
      raw: haState("binary_sensor.door", "off"),
      normalized: { value: false, unit: null },
      origin: "ha",
      haVersion: "2026.7.1",
      policyVersion: 1,
    });
    const bridge = makeBridge();
    bridge.start();
    fc.fireSnapshot({
      states: [haState("binary_sensor.door", "off")],
      reason: "initial",
      at: Date.now(),
    });
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(1); // still only the old row

    // ...and the baseline seeds debouncing: an identical live event is suppressed.
    fc.fireState(changed("binary_sensor.door", "off"));
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(1);
    fc.fireState(changed("binary_sensor.door", "on"));
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(2);
    bridge.stop();
  });

  it("initial snapshot appends when store.latest differs", () => {
    store.append({
      obsId: ulid(),
      entityId: "binary_sensor.door",
      at: Date.now() - 60_000,
      haTimeFired: Date.now() - 60_000,
      raw: haState("binary_sensor.door", "on"),
      normalized: { value: true, unit: null },
      origin: "ha",
      haVersion: "2026.7.1",
      policyVersion: 1,
    });
    const bridge = makeBridge();
    bridge.start();
    fc.fireSnapshot({
      states: [haState("binary_sensor.door", "off")],
      reason: "initial",
      at: Date.now(),
    });
    const rows = store.query({ entityId: "binary_sensor.door", order: "desc" });
    expect(rows).toHaveLength(2);
    expect(rows[0].normalized.value).toBe(false);
    expect(rows[0].origin).toBe("ha");
    bridge.stop();
  });

  it("resync synthesizes origin resync rows only for drifted values", () => {
    const bridge = makeBridge();
    bridge.start();
    fc.fireState(changed("binary_sensor.door", "on"));
    fc.fireState(changed("sensor.grid_co2", "200"));
    // Reconnect: door changed while we were away, grid_co2 did not.
    fc.fireSnapshot({
      states: [haState("binary_sensor.door", "off"), haState("sensor.grid_co2", "200")],
      reason: "resync",
      at: Date.now(),
    });
    const doorRows = store.query({ entityId: "binary_sensor.door" });
    expect(doorRows).toHaveLength(2);
    expect(doorRows[1].origin).toBe("resync");
    expect(doorRows[1].normalized.value).toBe(false);
    expect(store.query({ entityId: "sensor.grid_co2" })).toHaveLength(1); // in sync ⇒ nothing
    expect(bridge.stats().resyncSynthesized).toBe(1);
    bridge.stop();
  });

  it("snapshot rows use last_updated as haTimeFired", () => {
    const bridge = makeBridge();
    bridge.start();
    const lastUpdated = "2026-07-19T08:30:00.000Z";
    fc.fireSnapshot({
      states: [haState("binary_sensor.door", "on", {}, lastUpdated)],
      reason: "initial",
      at: Date.now(),
    });
    const rows = store.query({ entityId: "binary_sensor.door" });
    expect(rows[0].haTimeFired).toBe(Date.parse(lastUpdated));
    bridge.stop();
  });
});

describe("onSignal tap", () => {
  it("fires after each appended row and never for suppressed ones", () => {
    const seen: SignalRow[] = [];
    const bridge = makeBridge({ onSignal: (row) => seen.push(row) });
    bridge.start();
    fc.fireState(changed("binary_sensor.door", "on"));
    fc.fireState(changed("binary_sensor.door", "on")); // suppressed
    fc.fireState(changed("binary_sensor.door", "off"));
    expect(seen.map((r) => r.normalized.value)).toEqual([true, false]);
    // The tap receives rows already persisted:
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(2);
    expect(seen[0].haVersion).toBe("2026.7.1");
    expect(seen[0].policyVersion).toBe(1);
    bridge.stop();
  });

  it("a throwing tap does not break ingestion", () => {
    const logs: string[] = [];
    const bridge = makeBridge({
      onSignal: () => {
        throw new Error("boom");
      },
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    bridge.start();
    fc.fireState(changed("binary_sensor.door", "on"));
    fc.fireState(changed("binary_sensor.door", "off"));
    expect(store.query({ entityId: "binary_sensor.door" })).toHaveLength(2);
    expect(logs.some((l) => l.startsWith("error:"))).toBe(true);
    bridge.stop();
  });
});

describe("retention sweep", () => {
  it("prunes on start and accumulates prunedTotal", () => {
    const now = Date.now();
    store.append({
      obsId: ulid(),
      entityId: "sensor.old",
      at: now - 40 * 864e5,
      haTimeFired: now - 40 * 864e5,
      raw: {},
      normalized: { value: 1, unit: null },
      origin: "ha",
      haVersion: null,
      policyVersion: 1,
    });
    const bridge = makeBridge({ retention: { days: 30, sweepIntervalMs: 60_000 } });
    bridge.start();
    expect(bridge.stats().prunedTotal).toBe(1);
    expect(store.query({ entityId: "sensor.old" })).toHaveLength(0);
    bridge.stop();
  });
});
