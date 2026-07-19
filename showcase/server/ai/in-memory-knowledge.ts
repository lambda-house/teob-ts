/**
 * In-memory KnowledgeAPI implementation for the showcase.
 *
 * Uses simple word-overlap scoring instead of real vector embeddings.
 * Sufficient for demonstrating the RAG pattern without external dependencies.
 */

import type {
  KnowledgeAPI,
  KnowledgeFilter,
  KnowledgeRecord,
  KnowledgeRecordInput,
  KnowledgeRecordExport,
} from "../../../src/ai/knowledge/knowledge-api.js";

function textScore(query: string, text: string): number {
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const textLower = text.toLowerCase();
  if (queryWords.length === 0) return 0;
  const matches = queryWords.filter((w) => textLower.includes(w)).length;
  return matches / queryWords.length;
}

function matchesFilter(record: KnowledgeRecord, filter?: KnowledgeFilter): boolean {
  if (!filter) return true;
  if (filter.collection && record.collection !== filter.collection) return false;
  if (filter.attributes) {
    for (const [k, v] of Object.entries(filter.attributes)) {
      if (record.attributes[k] !== v) return false;
    }
  }
  return true;
}

export function createInMemoryKnowledgeAPI(): KnowledgeAPI {
  const records = new Map<string, KnowledgeRecord>();

  return {
    async findBestMatches(
      userQuery: string,
      filter?: KnowledgeFilter,
      limit = 5,
      similarityThreshold = 0.3,
    ): Promise<KnowledgeRecord[]> {
      const scored: Array<KnowledgeRecord & { similarity: number }> = [];
      for (const record of records.values()) {
        if (!matchesFilter(record, filter)) continue;
        const score = textScore(userQuery, record.text);
        if (score >= similarityThreshold) {
          scored.push({ ...record, similarity: score });
        }
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit);
    },

    async viewRecords(
      filter?: KnowledgeFilter,
      exactWord?: string,
      limit = 10,
    ): Promise<KnowledgeRecord[]> {
      const results: KnowledgeRecord[] = [];
      for (const record of records.values()) {
        if (!matchesFilter(record, filter)) continue;
        if (exactWord && !record.text.toLowerCase().includes(exactWord.toLowerCase())) continue;
        results.push(record);
        if (results.length >= limit) break;
      }
      return results;
    },

    async upsertRecord(input: KnowledgeRecordInput): Promise<KnowledgeRecord> {
      const now = new Date();
      const existing = records.get(input.id);
      const record: KnowledgeRecord = {
        id: input.id,
        text: input.text,
        collection: input.collection,
        attributes: input.attributes ?? {},
        checksum: input.checksum ?? simpleChecksum(input.text),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      records.set(input.id, record);
      return record;
    },

    async deleteRecord(id: string): Promise<boolean> {
      return records.delete(id);
    },

    async deleteCollection(collection: string): Promise<number> {
      let count = 0;
      for (const [id, record] of records) {
        if (record.collection === collection) {
          records.delete(id);
          count++;
        }
      }
      return count;
    },

    async exportCollection(collection: string): Promise<KnowledgeRecordExport[]> {
      const exports: KnowledgeRecordExport[] = [];
      for (const record of records.values()) {
        if (record.collection === collection) {
          exports.push({
            id: record.id,
            text: record.text,
            collection: record.collection,
            attributes: record.attributes,
          });
        }
      }
      return exports;
    },

    async importRecords(
      inputs: KnowledgeRecordExport[],
      _computeVectors: boolean,
    ): Promise<[number, number]> {
      let imported = 0;
      let skipped = 0;
      for (const input of inputs) {
        if (records.has(input.id)) {
          skipped++;
        } else {
          await this.upsertRecord({
            id: input.id,
            text: input.text,
            collection: input.collection,
            attributes: input.attributes,
          });
          imported++;
        }
      }
      return [imported, skipped];
    },

    async recomputeVector(id: string): Promise<KnowledgeRecord | undefined> {
      return records.get(id);
    },
  };
}

function simpleChecksum(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Pre-seed knowledge base with framework documentation. */
export async function seedKnowledge(api: KnowledgeAPI): Promise<void> {
  const docs = [
    {
      id: "teob-overview",
      text: "TEOB-TS is a TypeScript event-sourcing and CQRS framework. It provides type-safe, composable abstractions for building event-sourced entities. The core pattern is the Aggregate: define initial state, a decide function (command → events), and an apply function (state + event → state).",
      collection: "framework-docs",
      attributes: { topic: "overview" },
    },
    {
      id: "teob-effects",
      text: "Effects in TEOB are declarative descriptions of what should happen after a command is processed. The Effect ADT includes: Persist (save events), Run (execute side effects), Reply (send a response), Snapshot (create state snapshot), Stop (terminate entity), Stash/Unstash (defer commands). Effects are chainable: persist(...).andRun(...).andReply(...).",
      collection: "framework-docs",
      attributes: { topic: "effects" },
    },
    {
      id: "teob-petrinet",
      text: "The Petri Net module models multi-step workflows as flows of tokens through places and transitions. Places hold tokens, transitions consume tokens from one place and produce tokens to other places. flowAggregate() wraps a Petri Net schema into a standard TEOB Aggregate, allowing it to be managed by the EntityRuntime like any other entity.",
      collection: "framework-docs",
      attributes: { topic: "petrinet" },
    },
    {
      id: "teob-runtimes",
      text: "TEOB provides two runtime backends: InMemoryRuntime for testing and development (no external dependencies), and PostgresRuntime for production (with event journal, snapshots, and LISTEN/NOTIFY for event streaming). Both implement the same EntityRuntime interface.",
      collection: "framework-docs",
      attributes: { topic: "runtimes" },
    },
    {
      id: "teob-testing",
      text: "AggregateTestKit provides a synchronous test harness for aggregates. It runs commands against an aggregate and returns structured CommandResult objects with events, reply, and side effects. No database or Docker needed — tests run in milliseconds.",
      collection: "framework-docs",
      attributes: { topic: "testing" },
    },
    {
      id: "teob-ai",
      text: "The AI module integrates LLM capabilities into TEOB applications. It provides: LLMService (chat completions with tool support), EmbeddingService (vector embeddings), MCPToolRegistry (tool registration and execution), KnowledgeAPI (RAG pattern with semantic search), and AgentRunnerClient (remote agent orchestration via WebSocket).",
      collection: "framework-docs",
      attributes: { topic: "ai" },
    },
    {
      id: "showcase-gift-card",
      text: "The Gift Card showcase demonstrates a stateful aggregate with lifecycle management. A gift card starts Empty, becomes Active when issued with a balance, and can be Redeemed (debited) or Cancelled. Invariants ensure balance never goes negative and cancelled cards have zero balance.",
      collection: "faq",
      attributes: { topic: "gift-card" },
    },
    {
      id: "showcase-signup",
      text: "The Signup Flow showcase demonstrates Petri Net workflows. When a user signs up, a SignupRequested token enters the Pending place. The ValidateEmail transition checks email availability: if available, it produces an EmailValidated token; if taken, an EmailTaken token. The CreateAccount transition then creates the account, producing an AccountCreated token at the Completed place.",
      collection: "faq",
      attributes: { topic: "signup-flow" },
    },
  ];

  for (const doc of docs) {
    await api.upsertRecord(doc);
  }
}
