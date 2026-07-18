/** Filter for knowledge queries. */
export interface KnowledgeFilter {
  collection?: string;
  attributes?: Record<string, string>;
}

/** Input for creating/updating a knowledge record. */
export interface KnowledgeRecordInput {
  id: string;
  text: string;
  collection: string;
  attributes?: Record<string, string>;
  checksum?: string;
  vector?: number[];
}

/** A knowledge record with its vector embedding and metadata. */
export interface KnowledgeRecord {
  id: string;
  text: string;
  collection: string;
  attributes: Record<string, string>;
  checksum: string;
  vectorChecksum?: string;
  vector?: number[];
  createdAt: Date;
  updatedAt: Date;
  similarity?: number;
}

/** Whether the vector is in sync with current text. */
export function vectorInSync(record: KnowledgeRecord): boolean {
  return record.vectorChecksum !== undefined && record.vectorChecksum === record.checksum;
}

/** Export format for knowledge records (without vector/timestamps). */
export interface KnowledgeRecordExport {
  id: string;
  text: string;
  collection: string;
  attributes: Record<string, string>;
}

/**
 * Abstract Knowledge API for the RAG (Retrieval-Augmented Generation) pattern.
 *
 * Knowledge is organized into collections. Each record belongs to a collection
 * and can have arbitrary key-value attributes for filtering.
 */
export interface KnowledgeAPI {
  /** Find best matching records using vector similarity and optional filtering. */
  findBestMatches(
    userQuery: string,
    filter?: KnowledgeFilter,
    limit?: number,
    similarityThreshold?: number,
    vectorWeight?: number,
    textWeight?: number,
  ): Promise<KnowledgeRecord[]>;

  /** View knowledge records with optional filtering. */
  viewRecords(
    filter?: KnowledgeFilter,
    exactWord?: string,
    limit?: number,
  ): Promise<KnowledgeRecord[]>;

  /** Upsert a knowledge record (insert or update). Automatically computes embedding. */
  upsertRecord(record: KnowledgeRecordInput): Promise<KnowledgeRecord>;

  /** Delete a knowledge record by ID. Returns true if deleted. */
  deleteRecord(id: string): Promise<boolean>;

  /** Delete all records in a collection. Returns count deleted. */
  deleteCollection(collection: string): Promise<number>;

  /** Export all records in a collection (without vectors). */
  exportCollection(collection: string): Promise<KnowledgeRecordExport[]>;

  /** Import records. Returns [imported, skipped]. */
  importRecords(records: KnowledgeRecordExport[], computeVectors: boolean): Promise<[number, number]>;

  /** Recompute the embedding vector for a record. */
  recomputeVector(id: string): Promise<KnowledgeRecord | undefined>;
}
