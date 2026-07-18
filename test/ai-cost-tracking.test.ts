import { describe, it, expect } from "vitest";
import {
  CostModel,
  LLMUsage,
  LLMResponseMeta,
} from "../src/ai/llm/types.js";
import {
  createSpendGuardedLLMService,
  SpendLimitExceeded,
} from "../src/ai/llm/spend-guarded-llm-service.js";
import type { LLMService } from "../src/ai/llm/llm-service.js";
import type { LLMResult } from "../src/ai/llm/types.js";

describe("CostModel", () => {
  it("noop should return undefined", () => {
    expect(CostModel.noop.compute("gpt-4o", LLMUsage.empty)).toBeUndefined();
  });

  it("fromPricing should compute cost from exact match", () => {
    const cm = CostModel.fromPricing({ "gpt-4o": [5.0, 15.0] });
    const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
    const cost = cm.compute("gpt-4o", usage);
    expect(cost).toBeDefined();
    expect(cost!.inputCostUsd).toBeCloseTo(0.005);
    expect(cost!.outputCostUsd).toBeCloseTo(0.0075);
    expect(cost!.totalCostUsd).toBeCloseTo(0.0125);
  });

  it("fromPricing should match by prefix", () => {
    const cm = CostModel.fromPricing({ "gpt-4": [5.0, 15.0] });
    const cost = cm.compute("gpt-4o-mini", { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
    expect(cost).toBeDefined();
    expect(cost!.inputCostUsd).toBeCloseTo(5.0);
  });

  it("fromPricing should return undefined for unknown model", () => {
    const cm = CostModel.fromPricing({ "gpt-4": [5.0, 15.0] });
    expect(cm.compute("claude-3", { promptTokens: 100, completionTokens: 100, totalTokens: 200 })).toBeUndefined();
  });

  it("compose should try models in order", () => {
    const cm1 = CostModel.fromPricing({ "gpt-4": [5.0, 15.0] });
    const cm2 = CostModel.fromPricing({ "claude-3": [3.0, 15.0] });
    const composed = CostModel.compose(cm1, cm2);

    const usage = { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 };
    expect(composed.compute("gpt-4o", usage)).toBeDefined();
    expect(composed.compute("claude-3-sonnet", usage)).toBeDefined();
    expect(composed.compute("llama-3", usage)).toBeUndefined();
  });
});

describe("SpendGuardedLLMService", () => {
  function mockLLMService(meta: LLMResponseMeta): LLMService {
    return {
      chat: async () => "response",
      chatJson: async () => ({}) as never,
      chatWithTools: async () => ({ tag: "Content" as const, text: "response" }),
      chatTracked: async () => ({ value: "response", meta }),
      chatWithToolsTracked: async () => ({ value: { tag: "Content" as const, text: "response" }, meta }),
      async *chatStream() { yield { tag: "Done" as const, meta }; },
    };
  }

  const meta: LLMResponseMeta = {
    responseId: "r1",
    model: "gpt-4o",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    cost: { inputCostUsd: 0.01, outputCostUsd: 0.02, totalCostUsd: 0.03 },
    finishReason: "stop",
    latencyMs: 200,
  };

  it("should track spend across tracked calls", async () => {
    const guarded = createSpendGuardedLLMService(mockLLMService(meta), { maxTotalCostUsd: 1.0 });
    await guarded.chatTracked([]);
    await guarded.chatTracked([]);

    const state = guarded.getSpendState();
    expect(state.callCount).toBe(2);
    expect(state.totalCostUsd).toBeCloseTo(0.06);
    expect(state.totalTokens).toBe(300);
  });

  it("should throw SpendLimitExceeded when cost budget exceeded", async () => {
    const guarded = createSpendGuardedLLMService(mockLLMService(meta), { maxTotalCostUsd: 0.05 });
    await guarded.chatTracked([]);
    // After first call: 0.03 USD. Budget is 0.05. Second call should succeed.
    await guarded.chatTracked([]);
    // After second call: 0.06 USD >= 0.05. Third call should fail.
    await expect(guarded.chatTracked([])).rejects.toThrow(SpendLimitExceeded);
  });

  it("should throw SpendLimitExceeded when token budget exceeded", async () => {
    const guarded = createSpendGuardedLLMService(mockLLMService(meta), { maxTotalTokens: 200 });
    await guarded.chatTracked([]);
    // 150 tokens used. Budget is 200.
    await guarded.chatWithToolsTracked([], []);
    // 300 tokens used >= 200. Next call should fail.
    await expect(guarded.chatTracked([])).rejects.toThrow(SpendLimitExceeded);
  });

  it("should allow untracked methods without budget impact", async () => {
    const guarded = createSpendGuardedLLMService(mockLLMService(meta), { maxTotalTokens: 10 });
    // Untracked methods bypass budget
    const result = await guarded.chat([]);
    expect(result).toBe("response");
    expect(guarded.getSpendState().callCount).toBe(0);
  });

  it("should reset spend state", async () => {
    const guarded = createSpendGuardedLLMService(mockLLMService(meta), { maxTotalCostUsd: 1.0 });
    await guarded.chatTracked([]);
    guarded.resetSpendState();
    expect(guarded.getSpendState().callCount).toBe(0);
  });
});
