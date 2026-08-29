import type { NodeFlowDef, TriggerConfig } from "./def.js";
import type { NodeDef } from "./nodes.js";

/**
 * JSON-encoded shape of a NodeFlowDef. Keeps wire compatibility with Scala
 * counterparts: no Maps, no Sets — everything is plain objects/arrays.
 */
export interface NodeFlowDefJson {
  id: string;
  description: string;
  nodes: Array<{ id: string; def: NodeDefJson }>;
  edges: Array<[string, string]>;
  tags: string[];
  initialContext: Record<string, unknown>;
  maxConcurrentNodes?: number;
  trigger: TriggerConfig;
}

export type NodeDefJson =
  | Exclude<NodeDef, { kind: "branch" }>
  | {
      kind: "branch";
      predicateAttribute: string;
      branches: Array<[unknown, string]>;
    };

export function encodeFlowDef(def: NodeFlowDef): NodeFlowDefJson {
  return {
    id: def.id,
    description: def.description,
    nodes: [...def.nodes.entries()].map(([id, node]) => ({ id, def: encodeNode(node) })),
    edges: def.edges,
    tags: [...def.tags],
    initialContext: def.initialContext,
    maxConcurrentNodes: def.maxConcurrentNodes,
    trigger: def.trigger,
  };
}

export function decodeFlowDef(json: NodeFlowDefJson): NodeFlowDef {
  const nodes = new Map<string, NodeDef>();
  for (const { id, def } of json.nodes) nodes.set(id, decodeNode(def));
  return {
    id: json.id,
    description: json.description,
    nodes,
    edges: json.edges,
    tags: new Set(json.tags),
    initialContext: json.initialContext,
    maxConcurrentNodes: json.maxConcurrentNodes,
    trigger: json.trigger,
  };
}

function encodeNode(node: NodeDef): NodeDefJson {
  if (node.kind === "branch") {
    return {
      kind: "branch",
      predicateAttribute: node.predicateAttribute,
      branches: [...node.branches.entries()],
    };
  }
  return node;
}

function decodeNode(node: NodeDefJson): NodeDef {
  if (node.kind === "branch") {
    return {
      kind: "branch",
      predicateAttribute: node.predicateAttribute,
      branches: new Map(node.branches),
    };
  }
  return node;
}
