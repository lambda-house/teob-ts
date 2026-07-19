/**
 * Agent Flow Aggregate — factory function that creates a TEOB Aggregate
 * for LLM-driven agent flows with tool execution and retry logic.
 *
 * Follows the self-command loop pattern from petrinet/flow-aggregate.ts:
 * side effects invoke the LLM or execute tools, then feed results back
 * via ctx.tellSelf().
 */

import { randomUUID } from "crypto";
import type { Aggregate } from "../../core/aggregate.js";
import type { EffectControl } from "../../core/effect-control.js";
import type { EntityId, CategoryId, TimerId } from "../../core/types.js";
import { CategoryId as CategoryIdOf, TimerId as TimerIdOf } from "../../core/types.js";
import type { Effect } from "../../core/effect.js";
import { persist, reply as replyEffect, done, andRun, andReply } from "../../core/effect.js";
import type { LLMService } from "../llm/llm-service.js";
import type { LLMToolResponse, ModelConfig } from "../llm/types.js";
import { llmTool } from "../llm/types.js";
import type { MCPToolRegistry } from "../tool/mcp-tool-registry.js";
import type {
  AgentFlowConfig,
  FlowStateSchema,
  FlowContextBuilder,
  FlowResponseHandler,
  AgentFlowCommand,
  AgentFlowEvent,
  AgentFlowReply,
  AgentFlowState,
  FlowMetrics,
  ToolExecutionResult,
} from "./types.js";

// --- Dependencies ---

export interface AgentFlowAggregateDeps<S> {
  config: AgentFlowConfig;
  llmService: LLMService;
  toolRegistry: MCPToolRegistry;
  stateSchema: FlowStateSchema<S>;
  contextBuilder: FlowContextBuilder<S>;
  responseHandler: FlowResponseHandler<S>;
  category?: string; // default "agent-flow"
}

// --- Helper: build metrics from state ---

function metricsFromState<S>(state: AgentFlowState<S>): FlowMetrics {
  return {
    totalLLMCalls: state.totalLLMCalls,
    totalToolCalls: state.totalToolCalls,
    totalTokensUsed: state.totalTokensUsed,
    totalLatencyMs: state.totalLatencyMs,
  };
}

// --- Helper: convert MCPToolDefinitions to LLMTools ---

function toolDefsToLLMTools(registry: MCPToolRegistry) {
  return registry.getDefinitions().map((d) => llmTool(d.name, d.description, d.inputSchema));
}

// --- Factory ---

