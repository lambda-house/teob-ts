import type { MCPTool, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { MemoryService } from "./memory-service.js";

/**
 * Create an MCP tool that exposes memory store/recall/forget actions to an agent.
 */
export function createMemoryTool(memoryService: MemoryService, agentId: string): MCPTool {
  const inputSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["store", "recall", "forget"],
        description: "Action to perform",
      },
      memory_type: {
        type: "string",
        enum: ["user", "feedback", "domain", "reference"],
        description: "Type of memory (required for store)",
      },
      content: {
        type: "string",
        description: "Content to store (required for store)",
      },
      query: {
        type: "string",
        description: "Semantic search query (for recall)",
      },
      id: {
        type: "string",
        description: "Memory ID (required for forget)",
      },
      limit: {
        type: "integer",
        description: "Maximum number of results for recall",
      },
    },
    required: ["action"],
  };

  return {
    name: "memory",
    description: "Store and recall information across conversations",
    inputSchema,

    async execute(input: unknown): Promise<MCPToolResult> {
      try {
        const params = input as Record<string, unknown>;
        const action = params.action as string;

        switch (action) {
          case "store": {
            const memoryType = params.memory_type as string;
            const content = params.content as string;
            if (!memoryType || !content) {
              return MCPToolResultFactory.failure("store requires memory_type and content");
            }
            const memory = await memoryService.store(
              agentId,
              memoryType as "user" | "feedback" | "domain" | "reference",
              content,
            );
            return MCPToolResultFactory.success(memory);
          }

          case "recall": {
            const query = typeof params.query === "string" ? params.query : undefined;
            const memoryType = typeof params.memory_type === "string"
              ? (params.memory_type as "user" | "feedback" | "domain" | "reference")
              : undefined;
            const limit = typeof params.limit === "number" ? params.limit : undefined;
            const memories = await memoryService.recall({
              agentId,
              semanticQuery: query,
              memoryType,
              limit,
            });
            return MCPToolResultFactory.success(memories);
          }

          case "forget": {
            const id = params.id as string;
            if (!id) {
              return MCPToolResultFactory.failure("forget requires id");
            }
            await memoryService.forget(id);
            return MCPToolResultFactory.success({ deleted: id });
          }

          default:
            return MCPToolResultFactory.failure(`Unknown action: ${action}`);
        }
      } catch (err) {
        return MCPToolResultFactory.failure(
          `Memory tool failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
