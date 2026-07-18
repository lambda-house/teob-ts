import { describe, it, expect } from "vitest";
import { collectStream } from "../src/ai/llm/stream-accumulator.js";
import type { LLMStreamChunk, LLMResponseMeta } from "../src/ai/llm/types.js";

describe("StreamAccumulator", () => {
  async function* chunks(...items: LLMStreamChunk[]): AsyncIterable<LLMStreamChunk> {
    for (const item of items) yield item;
  }

  const doneMeta: LLMResponseMeta = {
    responseId: "resp-1",
    model: "gpt-4o-mini",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    cost: { inputCostUsd: 0.001, outputCostUsd: 0.002, totalCostUsd: 0.003 },
    finishReason: "stop",
    latencyMs: 150,
  };

  it("should collect content deltas into a single Content response", async () => {
    const stream = chunks(
      { tag: "ContentDelta", text: "Hello" },
      { tag: "ContentDelta", text: ", " },
      { tag: "ContentDelta", text: "world!" },
      { tag: "Done", meta: doneMeta },
    );

    const result = await collectStream(stream);
    expect(result.value.tag).toBe("Content");
    if (result.value.tag === "Content") {
      expect(result.value.text).toBe("Hello, world!");
    }
    expect(result.meta).toEqual(doneMeta);
  });

  it("should collect tool call deltas into complete tool calls", async () => {
    const stream = chunks(
      { tag: "ToolCallDelta", index: 0, id: "call-1", name: "search", argumentsDelta: '{"q' },
      { tag: "ToolCallDelta", index: 0, id: undefined, name: undefined, argumentsDelta: 'uery": "hello"}' },
      { tag: "Done", meta: doneMeta },
    );

    const result = await collectStream(stream);
    expect(result.value.tag).toBe("ToolCalls");
    if (result.value.tag === "ToolCalls") {
      expect(result.value.calls).toHaveLength(1);
      expect(result.value.calls[0].id).toBe("call-1");
      expect(result.value.calls[0].function.name).toBe("search");
      expect(result.value.calls[0].function.arguments).toBe('{"query": "hello"}');
    }
  });

  it("should accumulate multiple tool calls by index", async () => {
    const stream = chunks(
      { tag: "ToolCallDelta", index: 0, id: "call-1", name: "search", argumentsDelta: '{"q": "a"}' },
      { tag: "ToolCallDelta", index: 1, id: "call-2", name: "lookup", argumentsDelta: '{"id": 1}' },
      { tag: "Done", meta: doneMeta },
    );

    const result = await collectStream(stream);
    if (result.value.tag === "ToolCalls") {
      expect(result.value.calls).toHaveLength(2);
      expect(result.value.calls[0].function.name).toBe("search");
      expect(result.value.calls[1].function.name).toBe("lookup");
    }
  });

  it("should provide empty meta when no Done chunk is received", async () => {
    const stream = chunks({ tag: "ContentDelta", text: "hello" });
    const result = await collectStream(stream);
    expect(result.meta.responseId).toBe("");
    expect(result.meta.latencyMs).toBe(0);
  });
});
