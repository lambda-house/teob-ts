// schema.ts — the one hard rule about tool schemas: inputSchema MUST be a
// JSON Schema *object*, never null or a primitive. Validated at registration
// time (createMCPServer), not at call time — a bad schema is a programming
// error, not a runtime condition.

export function isValidInputSchema(schema: unknown): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

/** The recommended no-argument schema from the 2026-07-28 revision. */
export const NO_ARGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
};
