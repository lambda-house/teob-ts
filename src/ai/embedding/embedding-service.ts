/**
 * Provider-agnostic interface for generating vector embeddings from text.
 */
export interface EmbeddingService {
  /** Embed a text string into a vector representation. */
  embed(text: string): Promise<number[]>;
}
