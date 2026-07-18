import type { MCPRequest, MCPResponse } from "./protocol.js";
import type { MCPTransport } from "./transport.js";

/**
 * HTTP+SSE transport: sends JSON-RPC requests via HTTP POST
 * and receives responses.
 */
export function createHttpSseTransport(
  baseUrl: string,
  headers?: Record<string, string>,
): MCPTransport {
  return {
    async send(request: MCPRequest): Promise<MCPResponse> {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`MCP HTTP error ${response.status}: ${text}`);
      }

      return await response.json() as MCPResponse;
    },

    async close(): Promise<void> {
      // HTTP transport is stateless, nothing to close
    },
  };
}
