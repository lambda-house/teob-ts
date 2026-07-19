import type { LLMService } from "../llm/llm-service.js";
import type {
  ChatMessage,
  LLMResult,
  LLMStreamChunk,
  LLMTool,
  LLMToolResponse,
  ModelConfig,
  ResponseSchema,
} from "../llm/types.js";
import type { RecordedLLMCall } from "./types.js";

let nextRequestId = 1;

function genRequestId(): string {
  return `req-${(nextRequestId++).toString(36)}`;
}

function describeResponse(value: LLMToolResponse): {
  responseType: "content" | "tool_calls";
  content: string | null;
  toolCalls: unknown;
} {
  if (value.tag === "Content") {
    return { responseType: "content", content: value.text, toolCalls: null };
  }
  return { responseType: "tool_calls", content: null, toolCalls: value.calls };
}

/**
 * Decorator LLMService that records every chat call into an internal buffer.
 *
 * All semantics delegate to the wrapped service unchanged.
 */
export class RecordingLLMService implements LLMService {
  private buffer: RecordedLLMCall[] = [];

  constructor(
    private readonly underlying: LLMService,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Snapshot of LLM calls captured so far. */
  async getRecordedCalls(): Promise<RecordedLLMCall[]> {
    return [...this.buffer];
  }

  async chat(messages: ChatMessage[], jsonMode?: boolean): Promise<string> {
    const result = await this.underlying.chatTracked(messages, jsonMode);
    this.buffer.push({
      type: "llmcall",
      requestId: genRequestId(),
      messages,
      tools: [],
      responseType: "content",
      content: result.value,
      toolCalls: null,
      meta: result.meta,
      completedAt: this.clock(),
    });
    return result.value;
  }

  async chatJson<A>(messages: ChatMessage[], parse?: (raw: unknown) => A): Promise<A> {
    const raw = await this.underlying.chatJson(messages, (x) => x);
    this.buffer.push({
      type: "llmcall",
      requestId: genRequestId(),
      messages,
      tools: [],
      responseType: "content",
      content: typeof raw === "string" ? raw : JSON.stringify(raw),
      toolCalls: null,
      meta: { responseId: "", model: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: undefined, finishReason: undefined, latencyMs: 0 },
      completedAt: this.clock(),
    });
    return parse ? parse(raw) : (raw as A);
  }

  async chatWithTools(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): Promise<LLMToolResponse> {
    const result = await this.underlying.chatWithToolsTracked(messages, tools, responseSchema, config);
    const desc = describeResponse(result.value);
    this.buffer.push({
      type: "llmcall",
      requestId: genRequestId(),
      messages,
      tools: tools.map((t) => t.function.name),
      responseType: desc.responseType,
      content: desc.content,
      toolCalls: desc.toolCalls,
      meta: result.meta,
      completedAt: this.clock(),
    });
    return result.value;
  }

  async chatTracked(messages: ChatMessage[], jsonMode?: boolean): Promise<LLMResult<string>> {
    const result = await this.underlying.chatTracked(messages, jsonMode);
    this.buffer.push({
      type: "llmcall",
      requestId: genRequestId(),
      messages,
      tools: [],
      responseType: "content",
      content: result.value,
      toolCalls: null,
      meta: result.meta,
      completedAt: this.clock(),
    });
    return result;
  }

  async chatWithToolsTracked(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): Promise<LLMResult<LLMToolResponse>> {
    const result = await this.underlying.chatWithToolsTracked(messages, tools, responseSchema, config);
    const desc = describeResponse(result.value);
    this.buffer.push({
      type: "llmcall",
      requestId: genRequestId(),
      messages,
      tools: tools.map((t) => t.function.name),
      responseType: desc.responseType,
      content: desc.content,
      toolCalls: desc.toolCalls,
      meta: result.meta,
      completedAt: this.clock(),
    });
    return result;
  }

  async *chatStream(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema?: ResponseSchema,
    config?: ModelConfig,
  ): AsyncIterable<LLMStreamChunk> {
    let aggregated: { content: string; toolCalls: unknown[] } = { content: "", toolCalls: [] };
    let lastMeta: LLMStreamChunk | undefined;
    for await (const chunk of this.underlying.chatStream(messages, tools, responseSchema, config)) {
      if (chunk.tag === "ContentDelta") aggregated.content += chunk.text;
      if (chunk.tag === "Done") lastMeta = chunk;
      yield chunk;
    }
    if (lastMeta && lastMeta.tag === "Done") {
      this.buffer.push({
        type: "llmcall",
        requestId: genRequestId(),
        messages,
        tools: tools.map((t) => t.function.name),
        responseType: aggregated.content ? "content" : "tool_calls",
        content: aggregated.content || null,
        toolCalls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : null,
        meta: lastMeta.meta,
        completedAt: this.clock(),
      });
    }
  }
}
