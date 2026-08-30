// ha/bridge.ts — routes HA state_changed traffic into the SignalStore ring.
// Keeps a live cache of ALL entity states (never journaled), debounces routed
// entities per RouteSpec, and synthesizes baseline/resync rows on snapshots.

import type { HaClient } from "./client.js";
import type { HaEntityState, HaStateChangedEvent, HaStatesSnapshot } from "./types.js";
import type { NormalizedValue, SignalRow, SignalStore } from "./signal-store.js";
import { normalizeState } from "./normalize.js";
import { ulid } from "../core/ulid.js";

export type DebounceClass = "on-change" | "deadband" | "throttle-ema" | "slow-context";

export interface RouteParams {
  /** deadband: minimum |Δvalue| to emit. Required for "deadband". */
  deadband?: number;
  /** throttle-ema: EMA halflife. Default 10_000. */
  emaHalflifeMs?: number;
  /** throttle-ema: minimum spacing between emitted rows. Default 10_000. */
  emitIntervalMs?: number;
}

export interface RouteSpec { entityId: string; debounce: DebounceClass; params?: RouteParams; }

export interface HaBridgeStats {
  routedEntities: number;
  cacheSize: number;
  received: number;      // state_changed seen for routed entities
  appended: number;      // rows written after debounce
  suppressed: number;    // debounced away
  resyncSynthesized: number;
  lastSignalAt: number | null;
  prunedTotal: number;
}

