/**
 * Integration test: DurableCall slot inside an aggregate, end-to-end via
 * InMemoryAggregateRuntime. Exercises the success, retry-then-success,
 * permanent-failure, and exhaustion paths.
 */

import { describe, it, expect } from "vitest";
import type { Aggregate } from "../../../src/core/aggregate.js";
import { CategoryId, EntityId, TimerId } from "../../../src/core/types.js";
import { tagCodec } from "../../../src/core/codec.js";
import { persist, reply } from "../../../src/core/effect.js";
import { createSingleRuntime } from "../../../src/inmem/runtime.js";
import { CallGateway } from "../../../src/core/call/gateway.js";
import { CallId, type CallError } from "../../../src/core/call/types.js";
import { DurableCall } from "../../../src/core/call/durable-call.js";
import { DurableCallSlot } from "../../../src/core/call/slot.js";
import type { CallPhase } from "../../../src/core/call/phase.js";
import type { CallLifecycleEvent, DurableCallResult } from "../../../src/core/call/events.js";
import { categoryTypes } from "../../../src/core/effect-control.js";

interface Req {
  v: number;
}
interface Resp {
  echoed: number;
}

type Cmd =
  | { tag: "Start"; req: Req }
  | { tag: "GetState" }
  | { tag: "Callback"; result: DurableCallResult<Resp> }
  | { tag: "Retry" };

type Reply = { tag: "started" } | { tag: "state"; phase: CallPhase<Resp> };

type Event = { tag: "Lifecycle"; ev: CallLifecycleEvent<Req, Resp> };

interface State {
  request?: Req;
  phase: CallPhase<Resp>;
}

function makeAggregate(opts: {
  call: ReturnType<typeof DurableCall.of<Req, Resp>>;
  gateway: CallGateway;
}): Aggregate<Cmd, Reply, Event, State> {
  const buildSlot = (state: State, ctx: Parameters<Aggregate<Cmd, Reply, Event, State>["decide"]>[2]) =>
    DurableCallSlot.create<Cmd, State, Event, Req, Resp>({
      call: opts.call,
      gateway: opts.gateway,
      timerId: TimerId("retry"),
      getPhase: (s) => s.phase,
      setPhase: (s, p) => ({ ...s, phase: p }),
      getRequest: (s) => s.request!,
      wrapEvent: (ev) => ({ tag: "Lifecycle", ev }),
      wrapCallback: (r) => ({ tag: "Callback", result: r }),
      retryCmd: { tag: "Retry" },
      ctx,
    });

  return {
    category: CategoryId("dc-test"),
    initial: () => ({ phase: { tag: "idle" } }),
    async decide(state, cmd, ctx) {
      switch (cmd.tag) {
        case "Start": {
          const startedState: State = { ...state, request: cmd.req };
          const slot = buildSlot(startedState, ctx);
          const initiateEffect = slot.initiate(startedState, CallId.generate());
          // Add reply at the end of the chain
          const { andReply } = await import("../../../src/core/effect.js");
          return andReply(initiateEffect, { tag: "started" });
        }
        case "GetState":
          return reply<Event, Reply>({ tag: "state", phase: state.phase });
        case "Callback": {
          const slot = buildSlot(state, ctx);
          return slot.handleCallback(state, cmd.result);
        }
        case "Retry": {
          const slot = buildSlot(state, ctx);
          return slot.handleRetry(state);
        }
      }
    },
    apply(state, event) {
      // Capture request from the first call_initiated event so it survives
      // event-replay even if the aggregate state itself is rebuilt cold.
      let s = state;
      if (event.ev.tag === "call_initiated" && s.request === undefined) {
        s = { ...s, request: event.ev.request };
      }
      const slot = DurableCallSlot.create<Cmd, State, Event, Req, Resp>({
        call: opts.call,
        gateway: opts.gateway,
        timerId: TimerId("retry"),
        getPhase: (x) => x.phase,
        setPhase: (x, p) => ({ ...x, phase: p }),
        getRequest: (x) => x.request!,
        wrapEvent: (ev) => ({ tag: "Lifecycle", ev }),
        wrapCallback: (r) => ({ tag: "Callback", result: r }),
        retryCmd: { tag: "Retry" },
        ctx: undefined as never,
      });
      return slot.applyEvent(s, event.ev);
    },
  };
}

const cat = categoryTypes<Cmd, Reply>(CategoryId("dc-test"));

