import { describe, it, expect } from "vitest";
import { RunComparison } from "../../../src/ai/sandbox/comparison.js";
import type { AgentRunRecording } from "../../../src/ai/sandbox/types.js";

const baseConfig = { model: "m", provider: "p", temperature: 0, maxTokens: 0 };

function recWithToolNames(names: string[], finalState: unknown = null): AgentRunRecording {
  return {
    runId: "r",
    config: baseConfig,
    steps: names.map((n, i) => ({
      type: "toolexec" as const,
      toolCallId: `tc${i}`,
      toolName: n,
      arguments: {},
      result: { success: true, output: null },
      latencyMs: 1,
    })),
    metrics: {
      totalLLMCalls: 0,
      totalToolCalls: names.length,
      totalTokens: 0,
      totalLatencyMs: names.length,
    },
    finalState,
    startedAt: "t",
  };
}

describe("RunComparison.compare", () => {
  it("identical recordings → no drift", () => {
    const a = recWithToolNames(["s", "fetch"], { ok: true });
    const b = recWithToolNames(["s", "fetch"], { ok: true });
    const r = RunComparison.compare(a, b);
    expect(r.stateMatch).toBe(true);
    expect(r.toolCallOrderMatch).toBe(true);
    expect(r.divergenceStep).toBeUndefined();
  });

  it("flags different tool args at correct step", () => {
    const a: AgentRunRecording = {
      ...recWithToolNames(["s"]),
      steps: [
        {
          type: "toolexec",
          toolCallId: "1",
          toolName: "s",
          arguments: { q: "alpha" },
          result: { success: true, output: null },
          latencyMs: 1,
        },
      ],
    };
    const b: AgentRunRecording = {
      ...recWithToolNames(["s"]),
      steps: [
        {
          type: "toolexec",
          toolCallId: "1",
          toolName: "s",
          arguments: { q: "beta" },
          result: { success: true, output: null },
          latencyMs: 1,
        },
      ],
    };
    const r = RunComparison.compare(a, b);
    expect(r.divergenceStep).toBe(0);
  });

  it("flags state mismatch", () => {
    const a = recWithToolNames(["x"], { ok: true });
    const b = recWithToolNames(["x"], { ok: false });
    const r = RunComparison.compare(a, b);
    expect(r.stateMatch).toBe(false);
  });
});

describe("RunComparison.compareSummaries", () => {
  it("returns metric ranges", () => {
    const r1 = {
      runId: "1",
      scenarioId: "s",
      recording: recWithToolNames(["a"]),
      scores: [{ evaluatorName: "x", score: 0.5 }],
      timestamp: "t",
    };
    const r2 = {
      runId: "2",
      scenarioId: "s",
      recording: recWithToolNames(["a", "b", "c"]),
      scores: [{ evaluatorName: "x", score: 0.7 }],
      timestamp: "t",
    };
    const out = RunComparison.compareSummaries([r1, r2]);
    expect(out.summaries).toHaveLength(2);
    expect(out.comparison.toolCallRange).toEqual([1, 3]);
  });

  it("empty input returns zeroed ranges", () => {
    const out = RunComparison.compareSummaries([]);
    expect(out.summaries).toHaveLength(0);
    expect(out.comparison.tokenRange).toEqual([0, 0]);
  });
});