export interface HaBridgeOptions {
  client: Pick<HaClient, "onStateChanged" | "onStatesSnapshot" | "stats">;
  store: SignalStore;
  routes: RouteSpec[];
  policyVersion?: number; // default 1
  /** Tap fired AFTER a row is appended — feeds SSE + (M1) aggregate commands. Must not throw. */
  onSignal?: (row: SignalRow) => void;
  retention?: { days: number; sweepIntervalMs?: number }; // default {days: 30, sweepIntervalMs: 3_600_000}
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

export interface HaBridge {
  start(): void; // subscribes; idempotent
  stop(): void;  // unsubscribes, clears the sweep timer
  /** Live cache of ALL entities ever seen (routed or not). Never journaled. */
  liveState(entityId: string): HaEntityState | undefined;
  liveCache(): ReadonlyMap<string, HaEntityState>;
  routedEntities(): string[];
  stats(): HaBridgeStats;
}

const LN2 = Math.LN2;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** True when the value changed type, or changed to/from null — always emits. */
function typeChanged(a: NormalizedValue["value"], b: NormalizedValue["value"]): boolean {
  if (a === null || b === null) return (a === null) !== (b === null);
  return typeof a !== typeof b;
}

interface RouteState {
  spec: RouteSpec;
  hasEmitted: boolean;
  lastEmitted: NormalizedValue["value"];
  /** store.latest() consulted once as boot baseline. */
  baselineChecked: boolean;
  // throttle-ema state
  ema: number | null;
  lastSampleAt: number | null;
  lastEmitAt: number | null;
}

export function createHaBridge(opts: HaBridgeOptions): HaBridge {
  const log = opts.log ?? (() => {});
  const policyVersion = opts.policyVersion ?? 1;
  const retentionDays = opts.retention?.days ?? 30;
  const sweepIntervalMs = opts.retention?.sweepIntervalMs ?? 3_600_000;

  const routeStates = new Map<string, RouteState>();
  for (const spec of opts.routes) {
    if (routeStates.has(spec.entityId)) {
      throw new Error(`Duplicate route for entity "${spec.entityId}"`);
    }
    routeStates.set(spec.entityId, {
      spec,
      hasEmitted: false,
      lastEmitted: null,
      baselineChecked: false,
      ema: null,
      lastSampleAt: null,
      lastEmitAt: null,
    });
  }

  const cache = new Map<string, HaEntityState>();

  let started = false;
  let unsubs: Array<() => void> = [];
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  const stats: HaBridgeStats = {
    routedEntities: routeStates.size,
    cacheSize: 0,
    received: 0,
    appended: 0,
    suppressed: 0,
    resyncSynthesized: 0,
    lastSignalAt: null,
    prunedTotal: 0,
  };

  function append(
    rs: RouteState,
    normalized: NormalizedValue,
    raw: unknown,
    at: number,
    haTimeFired: number,
    origin: SignalRow["origin"],
  ): void {
    const row: SignalRow = {
      obsId: ulid(),
      entityId: rs.spec.entityId,
      at,
      haTimeFired,
      raw,
      normalized,
      origin,
      haVersion: opts.client.stats.haVersion,
      policyVersion,
    };
    opts.store.append(row);
    stats.appended++;
    stats.lastSignalAt = at;
    rs.hasEmitted = true;
    rs.lastEmitted = normalized.value;
    if (opts.onSignal !== undefined) {
      try {
        opts.onSignal(row);
      } catch (err) {
        log("error", `onSignal tap threw: ${String(err)}`);
      }
    }
  }

  /** Seed EMA machinery from an emitted/baseline value. */
  function seedEma(rs: RouteState, value: NormalizedValue["value"], at: number): void {
    if (rs.spec.debounce !== "throttle-ema") return;
    rs.ema = typeof value === "number" ? value : null;
    rs.lastSampleAt = typeof value === "number" ? at : null;
    rs.lastEmitAt = at;
  }

  function handleStateChanged(e: HaStateChangedEvent): void {
    // Live cache tracks ALL entities.
    if (e.newState === null) {
      cache.delete(e.entityId);
    } else {
      cache.set(e.entityId, e.newState);
    }

    const rs = routeStates.get(e.entityId);
    if (rs === undefined) return;
    stats.received++;

    const at = Date.now();
    const nv: NormalizedValue =
      e.newState === null ? { value: null, unit: null } : normalizeState(e.newState);
    const v = nv.value;

    // First-ever sample or a type/null transition always emits (raw value).
    if (!rs.hasEmitted || typeChanged(v, rs.lastEmitted)) {
      if (rs.spec.debounce === "throttle-ema") {
        seedEma(rs, v, at);
        const emitValue = typeof v === "number" ? round3(v) : v;
        append(rs, { value: emitValue, unit: nv.unit }, e.newState, at, e.timeFired, "ha");
      } else {
        append(rs, nv, e.newState, at, e.timeFired, "ha");
      }
      return;
    }

    switch (rs.spec.debounce) {
      case "on-change":
      case "slow-context": {
        if (v !== rs.lastEmitted) {
          append(rs, nv, e.newState, at, e.timeFired, "ha");
        } else {
          stats.suppressed++;
        }
        break;
      }
      case "deadband": {
        if (typeof v === "number" && typeof rs.lastEmitted === "number") {
          const deadband = rs.spec.params?.deadband;
          if (deadband === undefined) {
            // Misconfigured route — fall back to on-change semantics.
            if (v !== rs.lastEmitted) append(rs, nv, e.newState, at, e.timeFired, "ha");
            else stats.suppressed++;
          } else if (Math.abs(v - rs.lastEmitted) >= deadband) {
            append(rs, nv, e.newState, at, e.timeFired, "ha");
          } else {
            stats.suppressed++;
          }
        } else if (v !== rs.lastEmitted) {
          append(rs, nv, e.newState, at, e.timeFired, "ha");
        } else {
          stats.suppressed++;
        }
        break;
      }
      case "throttle-ema": {
        if (typeof v !== "number") {
          // Non-numeric ⇒ on-change fallback (type transitions handled above,
          // so lastEmitted is non-numeric of the same type here).
          if (v !== rs.lastEmitted) append(rs, nv, e.newState, at, e.timeFired, "ha");
          else stats.suppressed++;
          break;
        }
        const halflifeMs = rs.spec.params?.emaHalflifeMs ?? 10_000;
        const emitIntervalMs = rs.spec.params?.emitIntervalMs ?? 10_000;
        if (rs.ema === null || rs.lastSampleAt === null) {
          rs.ema = v;
        } else {
          const dt = Math.max(0, at - rs.lastSampleAt);
          const alpha = 1 - Math.exp(-dt / (halflifeMs / LN2));
          rs.ema = rs.ema + alpha * (v - rs.ema);
        }
        rs.lastSampleAt = at;
        if (rs.lastEmitAt === null || at - rs.lastEmitAt >= emitIntervalMs) {
          rs.lastEmitAt = at;
          append(rs, { value: round3(rs.ema), unit: nv.unit }, e.newState, at, e.timeFired, "ha");
        } else {
          stats.suppressed++;
        }
        break;
      }
    }
  }

  function handleSnapshot(snap: HaStatesSnapshot): void {
    // Snapshots replace the whole live cache.
    cache.clear();
    for (const s of snap.states) cache.set(s.entity_id, s);

    for (const s of snap.states) {
      const rs = routeStates.get(s.entity_id);
      if (rs === undefined) continue;

      const nv = normalizeState(s);
      const at = Date.now();
      const parsed = Date.parse(s.last_updated);
      const haTimeFired = Number.isFinite(parsed) ? parsed : at;

      // Boot baseline: fall back to the last persisted row when nothing has
      // been emitted in-memory yet.
      if (!rs.hasEmitted && !rs.baselineChecked) {
        rs.baselineChecked = true;
        const latest = opts.store.latest(s.entity_id);
        if (latest !== undefined) {
          rs.hasEmitted = true;
          rs.lastEmitted = latest.normalized.value;
          seedEma(rs, latest.normalized.value, latest.at);
        }
      }

      if (rs.hasEmitted && nv.value === rs.lastEmitted) continue; // in sync — nothing to say

      const origin: SignalRow["origin"] = snap.reason === "initial" ? "ha" : "resync";
      seedEma(rs, nv.value, at);
      append(rs, nv, s, at, haTimeFired, origin);
      if (snap.reason === "resync") stats.resyncSynthesized++;
    }
  }

  function sweep(): void {
    try {
      stats.prunedTotal += opts.store.prune(retentionDays);
    } catch (err) {
      log("error", `retention sweep failed: ${String(err)}`);
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      unsubs.push(opts.client.onStateChanged(handleStateChanged));
      unsubs.push(opts.client.onStatesSnapshot(handleSnapshot));
      sweep();
      sweepTimer = setInterval(sweep, sweepIntervalMs);
      sweepTimer.unref?.();
    },

    stop(): void {
      if (!started) return;
      started = false;
      for (const u of unsubs) u();
      unsubs = [];
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    },

    liveState(entityId: string): HaEntityState | undefined {
      return cache.get(entityId);
    },

    liveCache(): ReadonlyMap<string, HaEntityState> {
      return cache;
    },

    routedEntities(): string[] {
      return [...routeStates.keys()];
    },

    stats(): HaBridgeStats {
      return { ...stats, cacheSize: cache.size };
    },
  };
}
