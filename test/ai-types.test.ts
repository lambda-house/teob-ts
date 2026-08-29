import { describe, it, expect } from "vitest";
import {
  ChatMessage,
  defaultModelConfig,
  llmTool,
} from "../src/ai/llm/types.js";
import {
  MCPToolResult,
  toolDefinitionFromTool,
} from "../src/ai/tool/types.js";
import type { MCPTool } from "../src/ai/tool/types.js";
import {
  parseWsDownstreamMessage,
  serializeWsUpstreamMessage,
} from "../src/ai/agent/types.js";

describe("AI types", () => {
  describe("ChatMessage", () => {
    it("should create system message", () => {
      const msg = ChatMessage.system("You are helpful");
      expect(msg).toEqual({ role: "system", content: "You are helpful" });
    });

    it("should create user message", () => {
      const msg = ChatMessage.user("Hello");
      expect(msg).toEqual({ role: "user", content: "Hello" });
    });

    it("should create assistant message", () => {
      const msg = ChatMessage.assistant("Hi there");
      expect(msg).toEqual({ role: "assistant", content: "Hi there" });
    });
  });

  describe("ModelConfig", () => {
    it("should have sensible defaults", () => {
      expect(defaultModelConfig.temperature).toBe(0.7);
      expect(defaultModelConfig.maxTokens).toBe(2048);
    });
  });

  describe("llmTool", () => {
    it("should create a function tool", () => {
      const tool = llmTool("search", "Search the web", {
        type: "object",
        properties: { query: { type: "string" } },
      });

      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe("search");
      expect(tool.function.description).toBe("Search the web");
    });
  });

  describe("MCPToolResult", () => {
    it("should create success result", () => {
      const result = MCPToolResult.success({ data: "hello" });
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ data: "hello" });
      expect(result.error).toBeUndefined();
    });

    it("should create failure result", () => {
      const result = MCPToolResult.failure("something went wrong");
      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe("something went wrong");
    });
  });

  describe("toolDefinitionFromTool", () => {
    it("should extract definition from tool", () => {
      const tool: MCPTool = {
        name: "calculator",
        description: "Does math",
        inputSchema: { type: "object", properties: { expression: { type: "string" } } },
        async execute() { return MCPToolResult.success(42); },
      };

      const def = toolDefinitionFromTool(tool);
      expect(def.name).toBe("calculator");
      expect(def.description).toBe("Does math");
      expect(def.inputSchema).toEqual(tool.inputSchema);
    });
  });

  describe("WsDownstreamMessage parsing", () => {
    it("should parse system message", () => {
      const msg = parseWsDownstreamMessage('{"type":"system","sessionId":"sess_abc","model":"gpt-4"}');
      expect(msg).toEqual({ type: "system", sessionId: "sess_abc", model: "gpt-4" });
    });

    it("should parse assistant message", () => {
      const msg = parseWsDownstreamMessage('{"type":"assistant","text":"Hello!"}');
      expect(msg).toEqual({ type: "assistant", text: "Hello!" });
    });

    it("should parse tool_use message", () => {
      const msg = parseWsDownstreamMessage('{"type":"tool_use","toolName":"search","input":{"q":"test"}}');
      expect(msg).toEqual({ type: "tool_use", toolName: "search", input: { q: "test" } });
    });

    it("should parse tool_result message", () => {
      const msg = parseWsDownstreamMessage('{"type":"tool_result","toolName":"search","output":"found 3 results"}');
      expect(msg).toEqual({ type: "tool_result", toolName: "search", output: "found 3 results" });
    });

    it("should parse result message", () => {
      const msg = parseWsDownstreamMessage(
        '{"type":"result","text":"Done","costUsd":0.01,"durationMs":1500,"numTurns":3}',
      );
      expect(msg).toEqual({ type: "result", text: "Done", costUsd: 0.01, durationMs: 1500, numTurns: 3 });
    });

    it("should parse error message", () => {
      const msg = parseWsDownstreamMessage('{"type":"error","message":"rate limited"}');
      expect(msg).toEqual({ type: "error", message: "rate limited" });
    });

    it("should parse closed message", () => {
      const msg = parseWsDownstreamMessage('{"type":"closed","reason":"completed"}');
      expect(msg).toEqual({ type: "closed", reason: "completed" });
    });

    it("should throw on unknown type", () => {
      expect(() => parseWsDownstreamMessage('{"type":"unknown"}')).toThrow("Unknown WsDownstreamMessage type");
    });
  });

  describe("WsUpstreamMessage serialization", () => {
    it("should serialize user_message", () => {
      const json = serializeWsUpstreamMessage({ type: "user_message", text: "Hello" });
      expect(JSON.parse(json)).toEqual({ type: "user_message", text: "Hello" });
    });

    it("should serialize interrupt", () => {
      const json = serializeWsUpstreamMessage({ type: "interrupt" });
      expect(JSON.parse(json)).toEqual({ type: "interrupt" });
    });
  });
});
