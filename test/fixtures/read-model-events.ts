import type { Codec } from "../../src/core/codec.js";

// --- Test event types ---

export type TestReadModelEvent =
  | { tag: "ItemAdded"; entityId: string; itemId: string; value: string; timestamp: string }
  | { tag: "ItemUpdated"; entityId: string; itemId: string; value: string; timestamp: string }
  | { tag: "MetadataUpdated"; entityId: string; metadata: TestMetadata; timestamp: string };

export interface TestMetadata {
  name: string;
  description?: string;
}

export interface TestItem {
  itemId: string;
  value: string;
  lastUpdated: string;
}

export interface TestViewEntry {
  entityId: string;
  metadata?: TestMetadata;
  items: Record<string, TestItem>;
  lastUpdated: string;
  seq: number;
  lastProcessedSeq: number;
  incomplete: boolean;
}

// --- Factories ---

export function itemAdded(entityId: string, itemId: string, value: string, timestamp?: Date): TestReadModelEvent {
  return { tag: "ItemAdded", entityId, itemId, value, timestamp: (timestamp ?? new Date()).toISOString() };
}

export function itemUpdated(entityId: string, itemId: string, value: string, timestamp?: Date): TestReadModelEvent {
  return { tag: "ItemUpdated", entityId, itemId, value, timestamp: (timestamp ?? new Date()).toISOString() };
}

export function metadataUpdated(entityId: string, metadata: TestMetadata, timestamp?: Date): TestReadModelEvent {
  return { tag: "MetadataUpdated", entityId, metadata, timestamp: (timestamp ?? new Date()).toISOString() };
}

export function emptyViewEntry(entityId: string): TestViewEntry {
  return {
    entityId,
    metadata: undefined,
    items: {},
    lastUpdated: new Date().toISOString(),
    seq: 0,
    lastProcessedSeq: 0,
    incomplete: false,
  };
}

export function updateViewEntry(entry: TestViewEntry, event: TestReadModelEvent): TestViewEntry {
  switch (event.tag) {
    case "ItemAdded": {
      const newItem: TestItem = { itemId: event.itemId, value: event.value, lastUpdated: event.timestamp };
      return {
        ...entry,
        items: { ...entry.items, [event.itemId]: newItem },
        lastUpdated: event.timestamp,
        seq: entry.seq + 1,
        lastProcessedSeq: entry.lastProcessedSeq + 1,
      };
    }
    case "ItemUpdated": {
      const existing = entry.items[event.itemId];
      const updatedItem: TestItem = existing
        ? { ...existing, value: event.value, lastUpdated: event.timestamp }
        : { itemId: event.itemId, value: event.value, lastUpdated: event.timestamp };
      return {
        ...entry,
        items: { ...entry.items, [event.itemId]: updatedItem },
        lastUpdated: event.timestamp,
        lastProcessedSeq: entry.lastProcessedSeq + 1,
        // Note: ItemUpdated does NOT increment seq
      };
    }
    case "MetadataUpdated":
      return {
        ...entry,
        metadata: event.metadata,
        lastUpdated: event.timestamp,
        seq: entry.seq + 1,
        lastProcessedSeq: entry.lastProcessedSeq + 1,
        incomplete: false,
      };
    default:
      // Unknown event tag — return state unchanged
      return entry;
  }
}

// --- Codecs ---

export const testEventCodec: Codec<TestReadModelEvent> = {
  manifest(event: TestReadModelEvent): string {
    return event.tag;
  },
  encode(event: TestReadModelEvent): unknown {
    return event;
  },
  decode(manifest: string, data: unknown): TestReadModelEvent {
    const obj = data as Record<string, unknown>;
    if (obj.tag !== manifest) {
      return { ...obj, tag: manifest } as TestReadModelEvent;
    }
    return obj as TestReadModelEvent;
  },
};

export const testViewEntryCodec: Codec<TestViewEntry> = {
  manifest(_state: TestViewEntry): string {
    return "TestViewEntry";
  },
  encode(state: TestViewEntry): unknown {
    return state;
  },
  decode(_manifest: string, data: unknown): TestViewEntry {
    return data as TestViewEntry;
  },
};
