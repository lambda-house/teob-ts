import type { MCPTool, MCPToolResult } from "../tool/types.js";
import { MCPToolResult as MCPToolResultFactory } from "../tool/types.js";
import type { KnowledgeAPI, KnowledgeFilter } from "./knowledge-api.js";

/** Knowledge collection descriptor for tool configuration. */
export interface KnowledgeCollection {
  name: string;
  description: string;
}

/**
 * MCP tool bridging KnowledgeAPI to the tool registry.
 * Provides semantic search over the knowledge base as an agent tool.
 */
export function createKnowledgeSearchTool(
  knowledgeAPI: KnowledgeAPI,
  collections: KnowledgeCollection[] = [],
): MCPTool {
  const baseDesc =
    "Search the knowledge base for relevant information. Use English for the query regardless of user language. Omit query to browse/list all entries in a collection.";

  const description = collections.length === 0
    ? baseDesc
    : `${baseDesc}\n\nAvailable collections:\n${collections.map((c) => `  - ${c.name}: ${c.description}`).join("\n")}`;

  const collectionSchema = collections.length === 0
    ? { type: "string", description: "Collection to search in" }
    : { type: "string", enum: collections.map((c) => c.name), description: "Collection to search in" };

  const inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query in English. Omit to browse/list all entries.",
      },
      collection: collectionSchema,
      attributes: {
        type: "object",
        description: "Filter by metadata attributes",
      },
      limit: {
        type: "integer",
        default: 5,
        description: "Maximum results",
      },
    },
    required: [] as string[],
  };

  return {
    name: "knowledge_search",
    description,
    inputSchema,

    async execute(input: unknown): Promise<MCPToolResult> {
      try {
        const params = input as Record<string, unknown>;
        const query = typeof params.query === "string" && params.query.length > 0
          ? params.query
          : undefined;
        const collection = typeof params.collection === "string" ? params.collection : undefined;
        const attributes = (params.attributes as Record<string, string>) ?? {};
        const limit = typeof params.limit === "number" ? params.limit : 5;

        const filter: KnowledgeFilter | undefined =
          collection !== undefined || Object.keys(attributes).length > 0
            ? { collection, attributes }
            : undefined;

        const records = query !== undefined
          ? await knowledgeAPI.findBestMatches(query, filter, limit, 0.6)
          : await knowledgeAPI.viewRecords(filter, undefined, limit);

        const results = records.map((r) => ({
          id: r.id,
          text: r.text,
          collection: r.collection,
          attributes: r.attributes,
          similarity: r.similarity,
        }));

        return MCPToolResultFactory.success(results);
      } catch (err) {
        return MCPToolResultFactory.failure(
          `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
