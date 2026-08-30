import { describe, it, expect } from "vitest";
import { DurableCallSlot } from "../../../src/core/call/slot.js";
import { CallId, type CallError } from "../../../src/core/call/types.js";
import type { CallPhase } from "../../../src/core/call/phase.js";
import type { CallLifecycleEvent, DurableCallResult } from "../../../src/core/call/events.js";
import type { CallGateway } from "../../../src/core/call/gateway.js";
import { DurableCall } from "../../../src/core/call/durable-call.js";
import type { EffectControl } from "../../../src/core/effect-control.js";
import { CategoryId, EntityId, TimerId } from "../../../src/core/types.js";
import { commandResultFromEffect } from "../../../src/testing/aggregate-testkit.js";

// --- shared fixtures ------------------------------------------------------

interface Req {
  v: number;
}
interface Resp {
  echoed: number;
}

type Cmd =
  | { tag: "callback"; result: DurableCallResult<Resp> }
  | { tag: "retry" };
type Event = { tag: "Lifecycle"; ev: CallLifecycleEvent<Req, Resp> };
interface State {
  phase: CallPhase<Resp>;
  request: Req;
}

const initialState: State = { phase: { tag: "idle" }, request: { v: 1 } };

function mockCtx(): { ctx: EffectControl<Cmd, unknown>; selfCommands: Cmd[]; timers: Array<{ id: string; cmd: Cmd; delay: number }> } {
  const selfCommands: Cmd[] = [];
  const timers: Array<{ id: string; cmd: Cmd; delay: number }> = [];
  const ctx: EffectControl<Cmd, unknown> = {
    entityId: "e1" as EntityId,
    categoryId: CategoryId("c"),
    async tellSelf(c) {
      selfCommands.push(c);
    },
    async tell() {},
    async ask() {
      return { ok: true, value: undefined };
    },
    async scheduleOnce(id, cmd, delay) {
      timers.push({ id, cmd, delay });
    },
    async schedulePeriodic() {},
    async cancelTimer() {},
    log() {},
    async sync() {},
  };
  return { ctx, selfCommands, timers };
}

function fakeGateway(impl: (req: Req, callId: CallId) => Promise<{ ok: true; value: Resp } | { ok: false; error: CallError }>): CallGateway {
  return {
    name: "gw",
    async execute(_call, request, callId) {
      return await impl(request as Req, callId);
    },
  };
}

function makeSlot(opts: {
  call: ReturnType<typeof DurableCall.of<Req, Resp>>;
  gateway: CallGateway;
  ctx: EffectControl<Cmd, unknown>;
  clock?: () => number;
}) {
  return DurableCallSlot.create<Cmd, State, Event, Req, Resp>({
    call: opts.call,
    gateway: opts.gateway,
    timerId: TimerId("retry"),
    getPhase: (s) => s.phase,
    setPhase: (s, p) => ({ ...s, phase: p }),
    getRequest: (s) => s.request,
    wrapEvent: (ev) => ({ tag: "Lifecycle", ev }),
    wrapCallback: (r) => ({ tag: "callback", result: r }),
    retryCmd: { tag: "retry" },
    ctx: opts.ctx,
    clock: opts.clock,
  });
}

// --- applyEvent -----------------------------------------------------------

