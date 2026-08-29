import type { Aggregate } from "../../core/aggregate.js";
import { CategoryId } from "../../core/types.js";
import { persist, reply, run, andRun, andReply, done } from "../../core/effect.js";
import type { Effect } from "../../core/effect.js";
import type { EffectControl } from "../../core/effect-control.js";
import type { NodeFlowDef, CompiledFlow } from "./def.js";
import { compile } from "./def.js";
import type { NodeDef } from "./nodes.js";
import { executeNode, type ExecutorContext } from "./executor.js";
import { applyMapping } from "./context.js";
import { isSignal, type NodeExecutionSignal } from "./signals.js";

export type NodeStatus = "pending" | "running" | "completed" | "failed";
export type NodeFlowStatus =
  | "not_started"
  | "running"
  | "completed"
  | "failed"
  | "waiting_for_input";

export interface NodeFlowState {
  flowDefId?: string;
  status: NodeFlowStatus;
  nodeStatuses: Map<string, NodeStatus>;
  nodeOutputs: Map<string, unknown>;
  context: Record<string, unknown>;
  activeNodeCount: number;
  waitingNodes: Set<string>;
  /** runtime-only — recompiled lazily on demand. */
  _compiled?: CompiledFlow;
}

export type NodeFlowCommand =
  | { tag: "start_flow"; flowDef: NodeFlowDef; initialContext?: Record<string, unknown> }
  | { tag: "node_completed"; nodeId: string; result: unknown }
  | { tag: "node_failed"; nodeId: string; error: string }
  | { tag: "child_flow_completed"; childFlowId: string; result: unknown }
  | { tag: "user_message"; nodeId: string; message: unknown }
  | { tag: "user_choice_response"; nodeId: string; choice: number }
  | { tag: "get_state" };

export type NodeFlowEvent =
  | { tag: "flow_started"; flowDefId: string; context: Record<string, unknown> }
  | { tag: "node_started"; nodeId: string }
  | { tag: "node_succeeded"; nodeId: string; output: unknown }
  | { tag: "node_failed"; nodeId: string; error: string }
  | { tag: "flow_completed"; finalContext: Record<string, unknown> }
  | { tag: "flow_failed"; reason: string }
  | { tag: "waiting_for_input"; nodeId: string }
  | {
      tag: "child_flow_started";
      childFlowId: string;
      parentNodeId: string;
      itemIndex?: number;
    }
  | { tag: "child_flow_done"; childFlowId: string; output: unknown }
  | { tag: "message_received"; nodeId: string; message: unknown }
  | { tag: "message_sent"; nodeId: string };

export type NodeFlowReply =
  | { tag: "acknowledged"; flowId: string }
  | { tag: "state_snapshot"; state: NodeFlowState }
  | { tag: "error"; message: string };

export interface NodeFlowAggregateOpts {
  category?: string;
  registry?: Map<string, NodeFlowDef>;
  executor?: (def: NodeDef, exec: ExecutorContext) => Promise<NodeExecutionSignal>;
  buildExecCtx?: (state: NodeFlowState) => ExecutorContext;
}

