import type { MCPRequest, MCPResponse } from "./protocol.js";

/**
 * Abstract transport for MCP communication.
 * Handles sending JSON-RPC requests and receiving responses.
 */
export interface MCPTransport {
  send(request: MCPRequest): Promise<MCPResponse>;
  close(): Promise<void>;
}
