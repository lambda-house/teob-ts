/**
 * Agent Flow types — commands, events, replies, state, and configuration
 * for LLM-driven agent flow aggregates.
 */

import type { EntityId } from "../../core/types.js";
import type { MCPToolDefinition } from "../tool/types.js";
import type { ResponseSchema } from "../llm/types.js";

// --- Flow Status ---

export type FlowStatus = "Idle" | "Processing" | "WaitingForTools" | "WaitingForRetry" | "Completed" | "Failed";

// --- Configuration ---

export interface AgentFlowConfig {
  model: string;
  provider?: string;
  temperature?: number;       // default 0.7
  maxTokens?: number;         // default 4096
  maxToolRounds?: number;     // default 10
  maxRetries?: number;        // default 3
  retryBaseDelayMs?: number;  // default 5000
  tokenBudget?: number;       // optional
  requestTimeoutMs?: number;  // default 60000
}

// --- User State Management ---

export interface FlowStateSchema<S> {
  initial(id: EntityId): S;
  encode(state: S): unknown;
  decode(json: unknown): S;
}

// --- Context Builder ---

export interface FlowContextBuilder<S> {
  buildContext(
    input: unknown,
    state: S,
    pendingMessages: unknown[],
    tools: MCPToolDefinition[],
  ): Promise<unknown[]>;
}

// --- Response Handler ---

export interface FlowResponseHandler<S> {
  responseSchema?: ResponseSchema;
  parseAndApply(state: S, response: string): Promise<{ state: S; explanation: string; isDone: boolean }>;
}

// --- Metrics ---

export interface FlowMetrics {
  totalLLMCalls: number;
  totalToolCalls: number;
  totalTokensUsed: number;
  totalLatencyMs: number;
}

// --- Tool Execution Result ---

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  latencyMs: number;
}

// --- Commands ---

export type AgentFlowCommand =
  | { tag: "ProcessInput"; input: unknown; timestamp: Date }
  | { tag: "ContinueLLMResponse"; requestId: string; response: import("../llm/types.js").LLMToolResponse; promptTokens: number; completionTokens: number; totalTokens: number; latencyMs: number }
  | { tag: "ContinueToolResults"; requestId: string; results: ToolExecutionResult[]; assistantMessage: unknown }
  | { tag: "HandleLLMFailure"; requestId: string; error: string; retryCount: number }
  | { tag: "RetryStep"; requestId: string; retryCount: number }
  | { tag: "GetFlowState" };

// --- Events ---

export type AgentFlowEvent =
  | { tag: "InputReceived"; requestId: string; input: unknown }
  | { tag: "LLMInvoked"; requestId: string; model: string; temperature: number; messagesJson: unknown[]; tools: string[]; responseSchema: unknown; requestedAt: string }
  | { tag: "LLMResponded"; requestId: string; model: string; text: string | undefined; toolCalls: unknown[] | undefined; promptTokens: number; completionTokens: number; totalTokens: number; latencyMs: number; respondedAt: string }
  | { tag: "LLMFailed"; requestId: string; error: string; failedAt: string; retryCount: number }
  | { tag: "ToolInvoked"; requestId: string; toolName: string; toolInput: unknown; executedAt: string }
  | { tag: "ToolCompleted"; requestId: string; toolName: string; result: unknown; latencyMs: number; completedAt: string }
  | { tag: "StateMutated"; requestId: string; flowStateJson: unknown; mutatedAt: string }
  | { tag: "FlowCompleted"; requestId: string; output: unknown; totalLLMCalls: number; totalToolCalls: number; totalTokens: number; totalLatencyMs: number }
  | { tag: "FlowFailed"; requestId: string; error: string; failedAt: string; totalLLMCalls: number; totalTokens: number }
  | { tag: "RetryScheduled"; requestId: string; reason: string; retryCount: number; scheduledAt: string; nextRetryAt: string };

// --- Replies ---

export type AgentFlowReply =
  | { tag: "FlowStarted"; aggregateId: EntityId }
  | { tag: "FlowResult"; aggregateId: EntityId; result: unknown; metrics: FlowMetrics }
  | { tag: "FlowError"; aggregateId: EntityId; error: string; metrics: FlowMetrics }
  | { tag: "CurrentState"; aggregateId: EntityId; flowState: unknown; status: FlowStatus; metrics: FlowMetrics };

// --- State ---

export interface AgentFlowState<S> {
  id: EntityId;
  flowState: S;
  status: FlowStatus;
  currentRequestId?: string;
  pendingMessages: unknown[];
  retryCount: number;
  toolRoundCount: number;
  totalLLMCalls: number;
  totalToolCalls: number;
  totalTokensUsed: number;
  totalLatencyMs: number;
  lastError?: string;
}
