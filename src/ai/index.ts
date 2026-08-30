// LLM
export type { LLMService } from "./llm/llm-service.js";
export { withDefaults as withLLMDefaults } from "./llm/llm-service.js";
export type {
  ChatMessage,
  ModelConfig,
  ResponseSchema,
  LLMTool,
  LLMToolCall,
  LLMFunctionCall,
  LLMFunction,
  LLMToolResponse,
  LLMUsage,
  LLMCost,
  LLMResponseMeta,
  LLMResult,
  CostModel,
  LLMStreamChunk,
} from "./llm/types.js";
export {
  ChatMessage as ChatMessageFactory,
  defaultModelConfig,
  llmTool,
  LLMUsage as LLMUsageFactory,
  LLMResponseMeta as LLMResponseMetaFactory,
  CostModel as CostModelFactory,
  LLMStreamChunk as LLMStreamChunkFactory,
} from "./llm/types.js";
export { createOpenAILLMService, type OpenAILLMConfig } from "./llm/openai-llm-service.js";
export { createOpenRouterLLMService } from "./llm/openrouter-llm-service.js";
export { collectStream } from "./llm/stream-accumulator.js";
export {
  createSpendGuardedLLMService,
  SpendLimitExceeded,
  type SpendBudget,
  type SpendState,
} from "./llm/spend-guarded-llm-service.js";

// Embedding
export type { EmbeddingService } from "./embedding/embedding-service.js";
export { createOpenAIEmbeddingService, type OpenAIEmbeddingConfig } from "./embedding/openai-embedding-service.js";

// Tool
export type { MCPTool, MCPToolCall, MCPToolResult, MCPToolDefinition, ToolPermission, ToolApprovalCallback } from "./tool/types.js";
export { MCPToolResult as MCPToolResultFactory, ToolPermission as ToolPermissionFactory, toolDefinitionFromTool } from "./tool/types.js";
export type { MCPToolRegistry } from "./tool/mcp-tool-registry.js";
export { createMCPToolRegistry, createNoopMCPToolRegistry } from "./tool/mcp-tool-registry.js";

// MCP Client
export type {
  MCPRequest,
  MCPResponse,
  MCPError,
  MCPNotification,
  MCPServerInfo,
  MCPCapabilities,
  MCPInitializeResult,
  MCPRemoteToolDef,
  MCPTransport,
  MCPClient,
} from "./tool/mcp/index.js";
export {
  MCP_PROTOCOL_VERSION,
  createStdioTransport,
  createHttpSseTransport,
  createMCPClient,
} from "./tool/mcp/index.js";

// Knowledge
export type {
  KnowledgeAPI,
  KnowledgeFilter,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeRecordExport,
} from "./knowledge/knowledge-api.js";
export { vectorInSync } from "./knowledge/knowledge-api.js";
export { createKnowledgeSearchTool, type KnowledgeCollection } from "./knowledge/knowledge-search-tool.js";

// Memory
export type { Memory, MemoryQuery, MemoryService, MemoryType } from "./memory/memory-service.js";
export { createKnowledgeBackedMemoryService, toMemory } from "./memory/knowledge-backed-memory-service.js";
export { createMemoryTool } from "./memory/memory-tool.js";

// Guardrails
export type {
  Direction,
  GuardrailContext,
  GuardrailResult,
  Guardrail,
} from "./guardrail/index.js";
export {
  GuardrailResultFactory,
  keywordBlocklist,
  regexPolicy,
  lengthLimit,
  llmPolicy,
  guardrailChain,
  guardrailChainCollectAll,
  createGuardedLLMService,
  GuardrailBlocked,
} from "./guardrail/index.js";

// Evaluation
export type {
  EvalInput,
  EvalScore,
  Evaluator,
  EvalSample,
  EvalDataset,
  EvalResult,
  AggregateScore,
  EvalReport,
} from "./eval/index.js";
export {
  exactMatch,
  contains,
  jsonValid,
  regexMatch,
  cosineSimilarity,
  llmJudge,
  lengthCheck,
  evaluateSample,
  evaluateDataset,
} from "./eval/index.js";

// Prompt Versioning
export type {
  VersionedPromptSection,
  PromptVersion,
  PromptRegistry,
} from "./prompt/index.js";
export { createInMemoryPromptRegistry } from "./prompt/index.js";

// Tabular Data
export type {
  Row,
  TableInfo,
  ColumnDef,
  TableSchema,
  FilterOp,
  FilterCondition,
  RowFilter,
  TabularStore,
} from "./data/index.js";
export { createInMemoryTabularStore, createDataTool } from "./data/index.js";

// File Store
export type { FileStore, FileInfo, FileToolConfig } from "./file/index.js";
export { defaultFileToolConfig, createInMemoryFileStore, createLocalFileStore, createFileTool } from "./file/index.js";

// Skills
export type { SkillDefinition, SkillStore, ParsedSkill } from "./skill/index.js";
export {
  parseSkillMarkdown,
  parseSkillDefinition,
  createInMemorySkillStore,
  createSkillTool,
  buildSkillSummary,
} from "./skill/index.js";

// Capability
export * as Capability from "./capability/index.js";

// Sandbox
export * as Sandbox from "./sandbox/index.js";

// NodeFlow
export * as NodeFlow from "./node-flow/index.js";
