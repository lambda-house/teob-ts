import type { NodeDef } from "./nodes.js";

export type TriggerConfig =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string }
  | { kind: "webhook"; path: string }
  | { kind: "message"; adapterId: string }
  | { kind: "event"; topic: string };

export interface NodeFlowDef {
  id: string;
  description: string;
  nodes: Map<string, NodeDef>;
  edges: Array<[string, string]>;
  tags: Set<string>;
  initialContext: Record<string, unknown>;
  maxConcurrentNodes?: number;
  trigger: TriggerConfig;
}

export interface CompiledFlow {
  def: NodeFlowDef;
  rootNodes: Set<string>;
  terminalNodes: Set<string>;
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

export class CompileError extends Error {
  readonly tag = "CompileError" as const;
  constructor(public reason: string, public details?: unknown) {
    super(`NodeFlow compile error: ${reason}`);
  }
}

export function compile(def: NodeFlowDef): CompiledFlow {
  const ids = new Set(def.nodes.keys());
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const id of ids) {
    dependencies.set(id, new Set());
    dependents.set(id, new Set());
  }
  for (const [from, to] of def.edges) {
    if (!ids.has(from)) throw new CompileError(`edge from unknown node: ${from}`);
    if (!ids.has(to)) throw new CompileError(`edge to unknown node: ${to}`);
    dependencies.get(to)!.add(from);
    dependents.get(from)!.add(to);
  }
  // Cycle detection via DFS
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);
  function visit(id: string, stack: string[]): void {
    if (color.get(id) === GRAY) {
      throw new CompileError(
        `cycle detected: ${[...stack, id].join(" -> ")}`,
        { cycle: [...stack, id] },
      );
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    for (const next of dependents.get(id)!) visit(next, [...stack, id]);
    color.set(id, BLACK);
  }
  for (const id of ids) if (color.get(id) === WHITE) visit(id, []);

  const rootNodes = new Set<string>();
  const terminalNodes = new Set<string>();
  for (const id of ids) {
    if ((dependencies.get(id) ?? new Set()).size === 0) rootNodes.add(id);
    if ((dependents.get(id) ?? new Set()).size === 0) terminalNodes.add(id);
  }

  if (ids.size > 0 && rootNodes.size === 0) {
    throw new CompileError("no root nodes (every node has dependencies)");
  }

  return { def, rootNodes, terminalNodes, dependencies, dependents };
}
