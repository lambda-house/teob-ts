import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJournal, type SqliteJournal } from "../src/sqlite/journal.js";
import { createSqliteRuntime, registration } from "../src/sqlite/index.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { persist, andReply } from "../src/core/effect.js";
import { categoryTypes } from "../src/core/effect-control.js";
import type { Aggregate } from "../src/core/aggregate.js";
import { ulid } from "../src/core/ulid.js";
import { stampEnvelope, type EventEnvelope, type PersistedBatch } from "../src/core/envelope.js";

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

type Evt = { tag: "Happened"; n: number };
const eventCodec = tagCodec<Evt>("Happened");

const env = (over: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: ulid(),
  v: 1,
  ...over,
});

let dir: string;
let journal: SqliteJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teob-env-"));
  journal = createSqliteJournal({ path: join(dir, "journal.db") });
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

function persistOne(
  category: string,
  entityId: string,
  seq: number,
  n: number,
  envelope?: EventEnvelope,
): EventEnvelope | undefined {
  journal.persistEvents(
    CategoryId(category),
    EntityId(entityId),
    [{ tag: "Happened", n }],
    SequenceNr(seq),
    eventCodec,
    envelope === undefined ? undefined : [envelope],
  );
  return envelope;
}

// --- schema / migration ---

describe("sqlite journal envelope schema", () => {
  it("fresh db has the five envelope columns and indexes", () => {
    const cols = (journal.db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const c of ["event_id", "causation_id", "correlation_id", "origin", "env_v"]) {
      expect(cols).toContain(c);
    }
    const indexes = (journal.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='journal'")
      .all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_journal_event_id");
    expect(indexes).toContain("idx_journal_causation");
    expect(indexes).toContain("idx_journal_ts");
  });

  it("migrates a pre-envelope db in place; old rows read envelope: null, new writes carry envelopes", () => {
    // Old (pre-envelope) schema, copied verbatim from the pre-change SCHEMA_SQL.
    const OLD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal (
  persistence_id TEXT NOT NULL,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (persistence_id, sequence_nr)
);

CREATE TABLE IF NOT EXISTS snapshots (
  persistence_id TEXT NOT NULL PRIMARY KEY,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch())
);
`;
    const oldPath = join(dir, "old.db");
    const oldDb = new Database(oldPath);
    oldDb.exec(OLD_SCHEMA_SQL);
    oldDb
      .prepare("INSERT INTO journal (persistence_id, sequence_nr, manifest, payload) VALUES (?, ?, ?, ?)")
      .run("legacy:e1", 1, "Happened", JSON.stringify({ tag: "Happened", n: 42 }));
    oldDb.close();

    // Reopen through createSqliteJournal — migration must run.
    const migrated = createSqliteJournal({ path: oldPath });
    try {
      const cols = (migrated.db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const c of ["event_id", "causation_id", "correlation_id", "origin", "env_v"]) {
        expect(cols).toContain(c);
      }

      // Old row: still loads via the classic path and reads envelope: null via the query path.
      const loaded = migrated.loadEvents(CategoryId("legacy"), EntityId("e1"), SequenceNr(0), eventCodec);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].event).toEqual({ tag: "Happened", n: 42 });

      const oldRows = migrated.queryEvents({ category: "legacy" });
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0].envelope).toBeNull();
      expect(oldRows[0].payload).toEqual({ tag: "Happened", n: 42 });
      expect(oldRows[0].manifest).toBe("Happened");
      expect(oldRows[0].sequenceNr).toBe(1);
      expect(typeof oldRows[0].ts).toBe("number");

      // New write on the migrated db carries an envelope.
      const e = env({ causationId: "cause-1", origin: "nodered" });
      migrated.persistEvents(
        CategoryId("legacy"),
        EntityId("e1"),
        [{ tag: "Happened", n: 43 }],
        SequenceNr(1),
        eventCodec,
        [e],
      );
      const all = migrated.queryEvents({ category: "legacy", order: "asc" });
      expect(all).toHaveLength(2);
      expect(all[0].envelope).toBeNull();
      expect(all[1].envelope).toEqual({ eventId: e.eventId, v: 1, causationId: "cause-1", origin: "nodered" });

      // Reopening a second time is a no-op (idempotent migration).
      migrated.close();
      const reopened = createSqliteJournal({ path: oldPath });
      expect(reopened.queryEvents({ category: "legacy" })).toHaveLength(2);
      reopened.close();
    } finally {
      try {
        migrated.close();
      } catch {}
    }
  });

  it("repairs a half-migrated db (crash between the per-column ALTERs)", () => {
    // Simulate a crash after only the first ALTER ran: event_id exists, the
    // other four envelope columns do not. A sentinel-only guard would skip the
    // migration forever and every subsequent persist would fail with
    // "table journal has no column named causation_id".
    const OLD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal (
  persistence_id TEXT NOT NULL,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (persistence_id, sequence_nr)
);

CREATE TABLE IF NOT EXISTS snapshots (
  persistence_id TEXT NOT NULL PRIMARY KEY,
  sequence_nr    INTEGER NOT NULL,
  manifest       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  timestamp      INTEGER NOT NULL DEFAULT (unixepoch())
);
`;
    const halfPath = join(dir, "half.db");
    const halfDb = new Database(halfPath);
    halfDb.exec(OLD_SCHEMA_SQL);
    halfDb.exec("ALTER TABLE journal ADD COLUMN event_id TEXT");
    halfDb.close();

    const repaired = createSqliteJournal({ path: halfPath });
    try {
      const cols = (repaired.db.prepare("PRAGMA table_info(journal)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const c of ["event_id", "causation_id", "correlation_id", "origin", "env_v"]) {
        expect(cols).toContain(c);
      }
      // Persisting with an envelope works — the missing columns were added.
      const e = env({ causationId: "cause-x" });
      repaired.persistEvents(
        CategoryId("repaired"),
        EntityId("e1"),
        [{ tag: "Happened", n: 1 }],
        SequenceNr(0),
        eventCodec,
        [e],
      );
      const rows = repaired.queryEvents({ category: "repaired" });
      expect(rows).toHaveLength(1);
      expect(rows[0].envelope).toEqual({ eventId: e.eventId, v: 1, causationId: "cause-x" });
    } finally {
      repaired.close();
    }
  });

  it("persistEvents without envelopes stores NULL columns (envelope: null on read)", () => {
    persistOne("cat", "e1", 0, 1);
    const rows = journal.queryEvents({});
    expect(rows).toHaveLength(1);
    expect(rows[0].envelope).toBeNull();
  });
});

// --- queryEvents ---

describe("queryEvents", () => {
  it("returns rows with envelope fields, omitting absent optionals", () => {
    const full = env({ causationId: "c1", correlationId: "corr1", origin: "ha" });
    const minimal = env();
    persistOne("cat", "e1", 0, 1, full);
    persistOne("cat", "e1", 1, 2, minimal);

    const rows = journal.queryEvents({ order: "asc" });
    expect(rows).toHaveLength(2);
    expect(rows[0].envelope).toEqual({ eventId: full.eventId, v: 1, causationId: "c1", correlationId: "corr1", origin: "ha" });
    expect(rows[1].envelope).toEqual({ eventId: minimal.eventId, v: 1 });
    expect(Object.keys(rows[1].envelope!).sort()).toEqual(["eventId", "v"]);
  });

  it("defaults to desc (timeline) order with strictly increasing globalSeq", () => {
    for (let i = 0; i < 3; i++) persistOne("cat", "e1", i, i + 1, env());
    const rows = journal.queryEvents({});
    expect(rows.map((r) => r.sequenceNr)).toEqual([3, 2, 1]);
    expect(rows[0].globalSeq).toBeGreaterThan(rows[1].globalSeq);
    expect(rows[1].globalSeq).toBeGreaterThan(rows[2].globalSeq);
  });

  it("filters by category and splits persistence_id on the FIRST colon", () => {
    persistOne("cat", "dev:1", 0, 1, env());
    persistOne("other", "e1", 0, 2, env());

    const rows = journal.queryEvents({ category: "cat" });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("cat");
    expect(rows[0].entityId).toBe("dev:1"); // entity id containing ":" survives
  });

  it("filters by entityId (exact persistence id)", () => {
    persistOne("cat", "e1", 0, 1, env());
    persistOne("cat", "e2", 0, 2, env());

    const rows = journal.queryEvents({ category: "cat", entityId: "e2" });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe("e2");
    expect(rows[0].payload).toEqual({ tag: "Happened", n: 2 });
  });

  it("throws when entityId is given without category", () => {
    expect(() => journal.queryEvents({ entityId: "e1" })).toThrow(/category/);
  });

  it("paginates desc with an exclusive cursor", () => {
    for (let i = 0; i < 5; i++) persistOne("cat", "e1", i, i + 1, env());

    const page1 = journal.queryEvents({ limit: 2 });
    expect(page1.map((r) => r.sequenceNr)).toEqual([5, 4]);

    const page2 = journal.queryEvents({ limit: 2, cursor: page1[1].globalSeq });
    expect(page2.map((r) => r.sequenceNr)).toEqual([3, 2]);

    const page3 = journal.queryEvents({ limit: 2, cursor: page2[1].globalSeq });
    expect(page3.map((r) => r.sequenceNr)).toEqual([1]);
  });

  it("asc order uses cursor as exclusive lower bound", () => {
    for (let i = 0; i < 4; i++) persistOne("cat", "e1", i, i + 1, env());
    const first = journal.queryEvents({ order: "asc", limit: 2 });
    expect(first.map((r) => r.sequenceNr)).toEqual([1, 2]);
    const rest = journal.queryEvents({ order: "asc", cursor: first[1].globalSeq });
    expect(rest.map((r) => r.sequenceNr)).toEqual([3, 4]);
  });

  it("sinceMs is an inclusive lower bound converted to seconds", () => {
    persistOne("cat", "e1", 0, 1, env());
    persistOne("cat", "e1", 1, 2, env());
    // Backdate the first row by 10000 seconds.
    journal.db.prepare("UPDATE journal SET timestamp = timestamp - 10000 WHERE sequence_nr = 1").run();

    const rows = journal.queryEvents({ sinceMs: Date.now() - 5000 * 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].sequenceNr).toBe(2);

    const all = journal.queryEvents({ sinceMs: Date.now() - 20000 * 1000 });
    expect(all).toHaveLength(2);
  });

  it("filters by causationId and correlationId", () => {
    persistOne("cat", "e1", 0, 1, env({ causationId: "obs-1" }));
    persistOne("cat", "e1", 1, 2, env({ causationId: "obs-2", correlationId: "flow-1" }));
    persistOne("cat", "e1", 2, 3, env({ correlationId: "flow-1" }));

    const byCause = journal.queryEvents({ causationId: "obs-2" });
    expect(byCause).toHaveLength(1);
    expect(byCause[0].sequenceNr).toBe(2);

    const byCorr = journal.queryEvents({ correlationId: "flow-1", order: "asc" });
    expect(byCorr.map((r) => r.sequenceNr)).toEqual([2, 3]);

    expect(journal.queryEvents({ causationId: "missing" })).toEqual([]);
  });

  it("clamps limit into [1, 1000] and defaults to 100", () => {
    const events: Evt[] = Array.from({ length: 1200 }, (_, i) => ({ tag: "Happened", n: i }));
    const envelopes = events.map(() => env());
    journal.persistEvents(CategoryId("bulk"), EntityId("e1"), events, SequenceNr(0), eventCodec, envelopes);

    expect(journal.queryEvents({})).toHaveLength(100);
    expect(journal.queryEvents({ limit: 5000 })).toHaveLength(1000);
    expect(journal.queryEvents({ limit: 7 })).toHaveLength(7);
    // SQLite treats LIMIT -1 as "no limit" — a negative limit must never dump the journal.
    expect(journal.queryEvents({ limit: -1 })).toHaveLength(1);
    expect(journal.queryEvents({ limit: 0 })).toHaveLength(1);
  });
});

// --- eventByEventId / causationChain / lastGlobalSeq ---

describe("eventByEventId and causationChain", () => {
  it("eventByEventId finds a row or returns undefined", () => {
    const e = env({ origin: "ha" });
    persistOne("cat", "e1", 0, 1, e);

    const row = journal.eventByEventId(e.eventId);
    expect(row).toBeDefined();
    expect(row!.envelope!.eventId).toBe(e.eventId);
    expect(row!.payload).toEqual({ tag: "Happened", n: 1 });

    expect(journal.eventByEventId("01UNKNOWNUNKNOWNUNKNOWNUNK")).toBeUndefined();
  });

  it("walks a 3-link causation chain, self first, terminating at a non-event causation id", () => {
    const e1 = env({ causationId: "ha-ctx-abc" }); // caused by an HA context id, not an event
    persistOne("cat", "e1", 0, 1, e1);
    const e2 = env({ causationId: e1.eventId });
    persistOne("cat", "e1", 1, 2, e2);
    const e3 = env({ causationId: e2.eventId });
    persistOne("cat", "e1", 2, 3, e3);

    const chain = journal.causationChain(e3.eventId);
    expect(chain.map((r) => r.envelope!.eventId)).toEqual([e3.eventId, e2.eventId, e1.eventId]);
    // e1's causation id is an HA context id — chain stops there, correct behavior.
    expect(chain[2].envelope!.causationId).toBe("ha-ctx-abc");
  });

  it("stops at maxDepth", () => {
    const e1 = env();
    persistOne("cat", "e1", 0, 1, e1);
    const e2 = env({ causationId: e1.eventId });
    persistOne("cat", "e1", 1, 2, e2);
    const e3 = env({ causationId: e2.eventId });
    persistOne("cat", "e1", 2, 3, e3);

    const chain = journal.causationChain(e3.eventId, { maxDepth: 2 });
    expect(chain.map((r) => r.envelope!.eventId)).toEqual([e3.eventId, e2.eventId]);
  });

  it("returns [] for an unknown event id and a single row for a cause-less event", () => {
    expect(journal.causationChain("NOPE")).toEqual([]);
    const e = env();
    persistOne("cat", "e1", 0, 1, e);
    expect(journal.causationChain(e.eventId)).toHaveLength(1);
  });
});

describe("lastGlobalSeq", () => {
  it("is 0 when empty and MAX(rowid) after writes", () => {
    expect(journal.lastGlobalSeq()).toBe(0);
    persistOne("cat", "e1", 0, 1, env());
    persistOne("cat", "e1", 1, 2, env());
    expect(journal.lastGlobalSeq()).toBe(2);
    const rows = journal.queryEvents({ limit: 1 });
    expect(rows[0].globalSeq).toBe(2);
  });
});

// --- end-to-end through the sqlite runtime ---

type Cmd = { tag: "Record"; note: string; causationId: string };
type Reply = { tag: "Ok" };
type State = { count: number };
type AuditEvt = { tag: "Recorded"; note: string };

const auditAggregate: Aggregate<Cmd, Reply, AuditEvt, State> = {
  category: CategoryId("env-audit"),
  initial: () => ({ count: 0 }),
  async decide(_state, command) {
    return andReply(
      persist(
        stampEnvelope(
          { tag: "Recorded", note: command.note },
          { causationId: command.causationId, origin: "nodered" },
        ),
      ),
      { tag: "Ok" },
    );
  },
  apply(state) {
    return { count: state.count + 1 };
  },
};

const auditEvtCodec = tagCodec<AuditEvt>("Recorded");
const auditStateCodec = objectCodec<State>("EnvAuditState");
const auditCategory = categoryTypes<Cmd, Reply>(CategoryId("env-audit"));

describe("sqlite runtime persist path", () => {
  it("stamps envelopes into the journal and fires onPersisted with matching eventIds", async () => {
    const batches: PersistedBatch[] = [];
    const { runtime, journal: rtJournal } = createSqliteRuntime(
      { path: join(dir, "runtime.db"), onPersisted: (b) => batches.push(b) },
      [registration(auditAggregate, auditEvtCodec, auditStateCodec)],
    );

    try {
      await runtime.ask(EntityId("nodered"), { tag: "Record", note: "light.turn_on", causationId: "ha-ctx-1" }, auditCategory);
      await runtime.ask(EntityId("nodered"), { tag: "Record", note: "light.turn_off", causationId: "ha-ctx-2" }, auditCategory);

      // Hook fired with envelopes
      expect(batches).toHaveLength(2);
      expect(batches[0].records[0].envelope.causationId).toBe("ha-ctx-1");
      expect(batches[0].records[0].envelope.origin).toBe("nodered");
      expect(batches[0].records[0].envelope.eventId).toMatch(ULID_RE);

      // Journal rows carry the same envelopes
      const rows = rtJournal.queryEvents({ category: "env-audit", order: "asc" });
      expect(rows).toHaveLength(2);
      expect(rows[0].envelope!.eventId).toBe(batches[0].records[0].envelope.eventId);
      expect(rows[0].envelope!.causationId).toBe("ha-ctx-1");
      expect(rows[1].envelope!.causationId).toBe("ha-ctx-2");
      expect(rows[0].payload).toEqual({ tag: "Recorded", note: "light.turn_on" });

      // Causation filter works on runtime-persisted rows
      const byCause = rtJournal.queryEvents({ causationId: "ha-ctx-2" });
      expect(byCause).toHaveLength(1);
      expect(byCause[0].envelope!.eventId).toBe(batches[1].records[0].envelope.eventId);
    } finally {
      await runtime.shutdown();
      rtJournal.close();
    }
  });
});
