/** JSON-RPC 2.0 request for MCP protocol. */
export interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response for MCP protocol. */
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

export const MCP_PROTOCOL_VERSION = "2024-11-05";