async function waitForState<P extends State["phase"]["tag"]>(
  runtime: ReturnType<typeof createSingleRuntime<Cmd, Reply, Event, State>>["runtime"],
  id: EntityId,
  predicate: (phase: CallPhase<Resp>) => boolean,
  timeoutMs = 2000,
): Promise<CallPhase<Resp>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await runtime.ask(id, { tag: "GetState" }, cat);
    if (r.ok && r.value.reply?.tag === "state") {
      const phase = r.value.reply.phase;
      if (predicate(phase)) return phase;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("timeout waiting for phase");
}

describe("DurableCall + InMemory runtime — integration", () => {
  it("happy path: start → succeeded", async () => {
    const call = DurableCall.of<Req, Resp>({
      name: "echo",
      execute: async (req) => ({ ok: true, value: { echoed: req.v * 2 } }),
    });
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const agg = makeAggregate({ call, gateway: gw });
    const { runtime } = createSingleRuntime(
      agg,
      tagCodec<Event>("Lifecycle"),
      tagCodec<State>("State") as unknown as ReturnType<typeof tagCodec<State>>,
    );
    const id = "e1" as EntityId;
    const r = await runtime.ask(id, { tag: "Start", req: { v: 21 } }, cat);
    expect(r.ok).toBe(true);
    const phase = await waitForState(runtime, id, (p) => p.tag === "succeeded");
    expect(phase.tag).toBe("succeeded");
    if (phase.tag === "succeeded") expect(phase.response.echoed).toBe(42);
    await runtime.shutdown();
  });

  it("permanent failure on 4xx (non-retryable)", async () => {
    const call = DurableCall.of<Req, Resp>({
      name: "fail",
      execute: async () => ({ ok: false, error: { type: "http_status", code: 400, body: "bad" } }),
    });
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const agg = makeAggregate({ call, gateway: gw });
    const { runtime } = createSingleRuntime(
      agg,
      tagCodec<Event>("Lifecycle"),
      tagCodec<State>("State") as unknown as ReturnType<typeof tagCodec<State>>,
    );
    const id = "e2" as EntityId;
    await runtime.ask(id, { tag: "Start", req: { v: 1 } }, cat);
    const phase = await waitForState(runtime, id, (p) => p.tag === "permanent_failure");
    expect(phase.tag).toBe("permanent_failure");
    await runtime.shutdown();
  });

  it("retry then succeed", async () => {
    let calls = 0;
    const call = DurableCall.of<Req, Resp>({
      name: "flaky",
      execute: async (req) => {
        calls += 1;
        if (calls < 3) {
          return { ok: false, error: { type: "timeout", durationMs: 1 } };
        }
        return { ok: true, value: { echoed: req.v } };
      },
      retryPolicy: { maxAttempts: 5, initialDelayMs: 5, maxDelayMs: 100, strategy: { kind: "fixed" } },
    });
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const agg = makeAggregate({ call, gateway: gw });
    const { runtime } = createSingleRuntime(
      agg,
      tagCodec<Event>("Lifecycle"),
      tagCodec<State>("State") as unknown as ReturnType<typeof tagCodec<State>>,
    );
    const id = "e3" as EntityId;
    await runtime.ask(id, { tag: "Start", req: { v: 7 } }, cat);
    const phase = await waitForState(runtime, id, (p) => p.tag === "succeeded", 5000);
    expect(phase.tag).toBe("succeeded");
    expect(calls).toBeGreaterThanOrEqual(3);
    await runtime.shutdown();
  });

  it("exhaustion when retryable repeats past maxAttempts", async () => {
    const call = DurableCall.of<Req, Resp>({
      name: "always-timeout",
      execute: async () => ({ ok: false, error: { type: "timeout", durationMs: 1 } }),
      retryPolicy: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 100, strategy: { kind: "fixed" } },
    });
    const gw = CallGateway.create("g", { maxConcurrent: 5, callTimeoutMs: 1000 });
    const agg = makeAggregate({ call, gateway: gw });
    const { runtime } = createSingleRuntime(
      agg,
      tagCodec<Event>("Lifecycle"),
      tagCodec<State>("State") as unknown as ReturnType<typeof tagCodec<State>>,
    );
    const id = "e4" as EntityId;
    await runtime.ask(id, { tag: "Start", req: { v: 0 } }, cat);
    const phase = await waitForState(runtime, id, (p) => p.tag === "exhausted", 3000);
    expect(phase.tag).toBe("exhausted");
    if (phase.tag === "exhausted") expect(phase.totalAttempts).toBe(2);
    await runtime.shutdown();
  });
});
