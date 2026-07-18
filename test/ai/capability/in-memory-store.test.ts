import { describe, it, expect } from "vitest";
import { newCapability } from "../../../src/ai/capability/types.js";
import { InMemoryCapabilityStore, jaccard, tokenize } from "../../../src/ai/capability/in-memory-store.js";
import { CapabilityOptics } from "../../../src/ai/capability/optics.js";

const cap = (overrides: Partial<Parameters<typeof newCapability>[0]> = {}) =>
  newCapability({
    scopeKey: "agent-1",
    layer: "experience",
    content: "DB latency exceeds 200ms triggers saga retries",
    source: { kind: "agent_observation", agentId: "agent-1", roundId: "r1" },
    now: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });

describe("tokenize / jaccard", () => {
  it("ignores stop words and short tokens", () => {
    const t = tokenize("The DB latency exceeds 200ms");
    expect(t.has("the")).toBe(false);
    expect(t.has("db")).toBe(false); // < 3 chars
    expect(t.has("latency")).toBe(true);
    expect(t.has("exceeds")).toBe(true);
  });

  it("jaccard 1 for identical sets, 0 for disjoint", () => {
    const a = new Set(["foo", "bar"]);
    const b = new Set(["foo", "bar"]);
    expect(jaccard(a, b)).toBe(1);
    const c = new Set(["baz"]);
    expect(jaccard(a, c)).toBe(0);
  });
});

describe("InMemoryCapabilityStore", () => {
  it("save/get round-trips", async () => {
    const store = new InMemoryCapabilityStore();
    const c = cap();
    await store.save(c);
    const got = await store.get(c.id);
    expect(got?.id).toBe(c.id);
  });

  it("findSimilar ranks by Jaccard descending", async () => {
    const store = new InMemoryCapabilityStore();
    const c1 = cap({ content: "DB latency exceeds 200ms triggers saga retries" });
    const c2 = cap({ content: "User profile photo uploads to S3" });
    const c3 = cap({ content: "DB latency monitoring helps detect slow queries" });
    await store.save(c1);
    await store.save(c2);
    await store.save(c3);
    const results = await store.findSimilar("DB latency saga retries", "agent-1", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(c1.id); // highest similarity
  });

  it("findSimilar excludes retired", async () => {
    const store = new InMemoryCapabilityStore();
    const c1 = cap({ content: "DB latency saga retries" });
    await store.save(c1);
    await store.update(c1.id, CapabilityOptics.retire("2025-06-01T00:00:00.000Z"));
    const r = await store.findSimilar("DB latency saga retries", "agent-1", 5);
    expect(r).toHaveLength(0);
  });

  it("findByScope filters by layer/maturity/includeRetired", async () => {
    const store = new InMemoryCapabilityStore();
    const c1 = cap({ layer: "principle" });
    const c2 = cap({ layer: "heuristic" });
    await store.save(c1);
    await store.save(c2);
    const principles = await store.findByScope({ scopeKey: "agent-1", layer: "principle" });
    expect(principles.map((c) => c.id)).toEqual([c1.id]);

    await store.update(c1.id, CapabilityOptics.retire("t"));
    const active = await store.findByScope({ scopeKey: "agent-1" });
    expect(active.map((c) => c.id)).toEqual([c2.id]);

    const all = await store.findByScope({ scopeKey: "agent-1", includeRetired: true });
    expect(new Set(all.map((c) => c.id))).toEqual(new Set([c1.id, c2.id]));
  });

  it("findValid uses time-travel windows", async () => {
    const store = new InMemoryCapabilityStore();
    const c1 = cap({ now: "2024-06-01T00:00:00.000Z" });
    await store.save(c1);
    // valid in window
    const before = await store.findValid("agent-1", "2024-06-02T00:00:00.000Z");
    expect(before.map((c) => c.id)).toEqual([c1.id]);
    // not yet valid
    const earlier = await store.findValid("agent-1", "2023-01-01T00:00:00.000Z");
    expect(earlier).toHaveLength(0);
    // retire then ask after retirement
    await store.update(c1.id, CapabilityOptics.retire("2024-08-01T00:00:00.000Z"));
    const after = await store.findValid("agent-1", "2024-09-01T00:00:00.000Z");
    expect(after).toHaveLength(0);
    // still valid right at retirement instant — invalidAt is exclusive (we use <= asOf to consider invalid)
    const at = await store.findValid("agent-1", "2024-07-15T00:00:00.000Z");
    expect(at).toHaveLength(1);
  });
});
