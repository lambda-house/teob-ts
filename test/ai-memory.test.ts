import { describe, it, expect } from "vitest";
import type { KnowledgeAPI, KnowledgeRecord } from "../src/ai/knowledge/knowledge-api.js";
import { createKnowledgeBackedMemoryService, toMemory } from "../src/ai/memory/knowledge-backed-memory-service.js";
import { createMemoryTool } from "../src/ai/memory/memory-tool.js";

function createMockKnowledgeAPI(): KnowledgeAPI & { records: Map<string, KnowledgeRecord> } {
  const records = new Map<string, KnowledgeRecord>();

  return {
    records,

    async findBestMatches(userQuery, filter, limit) {
      let results = Array.from(records.values());
      if (filter?.collection) {
        results = results.filter((r) => r.collection === filter.collection);
      }
      if (filter?.attributes) {
        for (const [key, value] of Object.entries(filter.attributes)) {
          results = results.filter((r) => r.attributes[key] === value);
        }
      }
      return results.slice(0, limit ?? 10).map((r) => ({ ...r, similarity: 0.85 }));
    },

    async viewRecords(filter, _exactWord, limit) {
      let results = Array.from(records.values());
      if (filter?.collection) {
        results = results.filter((r) => r.collection === filter.collection);
      }
      if (filter?.attributes) {
        for (const [key, value] of Object.entries(filter.attributes)) {
          results = results.filter((r) => r.attributes[key] === value);
        }
      }
      return results.slice(0, limit ?? 100);
    },

    async upsertRecord(input) {
      const now = new Date();
      const existing = records.get(input.id);
      const record: KnowledgeRecord = {
        id: input.id,
        text: input.text,
        collection: input.collection,
        attributes: input.attributes ?? {},
        checksum: input.checksum ?? "checksum",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      records.set(input.id, record);
      return record;
    },

    async deleteRecord(id) {
      return records.delete(id);
    },

    async deleteCollection(collection) {
      let count = 0;
      for (const [id, r] of records) {
        if (r.collection === collection) {
          records.delete(id);
          count++;
        }
      }
      return count;
    },

    async exportCollection() { return []; },
    async importRecords() { return [0, 0]; },
    async recomputeVector() { return undefined; },
  };
}

describe("MemoryService", () => {
  it("store creates a record via KnowledgeAPI", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    const memory = await service.store("agent-1", "user", "User prefers dark mode", { source: "chat" });

    expect(memory.agentId).toBe("agent-1");
    expect(memory.memoryType).toBe("user");
    expect(memory.content).toBe("User prefers dark mode");
    expect(memory.metadata).toEqual({ source: "chat" });
    expect(memory.id).toBeDefined();
    expect(api.records.size).toBe(1);

    const stored = Array.from(api.records.values())[0];
    expect(stored.collection).toBe("memory:agent-1");
    expect(stored.attributes.memoryType).toBe("user");
  });

  it("recall with semanticQuery uses findBestMatches", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "User likes TypeScript");
    await service.store("agent-1", "domain", "Project uses React");

    const results = await service.recall({ agentId: "agent-1", semanticQuery: "TypeScript" });

    expect(results.length).toBe(2);
    expect(results[0].agentId).toBe("agent-1");
  });

  it("recall without semanticQuery uses viewRecords", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "User likes TypeScript");
    await service.store("agent-2", "user", "Different agent memory");

    const results = await service.recall({ agentId: "agent-1" });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe("User likes TypeScript");
  });

  it("recall with explicit limit passes it to findBestMatches", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "Memory one");
    await service.store("agent-1", "user", "Memory two");
    await service.store("agent-1", "user", "Memory three");

    const results = await service.recall({ agentId: "agent-1", semanticQuery: "memory", limit: 2 });

    expect(results.length).toBe(2);
  });

  it("recall with explicit limit passes it to viewRecords", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "Memory one");
    await service.store("agent-1", "user", "Memory two");
    await service.store("agent-1", "user", "Memory three");

    const results = await service.recall({ agentId: "agent-1", limit: 2 });

    expect(results.length).toBe(2);
  });

  it("metadata passthrough in store is preserved and round-tripped via recall", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "User prefers dark mode", { source: "chat", topic: "preferences" });

    // Verify metadata is stored as attributes in the knowledge record
    const stored = Array.from(api.records.values())[0];
    expect(stored.attributes.source).toBe("chat");
    expect(stored.attributes.topic).toBe("preferences");
    expect(stored.attributes.memoryType).toBe("user");

    // Verify metadata round-trips back through recall (memoryType is extracted, rest stays in metadata)
    const results = await service.recall({ agentId: "agent-1" });
    expect(results.length).toBe(1);
    expect(results[0].metadata).toEqual({ source: "chat", topic: "preferences" });
    expect(results[0].memoryType).toBe("user");
  });

  it("recall with memoryType filters by attribute", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await service.store("agent-1", "user", "User preference");
    await service.store("agent-1", "domain", "Domain knowledge");

    const results = await service.recall({ agentId: "agent-1", memoryType: "user" });

    expect(results.length).toBe(1);
    expect(results[0].memoryType).toBe("user");
    expect(results[0].content).toBe("User preference");
  });

  it("update modifies existing record", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    const original = await service.store("agent-1", "user", "Original content");
    const updated = await service.update(original.id, "Updated content");

    expect(updated.id).toBe(original.id);
    expect(updated.content).toBe("Updated content");
    expect(updated.agentId).toBe("agent-1");
    expect(updated.memoryType).toBe("user");
  });

  it("update throws for non-existent record", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    await expect(service.update("non-existent", "content")).rejects.toThrow("Memory not found");
  });

  it("forget deletes record", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);

    const memory = await service.store("agent-1", "user", "To be forgotten");
    expect(api.records.size).toBe(1);

    await service.forget(memory.id);
    expect(api.records.size).toBe(0);
  });
});

