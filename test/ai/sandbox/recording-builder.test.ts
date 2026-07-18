import { describe, it, expect } from "vitest";
import { RecordingBuilder, deriveMetrics } from "../../../src/ai/sandbox/recording-builder.js";

const config = { model: "gpt-4.1", provider: "openai", temperature: 0.5, maxTokens: 1024 };

describe("RecordingBuilder", () => {
  it("auto-derives metrics from steps", () => {
    const r = RecordingBuilder.create({
      runId: "r1",
      config,
      startedAt: "2025-01-01T00:00:00.000Z",
    })
      .addLLMCall({
        requestId: "q1",
        messages: [],
        tools: [],
        responseType: "content",
        content: "hello",
        toolCalls: null,
        meta: {
          responseId: "id",
          model: "gpt-4.1",
          usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
          cost: { inputCostUsd: 0.001, outputCostUsd: 0.002, totalCostUsd: 0.003 },
          finishReason: "stop",
          latencyMs: 100,
        },
      })
      .addToolExec({
        toolCallId: "t1",
        toolName: "lookup",
        arguments: { x: 1 },
        result: { success: true, output: { ok: true } },
        latencyMs: 50,
      })
      .build();

    expect(r.metrics.totalLLMCalls).toBe(1);
    expect(r.metrics.totalToolCalls).toBe(1);
    expect(r.metrics.totalTokens).toBe(12);
    expect(r.metrics.totalLatencyMs).toBe(150);
    expect(r.metrics.totalCostUsd).toBeCloseTo(0.003);
  });

  it("explicit metrics override auto-derive", () => {
    const r = RecordingBuilder.create({
      runId: "r2",
      config,
      startedAt: "2025-01-01T00:00:00.000Z",
    })
      .addLLMCall({
        requestId: "q1",
        messages: [],
        tools: [],
        responseType: "content",
        content: "x",
        toolCalls: null,
        meta: {
          responseId: "",
          model: "",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 100 },
          cost: undefined,
          finishReason: undefined,
          latencyMs: 0,
        },
      })
      .withMetrics({ totalLLMCalls: 99, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0 })
      .build();
    expect(r.metrics.totalLLMCalls).toBe(99);
  });

  it("round-trips through JSON", () => {
    const r = RecordingBuilder.create({
      runId: "r3",
      config,
      startedAt: "2025-01-01T00:00:00.000Z",
    })
      .addLLMCall({
        requestId: "q",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        responseType: "content",
        content: "hello",
        toolCalls: null,
        meta: {
          responseId: "id",
          model: "gpt",
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          cost: undefined,
          finishReason: "stop",
          latencyMs: 1,
        },
      })
      .build();
    const restored = JSON.parse(JSON.stringify(r));
    expect(restored.runId).toBe("r3");
    expect(restored.steps[0].type).toBe("llmcall");
  });

  it("interleaves chronologically when timestamps provided", () => {
    const r = RecordingBuilder.create({
      runId: "r4",
      config,
      startedAt: "2025-01-01T00:00:00.000Z",
    })
      .addToolExec({
        toolCallId: "b",
        toolName: "later",
        arguments: {},
        result: { success: true, output: null },
        latencyMs: 1,
        completedAt: "2025-01-01T00:00:02.000Z",
      })
      .addToolExec({
        toolCallId: "a",
        toolName: "first",
        arguments: {},
        result: { success: true, output: null },
        latencyMs: 1,
        completedAt: "2025-01-01T00:00:01.000Z",
      })
      .build();
    const names = r.steps.map((s) => (s.type === "toolexec" ? s.toolName : ""));
    expect(names).toEqual(["first", "later"]);
  });

  it("deriveMetrics directly", () => {
    const m = deriveMetrics([]);
    expect(m).toEqual({ totalLLMCalls: 0, totalToolCalls: 0, totalTokens: 0, totalLatencyMs: 0, totalCostUsd: undefined });
  });
});
