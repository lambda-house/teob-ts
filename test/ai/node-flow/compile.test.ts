import { describe, it, expect } from "vitest";
import { compile, CompileError } from "../../../src/ai/node-flow/def.js";
import type { NodeFlowDef } from "../../../src/ai/node-flow/def.js";

const trivial = (id: string): NodeFlowDef["nodes"] extends Map<string, infer T> ? T : never => ({
  kind: "attribute_op",
  reads: [],
  writes: {},
});

function flow(nodes: string[], edges: Array<[string, string]>): NodeFlowDef {
  return {
    id: "f",
    description: "",
    nodes: new Map(nodes.map((n) => [n, trivial(n)])),
    edges,
    tags: new Set(),
    initialContext: {},
    trigger: { kind: "manual" },
  };
}

describe("compile", () => {
  it("identifies roots and terminals", () => {
    const c = compile(flow(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
    expect([...c.rootNodes]).toEqual(["a"]);
    expect([...c.terminalNodes]).toEqual(["c"]);
  });

  it("rejects edges to unknown nodes", () => {
    expect(() => compile(flow(["a"], [["a", "ghost"]]))).toThrow(CompileError);
  });

  it("rejects cycles", () => {
    expect(() =>
      compile(flow(["a", "b"], [["a", "b"], ["b", "a"]])),
    ).toThrow(CompileError);
  });

  it("orphans are roots and terminals", () => {
    const c = compile(flow(["a", "b"], []));
    expect(c.rootNodes.size).toBe(2);
    expect(c.terminalNodes.size).toBe(2);
  });
});
