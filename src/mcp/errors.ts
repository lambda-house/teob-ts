// errors.ts — JSON-RPC error codes for MCP, including the codes the
// 2026-07-28 revision allocates from the protocol-reserved sub-range.
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcResponse } from "./protocol.js";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** HTTP header/body mismatch (Streamable HTTP). Always paired with HTTP 400. */
export const HEADER_MISMATCH = -32020;
/** Requested protocol version not supported; data lists supported versions. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcErrorObject = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}

export function unsupportedVersionResponse(
  id: JsonRpcId | null,
  requested: string | null,
  supported: string[],
): JsonRpcResponse {
  return errorResponse(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
    supported,
    requested,
  });
}

/** Modern error codes a dual-era client must recognize before falling back. */
export function isModernErrorCode(code: number): boolean {
  return code === UNSUPPORTED_PROTOCOL_VERSION || code === HEADER_MISMATCH;
}
