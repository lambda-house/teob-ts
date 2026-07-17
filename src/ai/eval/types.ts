/** Input for an evaluation. */
export interface EvalInput {
  question: string;
  response: string;
  expectedOutput?: string;
  context?: string;
}

/** Score from a single evaluator. */
export interface EvalScore {
  evaluatorName: string;
  /** Score between 0.0 and 1.0. */
  score: number;
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

/** A single evaluator that scores LLM output. */
export interface Evaluator {
  readonly name: string;
  evaluate(input: EvalInput): Promise<EvalScore>;
}

/** A test sample in an evaluation dataset. */
export interface EvalSample {
  id: string;
  prompt: string;
  expectedOutput?: string;
  context?: string;
}

/** A versioned collection of evaluation samples. */
export interface EvalDataset {
  name: string;
  version: string;
  samples: EvalSample[];
}

/** Result of evaluating a single sample. */
export interface EvalResult {
  sampleId: string;
  scores: EvalScore[];
}

/** Aggregate statistics for an evaluator across a dataset. */
export interface AggregateScore {
  evaluatorName: string;
  mean: number;
  min: number;
  max: number;
  stddev: number;
  count: number;
}

/** Full evaluation report for a dataset. */
export interface EvalReport {
  datasetName: string;
  datasetVersion: string;
  results: EvalResult[];
  aggregates: AggregateScore[];
}
