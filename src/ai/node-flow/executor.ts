import type { LLMService } from "../llm/llm-service.js";
import type { ChatMessage } from "../llm/types.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type { NodeDef } from "./nodes.js";
import type { NodeExecutionSignal } from "./signals.js";
import { renderTemplate, applyMapping, applyInputMapping } from "./context.js";
import { evaluate as evaluateGuard, readPath, type Guard } from "./guard.js";

export interface ExecutorContext {
  flowState: Record<string, unknown>;
  llm?: LLMService;
  tools?: MCPToolRegistry;
  fetchImpl?: typeof fetch;
  /** Adapters keyed by id, for send/receive_message nodes. */
  messageAdapters?: Map<string, MessageAdapter>;
  /** Knowledge backend for knowledge_lookup nodes. */
  knowledge?: KnowledgeApi;
  /** Returns ISO timestamp; injectable for tests. */
  now?: () => string;
}

export interface MessageAdapter {
  send(content: string, meta?: unknown): Promise<unknown>;
}

export interface KnowledgeApi {
  search(query: string, opts: { sources: string[]; topK: number }): Promise<unknown[]>;
}

export class UnsupportedNodeKind extends Error {
  constructor(public kind: string) {
    super(`Node kind not implemented in executor: ${kind}`);
  }
}

/**
 * Execute a single node and return either a `completed` signal or a
 * blocking signal indicating the flow must wait for an external trigger.
 */
export async function executeNode(
  def: NodeDef,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  switch (def.kind) {
    case "attribute_op":
      return executeAttributeOp(def, exec);
    case "branch":
      return executeBranch(def, exec);
    case "delay":
      return executeDelay(def);
    case "mcp_tool_exec":
      return executeMcpTool(def, exec);
    case "knowledge_lookup":
      return executeKnowledge(def, exec);
    case "send_message":
      return executeSendMessage(def, exec);
    case "receive_message":
      return executeReceiveMessage();
    case "user_choice":
      return executeUserChoice();
    case "human_approval":
      return executeHumanApproval();
    case "http_call":
      return executeHttp(def, exec);
    case "llm_call":
      return executeLlmCall(def, exec);
    case "llm_extract":
      return executeLlmExtract(def, exec);
    case "merge":
      return executeMerge(def, exec);
    case "wait_until":
      return executeWaitUntil(def);
    case "verify":
      return executeVerify(def, exec);
    case "plan":
      return executePlan(def, exec);
    case "sub_flow_start":
    case "sub_flow_join":
    case "poll_until":
      // These signal up-aggregate handling; the executor returns a "blocking"
      // marker. The aggregate is responsible for orchestrating them.
      return { __signal: "blocking" };
  }
}

function executeAttributeOp(
  def: Extract<NodeDef, { kind: "attribute_op" }>,
  exec: ExecutorContext,
): NodeExecutionSignal {
  // `writes` is `{ targetKey: jsonPath-or-template }`. Reads are advisory.
  const out = applyInputMapping(def.writes, exec.flowState);
  return { __signal: "completed", output: out };
}

function executeBranch(
  def: Extract<NodeDef, { kind: "branch" }>,
  exec: ExecutorContext,
): NodeExecutionSignal {
  // Read predicateAttribute from state; the chosen branch id is in output.
  const value =
    typeof def.predicateAttribute === "string"
      ? readContextValue(def.predicateAttribute, exec.flowState)
      : undefined;
  for (const [k, target] of def.branches) {
    if (k === value) {
      return { __signal: "completed", output: { branch: target } };
    }
  }
  // Default: pick the first branch as a deterministic fallback.
  const first = [...def.branches.values()][0];
  return { __signal: "completed", output: { branch: first ?? null } };
}

async function executeDelay(def: Extract<NodeDef, { kind: "delay" }>): Promise<NodeExecutionSignal> {
  await new Promise((res) => setTimeout(res, def.durationMs));
  return { __signal: "completed", output: { delayedMs: def.durationMs } };
}

async function executeMcpTool(
  def: Extract<NodeDef, { kind: "mcp_tool_exec" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.tools) {
    return { __signal: "completed", output: { error: "no MCPToolRegistry available" } };
  }
  const args = applyInputMapping(def.inputMapping, exec.flowState);
  const result = await exec.tools.execute({ name: def.toolName, arguments: args });
  if (!result.success) {
    return { __signal: "completed", output: { error: result.error ?? "tool failed" } };
  }
  const mapped = applyMapping(def.outputMapping, result.output);
  return { __signal: "completed", output: mapped };
}

async function executeKnowledge(
  def: Extract<NodeDef, { kind: "knowledge_lookup" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.knowledge) {
    return { __signal: "completed", output: { [def.resultAttribute]: [] } };
  }
  const query = renderTemplate(def.queryTemplate, exec.flowState);
  const results = await exec.knowledge.search(query, { sources: def.sources, topK: def.topK });
  return { __signal: "completed", output: { [def.resultAttribute]: results } };
}

