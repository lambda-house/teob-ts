import type { KnowledgeAPI, KnowledgeRecord } from "../knowledge/knowledge-api.js";
import type { Memory, MemoryQuery, MemoryService, MemoryType } from "./memory-service.js";

const COLLECTION_PREFIX = "memory:";

/** Convert a KnowledgeRecord to a Memory. */
export function toMemory(record: KnowledgeRecord): Memory {
  const agentId = record.collection.startsWith(COLLECTION_PREFIX)
    ? record.collection.slice(COLLECTION_PREFIX.length)
    : record.collection;
  const { memoryType, ...rest } = record.attributes;
  return {
    id: record.id,
    agentId,
    memoryType: (memoryType as MemoryType) ?? "domain",
    content: record.text,
    metadata: rest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Create a MemoryService backed by a KnowledgeAPI.
 *
 * Memories are stored as knowledge records with collection "memory:{agentId}"
 * and the memory type stored as an attribute.
 */
export function createKnowledgeBackedMemoryService(knowledge: KnowledgeAPI): MemoryService {
  return {
    async store(agentId, memoryType, content, metadata = {}) {
      const id = crypto.randomUUID();
      const record = await knowledge.upsertRecord({
        id,
        text: content,
        collection: `${COLLECTION_PREFIX}${agentId}`,
        attributes: { ...metadata, memoryType },
      });
      return toMemory(record);
    },

    async recall(query) {
      const limit = query.limit ?? 10;
      const filter = {
        collection: `${COLLECTION_PREFIX}${query.agentId}`,
        attributes: query.memoryType ? { memoryType: query.memoryType } : undefined,
      };

      const records = query.semanticQuery
        ? await knowledge.findBestMatches(query.semanticQuery, filter, limit)
        : await knowledge.viewRecords(filter, undefined, limit);

      return records.map(toMemory);
    },

    async update(id, content) {
      // Retrieve the existing record to preserve collection and attributes
      const existing = await knowledge.viewRecords(undefined, undefined, undefined);
      const record = existing.find((r) => r.id === id);
      if (!record) {
        throw new Error(`Memory not found: ${id}`);
      }
      const updated = await knowledge.upsertRecord({
        id,
        text: content,
        collection: record.collection,
        attributes: record.attributes,
      });
      return toMemory(updated);
    },

    async forget(id) {
      await knowledge.deleteRecord(id);
    },
  };
}
