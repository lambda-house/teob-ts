import { describe, it, expect } from "vitest";
import { CapabilityService } from "../../../src/ai/capability/service.js";
import { InMemoryCapabilityStore } from "../../../src/ai/capability/in-memory-store.js";
import { RuleBasedDecider } from "../../../src/ai/capability/decider.js";
import { newCapability } from "../../../src/ai/capability/types.js";

function makeService(opts: { strengthenThreshold?: number; reviseThreshold?: number } = {}) {
  let now = 0;
  const store = new InMemoryCapabilityStore();
  const service = new CapabilityService({
    store,
    decider: new RuleBasedDecider({
      strengthenThreshold: opts.strengthenThreshold,
      reviseThreshold: opts.reviseThreshold,
    }),
    clock: () => {
      now += 1;
      return new Date(now * 1000).toISOString();
    },
  });
  return { service, store };
}

describe("CapabilityService.processObservation", () => {
  it("empty store → adds new capability", async () => {
    const { service, store } = makeService();
    const d = await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries",
      source: { kind: "agent_observation", agentId: "agent-1", roundId: "r1" },
    });
    expect(d.kind).toBe("add");
    const all = await store.all("agent-1");
    expect(all).toHaveLength(1);
    expect(all[0].maturity).toBe("observed");
  });

  it("subsequent identical observation → strengthens", async () => {
    const { service, store } = makeService();
    await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries",
      source: { kind: "agent_observation", agentId: "agent-1", roundId: "r1" },
    });
    const d = await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries",
      source: { kind: "agent_observation", agentId: "agent-1", roundId: "r2" },
    });
    expect(d.kind).toBe("strengthen");
    const all = await store.all("agent-1");
    expect(all).toHaveLength(1);
    expect(all[0].evidence).toHaveLength(1);
  });

  it("strengthen N times triggers maturity promotion to recurring", async () => {
    const { service, store } = makeService();
    for (let i = 0; i < 3; i++) {
      await service.processObservation({
        scopeKey: "agent-1",
        content: "DB latency exceeds 200ms triggers saga retries",
        source: { kind: "agent_observation", agentId: "agent-1", roundId: `r${i}` },
      });
    }
    const all = await store.all("agent-1");
    expect(all).toHaveLength(1);
    expect(all[0].maturity).toBe("recurring");
    expect(all[0].evidence).toHaveLength(2); // first call adds, next two strengthen
  });

  it("near-similar observation → revise", async () => {
    const { service, store } = makeService({
      strengthenThreshold: 0.99,
      reviseThreshold: 0.05,
    });
    await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries",
      source: { kind: "agent_observation", agentId: "a", roundId: "r1" },
    });
    const d = await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries with circuit breaker",
      source: { kind: "agent_observation", agentId: "a", roundId: "r2" },
    });
    expect(d.kind).toBe("revise");
    const all = await store.all("agent-1");
    expect(all[0].content).toContain("circuit breaker");
  });

  it("revise blocked → noop for human-authored target", async () => {
    const { service, store } = makeService({
      strengthenThreshold: 0.99,
      reviseThreshold: 0.05,
    });
    // Pre-seed the store with a human-authored capability:
    const seeded = newCapability({
      scopeKey: "agent-1",
      layer: "principle",
      content: "DB latency exceeds 200ms triggers saga retries",
      source: { kind: "human_authored", author: "alice" },
      now: new Date(0).toISOString(),
    });
    await store.save(seeded);

    const d = await service.processObservation({
      scopeKey: "agent-1",
      content: "DB latency exceeds 200ms triggers saga retries with circuit breaker",
      source: { kind: "agent_observation", agentId: "a", roundId: "r2" },
    });
    expect(d.kind).toBe("noop");
    const stored = await store.get(seeded.id);
    expect(stored?.content).toBe(seeded.content); // unchanged
  });
});