export function createNodeFlowAggregate(
  opts: NodeFlowAggregateOpts = {},
): Aggregate<NodeFlowCommand, NodeFlowReply, NodeFlowEvent, NodeFlowState> {
  const category = CategoryId(opts.category ?? "node-flow");
  const registry = opts.registry ?? new Map<string, NodeFlowDef>();
  const exec = opts.executor ?? executeNode;
  const buildCtx =
    opts.buildExecCtx ??
    ((state: NodeFlowState): ExecutorContext => ({ flowState: state.context }));

  function getCompiled(state: NodeFlowState): CompiledFlow | undefined {
    if (state._compiled) return state._compiled;
    if (!state.flowDefId) return undefined;
    const def = registry.get(state.flowDefId);
    if (!def) return undefined;
    const c = compile(def);
    state._compiled = c;
    return c;
  }

  function nodesReadyToRun(state: NodeFlowState, compiled: CompiledFlow): string[] {
    const ready: string[] = [];
    for (const [id, deps] of compiled.dependencies) {
      const status = state.nodeStatuses.get(id) ?? "pending";
      if (status !== "pending") continue;
      let ok = true;
      for (const dep of deps) {
        if (state.nodeStatuses.get(dep) !== "completed") {
          ok = false;
          break;
        }
      }
      if (ok) ready.push(id);
    }
    return ready;
  }

  function fireNode(
    nodeId: string,
    state: NodeFlowState,
    compiled: CompiledFlow,
    ctx: EffectControl<NodeFlowCommand, NodeFlowReply>,
  ): Array<NodeFlowEvent | (() => Promise<void>)> {
    const def = compiled.def.nodes.get(nodeId);
    if (!def) {
      return [{ tag: "node_failed", nodeId, error: "node not found" }];
    }
    const events: NodeFlowEvent[] = [{ tag: "node_started", nodeId }];
    const sideEffect = async (): Promise<void> => {
      try {
        const signal = await exec(def, buildCtx(state));
        if (signal.__signal === "completed") {
          await ctx.tellSelf({ tag: "node_completed", nodeId, result: signal.output });
        } else if (signal.__signal === "blocking") {
          // The aggregate transitions via the started event already; the user
          // is responsible for sending a `user_message` / `user_choice_response`.
          // No-op here.
        } else {
          // Other signals not yet supported in the v1 aggregate — treat as completion
          // of the underlying node.
          await ctx.tellSelf({ tag: "node_completed", nodeId, result: signal });
        }
      } catch (err) {
        await ctx.tellSelf({ tag: "node_failed", nodeId, error: String(err) });
      }
    };
    return [...events, sideEffect];
  }

  return {
    category,
    initial: () => ({
      status: "not_started",
      nodeStatuses: new Map(),
      nodeOutputs: new Map(),
      context: {},
      activeNodeCount: 0,
      waitingNodes: new Set(),
    }),

    async decide(state, command, ctx) {
      switch (command.tag) {
        case "start_flow": {
          if (state.status !== "not_started" && state.status !== "completed" && state.status !== "failed") {
            return reply<NodeFlowEvent, NodeFlowReply>({
              tag: "error",
              message: "flow already running",
            });
          }
          const compiled = compile(command.flowDef);
          registry.set(command.flowDef.id, command.flowDef);
          const initialContext = {
            ...command.flowDef.initialContext,
            ...(command.initialContext ?? {}),
          };
          const startEv: NodeFlowEvent = {
            tag: "flow_started",
            flowDefId: command.flowDef.id,
            context: initialContext,
          };
          // Synthesize the post-flow_started state so we can fire roots in a
          // single decide() pass without waiting for a self-tell round trip.
          const projected: NodeFlowState = {
            ...state,
            flowDefId: command.flowDef.id,
            status: "running",
            nodeStatuses: new Map([...compiled.def.nodes.keys()].map((id) => [id, "pending"])),
            nodeOutputs: new Map(),
            context: initialContext,
            activeNodeCount: 0,
            waitingNodes: new Set(),
            _compiled: compiled,
          };
          const startEvents: NodeFlowEvent[] = [startEv];
          const sideEffects: Array<() => Promise<void>> = [];
          for (const root of compiled.rootNodes) {
            const fired = fireNode(root, projected, compiled, ctx);
            for (const item of fired) {
              if (typeof item === "function") sideEffects.push(item);
              else startEvents.push(item);
            }
          }
          let eff: Effect<NodeFlowEvent, NodeFlowReply> = persist(...startEvents);
          for (const se of sideEffects) eff = andRun(eff, se);
          return andReply(eff, { tag: "acknowledged", flowId: command.flowDef.id });
        }

        case "node_completed": {
          const compiled = getCompiled(state);
          if (!compiled) return reply({ tag: "error", message: "no flow running" });
          const events: NodeFlowEvent[] = [
            { tag: "node_succeeded", nodeId: command.nodeId, output: command.result },
          ];
          // Project state forward so dependents can fire in this same step.
          const projected = applyEvents(state, events);
          // Determine nextReady from the projected state.
          const nextReady = nodesReadyToRun(projected, compiled);
          const sideEffects: Array<() => Promise<void>> = [];
          for (const id of nextReady) {
            const fired = fireNode(id, projected, compiled, ctx);
            for (const item of fired) {
              if (typeof item === "function") sideEffects.push(item);
              else events.push(item);
            }
          }
          // Update projected after firing started events
          const projected2 = applyEvents(state, events);
          // Check if all terminals are completed → flow_completed
          let allTerminalsDone = true;
          for (const t of compiled.terminalNodes) {
            if (projected2.nodeStatuses.get(t) !== "completed") {
              allTerminalsDone = false;
              break;
            }
          }
          if (allTerminalsDone && compiled.terminalNodes.size > 0) {
            events.push({ tag: "flow_completed", finalContext: projected2.context });
          }
          let eff: Effect<NodeFlowEvent, NodeFlowReply> = persist(...events);
          for (const se of sideEffects) eff = andRun(eff, se);
          return eff;
        }

        case "node_failed": {
          const compiled = getCompiled(state);
          if (!compiled) return reply({ tag: "error", message: "no flow running" });
          // Apply the node's errorPolicy.
          const def = compiled.def.nodes.get(command.nodeId);
          const policy = (def && (def as { errorPolicy?: { kind: string } }).errorPolicy?.kind) ?? "fail_flow";
          if (policy === "skip") {
            // Treat as success with empty output.
            return persist<NodeFlowEvent, NodeFlowReply>({
              tag: "node_succeeded",
              nodeId: command.nodeId,
              output: null,
            });
          }
          // fail_flow / retry / compensate: emit failure + flow_failed for now.
          const events: NodeFlowEvent[] = [
            { tag: "node_failed", nodeId: command.nodeId, error: command.error },
            { tag: "flow_failed", reason: `node ${command.nodeId} failed: ${command.error}` },
          ];
          return persist(...events);
        }

        case "user_message": {
          return persist<NodeFlowEvent, NodeFlowReply>(
            { tag: "message_received", nodeId: command.nodeId, message: command.message },
            { tag: "node_succeeded", nodeId: command.nodeId, output: command.message },
          );
        }

        case "user_choice_response": {
          return persist<NodeFlowEvent, NodeFlowReply>({
            tag: "node_succeeded",
            nodeId: command.nodeId,
            output: { choice: command.choice },
          });
        }

        case "child_flow_completed": {
          return persist<NodeFlowEvent, NodeFlowReply>({
            tag: "child_flow_done",
            childFlowId: command.childFlowId,
            output: command.result,
          });
        }

        case "get_state":
          return reply<NodeFlowEvent, NodeFlowReply>({
            tag: "state_snapshot",
            state,
          });
      }
    },

    apply(state, event) {
      return applyEvent(state, event);
    },
  };
}

