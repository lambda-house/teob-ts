// The MCP wire types moved to src/mcp/protocol.ts, where both the client
// (this directory) and the server (src/mcp-server/) share one definition.
// This file stays as a re-export so deep imports keep working.
export {
  MCP_PROTOCOL_VERSION,
  type MCPCapabilities,
  type MCPError,
  type MCPInitializeResult,
  type MCPNotification,
  type MCPRemoteToolDef,
  type MCPRequest,
  type MCPResponse,
  type MCPServerInfo,
  type MCPToolCallResult,
  type MCPToolListResult,
} from "../../../mcp/protocol.js";
