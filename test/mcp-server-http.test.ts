import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import { MCPToolResult } from "../src/ai/tool/types.js";
import { HEADER_MISMATCH, METHOD_NOT_FOUND } from "../src/mcp/errors.js";
import { META_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { createMCPServer, mcpHono } from "../src/mcp-server/index.js";

function makeApp(allowedOrigins?: string[]) {
  const registry = createMCPToolRegistry();
  registry.register({
    name: "echo",
    description: "echoes",
    inputSchema: { type: "object" },
    execute: (input) => Promise.resolve(MCPToolResult.success({ echoed: input })),
  });
  registry.register({
    name: "névé", // deliberately not header-safe
    description: "unicode-named tool",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve(MCPToolResult.success("snow")),
  });
  const server = createMCPServer({ registry, serverInfo: { name: "http-test", version: "0.0.0" } });
  const app = new Hono();
  app.route("/mcp", mcpHono(server, allowedOrigins ? { allowedOrigins } : {}));
  return app;
}

const meta = { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION };

function post(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const modernHeaders = (method: string, name?: string): Record<string, string> => ({
  "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
  "mcp-method": method,
  ...(name !== undefined ? { "mcp-name": name } : {}),
});

describe("streamable HTTP", () => {
  const app = makeApp();

  it("modern tools/call with matching headers → 200", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1 }, _meta: meta } },
      modernHeaders("tools/call", "echo"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { structuredContent: unknown } };
    expect(body.result.structuredContent).toEqual({ echoed: { a: 1 } });
  });

  it("missing MCP-Protocol-Version header on a modern request → 400 -32020", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } },
      { "mcp-method": "tools/list" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(HEADER_MISMATCH);
  });

  it("Mcp-Method mismatching the body → 400 -32020", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: meta } },
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": "tools/call" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(HEADER_MISMATCH);
  });

  it("Mcp-Name mismatch → 400; matching → 200", async () => {
    const bad = await post(
      app,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: {}, _meta: meta } },
      modernHeaders("tools/call", "other"),
    );
    expect(bad.status).toBe(400);
  });

  it("base64 sentinel Mcp-Name decodes before comparison", async () => {
    const encoded = `=?base64?${Buffer.from("névé", "utf8").toString("base64")}?=`;
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "névé", arguments: {}, _meta: meta } },
      modernHeaders("tools/call", encoded),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]?.text).toBe("snow");
  });

  it("unknown method → 404 with -32601 body (modern-vs-legacy-SSE discriminator)", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 6, method: "resources/list", params: { _meta: meta } },
      modernHeaders("resources/list"),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(METHOD_NOT_FOUND);
  });

  it("unsupported version → 400 with -32022 body", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: { [META_PROTOCOL_VERSION]: "1900-01-01" } } },
      { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32022);
  });

  it("notification → 202 with no body", async () => {
    const res = await post(app, { jsonrpc: "2.0", method: "notifications/cancelled" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("legacy initialize without modern headers → 200 (dual-era endpoint)", async () => {
    const res = await post(app, { jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("GET and DELETE → 405 (no GET stream, no sessions in this revision)", async () => {
    expect((await app.request("/mcp", { method: "GET" })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE" })).status).toBe(405);
  });

  it("unparseable body → 400 -32700", async () => {
    const res = await app.request("/mcp", { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("unknown tool → 200 with a JSON-RPC error body (protocol error, not transport error)", async () => {
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ghost", arguments: {}, _meta: meta } },
      modernHeaders("tools/call", "ghost"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe("origin validation", () => {
  it("absent Origin is accepted; unlisted Origin → 403; listed → 200", async () => {
    const app = makeApp(["https://claude.ai"]);
    const body = { jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: meta } };
    const headers = { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": "ping" };

    expect((await post(app, body, headers)).status).toBe(200);
    expect((await post(app, body, { ...headers, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, body, { ...headers, origin: "https://claude.ai" })).status).toBe(200);
  });

  it("with no origin policy configured, any present Origin is rejected (rebinding defence)", async () => {
    const app = makeApp();
    const res = await post(
      app,
      { jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: meta } },
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": "ping", origin: "https://anything.example" },
    );
    expect(res.status).toBe(403);
  });
});
