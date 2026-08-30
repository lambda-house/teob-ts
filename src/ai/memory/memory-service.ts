/** Type of memory stored by an agent. */
export type MemoryType = "user" | "feedback" | "domain" | "reference";

/** A memory record persisted by the memory service. */
export interface Memory {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  metadata: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

/** Query parameters for recalling memories. */
export interface MemoryQuery {
  agentId: string;
  memoryType?: MemoryType;
  semanticQuery?: string;
  /** Maximum number of results (default 10). */
  limit?: number;
}

/** Service for storing and recalling agent memories. */
export interface MemoryService {
  /** Store a new memory. */
  store(agentId: string, memoryType: MemoryType, content: string, metadata?: Record<string, string>): Promise<Memory>;

  /** Recall memories matching a query. */
  recall(query: MemoryQuery): Promise<Memory[]>;

  /** Update an existing memory's content. */
  update(id: string, content: string): Promise<Memory>;

  /** Delete a memory by ID. */
  forget(id: string): Promise<void>;
}
