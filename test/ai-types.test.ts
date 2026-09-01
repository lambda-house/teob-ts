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
});
