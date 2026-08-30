import type { Guardrail, GuardrailContext, GuardrailResult } from "./types.js";

/**
 * Compose multiple guardrails sequentially. Short-circuits on the first Block.
 * Returns the most severe result (Block > Warn > Pass).
 */
export function guardrailChain(guardrails: Guardrail[]): Guardrail {
  return {
    name: "GuardrailChain",
    async check(content: string, context: GuardrailContext): Promise<GuardrailResult> {
      let worstResult: GuardrailResult = { tag: "Pass" };

      for (const g of guardrails) {
        const result = await g.check(content, context);
        if (result.tag === "Block") return result;
        if (result.tag === "Warn" && worstResult.tag === "Pass") {
          worstResult = result;
        }
      }

      return worstResult;
    },
  };
}

/**
 * Compose multiple guardrails, running all even if some block.
 * Returns the most severe result found across all checks.
 */
export function guardrailChainCollectAll(guardrails: Guardrail[]): Guardrail {
  return {
    name: "GuardrailChain",
    async check(content: string, context: GuardrailContext): Promise<GuardrailResult> {
      let worstResult: GuardrailResult = { tag: "Pass" };

      for (const g of guardrails) {
        const result = await g.check(content, context);
        if (result.tag === "Block") {
          worstResult = result;
        } else if (result.tag === "Warn" && worstResult.tag === "Pass") {
          worstResult = result;
        }
      }

      return worstResult;
    },
  };
}
