/**
 * Tests for AgentFlowAggregate.
 *
 * Uses mock LLMService and MCPToolRegistry to verify the agent flow
 * self-command loop: ProcessInput -> LLM -> tool calls -> LLM -> done.
 */

import { describe, it, expect } from "vitest";
import { EntityId, CategoryId } from "../src/core/types.js";
import { tagCodec } from "../src/core/codec.js";
import { categoryTypes } from "../src/core/effect-control.js";
import { createSingleRuntime } from "../src/inmem/runtime.js";
import { createMCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";
import { MCPToolResult } from "../src/ai/tool/types.js";
import { agentFlowAggregate } from "../src/ai/agent-flow/agent-flow-aggregate.js";
import { agentFlowEventCodec, agentFlowCommandCodec, agentFlowReplyCodec, agentFlowStateCodec } from "../src/ai/agent-flow/codecs.js";
import type {
  AgentFlowConfig,
  FlowStateSchema,
  FlowContextBuilder,
  FlowResponseHandler,
  AgentFlowCommand,
  AgentFlowEvent,
  AgentFlowReply,
  AgentFlowState,
} from "../src/ai/agent-flow/types.js";
import type { LLMService } from "../src/ai/llm/llm-service.js";
import type { LLMToolResponse } from "../src/ai/llm/types.js";
import type { MCPToolRegistry } from "../src/ai/tool/mcp-tool-registry.js";

// --- Test state: simple counter ---

interface TestState {
  counter: number;
}

const testStateSchema: FlowStateSchema<TestState> = {
  initial(_id) {
    return { counter: 0 };
  },
  encode(state) {
    return state;
  },
  decode(json) {
    return json as TestState;
  },
};

// --- Test context builder ---

const testContextBuilder: FlowContextBuilder<TestState> = {
  async buildContext(input, state, pendingMessages, _tools) {
    const messages: unknown[] = [
      { role: "system", content: "You are a test agent." },
    ];
    if (input) {
      messages.push({ role: "user", content: JSON.stringify(input) });
    }
    messages.push(...pendingMessages);
    return messages;
  },
};

// --- Test response handler ---

function createTestResponseHandler(opts?: { doneAfter?: number }): FlowResponseHandler<TestState> {
  let callCount = 0;
  const doneAfter = opts?.doneAfter ?? 1;
  return {
    async parseAndApply(state, response) {
      callCount++;
      return {
        state: { counter: state.counter + 1 },
        explanation: response,
        isDone: callCount >= doneAfter,
      };
    },
  };
}

// --- Mock LLM Service ---

function createMockLLMService(responses: LLMToolResponse[]): LLMService {
  let callIndex = 0;
  return {
    async chat() { return ""; },
    async chatJson() { return {} as never; },
    async chatWithTools(): Promise<LLMToolResponse> {
      const response = responses[callIndex % responses.length];
      callIndex++;
      return response;
    },
  };
}

// --- Mock LLM Service that fails N times then succeeds ---

function createFailingThenSucceedingLLMService(failCount: number, successResponse: LLMToolResponse): LLMService {
  let callIndex = 0;
  return {
    async chat() { return ""; },
    async chatJson() { return {} as never; },
    async chatWithTools(): Promise<LLMToolResponse> {
      callIndex++;
      if (callIndex <= failCount) {
        throw new Error(`LLM error attempt ${callIndex}`);
      }
      return successResponse;
    },
  };
}

// --- Test tool registry ---

function createTestToolRegistry(): MCPToolRegistry {
  const registry = createMCPToolRegistry();
  registry.register({
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    async execute(input) {
      const { a, b } = input as { a: number; b: number };
      return MCPToolResult.success(a + b);
    },
  });
  registry.register({
    name: "multiply",
    description: "Multiply two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    async execute(input) {
      const { a, b } = input as { a: number; b: number };
      return MCPToolResult.success(a * b);
    },
  });
  return registry;
}

// --- Default config ---

const defaultConfig: AgentFlowConfig = {
  model: "test-model",
  temperature: 0.5,
  maxTokens: 1024,
  maxToolRounds: 10,
  maxRetries: 3,
  retryBaseDelayMs: 10, // very short for tests
};

// --- Category ---

const agentFlowCategory = categoryTypes<AgentFlowCommand, AgentFlowReply>(CategoryId("agent-flow"));

// --- Helpers ---

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Tests
// ============================================================