describe("toMemory", () => {
  it("correctly extracts agentId from collection", () => {
    const record: KnowledgeRecord = {
      id: "test-id",
      text: "some content",
      collection: "memory:agent-42",
      attributes: { memoryType: "feedback", source: "chat" },
      checksum: "abc",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-02"),
    };

    const memory = toMemory(record);

    expect(memory.id).toBe("test-id");
    expect(memory.agentId).toBe("agent-42");
    expect(memory.memoryType).toBe("feedback");
    expect(memory.content).toBe("some content");
    expect(memory.metadata).toEqual({ source: "chat" });
    expect(memory.createdAt).toEqual(new Date("2025-01-01"));
    expect(memory.updatedAt).toEqual(new Date("2025-01-02"));
  });

  it("defaults memoryType to domain when not in attributes", () => {
    const record: KnowledgeRecord = {
      id: "test-id",
      text: "content",
      collection: "memory:agent-1",
      attributes: {},
      checksum: "abc",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const memory = toMemory(record);
    expect(memory.memoryType).toBe("domain");
  });
});

describe("MemoryTool", () => {
  it("dispatches store action", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    const result = await tool.execute({
      action: "store",
      memory_type: "user",
      content: "User prefers dark mode",
    });

    expect(result.success).toBe(true);
    const output = result.output as { memoryType: string; content: string };
    expect(output.memoryType).toBe("user");
    expect(output.content).toBe("User prefers dark mode");
  });

  it("dispatches recall action", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    await service.store("agent-1", "user", "User likes cats");

    const result = await tool.execute({ action: "recall", query: "cats" });

    expect(result.success).toBe(true);
    const output = result.output as Array<{ content: string }>;
    expect(output.length).toBe(1);
    expect(output[0].content).toBe("User likes cats");
  });

  it("dispatches forget action", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    const memory = await service.store("agent-1", "user", "To forget");

    const result = await tool.execute({ action: "forget", id: memory.id });

    expect(result.success).toBe(true);
    expect((result.output as { deleted: string }).deleted).toBe(memory.id);
    expect(api.records.size).toBe(0);
  });

  it("returns error for missing store params", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    const result = await tool.execute({ action: "store" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("requires memory_type and content");
  });

  it("returns error for unknown action", async () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    const result = await tool.execute({ action: "invalid" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("has correct name and schema", () => {
    const api = createMockKnowledgeAPI();
    const service = createKnowledgeBackedMemoryService(api);
    const tool = createMemoryTool(service, "agent-1");

    expect(tool.name).toBe("memory");
    expect(tool.description).toBe("Store and recall information across conversations");
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });
});
