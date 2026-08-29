import { describe, it, expect } from "vitest";
import { createInMemoryFileStore } from "../src/ai/file/in-memory-file-store.js";
import { createFileTool } from "../src/ai/file/file-tool.js";

describe("InMemoryFileStore", () => {
  it("should write and read files", async () => {
    const store = createInMemoryFileStore();
    await store.write("/test.txt", "Hello World");
    const content = await store.read("/test.txt");
    expect(content).toBe("Hello World");
  });

  it("should throw on read of nonexistent file", async () => {
    const store = createInMemoryFileStore();
    await expect(store.read("/missing.txt")).rejects.toThrow("File not found");
  });

  it("should list files in directory", async () => {
    const store = createInMemoryFileStore();
    await store.write("/docs/a.txt", "a");
    await store.write("/docs/b.txt", "b");
    await store.write("/other/c.txt", "c");

    const files = await store.list("/docs/");
    expect(files).toHaveLength(2);
  });

  it("should check file existence", async () => {
    const store = createInMemoryFileStore();
    await store.write("/exists.txt", "data");
    expect(await store.exists("/exists.txt")).toBe(true);
    expect(await store.exists("/missing.txt")).toBe(false);
  });

  it("should return file info", async () => {
    const store = createInMemoryFileStore();
    await store.write("/test.txt", "Hello");
    const info = await store.info("/test.txt");
    expect(info).toBeDefined();
    expect(info!.extension).toBe(".txt");
    expect(info!.size).toBe(5);
  });
});

describe("FileTool", () => {
  it("should read a file", async () => {
    const store = createInMemoryFileStore();
    await store.write("/data.txt", "Content here");
    const tool = createFileTool(store);

    const result = await tool.execute({ action: "read", path: "/data.txt" });
    expect(result.success).toBe(true);
    expect((result.output as { content: string }).content).toBe("Content here");
  });

  it("should write a file", async () => {
    const store = createInMemoryFileStore();
    const tool = createFileTool(store);

    const result = await tool.execute({ action: "write", path: "/new.txt", content: "New content" });
    expect(result.success).toBe(true);

    const content = await store.read("/new.txt");
    expect(content).toBe("New content");
  });

  it("should parse CSV", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const csv = "name,age\nAlice,30\nBob,25";

    const result = await tool.execute({ action: "parse_csv", content: csv });
    expect(result.success).toBe(true);
    const rows = result.output as Record<string, string>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Alice");
    expect(rows[1].age).toBe("25");
  });

  it("should parse CSV with quoted fields", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const csv = 'name,description\nAlice,"Has a, comma"\nBob,"Normal"';

    const result = await tool.execute({ action: "parse_csv", content: csv });
    expect(result.success).toBe(true);
    const rows = result.output as Record<string, string>[];
    expect(rows[0].description).toBe("Has a, comma");
  });

  it("should convert JSON to CSV", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const json = JSON.stringify([{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]);

    const result = await tool.execute({ action: "to_csv", content: json });
    expect(result.success).toBe(true);
    const csv = (result.output as { csv: string }).csv;
    expect(csv).toContain("name,age");
    expect(csv).toContain("Alice,30");
  });

  it("should parse JSON content", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const result = await tool.execute({ action: "parse_json", content: '{"key": "value"}' });
    expect(result.success).toBe(true);
    expect((result.output as { key: string }).key).toBe("value");
  });

  it("should convert markdown to HTML", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const result = await tool.execute({ action: "markdown_to_html", content: "# Hello\n\n**Bold** text" });
    expect(result.success).toBe(true);
    const html = (result.output as { html: string }).html;
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>Bold</strong>");
  });

  it("should fail gracefully on missing path", async () => {
    const tool = createFileTool(createInMemoryFileStore());
    const result = await tool.execute({ action: "read" });
    expect(result.success).toBe(false);
  });
});
