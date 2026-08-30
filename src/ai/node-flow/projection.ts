import type { NodeFlowEvent } from "./aggregate.js";

export interface LLMUsageView {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  totalToolCalls: number;
  totalGuardrailBlocks: number;
  totalGuardrailWarns: number;
  totalFeedback: number;
  feedbackSum: number;
  tokensByModel: Map<string, number>;
  callsByModel: Map<string, number>;
}

export const LLMUsageEmpty = (): LLMUsageView => ({
  totalCalls: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  totalLatencyMs: 0,
  totalToolCalls: 0,
  totalGuardrailBlocks: 0,
  totalGuardrailWarns: 0,
  totalFeedback: 0,
  feedbackSum: 0,
  tokensByModel: new Map(),
  callsByModel: new Map(),
});

interface NodeOutputUsage {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  toolCalls?: number;
}

function extractUsage(output: unknown): NodeOutputUsage | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  const usage = (o.usage as Record<string, unknown> | undefined) ?? o;
  const model = (usage.model as string | undefined) ?? (o.model as string | undefined);
  const promptTokens = numOrUndef(usage.promptTokens);
  const completionTokens = numOrUndef(usage.completionTokens);
  const totalTokens = numOrUndef(usage.totalTokens);
  const latencyMs = numOrUndef(usage.latencyMs);
  const toolCalls = numOrUndef(usage.toolCalls);
  if (
    model === undefined &&
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    latencyMs === undefined &&
    toolCalls === undefined
  ) {
    return undefined;
  }
  return { model, promptTokens, completionTokens, totalTokens, latencyMs, toolCalls };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Pure read-side projection: fold a sequence of NodeFlowEvents into an
 * LLMUsageView. Looks for `usage` payloads inside `node_succeeded` outputs.
 */
export function projectLLMUsage(events: Iterable<NodeFlowEvent>, initial?: LLMUsageView): LLMUsageView {
  const v: LLMUsageView = initial ?? LLMUsageEmpty();
  for (const ev of events) {
    if (ev.tag !== "node_succeeded") continue;
    const u = extractUsage(ev.output);
    if (!u) continue;
    v.totalCalls += 1;
    if (u.model) {
      v.callsByModel.set(u.model, (v.callsByModel.get(u.model) ?? 0) + 1);
      if (u.totalTokens !== undefined) {
        v.tokensByModel.set(u.model, (v.tokensByModel.get(u.model) ?? 0) + u.totalTokens);
      }
    }
    if (u.promptTokens !== undefined) v.totalPromptTokens += u.promptTokens;
    if (u.completionTokens !== undefined) v.totalCompletionTokens += u.completionTokens;
    if (u.totalTokens !== undefined) v.totalTokens += u.totalTokens;
    if (u.latencyMs !== undefined) v.totalLatencyMs += u.latencyMs;
    if (u.toolCalls !== undefined) v.totalToolCalls += u.toolCalls;
  }
  return v;
}
