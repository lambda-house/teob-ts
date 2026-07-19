import type { MCPToolRegistry } from "../mcp-tool-registry.js";
import { MCPToolResult as MCPToolResultFactory } from "../types.js";
import type { MCPTool, MCPToolResult } from "../types.js";
import type {
  MCPInitializeResult,
  MCPRemoteToolDef,
  MCPToolCallResult,
  MCPToolListResult,
} from "./protocol.js";
import { MCP_PROTOCOL_VERSION } from "./protocol.js";
import type { MCPTransport } from "./transport.js";

/** Client for connecting to external MCP servers. */
export interface MCPClient {
  /** Perform the MCP initialize handshake. */
  initialize(): Promise<MCPInitializeResult>;
  /** List available tools from the remote server. */
  listTools(): Promise<MCPRemoteToolDef[]>;
  /** Call a remote tool by name. */
  callTool(name: string, args: unknown): Promise<MCPToolResult>;
  /** Register all remote tools into a local registry. */
  registerAll(registry: MCPToolRegistry): Promise<void>;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Create an MCP client over the given transport.
 */
export function createMCPClient(transport: MCPTransport): MCPClient {
  let requestId = 0;

  async function rpc<R>(method: string, params?: unknown): Promise<R> {
    const id = ++requestId;
    const response = await transport.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    if (response.error) {
      throw new Error(`MCP error [${response.error.code}]: ${response.error.message}`);
    }

    return response.result as R;
  }

  return {
    async initialize(): Promise<MCPInitializeResult> {
      const result = await rpc<MCPInitializeResult>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "teob-ts", version: "1.0.0" },
      });

      // Send initialized notification (no response expected)
      await transport.send({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "notifications/initialized",
      });

      return result;
    },

    async listTools(): Promise<MCPRemoteToolDef[]> {
      const result = await rpc<MCPToolListResult>("tools/list");
      return result.tools;
    },

    async callTool(name: string, args: unknown): Promise<MCPToolResult> {
      try {
        const result = await rpc<MCPToolCallResult>("tools/call", { name, arguments: args });
        const text = result.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        return result.isError
          ? MCPToolResultFactory.failure(text || "Tool execution failed")
          : MCPToolResultFactory.success(text ? tryParseJson(text) : null);
      } catch (err) {
        return MCPToolResultFactory.failure(err instanceof Error ? err.message : String(err));
      }
    },

    async registerAll(registry: MCPToolRegistry): Promise<void> {
      const tools = await this.listTools();
      const client = this;

      for (const def of tools) {
        const tool: MCPTool = {
          name: def.name,
          description: def.description ?? "",
          inputSchema: def.inputSchema,
          async execute(input: unknown): Promise<MCPToolResult> {
            return client.callTool(def.name, input);
          },
        };
        registry.register(tool);
      }
    },

    async close(): Promise<void> {
      await transport.close();
    },
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
