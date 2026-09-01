// runner — poll/nudge loop driving projections against a journal
//
// Each cycle delegates to the existing runProjection / runMultiStreamProjection,
// so incremental offset tracking and rebuild semantics are preserved verbatim.
// Known accepted inefficiency: runProjection rescans allEvents per cycle; M0
// journal volume (audit only) makes this fine. Do NOT optimize in M0 — a
// queryEvents-based incremental path is an M1 task.

import type { Codec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";
import {
  type MultiStreamProjection,
  type Projection,
  type ProjectionStore,
  type SingleStreamProjection,
  rebuildMultiStreamProjection,
  rebuildProjection,
  runMultiStreamProjection,
  runProjection,
} from "./index.js";

export interface ProjectionEntry {
  projection: Projection<any, any>;
  eventCodec?: Codec<any>;
}

export interface ProjectionRunnerOptions {
  entries: ProjectionEntry[];
  journal: Journal;
  store: ProjectionStore;
  pollIntervalMs?: number; // default 2_000
  /** Health surface: fired after every completed cycle. */
  onCycle?: (info: { at: number; durationMs: number }) => void;
  /** Default: console.error; a throwing projection must not kill the loop. */
  onError?: (err: unknown) => void;
}

export interface ProjectionRunner {
  /** Idempotent; timers unref()d. */
  start(): void;
  /** Waits for an in-flight cycle. */
  stop(): Promise<void>;
  /** Coalesced immediate cycle: if idle, run now (microtask); if mid-cycle, run once more after. */
  nudge(): void;
  /** One synchronous pass over all entries (used by tests and boot catch-up). */
  runOnce(): void;
  /** store.clear + full re-run for one projection. Throws if projectionId is unknown. */
  rebuild(projectionId: string): void;
  stats(): { lastCycleAt: number | null; lastCycleDurationMs: number | null; cycles: number };
}

function isMultiStream(p: Projection<any, any>): p is MultiStreamProjection<any, any> {
  return "sources" in p;
}

export function createProjectionRunner(opts: ProjectionRunnerOptions): ProjectionRunner {
  const { entries, journal, store } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const onError = opts.onError ?? ((err: unknown) => console.error("[projection-runner]", err));

  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let running = false; // a cycle is executing right now (re-entrancy guard for nudge)
  let nudgeRequested = false; // a nudge arrived mid-cycle → run once more after
  let scheduled = false; // an immediate cycle is already queued on the microtask queue

  let cycles = 0;
  let lastCycleAt: number | null = null;
  let lastCycleDurationMs: number | null = null;

  function cycle(): void {
    running = true;
    const at = Date.now();
    const t0 = performance.now();
    try {
      for (const entry of entries) {
        try {
          if (isMultiStream(entry.projection)) {
            runMultiStreamProjection(entry.projection, journal, store, {
              eventCodec: entry.eventCodec,
            });
          } else {
            runProjection(entry.projection as SingleStreamProjection<any, any>, journal, store, {
              eventCodec: entry.eventCodec,
            });
          }
        } catch (err) {
          onError(err);
        }
      }
    } finally {
      running = false;
    }
    const durationMs = performance.now() - t0;
    cycles += 1;
    lastCycleAt = at;
    lastCycleDurationMs = durationMs;
    try {
      opts.onCycle?.({ at, durationMs });
    } catch (err) {
      onError(err);
    }
    if (nudgeRequested) {
      nudgeRequested = false;
      scheduleImmediate();
    }
  }

  function scheduleImmediate(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped) return;
      if (running) {
        // A cycle is somehow underway (re-entrant scheduling); run once more after it.
        nudgeRequested = true;
        return;
      }
      cycle();
    });
  }

  return {
    start(): void {
      stopped = false;
      if (interval) return;
      interval = setInterval(() => {
        if (!running) cycle();
      }, pollIntervalMs);
      interval.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      nudgeRequested = false;
      // Cycles are synchronous; drain any already-queued immediate cycle so that
      // callers observe "no cycle in flight" after stop() resolves.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    },

    nudge(): void {
      if (stopped) return;
      if (running) {
        nudgeRequested = true;
        return;
      }
      scheduleImmediate();
    },

    runOnce(): void {
      cycle();
    },

    rebuild(projectionId: string): void {
      const entry = entries.find((e) => e.projection.projectionId === projectionId);
      if (!entry) throw new Error(`Unknown projection: ${projectionId}`);
      if (isMultiStream(entry.projection)) {
        rebuildMultiStreamProjection(entry.projection, journal, store, {
          eventCodec: entry.eventCodec,
        });
      } else {
        rebuildProjection(entry.projection as SingleStreamProjection<any, any>, journal, store, {
          eventCodec: entry.eventCodec,
        });
      }
    },

    stats() {
      return { lastCycleAt, lastCycleDurationMs, cycles };
    },
  };
}
