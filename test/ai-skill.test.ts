import { describe, it, expect } from "vitest";
import { parseSkillMarkdown, parseSkillDefinition } from "../src/ai/skill/skill-markdown-parser.js";
import { createInMemorySkillStore } from "../src/ai/skill/skill-store.js";
import { createSkillTool, buildSkillSummary } from "../src/ai/skill/skill-tool.js";

describe("SkillMarkdownParser", () => {
  const sampleSkill = `---
name: objection-price
description: "Techniques for handling price objections"
when-to-use: "When customer raises price concerns"
allowed-tools: [knowledge_search, data_query]
arguments: [objection_type]
version: "1.0"
---

## Price Objection Handling

1. Acknowledge the concern
2. Reframe the value proposition
3. Offer alternatives`;

  it("should parse a complete skill file", () => {
    const result = parseSkillMarkdown("objection-price.skill.md", sampleSkill);
    expect(result.name).toBe("objection-price");
    expect(result.definition.description).toBe("Techniques for handling price objections");
    expect(result.definition.whenToUse).toBe("When customer raises price concerns");
    expect(result.definition.allowedTools).toEqual(["knowledge_search", "data_query"]);
    expect(result.definition.arguments).toEqual(["objection_type"]);
    expect(result.definition.version).toBe("1.0");
    expect(result.definition.content).toContain("Price Objection Handling");
  });

  it("should use filename as fallback name", () => {
    const md = `---
description: "A skill"
---

Content here`;
    const result = parseSkillMarkdown("my-skill.skill.md", md);
    expect(result.name).toBe("my-skill");
  });

  it("should handle when_to_use (underscore variant)", () => {
    const md = `---
description: test
when_to_use: always
---

Content`;
    const result = parseSkillMarkdown("test.md", md);
    expect(result.definition.whenToUse).toBe("always");
  });

  it("should throw on missing frontmatter", () => {
    expect(() => parseSkillMarkdown("test.md", "No frontmatter here")).toThrow("Missing frontmatter delimiter");
  });

  it("should throw on unclosed frontmatter", () => {
    expect(() => parseSkillMarkdown("test.md", "---\nname: test\nNo closing")).toThrow("Missing closing frontmatter");
  });

  it("should handle single-value list fields", () => {
    const md = `---
description: test
allowed-tools: search
---

Content`;
    const result = parseSkillMarkdown("test.md", md);
    expect(result.definition.allowedTools).toEqual(["search"]);
  });

  it("should strip surrounding quotes from values", () => {
    const md = `---
description: 'Quoted description'
version: "2.0"
---

Content`;
    const result = parseSkillMarkdown("test.md", md);
    expect(result.definition.description).toBe("Quoted description");
    expect(result.definition.version).toBe("2.0");
  });

  it("should work with parseSkillDefinition", () => {
    const [name, defn] = parseSkillDefinition("test.skill.md", sampleSkill);
    expect(name).toBe("objection-price");
    expect(defn.description).toBe("Techniques for handling price objections");
  });
});

describe("SkillStore", () => {
  it("should add and retrieve skills", async () => {
    const store = createInMemorySkillStore();
    store.add("test-skill", { description: "A test skill", content: "Instructions here" });

    const skill = await store.get("test-skill");
    expect(skill).toBeDefined();
    expect(skill!.description).toBe("A test skill");
    expect(skill!.content).toBe("Instructions here");
  });

  it("should list all skills", async () => {
    const store = createInMemorySkillStore();
    store.add("skill-a", { description: "Skill A", content: "A" });
    store.add("skill-b", { description: "Skill B", content: "B" });

    const skills = await store.list();
    expect(skills).toHaveLength(2);
  });

  it("should return undefined for missing skill", async () => {
    const store = createInMemorySkillStore();
    expect(await store.get("nonexistent")).toBeUndefined();
  });
});

describe("SkillTool", () => {
  it("should return skill content", async () => {
    const store = createInMemorySkillStore();
    store.add("greeting", {
      description: "Greeting skill",
      whenToUse: "When greeting users",
      content: "Say hello warmly",
    });

    const tool = createSkillTool(store);
    const result = await tool.execute({ name: "greeting" });
    expect(result.success).toBe(true);

    const output = result.output as { name: string; description: string; content: string };
    expect(output.name).toBe("greeting");
    expect(output.description).toBe("Greeting skill");
    expect(output.content).toBe("Say hello warmly");
  });

  it("should fail for missing skill", async () => {
    const store = createInMemorySkillStore();
    const tool = createSkillTool(store);
    const result = await tool.execute({ name: "nonexistent" });
    expect(result.success).toBe(false);
  });

  it("should fail for missing name", async () => {
    const store = createInMemorySkillStore();
    const tool = createSkillTool(store);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
  });
});

describe("buildSkillSummary", () => {
  it("should build a markdown summary of available skills", async () => {
    const store = createInMemorySkillStore();
    store.add("greeting", { description: "Greeting skill", whenToUse: "When greeting", content: "" });
    store.add("farewell", { description: "Farewell skill", content: "" });

    const summary = await buildSkillSummary(store);
    expect(summary).toContain("## Available Skills");
    expect(summary).toContain("**greeting**");
    expect(summary).toContain("(use when: When greeting)");
    expect(summary).toContain("**farewell**");
  });

  it("should return empty string for no skills", async () => {
    const store = createInMemorySkillStore();
    const summary = await buildSkillSummary(store);
    expect(summary).toBe("");
  });
});