export function agentFlowAggregate<S>(
  deps: AgentFlowAggregateDeps<S>,
): Aggregate<AgentFlowCommand, AgentFlowReply, AgentFlowEvent, AgentFlowState<S>> {
  const {
    config,
    llmService,
    toolRegistry,
    stateSchema,
    contextBuilder,
    responseHandler,
  } = deps;

  const category = CategoryIdOf(deps.category ?? "agent-flow") as CategoryId;
  const temperature = config.temperature ?? 0.7;
  const maxTokens = config.maxTokens ?? 4096;
  const maxToolRounds = config.maxToolRounds ?? 10;
  const maxRetries = config.maxRetries ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 5000;

  const modelConfig: ModelConfig = { temperature, maxTokens };

  /** Invoke the LLM and tellSelf the result or failure. */
  function invokeLLM(
    ctx: EffectControl<AgentFlowCommand, AgentFlowReply>,
    requestId: string,
    messages: unknown[],
    retryCount: number,
  ): () => Promise<void> {
    return async () => {
      const startMs = Date.now();
      try {
        const tools = toolDefsToLLMTools(toolRegistry);
        const response = await llmService.chatWithTools(
          messages,
          tools,
          responseHandler.responseSchema,
          modelConfig,
        );
        const latencyMs = Date.now() - startMs;
        await ctx.tellSelf({
          tag: "ContinueLLMResponse",
          requestId,
          response,
          promptTokens: 0, // not available from the interface — set to 0
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
        });
      } catch (err) {
        await ctx.tellSelf({
          tag: "HandleLLMFailure",
          requestId,
          error: err instanceof Error ? err.message : String(err),
          retryCount,
        });
      }
    };
  }

  return {
    category,

    initial(id: EntityId): AgentFlowState<S> {
      return {
        id,
        flowState: stateSchema.initial(id),
        status: "Idle",
        currentRequestId: undefined,
        pendingMessages: [],
        retryCount: 0,
        toolRoundCount: 0,
        totalLLMCalls: 0,
        totalToolCalls: 0,
        totalTokensUsed: 0,
        totalLatencyMs: 0,
        lastError: undefined,
      };
    },

    async decide(
      state: AgentFlowState<S>,
      command: AgentFlowCommand,
      ctx: EffectControl<AgentFlowCommand, AgentFlowReply>,
    ): Promise<Effect<AgentFlowEvent, AgentFlowReply>> {
      switch (command.tag) {
        // --- ProcessInput ---
        case "ProcessInput": {
          if (state.status !== "Idle") {
            return replyEffect<AgentFlowEvent, AgentFlowReply>({
              tag: "FlowError",
              aggregateId: state.id,
              error: `Cannot process input: flow is ${state.status}`,
              metrics: metricsFromState(state),
            });
          }

          const requestId = randomUUID();
          const toolDefs = toolRegistry.getDefinitions();
          const messages = await contextBuilder.buildContext(
            command.input,
            state.flowState,
            [],
            toolDefs,
          );

          const toolNames = toolDefs.map((d) => d.name);
          const now = new Date().toISOString();

          const events: AgentFlowEvent[] = [
            { tag: "InputReceived", requestId, input: command.input },
            {
              tag: "LLMInvoked",
              requestId,
              model: config.model,
              temperature,
              messagesJson: messages,
              tools: toolNames,
              responseSchema: responseHandler.responseSchema ?? null,
              requestedAt: now,
            },
          ];

          let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(...events);
          effect = andRun(effect, invokeLLM(ctx, requestId, messages, 0));
          effect = andReply(effect, { tag: "FlowStarted", aggregateId: state.id });
          return effect;
        }

        // --- ContinueLLMResponse ---
        case "ContinueLLMResponse": {
          const { requestId, response, promptTokens, completionTokens, totalTokens, latencyMs } = command;
          const now = new Date().toISOString();

          const respondedEvent: AgentFlowEvent = {
            tag: "LLMResponded",
            requestId,
            model: config.model,
            text: response.tag === "Content" ? response.text : undefined,
            toolCalls: response.tag === "ToolCalls" ? response.calls : undefined,
            promptTokens,
            completionTokens,
            totalTokens,
            latencyMs,
            respondedAt: now,
          };

          if (response.tag === "Content") {
            // Parse and apply the response to user state
            const parsed = await responseHandler.parseAndApply(state.flowState, response.text);
            const mutatedEvent: AgentFlowEvent = {
              tag: "StateMutated",
              requestId,
              flowStateJson: stateSchema.encode(parsed.state),
              mutatedAt: new Date().toISOString(),
            };

            if (parsed.isDone) {
              const completedEvent: AgentFlowEvent = {
                tag: "FlowCompleted",
                requestId,
                output: parsed.explanation,
                totalLLMCalls: state.totalLLMCalls + 1,
                totalToolCalls: state.totalToolCalls,
                totalTokens: state.totalTokensUsed + totalTokens,
                totalLatencyMs: state.totalLatencyMs + latencyMs,
              };
              let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
                respondedEvent,
                mutatedEvent,
                completedEvent,
              );
              effect = andReply(effect, {
                tag: "FlowResult",
                aggregateId: state.id,
                result: parsed.explanation,
                metrics: {
                  totalLLMCalls: state.totalLLMCalls + 1,
                  totalToolCalls: state.totalToolCalls,
                  totalTokensUsed: state.totalTokensUsed + totalTokens,
                  totalLatencyMs: state.totalLatencyMs + latencyMs,
                },
              });
              return effect;
            } else {
              // Not done — invoke LLM again with updated state
              const updatedMessages = await contextBuilder.buildContext(
                undefined,
                parsed.state,
                [...state.pendingMessages, { role: "assistant", content: response.text }],
                toolRegistry.getDefinitions(),
              );

              const invokedEvent: AgentFlowEvent = {
                tag: "LLMInvoked",
                requestId,
                model: config.model,
                temperature,
                messagesJson: updatedMessages,
                tools: toolRegistry.getDefinitions().map((d) => d.name),
                responseSchema: responseHandler.responseSchema ?? null,
                requestedAt: new Date().toISOString(),
              };

              let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
                respondedEvent,
                mutatedEvent,
                invokedEvent,
              );
              effect = andRun(effect, invokeLLM(ctx, requestId, updatedMessages, state.retryCount));
              return effect;
            }
          } else {
            // ToolCalls — execute tools
            const toolCalls = response.calls;

            // Check tool round limit
            if (state.toolRoundCount >= maxToolRounds) {
              const failedEvent: AgentFlowEvent = {
                tag: "FlowFailed",
                requestId,
                error: `Max tool rounds exceeded (${maxToolRounds})`,
                failedAt: now,
                totalLLMCalls: state.totalLLMCalls + 1,
                totalTokens: state.totalTokensUsed + totalTokens,
              };
              let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
                respondedEvent,
                failedEvent,
              );
              effect = andReply(effect, {
                tag: "FlowError",
                aggregateId: state.id,
                error: `Max tool rounds exceeded (${maxToolRounds})`,
                metrics: {
                  totalLLMCalls: state.totalLLMCalls + 1,
                  totalToolCalls: state.totalToolCalls,
                  totalTokensUsed: state.totalTokensUsed + totalTokens,
                  totalLatencyMs: state.totalLatencyMs + latencyMs,
                },
              });
              return effect;
            }

            // Build ToolInvoked events
            const invokeEvents: AgentFlowEvent[] = toolCalls.map((tc) => ({
              tag: "ToolInvoked" as const,
              requestId,
              toolName: tc.function.name,
              toolInput: tc.function.arguments,
              executedAt: now,
            }));

            let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
              respondedEvent,
              ...invokeEvents,
            );

            // Execute tools and tellSelf
            effect = andRun(effect, async () => {
              const results: ToolExecutionResult[] = [];
              for (const tc of toolCalls) {
                const toolStartMs = Date.now();
                let parsedArgs: unknown;
                try {
                  parsedArgs = typeof tc.function.arguments === "string"
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments;
                } catch {
                  parsedArgs = tc.function.arguments;
                }
                const toolResult = await toolRegistry.execute({
                  name: tc.function.name,
                  arguments: parsedArgs,
                });
                const toolLatencyMs = Date.now() - toolStartMs;
                results.push({
                  toolCallId: tc.id,
                  toolName: tc.function.name,
                  result: toolResult.success ? toolResult.output : toolResult.error,
                  isError: !toolResult.success,
                  latencyMs: toolLatencyMs,
                });
              }
              await ctx.tellSelf({
                tag: "ContinueToolResults",
                requestId,
                results,
                assistantMessage: response.rawMessage,
              });
            });

            return effect;
          }
        }

        // --- ContinueToolResults ---
        case "ContinueToolResults": {
          const { requestId, results, assistantMessage } = command;
          const now = new Date().toISOString();

          // Build ToolCompleted events
          const completedEvents: AgentFlowEvent[] = results.map((r) => ({
            tag: "ToolCompleted" as const,
            requestId,
            toolName: r.toolName,
            result: r.result,
            latencyMs: r.latencyMs,
            completedAt: now,
          }));

          // Build tool result messages for the LLM
          const toolResultMessages = results.map((r) => ({
            role: "tool",
            tool_call_id: r.toolCallId,
            content: typeof r.result === "string" ? r.result : JSON.stringify(r.result),
          }));

          // Rebuild messages with assistant message + tool results
          const updatedPendingMessages = [
            ...state.pendingMessages,
            assistantMessage,
            ...toolResultMessages,
          ];

          const messages = await contextBuilder.buildContext(
            undefined,
            state.flowState,
            updatedPendingMessages,
            toolRegistry.getDefinitions(),
          );

          const invokedEvent: AgentFlowEvent = {
            tag: "LLMInvoked",
            requestId,
            model: config.model,
            temperature,
            messagesJson: messages,
            tools: toolRegistry.getDefinitions().map((d) => d.name),
            responseSchema: responseHandler.responseSchema ?? null,
            requestedAt: new Date().toISOString(),
          };

          let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
            ...completedEvents,
            invokedEvent,
          );
          effect = andRun(effect, invokeLLM(ctx, requestId, messages, state.retryCount));
          return effect;
        }

        // --- HandleLLMFailure ---
        case "HandleLLMFailure": {
          const { requestId, error, retryCount } = command;
          const now = new Date().toISOString();

          const failedEvent: AgentFlowEvent = {
            tag: "LLMFailed",
            requestId,
            error,
            failedAt: now,
            retryCount,
          };

          if (retryCount < maxRetries) {
            const delayMs = retryBaseDelayMs * Math.pow(2, retryCount);
            const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

            const retryEvent: AgentFlowEvent = {
              tag: "RetryScheduled",
              requestId,
              reason: error,
              retryCount: retryCount + 1,
              scheduledAt: now,
              nextRetryAt,
            };

            let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
              failedEvent,
              retryEvent,
            );
            effect = andRun(effect, async () => {
              await ctx.scheduleOnce(
                TimerIdOf(`retry-${requestId}`) as TimerId,
                { tag: "RetryStep", requestId, retryCount: retryCount + 1 },
                delayMs,
              );
            });
            return effect;
          } else {
            const flowFailedEvent: AgentFlowEvent = {
              tag: "FlowFailed",
              requestId,
              error: `Max retries exceeded: ${error}`,
              failedAt: now,
              totalLLMCalls: state.totalLLMCalls,
              totalTokens: state.totalTokensUsed,
            };

            let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(
              failedEvent,
              flowFailedEvent,
            );
            effect = andReply(effect, {
              tag: "FlowError",
              aggregateId: state.id,
              error: `Max retries exceeded: ${error}`,
              metrics: metricsFromState(state),
            });
            return effect;
          }
        }

        // --- RetryStep ---
        case "RetryStep": {
          const { requestId, retryCount } = command;

          // Rebuild context and invoke LLM again
          const toolDefs = toolRegistry.getDefinitions();
          const messages = await contextBuilder.buildContext(
            undefined,
            state.flowState,
            state.pendingMessages,
            toolDefs,
          );

          const now = new Date().toISOString();
          const invokedEvent: AgentFlowEvent = {
            tag: "LLMInvoked",
            requestId,
            model: config.model,
            temperature,
            messagesJson: messages,
            tools: toolDefs.map((d) => d.name),
            responseSchema: responseHandler.responseSchema ?? null,
            requestedAt: now,
          };

          let effect: Effect<AgentFlowEvent, AgentFlowReply> = persist<AgentFlowEvent, AgentFlowReply>(invokedEvent);
          effect = andRun(effect, invokeLLM(ctx, requestId, messages, retryCount));
          return effect;
        }

        // --- GetFlowState ---
        case "GetFlowState": {
          return replyEffect<AgentFlowEvent, AgentFlowReply>({
            tag: "CurrentState",
            aggregateId: state.id,
            flowState: stateSchema.encode(state.flowState),
            status: state.status,
            metrics: metricsFromState(state),
          });
        }
      }
    },

    apply(state: AgentFlowState<S>, event: AgentFlowEvent): AgentFlowState<S> {
      switch (event.tag) {
        case "InputReceived":
          return {
            ...state,
            status: "Processing",
            currentRequestId: event.requestId,
            retryCount: 0,
            toolRoundCount: 0,
            pendingMessages: [],
          };

        case "LLMInvoked":
          return state; // no state change on invocation

        case "LLMResponded":
          return {
            ...state,
            totalLLMCalls: state.totalLLMCalls + 1,
            totalTokensUsed: state.totalTokensUsed + event.totalTokens,
            totalLatencyMs: state.totalLatencyMs + event.latencyMs,
            pendingMessages: event.text
              ? [...state.pendingMessages, { role: "assistant", content: event.text }]
              : state.pendingMessages,
            status: event.toolCalls && event.toolCalls.length > 0 ? "WaitingForTools" : state.status,
            toolRoundCount: event.toolCalls && event.toolCalls.length > 0
              ? state.toolRoundCount + 1
              : state.toolRoundCount,
          };

        case "LLMFailed":
          return {
            ...state,
            lastError: event.error,
          };

        case "ToolInvoked":
          return state; // no state change on invocation

        case "ToolCompleted":
          return {
            ...state,
            totalToolCalls: state.totalToolCalls + 1,
          };

        case "StateMutated":
          return {
            ...state,
            flowState: stateSchema.decode(event.flowStateJson),
          };

        case "FlowCompleted":
          return {
            ...state,
            status: "Completed",
            pendingMessages: [],
          };

        case "FlowFailed":
          return {
            ...state,
            status: "Failed",
          };

        case "RetryScheduled":
          return {
            ...state,
            status: "WaitingForRetry",
            retryCount: event.retryCount,
          };
      }
    },
  };
}
