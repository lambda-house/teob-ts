// Agent Flow — LLM-driven agent flow aggregates
export type {
  FlowStatus,
  AgentFlowConfig,
  FlowStateSchema,
  FlowContextBuilder,
  FlowResponseHandler,
  FlowMetrics,
  ToolExecutionResult,
  AgentFlowCommand,
  AgentFlowEvent,
  AgentFlowReply,
  AgentFlowState,
} from "./types.js";

export type { AgentFlowAggregateDeps } from "./agent-flow-aggregate.js";
export { agentFlowAggregate } from "./agent-flow-aggregate.js";

export {
  agentFlowCommandCodec,
  agentFlowEventCodec,
  agentFlowReplyCodec,
  agentFlowStateCodec,
} from "./codecs.js";
