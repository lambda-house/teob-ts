import type { Evaluator, EvalInput, EvalScore } from "./types.js";
import type { EmbeddingService } from "../embedding/embedding-service.js";
import type { LLMService } from "../llm/llm-service.js";
import { ChatMessage } from "../llm/types.js";

/** Scores 1.0 for exact string equality between response and expectedOutput. */
export function exactMatch(): Evaluator {
  return {
    name: "ExactMatch",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      const score = input.response === (input.expectedOutput ?? "") ? 1.0 : 0.0;
      return { evaluatorName: "ExactMatch", score, reasoning: score === 1.0 ? "Exact match" : "No match" };
    },
  };
}

/** Scores as fraction of required keywords found in response (case-insensitive). */
export function contains(keywords: string[]): Evaluator {
  return {
    name: "Contains",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      const lower = input.response.toLowerCase();
      const found = keywords.filter((kw) => lower.includes(kw.toLowerCase()));
      const score = keywords.length > 0 ? found.length / keywords.length : 1.0;
      return {
        evaluatorName: "Contains",
        score,
        reasoning: `Found ${found.length}/${keywords.length} keywords`,
        metadata: { found, missing: keywords.filter((kw) => !lower.includes(kw.toLowerCase())) },
      };
    },
  };
}

/** Scores 1.0 if the response is valid JSON. */
export function jsonValid(): Evaluator {
  return {
    name: "JsonValid",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      try {
        JSON.parse(input.response);
        return { evaluatorName: "JsonValid", score: 1.0, reasoning: "Valid JSON" };
      } catch {
        return { evaluatorName: "JsonValid", score: 0.0, reasoning: "Invalid JSON" };
      }
    },
  };
}

/** Scores 1.0 if the response matches the given regex pattern. */
export function regexMatch(pattern: RegExp): Evaluator {
  return {
    name: "RegexMatch",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      const matches = pattern.test(input.response);
      return {
        evaluatorName: "RegexMatch",
        score: matches ? 1.0 : 0.0,
        reasoning: matches ? "Pattern matched" : "Pattern did not match",
      };
    },
  };
}

/** Scores based on cosine similarity between response and expectedOutput embeddings. */
export function cosineSimilarity(embeddingService: EmbeddingService): Evaluator {
  return {
    name: "CosineSimilarity",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      if (!input.expectedOutput) {
        return { evaluatorName: "CosineSimilarity", score: 0.0, reasoning: "No expected output" };
      }

      const [responseVec, expectedVec] = await Promise.all([
        embeddingService.embed(input.response),
        embeddingService.embed(input.expectedOutput),
      ]);

      const score = cosine(responseVec, expectedVec);
      return { evaluatorName: "CosineSimilarity", score, reasoning: `Cosine similarity: ${score.toFixed(4)}` };
    },
  };
}

/** LLM-as-a-judge evaluator with a custom grading rubric. */
export function llmJudge(llm: LLMService, rubric: string): Evaluator {
  return {
    name: "LLMJudge",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      const prompt = [
        ChatMessage.system(
          `You are an expert evaluator. Grade the following response according to this rubric:\n\n` +
          `${rubric}\n\n` +
          `Question: ${input.question}\n` +
          (input.expectedOutput ? `Expected: ${input.expectedOutput}\n` : "") +
          (input.context ? `Context: ${input.context}\n` : "") +
          `\nRespond with JSON: {"score": <0.0-1.0>, "reasoning": "..."}`,
        ),
        ChatMessage.user(input.response),
      ];

      const result = await llm.chatJson<{ score: number; reasoning: string }>(prompt);
      return {
        evaluatorName: "LLMJudge",
        score: Math.max(0, Math.min(1, result.score)),
        reasoning: result.reasoning,
      };
    },
  };
}

/** Scores 1.0 if response length is within limit, scales down linearly beyond. */
export function lengthCheck(maxLength: number): Evaluator {
  return {
    name: "LengthCheck",
    async evaluate(input: EvalInput): Promise<EvalScore> {
      if (input.response.length <= maxLength) {
        return { evaluatorName: "LengthCheck", score: 1.0, reasoning: "Within length limit" };
      }
      const score = Math.max(0, maxLength / input.response.length);
      return {
        evaluatorName: "LengthCheck",
        score,
        reasoning: `Response length ${input.response.length} exceeds limit ${maxLength}`,
      };
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
