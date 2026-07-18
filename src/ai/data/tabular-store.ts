/** A row in a tabular store. */
export interface Row {
  id: string;
  data: Record<string, unknown>;
}

/** Information about a table. */
export interface TableInfo {
  name: string;
  rowCount: number;
  columns: string[];
}

/** Column definition. */
export interface ColumnDef {
  name: string;
  type: string;
}

/** Table schema. */
export interface TableSchema {
  columns: ColumnDef[];
}

/** Filter operators. */
export type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains" | "in";

/** A single filter condition. */
export interface FilterCondition {
  column: string;
  op: FilterOp;
  value: unknown;
}

/** Composite filter (AND of all conditions). */
export interface RowFilter {
  conditions: FilterCondition[];
}

/** Row-based structured data store (complements vector search). */
export interface TabularStore {
  listTables(): Promise<TableInfo[]>;
  query(table: string, filter?: RowFilter, limit?: number): Promise<Row[]>;
  append(table: string, data: Record<string, unknown>): Promise<Row>;
  update(table: string, filter: RowFilter, updates: Record<string, unknown>): Promise<number>;
  delete(table: string, filter: RowFilter): Promise<number>;
  schema(table: string): Promise<TableSchema | undefined>;
}
