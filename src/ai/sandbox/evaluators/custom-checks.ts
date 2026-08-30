import type { RunEvaluator, EvalScore } from "../evaluator.js";
import type { AgentRunRecording } from "../types.js";
import type { ExpectedOutcome } from "../scenario.js";

/**
 * Score = (passingChecks / totalChecks). Reasoning lists names of checks
 * that failed.
 */
export function CustomChecksEvaluator(): RunEvaluator {
  return {
    name: "custom_checks",
    async evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore> {
      const checks = expected?.customChecks ?? [];
      if (checks.length === 0) {
        return { evaluatorName: "custom_checks", score: 1, reasoning: "no checks declared" };
      }
      const failed: string[] = [];
      for (const c of checks) {
        let ok = false;
        try {
          ok = !!c.check(recording.finalState);
        } catch {
          ok = false;
        }
        if (!ok) failed.push(c.name);
      }
      const score = (checks.length - failed.length) / checks.length;
      return {
        evaluatorName: "custom_checks",
        score,
        reasoning: failed.length > 0 ? `failed: ${failed.join(", ")}` : "all passed",
        metadata: { failed },
      };
    },
  };
}