describe("DurableCallSlot.applyEvent", () => {
  const callId = CallId.of("c-1");
  const call = DurableCall.of<Req, Resp>({
    name: "echo",
    execute: async (req) => ({ ok: true, value: { echoed: req.v } }),
  });
  const { ctx } = mockCtx();
  const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx });

  it("call_initiated → pending", () => {
    const s = slot.applyEvent(initialState, {
      tag: "call_initiated",
      callId,
      request: { v: 1 },
      attempt: 1,
      epochMs: 1000,
    });
    expect(s.phase.tag).toBe("pending");
    if (s.phase.tag === "pending") {
      expect(s.phase.callId).toBe(callId);
      expect(s.phase.attempt).toBe(1);
    }
  });

  it("call_succeeded → succeeded", () => {
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const s = slot.applyEvent(pending, {
      tag: "call_succeeded",
      callId,
      response: { echoed: 1 },
      attempt: 1,
      epochMs: 100,
    });
    expect(s.phase.tag).toBe("succeeded");
  });

  it("call_failed willRetry=true → retry_scheduled", () => {
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const s = slot.applyEvent(pending, {
      tag: "call_failed",
      callId,
      error: "boom",
      attempt: 1,
      willRetry: true,
      nextRetryAtEpochMs: 5000,
    });
    expect(s.phase.tag).toBe("retry_scheduled");
    if (s.phase.tag === "retry_scheduled") {
      expect(s.phase.nextAtEpochMs).toBe(5000);
    }
  });

  it("call_failed willRetry=false → permanent_failure", () => {
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const s = slot.applyEvent(pending, {
      tag: "call_failed",
      callId,
      error: "boom",
      attempt: 1,
      willRetry: false,
    });
    expect(s.phase.tag).toBe("permanent_failure");
  });

  it("call_exhausted → exhausted", () => {
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 5, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const s = slot.applyEvent(pending, {
      tag: "call_exhausted",
      callId,
      lastError: "bad",
      totalAttempts: 5,
    });
    expect(s.phase.tag).toBe("exhausted");
    if (s.phase.tag === "exhausted") expect(s.phase.totalAttempts).toBe(5);
  });
});

// --- handleCallback -------------------------------------------------------

describe("DurableCallSlot.handleCallback", () => {
  const callId = CallId.of("c-2");
  const call = DurableCall.of<Req, Resp>({
    name: "echo",
    execute: async () => ({ ok: true, value: { echoed: 0 } }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 10_000, strategy: { kind: "fixed" } },
  });

  it("success emits call_succeeded", async () => {
    const { ctx } = mockCtx();
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx, clock: () => 5000 });
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const eff = slot.handleCallback(pending, { tag: "success", response: { echoed: 1 }, attempt: 1 });
    const r = commandResultFromEffect(eff);
    expect(r.events).toHaveLength(1);
    const ev = (r.events[0] as Event).ev;
    expect(ev.tag).toBe("call_succeeded");
  });

  it("retryable + attempts left → call_failed willRetry=true and schedules timer", async () => {
    const { ctx, timers } = mockCtx();
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx, clock: () => 5000 });
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const eff = slot.handleCallback(pending, {
      tag: "failure",
      error: { type: "timeout", durationMs: 100 },
      attempt: 1,
    });
    const r = commandResultFromEffect(eff);
    const ev = (r.events[0] as Event).ev;
    expect(ev.tag).toBe("call_failed");
    if (ev.tag === "call_failed") {
      expect(ev.willRetry).toBe(true);
      expect(ev.nextRetryAtEpochMs).toBe(5100); // clock 5000 + initialDelay 100
    }
    // run the side-effect
    for (const se of r.sideEffects) await se();
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(100);
  });

  it("retryable but exhausted → call_exhausted", async () => {
    const { ctx } = mockCtx();
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx });
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 3, startedAtEpochMs: 0 }, // attempt == maxAttempts
      request: { v: 1 },
    };
    const eff = slot.handleCallback(pending, {
      tag: "failure",
      error: { type: "timeout", durationMs: 100 },
      attempt: 3,
    });
    const r = commandResultFromEffect(eff);
    const ev = (r.events[0] as Event).ev;
    expect(ev.tag).toBe("call_exhausted");
  });

  it("non-retryable error → call_failed willRetry=false (permanent_failure)", async () => {
    const { ctx } = mockCtx();
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx });
    const pending: State = {
      phase: { tag: "pending", callId, attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    const eff = slot.handleCallback(pending, {
      tag: "failure",
      error: { type: "http_status", code: 404, body: "not found" },
      attempt: 1,
    });
    const r = commandResultFromEffect(eff);
    const ev = (r.events[0] as Event).ev;
    expect(ev.tag).toBe("call_failed");
    if (ev.tag === "call_failed") expect(ev.willRetry).toBe(false);
  });

  it("ignored if not in pending phase", async () => {
    const { ctx } = mockCtx();
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx });
    const eff = slot.handleCallback(initialState, {
      tag: "success",
      response: { echoed: 1 },
      attempt: 1,
    });
    const r = commandResultFromEffect(eff);
    expect(r.events).toHaveLength(0);
  });
});

