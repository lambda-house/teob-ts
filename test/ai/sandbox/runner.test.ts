import { describe, it, expect } from "vitest";
import { SandboxBuilder } from "../../../src/ai/sandbox/runner.js";
import type { LLMService } from "../../../src/ai/llm/llm-service.js";
import type { MCPToolRegistry } from "../../../src/ai/tool/mcp-tool-registry.js";
import { withDefaults } from "../../../src/ai/llm/llm-service.js";
import { ToolUsageEvaluator, OutcomeEvaluator } from "../../../src/ai/sandbox/evaluators/index.js";
import type { AgentLoop } from "../../../src/ai/sandbox/runner.js";
import type { Scenario } from "../../../src/ai/sandbox/scenario.js";

function stubLLM(): LLMService {
  return withDefaults({
    async chat() {
      return "ok";
    },
    async chatJson() {
      return {} as any;
    },
    async chatWithTools() {
      return { tag: "Content", text: "ok" } as any;
    },
  });
}

function stubTools(): MCPToolRegistry {
  return {
    register() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    getDefinitions() {
      return [];
    },
    async execute() {
      return { success: true, output: null };
    },
    async executeAll() {
      return [];
    },
  };
}

const config = { model: "gpt", provider: "openai", temperature: 0, maxTokens: 100 };

describe("SandboxRunner — Live mode", () => {
  it("runs agent loop and produces a scored recording", async () => {
    const loop: AgentLoop = {
      async run(llm, tools, instruction) {
        await llm.chat([{ role: "user", content: instruction }]);
        await tools.execute({ name: "search", arguments: { q: "x" } });
        return { finalState: { done: true } };
      },
    };
    const runner = new SandboxBuilder()
      .withAgentLoop(loop)
      .withLLM(stubLLM())
      .withTools(stubTools())
      .withConfig(config)
      .addEvaluator(OutcomeEvaluator())
      .build();
    const scenario: Scenario = {
      id: "s1",
      name: "test",
      instruction: "do the thing",
      expectedOutcome: { finalStatePredicate: (s) => (s as { done: boolean }).done },
    };
    const result = await runner.runScenario(scenario, { kind: "live" });
    expect(result.recording.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].score).toBe(1);
  });
});

describe("SandboxRunner — Replay mode", () => {
  it("reproduces a previous recording deterministically", async () => {
    let invocations = 0;
    const loop: AgentLoop = {
      async run(llm, tools) {
        invocations += 1;
        await llm.chat([{ role: "user", content: "hi" }]);
        await tools.execute({ name: "search", arguments: { q: "x" } });
        return { finalState: { done: true } };
      },
    };
    const runner = new SandboxBuilder()
      .withAgentLoop(loop)
      .withLLM(stubLLM())
      .withTools(stubTools())
      .withConfig(config)
      .addEvaluator(OutcomeEvaluator())
      .build();
    const scenario: Scenario = {
      id: "s1",
      name: "test",
      instruction: "do it",
      expectedOutcome: { finalStatePredicate: (s) => (s as { done: boolean }).done },
    };
    const live = await runner.runScenario(scenario, { kind: "live" });
    expect(invocations).toBe(1);

    const replay = await runner.runScenario(scenario, { kind: "replay", recording: live.recording });
    expect(invocations).toBe(2);
    expect(replay.recording.metrics.totalToolCalls).toBe(live.recording.metrics.totalToolCalls);
    expect(replay.recording.metrics.totalLLMCalls).toBe(live.recording.metrics.totalLLMCalls);
  });
});

describe("SandboxRunner — Simulated mode", () => {
  it("uses scenario.toolSimulations for tool calls", async () => {
    const loop: AgentLoop = {
      async run(_llm, tools) {
        const r = await tools.execute({ name: "lookup", arguments: { id: 1 } });
        return { finalState: r.output };
      },
    };
    const runner = new SandboxBuilder()
      .withAgentLoop(loop)
      .withLLM(stubLLM())
      .withConfig(config)
      .addEvaluator(ToolUsageEvaluator())
      .build();
    const scenario: Scenario = {
      id: "s2",
      name: "sim",
      instruction: "go",
      toolSimulations: new Map([
        ["lookup", () => ({ success: true, output: "fake" })],
      ]),
    };
    const result = await runner.runScenario(scenario, { kind: "simulated" });
    expect(result.recording.finalState).toBe("fake");
  });
});

describe("SandboxRunner — runBenchmark", () => {
  it("aggregates scores across scenarios", async () => {
    const loop: AgentLoop = {
      async run(_l, _t, instruction) {
        return { finalState: { instruction } };
      },
    };
    const runner = new SandboxBuilder()
      .withAgentLoop(loop)
      .withLLM(stubLLM())
      .withTools(stubTools())
      .withConfig(config)
      .addEvaluator(OutcomeEvaluator())
      .build();
    const r = await runner.runBenchmark(
      [
        { id: "a", name: "a", instruction: "x" },
        { id: "b", name: "b", instruction: "y" },
      ],
      { kind: "live" },
    );
    expect(r.results).toHaveLength(2);
    expect(r.aggregateScores.has("outcome")).toBe(true);
    expect(r.finalScore).toBe(1);
  });
});
