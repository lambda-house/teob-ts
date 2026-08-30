import { describe, it, expect } from "vitest";
import { createKnowledgeSearchTool } from "../src/ai/knowledge/knowledge-search-tool.js";
import type { KnowledgeAPI, KnowledgeRecord } from "../src/ai/knowledge/knowledge-api.js";

function mockKnowledgeAPI(records: KnowledgeRecord[]): KnowledgeAPI {
  return {
    async findBestMatches(userQuery, filter, limit) {
      let results = records;
      if (filter?.collection) {
        results = results.filter((r) => r.collection === filter.collection);
      }
      return results.slice(0, limit ?? 10).map((r) => ({
        ...r,
        similarity: 0.9,
      }));
    },
    async viewRecords(filter, _exactWord, limit) {
      let results = records;
      if (filter?.collection) {
        results = results.filter((r) => r.collection === filter.collection);
      }
      return results.slice(0, limit ?? 100);
    },
    async upsertRecord() { return records[0]; },
    async deleteRecord() { return true; },
    async deleteCollection() { return 0; },
    async exportCollection() { return []; },
    async importRecords() { return [0, 0]; },
    async recomputeVector() { return undefined; },
  };
}

const testRecords: KnowledgeRecord[] = [
  {
    id: "r1",
    text: "TypeScript is a typed superset of JavaScript",
    collection: "docs",
    attributes: { topic: "typescript" },
    checksum: "abc",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "r2",
    text: "Scala is a JVM language",
    collection: "docs",
    attributes: { topic: "scala" },
    checksum: "def",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "r3",
    text: "Kubernetes manages containers",
    collection: "infra",
    attributes: { topic: "k8s" },
    checksum: "ghi",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe("KnowledgeSearchTool", () => {
  it("should have correct name and schema", () => {
    const tool = createKnowledgeSearchTool(mockKnowledgeAPI(testRecords));
    expect(tool.name).toBe("knowledge_search");
    expect(tool.inputSchema).toBeDefined();
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });

  it("should include collection descriptions", () => {
    const tool = createKnowledgeSearchTool(mockKnowledgeAPI(testRecords), [
      { name: "docs", description: "Documentation" },
      { name: "infra", description: "Infrastructure" },
    ]);
    expect(tool.description).toContain("docs: Documentation");
    expect(tool.description).toContain("infra: Infrastructure");
  });

  it("should search with query", async () => {
    const tool = createKnowledgeSearchTool(mockKnowledgeAPI(testRecords));

    const result = await tool.execute({ query: "TypeScript", limit: 5 });
    expect(result.success).toBe(true);
    const output = result.output as Array<{ id: string; similarity: number }>;
    expect(output.length).toBeGreaterThan(0);
    expect(output[0].similarity).toBe(0.9);
  });

  it("should browse without query", async () => {
    const tool = createKnowledgeSearchTool(mockKnowledgeAPI(testRecords));

    const result = await tool.execute({ collection: "docs" });
    expect(result.success).toBe(true);
    const output = result.output as Array<{ id: string; collection: string }>;
    expect(output.every((r) => r.collection === "docs")).toBe(true);
  });

  it("should filter by collection", async () => {
    const tool = createKnowledgeSearchTool(mockKnowledgeAPI(testRecords));

    const result = await tool.execute({ query: "test", collection: "infra" });
    expect(result.success).toBe(true);
    const output = result.output as Array<{ id: string; collection: string }>;
    expect(output.every((r) => r.collection === "infra")).toBe(true);
  });

  it("should handle errors gracefully", async () => {
    const failingAPI: KnowledgeAPI = {
      ...mockKnowledgeAPI([]),
      async findBestMatches() { throw new Error("DB connection failed"); },
    };

    const tool = createKnowledgeSearchTool(failingAPI);
    const result = await tool.execute({ query: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("DB connection failed");
  });
});
