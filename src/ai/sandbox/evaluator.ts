import type { AgentRunRecording } from "./types.js";
import type { ExpectedOutcome } from "./scenario.js";

export interface EvalScore {
  evaluatorName: string;
  score: number; // 0..1
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

export interface RunEvaluator {
  readonly name: string;
  evaluate(recording: AgentRunRecording, expected?: ExpectedOutcome): Promise<EvalScore>;
}
