import { describe, expect, it } from "vitest";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import { MCPToolResult, ToolPermission } from "../src/ai/tool/types.js";
import { INVALID_PARAMS, METHOD_NOT_FOUND, UNSUPPORTED_PROTOCOL_VERSION } from "../src/mcp/errors.js";
import { META_PROTOCOL_VERSION, META_SERVER_INFO, MODERN_PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { createMCPServer } from "../src/mcp-server/index.js";

const OBJ_SCHEMA = { type: "object", additionalProperties: false };

function testRegistry() {
  const registry = createMCPToolRegistry();
  registry.register({
    name: "echo",
    description: "echoes its arguments",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute: (input) => Promise.resolve(MCPToolResult.success({ echoed: input })),
  });
  registry.register({
    name: "fail",
    description: "always fails",
    inputSchema: OBJ_SCHEMA,
    execute: () => Promise.resolve(MCPToolResult.failure("boom")),
  });
  registry.register({
    name: "throws",
    description: "always throws",
    inputSchema: OBJ_SCHEMA,
    execute: () => Promise.reject(new Error("kaput")),
  });
  registry.register({
    name: "secret",
    description: "requires confirmation",
    inputSchema: OBJ_SCHEMA,
    permission: ToolPermission.Confirm,
    execute: () => Promise.resolve(MCPToolResult.success("should never run")),
  });
  return registry;
}

function makeServer() {
  return createMCPServer({
    registry: testRegistry(),
    serverInfo: { name: "test-server", version: "1.2.3" },
    instructions: "for tests",
  });
}

const modernMeta = { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION };
const req = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe("modern era", () => {
  const server = makeServer();

  it("server/discover", async () => {
    const res = await server.handle(req("d1", "server/discover", { _meta: modernMeta }));
    expect(res?.error).toBeUndefined();
    expect(res?.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: "for tests",
    });
    expect((res?.result as Record<string, unknown>)["_meta"]).toEqual({
      [META_SERVER_INFO]: { name: "test-server", version: "1.2.3" },
    });
  });

  it("tools/list carries the modern envelope, sorted, without Confirm tools", async () => {
    const res = await server.handle(req(1, "tools/list", { _meta: modernMeta }));
    const result = res?.result as { resultType: string; tools: { name: string; outputSchema?: unknown }[] };
    expect(result.resultType).toBe("complete");
    expect(result.tools.map((t) => t.name)).toEqual(["echo", "fail", "throws"]);
    expect(result.tools[0]?.outputSchema).toEqual({ type: "object" });
  });

  it("tools/call success → structuredContent + serialized text", async () => {
    const res = await server.handle(
      req(2, "tools/call", { name: "echo", arguments: { a: 1 }, _meta: modernMeta }),
    );
    expect(res?.result).toMatchObject({
      resultType: "complete",
      isError: false,
      structuredContent: { echoed: { a: 1 } },
      content: [{ type: "text", text: JSON.stringify({ echoed: { a: 1 } }) }],
    });
  });

  it("failing tool → isError result, NOT a JSON-RPC error", async () => {
    const res = await server.handle(req(3, "tools/call", { name: "fail", arguments: {}, _meta: modernMeta }));
    expect(res?.error).toBeUndefined();
    expect(res?.result).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
  });

  it("throwing tool → isError result, NOT a JSON-RPC error", async () => {
    const res = await server.handle(req(4, "tools/call", { name: "throws", arguments: {}, _meta: modernMeta }));
    expect(res?.error).toBeUndefined();
    expect(res?.result).toMatchObject({ isError: true, content: [{ type: "text", text: "kaput" }] });
  });

  it("unknown tool → JSON-RPC -32602, NOT isError", async () => {
    const res = await server.handle(req(5, "tools/call", { name: "nope", arguments: {}, _meta: modernMeta }));
    expect(res?.result).toBeUndefined();
    expect(res?.error?.code).toBe(INVALID_PARAMS);
  });

  it("a Confirm tool is indistinguishable from an unknown one — fail closed", async () => {
    const res = await server.handle(req(6, "tools/call", { name: "secret", arguments: {}, _meta: modernMeta }));
    expect(res?.error?.code).toBe(INVALID_PARAMS);
  });

  it("unsupported version → -32022 with supported list", async () => {
    const res = await server.handle(
      req(7, "tools/list", { _meta: { [META_PROTOCOL_VERSION]: "1900-01-01" } }),
    );
    expect(res?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(res?.error?.data).toEqual({ supported: [MODERN_PROTOCOL_VERSION], requested: "1900-01-01" });
  });

  it("unknown method → -32601", async () => {
    const res = await server.handle(req(8, "resources/list", { _meta: modernMeta }));
    expect(res?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  it("ping works in both eras", async () => {
    expect((await server.handle(req(9, "ping", { _meta: modernMeta })))?.result).toEqual({});
    expect((await server.handle(req(10, "ping")))?.result).toEqual({});
  });
});

describe("legacy era", () => {
  const server = makeServer();

  it("initialize echoes a known requested version", async () => {
    const res = await server.handle(req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
    expect(res?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "test-server", version: "1.2.3" },
    });
  });

  it("initialize with an unknown version answers our newest legacy revision", async () => {
    const res = await server.handle(req(1, "initialize", { protocolVersion: "2023-01-01" }));
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  it("notifications/initialized as a true notification → no response", async () => {
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("notifications/initialized sent as a request (legacy client quirk) → acknowledged", async () => {
    const res = await server.handle(req(2, "notifications/initialized"));
    expect(res?.result).toEqual({});
  });

  it("legacy tools/list has NO resultType envelope", async () => {
    const res = await server.handle(req(3, "tools/list"));
    const result = res?.result as Record<string, unknown>;
    expect(result["resultType"]).toBeUndefined();
    expect((result["tools"] as unknown[]).length).toBe(3);
  });

  it("legacy tools/call has the bare result shape", async () => {
    const res = await server.handle(req(4, "tools/call", { name: "echo", arguments: { x: true } }));
    expect(res?.result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ echoed: { x: true } }) }],
    });
    expect((res?.result as Record<string, unknown>)["resultType"]).toBeUndefined();
  });

  it("same call in both eras yields equivalent content (era matrix pin)", async () => {
    const legacy = await server.handle(req(5, "tools/call", { name: "echo", arguments: { n: 1 } }));
    const modern = await server.handle(
      req(6, "tools/call", { name: "echo", arguments: { n: 1 }, _meta: modernMeta }),
    );
    const legacyResult = legacy?.result as Record<string, unknown>;
    const modernResult = modern?.result as Record<string, unknown>;
    expect(legacyResult["content"]).toEqual(modernResult["content"]);
    expect(modernResult["resultType"]).toBe("complete");
  });

  it("legacyCompat: false rejects initialize naming supported versions", async () => {
    const strict = createMCPServer({
      registry: testRegistry(),
      serverInfo: { name: "strict", version: "0" },
      legacyCompat: false,
    });
    const res = await strict.handle(req(1, "initialize", { protocolVersion: "2025-06-18" }));
    expect(res?.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(res?.error?.data).toMatchObject({ supported: [MODERN_PROTOCOL_VERSION] });
  });
});

describe("malformed input", () => {
  const server = makeServer();

  it("non-object → invalid request with id null", async () => {
    const res = await server.handle("what");
    expect(res?.id).toBeNull();
    expect(res?.error?.code).toBe(-32600);
  });

  it("missing method on a request → invalid request", async () => {
    const res = await server.handle({ jsonrpc: "2.0", id: 1 });
    expect(res?.error?.code).toBe(-32600);
  });

  it("string ids are legal", async () => {
    const res = await server.handle(req("abc", "ping"));
    expect(res?.id).toBe("abc");
  });

  it("handle never throws — a registry with a bad schema fails at construction instead", () => {
    const registry = createMCPToolRegistry();
    registry.register({
      name: "bad",
      description: "schema is null",
      inputSchema: null,
      execute: () => Promise.resolve(MCPToolResult.success(null)),
    });
    expect(() =>
      createMCPServer({ registry, serverInfo: { name: "x", version: "0" } }),
    ).toThrow(/invalid inputSchema/);
  });
});
