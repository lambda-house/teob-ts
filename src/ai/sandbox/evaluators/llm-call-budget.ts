import type { RunEvaluator, EvalScore } from "../evaluator.js";
import type { AgentRunRecording } from "../types.js";
import type { ExpectedOutcome } from "../scenario.js";

/**
 * 1.0 if totalLLMCalls ≤ max; otherwise linear degradation toward 0
 * proportional to the overrun (capped at 0).
 */
export function LLMCallBudgetEvaluator(defaultMax: number): RunEvaluator {
  return {
    name: "llm_call_budget",
    async evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore> {
      const max = expected?.maxLLMCalls ?? defaultMax;
      if (max <= 0) return { evaluatorName: "llm_call_budget", score: 0, reasoning: "max non-positive" };
      const calls = recording.metrics.totalLLMCalls;
      const score = calls <= max ? 1 : Math.max(0, 1 - (calls - max) / max);
      return {
        evaluatorName: "llm_call_budget",
        score,
        reasoning: `calls ${calls}/${max}`,
        metadata: { calls, max },
      };
    },
  };
}
