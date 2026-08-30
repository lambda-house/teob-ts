import type { LLMStreamChunk, LLMResponseMeta, LLMResult, LLMToolCall, LLMToolResponse } from "./types.js";

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

interface AccState {
  content: string;
  toolCalls: Map<number, ToolCallAcc>;
  meta: LLMResponseMeta | undefined;
}

/**
 * Collects an async iterable of LLMStreamChunks into a complete LLMResult.
 *
 * Content deltas are concatenated. Tool call deltas are accumulated by index
 * into complete LLMToolCalls.
 */
export async function collectStream(
  stream: AsyncIterable<LLMStreamChunk>,
): Promise<LLMResult<LLMToolResponse>> {
  const state: AccState = { content: "", toolCalls: new Map(), meta: undefined };

  for await (const chunk of stream) {
    switch (chunk.tag) {
      case "ContentDelta":
        state.content += chunk.text;
        break;
      case "ToolCallDelta": {
        const existing = state.toolCalls.get(chunk.index) ?? { id: "", name: "", args: "" };
        state.toolCalls.set(chunk.index, {
          id: chunk.id ?? existing.id,
          name: chunk.name ?? existing.name,
          args: existing.args + chunk.argumentsDelta,
        });
        break;
      }
      case "Done":
        state.meta = chunk.meta;
        break;
    }
  }

  const meta = state.meta ?? {
    responseId: "",
    model: "",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cost: undefined,
    finishReason: undefined,
    latencyMs: 0,
  };

  if (state.toolCalls.size > 0) {
    const calls: LLMToolCall[] = [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({
        id: acc.id,
        type: "function" as const,
        function: { name: acc.name, arguments: acc.args },
      }));

    const rawMessage = {
      role: "assistant",
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    };

    return { value: { tag: "ToolCalls", calls, rawMessage }, meta };
  }

  return { value: { tag: "Content", text: state.content }, meta };
}
