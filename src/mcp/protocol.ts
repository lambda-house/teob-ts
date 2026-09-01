// protocol.ts — era-aware MCP wire types, shared by the client and the server.
//
// The MCP spec has two eras (see MCP_SERVER_PLAN.md and the 2026-07-28 revision):
//   - modern (2026-07-28+): no handshake, every request carries its protocol
//     version in params._meta; results use the { resultType: "complete" } envelope.
//   - legacy (2025-11-25 and earlier): initialize handshake, bare result shapes.
// A server answers both; a request's era is a property of the request, never of
// a connection — the spec removed sessions, and reintroducing one would be a bug.
//
// The legacy shapes here are the exact types that lived in
// src/ai/tool/mcp/protocol.ts (which now re-exports them) — moved, not forked.

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope, spec-wide: ids may be strings or numbers, and a
// response to an unparseable request carries id null.
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

// ---------------------------------------------------------------------------
// Modern era (2026-07-28)
// ---------------------------------------------------------------------------

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** _meta keys defined by the 2026-07-28 revision. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export interface WireToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * Caching hints. The 2026-07-28 revision makes these mandatory on every
 * `resultType: "complete"` result of a cacheable operation (server/discover,
 * tools/list, prompts/list, resources/{list,templates/list,read}) — hence
 * required here, so omitting one is a type error rather than a client-side
 * validation failure. tools/call results are not cacheable and carry none.
 */
export interface CacheHints {
  /** Freshness window in ms; MUST be >= 0. 0 means "immediately stale". */
  ttlMs: number;
  /** "public" only when the result is identical for every caller. */
  cacheScope: "public" | "private";
}

/** server/discover result — mandatory RPC in the modern era. */
export interface DiscoverResult extends CacheHints {
  resultType: "complete";
  supportedVersions: string[];
  capabilities: MCPCapabilities;
  _meta: { [META_SERVER_INFO]: MCPServerInfo };
  instructions?: string;
}

export interface ModernToolsListResult extends CacheHints {
  resultType: "complete";
  tools: WireToolDef[];
  nextCursor?: string;
}

export interface ModernToolCallResult {
  resultType: "complete";
  content: TextContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Legacy era (initialize handshake; 2025-11-25 and earlier)
// ---------------------------------------------------------------------------

/** Legacy protocol revisions this package's server shim will negotiate. */
export const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** JSON-RPC 2.0 request for MCP protocol (legacy client shape: numeric ids). */
export interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response for MCP protocol (legacy client shape). */
export interface MCPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: MCPError;
}

/** JSON-RPC 2.0 error. */
export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 notification (no id). */
export interface MCPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** MCP server info from initialize handshake. */
export interface MCPServerInfo {
  name: string;
  version: string;
}

/** MCP server capabilities. */
export interface MCPCapabilities {
  tools?: { listChanged?: boolean };
}

/** Result of the MCP initialize handshake. */
export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPCapabilities;
  serverInfo: MCPServerInfo;
  instructions?: string;
}

/** MCP tool definition from listTools. */
export interface MCPRemoteToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Result of tools/list. */
export interface MCPToolListResult {
  tools: MCPRemoteToolDef[];
}

/** Result of tools/call. */
export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The era the existing client (src/ai/tool/mcp) pins. Kept for backward
 * compatibility; the server supports MODERN_PROTOCOL_VERSION plus every
 * LEGACY_PROTOCOL_VERSIONS entry.
 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
