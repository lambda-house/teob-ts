import type { LLMService } from "../llm/llm-service.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type { AgentRunRecording, AgentOutcome, RecordingConfig, SandboxMode } from "./types.js";
import type { Scenario } from "./scenario.js";
import type { RunEvaluator, EvalScore } from "./evaluator.js";
import { RecordingLLMService } from "./recording-llm-service.js";
import { RecordingToolRegistry } from "./recording-tool-registry.js";
import { ReplayLLMService } from "./replay-llm-service.js";
import { ReplayToolRegistry } from "./replay-tool-registry.js";
import { SimulatedToolRegistry } from "./simulated-tool-registry.js";
import { RecordingBuilder } from "./recording-builder.js";

export interface AgentLoop {
  run(
    llm: LLMService,
    tools: MCPToolRegistry,
    instruction: string,
  ): Promise<{ finalState: unknown; outcome?: AgentOutcome }>;
}

export interface SandboxResult {
  runId: string;
  scenarioId?: string;
  recording: AgentRunRecording;
  scores: EvalScore[];
  outcome?: AgentOutcome;
  timestamp: string;
}

export interface AggregateScore {
  evaluatorName: string;
  mean: number;
  min: number;
  max: number;
  count: number;
}

export interface BenchmarkReport {
  results: SandboxResult[];
  aggregateScores: Map<string, AggregateScore>;
  finalScore: number;
  timestamp: string;
}

export interface SandboxRunner {
  runScenario(s: Scenario, mode: SandboxMode): Promise<SandboxResult>;
  runBenchmark(scenarios: Scenario[], mode: SandboxMode): Promise<BenchmarkReport>;
}

export interface SandboxBuilderConfig {
  agentLoop?: AgentLoop;
  llm?: LLMService;
  tools?: MCPToolRegistry;
  evaluators: RunEvaluator[];
  recordingConfig?: RecordingConfig;
}

export class SandboxBuilder {
  private cfg: SandboxBuilderConfig = { evaluators: [] };

  withAgentLoop(loop: AgentLoop): this {
    this.cfg.agentLoop = loop;
    return this;
  }
  withLLM(svc: LLMService): this {
    this.cfg.llm = svc;
    return this;
  }
  withTools(reg: MCPToolRegistry): this {
    this.cfg.tools = reg;
    return this;
  }
  addEvaluator(e: RunEvaluator): this {
    this.cfg.evaluators.push(e);
    return this;
  }
  withConfig(c: RecordingConfig): this {
    this.cfg.recordingConfig = c;
    return this;
  }

  build(): SandboxRunner {
    const cfg = this.cfg;
    if (!cfg.agentLoop) throw new Error("SandboxBuilder: agentLoop required");
    if (!cfg.recordingConfig) throw new Error("SandboxBuilder: recordingConfig required");
    return makeRunner(cfg as Required<SandboxBuilderConfig> & { llm?: LLMService; tools?: MCPToolRegistry });
  }
}

function makeRunner(cfg: SandboxBuilderConfig): SandboxRunner {
  let runIdCounter = 0;
  function genRunId(prefix: string): string {
    runIdCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${runIdCounter.toString(36)}`;
  }

  async function runScenario(s: Scenario, mode: SandboxMode): Promise<SandboxResult> {
    const runId = genRunId(s.id);
    const startedAt = new Date().toISOString();
    let llm: LLMService;
    let tools: MCPToolRegistry;
    let recordingLLM: RecordingLLMService;
    let recordingTools: RecordingToolRegistry;

    switch (mode.kind) {
      case "live": {
        if (!cfg.llm) throw new Error("Live mode requires withLLM(...)");
        if (!cfg.tools) throw new Error("Live mode requires withTools(...)");
        recordingLLM = new RecordingLLMService(cfg.llm);
        recordingTools = new RecordingToolRegistry(cfg.tools);
        llm = recordingLLM;
        tools = recordingTools;
        break;
      }
      case "replay": {
        const replayLLM = ReplayLLMService.from(mode.recording);
        const replayTools = ReplayToolRegistry.from(mode.recording);
        recordingLLM = new RecordingLLMService(replayLLM);
        recordingTools = new RecordingToolRegistry(replayTools);
        llm = recordingLLM;
        tools = recordingTools;
        break;
      }
      case "simulated": {
        if (!cfg.llm) throw new Error("Simulated mode requires withLLM(...)");
        const simulated = SimulatedToolRegistry.fromScenario(s);
        recordingLLM = new RecordingLLMService(cfg.llm);
        recordingTools = new RecordingToolRegistry(simulated);
        llm = recordingLLM;
        tools = recordingTools;
        break;
      }
    }

    const { finalState, outcome } = await cfg.agentLoop!.run(llm, tools, s.instruction);
    const completedAt = new Date().toISOString();

    const builder = RecordingBuilder.create({
      runId,
      config: cfg.recordingConfig!,
      startedAt,
      scenario: s.id,
    })
      .withFinalState(finalState)
      .withCompletedAt(completedAt);

    for (const c of await recordingLLM.getRecordedCalls()) builder.addStep(c);
    for (const e of await recordingTools.getRecordedExecs()) builder.addStep(e);

    const recording = builder.build();

    const scores: EvalScore[] = [];
    for (const ev of cfg.evaluators) {
      scores.push(await ev.evaluate(recording, s.expectedOutcome));
    }

    return { runId, scenarioId: s.id, recording, scores, outcome, timestamp: completedAt };
  }

  async function runBenchmark(scenarios: Scenario[], mode: SandboxMode): Promise<BenchmarkReport> {
    const results: SandboxResult[] = [];
    for (const s of scenarios) results.push(await runScenario(s, mode));
    const aggregateScores = aggregateScoresOf(results);
    const finalScore = computeFinalScore(results);
    return {
      results,
      aggregateScores,
      finalScore,
      timestamp: new Date().toISOString(),
    };
  }

  return { runScenario, runBenchmark };
}

function aggregateScoresOf(results: SandboxResult[]): Map<string, AggregateScore> {
  const buckets = new Map<string, number[]>();
  for (const r of results) {
    for (const s of r.scores) {
      if (!buckets.has(s.evaluatorName)) buckets.set(s.evaluatorName, []);
      buckets.get(s.evaluatorName)!.push(s.score);
    }
  }
  const out = new Map<string, AggregateScore>();
  for (const [name, vals] of buckets) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    out.set(name, { evaluatorName: name, mean, min, max, count: vals.length });
  }
  return out;
}

function computeFinalScore(results: SandboxResult[]): number {
  const vals: number[] = [];
  for (const r of results) for (const s of r.scores) vals.push(s.score);
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
