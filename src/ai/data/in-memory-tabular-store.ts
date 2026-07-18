import type {
  ColumnDef,
  FilterCondition,
  Row,
  RowFilter,
  TableInfo,
  TableSchema,
  TabularStore,
} from "./tabular-store.js";

/**
 * Thread-safe in-memory tabular store.
 */
export function createInMemoryTabularStore(): TabularStore {
  const tables = new Map<string, Row[]>();
  let idCounter = 0;

  function matchesCondition(row: Row, cond: FilterCondition): boolean {
    const val = row.data[cond.column];

    switch (cond.op) {
      case "eq":
        return val === cond.value;
      case "neq":
        return val !== cond.value;
      case "gt":
        return typeof val === "number" && typeof cond.value === "number" && val > cond.value;
      case "lt":
        return typeof val === "number" && typeof cond.value === "number" && val < cond.value;
      case "gte":
        return typeof val === "number" && typeof cond.value === "number" && val >= cond.value;
      case "lte":
        return typeof val === "number" && typeof cond.value === "number" && val <= cond.value;
      case "contains":
        return typeof val === "string" && typeof cond.value === "string" && val.includes(cond.value);
      case "in":
        return Array.isArray(cond.value) && cond.value.includes(val);
      default:
        return false;
    }
  }

  function matchesFilter(row: Row, filter: RowFilter): boolean {
    return filter.conditions.every((c) => matchesCondition(row, c));
  }

  function ensureTable(name: string): Row[] {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    return rows;
  }

  return {
    async listTables(): Promise<TableInfo[]> {
      return [...tables.entries()].map(([name, rows]) => {
        const columns = rows.length > 0 ? Object.keys(rows[0].data) : [];
        return { name, rowCount: rows.length, columns };
      });
    },

    async query(table: string, filter?: RowFilter, limit?: number): Promise<Row[]> {
      const rows = tables.get(table) ?? [];
      let result = filter ? rows.filter((r) => matchesFilter(r, filter)) : [...rows];
      if (limit !== undefined) result = result.slice(0, limit);
      return result;
    },

    async append(table: string, data: Record<string, unknown>): Promise<Row> {
      const rows = ensureTable(table);
      const row: Row = { id: String(++idCounter), data };
      rows.push(row);
      return row;
    },

    async update(table: string, filter: RowFilter, updates: Record<string, unknown>): Promise<number> {
      const rows = tables.get(table) ?? [];
      let count = 0;
      for (const row of rows) {
        if (matchesFilter(row, filter)) {
          Object.assign(row.data, updates);
          count++;
        }
      }
      return count;
    },

    async delete(table: string, filter: RowFilter): Promise<number> {
      const rows = tables.get(table);
      if (!rows) return 0;
      const before = rows.length;
      const remaining = rows.filter((r) => !matchesFilter(r, filter));
      tables.set(table, remaining);
      return before - remaining.length;
    },

    async schema(table: string): Promise<TableSchema | undefined> {
      const rows = tables.get(table);
      if (!rows || rows.length === 0) return undefined;
      const columns: ColumnDef[] = Object.entries(rows[0].data).map(([name, val]) => ({
        name,
        type: typeof val,
      }));
      return { columns };
    },
  };
}
