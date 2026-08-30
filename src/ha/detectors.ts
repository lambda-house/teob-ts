// ha/detectors.ts — pure, rebuildable detector state machines.
// M0: exported + tested, NOT wired into the bridge. All state is plain
// JSON-serializable data; step() is pure (same state + sample ⇒ same result).

export interface DetectorSample { at: number; value: number; obsId: string; }
export interface DetectorEvent<T extends string = string> { tag: T; at: number; obsId: string; value: number; }
export interface Detector<S, T extends string> {
  init(): S;
  /** Pure: same (state, sample) ⇒ same result. */
  step(state: S, sample: DetectorSample): { state: S; out: Array<DetectorEvent<T>> };
}

const LN2 = Math.LN2;

// ---------------------------------------------------------------------------
// relativeRise — rise vs an EWMA baseline
// ---------------------------------------------------------------------------

export interface RelativeRiseState {
  ema: number | null; lastAt: number | null; firstAt: number | null;
  phase: "idle" | "risen";
}

/**
 * Rise vs an EWMA baseline. Baseline is FROZEN while phase==="risen" (steam
 * must not poison it). No output until warmupMs after the first sample.
 * Rise: value >= ema*(1+risePct/100) ⇒ "RiseDetected".
 * Clear: value <= ema*(1+clearPct/100) ⇒ "RiseCleared".
 */
export function relativeRise(params: {
  baselineHalflifeMs: number;
  risePct: number;
  clearPct: number;
  warmupMs?: number; // default 600_000
}): Detector<RelativeRiseState, "RiseDetected" | "RiseCleared"> {
  const warmupMs = params.warmupMs ?? 600_000;

  return {
    init(): RelativeRiseState {
      return { ema: null, lastAt: null, firstAt: null, phase: "idle" };
    },

    step(state, sample) {
      const out: Array<DetectorEvent<"RiseDetected" | "RiseCleared">> = [];
      const { at, value, obsId } = sample;

      // First sample seeds the baseline.
      if (state.ema === null || state.lastAt === null || state.firstAt === null) {
        return { state: { ema: value, lastAt: at, firstAt: at, phase: "idle" }, out };
      }

      const warm = at - state.firstAt >= warmupMs;
      let { ema, lastAt, phase } = state;

      if (phase === "risen") {
        if (value <= ema * (1 + params.clearPct / 100)) {
          phase = "idle";
          out.push({ tag: "RiseCleared", at, obsId, value });
          // Baseline unfreezes: absorb the clearing sample.
          const alpha = 1 - Math.exp(-Math.max(0, at - lastAt) / (params.baselineHalflifeMs / LN2));
          ema = ema + alpha * (value - ema);
          lastAt = at;
        }
        // else: still risen — baseline stays frozen (ema/lastAt untouched).
      } else {
        if (warm && value >= ema * (1 + params.risePct / 100)) {
          // Rise detected against the pre-sample baseline; freeze it.
          phase = "risen";
          out.push({ tag: "RiseDetected", at, obsId, value });
        } else {
          const alpha = 1 - Math.exp(-Math.max(0, at - lastAt) / (params.baselineHalflifeMs / LN2));
          ema = ema + alpha * (value - ema);
          lastAt = at;
        }
      }

      return { state: { ema, lastAt, firstAt: state.firstAt, phase }, out };
    },
  };
}

// ---------------------------------------------------------------------------
// incrementWatcher — monotone-counter watcher
// ---------------------------------------------------------------------------

export interface IncrementWatcherState { anchorAt: number | null; anchorValue: number | null; }

/**
 * Monotone-counter watcher: emits "IncrementDetected" (value = delta) when
 * value - anchor >= minIncrement within windowMs, then re-anchors. Counter
 * reset (value < anchor) or window expiry re-anchors silently.
 */
export function incrementWatcher(params: {
  minIncrement: number;
  windowMs: number;
}): Detector<IncrementWatcherState, "IncrementDetected"> {
  return {
    init(): IncrementWatcherState {
      return { anchorAt: null, anchorValue: null };
    },

    step(state, sample) {
      const out: Array<DetectorEvent<"IncrementDetected">> = [];
      const { at, value, obsId } = sample;

      if (state.anchorAt === null || state.anchorValue === null) {
        return { state: { anchorAt: at, anchorValue: value }, out };
      }

      // Counter reset — re-anchor silently.
      if (value < state.anchorValue) {
        return { state: { anchorAt: at, anchorValue: value }, out };
      }

      // Window expiry — re-anchor silently at the current sample.
      if (at - state.anchorAt > params.windowMs) {
        return { state: { anchorAt: at, anchorValue: value }, out };
      }

      const delta = value - state.anchorValue;
      if (delta >= params.minIncrement) {
        out.push({ tag: "IncrementDetected", at, obsId, value: delta });
        return { state: { anchorAt: at, anchorValue: value }, out };
      }

      return { state, out };
    },
  };
}

// ---------------------------------------------------------------------------
// sustainedAbove — threshold with sustain confirmation
// ---------------------------------------------------------------------------

export interface SustainedAboveState { phase: "idle" | "pending" | "active"; pendingSince: number | null; }

/**
 * "ThresholdSustained" once a sample arrives with value >= threshold AND
 * (at - pendingSince) >= sustainMs; "ThresholdCleared" when active and
 * value < (clearBelow ?? threshold). Sample-driven only: confirmation latency
 * is bounded by routing cadence — documented, accepted.
 */
export function sustainedAbove(params: {
  threshold: number;
  sustainMs: number;
  clearBelow?: number;
}): Detector<SustainedAboveState, "ThresholdSustained" | "ThresholdCleared"> {
  const clearBelow = params.clearBelow ?? params.threshold;

  return {
    init(): SustainedAboveState {
      return { phase: "idle", pendingSince: null };
    },

    step(state, sample) {
      const out: Array<DetectorEvent<"ThresholdSustained" | "ThresholdCleared">> = [];
      const { at, value, obsId } = sample;

      switch (state.phase) {
        case "idle": {
          if (value >= params.threshold) {
            return { state: { phase: "pending", pendingSince: at }, out };
          }
          return { state, out };
        }
        case "pending": {
          if (value < params.threshold) {
            return { state: { phase: "idle", pendingSince: null }, out };
          }
          if (state.pendingSince !== null && at - state.pendingSince >= params.sustainMs) {
            out.push({ tag: "ThresholdSustained", at, obsId, value });
            return { state: { phase: "active", pendingSince: null }, out };
          }
          return { state, out };
        }
        case "active": {
          if (value < clearBelow) {
            out.push({ tag: "ThresholdCleared", at, obsId, value });
            return { state: { phase: "idle", pendingSince: null }, out };
          }
          return { state, out };
        }
      }
    },
  };
}
