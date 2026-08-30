import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { Codec } from "../src/core/codec.js";
import { createSqliteJournal } from "../src/sqlite/journal.js";
import { createSqliteCleanJournal } from "../src/sqlite/clean-journal.js";

type E = { tag: "E"; n: number };
const codec: Codec<E> = { manifest: () => "E", encode: (e) => e, decode: (_m, d) => d as E };
type S = { total: number };
const stateCodec: Codec<S> = { manifest: () => "S", encode: (s) => s, decode: (_m, d) => d as S };

const cat = CategoryId("clean-cat");
const e = (n: number): E => ({ tag: "E", n });

function seeded() {
  const journal = createSqliteJournal({ path: ":memory:" });
  const clean = createSqliteCleanJournal(journal);
  journal.persistEvents(cat, EntityId("a"), [e(1), e(2), e(3), e(4)], SequenceNr(0), codec);
  journal.persistEvents(cat, EntityId("b"), [e(10)], SequenceNr(0), codec);
  journal.persistSnapshot(cat, EntityId("a"), { total: 3 }, SequenceNr(3), stateCodec);
  return { journal, clean };
}

describe("SqliteCleanJournal", () => {
  it("deleteAll purges one entity (events before snapshots) and reports real counts", () => {
    const { journal, clean } = seeded();
    const result = clean.deleteAll(cat, EntityId("a"));
    expect(result).toEqual({ events: 4, snapshots: 1 });
    expect(journal.loadEvents(cat, EntityId("a"), SequenceNr(0), codec)).toEqual([]);
    expect(journal.loadSnapshot(cat, EntityId("a"), stateCodec)).toBeUndefined();
    // The other entity is untouched.
    expect(journal.loadEvents(cat, EntityId("b"), SequenceNr(0), codec)).toHaveLength(1);
    journal.close();
  });

  it("deleteJournalEventsTo trims up to and including the given seqNr — recovery still works from the snapshot", () => {
    const { journal, clean } = seeded();
    const deleted = clean.deleteJournalEventsTo(cat, EntityId("a"), 3);
    expect(deleted).toBe(3);
    // The snapshot at seq 3 plus the remaining event 4 reconstructs the state.
    const snap = journal.loadSnapshot(cat, EntityId("a"), stateCodec);
    expect(snap?.sequenceNr).toBe(3);
    const rest = journal.loadEvents(cat, EntityId("a"), snap!.sequenceNr, codec);
    expect(rest.map((r) => r.event.n)).toEqual([4]);
    journal.close();
  });

  it("deleteSnapshotsTo removes only a snapshot at or below the bound", () => {
    const { journal, clean } = seeded();
    expect(clean.deleteSnapshotsTo(cat, EntityId("a"), 2)).toBe(0); // snapshot is at 3
    expect(clean.deleteSnapshotsTo(cat, EntityId("a"), 3)).toBe(1);
    expect(journal.loadSnapshot(cat, EntityId("a"), stateCodec)).toBeUndefined();
    journal.close();
  });

  it("time-based retention deletes only rows older than the bound", () => {
    const { journal, clean } = seeded();
    // Age entity a's first two events far into the past.
    journal.db
      .prepare("UPDATE journal SET timestamp = 1000 WHERE persistence_id = ? AND sequence_nr <= 2")
      .run(`${cat}:a`);
    const deleted = clean.deleteJournalEventsBefore(cat, Date.now() - 24 * 3600 * 1000);
    expect(deleted).toBe(2);
    expect(journal.loadEvents(cat, EntityId("a"), SequenceNr(0), codec).map((r) => r.event.n)).toEqual([3, 4]);
    expect(journal.loadEvents(cat, EntityId("b"), SequenceNr(0), codec)).toHaveLength(1);
    journal.close();
  });

  it("raw inspection surfaces stored representation and write recency", () => {
    const { journal } = seeded();
    expect(journal.entityIds(cat).sort()).toEqual(["a", "b"]);
    const raw = journal.rawEvents(cat, EntityId("a"), { limit: 2 });
    expect(raw).toHaveLength(2);
    expect(raw[0].manifest).toBe("E");
    expect(JSON.parse(raw[0].payload)).toEqual({ tag: "E", n: 1 });
    const snap = journal.snapshotRaw(cat, EntityId("a"));
    expect(snap?.sequenceNr).toBe(3);
    expect(JSON.parse(snap!.payload)).toEqual({ total: 3 });
    const recency = journal.lastWrittenAt(cat);
    expect(recency.map((r) => r.entityId).sort()).toEqual(["a", "b"]);
    expect(recency.every((r) => r.atMs > Date.now() - 60_000)).toBe(true);
    journal.close();
  });

  it("liveRawEvents follows all categories live only, from the current end", async () => {
    const { journal } = seeded();
    const abort = new AbortController();
    const tail = journal.liveRawEvents({ signal: abort.signal, pollIntervalMs: 5 });
    const got: Array<{ category: string; sequenceNr: number }> = [];
    const running = (async () => {
      for await (const row of tail) {
        got.push({ category: row.category, sequenceNr: row.sequenceNr });
        if (got.length >= 2) break;
      }
    })();
    const timer = setTimeout(() => abort.abort(), 2_000);

    // Seeded backlog must NOT replay; only these two arrive.
    journal.persistEvents(CategoryId("other-cat"), EntityId("x"), [e(1)], SequenceNr(0), codec);
    journal.persistEvents(cat, EntityId("a"), [e(5)], SequenceNr(4), codec);

    await running;
    clearTimeout(timer);
    abort.abort();
    expect(got).toEqual([
      { category: "other-cat", sequenceNr: 1 },
      { category: "clean-cat", sequenceNr: 5 },
    ]);
    journal.close();
  });
});
