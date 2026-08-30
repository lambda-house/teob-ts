import { describe, it, expect } from "vitest";
import { newCapability } from "../../../src/ai/capability/types.js";
import { RuleBasedDecider } from "../../../src/ai/capability/decider.js";

const cap = (content: string, overrides: Partial<Parameters<typeof newCapability>[0]> = {}) =>
  newCapability({
    scopeKey: "agent-1",
    layer: "experience",
    content,
    source: { kind: "agent_observation", agentId: "agent-1", roundId: "r1" },
    now: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });

const decider = new RuleBasedDecider();

describe("RuleBasedDecider.decide", () => {
  it("returns add when similar empty", async () => {
    const d = await decider.decide({
      observation: "users prefer dark mode",
      similar: [],
      source: { kind: "agent_observation", agentId: "a", roundId: "r" },
      now: "t",
    });
    expect(d.kind).toBe("add");
  });

  it("strengthens when similarity ≥ 0.5", async () => {
    const existing = cap("DB latency exceeds 200ms triggers saga retries");
    const d = await decider.decide({
      observation: "DB latency exceeds 200ms triggers saga retries",
      similar: [existing],
      source: { kind: "agent_observation", agentId: "a", roundId: "r" },
      now: "2025-01-02T00:00:00.000Z",
    });
    expect(d.kind).toBe("strengthen");
    if (d.kind === "strengthen") {
      expect(d.targetId).toBe(existing.id);
      expect(d.evidence.roundId).toBe("r");
    }
  });

  it("revises when similarity in (0.3, 0.5)", async () => {
    const decider = new RuleBasedDecider({
      strengthenThreshold: 0.99, // make it almost impossible to strengthen
      reviseThreshold: 0.05,
    });
    const existing = cap("DB latency saga retries");
    const d = await decider.decide({
      observation: "DB latency saga retries with circuit breaker",
      similar: [existing],
      source: { kind: "agent_observation", agentId: "a", roundId: "r" },
      now: "t",
    });
    expect(d.kind).toBe("revise");
  });

  it("revise blocked → noop when target is human-authored", async () => {
    const decider = new RuleBasedDecider({
      strengthenThreshold: 0.99,
      reviseThreshold: 0.05,
    });
    const existing = cap("DB latency saga retries", {
      source: { kind: "human_authored", author: "alice" },
    });
    const d = await decider.decide({
      observation: "DB latency saga retries with circuit breaker",
      similar: [existing],
      source: { kind: "agent_observation", agentId: "a", roundId: "r" },
      now: "t",
    });
    expect(d.kind).toBe("noop");
  });

  it("adds when similarity ≤ 0.3", async () => {
    const existing = cap("Total unrelated subject XYZ");
    const d = await decider.decide({
      observation: "DB latency saga retries",
      similar: [existing],
      source: { kind: "agent_observation", agentId: "a", roundId: "r" },
      now: "t",
    });
    expect(d.kind).toBe("add");
  });
});
