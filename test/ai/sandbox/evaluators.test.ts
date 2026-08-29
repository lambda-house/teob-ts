import { describe, it, expect } from "vitest";
import {
  EfficiencyEvaluator,
  ToolUsageEvaluator,
  OutcomeEvaluator,
  CustomChecksEvaluator,
  LLMCallBudgetEvaluator,
} from "../../../src/ai/sandbox/evaluators/index.js";
import type { AgentRunRecording } from "../../../src/ai/sandbox/types.js";

const baseRecording = (overrides: Partial<AgentRunRecording> = {}): AgentRunRecording => ({
  runId: "r",
  config: { model: "m", provider: "p", temperature: 0, maxTokens: 0 },
  steps: [],
  metrics: { totalLLMCalls: 0, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0 },
  startedAt: "t",
  ...overrides,
});

describe("EfficiencyEvaluator", () => {
  it("under budget gives high score", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 1, totalToolCalls: 0, totalTokens: 100, totalLatencyMs: 0 } });
    const e = EfficiencyEvaluator(1000);
    const s = await e.evaluate(r);
    expect(s.score).toBeCloseTo(0.9);
  });

  it("at budget gives 0", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 1, totalToolCalls: 0, totalTokens: 1000, totalLatencyMs: 0 } });
    const s = await EfficiencyEvaluator(1000).evaluate(r);
    expect(s.score).toBe(0);
  });

  it("over budget clamps to 0", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 1, totalToolCalls: 0, totalTokens: 9999, totalLatencyMs: 0 } });
    const s = await EfficiencyEvaluator(1000).evaluate(r);
    expect(s.score).toBe(0);
  });

  it("respects expected.maxTokens override", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 1, totalToolCalls: 0, totalTokens: 100, totalLatencyMs: 0 } });
    const s = await EfficiencyEvaluator(50).evaluate(r, { maxTokens: 1000 });
    expect(s.score).toBeCloseTo(0.9);
  });
});

describe("ToolUsageEvaluator", () => {
  it("no expectations → 1", async () => {
    const r = baseRecording();
    const s = await ToolUsageEvaluator().evaluate(r);
    expect(s.score).toBe(1);
  });

  it("required tools all used → 1", async () => {
    const r = baseRecording({
      steps: [
        {
          type: "toolexec",
          toolCallId: "1",
          toolName: "search",
          arguments: {},
          result: { success: true, output: null },
          latencyMs: 1,
        },
      ],
    });
    const s = await ToolUsageEvaluator().evaluate(r, { mustUseTools: new Set(["search"]) });
    expect(s.score).toBe(1);
  });

  it("required tool missing → < 1", async () => {
    const r = baseRecording();
    const s = await ToolUsageEvaluator().evaluate(r, { mustUseTools: new Set(["search"]) });
    expect(s.score).toBe(0);
  });

  it("forbidden tool used → < 1", async () => {
    const r = baseRecording({
      steps: [
        {
          type: "toolexec",
          toolCallId: "1",
          toolName: "delete",
          arguments: {},
          result: { success: true, output: null },
          latencyMs: 1,
        },
      ],
    });
    const s = await ToolUsageEvaluator().evaluate(r, { mustNotUseTools: new Set(["delete"]) });
    expect(s.score).toBe(0);
  });
});

describe("OutcomeEvaluator", () => {
  it("predicate satisfied → 1", async () => {
    const r = baseRecording({ finalState: { ok: true } });
    const s = await OutcomeEvaluator().evaluate(r, {
      finalStatePredicate: (s) => (s as { ok: boolean }).ok,
    });
    expect(s.score).toBe(1);
  });

  it("predicate fails → 0", async () => {
    const r = baseRecording({ finalState: { ok: false } });
    const s = await OutcomeEvaluator().evaluate(r, {
      finalStatePredicate: (s) => (s as { ok: boolean }).ok,
    });
    expect(s.score).toBe(0);
  });

  it("no predicate → 1", async () => {
    const r = baseRecording();
    const s = await OutcomeEvaluator().evaluate(r);
    expect(s.score).toBe(1);
  });
});

describe("CustomChecksEvaluator", () => {
  it("all pass → 1", async () => {
    const r = baseRecording({ finalState: 5 });
    const s = await CustomChecksEvaluator().evaluate(r, {
      customChecks: [
        { name: "is_number", check: (x) => typeof x === "number" },
        { name: "is_positive", check: (x) => (x as number) > 0 },
      ],
    });
    expect(s.score).toBe(1);
  });

  it("partial pass → fraction", async () => {
    const r = baseRecording({ finalState: -5 });
    const s = await CustomChecksEvaluator().evaluate(r, {
      customChecks: [
        { name: "is_number", check: (x) => typeof x === "number" },
        { name: "is_positive", check: (x) => (x as number) > 0 },
      ],
    });
    expect(s.score).toBe(0.5);
    expect(s.reasoning).toContain("is_positive");
  });

  it("thrown check counts as fail", async () => {
    const r = baseRecording();
    const s = await CustomChecksEvaluator().evaluate(r, {
      customChecks: [
        {
          name: "throws",
          check: () => {
            throw new Error("nope");
          },
        },
      ],
    });
    expect(s.score).toBe(0);
  });
});

describe("LLMCallBudgetEvaluator", () => {
  it("within budget → 1", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 3, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0 } });
    const s = await LLMCallBudgetEvaluator(5).evaluate(r);
    expect(s.score).toBe(1);
  });

  it("over budget degrades", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 8, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0 } });
    const s = await LLMCallBudgetEvaluator(5).evaluate(r);
    expect(s.score).toBeLessThan(1);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });

  it("absurdly over → 0", async () => {
    const r = baseRecording({ metrics: { totalLLMCalls: 999, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0 } });
    const s = await LLMCallBudgetEvaluator(5).evaluate(r);
    expect(s.score).toBe(0);
  });
});
