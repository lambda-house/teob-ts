import { describe, it, expect } from "vitest";
import { evaluate, readPath } from "../../../src/ai/node-flow/guard.js";

describe("readPath", () => {
  it("reads dotted paths and array indices", () => {
    const ctx = { a: { b: [{ c: 42 }] } };
    expect(readPath("a.b[0].c", ctx)).toBe(42);
    expect(readPath("$.a.b[0].c", ctx)).toBe(42);
  });

  it("returns undefined for missing keys", () => {
    expect(readPath("a.x", { a: {} })).toBeUndefined();
  });
});

describe("evaluate", () => {
  const ctx = { count: 5, name: "alpha", tags: ["x", "y"] };

  it("eq / neq", () => {
    expect(evaluate({ type: "eq", path: "count", value: 5 }, ctx)).toBe(true);
    expect(evaluate({ type: "neq", path: "count", value: 7 }, ctx)).toBe(true);
  });

  it("numeric comparators", () => {
    expect(evaluate({ type: "gt", path: "count", value: 4 }, ctx)).toBe(true);
    expect(evaluate({ type: "lt", path: "count", value: 4 }, ctx)).toBe(false);
    expect(evaluate({ type: "gte", path: "count", value: 5 }, ctx)).toBe(true);
    expect(evaluate({ type: "lte", path: "count", value: 5 }, ctx)).toBe(true);
  });

  it("contains for arrays and strings", () => {
    expect(evaluate({ type: "contains", path: "name", value: "lph" }, ctx)).toBe(true);
    expect(evaluate({ type: "contains", path: "tags", value: "x" }, ctx)).toBe(true);
    expect(evaluate({ type: "contains", path: "tags", value: "z" }, ctx)).toBe(false);
  });

  it("AND / OR / NOT compose", () => {
    expect(
      evaluate(
        {
          type: "and",
          left: { type: "gt", path: "count", value: 2 },
          right: { type: "eq", path: "name", value: "alpha" },
        },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluate(
        {
          type: "or",
          left: { type: "eq", path: "name", value: "beta" },
          right: { type: "gt", path: "count", value: 100 },
        },
        ctx,
      ),
    ).toBe(false);
    expect(evaluate({ type: "not", inner: { type: "always" } }, ctx)).toBe(false);
  });

  it("always returns true", () => {
    expect(evaluate({ type: "always" }, ctx)).toBe(true);
  });
});
