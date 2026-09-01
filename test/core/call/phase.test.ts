import { describe, it, expect } from "vitest";
import { CallPhase } from "../../../src/core/call/phase.js";
import { CallId } from "../../../src/core/call/types.js";

describe("CallPhase", () => {
  const cid = CallId.of("c1");

  it("isTerminal", () => {
    expect(CallPhase.isTerminal(CallPhase.idle())).toBe(false);
    expect(
      CallPhase.isTerminal({ tag: "pending", callId: cid, attempt: 1, startedAtEpochMs: 0 }),
    ).toBe(false);
    expect(
      CallPhase.isTerminal({
        tag: "retry_scheduled",
        callId: cid,
        attempt: 1,
        nextAtEpochMs: 1,
      }),
    ).toBe(false);
    expect(CallPhase.isTerminal({ tag: "succeeded", response: 1, completedAtEpochMs: 0 })).toBe(true);
    expect(CallPhase.isTerminal({ tag: "permanent_failure", error: "x" })).toBe(true);
    expect(CallPhase.isTerminal({ tag: "exhausted", lastError: "y", totalAttempts: 5 })).toBe(true);
  });

  it("needsRecoveryAction", () => {
    expect(CallPhase.needsRecoveryAction(CallPhase.idle())).toBe(false);
    expect(
      CallPhase.needsRecoveryAction({
        tag: "pending",
        callId: cid,
        attempt: 1,
        startedAtEpochMs: 0,
      }),
    ).toBe(true);
    expect(
      CallPhase.needsRecoveryAction({
        tag: "retry_scheduled",
        callId: cid,
        attempt: 1,
        nextAtEpochMs: 1,
      }),
    ).toBe(true);
    expect(
      CallPhase.needsRecoveryAction({ tag: "succeeded", response: 1, completedAtEpochMs: 0 }),
    ).toBe(false);
  });
});