// --- pure event application ----------------------------------------------

function applyEvents(state: NodeFlowState, events: NodeFlowEvent[]): NodeFlowState {
  let s = state;
  for (const e of events) s = applyEvent(s, e);
  return s;
}

function applyEvent(state: NodeFlowState, event: NodeFlowEvent): NodeFlowState {
  switch (event.tag) {
    case "flow_started": {
      return {
        ...state,
        flowDefId: event.flowDefId,
        status: "running",
        nodeStatuses: new Map(state.nodeStatuses),
        nodeOutputs: new Map(),
        context: { ...event.context },
        activeNodeCount: 0,
        waitingNodes: new Set(),
        _compiled: state._compiled,
      };
    }
    case "node_started": {
      const m = new Map(state.nodeStatuses);
      m.set(event.nodeId, "running");
      return { ...state, nodeStatuses: m, activeNodeCount: state.activeNodeCount + 1 };
    }
    case "node_succeeded": {
      const m = new Map(state.nodeStatuses);
      m.set(event.nodeId, "completed");
      const outs = new Map(state.nodeOutputs);
      outs.set(event.nodeId, event.output);
      // Merge node output into context if it's an object.
      let context = state.context;
      if (event.output && typeof event.output === "object" && !Array.isArray(event.output)) {
        context = { ...state.context, ...(event.output as Record<string, unknown>) };
      }
      return {
        ...state,
        nodeStatuses: m,
        nodeOutputs: outs,
        context,
        activeNodeCount: Math.max(0, state.activeNodeCount - 1),
      };
    }
    case "node_failed": {
      const m = new Map(state.nodeStatuses);
      m.set(event.nodeId, "failed");
      return { ...state, nodeStatuses: m, activeNodeCount: Math.max(0, state.activeNodeCount - 1) };
    }
    case "flow_completed":
      return { ...state, status: "completed", context: { ...event.finalContext } };
    case "flow_failed":
      return { ...state, status: "failed" };
    case "waiting_for_input": {
      const w = new Set(state.waitingNodes);
      w.add(event.nodeId);
      return { ...state, status: "waiting_for_input", waitingNodes: w };
    }
    case "message_received": {
      const w = new Set(state.waitingNodes);
      w.delete(event.nodeId);
      return { ...state, waitingNodes: w };
    }
    case "message_sent":
      return state;
    case "child_flow_started":
      return state;
    case "child_flow_done":
      return state;
  }
}