async function executeSendMessage(
  def: Extract<NodeDef, { kind: "send_message" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  const content = renderTemplate(def.contentTemplate, exec.flowState);
  const adapter = exec.messageAdapters?.get(def.adapterId);
  if (!adapter) {
    return { __signal: "completed", output: { sent: false, reason: "adapter_not_found" } };
  }
  const r = await adapter.send(content, { templateId: def.templateId });
  return { __signal: "completed", output: { sent: true, adapter: def.adapterId, response: r } };
}

function executeReceiveMessage(): NodeExecutionSignal {
  return { __signal: "blocking" };
}

function executeUserChoice(): NodeExecutionSignal {
  return { __signal: "blocking" };
}

function executeHumanApproval(): NodeExecutionSignal {
  return { __signal: "blocking" };
}

async function executeHttp(
  def: Extract<NodeDef, { kind: "http_call" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  const fetchImpl = exec.fetchImpl ?? globalThis.fetch;
  const url = renderTemplate(def.urlTemplate, exec.flowState);
  const init: RequestInit = { method: def.method };
  if (def.headers) init.headers = def.headers;
  if (def.bodyTemplate) init.body = renderTemplate(def.bodyTemplate, exec.flowState);
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    return { __signal: "completed", output: { error: `network_error: ${String(err)}` } };
  }
  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    return {
      __signal: "completed",
      output: { error: `http_${res.status}`, body, status: res.status },
    };
  }
  const mapped = applyMapping(def.responseMapping, body);
  return { __signal: "completed", output: mapped };
}

async function executeLlmCall(
  def: Extract<NodeDef, { kind: "llm_call" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.llm) {
    return { __signal: "completed", output: { error: "no LLMService available" } };
  }
  const userPrompt = renderTemplate(def.userPromptTemplate, exec.flowState);
  const messages: ChatMessage[] = [];
  if (def.systemPromptTemplate) {
    messages.push({ role: "system", content: renderTemplate(def.systemPromptTemplate, exec.flowState) });
  }
  messages.push({ role: "user", content: userPrompt });
  const text = await exec.llm.chat(messages, !!def.responseSchema);
  let body: unknown = text;
  if (def.responseSchema) {
    try {
      body = JSON.parse(text);
    } catch {
      // leave as raw string; mapping may target the raw value.
    }
  }
  const mapped = applyMapping(def.responseMapping, body);
  return { __signal: "completed", output: { ...mapped, rawText: text } };
}

async function executeLlmExtract(
  def: Extract<NodeDef, { kind: "llm_extract" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.llm) {
    return { __signal: "completed", output: { error: "no LLMService available" } };
  }
  const userPrompt = renderTemplate(def.promptTemplate, exec.flowState);
  const text = await exec.llm.chat([{ role: "user", content: userPrompt }], true);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // raw string fallback
  }
  const mapped = applyMapping(def.responseMapping, parsed);
  return { __signal: "completed", output: mapped };
}

async function executeMerge(
  def: Extract<NodeDef, { kind: "merge" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  switch (def.strategy) {
    case "concatenate": {
      const inputs = applyInputMapping(def.responseMapping, exec.flowState);
      const concatenated = Object.values(inputs)
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join("\n\n");
      return { __signal: "completed", output: { merged: concatenated } };
    }
    case "select_best":
      return { __signal: "completed", output: applyInputMapping(def.responseMapping, exec.flowState) };
    case "llm_synthesize": {
      if (!exec.llm || !def.promptTemplate) {
        return {
          __signal: "completed",
          output: { error: "llm_synthesize requires LLMService and promptTemplate" },
        };
      }
      const prompt = renderTemplate(def.promptTemplate, exec.flowState);
      const r = await exec.llm.chat([{ role: "user", content: prompt }]);
      return { __signal: "completed", output: { merged: r } };
    }
  }
}

async function executeWaitUntil(
  def: Extract<NodeDef, { kind: "wait_until" }>,
): Promise<NodeExecutionSignal> {
  if (def.durationMs && def.durationMs > 0) {
    await new Promise((res) => setTimeout(res, def.durationMs));
    return { __signal: "completed", output: { waitedMs: def.durationMs } };
  }
  // Cron-driven wait is the aggregate's job; signal blocking.
  return { __signal: "blocking" };
}

async function executeVerify(
  def: Extract<NodeDef, { kind: "verify" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.llm) {
    return { __signal: "completed", output: { error: "no LLMService available", verified: false } };
  }
  const prompt = renderTemplate(def.promptTemplate, exec.flowState);
  const r = await exec.llm.chat([{ role: "user", content: prompt }], true);
  let parsed: unknown = r;
  try {
    parsed = JSON.parse(r);
  } catch {
    // raw fallback
  }
  const mapped = applyMapping(def.responseMapping, parsed);
  return { __signal: "completed", output: { ...mapped, raw: r } };
}

async function executePlan(
  def: Extract<NodeDef, { kind: "plan" }>,
  exec: ExecutorContext,
): Promise<NodeExecutionSignal> {
  if (!exec.llm) {
    return { __signal: "completed", output: { error: "no LLMService available" } };
  }
  const goal = renderTemplate(def.goalTemplate, exec.flowState);
  const planner = renderTemplate(def.plannerPromptTemplate, exec.flowState);
  const r = await exec.llm.chat(
    [
      { role: "system", content: planner },
      { role: "user", content: `Goal: ${goal}\nAvailable node types: ${def.availableNodeTypes.join(", ")}\nMaxSteps: ${def.maxSteps}` },
    ],
    true,
  );
  let parsed: unknown = r;
  try {
    parsed = JSON.parse(r);
  } catch {
    // raw
  }
  const mapped = applyMapping(def.responseMapping, parsed);
  return { __signal: "completed", output: { ...mapped, plan: parsed } };
}

function readContextValue(path: string, ctx: unknown): unknown {
  return readPath(path, ctx);
}
