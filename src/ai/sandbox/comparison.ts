import type { AgentRunRecording, RecordedToolExec } from "./types.js";
import type { SandboxResult } from "./runner.js";

export interface DriftReport {
  stateMatch: boolean;
  toolCallOrderMatch: boolean;
  totalStepsA: number;
  totalStepsB: number;
  divergenceStep?: number;
  details: string[];
}

export interface RunSummary {
  runId: string;
  scenarioId?: string;
  metrics: AgentRunRecording["metrics"];
  scores: Map<string, number>;
}

export interface MetricsComparison {
  tokenRange: [number, number];
  latencyRange: [number, number];
  toolCallRange: [number, number];
  llmCallRange: [number, number];
}

function toolCallSequence(rec: AgentRunRecording): RecordedToolExec[] {
  return rec.steps.filter((s): s is RecordedToolExec => s.type === "toolexec");
}

function jsonEq(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export const RunComparison = {
  compare(a: AgentRunRecording, b: AgentRunRecording): DriftReport {
    const details: string[] = [];

    const stateMatch = jsonEq(a.finalState, b.finalState);
    if (!stateMatch) details.push("finalState differs");

    let divergenceStep: number | undefined;
    const minLen = Math.min(a.steps.length, b.steps.length);
    for (let i = 0; i < minLen; i++) {
      const sa = a.steps[i];
      const sb = b.steps[i];
      if (sa.type !== sb.type) {
        divergenceStep = i;
        details.push(`step ${i}: type mismatch (${sa.type} vs ${sb.type})`);
        break;
      }
      if (sa.type === "toolexec" && sb.type === "toolexec") {
        if (sa.toolName !== sb.toolName) {
          divergenceStep = i;
          details.push(`step ${i}: toolName ${sa.toolName} vs ${sb.toolName}`);
          break;
        }
        if (!jsonEq(sa.arguments, sb.arguments)) {
          divergenceStep = i;
          details.push(`step ${i}: tool ${sa.toolName} arguments differ`);
          break;
        }
      } else if (sa.type === "llmcall" && sb.type === "llmcall") {
        if (sa.responseType !== sb.responseType) {
          divergenceStep = i;
          details.push(`step ${i}: responseType ${sa.responseType} vs ${sb.responseType}`);
          break;
        }
      }
    }

    if (a.steps.length !== b.steps.length && divergenceStep === undefined) {
      divergenceStep = minLen;
      details.push(`length mismatch: ${a.steps.length} vs ${b.steps.length}`);
    }

    const aSeq = toolCallSequence(a).map((s) => s.toolName);
    const bSeq = toolCallSequence(b).map((s) => s.toolName);
    const toolCallOrderMatch = aSeq.length === bSeq.length && aSeq.every((t, i) => t === bSeq[i]);
    if (!toolCallOrderMatch) details.push(`tool-call order differs: [${aSeq.join(",")}] vs [${bSeq.join(",")}]`);

    return {
      stateMatch,
      toolCallOrderMatch,
      totalStepsA: a.steps.length,
      totalStepsB: b.steps.length,
      divergenceStep,
      details,
    };
  },

  compareSummaries(results: SandboxResult[]): {
    summaries: RunSummary[];
    comparison: MetricsComparison;
  } {
    const summaries: RunSummary[] = results.map((r) => ({
      runId: r.runId,
      scenarioId: r.scenarioId,
      metrics: r.recording.metrics,
      scores: new Map(r.scores.map((s) => [s.evaluatorName, s.score])),
    }));
    if (summaries.length === 0) {
      return {
        summaries,
        comparison: {
          tokenRange: [0, 0],
          latencyRange: [0, 0],
          toolCallRange: [0, 0],
          llmCallRange: [0, 0],
        },
      };
    }
    const tokens = summaries.map((s) => s.metrics.totalTokens);
    const latencies = summaries.map((s) => s.metrics.totalLatencyMs);
    const toolCalls = summaries.map((s) => s.metrics.totalToolCalls);
    const llmCalls = summaries.map((s) => s.metrics.totalLLMCalls);
    return {
      summaries,
      comparison: {
        tokenRange: [Math.min(...tokens), Math.max(...tokens)],
        latencyRange: [Math.min(...latencies), Math.max(...latencies)],
        toolCallRange: [Math.min(...toolCalls), Math.max(...toolCalls)],
        llmCallRange: [Math.min(...llmCalls), Math.max(...llmCalls)],
      },
    };
  },
};
