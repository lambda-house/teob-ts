import type { CallError } from "./types.js";
import { CallError as Err } from "./types.js";

export interface CircuitBreakerConfig {
  maxFailures: number;
  resetTimeoutMs: number;
  halfOpenMaxCalls: number;
}

export const defaultCircuitBreakerConfig = (): CircuitBreakerConfig => ({
  maxFailures: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
});

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerMetrics {
  currentState(): Promise<CircuitState>;
  consecutiveFailures(): Promise<number>;
  totalFailures(): Promise<number>;
  totalSuccesses(): Promise<number>;
  totalRejections(): Promise<number>;
}

export type EitherResult<A, E> = { ok: true; value: A } | { ok: false; error: E };

export interface CircuitBreaker {
  readonly name: string;
  protect<A>(op: () => Promise<A>): Promise<A>;
  protectOrElse<A>(op: () => Promise<A>, fallback: () => Promise<A>): Promise<A>;
  protectEither<A, E>(
    op: () => Promise<EitherResult<A, E>>,
    isFailure: (e: E) => boolean,
  ): Promise<EitherResult<A, E>>;
  metrics: CircuitBreakerMetrics;
}

interface BreakerInternalState {
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  totalRejections: number;
  openedAtMs: number; // when state turned to 'open'
  halfOpenInflight: number;
}

export interface CreateCircuitBreakerOpts extends CircuitBreakerConfig {
  clock?: () => number;
}

export class CircuitOpenError extends Error {
  readonly tag = "CircuitOpen" as const;
  constructor(public breakerName: string) {
    super(`circuit_open: ${breakerName}`);
  }
}

export const CircuitBreaker = {
  create(name: string, cfg: CreateCircuitBreakerOpts): CircuitBreaker {
    return createCircuitBreakerImpl(name, cfg);
  },
};

function createCircuitBreakerImpl(
  name: string,
  cfg: CreateCircuitBreakerOpts,
): CircuitBreaker {
  const clock = cfg.clock ?? (() => Date.now());
  const state: BreakerInternalState = {
    state: "closed",
    consecutiveFailures: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    totalRejections: 0,
    openedAtMs: 0,
    halfOpenInflight: 0,
  };

  function maybeTransitionFromOpen(): void {
    if (state.state !== "open") return;
    const now = clock();
    if (now >= state.openedAtMs + cfg.resetTimeoutMs) {
      state.state = "half_open";
      state.halfOpenInflight = 0;
    }
  }

  function tryAcquire(): { ok: true } | { ok: false } {
    maybeTransitionFromOpen();
    if (state.state === "open") {
      state.totalRejections += 1;
      return { ok: false };
    }
    if (state.state === "half_open") {
      if (state.halfOpenInflight >= cfg.halfOpenMaxCalls) {
        state.totalRejections += 1;
        return { ok: false };
      }
      state.halfOpenInflight += 1;
    }
    return { ok: true };
  }

  function recordSuccess(): void {
    state.totalSuccesses += 1;
    state.consecutiveFailures = 0;
    if (state.state === "half_open") {
      state.halfOpenInflight = Math.max(0, state.halfOpenInflight - 1);
      state.state = "closed";
    }
  }

  function recordFailure(): void {
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    if (state.state === "half_open") {
      state.halfOpenInflight = Math.max(0, state.halfOpenInflight - 1);
      state.state = "open";
      state.openedAtMs = clock();
      return;
    }
    if (state.state === "closed" && state.consecutiveFailures >= cfg.maxFailures) {
      state.state = "open";
      state.openedAtMs = clock();
    }
  }

  return {
    name,
    async protect<A>(op: () => Promise<A>): Promise<A> {
      const acq = tryAcquire();
      if (!acq.ok) throw new CircuitOpenError(name);
      try {
        const v = await op();
        recordSuccess();
        return v;
      } catch (err) {
        recordFailure();
        throw err;
      }
    },
    async protectOrElse<A>(op: () => Promise<A>, fallback: () => Promise<A>): Promise<A> {
      const acq = tryAcquire();
      if (!acq.ok) return await fallback();
      try {
        const v = await op();
        recordSuccess();
        return v;
      } catch {
        recordFailure();
        return await fallback();
      }
    },
    async protectEither<A, E>(
      op: () => Promise<EitherResult<A, E>>,
      isFailure: (e: E) => boolean,
    ): Promise<EitherResult<A, E>> {
      const acq = tryAcquire();
      if (!acq.ok) {
        return {
          ok: false,
          error: Err.circuitOpen(name) as unknown as E,
        };
      }
      try {
        const r = await op();
        if (r.ok) {
          recordSuccess();
        } else if (isFailure(r.error)) {
          recordFailure();
        } else {
          recordSuccess();
        }
        return r;
      } catch (err) {
        recordFailure();
        throw err;
      }
    },
    metrics: {
      async currentState() {
        maybeTransitionFromOpen();
        return state.state;
      },
      async consecutiveFailures() {
        return state.consecutiveFailures;
      },
      async totalFailures() {
        return state.totalFailures;
      },
      async totalSuccesses() {
        return state.totalSuccesses;
      },
      async totalRejections() {
        return state.totalRejections;
      },
    },
  };
}

/** Convenience: tells whether a CallError should count as a "failure" against the breaker. */
export function defaultIsCallErrorFailure(_e: CallError): boolean {
  return true;
}
