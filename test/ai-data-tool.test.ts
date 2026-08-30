import { describe, it, expect } from "vitest";
import { createInMemoryTabularStore } from "../src/ai/data/in-memory-tabular-store.js";
import { createDataTool } from "../src/ai/data/data-tool.js";

describe("InMemoryTabularStore", () => {
  it("should append and query rows", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice", age: 30 });
    await store.append("users", { name: "Bob", age: 25 });

    const rows = await store.query("users");
    expect(rows).toHaveLength(2);
    expect(rows[0].data.name).toBe("Alice");
  });

  it("should filter with eq condition", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice", age: 30 });
    await store.append("users", { name: "Bob", age: 25 });

    const rows = await store.query("users", {
      conditions: [{ column: "name", op: "eq", value: "Bob" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].data.name).toBe("Bob");
  });

  it("should filter with gt condition", async () => {
    const store = createInMemoryTabularStore();
    await store.append("items", { price: 10 });
    await store.append("items", { price: 50 });
    await store.append("items", { price: 100 });

    const rows = await store.query("items", {
      conditions: [{ column: "price", op: "gt", value: 30 }],
    });
    expect(rows).toHaveLength(2);
  });

  it("should filter with contains condition", async () => {
    const store = createInMemoryTabularStore();
    await store.append("notes", { text: "Hello world" });
    await store.append("notes", { text: "Goodbye world" });
    await store.append("notes", { text: "Hello there" });

    const rows = await store.query("notes", {
      conditions: [{ column: "text", op: "contains", value: "Hello" }],
    });
    expect(rows).toHaveLength(2);
  });

  it("should update matching rows", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice", status: "active" });
    await store.append("users", { name: "Bob", status: "active" });

    const count = await store.update(
      "users",
      { conditions: [{ column: "name", op: "eq", value: "Alice" }] },
      { status: "inactive" },
    );
    expect(count).toBe(1);

    const rows = await store.query("users", {
      conditions: [{ column: "name", op: "eq", value: "Alice" }],
    });
    expect(rows[0].data.status).toBe("inactive");
  });

  it("should delete matching rows", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice" });
    await store.append("users", { name: "Bob" });

    const count = await store.delete("users", {
      conditions: [{ column: "name", op: "eq", value: "Alice" }],
    });
    expect(count).toBe(1);

    const remaining = await store.query("users");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].data.name).toBe("Bob");
  });

  it("should list tables", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice" });
    await store.append("products", { title: "Widget" });

    const tables = await store.listTables();
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.name).sort()).toEqual(["products", "users"]);
  });

  it("should return schema", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice", age: 30 });

    const schema = await store.schema("users");
    expect(schema).toBeDefined();
    expect(schema!.columns).toHaveLength(2);
    expect(schema!.columns.find((c) => c.name === "name")?.type).toBe("string");
    expect(schema!.columns.find((c) => c.name === "age")?.type).toBe("number");
  });

  it("should respect query limit", async () => {
    const store = createInMemoryTabularStore();
    for (let i = 0; i < 10; i++) await store.append("items", { i });
    const rows = await store.query("items", undefined, 3);
    expect(rows).toHaveLength(3);
  });
});

describe("DataTool", () => {
  it("should execute query action", async () => {
    const store = createInMemoryTabularStore();
    await store.append("users", { name: "Alice" });

    const tool = createDataTool({ main: store });
    const result = await tool.execute({ action: "query", source: "main", table: "users" });
    expect(result.success).toBe(true);
    expect((result.output as unknown[]).length).toBe(1);
  });

  it("should execute append action", async () => {
    const store = createInMemoryTabularStore();
    const tool = createDataTool({ main: store });

    const result = await tool.execute({
      action: "append",
      source: "main",
      table: "users",
      data: { name: "Bob" },
    });
    expect(result.success).toBe(true);
  });

  it("should fail for unknown source", async () => {
    const tool = createDataTool({});
    const result = await tool.execute({ action: "list", source: "unknown" });
    expect(result.success).toBe(false);
  });
});
