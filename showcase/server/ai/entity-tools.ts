/**
 * Entity-aware MCP tools — let the AI query event-sourced entities.
 */

import type { MCPTool, MCPToolResult } from "../../../src/ai/tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../../../src/ai/tool/types.js";
import type { EntityRuntime } from "../../../src/core/runtime.js";
import { EntityId } from "../../../src/core/types.js";
import { giftCardCategory, type GiftCardCommand, type GiftCardReply } from "../domains/gift-card/aggregate.js";
import { todoCategory, type TodoCommand, type TodoReply } from "../domains/todo/aggregate.js";

export function createGiftCardBalanceTool(runtime: EntityRuntime): MCPTool {
  return {
    name: "gift_card_balance",
    description: "Look up the current balance and status of a gift card by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "The gift card ID" },
      },
      required: ["cardId"],
    },
    async execute(input: unknown): Promise<MCPToolResult> {
      try {
        const { cardId } = input as { cardId: string };
        const command: GiftCardCommand = { tag: "GetBalance" };
        const result = await runtime.ask(EntityId(cardId), command, giftCardCategory);
        if (!result.ok) return MCPToolResultFactory.failure(`Error: ${JSON.stringify(result.error)}`);
        const reply = result.value.reply as GiftCardReply;
        if (reply.tag === "Balance") {
          return MCPToolResultFactory.success({ cardId, balance: reply.amount });
        }
        return MCPToolResultFactory.success({ cardId, balance: 0, note: "No data" });
      } catch (err) {
        return MCPToolResultFactory.failure(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export function createTodoListTool(runtime: EntityRuntime): MCPTool {
  return {
    name: "todo_list",
    description: "Retrieve items from a todo list by its list ID.",
    inputSchema: {
      type: "object",
      properties: {
        listId: { type: "string", description: "The todo list ID" },
      },
      required: ["listId"],
    },
    async execute(input: unknown): Promise<MCPToolResult> {
      try {
        const { listId } = input as { listId: string };
        const command: TodoCommand = { tag: "GetList" };
        const result = await runtime.ask(EntityId(listId), command, todoCategory);
        if (!result.ok) return MCPToolResultFactory.failure(`Error: ${JSON.stringify(result.error)}`);
        const reply = result.value.reply as TodoReply;
        if (reply.tag === "TodoList") {
          return MCPToolResultFactory.success({ listId, items: reply.items });
        }
        return MCPToolResultFactory.success({ listId, items: [] });
      } catch (err) {
        return MCPToolResultFactory.failure(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
