// meta.ts — reading the per-request _meta block the modern era replaced the
// initialize handshake with. Era detection lives here: a request with the
// protocolVersion _meta key is modern; everything else is legacy or malformed.
import { META_PROTOCOL_VERSION } from "./protocol.js";

export function paramsOf(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const params = (message as Record<string, unknown>)["params"];
  if (typeof params !== "object" || params === null) return undefined;
  return params as Record<string, unknown>;
}

export function metaOf(message: unknown): Record<string, unknown> | undefined {
  const meta = paramsOf(message)?.["_meta"];
  if (typeof meta !== "object" || meta === null) return undefined;
  return meta as Record<string, unknown>;
}

/** The protocol version a modern request declares, or null for a legacy one. */
export function requestedProtocolVersion(message: unknown): string | null {
  const version = metaOf(message)?.[META_PROTOCOL_VERSION];
  return typeof version === "string" ? version : null;
}
