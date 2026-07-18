import type { CallId, CallError, CallResult } from "./types.js";
import { CallError as Err } from "./types.js";
import type { DurableCall } from "./durable-call.js";
import type { CircuitBreakerConfig, CircuitBreaker } from "./circuit-breaker.js";
import { CircuitBreaker as CB, CircuitOpenError } from "./circuit-breaker.js";

export interface CallGatewayConfig {
  maxConcurrent: number;
  callTimeoutMs: number;
  circuitBreaker?: CircuitBreakerConfig;
  /** Optional clock injection for tests. */
  clock?: () => number;
}

export interface CallGateway {
  readonly name: string;
  execute<Req, Resp>(
    call: DurableCall<Req, Resp>,
    request: Req,
    callId: CallId,
  ): Promise<CallResult<Resp>>;
  /** Returns the underlying breaker if one was configured (for metrics). */
  readonly breaker?: CircuitBreaker;
}

class Semaphore {
  private inflight = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number) {}
  async acquire(): Promise<void> {
    if (this.inflight < this.limit) {
      this.inflight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inflight += 1;
  }
  release(): void {
    this.inflight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
  get current(): number {
    return this.inflight;
  }
}

function raceWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "ok"; value: T } | { kind: "timeout" }> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ kind: "ok", value: v });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        // Propagate by re-throwing through a rejected promise:
        resolve({ kind: "ok", value: Promise.reject(err) as unknown as T });
      },
    );
  });
}

export const CallGateway = {
  create(name: string, cfg: CallGatewayConfig): CallGateway {
    return createGateway(name, cfg);
  },
};

function createGateway(name: string, cfg: CallGatewayConfig): CallGateway {
  const sem = new Semaphore(cfg.maxConcurrent);
  const breaker = cfg.circuitBreaker
    ? CB.create(name, { ...cfg.circuitBreaker, clock: cfg.clock })
    : undefined;

  async function executeCall<Req, Resp>(
    call: DurableCall<Req, Resp>,
    request: Req,
    callId: CallId,
  ): Promise<CallResult<Resp>> {
    await sem.acquire();
    try {
      const op = async (): Promise<CallResult<Resp>> => {
        const raced = await raceWithTimeout(call.execute(request, callId), cfg.callTimeoutMs);
        if (raced.kind === "timeout") {
          return { ok: false, error: Err.timeout(cfg.callTimeoutMs) };
        }
        try {
          const v = await Promise.resolve(raced.value);
          return v;
        } catch (err) {
          return { ok: false, error: Err.custom(`gateway exec threw: ${String(err)}`, err) };
        }
      };

      if (!breaker) return await op();

      try {
        return await breaker.protectEither<Resp, CallError>(
          op,
          (e) => e.type !== "circuit_open",
        );
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          return { ok: false, error: Err.circuitOpen(name) };
        }
        throw err;
      }
    } finally {
      sem.release();
    }
  }

  return {
    name,
    execute: executeCall,
    breaker,
  };
}
