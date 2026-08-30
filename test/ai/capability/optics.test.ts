import { describe, it, expect } from "vitest";
import { newCapability } from "../../../src/ai/capability/types.js";
import { CapabilityOptics, autoPromote } from "../../../src/ai/capability/optics.js";
import { CapabilityImmutableError } from "../../../src/ai/capability/errors.js";

const makeCap = (overrides: Partial<Parameters<typeof newCapability>[0]> = {}) =>
  newCapability({
    scopeKey: "agent-1",
    layer: "experience",
    content: "When DB latency exceeds 200ms the saga retries",
    source: { kind: "agent_observation", agentId: "agent-1", roundId: "r1" },
    now: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });

describe("CapabilityOptics.strengthen", () => {
  it("appends evidence and touches updatedAt", () => {
    const cap = makeCap();
    const result = CapabilityOptics.strengthen(
      { roundId: "r2", summary: "second observation", timestamp: "2025-01-02T00:00:00.000Z" },
      "2025-01-02T00:00:00.000Z",
    )(cap);
    expect(result.evidence).toHaveLength(1);
    expect(result.updatedAt).toBe("2025-01-02T00:00:00.000Z");
  });

  it("auto-promotes from observed to recurring at 2 evidences", () => {
    let cap = makeCap();
    expect(cap.maturity).toBe("observed");
    cap = CapabilityOptics.strengthen({ roundId: "r2", summary: "x", timestamp: "t" }, "t")(cap);
    expect(cap.maturity).toBe("observed"); // 1 evidence still observed
    cap = CapabilityOptics.strengthen({ roundId: "r3", summary: "y", timestamp: "t" }, "t")(cap);
    expect(cap.maturity).toBe("recurring"); // 2 evidences
  });

  it("auto-promotes from recurring to reliable at 4 evidences", () => {
    let cap = makeCap();
    for (let i = 0; i < 4; i++) {
      cap = CapabilityOptics.strengthen({ roundId: `r${i}`, summary: "x", timestamp: "t" }, "t")(cap);
    }
    expect(cap.maturity).toBe("reliable");
  });

  it("never auto-promotes to foundational", () => {
    let cap = makeCap();
    for (let i = 0; i < 100; i++) {
      cap = CapabilityOptics.strengthen({ roundId: `r${i}`, summary: "x", timestamp: "t" }, "t")(cap);
    }
    expect(cap.maturity).toBe("reliable");
  });
});

describe("CapabilityOptics.revise", () => {
  it("replaces content for agent-authored capability", () => {
    const cap = makeCap();
    const r = CapabilityOptics.revise("New, deeper insight", "2025-02-01T00:00:00.000Z")(cap);
    expect(r.content).toBe("New, deeper insight");
    expect(r.updatedAt).toBe("2025-02-01T00:00:00.000Z");
  });

  it("throws CapabilityImmutableError for human_authored capability", () => {
    const cap = makeCap({ source: { kind: "human_authored", author: "alice" } });
    expect(() => CapabilityOptics.revise("new", "t")(cap)).toThrow(CapabilityImmutableError);
  });
});

describe("CapabilityOptics.promote", () => {
  it("sets maturity directly, including foundational", () => {
    const cap = makeCap();
    const promoted = CapabilityOptics.promote("foundational", "t")(cap);
    expect(promoted.maturity).toBe("foundational");
    expect(promoted.updatedAt).toBe("t");
  });
});

describe("CapabilityOptics.retire", () => {
  it("sets invalidAt and updatedAt; preserves record", () => {
    const cap = makeCap();
    const r = CapabilityOptics.retire("2025-03-01T00:00:00.000Z")(cap);
    expect(r.invalidAt).toBe("2025-03-01T00:00:00.000Z");
    expect(r.updatedAt).toBe("2025-03-01T00:00:00.000Z");
    expect(r.content).toBe(cap.content);
  });
});

describe("autoPromote", () => {
  it("noop if thresholds not met", () => {
    const cap = makeCap();
    expect(autoPromote(cap).maturity).toBe("observed");
  });
});
