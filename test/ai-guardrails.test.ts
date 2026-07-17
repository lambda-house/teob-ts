import { describe, it, expect } from "vitest";
import {
  keywordBlocklist,
  regexPolicy,
  lengthLimit,
} from "../src/ai/guardrail/guardrails.js";
import { guardrailChain, guardrailChainCollectAll } from "../src/ai/guardrail/guardrail-chain.js";
import { createGuardedLLMService, GuardrailBlocked } from "../src/ai/guardrail/guarded-llm-service.js";
import type { LLMService } from "../src/ai/llm/llm-service.js";
import type { GuardrailContext } from "../src/ai/guardrail/types.js";

describe("Guardrails", () => {
  const ctx: GuardrailContext = { direction: "Input" };

  describe("KeywordBlocklist", () => {
    const guard = keywordBlocklist(["password", "secret"]);

    it("should pass clean content", async () => {
      expect((await guard.check("Hello world", ctx)).tag).toBe("Pass");
    });

    it("should block content with blocked word (case insensitive)", async () => {
      const result = await guard.check("Enter your PASSWORD here", ctx);
      expect(result.tag).toBe("Block");
    });
  });

  describe("RegexPolicy", () => {
    const guard = regexPolicy(/\b\d{3}-\d{2}-\d{4}\b/, "SSNPolicy");

    it("should pass content without SSN", async () => {
      expect((await guard.check("My number is 12345", ctx)).tag).toBe("Pass");
    });

    it("should block content with SSN pattern", async () => {
      const result = await guard.check("SSN: 123-45-6789", ctx);
      expect(result.tag).toBe("Block");
      if (result.tag === "Block") {
        expect(result.name).toBe("SSNPolicy");
      }
    });
  });

  describe("LengthLimit", () => {
    it("should pass content within limit", async () => {
      const guard = lengthLimit(100);
      expect((await guard.check("short", ctx)).tag).toBe("Pass");
    });

    it("should warn when exceeded in warn mode", async () => {
      const guard = lengthLimit(5, "warn");
      const result = await guard.check("long text here", ctx);
      expect(result.tag).toBe("Warn");
    });

    it("should block when exceeded in block mode", async () => {
      const guard = lengthLimit(5, "block");
      const result = await guard.check("long text here", ctx);
      expect(result.tag).toBe("Block");
    });
  });

  describe("GuardrailChain", () => {
    it("should short-circuit on first block", async () => {
      const chain = guardrailChain([
        keywordBlocklist(["bad"]),
        lengthLimit(1000),
      ]);
      const result = await chain.check("this is bad", ctx);
      expect(result.tag).toBe("Block");
    });

    it("should return worst non-block result", async () => {
      const chain = guardrailChain([
        lengthLimit(5, "warn"),
        lengthLimit(1000),
      ]);
      const result = await chain.check("medium text", ctx);
      expect(result.tag).toBe("Warn");
    });

    it("should pass when all pass", async () => {
      const chain = guardrailChain([
        keywordBlocklist(["bad"]),
        lengthLimit(1000),
      ]);
      const result = await chain.check("good text", ctx);
      expect(result.tag).toBe("Pass");
    });
  });

  describe("GuardrailChainCollectAll", () => {
    it("should run all guardrails even after block", async () => {
      const chain = guardrailChainCollectAll([
        keywordBlocklist(["bad"]),
        keywordBlocklist(["evil"]),
      ]);
      // Only first blocks, but chain continues
      const result = await chain.check("this is bad and evil", ctx);
      expect(result.tag).toBe("Block");
    });
  });
});

describe("GuardedLLMService", () => {
  function mockLLM(response: string): LLMService {
    return {
      chat: async () => response,
      chatJson: async () => ({}) as never,
      chatWithTools: async () => ({ tag: "Content" as const, text: response }),
      chatTracked: async () => ({
        value: response,
        meta: { responseId: "", model: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: undefined, finishReason: undefined, latencyMs: 0 },
      }),
      chatWithToolsTracked: async () => ({
        value: { tag: "Content" as const, text: response },
        meta: { responseId: "", model: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: undefined, finishReason: undefined, latencyMs: 0 },
      }),
      async *chatStream() {
        yield { tag: "ContentDelta" as const, text: response };
        yield { tag: "Done" as const, meta: { responseId: "", model: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: undefined, finishReason: undefined, latencyMs: 0 } };
      },
    };
  }

  it("should block input with guardrail violation", async () => {
    const guarded = createGuardedLLMService(
      mockLLM("ok"),
      [keywordBlocklist(["hack"])],
      [],
    );
    await expect(
      guarded.chat([{ role: "user", content: "How to hack a system" }]),
    ).rejects.toThrow(GuardrailBlocked);
  });

  it("should block output with guardrail violation", async () => {
    const guarded = createGuardedLLMService(
      mockLLM("Here is the secret password"),
      [],
      [keywordBlocklist(["password"])],
    );
    await expect(
      guarded.chat([{ role: "user", content: "Tell me something" }]),
    ).rejects.toThrow(GuardrailBlocked);
  });

  it("should pass clean content through", async () => {
    const guarded = createGuardedLLMService(
      mockLLM("Hello there"),
      [keywordBlocklist(["hack"])],
      [keywordBlocklist(["password"])],
    );
    const result = await guarded.chat([{ role: "user", content: "Hi!" }]);
    expect(result).toBe("Hello there");
  });
});
