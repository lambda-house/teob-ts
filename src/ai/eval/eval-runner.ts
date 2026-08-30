import type {
  AggregateScore,
  EvalDataset,
  EvalInput,
  EvalReport,
  EvalResult,
  EvalScore,
  Evaluator,
} from "./types.js";

/**
 * Evaluate a single sample against a list of evaluators.
 */
export async function evaluateSample(
  sampleId: string,
  input: EvalInput,
  evaluators: Evaluator[],
): Promise<EvalResult> {
  const scores: EvalScore[] = [];
  for (const evaluator of evaluators) {
    scores.push(await evaluator.evaluate(input));
  }
  return { sampleId, scores };
}

/**
 * Evaluate a full dataset. Calls responseFn for each sample to get the LLM response,
 * then runs all evaluators against each response.
 */
export async function evaluateDataset(
  dataset: EvalDataset,
  responseFn: (prompt: string, context?: string) => Promise<string>,
  evaluators: Evaluator[],
): Promise<EvalReport> {
  const results: EvalResult[] = [];

  for (const sample of dataset.samples) {
    const response = await responseFn(sample.prompt, sample.context);
    const input: EvalInput = {
      question: sample.prompt,
      response,
      expectedOutput: sample.expectedOutput,
      context: sample.context,
    };
    results.push(await evaluateSample(sample.id, input, evaluators));
  }

  const aggregates = computeAggregates(evaluators, results);
  return {
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    results,
    aggregates,
  };
}

function computeAggregates(evaluators: Evaluator[], results: EvalResult[]): AggregateScore[] {
  return evaluators.map((evaluator) => {
    const scores = results
      .flatMap((r) => r.scores)
      .filter((s) => s.evaluatorName === evaluator.name)
      .map((s) => s.score);

    if (scores.length === 0) {
      return { evaluatorName: evaluator.name, mean: 0, min: 0, max: 0, stddev: 0, count: 0 };
    }

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
    const stddev = Math.sqrt(variance);

    return { evaluatorName: evaluator.name, mean, min, max, stddev, count: scores.length };
  });
}
