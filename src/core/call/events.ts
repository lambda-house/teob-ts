import type { CallId, CallError } from "./types.js";

export type CallLifecycleEvent<Req, Resp> =
  | { tag: "call_initiated"; callId: CallId; request: Req; attempt: number; epochMs: number }
  | { tag: "call_succeeded"; callId: CallId; response: Resp; attempt: number; epochMs: number }
  | {
      tag: "call_failed";
      callId: CallId;
      error: string;
      attempt: number;
      willRetry: boolean;
      nextRetryAtEpochMs?: number;
    }
  | { tag: "call_exhausted"; callId: CallId; lastError: string; totalAttempts: number };

export type DurableCallResult<Resp> =
  | { tag: "success"; response: Resp; attempt: number }
  | { tag: "failure"; error: CallError; attempt: number };
