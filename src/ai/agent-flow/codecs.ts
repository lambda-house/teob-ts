/**
 * Codecs for AgentFlow commands, events, replies, and state.
 */

import type { Codec } from "../../core/codec.js";
import { tagCodec } from "../../core/codec.js";
import type { AgentFlowCommand, AgentFlowEvent, AgentFlowReply, AgentFlowState, FlowStateSchema } from "./types.js";

// --- Command codec ---

export const agentFlowCommandCodec: Codec<AgentFlowCommand> = tagCodec<AgentFlowCommand>(
  "ProcessInput",
  "ContinueLLMResponse",
  "ContinueToolResults",
  "HandleLLMFailure",
  "RetryStep",
  "GetFlowState",
);

// --- Event codec ---

export const agentFlowEventCodec: Codec<AgentFlowEvent> = tagCodec<AgentFlowEvent>(
  "InputReceived",
  "LLMInvoked",
  "LLMResponded",
  "LLMFailed",
  "ToolInvoked",
  "ToolCompleted",
  "StateMutated",
  "FlowCompleted",
  "FlowFailed",
  "RetryScheduled",
);

// --- Reply codec ---

export const agentFlowReplyCodec: Codec<AgentFlowReply> = tagCodec<AgentFlowReply>(
  "FlowStarted",
  "FlowResult",
  "FlowError",
  "CurrentState",
);

// --- State codec factory ---

export function agentFlowStateCodec<S>(stateSchema: FlowStateSchema<S>): Codec<AgentFlowState<S>> {
  return {
    manifest() {
      return "AgentFlowState";
    },
    encode(value: AgentFlowState<S>): unknown {
      return {
        ...value,
        flowState: stateSchema.encode(value.flowState),
      };
    },
    decode(_manifest: string, data: unknown): AgentFlowState<S> {
      const raw = data as Record<string, unknown>;
      return {
        ...(raw as unknown as AgentFlowState<S>),
        flowState: stateSchema.decode(raw.flowState),
      };
    },
    manifests: ["AgentFlowState"],
  };
}
