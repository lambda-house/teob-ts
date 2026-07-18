export class RecordingExhaustedError extends Error {
  readonly tag = "RecordingExhausted" as const;
  constructor(public requested: number, public available: number, public kind: "llm" | "tool") {
    super(
      `Recording exhausted: requested ${kind} call #${requested}, only ${available} available.`,
    );
  }
}
