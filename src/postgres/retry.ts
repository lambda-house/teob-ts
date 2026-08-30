export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const defaultRetryConfig: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

function isTransientError(e: unknown): boolean {
  const msg = (e instanceof Error ? (e.message + (e.cause ?? "")) : String(e)).toLowerCase();
  return (
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("timeout") ||
    msg.includes("closed") ||
    msg.includes("reset") ||
    msg.includes("broken pipe") ||
    msg.includes("pool") ||
    msg.includes("econnrefused")
  );
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = defaultRetryConfig,
): Promise<T> {
  let delay = config.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt >= config.maxRetries || !isTransientError(e)) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}
