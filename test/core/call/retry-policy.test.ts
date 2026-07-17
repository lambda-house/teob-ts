import { describe, it, expect } from "vitest";
import { RetryPolicy } from "../../../src/core/call/retry.js";

describe("RetryPolicy.delayFor", () => {
  it("fibonacci sequence × initialDelay", () => {
    const p: ReturnType<typeof RetryPolicy.default> = {
      maxAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 1_000_000,
      strategy: { kind: "fibonacci" },
    };
    // F: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55
    expect(RetryPolicy.delayFor(p, 1)).toBe(1000);
    expect(RetryPolicy.delayFor(p, 2)).toBe(1000);
    expect(RetryPolicy.delayFor(p, 3)).toBe(2000);
    expect(RetryPolicy.delayFor(p, 4)).toBe(3000);
    expect(RetryPolicy.delayFor(p, 5)).toBe(5000);
    expect(RetryPolicy.delayFor(p, 6)).toBe(8000);
  });

  it("fibonacci capped by maxDelayMs", () => {
    const p = {
      maxAttempts: 20,
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      strategy: { kind: "fibonacci" as const },
    };
    expect(RetryPolicy.delayFor(p, 5)).toBe(4000); // F_5=5 → 5000 capped to 4000
    expect(RetryPolicy.delayFor(p, 10)).toBe(4000);
  });

  it("exponential factor=2 doubles", () => {
    const p = {
      maxAttempts: 10,
      initialDelayMs: 100,
      maxDelayMs: 1_000_000,
      strategy: { kind: "exponential" as const, factor: 2 },
    };
    expect(RetryPolicy.delayFor(p, 1)).toBe(100);
    expect(RetryPolicy.delayFor(p, 2)).toBe(200);
    expect(RetryPolicy.delayFor(p, 3)).toBe(400);
    expect(RetryPolicy.delayFor(p, 5)).toBe(1600);
  });

  it("exponential capped", () => {
    const p = {
      maxAttempts: 10,
      initialDelayMs: 100,
      maxDelayMs: 500,
      strategy: { kind: "exponential" as const, factor: 2 },
    };
    expect(RetryPolicy.delayFor(p, 4)).toBe(500); // 800 capped
  });

  it("fixed always initialDelayMs", () => {
    const p = {
      maxAttempts: 5,
      initialDelayMs: 250,
      maxDelayMs: 999_999,
      strategy: { kind: "fixed" as const },
    };
    expect(RetryPolicy.delayFor(p, 1)).toBe(250);
    expect(RetryPolicy.delayFor(p, 5)).toBe(250);
  });

  it("attempt < 1 returns 0", () => {
    expect(RetryPolicy.delayFor(RetryPolicy.default(), 0)).toBe(0);
  });

  it("default has maxAttempts=10, fibonacci", () => {
    const p = RetryPolicy.default();
    expect(p.maxAttempts).toBe(10);
    expect(p.strategy.kind).toBe("fibonacci");
  });
});
