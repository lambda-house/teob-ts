/**
 * DurableCallSlot — encapsulates the boilerplate of running a single
 * DurableCall as part of an aggregate's lifecycle.
 *
 * The aggregate keeps a `CallPhase<Resp>` field in its state. The slot
 * provides:
 *   - initiate(state, callId): emit call_initiated, mark pending
 *   - fire(state):              actually invoke the gateway (Effect.run)
 *   - handleCallback(state, r): emit call_succeeded / call_failed / call_exhausted
 *   - handleRetry(state):       on timer tick, transition retry_scheduled → pending and re-fire
 *   - applyEvent(state, ev):    pure state transition for any lifecycle event
 *   - recover(state):           re-arm timers / re-fire pending after a crash
 */

import type { Effect } from "../effect.js";
import { persist, run, andRun } from "../effect.js";
import type { EffectControl } from "../effect-control.js";
import type { TimerId } from "../types.js";
import type { CallPhase } from "./phase.js";
import type { CallId } from "./types.js";
import { errorToString, isTransient } from "./types.js";
import type { CallLifecycleEvent, DurableCallResult } from "./events.js";
import type { DurableCall } from "./durable-call.js";
import type { CallGateway } from "./gateway.js";
import { RetryPolicy } from "./retry.js";

export interface DurableCallSlotOpts<Cmd, State, Event, Req, Resp> {
  call: DurableCall<Req, Resp>;
  gateway: CallGateway;
  timerId: TimerId;
  getPhase: (s: State) => CallPhase<Resp>;
  setPhase: (s: State, p: CallPhase<Resp>) => State;
  getRequest: (s: State) => Req;
  wrapEvent: (e: CallLifecycleEvent<Req, Resp>) => Event;
  wrapCallback: (r: DurableCallResult<Resp>) => Cmd;
  retryCmd: Cmd;
  ctx: EffectControl<Cmd, unknown>;
  /** Optional clock injection for tests. */
  clock?: () => number;
}

export interface DurableCallSlot<Cmd, State, Event, Req, Resp> {
  initiate(state: State, callId: CallId): Effect<Event, unknown>;
  fire(state: State): Promise<void>;
  handleCallback(state: State, result: DurableCallResult<Resp>): Effect<Event, unknown>;
  handleRetry(state: State): Effect<Event, unknown>;
  applyEvent(state: State, event: CallLifecycleEvent<Req, Resp>): State;
  recover(state: State): Promise<void>;
}

export const DurableCallSlot = {
  create<Cmd, State, Event, Req, Resp>(
    opts: DurableCallSlotOpts<Cmd, State, Event, Req, Resp>,
  ): DurableCallSlot<Cmd, State, Event, Req, Resp> {
    return createSlot(opts);
  },
};

