import { describe, it, expect } from "vitest";
import {
  createMCPToolRegistry,
  createNoopMCPToolRegistry,
} from "../src/ai/tool/mcp-tool-registry.js";
import type { MCPTool, ToolApprovalCallback } from "../src/ai/tool/types.js";
import { MCPToolResult, ToolPermission } from "../src/ai/tool/types.js";

function echoTool(): MCPTool {
  return {
    name: "echo",
    description: "Echoes input back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    async execute(input: unknown) {
      const params = input as Record<string, unknown>;
      return MCPToolResult.success({ echoed: params.text });
    },
  };
}

function failTool(): MCPTool {
  return {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object" },
    async execute() {
      return MCPToolResult.failure("intentional failure");
    },
  };
}

describe("MCPToolRegistry", () => {
  describe("in-memory registry", () => {
    it("should register and retrieve tools", () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());

      expect(registry.get("echo")).toBeDefined();
      expect(registry.get("echo")!.name).toBe("echo");
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should list all registered tools", () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());
      registry.register(failTool());

      const tools = registry.list();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
    });

    it("should return tool definitions", () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());

      const defs = registry.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("echo");
      expect(defs[0].description).toBe("Echoes input back");
      expect(defs[0].inputSchema).toEqual({
        type: "object",
        properties: { text: { type: "string" } },
      });
    });

    it("should execute a tool", async () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());

      const result = await registry.execute({ name: "echo", arguments: { text: "hello" } });
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ echoed: "hello" });
    });

    it("should return failure for unknown tool", async () => {
      const registry = createMCPToolRegistry();

      const result = await registry.execute({ name: "unknown", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Tool not found");
    });

    it("should execute multiple tools", async () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());
      registry.register(failTool());

      const results = await registry.executeAll([
        { name: "echo", arguments: { text: "hi" } },
        { name: "fail", arguments: {} },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0][0].name).toBe("echo");
      expect(results[0][1].success).toBe(true);
      expect(results[1][0].name).toBe("fail");
      expect(results[1][1].success).toBe(false);
      expect(results[1][1].error).toBe("intentional failure");
    });

    it("should overwrite tool on re-register", () => {
      const registry = createMCPToolRegistry();
      registry.register(echoTool());
      registry.register({
        ...echoTool(),
        description: "Updated echo",
      });

      expect(registry.list()).toHaveLength(1);
      expect(registry.get("echo")!.description).toBe("Updated echo");
    });
  });

  describe("tool permissions", () => {
    function toolWithPermission(permission?: ToolPermission): MCPTool {
      return {
        name: "guarded",
        description: "A guarded tool",
        inputSchema: { type: "object" },
        permission,
        async execute(input: unknown) {
          return MCPToolResult.success({ executed: true, input });
        },
      };
    }

    it("Auto permission executes without callback", async () => {
      const registry = createMCPToolRegistry();
      registry.register(toolWithPermission(ToolPermission.Auto));

      const result = await registry.execute({ name: "guarded", arguments: { x: 1 } });
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ executed: true, input: { x: 1 } });
    });

    it("tool without permission field defaults to Auto", async () => {
      const registry = createMCPToolRegistry();
      registry.register(toolWithPermission(undefined));

      const result = await registry.execute({ name: "guarded", arguments: {} });
      expect(result.success).toBe(true);
    });

    it("Confirm permission: callback approves -> executes", async () => {
      const approve: ToolApprovalCallback = async () => true;
      const registry = createMCPToolRegistry(approve);
      registry.register(toolWithPermission(ToolPermission.Confirm));

      const result = await registry.execute({ name: "guarded", arguments: { a: 1 } });
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ executed: true, input: { a: 1 } });
    });

    it("Confirm permission: callback denies -> returns error", async () => {
      const deny: ToolApprovalCallback = async () => false;
      const registry = createMCPToolRegistry(deny);
      registry.register(toolWithPermission(ToolPermission.Confirm));

      const result = await registry.execute({ name: "guarded", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });

    it("Confirm permission: no callback -> returns error", async () => {
      const registry = createMCPToolRegistry();
      registry.register(toolWithPermission(ToolPermission.Confirm));

      const result = await registry.execute({ name: "guarded", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });

    it("ConfirmIf('amount > 100'): amount=50 -> auto-executes", async () => {
      const deny: ToolApprovalCallback = async () => false;
      const registry = createMCPToolRegistry(deny);
      registry.register(toolWithPermission(ToolPermission.ConfirmIf("amount > 100")));

      const result = await registry.execute({ name: "guarded", arguments: { amount: 50 } });
      expect(result.success).toBe(true);
    });

    it("ConfirmIf('amount > 100'): amount=200 -> needs approval", async () => {
      const approve: ToolApprovalCallback = async () => true;
      const registry = createMCPToolRegistry(approve);
      registry.register(toolWithPermission(ToolPermission.ConfirmIf("amount > 100")));

      const result = await registry.execute({ name: "guarded", arguments: { amount: 200 } });
      expect(result.success).toBe(true);
    });

    it("ConfirmIf('amount > 100'): amount=200, denied -> returns error", async () => {
      const deny: ToolApprovalCallback = async () => false;
      const registry = createMCPToolRegistry(deny);
      registry.register(toolWithPermission(ToolPermission.ConfirmIf("amount > 100")));

      const result = await registry.execute({ name: "guarded", arguments: { amount: 200 } });
      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });

    it("ConfirmIf('dangerous'): field present -> needs approval", async () => {
      const deny: ToolApprovalCallback = async () => false;
      const registry = createMCPToolRegistry(deny);
      registry.register(toolWithPermission(ToolPermission.ConfirmIf("dangerous")));

      const result = await registry.execute({ name: "guarded", arguments: { dangerous: true } });
      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });

    it("ConfirmIf('dangerous'): field absent -> auto-executes", async () => {
      const deny: ToolApprovalCallback = async () => false;
      const registry = createMCPToolRegistry(deny);
      registry.register(toolWithPermission(ToolPermission.ConfirmIf("dangerous")));

      const result = await registry.execute({ name: "guarded", arguments: { safe: true } });
      expect(result.success).toBe(true);
    });
  });

  describe("noop registry", () => {
    it("should return empty results", async () => {
      const registry = createNoopMCPToolRegistry();

      expect(registry.get("anything")).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
      expect(registry.getDefinitions()).toHaveLength(0);

      const result = await registry.execute({ name: "test", arguments: {} });
      expect(result.success).toBe(false);

      const results = await registry.executeAll([{ name: "test", arguments: {} }]);
      expect(results).toHaveLength(0);
    });
  });
});
