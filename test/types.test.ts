import { describe, it, expect } from "vitest";
import { EntityId, CategoryId, TimerId, SequenceNr, nextSequenceNr } from "../src/core/types.js";
import { categoryTypes } from "../src/core/effect-control.js";

describe("EntityId", () => {
  it("should create from string", () => {
    const id = EntityId("test-entity");
    expect(id as string).toBe("test-entity");
  });

  it("should support equality", () => {
    const id1 = EntityId("same");
    const id2 = EntityId("same");
    const id3 = EntityId("different");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe("CategoryId", () => {
  it("should create from string", () => {
    const id = CategoryId("my-category");
    expect(id as string).toBe("my-category");
  });

  it("should support equality", () => {
    const id1 = CategoryId("same");
    const id2 = CategoryId("same");
    const id3 = CategoryId("different");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe("TimerId", () => {
  it("should create from string", () => {
    const id = TimerId("my-timer");
    expect(id as string).toBe("my-timer");
  });

  it("should support equality", () => {
    const id1 = TimerId("same");
    const id2 = TimerId("same");
    expect(id1).toBe(id2);
  });
});

describe("SequenceNr", () => {
  it("should create from number", () => {
    const nr = SequenceNr(42);
    expect(nr as number).toBe(42);
  });

  it("should support next", () => {
    const nr = SequenceNr(10);
    expect(nextSequenceNr(nr) as number).toBe(11);
  });

  it("should support ordering via sorting", () => {
    const nr1 = SequenceNr(1);
    const nr2 = SequenceNr(2);
    const nr3 = SequenceNr(3);
    const sorted = [nr3, nr1, nr2].sort((a, b) => (a as number) - (b as number));
    expect(sorted.map((n) => n as number)).toEqual([1, 2, 3]);
  });
});

describe("categoryTypes", () => {
  it("should create type-safe category association", () => {
    type MyCommand = { action: string };
    type MyReply = { result: string };
    const cat = categoryTypes<MyCommand, MyReply>(CategoryId("my-entity"));
    expect(cat.categoryId as string).toBe("my-entity");
  });
});

describe("ReplyError", () => {
  it("should have Timeout", () => {
    const err = { tag: "Timeout" as const };
    expect(err.tag).toBe("Timeout");
  });

  it("should have CategoryNotFound", () => {
    const err = { tag: "CategoryNotFound" as const, categoryId: CategoryId("missing") };
    expect(err.tag).toBe("CategoryNotFound");
    expect(err.categoryId as string).toBe("missing");
  });

  it("should have General", () => {
    const err = { tag: "General" as const, message: "Something went wrong" };
    expect(err.message).toBe("Something went wrong");
  });
});
