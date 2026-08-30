import { describe, it, expect } from "vitest";
import { createInMemoryPromptRegistry } from "../src/ai/prompt/prompt-registry.js";

describe("PromptRegistry", () => {
  it("should create a prompt with initial version", async () => {
    const registry = createInMemoryPromptRegistry();
    const v1 = await registry.create("greeting", [
      { tag: "system", content: "You are a helpful assistant.", priority: 1 },
      { tag: "context", content: "Topic: {{topic}}", priority: 2 },
    ]);

    expect(v1.promptId).toBe("greeting");
    expect(v1.parentVersionId).toBeUndefined();
    expect(v1.sections).toHaveLength(2);
  });

  it("should update prompt with linked version", async () => {
    const registry = createInMemoryPromptRegistry();
    const v1 = await registry.create("greeting", [
      { tag: "system", content: "v1 content", priority: 1 },
    ]);
    const v2 = await registry.update("greeting", [
      { tag: "system", content: "v2 content", priority: 1 },
    ]);

    expect(v2.parentVersionId).toBe(v1.versionId);
  });

  it("should get latest version", async () => {
    const registry = createInMemoryPromptRegistry();
    await registry.create("greeting", [{ tag: "s", content: "v1", priority: 1 }]);
    await registry.update("greeting", [{ tag: "s", content: "v2", priority: 1 }]);

    const latest = await registry.get("greeting");
    expect(latest?.sections[0].content).toBe("v2");
  });

  it("should get specific version", async () => {
    const registry = createInMemoryPromptRegistry();
    const v1 = await registry.create("greeting", [{ tag: "s", content: "v1", priority: 1 }]);
    await registry.update("greeting", [{ tag: "s", content: "v2", priority: 1 }]);

    const retrieved = await registry.getVersion("greeting", v1.versionId);
    expect(retrieved?.sections[0].content).toBe("v1");
  });

  it("should list versions newest first", async () => {
    const registry = createInMemoryPromptRegistry();
    await registry.create("greeting", [{ tag: "s", content: "v1", priority: 1 }]);
    await registry.update("greeting", [{ tag: "s", content: "v2", priority: 1 }]);
    await registry.update("greeting", [{ tag: "s", content: "v3", priority: 1 }]);

    const versions = await registry.listVersions("greeting");
    expect(versions).toHaveLength(3);
    expect(versions[0].sections[0].content).toBe("v3");
    expect(versions[2].sections[0].content).toBe("v1");
  });

  it("should resolve with template substitution", async () => {
    const registry = createInMemoryPromptRegistry();
    await registry.create("greeting", [
      { tag: "role", content: "You are a {{role}}.", priority: 1 },
      { tag: "topic", content: "Discuss {{topic}}.", priority: 2 },
    ]);

    const result = await registry.resolve("greeting", { role: "teacher", topic: "math" });
    expect(result).toBeDefined();
    expect(result!.rendered).toBe("You are a teacher.\n\nDiscuss math.");
  });

  it("should preserve unresolved variables", async () => {
    const registry = createInMemoryPromptRegistry();
    await registry.create("test", [
      { tag: "s", content: "Hello {{name}}, your {{unknown}} is ready.", priority: 1 },
    ]);

    const result = await registry.resolve("test", { name: "Alice" });
    expect(result!.rendered).toBe("Hello Alice, your {{unknown}} is ready.");
  });

  it("should sort sections by priority", async () => {
    const registry = createInMemoryPromptRegistry();
    await registry.create("test", [
      { tag: "footer", content: "Footer", priority: 3 },
      { tag: "header", content: "Header", priority: 1 },
      { tag: "body", content: "Body", priority: 2 },
    ]);

    const result = await registry.resolve("test");
    expect(result!.rendered).toBe("Header\n\nBody\n\nFooter");
  });

  it("should return undefined for nonexistent prompt", async () => {
    const registry = createInMemoryPromptRegistry();
    expect(await registry.get("nonexistent")).toBeUndefined();
    expect(await registry.resolve("nonexistent")).toBeUndefined();
  });
});
