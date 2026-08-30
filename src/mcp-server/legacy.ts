// legacy.ts — the initialize-era shim. Claude Code still speaks this era to
// stdio servers by default (measured 2026-08-30: its v2 runtime negotiates
// 2026-07-28 on HTTP but uses the legacy handshake on stdio unless
// MCP_PROTOCOL_NEGOTIATION=auto), so this is the primary path for local use,
// not a fallback.
import { LEGACY_PROTOCOL_VERSIONS, type MCPCapabilities, type MCPInitializeResult, type MCPServerInfo } from "../mcp/protocol.js";

/**
 * Echo the client's revision when we know it; otherwise answer with our newest
 * legacy revision and let the client decide (per the legacy lifecycle spec).
 */
export function negotiateLegacyVersion(params: unknown): string {
  const requested =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)["protocolVersion"]
      : undefined;
  if (typeof requested === "string" && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LEGACY_PROTOCOL_VERSIONS[0];
}

export function initializeResult(
  serverInfo: MCPServerInfo,
  capabilities: MCPCapabilities,
  params: unknown,
  instructions?: string,
): MCPInitializeResult {
  return {
    protocolVersion: negotiateLegacyVersion(params),
    capabilities,
    serverInfo,
    ...(instructions !== undefined ? { instructions } : {}),
  };
}
