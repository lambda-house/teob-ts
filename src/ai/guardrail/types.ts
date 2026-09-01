/** Direction of content being checked. */
export type Direction = "Input" | "Output";

/** Context for guardrail evaluation. */
export interface GuardrailContext {
  direction: Direction;
  agentId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of a guardrail check. */
export type GuardrailResult =
  | { tag: "Pass" }
  | { tag: "Warn"; name: string; reason: string }
  | { tag: "Block"; name: string; reason: string; suggestion?: string };

export const GuardrailResult = {
  pass: { tag: "Pass" } as GuardrailResult,
  warn: (name: string, reason: string): GuardrailResult => ({ tag: "Warn", name, reason }),
  block: (name: string, reason: string, suggestion?: string): GuardrailResult =>
    ({ tag: "Block", name, reason, suggestion }),
};

/** A content safety policy that checks text against rules. */
export interface Guardrail {
  readonly name: string;
  check(content: string, context: GuardrailContext): Promise<GuardrailResult>;
}
