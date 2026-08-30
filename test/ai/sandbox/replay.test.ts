import { describe, it, expect } from "vitest";
import { ReplayLLMService } from "../../../src/ai/sandbox/replay-llm-service.js";
import { ReplayToolRegistry } from "../../../src/ai/sandbox/replay-tool-registry.js";
import { RecordingExhaustedError } from "../../../src/ai/sandbox/errors.js";
import type { RecordedLLMCall, RecordedToolExec } from "../../../src/ai/sandbox/types.js";

const meta = {
  responseId: "id",
  model: "m",
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  cost: undefined,
  finishReason: "stop",
  latencyMs: 1,
};

const llmCalls: RecordedLLMCall[] = [
  { type: "llmcall", requestId: "1", messages: [], tools: [], responseType: "content", content: "first", toolCalls: null, meta },
  { type: "llmcall", requestId: "2", messages: [], tools: [], responseType: "content", content: "second", toolCalls: null, meta },
];

describe("ReplayLLMService", () => {
  it("serves calls in order", async () => {
    const svc = ReplayLLMService.fromCalls(llmCalls);
    expect(await svc.chat([])).toBe("first");
    expect(await svc.chat([])).toBe("second");
  });

  it("throws RecordingExhaustedError past end", async () => {
    const svc = ReplayLLMService.fromCalls(llmCalls);
    await svc.chat([]);
    await svc.chat([]);
    await expect(svc.chat([])).rejects.toBeInstanceOf(RecordingExhaustedError);
  });

  it("served() reports current cursor", async () => {
    const svc = ReplayLLMService.fromCalls(llmCalls);
    expect(await svc.served()).toBe(0);
    await svc.chat([]);
    expect(await svc.served()).toBe(1);
  });

  it("reconstructs tool_calls response", async () => {
    const tcCall: RecordedLLMCall = {
      type: "llmcall",
      requestId: "x",
      messages: [],
      tools: ["t"],
      responseType: "tool_calls",
      content: null,
      toolCalls: [
        { id: "tc-1", type: "function", function: { name: "t", arguments: "{}" } },
      ],
      meta,
    };
    const svc = ReplayLLMService.fromCalls([tcCall]);
    const r = await svc.chatWithTools([], []);
    expect(r.tag).toBe("ToolCalls");
  });
});

describe("ReplayToolRegistry", () => {
  const execs: RecordedToolExec[] = [
    {
      type: "toolexec",
      toolCallId: "1",
      toolName: "lookup",
      arguments: { ignored: 1 },
      result: { success: true, output: "first" },
      latencyMs: 1,
    },
    {
      type: "toolexec",
      toolCallId: "2",
      toolName: "lookup",
      arguments: {},
      result: { success: false, output: null, error: "boom" },
      latencyMs: 1,
    },
  ];

  it("ignores arguments and returns recorded results in order", async () => {
    const reg = ReplayToolRegistry.fromExecs(execs);
    const a = await reg.execute({ name: "lookup", arguments: { totally: "different" } });
    expect(a.output).toBe("first");
    const b = await reg.execute({ name: "lookup", arguments: {} });
    expect(b.success).toBe(false);
  });

  it("getDefinitions derives from distinct toolNames", () => {
    const execs2: RecordedToolExec[] = [
      ...execs,
      { type: "toolexec", toolCallId: "3", toolName: "summarize", arguments: {}, result: { success: true, output: "" }, latencyMs: 1 },
    ];
    const reg = ReplayToolRegistry.fromExecs(execs2);
    const defs = reg.getDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(["lookup", "summarize"]);
  });

  it("throws RecordingExhaustedError past end", async () => {
    const reg = ReplayToolRegistry.fromExecs(execs);
    await reg.execute({ name: "lookup", arguments: {} });
    await reg.execute({ name: "lookup", arguments: {} });
    await expect(reg.execute({ name: "lookup", arguments: {} })).rejects.toBeInstanceOf(
      RecordingExhaustedError,
    );
  });
});
