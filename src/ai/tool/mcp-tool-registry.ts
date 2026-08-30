import type { MCPTool, MCPToolCall, MCPToolDefinition, MCPToolResult, ToolApprovalCallback } from "./types.js";
import { MCPToolResult as MCPToolResultFactory, ToolPermission, toolDefinitionFromTool } from "./types.js";

/** Registry for MCP tools that can be invoked by an agent system. */
export interface MCPToolRegistry {
  register(tool: MCPTool): void;
  get(name: string): MCPTool | undefined;
  list(): MCPTool[];
  getDefinitions(): MCPToolDefinition[];
  execute(call: MCPToolCall): Promise<MCPToolResult>;
  executeAll(calls: MCPToolCall[]): Promise<Array<[MCPToolCall, MCPToolResult]>>;
}

/**
 * Evaluate a simple condition against tool arguments.
 * Supports: "field > N", "field < N", "field" (truthy/presence check).
 */
function evaluateCondition(condition: string, args: unknown): boolean {
  const record = args as Record<string, unknown> | null | undefined;
  if (!record || typeof record !== "object") return false;
  const parts = condition.trim().split(/\s+/);
  if (parts.length === 3) {
    const [field, op, thresholdStr] = parts;
    const value = record[field];
    if (typeof value !== "number") return false;
    const threshold = Number(thresholdStr);
    if (Number.isNaN(threshold)) return false;
    if (op === ">") return value > threshold;
    if (op === "<") return value < threshold;
    return false;
  }
  if (parts.length === 1) {
    const field = parts[0];
    return field in record && record[field] != null;
  }
  return false;
}

/**
 * Create an in-memory tool registry.
 *
 * @param approvalCallback Optional callback for tools that require permission.
 *   If not provided, tools requiring approval will be denied.
 */
export function createMCPToolRegistry(approvalCallback?: ToolApprovalCallback): MCPToolRegistry {
  const tools = new Map<string, MCPTool>();

  async function checkPermission(tool: MCPTool, args: unknown): Promise<boolean> {
    const permission = tool.permission ?? ToolPermission.Auto;
    switch (permission.tag) {
      case "Auto":
        return true;
      case "Confirm": {
        if (!approvalCallback) return false;
        return approvalCallback(tool.name, args);
      }
      case "ConfirmIf": {
        if (evaluateCondition(permission.condition, args)) {
          if (!approvalCallback) return false;
          return approvalCallback(tool.name, args);
        }
        return true;
      }
    }
  }

  return {
    register(tool) {
      tools.set(tool.name, tool);
    },

    get(name) {
      return tools.get(name);
    },

    list() {
      return Array.from(tools.values());
    },

    getDefinitions() {
      return Array.from(tools.values()).map(toolDefinitionFromTool);
    },

    async execute(call) {
      const tool = tools.get(call.name);
      if (!tool) return MCPToolResultFactory.failure(`Tool not found: ${call.name}`);
      const approved = await checkPermission(tool, call.arguments);
      if (!approved) return MCPToolResultFactory.failure("Tool execution denied: approval required");
      return tool.execute(call.arguments);
    },

    async executeAll(calls) {
      const results: Array<[MCPToolCall, MCPToolResult]> = [];
      for (const call of calls) {
        const result = await this.execute(call);
        results.push([call, result]);
      }
      return results;
    },
  };
}

/** Create a no-op tool registry (for testing). */
export function createNoopMCPToolRegistry(): MCPToolRegistry {
  return {
    register() {},
    get() { return undefined; },
    list() { return []; },
    getDefinitions() { return []; },
    async execute() { return MCPToolResultFactory.failure("No tools registered"); },
    async executeAll() { return []; },
  };
}
