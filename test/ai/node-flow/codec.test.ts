import { describe, it, expect } from "vitest";
import { encodeFlowDef, decodeFlowDef } from "../../../src/ai/node-flow/codec.js";
import type { NodeFlowDef } from "../../../src/ai/node-flow/def.js";
import type { NodeDef } from "../../../src/ai/node-flow/nodes.js";

describe("flow def codec", () => {
  it("round-trips a flow with a branch node", () => {
    const branch: NodeDef = {
      kind: "branch",
      predicateAttribute: "status",
      branches: new Map<unknown, string>([
        ["ok", "happy"],
        ["err", "fail"],
      ]),
    };
    const def: NodeFlowDef = {
      id: "f1",
      description: "test",
      nodes: new Map<string, NodeDef>([
        ["b", branch],
        ["happy", { kind: "attribute_op", reads: [], writes: {} }],
      ]),
      edges: [["b", "happy"]],
      tags: new Set(["a", "b"]),
      initialContext: { x: 1 },
      trigger: { kind: "manual" },
    };
    const json = JSON.parse(JSON.stringify(encodeFlowDef(def)));
    const restored = decodeFlowDef(json);
    expect(restored.id).toBe("f1");
    expect([...restored.tags].sort()).toEqual(["a", "b"]);
    const b = restored.nodes.get("b");
    expect(b?.kind).toBe("branch");
    if (b?.kind === "branch") {
      expect(b.branches.get("ok")).toBe("happy");
    }
  });
});
