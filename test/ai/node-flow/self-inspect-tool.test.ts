import { describe, it, expect } from "vitest";
import { createSelfInspectTool } from "../../../src/ai/node-flow/self-inspect-tool.js";
import type { NodeFlowState } from "../../../src/ai/node-flow/aggregate.js";

const makeState = (over: Partial<NodeFlowState> = {}): NodeFlowState => ({
  status: "running",
  flowDefId: "f1",
  nodeStatuses: new Map([["a", "running"]]),
  nodeOutputs: new Map(),
  context: { foo: 1 },
  activeNodeCount: 1,
  waitingNodes: new Set(),
  ...over,
});

describe("self_inspect tool", () => {
  it("query=tools returns registered tools", async () => {
    const tool = createSelfInspectTool({
      agentId: "agent-1",
      flows: async () => [],
      tools: async () => [{ name: "search", description: "Web search", inputSchema: {} }],
      state: async () => makeState(),
    });
    const r = await tool.execute({ query: "tools" });
    expect(r.success).toBe(true);
    expect(r.output).toMatchObject({ agentId: "agent-1", tools: [{ name: "search" }] });
  });

  it("query=state surfaces status and active nodes", async () => {
    const tool = createSelfInspectTool({
      agentId: "agent-1",
      flows: async () => [],
      tools: async () => [],
      state: async () => makeState({ status: "waiting_for_input" }),
    });
    const r = await tool.execute({ query: "state" });
    expect(r.success).toBe(true);
    expect((r.output as { status: string }).status).toBe("waiting_for_input");
  });

  it("query=attributes returns flow context", async () => {
    const tool = createSelfInspectTool({
      agentId: "agent-1",
      flows: async () => [],
      tools: async () => [],
      state: async () => makeState({ context: { x: 5, y: "hi" } }),
    });
    const r = await tool.execute({ query: "attributes" });
    expect((r.output as { attributes: { x: number } }).attributes.x).toBe(5);
  });

  it("query=capabilities returns [] when not configured", async () => {
    const tool = createSelfInspectTool({
      agentId: "agent-1",
      flows: async () => [],
      tools: async () => [],
      state: async () => makeState(),
    });
    const r = await tool.execute({ query: "capabilities" });
    expect((r.output as { capabilities: unknown[] }).capabilities).toEqual([]);
  });

  it("unknown query → failure", async () => {
    const tool = createSelfInspectTool({
      agentId: "agent-1",
      flows: async () => [],
      tools: async () => [],
      state: async () => makeState(),
    });
    const r = await tool.execute({ query: "unknown" });
    expect(r.success).toBe(false);
  });
});
