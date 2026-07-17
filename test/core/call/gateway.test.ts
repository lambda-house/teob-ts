import { describe, it, expect } from "vitest";
import { CallGateway } from "../../../src/core/call/gateway.js";
import { CallId, type CallResult } from "../../../src/core/call/types.js";
import { DurableCall } from "../../../src/core/call/durable-call.js";

const okCall = (value: unknown) =>
  DurableCall.of<unknown, unknown>({
    name: "ok",
    execute: async () => ({ ok: true, value }),
  });

const errCall = (code: number) =>
  DurableCall.of<unknown, unknown>({
    name: "err",
    execute: async () => ({ ok: false, error: { type: "http_status", code, body: "" } }),
  });

const slowCall = (delayMs: number) =>
  DurableCall.of<unknown, unknown>({
    name: "slow",
    execute: async () => {
      await new Promise((res) => setTimeout(res, delayMs));
      return { ok: true, value: null };
    },
  });

describe("CallGateway.execute", () => {
  it("happy path returns ok=true", async () => {
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const r = await gw.execute(okCall(42), undefined, CallId.generate());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("propagates failure", async () => {
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const r = await gw.execute(errCall(500), undefined, CallId.generate());
    expect(r.ok).toBe(false);
  });

  it("enforces timeout", async () => {
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 20 });
    const r: CallResult<unknown> = await gw.execute(slowCall(200), undefined, CallId.generate());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe("timeout");
  });

  it("semaphore caps concurrent inflight calls", async () => {
    let inflight = 0;
    let maxObserved = 0;
    const tracker = DurableCall.of<unknown, unknown>({
      name: "tracker",
      execute: async () => {
        inflight += 1;
        if (inflight > maxObserved) maxObserved = inflight;
        await new Promise((res) => setTimeout(res, 30));
        inflight -= 1;
        return { ok: true, value: null };
      },
    });
    const gw = CallGateway.create("g", { maxConcurrent: 2, callTimeoutMs: 1000 });
    const promises = [];
    for (let i = 0; i < 6; i++) {
      promises.push(gw.execute(tracker, undefined, CallId.generate()));
    }
    await Promise.all(promises);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("integrates with circuit breaker", async () => {
    const gw = CallGateway.create("g", {
      maxConcurrent: 5,
      callTimeoutMs: 1000,
      circuitBreaker: { maxFailures: 2, resetTimeoutMs: 1000, halfOpenMaxCalls: 1 },
    });
    const r1 = await gw.execute(errCall(500), undefined, CallId.generate());
    const r2 = await gw.execute(errCall(500), undefined, CallId.generate());
    const r3 = await gw.execute(errCall(500), undefined, CallId.generate());
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.type).toBe("circuit_open");
    expect(await gw.breaker?.metrics.currentState()).toBe("open");
  });
});
