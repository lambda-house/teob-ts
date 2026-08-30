import type { LLMService } from "./llm-service.js";
import type {
  ChatMessage,
  CostModel,
  LLMResponseMeta,
  LLMResult,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMToolResponse,
  LLMUsage,
  ModelConfig,
  ResponseSchema,
} from "./types.js";
import { defaultModelConfig } from "./types.js";

export interface OpenAILLMConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  costModel?: CostModel;
}

/**
 * OpenAI-compatible Chat Completions implementation of LLMService.
 *
 * Works with any OpenAI-compatible API (OpenAI, OpenRouter, local models, etc.)
 */
export function createOpenAILLMService(config: OpenAILLMConfig): LLMService {
  const {
    apiKey,
    model = "gpt-4o-mini",
    baseUrl = "https://api.openai.com/v1/chat/completions",
    costModel,
  } = config;

  async function callAPI(body: unknown): Promise<unknown> {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const json = await response.json() as Record<string, unknown>;

    if (json.error) {
      throw new Error(`LLM API error in response body: ${JSON.stringify(json.error)}`);
    }

    return json;
  }

  function buildMeta(
    json: { id?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; choices?: Array<{ finish_reason?: string }> },
    latencyMs: number,
  ): LLMResponseMeta {
    const rawUsage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const usage: LLMUsage = {
      promptTokens: rawUsage.prompt_tokens,
      completionTokens: rawUsage.completion_tokens,
      totalTokens: rawUsage.total_tokens,
    };
    return {
      responseId: json.id ?? "",
      model,
      usage,
      cost: costModel?.compute(model, usage),
      finishReason: json.choices?.[0]?.finish_reason,
      latencyMs,
    };
  }

  function parseToolResponse(json: {
    choices: Array<{
      message: { role: string; content: string | null; tool_calls?: LLMToolCall[] };
      finish_reason: string;
    }>;
  }): LLMToolResponse {
    if (!json.choices || json.choices.length === 0) {
      throw new Error("No completion returned from OpenAI");
    }

    const choice = json.choices[0];

    if (choice.finish_reason === "tool_calls") {
      const calls = choice.message.tool_calls;
      if (!calls || calls.length === 0) {
        throw new Error("LLM returned tool_calls finish_reason but no tool_calls in message");
      }

      const rawMessage = {
        role: "assistant",
        content: choice.message.content,
        tool_calls: calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };

      return { tag: "ToolCalls", calls, rawMessage };
    }

    if (choice.message.content !== null) {
      return { tag: "Content", text: choice.message.content };
    }

    throw new Error("LLM returned no content and no tool_calls");
  }

  function buildToolBody(
    messages: unknown[],
    tools: LLMTool[],
    responseSchema: ResponseSchema | undefined,
    cfg: ModelConfig,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    } else if (responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: responseSchema.name,
          schema: responseSchema.schema,
          strict: responseSchema.strict ?? true,
        },
      };
    }
    return body;
  }

  function parseSseChunk(json: Record<string, unknown>): LLMStreamChunk | undefined {
    const choices = json.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
    const delta = choices?.[0]?.delta;
    if (!delta) return undefined;

    const content = delta.content as string | undefined;
    if (content) {
      return { tag: "ContentDelta", text: content };
    }

    const toolCalls = delta.tool_calls as Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }> | undefined;
    const tc = toolCalls?.[0];
    if (tc) {
      const index = tc.index ?? 0;
      const id = tc.id;
      const name = tc.function?.name;
      const args = tc.function?.arguments ?? "";
      if (id || name || args) {
        return { tag: "ToolCallDelta", index, id, name, argumentsDelta: args };
      }
    }

    return undefined;
  }

  return {
    async chat(messages: ChatMessage[], jsonMode = false): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
      };
      if (jsonMode) {
        body.response_format = { type: "json_object" };
      }

      const json = await callAPI(body) as {
        choices: Array<{ message: { content: string } }>;
      };

      if (!json.choices || json.choices.length === 0) {
        throw new Error("No completion returned from OpenAI");
      }

      return json.choices[0].message.content;
    },

    async chatJson<A>(messages: ChatMessage[], parse?: (raw: unknown) => A): Promise<A> {
      const content = await this.chat(messages, true);
      try {
        const parsed = JSON.parse(content);
        return parse ? parse(parsed) : parsed as A;
      } catch (err) {
        throw new Error(
          `Failed to parse LLM JSON response: ${err instanceof Error ? err.message : String(err)}\nContent: ${content}`,
        );
      }
    },

    async chatWithTools(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      cfg: ModelConfig = defaultModelConfig,
    ): Promise<LLMToolResponse> {
      const body = buildToolBody(messages, tools, responseSchema, cfg);
      const json = await callAPI(body) as {
        choices: Array<{
          message: { role: string; content: string | null; tool_calls?: LLMToolCall[] };
          finish_reason: string;
        }>;
      };
      return parseToolResponse(json);
    },

    async chatTracked(messages: ChatMessage[], jsonMode = false): Promise<LLMResult<string>> {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
      };
      if (jsonMode) {
        body.response_format = { type: "json_object" };
      }

      const startTime = Date.now();
      const json = await callAPI(body) as {
        id?: string;
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const latencyMs = Date.now() - startTime;

      if (!json.choices || json.choices.length === 0) {
        throw new Error("No completion returned from OpenAI");
      }

      return { value: json.choices[0].message.content, meta: buildMeta(json, latencyMs) };
    },

    async chatWithToolsTracked(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      cfg: ModelConfig = defaultModelConfig,
    ): Promise<LLMResult<LLMToolResponse>> {
      const body = buildToolBody(messages, tools, responseSchema, cfg);
      const startTime = Date.now();
      const json = await callAPI(body) as {
        id?: string;
        choices: Array<{
          message: { role: string; content: string | null; tool_calls?: LLMToolCall[] };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const latencyMs = Date.now() - startTime;

      return { value: parseToolResponse(json), meta: buildMeta(json, latencyMs) };
    },

    async *chatStream(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      cfg: ModelConfig = defaultModelConfig,
    ): AsyncIterable<LLMStreamChunk> {
      const body = { ...buildToolBody(messages, tools, responseSchema, cfg), stream: true };
      const startTime = Date.now();

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM API error ${response.status}: ${text}`);
      }

      if (!response.body) {
        throw new Error("No response body for streaming request");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const json = JSON.parse(data) as Record<string, unknown>;
              const chunk = parseSseChunk(json);
              if (chunk) yield chunk;
            } catch {
              // skip malformed JSON
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const latencyMs = Date.now() - startTime;
      yield {
        tag: "Done",
        meta: {
          responseId: "",
          model,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cost: undefined,
          finishReason: "stop",
          latencyMs,
        },
      };
    },
  };
}
