export type BackoffStrategy =
  | { kind: "fibonacci" }
  | { kind: "exponential"; factor: number }
  | { kind: "fixed" };

export interface RetryPolicy {
  /** Maximum total attempts, including the initial attempt. Must be ≥ 1. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  strategy: BackoffStrategy;
}

function fibonacci(n: number): number {
  // Returns nth fibonacci number, 1-indexed (F_1 = 1, F_2 = 1, F_3 = 2, ...).
  if (n <= 2) return 1;
  let a = 1;
  let b = 1;
  for (let i = 3; i <= n; i++) {
    const c = a + b;
    a = b;
    b = c;
  }
  return b;
}

export const RetryPolicy = {
  default: (): RetryPolicy => ({
    maxAttempts: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 5 * 60_000,
    strategy: { kind: "fibonacci" },
  }),

  /**
   * Compute the delay (in ms) before the *next* attempt, given that
   * `attempt` attempts have already failed. `attempt` is 1-indexed:
   * delayFor(p, 1) = delay before the 2nd attempt.
   */
  delayFor(p: RetryPolicy, attempt: number): number {
    if (attempt < 1) return 0;
    let raw: number;
    switch (p.strategy.kind) {
      case "fibonacci":
        raw = fibonacci(attempt) * p.initialDelayMs;
        break;
      case "exponential": {
        const factor = p.strategy.factor;
        raw = p.initialDelayMs * Math.pow(factor, attempt - 1);
        break;
      }
      case "fixed":
        raw = p.initialDelayMs;
        break;
    }
    return Math.min(raw, p.maxDelayMs);
  },
};
