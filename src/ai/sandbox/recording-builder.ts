import type {
  AgentRunRecording,
  RecordedInteraction,
  RecordedLLMCall,
  RecordedToolExec,
  RecordingConfig,
  RunMetrics,
} from "./types.js";

export interface RecordingBuilderInit {
  runId: string;
  config: RecordingConfig;
  startedAt: string;
  scenario?: string;
}

/**
 * RecordingBuilder — composable construction of an AgentRunRecording.
 *
 * Auto-derives RunMetrics from `steps` at build time unless an explicit
 * metrics override has been set.
 */
export class RecordingBuilder {
  private steps: RecordedInteraction[] = [];
  private finalState: unknown = undefined;
  private completedAt: string | undefined;
  private metricsOverride: RunMetrics | undefined;

  private constructor(private readonly init: RecordingBuilderInit) {}

  static create(init: RecordingBuilderInit): RecordingBuilder {
    return new RecordingBuilder(init);
  }

  addLLMCall(step: Omit<RecordedLLMCall, "type"> & { type?: "llmcall" }): this {
    this.steps.push({ ...step, type: "llmcall" });
    return this;
  }

  addToolExec(step: Omit<RecordedToolExec, "type"> & { type?: "toolexec" }): this {
    this.steps.push({ ...step, type: "toolexec" });
    return this;
  }

  addStep(step: RecordedInteraction): this {
    this.steps.push(step);
    return this;
  }

  withFinalState(state: unknown): this {
    this.finalState = state;
    return this;
  }

  withCompletedAt(iso: string): this {
    this.completedAt = iso;
    return this;
  }

  withMetrics(m: RunMetrics): this {
    this.metricsOverride = m;
    return this;
  }

  build(): AgentRunRecording {
    const sorted = [...this.steps];
    sortChronologically(sorted);
    return {
      runId: this.init.runId,
      scenario: this.init.scenario,
      config: this.init.config,
      steps: sorted,
      metrics: this.metricsOverride ?? deriveMetrics(sorted),
      finalState: this.finalState,
      startedAt: this.init.startedAt,
      completedAt: this.completedAt,
    };
  }
}

export function deriveMetrics(steps: RecordedInteraction[]): RunMetrics {
  let totalLLMCalls = 0;
  let totalToolCalls = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;
  let totalCostUsd: number | undefined;
  for (const step of steps) {
    if (step.type === "llmcall") {
      totalLLMCalls += 1;
      totalTokens += step.meta.usage.totalTokens ?? 0;
      totalLatencyMs += step.meta.latencyMs ?? 0;
      if (step.meta.cost !== undefined) {
        totalCostUsd = (totalCostUsd ?? 0) + step.meta.cost.totalCostUsd;
      }
    } else {
      totalToolCalls += 1;
      totalLatencyMs += step.latencyMs;
    }
  }
  return { totalLLMCalls, totalToolCalls, totalTokens, totalLatencyMs, totalCostUsd };
}

function sortChronologically(steps: RecordedInteraction[]): void {
  // Stable sort: items without a timestamp keep their relative order.
  const indexed = steps.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const ta = a.s.completedAt;
    const tb = b.s.completedAt;
    if (!ta && !tb) return a.i - b.i;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
  });
  for (let i = 0; i < indexed.length; i++) steps[i] = indexed[i].s;
}
