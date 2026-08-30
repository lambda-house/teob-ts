import type { LLMService } from "../llm/llm-service.js";
import type {
  ChatMessage,
  LLMResponseMeta,
  LLMResult,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMToolResponse,
  ModelConfig,
  ResponseSchema,
} from "../llm/types.js";
import type { AgentRunRecording, RecordedLLMCall } from "./types.js";
import { RecordingExhaustedError } from "./errors.js";

/**
 * LLMService that returns recorded responses in order. Ignores message
 * content and tool list — replay is response-only. Drift in arguments is
 * surfaced separately by RunComparison.
 */
export class ReplayLLMService implements LLMService {
  private cursor = 0;

  constructor(private readonly calls: RecordedLLMCall[]) {}

  static from(rec: AgentRunRecording): ReplayLLMService {
    const calls = rec.steps.filter((s): s is RecordedLLMCall => s.type === "llmcall");
    return new ReplayLLMService(calls);
  }

  static fromCalls(calls: RecordedLLMCall[]): ReplayLLMService {
    return new ReplayLLMService([...calls]);
  }

  async served(): Promise<number> {
    return this.cursor;
  }

  private next(): RecordedLLMCall {
    if (this.cursor >= this.calls.length) {
      throw new RecordingExhaustedError(this.cursor + 1, this.calls.length, "llm");
    }
    return this.calls[this.cursor++];
  }

  private materializeResponse(call: RecordedLLMCall): LLMToolResponse {
    if (call.responseType === "tool_calls") {
      const calls = (call.toolCalls as LLMToolCall[]) ?? [];
      return { tag: "ToolCalls", calls, rawMessage: { role: "assistant", tool_calls: calls } };
    }
    return { tag: "Content", text: call.content ?? "" };
  }

  async chat(_messages: ChatMessage[], _jsonMode?: boolean): Promise<string> {
    const c = this.next();
    return c.content ?? "";
  }

  async chatJson<A>(_messages: ChatMessage[], parse?: (raw: unknown) => A): Promise<A> {
    const c = this.next();
    const raw = c.content ?? "";
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // leave as raw string
    }
    return parse ? parse(value) : (value as A);
  }

  async chatWithTools(
    _messages: unknown[],
    _tools: LLMTool[],
    _responseSchema?: ResponseSchema,
    _config?: ModelConfig,
  ): Promise<LLMToolResponse> {
    return this.materializeResponse(this.next());
  }

  async chatTracked(messages: ChatMessage[], jsonMode?: boolean): Promise<LLMResult<string>> {
    const c = this.next();
    return { value: c.content ?? "", meta: c.meta };
  }

  async chatWithToolsTracked(
    _messages: unknown[],
    _tools: LLMTool[],
    _responseSchema?: ResponseSchema,
    _config?: ModelConfig,
  ): Promise<LLMResult<LLMToolResponse>> {
    const c = this.next();
    return { value: this.materializeResponse(c), meta: c.meta };
  }

  async *chatStream(
    _messages: unknown[],
    _tools: LLMTool[],
    _responseSchema?: ResponseSchema,
    _config?: ModelConfig,
  ): AsyncIterable<LLMStreamChunk> {
    const c = this.next();
    if (c.responseType === "content") {
      yield { tag: "ContentDelta", text: c.content ?? "" };
    } else if (Array.isArray(c.toolCalls)) {
      for (let i = 0; i < c.toolCalls.length; i++) {
        const call = c.toolCalls[i] as LLMToolCall;
        yield {
          tag: "ToolCallDelta",
          index: i,
          id: call.id,
          name: call.function.name,
          argumentsDelta: call.function.arguments ?? "",
        };
      }
    }
    yield { tag: "Done", meta: c.meta };
  }
}
