import type { Guardrail, GuardrailContext, GuardrailResult } from "./types.js";
import { GuardrailResult as GR } from "./types.js";
import type { LLMService } from "../llm/llm-service.js";
import { ChatMessage } from "../llm/types.js";

/** Blocks content containing any of the specified words (case-insensitive). */
export function keywordBlocklist(blockedWords: string[]): Guardrail {
  const lower = blockedWords.map((w) => w.toLowerCase());
  return {
    name: "KeywordBlocklist",
    async check(content: string): Promise<GuardrailResult> {
      const contentLower = content.toLowerCase();
      const found = lower.find((w) => contentLower.includes(w));
      return found
        ? GR.block("KeywordBlocklist", `Blocked keyword found: "${found}"`)
        : GR.pass;
    },
  };
}

/** Blocks content matching a regex pattern. */
export function regexPolicy(pattern: RegExp, policyName?: string): Guardrail {
  const name = policyName ?? "RegexPolicy";
  return {
    name,
    async check(content: string): Promise<GuardrailResult> {
      return pattern.test(content)
        ? GR.block(name, `Content matches blocked pattern: ${pattern}`)
        : GR.pass;
    },
  };
}

/** Warns or blocks when content exceeds a character limit. */
export function lengthLimit(
  maxLength: number,
  mode: "warn" | "block" = "warn",
): Guardrail {
  return {
    name: "LengthLimit",
    async check(content: string): Promise<GuardrailResult> {
      if (content.length <= maxLength) return GR.pass;
      const reason = `Content length ${content.length} exceeds limit of ${maxLength}`;
      return mode === "block" ? GR.block("LengthLimit", reason) : GR.warn("LengthLimit", reason);
    },
  };
}

/** Uses an LLM to evaluate whether content violates a natural language policy. */
export function llmPolicy(llm: LLMService, policy: string, policyName?: string): Guardrail {
  const name = policyName ?? "LLMPolicy";
  return {
    name,
    async check(content: string): Promise<GuardrailResult> {
      const prompt = [
        ChatMessage.system(
          `You are a content safety evaluator. Evaluate whether the following content violates this policy:\n\n` +
          `Policy: ${policy}\n\n` +
          `Respond with JSON: {"violates": true/false, "reason": "..."}`,
        ),
        ChatMessage.user(content),
      ];
      const result = await llm.chatJson<{ violates: boolean; reason: string }>(prompt);
      return result.violates
        ? GR.block(name, result.reason)
        : GR.pass;
    },
  };
}