// --- recover --------------------------------------------------------------

describe("DurableCallSlot.recover", () => {
  it("retry_scheduled re-arms timer with remaining delay", async () => {
    const { ctx, timers } = mockCtx();
    const call = DurableCall.of<Req, Resp>({
      name: "x",
      execute: async () => ({ ok: true, value: { echoed: 1 } }),
    });
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx, clock: () => 1000 });
    const state: State = {
      phase: { tag: "retry_scheduled", callId: CallId.of("c"), attempt: 1, nextAtEpochMs: 1500 },
      request: { v: 1 },
    };
    await slot.recover(state);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(500);
  });

  it("retry_scheduled in past → schedules with delay 0", async () => {
    const { ctx, timers } = mockCtx();
    const call = DurableCall.of<Req, Resp>({
      name: "x",
      execute: async () => ({ ok: true, value: { echoed: 1 } }),
    });
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx, clock: () => 9999 });
    const state: State = {
      phase: { tag: "retry_scheduled", callId: CallId.of("c"), attempt: 1, nextAtEpochMs: 100 },
      request: { v: 1 },
    };
    await slot.recover(state);
    expect(timers[0].delay).toBe(0);
  });

  it("pending re-fires the call with the same callId", async () => {
    const seen: CallId[] = [];
    const { ctx, selfCommands } = mockCtx();
    const call = DurableCall.of<Req, Resp>({
      name: "x",
      execute: async () => ({ ok: true, value: { echoed: 99 } }),
    });
    const slot = makeSlot({
      call,
      gateway: fakeGateway(async (_req, callId) => {
        seen.push(callId);
        return { ok: true, value: { echoed: 99 } };
      }),
      ctx,
    });
    const state: State = {
      phase: { tag: "pending", callId: CallId.of("c-stable"), attempt: 1, startedAtEpochMs: 0 },
      request: { v: 1 },
    };
    await slot.recover(state);
    expect(seen).toEqual([CallId.of("c-stable")]);
    expect(selfCommands).toHaveLength(1);
  });

  it("terminal phases are no-op", async () => {
    const { ctx, timers, selfCommands } = mockCtx();
    const call = DurableCall.of<Req, Resp>({
      name: "x",
      execute: async () => ({ ok: true, value: { echoed: 1 } }),
    });
    const slot = makeSlot({ call, gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })), ctx });
    await slot.recover({
      phase: { tag: "succeeded", response: { echoed: 1 }, completedAtEpochMs: 0 },
      request: { v: 1 },
    });
    expect(timers).toHaveLength(0);
    expect(selfCommands).toHaveLength(0);
  });
});

// --- handleRetry ----------------------------------------------------------

describe("DurableCallSlot.handleRetry", () => {
  it("retry_scheduled → new call_initiated and gateway re-invoked", async () => {
    const { ctx, selfCommands } = mockCtx();
    const call = DurableCall.of<Req, Resp>({
      name: "x",
      execute: async () => ({ ok: true, value: { echoed: 1 } }),
    });
    const slot = makeSlot({
      call,
      gateway: fakeGateway(async () => ({ ok: true, value: { echoed: 1 } })),
      ctx,
      clock: () => 7000,
    });
    const state: State = {
      phase: { tag: "retry_scheduled", callId: CallId.of("k"), attempt: 1, nextAtEpochMs: 7000 },
      request: { v: 1 },
    };
    const eff = slot.handleRetry(state);
    const r = commandResultFromEffect(eff);
    expect(r.events).toHaveLength(1);
    const ev = (r.events[0] as Event).ev;
    expect(ev.tag).toBe("call_initiated");
    if (ev.tag === "call_initiated") expect(ev.attempt).toBe(2);
    for (const se of r.sideEffects) await se();
    expect(selfCommands).toHaveLength(1);
  });
});
