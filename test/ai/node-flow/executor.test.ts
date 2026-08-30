import { describe, it, expect } from "vitest";
import { executeNode } from "../../../src/ai/node-flow/executor.js";
import type { NodeDef } from "../../../src/ai/node-flow/nodes.js";

describe("executeNode — attribute_op", () => {
  it("writes mapped values from context", async () => {
    const node: NodeDef = {
      kind: "attribute_op",
      reads: [],
      writes: { hello: "name" },
    };
    const r = await executeNode(node, { flowState: { name: "Alice" } });
    expect(r).toEqual({ __signal: "completed", output: { hello: "Alice" } });
  });
});

describe("executeNode — branch", () => {
  it("selects branch by predicate value", async () => {
    const node: NodeDef = {
      kind: "branch",
      predicateAttribute: "status",
      branches: new Map([
        ["ok", "happy_path"],
        ["err", "fail_path"],
      ]),
    };
    const r = await executeNode(node, { flowState: { status: "ok" } });
    expect(r).toEqual({ __signal: "completed", output: { branch: "happy_path" } });
  });
});

describe("executeNode — http_call", () => {
  it("calls fetch and applies responseMapping", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { user: "alice" } }), { status: 200 })) as unknown as typeof fetch;
    const node: NodeDef = {
      kind: "http_call",
      method: "GET",
      urlTemplate: "http://example.com/{{id}}",
      responseMapping: { user: "$.data.user" },
      errorPolicy: { kind: "fail_flow" },
    };
    const r = await executeNode(node, { flowState: { id: 1 }, fetchImpl });
    expect(r).toEqual({ __signal: "completed", output: { user: "alice" } });
  });

  it("captures HTTP errors as output without throwing", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const node: NodeDef = {
      kind: "http_call",
      method: "GET",
      urlTemplate: "http://x",
      responseMapping: {},
      errorPolicy: { kind: "fail_flow" },
    };
    const r = await executeNode(node, { flowState: {}, fetchImpl });
    expect((r as { __signal: string; output: { status: number } }).output.status).toBe(500);
  });
});

describe("executeNode — receive_message and human_approval are blocking", () => {
  it("receive_message → blocking", async () => {
    const r = await executeNode(
      { kind: "receive_message", adapterIds: ["x"] },
      { flowState: {} },
    );
    expect(r).toEqual({ __signal: "blocking" });
  });
  it("human_approval → blocking", async () => {
    const r = await executeNode(
      {
        kind: "human_approval",
        promptTemplate: "approve?",
        approverRoles: ["admin"],
      },
      { flowState: {} },
    );
    expect(r).toEqual({ __signal: "blocking" });
  });
});

describe("executeNode — mcp_tool_exec", () => {
  it("dispatches to MCPToolRegistry and applies outputMapping", async () => {
    const tools = {
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
      getDefinitions() {
        return [];
      },
      async execute(call: { name: string; arguments: unknown }) {
        return { success: true, output: { echo: (call.arguments as { x: number }).x } };
      },
      async executeAll() {
        return [];
      },
    };
    const node: NodeDef = {
      kind: "mcp_tool_exec",
      toolName: "echo",
      inputMapping: { x: "value" },
      outputMapping: { result: "$.echo" },
      errorPolicy: { kind: "fail_flow" },
    };
    const r = await executeNode(node, { flowState: { value: 7 }, tools: tools as any });
    expect(r).toEqual({ __signal: "completed", output: { result: 7 } });
  });
});
