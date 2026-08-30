// Branded CallId + structured CallError ADT.

declare const callIdBrand: unique symbol;
export type CallId = string & { readonly [callIdBrand]: "CallId" };

export const CallId = {
  generate: (): CallId => globalThis.crypto.randomUUID() as CallId,
  of: (s: string): CallId => s as CallId,
};

export type CallError =
  | { type: "http_status"; code: number; body: string }
  | { type: "timeout"; durationMs: number }
  | { type: "connection_refused"; target: string }
  | { type: "circuit_open"; name: string }
  | { type: "custom"; message: string; cause?: unknown };

export const CallError = {
  httpStatus: (code: number, body: string): CallError => ({ type: "http_status", code, body }),
  timeout: (durationMs: number): CallError => ({ type: "timeout", durationMs }),
  connectionRefused: (target: string): CallError => ({ type: "connection_refused", target }),
  circuitOpen: (name: string): CallError => ({ type: "circuit_open", name }),
  custom: (message: string, cause?: unknown): CallError => ({ type: "custom", message, cause }),
};

export type CallResult<Resp> =
  | { ok: true; value: Resp }
  | { ok: false; error: CallError };

/**
 * Default heuristic for "should we retry this error?".
 * - HTTP 5xx and 429 — yes.
 * - Network timeouts and connection refused — yes.
 * - Circuit-open — no (the breaker manages its own retries).
 * - Custom — no by default; callers can override per-DurableCall.
 */
export function isTransient(e: CallError): boolean {
  switch (e.type) {
    case "http_status":
      return e.code >= 500 || e.code === 429;
    case "timeout":
    case "connection_refused":
      return true;
    case "circuit_open":
    case "custom":
      return false;
  }
}

export function errorToString(e: CallError): string {
  switch (e.type) {
    case "http_status":
      return `http_status ${e.code}: ${e.body}`;
    case "timeout":
      return `timeout after ${e.durationMs}ms`;
    case "connection_refused":
      return `connection_refused: ${e.target}`;
    case "circuit_open":
      return `circuit_open: ${e.name}`;
    case "custom":
      return e.message;
  }
}

export function errorTypeLabel(e: CallError): string {
  switch (e.type) {
    case "http_status":
      return `http_${e.code}`;
    case "timeout":
      return "timeout";
    case "connection_refused":
      return "connection_refused";
    case "circuit_open":
      return "circuit_open";
    case "custom":
      return "custom";
  }
}
