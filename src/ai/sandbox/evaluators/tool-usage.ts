import type { RunEvaluator, EvalScore } from "../evaluator.js";
import type { AgentRunRecording, RecordedToolExec } from "../types.js";
import type { ExpectedOutcome } from "../scenario.js";

/**
 * Penalises missing required tools and using forbidden tools. The two
 * sub-scores are averaged; if there are no constraints, returns 1.
 */
export function ToolUsageEvaluator(): RunEvaluator {
  return {
    name: "tool_usage",
    async evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore> {
      if (!expected) {
        return { evaluatorName: "tool_usage", score: 1, reasoning: "no expectations declared" };
      }
      const usedTools = new Set(
        recording.steps
          .filter((s): s is RecordedToolExec => s.type === "toolexec")
          .map((s) => s.toolName),
      );

      const required = expected.mustUseTools ?? new Set<string>();
      const forbidden = expected.mustNotUseTools ?? new Set<string>();
      const missing: string[] = [];
      for (const t of required) if (!usedTools.has(t)) missing.push(t);
      const usedForbidden: string[] = [];
      for (const t of forbidden) if (usedTools.has(t)) usedForbidden.push(t);

      let score: number;
      const parts: string[] = [];
      if (required.size > 0) {
        const requiredScore = (required.size - missing.length) / required.size;
        parts.push(`required ${required.size - missing.length}/${required.size}`);
        if (forbidden.size > 0) {
          const forbiddenScore = forbidden.size === 0 ? 1 : (forbidden.size - usedForbidden.length) / forbidden.size;
          parts.push(`forbidden ${usedForbidden.length} used`);
          score = (requiredScore + forbiddenScore) / 2;
        } else {
          score = requiredScore;
        }
      } else if (forbidden.size > 0) {
        score = (forbidden.size - usedForbidden.length) / forbidden.size;
        parts.push(`forbidden ${usedForbidden.length}/${forbidden.size} used`);
      } else {
        score = 1;
        parts.push("no constraints");
      }

      return {
        evaluatorName: "tool_usage",
        score,
        reasoning: parts.join("; "),
        metadata: { missing, usedForbidden, usedTools: [...usedTools] },
      };
    },
  };
}
