// ha/signal-store.ts — sensor signal ring store on its own sqlite file
// (separate from journal.db). WAL by default, incremental auto-vacuum so
// pruned pages are actually returned to the OS.

import Database from "better-sqlite3";

export type SignalOrigin = "ha" | "resync" | "backfill";

export interface NormalizedValue {
  value: number | string | boolean | null; // null = unavailable/unknown
  unit: string | null;
}

export interface SignalRow {
  obsId: string;        // ULID
  entityId: string;
  at: number;           // ms epoch, bridge receipt time
  haTimeFired: number;  // ms epoch from HA event
  raw: unknown;         // the full HaEntityState (new state) as JSON
  normalized: NormalizedValue;
  origin: SignalOrigin;
  haVersion: string | null;
  policyVersion: number;
}

export interface SignalQuery {
  entityId: string;
  sinceMs?: number;   // inclusive
  untilMs?: number;   // exclusive
  limit?: number;     // default 500, max 5000
  order?: "asc" | "desc"; // default "asc" (sparkline order)
}

export interface SignalStoreStats { rows: number; oldestAt: number | null; newestAt: number | null; dbBytes: number; }

export interface SignalStore {
  append(row: SignalRow): void;
  query(q: SignalQuery): SignalRow[];
  latest(entityId: string): SignalRow | undefined;
  /** Delete rows with at < now - retentionDays*864e5. Returns deleted count. */
  prune(retentionDays: number): number;
  stats(): SignalStoreStats;
  close(): void;
  readonly db: Database.Database;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS signals (
  obs_id        TEXT NOT NULL PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  at            INTEGER NOT NULL,
  ha_time_fired INTEGER NOT NULL,
  raw           TEXT NOT NULL,
  norm_value    TEXT,              -- JSON.stringify of the scalar (null stored as SQL NULL)
  norm_unit     TEXT,
  origin        TEXT NOT NULL,
  ha_version    TEXT,
  policy_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_entity_at ON signals(entity_id, at);
CREATE INDEX IF NOT EXISTS idx_signals_at ON signals(at);
`;

interface RawSignalRow {
  obs_id: string;
  entity_id: string;
  at: number;
  ha_time_fired: number;
  raw: string;
  norm_value: string | null;
  norm_unit: string | null;
  origin: string;
  ha_version: string | null;
  policy_version: number;
}

function mapRow(r: RawSignalRow): SignalRow {
  return {
    obsId: r.obs_id,
    entityId: r.entity_id,
    at: r.at,
    haTimeFired: r.ha_time_fired,
    raw: JSON.parse(r.raw),
    normalized: {
      value: r.norm_value === null ? null : (JSON.parse(r.norm_value) as number | string | boolean),
      unit: r.norm_unit,
    },
    origin: r.origin as SignalOrigin,
    haVersion: r.ha_version,
    policyVersion: r.policy_version,
  };
}

export function createSignalStore(opts: { path: string; wal?: boolean }): SignalStore {
  const db = new Database(opts.path);

  // auto_vacuum must be set BEFORE the first table is created to take effect
  // on a fresh database file.
  db.pragma("auto_vacuum = INCREMENTAL");
  if (opts.wal !== false) {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA_SQL);

  const insertStmt = db.prepare(`
    INSERT INTO signals (obs_id, entity_id, at, ha_time_fired, raw, norm_value, norm_unit, origin, ha_version, policy_version)
    VALUES (@obs_id, @entity_id, @at, @ha_time_fired, @raw, @norm_value, @norm_unit, @origin, @ha_version, @policy_version)
  `);
  const latestStmt = db.prepare(
    "SELECT * FROM signals WHERE entity_id = ? ORDER BY at DESC, obs_id DESC LIMIT 1",
  );
  const pruneStmt = db.prepare("DELETE FROM signals WHERE at < ?");
  const statsStmt = db.prepare(
    "SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest FROM signals",
  );

  return {
    db,

    append(row: SignalRow): void {
      insertStmt.run({
        obs_id: row.obsId,
        entity_id: row.entityId,
        at: row.at,
        ha_time_fired: row.haTimeFired,
        raw: JSON.stringify(row.raw ?? null),
        norm_value: row.normalized.value === null ? null : JSON.stringify(row.normalized.value),
        norm_unit: row.normalized.unit,
        origin: row.origin,
        ha_version: row.haVersion,
        policy_version: row.policyVersion,
      });
    },

    query(q: SignalQuery): SignalRow[] {
      const where: string[] = ["entity_id = ?"];
      const params: unknown[] = [q.entityId];
      if (q.sinceMs !== undefined) {
        where.push("at >= ?");
        params.push(q.sinceMs);
      }
      if (q.untilMs !== undefined) {
        where.push("at < ?");
        params.push(q.untilMs);
      }
      const order = q.order ?? "asc";
      // Clamp BOTH ends: SQLite treats a negative LIMIT as "no limit".
      const limit = Math.max(1, Math.min(q.limit ?? 500, 5000));
      const dir = order === "asc" ? "ASC" : "DESC";
      const sql = `SELECT * FROM signals WHERE ${where.join(" AND ")} ORDER BY at ${dir}, obs_id ${dir} LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as RawSignalRow[];
      return rows.map(mapRow);
    },

    latest(entityId: string): SignalRow | undefined {
      const row = latestStmt.get(entityId) as RawSignalRow | undefined;
      return row === undefined ? undefined : mapRow(row);
    },

    prune(retentionDays: number): number {
      const cutoff = Date.now() - retentionDays * 864e5;
      const result = pruneStmt.run(cutoff);
      db.pragma("incremental_vacuum(2000)");
      return result.changes;
    },

    stats(): SignalStoreStats {
      const r = statsStmt.get() as { rows: number; oldest: number | null; newest: number | null };
      const pageCount = db.pragma("page_count", { simple: true }) as number;
      const pageSize = db.pragma("page_size", { simple: true }) as number;
      return {
        rows: r.rows,
        oldestAt: r.oldest,
        newestAt: r.newest,
        dbBytes: pageCount * pageSize,
      };
    },

    close(): void {
      db.close();
    },
  };
}
