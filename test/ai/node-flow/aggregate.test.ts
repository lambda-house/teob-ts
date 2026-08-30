import { describe, it, expect } from "vitest";
import { tagCodec } from "../../../src/core/codec.js";
import { EntityId } from "../../../src/core/types.js";
import { categoryTypes } from "../../../src/core/effect-control.js";
import { createSingleRuntime } from "../../../src/inmem/runtime.js";
import {
  createNodeFlowAggregate,
  type NodeFlowCommand,
  type NodeFlowEvent,
  type NodeFlowReply,
  type NodeFlowState,
} from "../../../src/ai/node-flow/aggregate.js";
import type { NodeFlowDef } from "../../../src/ai/node-flow/def.js";
import type { NodeDef } from "../../../src/ai/node-flow/nodes.js";

function flow(): NodeFlowDef {
  const nodes = new Map<string, NodeDef>([
    ["seed", { kind: "attribute_op", reads: [], writes: { greeting: "greeting" } }],
    [
      "compose",
      { kind: "attribute_op", reads: ["greeting"], writes: { message: "greeting" } },
    ],
  ]);
  return {
    id: "hello-flow",
    description: "tiny flow",
    nodes,
    edges: [["seed", "compose"]],
    tags: new Set(),
    initialContext: { greeting: "hello" },
    trigger: { kind: "manual" },
  };
}

const cat = categoryTypes<NodeFlowCommand, NodeFlowReply>(
  // Aggregate uses CategoryId("node-flow") by default; mirror that here.
  "node-flow" as unknown as ReturnType<typeof categoryTypes>["categoryId"],
);

async function waitForCompletion(
  runtime: ReturnType<typeof createSingleRuntime<NodeFlowCommand, NodeFlowReply, NodeFlowEvent, NodeFlowState>>["runtime"],
  id: EntityId,
  timeoutMs = 2000,
): Promise<NodeFlowState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await runtime.ask(id, { tag: "get_state" }, cat);
    if (r.ok && r.value.reply?.tag === "state_snapshot") {
      const s = r.value.reply.state;
      if (s.status === "completed" || s.status === "failed") return s;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("timeout waiting for flow completion");
}

describe("NodeFlowAggregate — happy path", () => {
  it("runs a 2-node DAG and reports completion", async () => {
    const aggregate = createNodeFlowAggregate();
    const { runtime } = createSingleRuntime(
      aggregate,
      tagCodec<NodeFlowEvent>(
        "flow_started",
        "node_started",
        "node_succeeded",
        "node_failed",
        "flow_completed",
        "flow_failed",
        "waiting_for_input",
        "child_flow_started",
        "child_flow_done",
        "message_received",
        "message_sent",
      ),
      tagCodec<NodeFlowState>("State") as unknown as ReturnType<typeof tagCodec<NodeFlowState>>,
    );
    const id = "f1" as EntityId;
    const start = await runtime.ask(id, { tag: "start_flow", flowDef: flow() }, cat);
    expect(start.ok).toBe(true);
    const final = await waitForCompletion(runtime, id);
    expect(final.status).toBe("completed");
    expect(final.nodeStatuses.get("seed")).toBe("completed");
    expect(final.nodeStatuses.get("compose")).toBe("completed");
    expect(final.context.message).toBe("hello");
    await runtime.shutdown();
  });
});
