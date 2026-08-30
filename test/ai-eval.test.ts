import { describe, it, expect } from "vitest";
import {
  exactMatch,
  contains,
  jsonValid,
  regexMatch,
  lengthCheck,
} from "../src/ai/eval/evaluators.js";
import { evaluateSample, evaluateDataset } from "../src/ai/eval/eval-runner.js";
import type { EvalInput } from "../src/ai/eval/types.js";

describe("Evaluators", () => {
  describe("ExactMatch", () => {
    const evaluator = exactMatch();

    it("should score 1.0 on exact match", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "hello", expectedOutput: "hello" });
      expect(score.score).toBe(1.0);
    });

    it("should score 0.0 on mismatch", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "hi", expectedOutput: "hello" });
      expect(score.score).toBe(0.0);
    });
  });

  describe("Contains", () => {
    const evaluator = contains(["TypeScript", "framework", "event"]);

    it("should score fraction of keywords found", async () => {
      const score = await evaluator.evaluate({
        question: "q",
        response: "This is a TypeScript framework",
      });
      expect(score.score).toBeCloseTo(2 / 3);
    });

    it("should score 1.0 when all keywords found", async () => {
      const score = await evaluator.evaluate({
        question: "q",
        response: "TypeScript event-sourcing framework",
      });
      expect(score.score).toBe(1.0);
    });

    it("should be case insensitive", async () => {
      const score = await evaluator.evaluate({
        question: "q",
        response: "typescript FRAMEWORK EVENT",
      });
      expect(score.score).toBe(1.0);
    });
  });

  describe("JsonValid", () => {
    const evaluator = jsonValid();

    it("should score 1.0 for valid JSON", async () => {
      const score = await evaluator.evaluate({ question: "q", response: '{"key": "value"}' });
      expect(score.score).toBe(1.0);
    });

    it("should score 0.0 for invalid JSON", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "not json" });
      expect(score.score).toBe(0.0);
    });
  });

  describe("RegexMatch", () => {
    const evaluator = regexMatch(/^\d{4}-\d{2}-\d{2}$/);

    it("should score 1.0 on match", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "2026-04-06" });
      expect(score.score).toBe(1.0);
    });

    it("should score 0.0 on no match", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "April 6th" });
      expect(score.score).toBe(0.0);
    });
  });

  describe("LengthCheck", () => {
    const evaluator = lengthCheck(50);

    it("should score 1.0 within limit", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "short" });
      expect(score.score).toBe(1.0);
    });

    it("should scale down linearly beyond limit", async () => {
      const score = await evaluator.evaluate({ question: "q", response: "x".repeat(100) });
      expect(score.score).toBeCloseTo(0.5);
    });
  });
});

describe("EvalRunner", () => {
  it("should evaluate a single sample", async () => {
    const result = await evaluateSample(
      "sample-1",
      { question: "What is 2+2?", response: "4", expectedOutput: "4" },
      [exactMatch(), jsonValid()],
    );
    expect(result.sampleId).toBe("sample-1");
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0].score).toBe(1.0);
  });

  it("should evaluate a dataset with aggregates", async () => {
    const dataset = {
      name: "math",
      version: "1.0",
      samples: [
        { id: "s1", prompt: "2+2", expectedOutput: "4" },
        { id: "s2", prompt: "3+3", expectedOutput: "6" },
      ],
    };

    const report = await evaluateDataset(
      dataset,
      async (prompt) => prompt === "2+2" ? "4" : "7", // second one wrong
      [exactMatch()],
    );

    expect(report.datasetName).toBe("math");
    expect(report.results).toHaveLength(2);
    expect(report.aggregates).toHaveLength(1);
    expect(report.aggregates[0].mean).toBeCloseTo(0.5);
    expect(report.aggregates[0].min).toBe(0.0);
    expect(report.aggregates[0].max).toBe(1.0);
    expect(report.aggregates[0].count).toBe(2);
  });
});
