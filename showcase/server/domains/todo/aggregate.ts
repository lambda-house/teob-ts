/**
 * TodoList aggregate — showcases a list-bearing TEOB aggregate.
 *
 * Demonstrates event sourcing over a collection: add/complete/remove items,
 * with the full list reconstructed from events.
 */

import { CategoryId, type EntityId } from "../../../../src/core/types.js";
import type { Aggregate } from "../../../../src/core/aggregate.js";
import type { Effect } from "../../../../src/core/effect.js";
import type { EffectControl } from "../../../../src/core/effect-control.js";
import { persist, reply, andReply } from "../../../../src/core/effect.js";
import { categoryTypes } from "../../../../src/core/effect-control.js";
import { tagCodec, objectCodec } from "../../../../src/core/codec.js";

export interface TodoItem {
  itemId: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export interface TodoState {
  id: string;
  items: TodoItem[];
}

export type TodoCommand =
  | { tag: "AddItem"; itemId: string; title: string }
  | { tag: "CompleteItem"; itemId: string }
  | { tag: "UncompleteItem"; itemId: string }
  | { tag: "RemoveItem"; itemId: string }
  | { tag: "GetList" };

export type TodoEvent =
  | { tag: "ItemAdded"; itemId: string; title: string; createdAt: string }
  | { tag: "ItemCompleted"; itemId: string }
  | { tag: "ItemUncompleted"; itemId: string }
  | { tag: "ItemRemoved"; itemId: string };

export type TodoReply =
  | { tag: "Ok" }
  | { tag: "TodoList"; items: TodoItem[] }
  | { tag: "Rejected"; reason: string };

export const todoCategory = categoryTypes<TodoCommand, TodoReply>(
  CategoryId("todo"),
);

export const todoAggregate: Aggregate<TodoCommand, TodoReply, TodoEvent, TodoState> = {
  category: CategoryId("todo"),

  initial(id: EntityId): TodoState {
    return { id, items: [] };
  },

  async decide(
    state: TodoState,
    command: TodoCommand,
    _ctx: EffectControl<TodoCommand, TodoReply>,
  ): Promise<Effect<TodoEvent, TodoReply>> {
    switch (command.tag) {
      case "AddItem": {
        if (state.items.some((i) => i.itemId === command.itemId)) {
          return reply({ tag: "Rejected", reason: "Item already exists" });
        }
        return andReply(
          persist({
            tag: "ItemAdded",
            itemId: command.itemId,
            title: command.title,
            createdAt: new Date().toISOString(),
          }),
          { tag: "Ok" },
        );
      }

      case "CompleteItem": {
        const item = state.items.find((i) => i.itemId === command.itemId);
        if (!item) return reply({ tag: "Rejected", reason: "Item not found" });
        if (item.completed) return reply({ tag: "Rejected", reason: "Already completed" });
        return andReply(persist({ tag: "ItemCompleted", itemId: command.itemId }), { tag: "Ok" });
      }

      case "UncompleteItem": {
        const item = state.items.find((i) => i.itemId === command.itemId);
        if (!item) return reply({ tag: "Rejected", reason: "Item not found" });
        if (!item.completed) return reply({ tag: "Rejected", reason: "Not completed" });
        return andReply(persist({ tag: "ItemUncompleted", itemId: command.itemId }), { tag: "Ok" });
      }

      case "RemoveItem": {
        const item = state.items.find((i) => i.itemId === command.itemId);
        if (!item) return reply({ tag: "Rejected", reason: "Item not found" });
        return andReply(persist({ tag: "ItemRemoved", itemId: command.itemId }), { tag: "Ok" });
      }

      case "GetList":
        return reply({ tag: "TodoList", items: state.items });
    }
  },

  apply(state: TodoState, event: TodoEvent): TodoState {
    switch (event.tag) {
      case "ItemAdded":
        return {
          ...state,
          items: [
            ...state.items,
            { itemId: event.itemId, title: event.title, completed: false, createdAt: event.createdAt },
          ],
        };
      case "ItemCompleted":
        return {
          ...state,
          items: state.items.map((i) => (i.itemId === event.itemId ? { ...i, completed: true } : i)),
        };
      case "ItemUncompleted":
        return {
          ...state,
          items: state.items.map((i) => (i.itemId === event.itemId ? { ...i, completed: false } : i)),
        };
      case "ItemRemoved":
        return {
          ...state,
          items: state.items.filter((i) => i.itemId !== event.itemId),
        };
    }
  },
};

export const todoEventCodec = tagCodec<TodoEvent>("ItemAdded", "ItemCompleted", "ItemUncompleted", "ItemRemoved");
export const todoStateCodec = objectCodec<TodoState>("TodoState");
