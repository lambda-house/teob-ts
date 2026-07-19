import { describe, it, expect } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../../src/core/call/circuit-breaker.js";

function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CircuitBreaker.protect", () => {
  it("starts closed; trips to open after maxFailures", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 3,
      resetTimeoutMs: 1000,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    expect(await cb.metrics.currentState()).toBe("closed");
    for (let i = 0; i < 3; i++) {
      await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    }
    expect(await cb.metrics.currentState()).toBe("open");
    expect(await cb.metrics.consecutiveFailures()).toBe(3);
  });

  it("rejects with CircuitOpenError when open", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 1000,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    await expect(cb.protect(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(await cb.metrics.totalRejections()).toBe(1);
  });

  it("transitions open → half_open after resetTimeoutMs", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 1000,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    expect(await cb.metrics.currentState()).toBe("open");
    clk.advance(1001);
    expect(await cb.metrics.currentState()).toBe("half_open");
  });

  it("half_open → closed on success; counters reset", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    clk.advance(101);
    const v = await cb.protect(() => Promise.resolve(42));
    expect(v).toBe(42);
    expect(await cb.metrics.currentState()).toBe("closed");
    expect(await cb.metrics.consecutiveFailures()).toBe(0);
  });

  it("half_open → open on failure", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    clk.advance(101);
    await expect(cb.protect(() => Promise.reject(new Error("y")))).rejects.toThrow();
    expect(await cb.metrics.currentState()).toBe("open");
  });

  it("rejects when half_open inflight at limit", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    clk.advance(101); // -> half_open

    let releaseFirst: (v: unknown) => void = () => {};
    const firstPromise = new Promise<number>((resolve) => {
      releaseFirst = resolve as (v: unknown) => void;
    });
    const inFlight = cb.protect(() => firstPromise);
    // attempt a second concurrent call while half_open is busy
    await expect(cb.protect(() => Promise.resolve(2))).rejects.toBeInstanceOf(CircuitOpenError);
    releaseFirst(1);
    await inFlight;
  });
});

describe("CircuitBreaker.protectEither", () => {
  it("treats result.ok=false with isFailure=true as failure", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 2,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    const op = async () =>
      ({ ok: false, error: { type: "http_status", code: 500, body: "" } } as const);
    await cb.protectEither(op, () => true);
    await cb.protectEither(op, () => true);
    expect(await cb.metrics.currentState()).toBe("open");
  });

  it("isFailure=false keeps breaker closed", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    const op = async () =>
      ({ ok: false, error: { type: "http_status", code: 400, body: "" } } as const);
    await cb.protectEither(op, () => false);
    expect(await cb.metrics.currentState()).toBe("closed");
  });
});

describe("CircuitBreaker.protectOrElse", () => {
  it("falls back when open", async () => {
    const clk = fakeClock();
    const cb = CircuitBreaker.create("svc", {
      maxFailures: 1,
      resetTimeoutMs: 1000,
      halfOpenMaxCalls: 1,
      clock: clk.now,
    });
    await expect(cb.protect(() => Promise.reject(new Error("x")))).rejects.toThrow();
    const v = await cb.protectOrElse(
      () => Promise.resolve("primary"),
      () => Promise.resolve("fallback"),
    );
    expect(v).toBe("fallback");
  });
});
