// The highest-value test in MCP_SERVER_PLAN.md: this repo's own MCP client
// wired to this repo's new MCP server through an in-memory transport. It pins
// client and server to one understanding of the wire — if either drifts, this
// breaks before any real deployment does.
import { describe, expect, it } from "vitest";
import { createMCPClient } from "../src/ai/tool/mcp/mcp-client.js";
import type { MCPTransport } from "../src/ai/tool/mcp/transport.js";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import { MCPToolResult } from "../src/ai/tool/types.js";
import type { MCPRequest, MCPResponse } from "../src/mcp/protocol.js";
import { createMCPServer, type MCPServer } from "../src/mcp-server/index.js";

function inMemoryTransport(server: MCPServer): MCPTransport {
  return {
    async send(request: MCPRequest): Promise<MCPResponse> {
      const response = await server.handle(request);
      if (response === null) throw new Error("request got no response");
      return response as MCPResponse;
    },
    close: () => Promise.resolve(),
  };
}

describe("legacy MCPClient ↔ modern dual-era server loopback", () => {
  const registry = createMCPToolRegistry();
  registry.register({
    name: "add",
    description: "adds two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    execute: (input) => {
      const { a, b } = input as { a: number; b: number };
      return Promise.resolve(MCPToolResult.success({ sum: a + b }));
    },
  });
  const server = createMCPServer({ registry, serverInfo: { name: "loopback", version: "1.0.0" } });
  const client = createMCPClient(inMemoryTransport(server));

  it("initialize → listTools → callTool round-trip", async () => {
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe("loopback");
    expect(init.capabilities.tools).toBeDefined();

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["add"]);

    const result = await client.callTool("add", { a: 2, b: 40 });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ sum: 42 });
  });
});
