import type { LLMResponseMeta } from "../llm/types.js";
import type { MCPToolResult } from "../tool/types.js";

export type SandboxMode =
  | { kind: "live" }
  | { kind: "replay"; recording: AgentRunRecording }
  | { kind: "simulated" };

export interface RecordingConfig {
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
}

export interface RunMetrics {
  totalLLMCalls: number;
  totalToolCalls: number;
  totalTokens: number;
  totalLatencyMs: number;
  totalCostUsd?: number;
}

export type AgentOutcome =
  | { tag: "ok" }
  | { tag: "denied_security" }
  | { tag: "needs_clarification" }
  | { tag: "unsupported" }
  | { tag: "internal_error" }
  | { tag: "failed"; reason: string };

export interface RecordedLLMCall {
  type: "llmcall";
  requestId: string;
  messages: unknown;
  tools: string[];
  responseType: "content" | "tool_calls";
  content: string | null;
  toolCalls: unknown;
  meta: LLMResponseMeta;
  /** Wall clock timestamp at completion (ISO). Used for chronological interleaving. */
  completedAt?: string;
}

export interface RecordedToolExec {
  type: "toolexec";
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: MCPToolResult;
  latencyMs: number;
  /** Wall clock timestamp at completion (ISO). Used for chronological interleaving. */
  completedAt?: string;
}

export type RecordedInteraction = RecordedLLMCall | RecordedToolExec;

export interface AgentRunRecording {
  runId: string;
  scenario?: string;
  config: RecordingConfig;
  steps: RecordedInteraction[];
  metrics: RunMetrics;
  finalState?: unknown;
  startedAt: string;
  completedAt?: string;
}
