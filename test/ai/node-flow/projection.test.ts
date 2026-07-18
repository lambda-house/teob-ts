import { describe, it, expect } from "vitest";
import { projectLLMUsage, LLMUsageEmpty } from "../../../src/ai/node-flow/projection.js";
import type { NodeFlowEvent } from "../../../src/ai/node-flow/aggregate.js";

describe("projectLLMUsage", () => {
  it("accumulates token and call counts from node_succeeded events", () => {
    const events: NodeFlowEvent[] = [
      {
        tag: "node_succeeded",
        nodeId: "n1",
        output: { usage: { model: "gpt-4o", promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
      },
      {
        tag: "node_succeeded",
        nodeId: "n2",
        output: { usage: { model: "gpt-4o", promptTokens: 5, completionTokens: 5, totalTokens: 10, latencyMs: 100 } },
      },
      { tag: "node_succeeded", nodeId: "n3", output: { unrelated: true } },
    ];
    const view = projectLLMUsage(events);
    expect(view.totalCalls).toBe(2);
    expect(view.totalTokens).toBe(40);
    expect(view.totalPromptTokens).toBe(15);
    expect(view.totalCompletionTokens).toBe(25);
    expect(view.totalLatencyMs).toBe(100);
    expect(view.tokensByModel.get("gpt-4o")).toBe(40);
    expect(view.callsByModel.get("gpt-4o")).toBe(2);
  });

  it("empty view defaults to zero counters", () => {
    const v = LLMUsageEmpty();
    expect(v.totalCalls).toBe(0);
    expect(v.tokensByModel.size).toBe(0);
  });
});
