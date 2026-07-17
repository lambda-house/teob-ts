/**
 * Chat service — runs an agentic tool-calling loop.
 *
 * Manages stateful chat sessions with conversation history.
 * Each message triggers an LLM call that may invoke tools (entity queries, knowledge search)
 * before producing a final response.
 */

import type { LLMService } from "../../../src/ai/llm/llm-service.js";
import type { ChatMessage, LLMTool, LLMToolCall } from "../../../src/ai/llm/types.js";
import { ChatMessage as CM } from "../../../src/ai/llm/types.js";
import type { MCPToolRegistry } from "../../../src/ai/tool/mcp-tool-registry.js";

export interface ChatSession {
  id: string;
  messages: unknown[]; // raw message objects for the LLM API (supports mixed types)
  createdAt: Date;
}

export interface ChatResponse {
  response: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
}

export interface ChatService {
  createSession(systemPrompt?: string): string;
  sendMessage(sessionId: string, userMessage: string): Promise<ChatResponse>;
  getMessages(sessionId: string): ChatMessage[];
  deleteSession(sessionId: string): boolean;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for the TEOB-TS framework showcase application. You have access to tools that let you query gift card balances, todo lists, and a knowledge base about the framework. Use tools when the user asks about specific entities or framework concepts. Be concise and helpful.`;

export function createChatService(
  llmService: LLMService,
  toolRegistry: MCPToolRegistry,
): ChatService {
  const sessions = new Map<string, ChatSession>();

  function toLLMTools(): LLMTool[] {
    return toolRegistry.getDefinitions().map((def) => ({
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: def.inputSchema,
      },
    }));
  }

  return {
    createSession(systemPrompt?: string): string {
      const id = crypto.randomUUID();
      const systemMsg = { role: "system", content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT };
      sessions.set(id, {
        id,
        messages: [systemMsg],
        createdAt: new Date(),
      });
      return id;
    },

    async sendMessage(sessionId: string, userMessage: string): Promise<ChatResponse> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      session.messages.push({ role: "user", content: userMessage });

      const tools = toLLMTools();
      const toolCallLog: Array<{ name: string; result: unknown }> = [];
      const maxIterations = 5;

      for (let i = 0; i < maxIterations; i++) {
        const response = await llmService.chatWithTools(session.messages, tools);

        if (response.tag === "Content") {
          session.messages.push({ role: "assistant", content: response.text });
          return { response: response.text, toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined };
        }

        // Tool calls — execute them and feed results back
        session.messages.push(response.rawMessage);

        for (const call of response.calls) {
          const args = JSON.parse(call.function.arguments);
          const result = await toolRegistry.execute({ name: call.function.name, arguments: args });
          toolCallLog.push({ name: call.function.name, result: result.output });

          session.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result.output),
          });
        }
      }

      // Exhausted iterations — ask for final response without tools
      const finalResponse = await llmService.chat(
        session.messages as ChatMessage[],
      );
      session.messages.push({ role: "assistant", content: finalResponse });
      return { response: finalResponse, toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined };
    },

    getMessages(sessionId: string): ChatMessage[] {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      // Return only user/assistant messages for display
      return (session.messages as ChatMessage[]).filter(
        (m) => m.role === "user" || m.role === "assistant",
      );
    },

    deleteSession(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },
  };
}
