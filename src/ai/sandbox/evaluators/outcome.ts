import type { RunEvaluator, EvalScore } from "../evaluator.js";
import type { AgentRunRecording } from "../types.js";
import type { ExpectedOutcome } from "../scenario.js";

/**
 * 1.0 if the recording's finalState satisfies expected.finalStatePredicate
 * (or if no predicate is set), else 0.0.
 */
export function OutcomeEvaluator(): RunEvaluator {
  return {
    name: "outcome",
    async evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore> {
      if (!expected?.finalStatePredicate) {
        return { evaluatorName: "outcome", score: 1, reasoning: "no predicate declared" };
      }
      const ok = !!expected.finalStatePredicate(recording.finalState);
      return {
        evaluatorName: "outcome",
        score: ok ? 1 : 0,
        reasoning: ok ? "predicate satisfied" : "predicate failed",
      };
    },
  };
}