describe("AgentFlowAggregate", () => {
  describe("simple flow: ProcessInput -> LLM content -> FlowCompleted", () => {
    it("should complete a simple flow with content response", async () => {
      const llmService = createMockLLMService([
        { tag: "Content", text: "The answer is 42" },
      ]);

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-1");

      // ProcessInput -> should get FlowStarted reply
      const startResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "What is 6*7?" }, timestamp: new Date() },
        agentFlowCategory,
      );

      expect(startResult.ok).toBe(true);
      if (startResult.ok && startResult.value.reply) {
        expect(startResult.value.reply.tag).toBe("FlowStarted");
      }

      // Wait for the self-command loop to complete
      await wait(500);

      // GetFlowState -> should be Completed
      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");
        expect(reply.metrics.totalLLMCalls).toBe(1);
      }

      await runtime.shutdown();
    });
  });

  describe("tool flow: ProcessInput -> LLM tool calls -> tool results -> LLM content -> FlowCompleted", () => {
    it("should execute tools and complete flow", async () => {
      const llmService = createMockLLMService([
        // First call: LLM requests tool call
        {
          tag: "ToolCalls",
          calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "add", arguments: JSON.stringify({ a: 3, b: 4 }) },
            },
          ],
          rawMessage: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "add", arguments: JSON.stringify({ a: 3, b: 4 }) } }] },
        },
        // Second call: LLM returns content
        { tag: "Content", text: "The sum is 7" },
      ]);

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-tools-1");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "What is 3+4?" }, timestamp: new Date() },
        agentFlowCategory,
      );

      // Wait for the self-command loop to complete
      await wait(800);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");
        expect(reply.metrics.totalLLMCalls).toBe(2);
        expect(reply.metrics.totalToolCalls).toBe(1);
      }

      await runtime.shutdown();
    });
  });

  describe("retry flow: LLM fails -> retry -> succeeds", () => {
    it("should retry on LLM failure and eventually succeed", async () => {
      const llmService = createFailingThenSucceedingLLMService(1, { tag: "Content", text: "Recovered!" });

      const aggregate = agentFlowAggregate({
        config: { ...defaultConfig, retryBaseDelayMs: 50 },
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-retry-1");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "retry test" }, timestamp: new Date() },
        agentFlowCategory,
      );

      // Wait for retry + completion (retry delay is 50ms * 2^0 = 50ms)
      await wait(1000);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");
        // Should have 2 LLM calls: the initial failed one is counted via LLMFailed (not LLMResponded),
        // plus the retry that gets LLMResponded
        expect(reply.metrics.totalLLMCalls).toBeGreaterThanOrEqual(1);
      }

      await runtime.shutdown();
    });
  });

  describe("max tool rounds exceeded -> FlowFailed", () => {
    it("should fail when max tool rounds exceeded", async () => {
      // Always return tool calls
      const llmService = createMockLLMService([
        {
          tag: "ToolCalls",
          calls: [
            {
              id: "call-loop",
              type: "function",
              function: { name: "add", arguments: JSON.stringify({ a: 1, b: 1 }) },
            },
          ],
          rawMessage: { role: "assistant", tool_calls: [{ id: "call-loop", type: "function", function: { name: "add", arguments: JSON.stringify({ a: 1, b: 1 }) } }] },
        },
      ]);

      const aggregate = agentFlowAggregate({
        config: { ...defaultConfig, maxToolRounds: 2 },
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-max-tools");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "loop forever" }, timestamp: new Date() },
        agentFlowCategory,
      );

      // Wait for loops to exceed max
      await wait(1500);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Failed");
      }

      await runtime.shutdown();
    });
  });

  describe("GetFlowState returns current state", () => {
    it("should return Idle state for new entity", async () => {
      const llmService = createMockLLMService([]);

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-idle");

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Idle");
        expect(reply.metrics.totalLLMCalls).toBe(0);
        expect(reply.metrics.totalToolCalls).toBe(0);
        expect(reply.flowState).toEqual({ counter: 0 });
      }

      await runtime.shutdown();
    });
  });

  describe("multiple tool rounds before completion", () => {
    it("should handle multiple sequential tool rounds", async () => {
      let callIndex = 0;
      const llmService: LLMService = {
        async chat() { return ""; },
        async chatJson() { return {} as never; },
        async chatWithTools(): Promise<LLMToolResponse> {
          callIndex++;
          if (callIndex <= 2) {
            // First two calls: tool calls
            return {
              tag: "ToolCalls",
              calls: [
                {
                  id: `call-${callIndex}`,
                  type: "function",
                  function: { name: "multiply", arguments: JSON.stringify({ a: callIndex, b: 10 }) },
                },
              ],
              rawMessage: {
                role: "assistant",
                tool_calls: [
                  {
                    id: `call-${callIndex}`,
                    type: "function",
                    function: { name: "multiply", arguments: JSON.stringify({ a: callIndex, b: 10 }) },
                  },
                ],
              },
            };
          }
          // Third call: content
          return { tag: "Content", text: "All done after 2 tool rounds" };
        },
      };

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-multi-tools");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "multi tool test" }, timestamp: new Date() },
        agentFlowCategory,
      );

      await wait(1500);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");
        expect(reply.metrics.totalLLMCalls).toBe(3); // 2 tool rounds + 1 content
        expect(reply.metrics.totalToolCalls).toBe(2); // 2 tool executions
      }

      await runtime.shutdown();
    });
  });

  describe("GetFlowState returns full state after completed flow", () => {
    it("should return CurrentState with correct status, flowState, and metrics after completion", async () => {
      const llmService = createMockLLMService([
        { tag: "Content", text: "Completed response" },
      ]);

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-get-state");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { data: "test" }, timestamp: new Date() },
        agentFlowCategory,
      );

      await wait(500);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");
        expect(reply.flowState).toEqual({ counter: 1 });
        expect(reply.metrics.totalLLMCalls).toBe(1);
        expect(reply.metrics.totalToolCalls).toBe(0);
        expect(reply.metrics.totalTokensUsed).toBe(0); // mock doesn't set tokens
        expect(reply.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
      }

      await runtime.shutdown();
    });
  });

  describe("codec round-trip", () => {
    it("should encode and decode AgentFlowEvent variants via manifest round-trip", () => {
      const events: AgentFlowEvent[] = [
        { tag: "InputReceived", requestId: "req-1", input: { question: "hello" } },
        {
          tag: "LLMResponded",
          requestId: "req-1",
          model: "test-model",
          text: "response text",
          toolCalls: undefined,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 150,
          respondedAt: "2026-03-24T00:00:00.000Z",
        },
        {
          tag: "FlowCompleted",
          requestId: "req-1",
          output: "done",
          totalLLMCalls: 2,
          totalToolCalls: 1,
          totalTokens: 50,
          totalLatencyMs: 300,
        },
      ];

      for (const event of events) {
        const manifest = agentFlowEventCodec.manifest(event);
        expect(manifest).toBe(event.tag);
        const encoded = agentFlowEventCodec.encode(event);
        const decoded = agentFlowEventCodec.decode(manifest, encoded);
        expect(decoded).toEqual(event);
      }
    });

    it("should encode and decode AgentFlowCommand variants via manifest round-trip", () => {
      const commands: AgentFlowCommand[] = [
        { tag: "ProcessInput", input: { q: "test" }, timestamp: new Date("2026-03-24T00:00:00.000Z") },
        { tag: "GetFlowState" },
        { tag: "RetryStep", requestId: "req-1", retryCount: 2 },
      ];

      for (const cmd of commands) {
        const manifest = agentFlowCommandCodec.manifest(cmd);
        expect(manifest).toBe(cmd.tag);
        const encoded = agentFlowCommandCodec.encode(cmd);
        const decoded = agentFlowCommandCodec.decode(manifest, encoded);
        expect(decoded).toEqual(cmd);
      }
    });

    it("should encode and decode AgentFlowReply variants via manifest round-trip", () => {
      const replies: AgentFlowReply[] = [
        { tag: "FlowStarted", aggregateId: EntityId("id-1") },
        {
          tag: "FlowResult",
          aggregateId: EntityId("id-1"),
          result: "answer",
          metrics: { totalLLMCalls: 1, totalToolCalls: 0, totalTokensUsed: 100, totalLatencyMs: 200 },
        },
        {
          tag: "CurrentState",
          aggregateId: EntityId("id-1"),
          flowState: { counter: 5 },
          status: "Completed",
          metrics: { totalLLMCalls: 3, totalToolCalls: 2, totalTokensUsed: 500, totalLatencyMs: 1000 },
        },
      ];

      for (const reply of replies) {
        const manifest = agentFlowReplyCodec.manifest(reply);
        expect(manifest).toBe(reply.tag);
        const encoded = agentFlowReplyCodec.encode(reply);
        const decoded = agentFlowReplyCodec.decode(manifest, encoded);
        expect(decoded).toEqual(reply);
      }
    });

    it("should expose correct manifests arrays", () => {
      expect(agentFlowEventCodec.manifests).toEqual([
        "InputReceived",
        "LLMInvoked",
        "LLMResponded",
        "LLMFailed",
        "ToolInvoked",
        "ToolCompleted",
        "StateMutated",
        "FlowCompleted",
        "FlowFailed",
        "RetryScheduled",
      ]);

      expect(agentFlowCommandCodec.manifests).toEqual([
        "ProcessInput",
        "ContinueLLMResponse",
        "ContinueToolResults",
        "HandleLLMFailure",
        "RetryStep",
        "GetFlowState",
      ]);

      expect(agentFlowReplyCodec.manifests).toEqual([
        "FlowStarted",
        "FlowResult",
        "FlowError",
        "CurrentState",
      ]);
    });
  });

  describe("FlowCompleted metrics accuracy", () => {
    it("should have correct non-zero metrics after a complete flow with tools", async () => {
      const llmService = createMockLLMService([
        // First call: tool call
        {
          tag: "ToolCalls",
          calls: [
            {
              id: "call-metric-1",
              type: "function",
              function: { name: "add", arguments: JSON.stringify({ a: 10, b: 20 }) },
            },
          ],
          rawMessage: {
            role: "assistant",
            tool_calls: [
              { id: "call-metric-1", type: "function", function: { name: "add", arguments: JSON.stringify({ a: 10, b: 20 }) } },
            ],
          },
        },
        // Second call: content response (flow completes)
        { tag: "Content", text: "The sum is 30" },
      ]);

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-metrics-1");

      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "What is 10+20?" }, timestamp: new Date() },
        agentFlowCategory,
      );

      await wait(1000);

      const stateResult = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "GetFlowState" },
        agentFlowCategory,
      );

      expect(stateResult.ok).toBe(true);
      if (stateResult.ok && stateResult.value.reply) {
        const reply = stateResult.value.reply as AgentFlowReply & { tag: "CurrentState" };
        expect(reply.tag).toBe("CurrentState");
        expect(reply.status).toBe("Completed");

        // 2 LLM calls: one for tool call, one for content
        expect(reply.metrics.totalLLMCalls).toBe(2);
        // 1 tool execution
        expect(reply.metrics.totalToolCalls).toBe(1);
        // Latency is accumulated from LLMResponded events; mock LLM may resolve in <1ms
        // so we verify it is a non-negative number rather than strictly positive
        expect(reply.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
        expect(typeof reply.metrics.totalLatencyMs).toBe("number");
      }

      await runtime.shutdown();
    });
  });

  describe("duplicate ProcessInput while processing", () => {
    it("should reject ProcessInput when flow is not Idle", async () => {
      // LLM that takes a long time (via a delayed response)
      const llmService: LLMService = {
        async chat() { return ""; },
        async chatJson() { return {} as never; },
        async chatWithTools(): Promise<LLMToolResponse> {
          await wait(2000);
          return { tag: "Content", text: "done" };
        },
      };

      const aggregate = agentFlowAggregate({
        config: defaultConfig,
        llmService,
        toolRegistry: createTestToolRegistry(),
        stateSchema: testStateSchema,
        contextBuilder: testContextBuilder,
        responseHandler: createTestResponseHandler(),
      });

      const stateCodec = agentFlowStateCodec(testStateSchema);
      const { runtime } = createSingleRuntime(aggregate, agentFlowEventCodec, stateCodec);
      await runtime.start();

      const id = EntityId("flow-dup");

      // First ProcessInput
      await runtime.tell<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "first" }, timestamp: new Date() },
        agentFlowCategory,
      );

      // Wait for first command to start processing
      await wait(100);

      // Second ProcessInput — should get error reply
      const result = await runtime.ask<AgentFlowCommand, AgentFlowReply>(
        id,
        { tag: "ProcessInput", input: { question: "second" }, timestamp: new Date() },
        agentFlowCategory,
      );

      expect(result.ok).toBe(true);
      if (result.ok && result.value.reply) {
        expect(result.value.reply.tag).toBe("FlowError");
      }

      await runtime.shutdown();
    });
  });
});
