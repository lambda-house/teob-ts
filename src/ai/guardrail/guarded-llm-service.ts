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
import type { Guardrail, GuardrailContext } from "./types.js";

export class GuardrailBlocked extends Error {
  constructor(
    public readonly guardrailName: string,
    public readonly reason: string,
    public readonly suggestion?: string,
  ) {
    super(`Guardrail '${guardrailName}' blocked: ${reason}`);
    this.name = "GuardrailBlocked";
  }
}

/**
 * Wraps an LLMService with input and output guardrails.
 *
 * Input guardrails check user messages before calling the LLM.
 * Output guardrails check the LLM response before returning it.
 */
export function createGuardedLLMService(
  inner: LLMService,
  inputGuardrails: Guardrail[],
  outputGuardrails: Guardrail[],
): LLMService {
  async function checkInput(content: string): Promise<void> {
    const ctx: GuardrailContext = { direction: "Input" };
    for (const g of inputGuardrails) {
      const result = await g.check(content, ctx);
      if (result.tag === "Block") {
        throw new GuardrailBlocked(result.name, result.reason, result.suggestion);
      }
    }
  }

  async function checkOutput(content: string): Promise<void> {
    const ctx: GuardrailContext = { direction: "Output" };
    for (const g of outputGuardrails) {
      const result = await g.check(content, ctx);
      if (result.tag === "Block") {
        throw new GuardrailBlocked(result.name, result.reason, result.suggestion);
      }
    }
  }

  function lastUserContent(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return "";
  }

  function lastUserContentFromRaw(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown> | null;
      if (msg && msg.role === "user" && typeof msg.content === "string") return msg.content;
    }
    return "";
  }

  return {
    async chat(messages: ChatMessage[], jsonMode?: boolean): Promise<string> {
      await checkInput(lastUserContent(messages));
      const result = await inner.chat(messages, jsonMode);
      await checkOutput(result);
      return result;
    },

    async chatJson<A>(messages: ChatMessage[], parse?: (raw: unknown) => A): Promise<A> {
      await checkInput(lastUserContent(messages));
      return inner.chatJson(messages, parse);
    },

    async chatWithTools(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      config?: ModelConfig,
    ): Promise<LLMToolResponse> {
      await checkInput(lastUserContentFromRaw(messages));
      const result = await inner.chatWithTools(messages, tools, responseSchema, config);
      if (result.tag === "Content") {
        await checkOutput(result.text);
      }
      return result;
    },

    async chatTracked(messages: ChatMessage[], jsonMode?: boolean): Promise<LLMResult<string>> {
      await checkInput(lastUserContent(messages));
      const result = await inner.chatTracked(messages, jsonMode);
      await checkOutput(result.value);
      return result;
    },

    async chatWithToolsTracked(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      config?: ModelConfig,
    ): Promise<LLMResult<LLMToolResponse>> {
      await checkInput(lastUserContentFromRaw(messages));
      const result = await inner.chatWithToolsTracked(messages, tools, responseSchema, config);
      if (result.value.tag === "Content") {
        await checkOutput(result.value.text);
      }
      return result;
    },

    async *chatStream(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      config?: ModelConfig,
    ): AsyncIterable<LLMStreamChunk> {
      await checkInput(lastUserContentFromRaw(messages));
      yield* inner.chatStream(messages, tools, responseSchema, config);
    },
  };
}
