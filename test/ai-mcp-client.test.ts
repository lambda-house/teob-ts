import { describe, it, expect } from "vitest";
import { createMCPClient } from "../src/ai/tool/mcp/mcp-client.js";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import type { MCPTransport } from "../src/ai/tool/mcp/transport.js";
import type { MCPRequest, MCPResponse } from "../src/ai/tool/mcp/protocol.js";

function createInMemoryTransport(
  handlers: Record<string, (params?: unknown) => unknown>,
): MCPTransport {
  return {
    async send(request: MCPRequest): Promise<MCPResponse> {
      const handler = handlers[request.method];
      if (!handler) {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
      }
      return { jsonrpc: "2.0", id: request.id, result: handler(request.params) };
    },
    async close() {},
  };
}

describe("MCPClient", () => {
  it("should initialize and receive server info", async () => {
    const transport = createInMemoryTransport({
      initialize: () => ({
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "test-server", version: "1.0" },
      }),
      "notifications/initialized": () => ({}),
    });

    const client = createMCPClient(transport);
    const result = await client.initialize();
    expect(result.serverInfo.name).toBe("test-server");
    expect(result.protocolVersion).toBe("2024-11-05");
    await client.close();
  });

  it("should list tools from remote server", async () => {
    const transport = createInMemoryTransport({
      "tools/list": () => ({
        tools: [
          { name: "search", description: "Search the web", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
          { name: "calculator", description: "Compute math", inputSchema: { type: "object", properties: { expr: { type: "string" } } } },
        ],
      }),
    });

    const client = createMCPClient(transport);
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("search");
    expect(tools[1].name).toBe("calculator");
    await client.close();
  });

  it("should call a tool and return result", async () => {
    const transport = createInMemoryTransport({
      "tools/call": (params: unknown) => {
        const p = params as { name: string; arguments: unknown };
        return {
          content: [{ type: "text", text: `Result for ${p.name}: ${JSON.stringify(p.arguments)}` }],
        };
      },
    });

    const client = createMCPClient(transport);
    const result = await client.callTool("search", { q: "hello" });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Result for search: {"q":"hello"}');
    await client.close();
  });

  it("should handle tool call errors", async () => {
    const transport = createInMemoryTransport({
      "tools/call": () => ({
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      }),
    });

    const client = createMCPClient(transport);
    const result = await client.callTool("broken", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
    await client.close();
  });

  it("should register remote tools into local registry", async () => {
    const transport = createInMemoryTransport({
      "tools/list": () => ({
        tools: [
          { name: "remote_tool", description: "A remote tool", inputSchema: { type: "object" } },
        ],
      }),
      "tools/call": () => ({
        content: [{ type: "text", text: '{"result": "ok"}' }],
      }),
    });

    const client = createMCPClient(transport);
    const registry = createMCPToolRegistry();
    await client.registerAll(registry);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("remote_tool")).toBeDefined();

    const result = await registry.execute({ name: "remote_tool", arguments: {} });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ result: "ok" });
    await client.close();
  });

  it("should handle MCP protocol errors", async () => {
    const transport = createInMemoryTransport({});
    const client = createMCPClient(transport);

    await expect(client.listTools()).rejects.toThrow("MCP error");
    await client.close();
  });
});
