import { describe, it, expect } from "vitest";
import { renderTemplate, applyMapping, applyInputMapping } from "../../../src/ai/node-flow/context.js";

describe("renderTemplate", () => {
  it("substitutes simple variables", () => {
    expect(renderTemplate("Hello {{name}}!", { name: "world" })).toBe("Hello world!");
  });

  it("supports dotted paths", () => {
    expect(renderTemplate("{{user.name}}", { user: { name: "Alice" } })).toBe("Alice");
  });

  it("missing values become empty strings", () => {
    expect(renderTemplate("[{{x}}]", {})).toBe("[]");
  });

  it("non-string values are JSON-stringified", () => {
    expect(renderTemplate("{{n}}", { n: 42 })).toBe("42");
    expect(renderTemplate("{{a}}", { a: [1, 2, 3] })).toBe("[1,2,3]");
  });
});

describe("applyMapping / applyInputMapping", () => {
  it("extracts via responseMapping path", () => {
    const r = applyMapping({ user: "$.data.user.name" }, { data: { user: { name: "Alice" } } });
    expect(r).toEqual({ user: "Alice" });
  });

  it("skips missing paths silently", () => {
    expect(applyMapping({ a: "$.absent" }, {})).toEqual({});
  });

  it("inputMapping reads from a context root", () => {
    expect(applyInputMapping({ q: "query" }, { query: "abc" })).toEqual({ q: "abc" });
  });
});
