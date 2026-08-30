import type {
  ChatMessage,
  LLMResult,
  LLMStreamChunk,
  LLMTool,
  LLMToolResponse,
  LLMResponseMeta,
  ModelConfig,
  ResponseSchema,
} from "./types.js";

/**
 * Provider-agnostic interface for LLM chat completions.
 *
 * The `*Tracked` methods return LLMResult which includes usage metadata (tokens, cost, latency).
 * The `chatStream` method emits chunks as they arrive from the LLM.
 */
export interface LLMService {
  /** Generate a chat completion. */
  chat(messages: ChatMessage[], jsonMode?: boolean): Promise<string>;

  /** Generate a chat completion with structured JSON output. */
  chatJson<A>(messages: ChatMessage[], parse?: (raw: unknown) => A): Promise<A>;

  /**
   * Generate a chat completion with tool support (agentic loop).
   */
  chatWithTools(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): Promise<LLMToolResponse>;

  /** Chat completion with usage metadata (tokens, cost, latency). */
  chatTracked(messages: ChatMessage[], jsonMode?: boolean): Promise<LLMResult<string>>;

  /** Chat with tools returning usage metadata. */
  chatWithToolsTracked(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): Promise<LLMResult<LLMToolResponse>>;

  /**
   * Streaming chat with tools. Emits chunks as they arrive from the LLM.
   * Returns an async iterable of LLMStreamChunk.
   */
  chatStream(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): AsyncIterable<LLMStreamChunk>;
}

/**
 * Default implementations for tracked and streaming methods.
 * These delegate to untracked methods with empty metadata.
 * Override in implementations that support usage reporting.
 */
export function withDefaults(
  base: Pick<LLMService, "chat" | "chatJson" | "chatWithTools">,
): LLMService {
  const service: LLMService = {
    ...base,

    async chatTracked(messages, jsonMode) {
      const value = await base.chat(messages, jsonMode);
      return { value, meta: LLMResponseMetaEmpty };
    },

    async chatWithToolsTracked(messages, tools, responseSchema, config) {
      const value = await base.chatWithTools(messages, tools, responseSchema, config);
      return { value, meta: LLMResponseMetaEmpty };
    },

    async *chatStream(messages, tools, responseSchema, config) {
      const result = await service.chatWithToolsTracked(messages, tools, responseSchema, config);
      const chunk: LLMStreamChunk = result.value.tag === "Content"
        ? { tag: "ContentDelta", text: result.value.text }
        : {
            tag: "ToolCallDelta",
            index: 0,
            id: result.value.calls[0]?.id,
            name: result.value.calls[0]?.function.name,
            argumentsDelta: result.value.calls[0]?.function.arguments ?? "",
          };
      yield chunk;
      yield { tag: "Done", meta: result.meta };
    },
  };
  return service;
}

const LLMResponseMetaEmpty: LLMResponseMeta = {
  responseId: "",
  model: "",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  cost: undefined,
  finishReason: undefined,
  latencyMs: 0,
};
