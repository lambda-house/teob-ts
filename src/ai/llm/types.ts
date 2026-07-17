// --- Chat Messages ---

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const ChatMessage = {
  system: (content: string): ChatMessage => ({ role: "system", content }),
  user: (content: string): ChatMessage => ({ role: "user", content }),
  assistant: (content: string): ChatMessage => ({ role: "assistant", content }),
};

// --- Model Configuration ---

export interface ModelConfig {
  temperature: number;
  maxTokens: number;
}

export const defaultModelConfig: ModelConfig = {
  temperature: 0.7,
  maxTokens: 2048,
};

// --- Response Schema (structured output) ---

export interface ResponseSchema {
  name: string;
  schema: unknown;
  strict?: boolean;
}

// --- Tool Definitions (OpenAI function-calling format) ---

export interface LLMFunction {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LLMTool {
  type: "function";
  function: LLMFunction;
}

export function llmTool(name: string, description: string, parameters: unknown): LLMTool {
  return { type: "function", function: { name, description, parameters } };
}

// --- Tool Calls (from LLM response) ---

export interface LLMFunctionCall {
  name: string;
  arguments: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: LLMFunctionCall;
}

// --- LLM Response (when tools are available) ---

export type LLMToolResponse =
  | { tag: "Content"; text: string }
  | { tag: "ToolCalls"; calls: LLMToolCall[]; rawMessage: unknown };

// --- Token & Cost Tracking ---

/** Token usage statistics from an LLM API call. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const LLMUsage = {
  empty: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as LLMUsage,
};

/** Cost information for an LLM call in USD. */
export interface LLMCost {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/** Metadata from an LLM API response. */
export interface LLMResponseMeta {
  responseId: string;
  model: string;
  usage: LLMUsage;
  cost: LLMCost | undefined;
  finishReason: string | undefined;
  latencyMs: number;
}

export const LLMResponseMeta = {
  empty: {
    responseId: "",
    model: "",
    usage: LLMUsage.empty,
    cost: undefined,
    finishReason: undefined,
    latencyMs: 0,
  } as LLMResponseMeta,
};

/** An LLM response paired with its metadata. */
export interface LLMResult<A> {
  value: A;
  meta: LLMResponseMeta;
}

/**
 * Computes the cost of an LLM call based on model and token usage.
 */
export interface CostModel {
  compute(model: string, usage: LLMUsage): LLMCost | undefined;
}

export const CostModel = {
  /** No-op cost model that never produces cost information. */
  noop: { compute: () => undefined } as CostModel,

  /**
   * Create a cost model from a pricing table.
   * @param prices Map of model name/prefix to [inputPricePerMillionTokens, outputPricePerMillionTokens]
   */
  fromPricing(prices: Record<string, [number, number]>): CostModel {
    return {
      compute(model: string, usage: LLMUsage): LLMCost | undefined {
        const pricing = prices[model] ??
          Object.entries(prices).find(([prefix]) => model.startsWith(prefix))?.[1];
        if (!pricing) return undefined;
        const [inputPrice, outputPrice] = pricing;
        const inputCost = (usage.promptTokens / 1_000_000) * inputPrice;
        const outputCost = (usage.completionTokens / 1_000_000) * outputPrice;
        return { inputCostUsd: inputCost, outputCostUsd: outputCost, totalCostUsd: inputCost + outputCost };
      },
    };
  },

  /** Compose multiple cost models — tries each in order until one returns a cost. */
  compose(...models: CostModel[]): CostModel {
    return {
      compute(model: string, usage: LLMUsage): LLMCost | undefined {
        for (const cm of models) {
          const result = cm.compute(model, usage);
          if (result) return result;
        }
        return undefined;
      },
    };
  },
};

// --- Streaming ---

/** A chunk from a streaming LLM response. */
export type LLMStreamChunk =
  | { tag: "ContentDelta"; text: string }
  | { tag: "ToolCallDelta"; index: number; id: string | undefined; name: string | undefined; argumentsDelta: string }
  | { tag: "Done"; meta: LLMResponseMeta };

export const LLMStreamChunk = {
  contentDelta: (text: string): LLMStreamChunk => ({ tag: "ContentDelta", text }),
  toolCallDelta: (index: number, id: string | undefined, name: string | undefined, argumentsDelta: string): LLMStreamChunk =>
    ({ tag: "ToolCallDelta", index, id, name, argumentsDelta }),
  done: (meta: LLMResponseMeta): LLMStreamChunk => ({ tag: "Done", meta }),
};
