import type { EmbeddingService } from "./embedding-service.js";

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * OpenAI Embeddings API implementation of EmbeddingService.
 *
 * Uses `text-embedding-3-small` by default.
 */
export function createOpenAIEmbeddingService(config: OpenAIEmbeddingConfig): EmbeddingService {
  const {
    apiKey,
    model = "text-embedding-3-small",
    baseUrl = "https://api.openai.com/v1/embeddings",
  } = config;

  return {
    async embed(text: string): Promise<number[]> {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: [text], model }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${body}`);
      }

      const json = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      if (!json.data || json.data.length === 0) {
        throw new Error("No embedding returned from OpenAI");
      }

      return json.data[0].embedding;
    },
  };
}
