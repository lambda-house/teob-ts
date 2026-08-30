import type { LLMService } from "./llm-service.js";
import type {
  ChatMessage,
  LLMResult,
  LLMStreamChunk,
  LLMTool,
  LLMToolResponse,
  ModelConfig,
  ResponseSchema,
} from "./types.js";

/** Budget limits for LLM spend tracking. */
export interface SpendBudget {
  maxTotalCostUsd?: number;
  maxTotalTokens?: number;
}

/** Current spend state. */
export interface SpendState {
  totalCostUsd: number;
  totalTokens: number;
  callCount: number;
}

export class SpendLimitExceeded extends Error {
  constructor(
    public readonly budget: SpendBudget,
    public readonly state: SpendState,
  ) {
    super(
      `Spend limit exceeded: cost=${state.totalCostUsd.toFixed(4)} USD, tokens=${state.totalTokens}` +
      ` (limits: cost=${budget.maxTotalCostUsd ?? "∞"}, tokens=${budget.maxTotalTokens ?? "∞"})`,
    );
    this.name = "SpendLimitExceeded";
  }
}

/**
 * Wraps an LLMService with cumulative spend tracking and budget enforcement.
 *
 * Only tracked methods update the spend state. Untracked methods delegate directly.
 */
export function createSpendGuardedLLMService(
  inner: LLMService,
  budget: SpendBudget,
): LLMService & { getSpendState(): SpendState; resetSpendState(): void } {
  let state: SpendState = { totalCostUsd: 0, totalTokens: 0, callCount: 0 };

  function checkBudget(): void {
    if (budget.maxTotalCostUsd !== undefined && state.totalCostUsd >= budget.maxTotalCostUsd) {
      throw new SpendLimitExceeded(budget, state);
    }
    if (budget.maxTotalTokens !== undefined && state.totalTokens >= budget.maxTotalTokens) {
      throw new SpendLimitExceeded(budget, state);
    }
  }

  function trackResult<A>(result: LLMResult<A>): LLMResult<A> {
    state = {
      totalCostUsd: state.totalCostUsd + (result.meta.cost?.totalCostUsd ?? 0),
      totalTokens: state.totalTokens + result.meta.usage.totalTokens,
      callCount: state.callCount + 1,
    };
    return result;
  }

  return {
    chat: (messages, jsonMode) => inner.chat(messages, jsonMode),
    chatJson: (messages, parse) => inner.chatJson(messages, parse),
    chatWithTools: (messages, tools, responseSchema, config) =>
      inner.chatWithTools(messages, tools, responseSchema, config),

    async chatTracked(messages: ChatMessage[], jsonMode?: boolean): Promise<LLMResult<string>> {
      checkBudget();
      return trackResult(await inner.chatTracked(messages, jsonMode));
    },

    async chatWithToolsTracked(
      messages: unknown[],
      tools: LLMTool[],
      responseSchema?: ResponseSchema,
      config?: ModelConfig,
    ): Promise<LLMResult<LLMToolResponse>> {
      checkBudget();
      return trackResult(await inner.chatWithToolsTracked(messages, tools, responseSchema, config));
    },

    chatStream: (messages, tools, responseSchema, config) =>
      inner.chatStream(messages, tools, responseSchema, config),

    getSpendState(): SpendState {
      return { ...state };
    },

    resetSpendState(): void {
      state = { totalCostUsd: 0, totalTokens: 0, callCount: 0 };
    },
  };
}
