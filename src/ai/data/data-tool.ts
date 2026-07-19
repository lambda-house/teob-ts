import type { MCPTool, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { FilterCondition, RowFilter, TabularStore } from "./tabular-store.js";

/**
 * MCP tool for row-based structured data access.
 * Routes requests by source ID to the appropriate TabularStore.
 */
export function createDataTool(
  stores: Record<string, TabularStore>,
): MCPTool {
  return {
    name: "data_query",
    description:
      "Query, append, update, or delete rows in structured data tables. " +
      "Supports filtering with conditions (eq, neq, gt, lt, gte, lte, contains, in).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "append", "update", "delete", "list", "schema"],
          description: "The operation to perform",
        },
        source: {
          type: "string",
          description: "Data source identifier",
        },
        table: {
          type: "string",
          description: "Table name (required for query/append/update/delete/schema)",
        },
        filter: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "in"] },
              value: {},
            },
            required: ["column", "op", "value"],
          },
          description: "Filter conditions (AND logic)",
        },
        data: {
          type: "object",
          description: "Row data (for append/update)",
        },
        limit: {
          type: "number",
          description: "Maximum rows to return (for query)",
        },
      },
      required: ["action", "source"],
    },

    async execute(input: unknown): Promise<MCPToolResult> {
      const params = input as {
        action: string;
        source: string;
        table?: string;
        filter?: FilterCondition[];
        data?: Record<string, unknown>;
        limit?: number;
      };

      const store = stores[params.source];
      if (!store) {
        return MCPToolResultFactory.failure(`Unknown data source: ${params.source}`);
      }

      const filter: RowFilter | undefined = params.filter
        ? { conditions: params.filter }
        : undefined;

      switch (params.action) {
        case "list":
          return MCPToolResultFactory.success(await store.listTables());

        case "schema": {
          if (!params.table) return MCPToolResultFactory.failure("table is required");
          const schema = await store.schema(params.table);
          return schema
            ? MCPToolResultFactory.success(schema)
            : MCPToolResultFactory.failure(`Table '${params.table}' not found`);
        }

        case "query": {
          if (!params.table) return MCPToolResultFactory.failure("table is required");
          const rows = await store.query(params.table, filter, params.limit);
          return MCPToolResultFactory.success(rows);
        }

        case "append": {
          if (!params.table) return MCPToolResultFactory.failure("table is required");
          if (!params.data) return MCPToolResultFactory.failure("data is required");
          const row = await store.append(params.table, params.data);
          return MCPToolResultFactory.success(row);
        }

        case "update": {
          if (!params.table) return MCPToolResultFactory.failure("table is required");
          if (!filter) return MCPToolResultFactory.failure("filter is required for update");
          if (!params.data) return MCPToolResultFactory.failure("data is required");
          const count = await store.update(params.table, filter, params.data);
          return MCPToolResultFactory.success({ updatedCount: count });
        }

        case "delete": {
          if (!params.table) return MCPToolResultFactory.failure("table is required");
          if (!filter) return MCPToolResultFactory.failure("filter is required for delete");
          const count = await store.delete(params.table, filter);
          return MCPToolResultFactory.success({ deletedCount: count });
        }

        default:
          return MCPToolResultFactory.failure(`Unknown action: ${params.action}`);
      }
    },
  };
}
