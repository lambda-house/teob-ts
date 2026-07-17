import type { CallId } from "./types.js";

export type CallPhase<Resp> =
  | { tag: "idle" }
  | { tag: "pending"; callId: CallId; attempt: number; startedAtEpochMs: number }
  | { tag: "retry_scheduled"; callId: CallId; attempt: number; nextAtEpochMs: number }
  | { tag: "succeeded"; response: Resp; completedAtEpochMs: number }
  | { tag: "permanent_failure"; error: string }
  | { tag: "exhausted"; lastError: string; totalAttempts: number };

export const CallPhase = {
  idle: <R>(): CallPhase<R> => ({ tag: "idle" }),
  isTerminal: <R>(p: CallPhase<R>): boolean =>
    p.tag === "succeeded" || p.tag === "permanent_failure" || p.tag === "exhausted",
  needsRecoveryAction: <R>(p: CallPhase<R>): boolean =>
    p.tag === "pending" || p.tag === "retry_scheduled",
  isActive: <R>(p: CallPhase<R>): boolean =>
    p.tag === "pending" || p.tag === "retry_scheduled",
};
