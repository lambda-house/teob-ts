import type { RunEvaluator, EvalScore } from "../evaluator.js";
import type { AgentRunRecording } from "../types.js";
import type { ExpectedOutcome } from "../scenario.js";

/**
 * Penalises high token usage. score = max(0, 1 - totalTokens / budget),
 * where budget = expected.maxTokens ?? defaultBudget.
 */
export function EfficiencyEvaluator(defaultBudget: number): RunEvaluator {
  return {
    name: "efficiency",
    async evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore> {
      const budget = expected?.maxTokens ?? defaultBudget;
      if (budget <= 0) {
        return { evaluatorName: "efficiency", score: 0, reasoning: "budget non-positive" };
      }
      const tokens = recording.metrics.totalTokens;
      const score = Math.max(0, 1 - tokens / budget);
      return {
        evaluatorName: "efficiency",
        score,
        reasoning: `tokens ${tokens}/${budget}`,
        metadata: { tokens, budget },
      };
    },
  };
}