function createSlot<Cmd, State, Event, Req, Resp>(
  opts: DurableCallSlotOpts<Cmd, State, Event, Req, Resp>,
): DurableCallSlot<Cmd, State, Event, Req, Resp> {
  const clock = opts.clock ?? (() => Date.now());
  const isRetryable = opts.call.isRetryable ?? isTransient;

  async function fireOnce(state: State): Promise<void> {
    const phase = opts.getPhase(state);
    if (phase.tag !== "pending") return;
    const callId = phase.callId;
    const attempt = phase.attempt;
    const request = opts.getRequest(state);
    let result: DurableCallResult<Resp>;
    try {
      const r = await opts.gateway.execute(opts.call, request, callId);
      result = r.ok
        ? { tag: "success", response: r.value, attempt }
        : { tag: "failure", error: r.error, attempt };
    } catch (err) {
      result = {
        tag: "failure",
        error: { type: "custom", message: `slot fire threw: ${String(err)}`, cause: err },
        attempt,
      };
    }
    await opts.ctx.tellSelf(opts.wrapCallback(result));
  }

  return {
    initiate(state, callId) {
      const now = clock();
      const event: CallLifecycleEvent<Req, Resp> = {
        tag: "call_initiated",
        callId,
        request: opts.getRequest(state),
        attempt: 1,
        epochMs: now,
      };
      const persistEffect = persist<Event, unknown>(opts.wrapEvent(event));
      return andRun(persistEffect, async () => {
        // Re-read latest state would be ideal, but we don't have it here;
        // rely on aggregate runtime to apply the event before this Run executes
        // is not guaranteed. Instead, we reconstruct fire from the just-emitted
        // event: at this moment we know callId/attempt/request.
        try {
          const r = await opts.gateway.execute(opts.call, event.request, callId);
          const result: DurableCallResult<Resp> = r.ok
            ? { tag: "success", response: r.value, attempt: 1 }
            : { tag: "failure", error: r.error, attempt: 1 };
          await opts.ctx.tellSelf(opts.wrapCallback(result));
        } catch (err) {
          await opts.ctx.tellSelf(
            opts.wrapCallback({
              tag: "failure",
              error: { type: "custom", message: `slot fire threw: ${String(err)}`, cause: err },
              attempt: 1,
            }),
          );
        }
      });
    },

    async fire(state) {
      await fireOnce(state);
    },

    handleCallback(state, result): Effect<Event, unknown> {
      const phase = opts.getPhase(state);
      if (phase.tag !== "pending") {
        // ignored — we are not awaiting any call
        return persist<Event, unknown>();
      }
      const { callId, attempt } = phase;
      if (result.tag === "success") {
        const ev: CallLifecycleEvent<Req, Resp> = {
          tag: "call_succeeded",
          callId,
          response: result.response,
          attempt,
          epochMs: clock(),
        };
        return persist<Event, unknown>(opts.wrapEvent(ev));
      }
      // failure
      const err = result.error;
      const retryable = isRetryable(err);
      const moreAttemptsLeft = attempt < opts.call.retryPolicy.maxAttempts;
      if (retryable && moreAttemptsLeft) {
        const delay = RetryPolicy.delayFor(opts.call.retryPolicy, attempt);
        const nextAt = clock() + delay;
        const failEvent: CallLifecycleEvent<Req, Resp> = {
          tag: "call_failed",
          callId,
          error: errorToString(err),
          attempt,
          willRetry: true,
          nextRetryAtEpochMs: nextAt,
        };
        const persistEffect = persist<Event, unknown>(opts.wrapEvent(failEvent));
        return andRun(persistEffect, async () => {
          await opts.ctx.scheduleOnce(opts.timerId, opts.retryCmd, delay);
        });
      }
      if (!retryable) {
        const failEvent: CallLifecycleEvent<Req, Resp> = {
          tag: "call_failed",
          callId,
          error: errorToString(err),
          attempt,
          willRetry: false,
        };
        return persist<Event, unknown>(opts.wrapEvent(failEvent));
      }
      // retryable but exhausted
      const exhausted: CallLifecycleEvent<Req, Resp> = {
        tag: "call_exhausted",
        callId,
        lastError: errorToString(err),
        totalAttempts: attempt,
      };
      return persist<Event, unknown>(opts.wrapEvent(exhausted));
    },

    handleRetry(state): Effect<Event, unknown> {
      const phase = opts.getPhase(state);
      if (phase.tag !== "retry_scheduled") return persist<Event, unknown>();
      const callId = phase.callId;
      const nextAttempt = phase.attempt + 1;
      const now = clock();
      const ev: CallLifecycleEvent<Req, Resp> = {
        tag: "call_initiated",
        callId,
        request: opts.getRequest(state),
        attempt: nextAttempt,
        epochMs: now,
      };
      const persistEffect = persist<Event, unknown>(opts.wrapEvent(ev));
      return andRun(persistEffect, async () => {
        try {
          const r = await opts.gateway.execute(opts.call, ev.request, callId);
          const result: DurableCallResult<Resp> = r.ok
            ? { tag: "success", response: r.value, attempt: nextAttempt }
            : { tag: "failure", error: r.error, attempt: nextAttempt };
          await opts.ctx.tellSelf(opts.wrapCallback(result));
        } catch (err) {
          await opts.ctx.tellSelf(
            opts.wrapCallback({
              tag: "failure",
              error: { type: "custom", message: `slot retry threw: ${String(err)}`, cause: err },
              attempt: nextAttempt,
            }),
          );
        }
      });
    },

    applyEvent(state, event): State {
      const phase = opts.getPhase(state);
      switch (event.tag) {
        case "call_initiated": {
          // could be initial or retry; both transition to pending
          return opts.setPhase(state, {
            tag: "pending",
            callId: event.callId,
            attempt: event.attempt,
            startedAtEpochMs: event.epochMs,
          });
        }
        case "call_succeeded":
          return opts.setPhase(state, {
            tag: "succeeded",
            response: event.response,
            completedAtEpochMs: event.epochMs,
          });
        case "call_failed": {
          if (event.willRetry && event.nextRetryAtEpochMs !== undefined) {
            const callId =
              phase.tag === "pending" || phase.tag === "retry_scheduled" ? phase.callId : event.callId;
            return opts.setPhase(state, {
              tag: "retry_scheduled",
              callId,
              attempt: event.attempt,
              nextAtEpochMs: event.nextRetryAtEpochMs,
            });
          }
          return opts.setPhase(state, { tag: "permanent_failure", error: event.error });
        }
        case "call_exhausted":
          return opts.setPhase(state, {
            tag: "exhausted",
            lastError: event.lastError,
            totalAttempts: event.totalAttempts,
          });
      }
    },

    async recover(state) {
      const phase = opts.getPhase(state);
      if (phase.tag === "pending") {
        // Re-fire with the same callId (idempotent w/ external system)
        const callId = phase.callId;
        const attempt = phase.attempt;
        try {
          const r = await opts.gateway.execute(opts.call, opts.getRequest(state), callId);
          const result: DurableCallResult<Resp> = r.ok
            ? { tag: "success", response: r.value, attempt }
            : { tag: "failure", error: r.error, attempt };
          await opts.ctx.tellSelf(opts.wrapCallback(result));
        } catch (err) {
          await opts.ctx.tellSelf(
            opts.wrapCallback({
              tag: "failure",
              error: { type: "custom", message: `slot recover threw: ${String(err)}`, cause: err },
              attempt,
            }),
          );
        }
        return;
      }
      if (phase.tag === "retry_scheduled") {
        const remaining = Math.max(0, phase.nextAtEpochMs - clock());
        await opts.ctx.scheduleOnce(opts.timerId, opts.retryCmd, remaining);
        return;
      }
      // terminal phases: nothing to do.
    },
  };
}
