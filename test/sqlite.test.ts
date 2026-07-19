import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteJournal, type SqliteJournal } from "../src/sqlite/journal.js";
import { createSqliteReadJournal } from "../src/sqlite/read-journal.js";
import { createSqliteRuntime, registration } from "../src/sqlite/index.js";
import { createSqliteProjectionStore, projection, runProjection } from "../src/projection/index.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { persist, reply, andReply, done } from "../src/core/effect.js";
import { categoryTypes } from "../src/core/effect-control.js";
import type { Aggregate } from "../src/core/aggregate.js";

// --- Test aggregate ---

type CounterCommand =
  | { tag: "Increment"; amount: number }
  | { tag: "Decrement"; amount: number }
  | { tag: "GetValue" }
  | { tag: "Noop" };

type CounterEvent =
  | { tag: "Incremented"; amount: number }
  | { tag: "Decremented"; amount: number };

type CounterReply =
  | { tag: "Ok" }
  | { tag: "Value"; value: number };

type CounterState = { value: number };

const counterAggregate: Aggregate<CounterCommand, CounterReply, CounterEvent, CounterState> = {
  category: CategoryId("counter"),
  initial: () => ({ value: 0 }),
  snapshotEvery: 5,
  async decide(state, command) {
    switch (command.tag) {
      case "Increment":
        return andReply(
          persist({ tag: "Incremented", amount: command.amount }),
          { tag: "Ok" },
        );
      case "Decrement":
        return andReply(
          persist({ tag: "Decremented", amount: command.amount }),
          { tag: "Ok" },
        );
      case "GetValue":
        return reply({ tag: "Value", value: state.value });
      case "Noop":
        return done();
    }
  },
  apply(state, event) {
    switch (event.tag) {
      case "Incremented": return { value: state.value + event.amount };
      case "Decremented": return { value: state.value - event.amount };
    }
  },
};

const eventCodec = tagCodec<CounterEvent>("Incremented", "Decremented");
const stateCodec = objectCodec<CounterState>("CounterState");
const counterCategory = categoryTypes<CounterCommand, CounterReply>(CategoryId("counter"));

// --- Journal Tests ---

describe("SqliteJournal", () => {
  let journal: SqliteJournal;

  beforeEach(() => {
    journal = createSqliteJournal({ path: ":memory:" });
  });

  afterEach(() => {
    journal.close();
  });

  it("creates tables on initialization", () => {
    const tables = journal.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("journal");
    expect(names).toContain("snapshots");
  });

  it("persists and loads events", () => {
    const seqNr = journal.persistEvents(
      CategoryId("counter"),
      EntityId("c1"),
      [{ tag: "Incremented", amount: 5 }],
      SequenceNr(0),
      eventCodec,
    );
    expect(seqNr).toBe(1);

    const events = journal.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), eventCodec);
    expect(events).toHaveLength(1);
    expect(events[0].sequenceNr).toBe(1);
    expect(events[0].event).toEqual({ tag: "Incremented", amount: 5 });
  });

  it("persists multiple events atomically", () => {
    const seqNr = journal.persistEvents(
      CategoryId("counter"),
      EntityId("c1"),
      [
        { tag: "Incremented", amount: 1 },
        { tag: "Incremented", amount: 2 },
        { tag: "Decremented", amount: 3 },
      ],
      SequenceNr(0),
      eventCodec,
    );
    expect(seqNr).toBe(3);

    const events = journal.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), eventCodec);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
  });

  it("loads events after a given sequence number", () => {
    journal.persistEvents(
      CategoryId("counter"),
      EntityId("c1"),
      [
        { tag: "Incremented", amount: 1 },
        { tag: "Incremented", amount: 2 },
        { tag: "Incremented", amount: 3 },
      ],
      SequenceNr(0),
      eventCodec,
    );

    const events = journal.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(2), eventCodec);
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ tag: "Incremented", amount: 3 });
  });

  it("persists and loads snapshots", () => {
    journal.persistSnapshot(CategoryId("counter"), EntityId("c1"), { value: 42 }, SequenceNr(10), stateCodec);

    const snap = journal.loadSnapshot(CategoryId("counter"), EntityId("c1"), stateCodec);
    expect(snap).toBeDefined();
    expect(snap!.sequenceNr).toBe(10);
    expect(snap!.state).toEqual({ value: 42 });
  });

  it("upserts snapshots (overwrites)", () => {
    journal.persistSnapshot(CategoryId("counter"), EntityId("c1"), { value: 1 }, SequenceNr(1), stateCodec);
    journal.persistSnapshot(CategoryId("counter"), EntityId("c1"), { value: 99 }, SequenceNr(50), stateCodec);

    const snap = journal.loadSnapshot(CategoryId("counter"), EntityId("c1"), stateCodec);
    expect(snap!.sequenceNr).toBe(50);
    expect(snap!.state).toEqual({ value: 99 });
  });

  it("returns undefined for missing snapshot", () => {
    const snap = journal.loadSnapshot(CategoryId("counter"), EntityId("missing"), stateCodec);
    expect(snap).toBeUndefined();
  });

  it("loads empty events for missing entity", () => {
    const events = journal.loadEvents(CategoryId("counter"), EntityId("missing"), SequenceNr(0), eventCodec);
    expect(events).toEqual([]);
  });

  it("allEvents returns events across entities for a category", () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [{ tag: "Incremented", amount: 1 }], SequenceNr(0), eventCodec);
    journal.persistEvents(CategoryId("counter"), EntityId("c2"), [{ tag: "Decremented", amount: 2 }], SequenceNr(0), eventCodec);
    journal.persistEvents(CategoryId("other"), EntityId("o1"), [{ tag: "Incremented", amount: 3 }], SequenceNr(0), eventCodec);

    const all = journal.allEvents(CategoryId("counter"), eventCodec);
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.entityId).sort()).toEqual(["c1", "c2"]);
  });

  it("returns 0 events when none persisted", () => {
    const seqNr = journal.persistEvents(CategoryId("counter"), EntityId("c1"), [], SequenceNr(5), eventCodec);
    expect(seqNr).toBe(5);
  });

  it("handles WAL mode", () => {
    // Default is WAL=true, already tested implicitly. Test explicit false.
    const j = createSqliteJournal({ path: ":memory:", wal: false });
    j.persistEvents(CategoryId("counter"), EntityId("c1"), [{ tag: "Incremented", amount: 1 }], SequenceNr(0), eventCodec);
    const events = j.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), eventCodec);
    expect(events).toHaveLength(1);
    j.close();
  });
});

// --- Runtime Tests ---

describe("createSqliteRuntime", () => {
  let runtime: ReturnType<typeof createSqliteRuntime>["runtime"];
  let journal: SqliteJournal;

  beforeEach(() => {
    ({ runtime, journal } = createSqliteRuntime(
      { path: ":memory:" },
      [registration(counterAggregate, eventCodec, stateCodec)],
    ));
  });

  afterEach(async () => {
    await runtime.shutdown();
    journal.close();
  });

  it("processes commands and persists events", async () => {
    const result = await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 10 }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toEqual({ tag: "Ok" });

    // Verify events in journal
    const events = journal.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), eventCodec);
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ tag: "Incremented", amount: 10 });
  });

  it("maintains state across commands", async () => {
    await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 5 }, counterCategory);
    await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 3 }, counterCategory);
    await runtime.ask(EntityId("c1"), { tag: "Decrement", amount: 2 }, counterCategory);

    const result = await runtime.ask(EntityId("c1"), { tag: "GetValue" }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toEqual({ tag: "Value", value: 6 });
  });

  it("handles multiple entities independently", async () => {
    await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 10 }, counterCategory);
    await runtime.ask(EntityId("c2"), { tag: "Increment", amount: 20 }, counterCategory);

    const r1 = await runtime.ask(EntityId("c1"), { tag: "GetValue" }, counterCategory);
    const r2 = await runtime.ask(EntityId("c2"), { tag: "GetValue" }, counterCategory);

    expect(r1.ok && r1.value.reply).toEqual({ tag: "Value", value: 10 });
    expect(r2.ok && r2.value.reply).toEqual({ tag: "Value", value: 20 });
  });

  it("ask returns meta with sequence numbers", async () => {
    const result = await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 1 }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta!.preSequenceNr).toBe(0);
      expect(result.value.meta!.sequenceNr).toBe(1);
    }
  });

  it("tell fires and forgets", async () => {
    await runtime.tell(EntityId("c1"), { tag: "Increment", amount: 7 }, counterCategory);
    // Give the entity time to process
    await new Promise((r) => setTimeout(r, 50));

    const result = await runtime.ask(EntityId("c1"), { tag: "GetValue" }, counterCategory);
    expect(result.ok && result.value.reply).toEqual({ tag: "Value", value: 7 });
  });

  it("categories returns registered categories", () => {
    const cats = runtime.categories();
    expect(cats.has(CategoryId("counter"))).toBe(true);
  });

  it("returns CategoryNotFound for unknown category", async () => {
    const badCat = categoryTypes(CategoryId("nonexistent"));
    const result = await runtime.ask(EntityId("c1"), {}, badCat);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.tag).toBe("CategoryNotFound");
  });

  it("creates snapshots after snapshotEvery events", async () => {
    // snapshotEvery = 5 in our aggregate
    for (let i = 0; i < 6; i++) {
      await runtime.ask(EntityId("c1"), { tag: "Increment", amount: 1 }, counterCategory);
    }

    const snap = journal.loadSnapshot(CategoryId("counter"), EntityId("c1"), stateCodec);
    expect(snap).toBeDefined();
    expect(snap!.state.value).toBe(5); // snapshot after 5th event
  });

  it("handles Done effect", async () => {
    const result = await runtime.ask(EntityId("c1"), { tag: "Noop" }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toBeUndefined();
  });
});

// --- Persistence / Recovery ---

describe("SQLite persistence and recovery", () => {
  it("recovers state from disk after restart", async () => {
    const tmpPath = `/tmp/teob-sqlite-test-${Date.now()}.db`;

    // First runtime: persist some events
    const { runtime: r1, journal: j1 } = createSqliteRuntime(
      { path: tmpPath },
      [registration(counterAggregate, eventCodec, stateCodec)],
    );

    await r1.ask(EntityId("c1"), { tag: "Increment", amount: 10 }, counterCategory);
    await r1.ask(EntityId("c1"), { tag: "Increment", amount: 20 }, counterCategory);
    await r1.shutdown();
    j1.close();

    // Second runtime: recover from same file
    const { runtime: r2, journal: j2 } = createSqliteRuntime(
      { path: tmpPath },
      [registration(counterAggregate, eventCodec, stateCodec)],
    );

    const result = await r2.ask(EntityId("c1"), { tag: "GetValue" }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toEqual({ tag: "Value", value: 30 });

    await r2.shutdown();
    j2.close();

    // Cleanup
    const fs = await import("node:fs");
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(tmpPath + suffix); } catch {}
    }
  });
});

// --- SQLite ReadJournal ---

describe("SqliteReadJournal", () => {
  let journal: SqliteJournal;

  beforeEach(() => {
    journal = createSqliteJournal({ path: ":memory:" });
  });

  afterEach(() => {
    journal.close();
  });

  it("fetchIds returns all distinct persistence IDs", async () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [{ tag: "Incremented", amount: 1 }], SequenceNr(0), eventCodec);
    journal.persistEvents(CategoryId("counter"), EntityId("c2"), [{ tag: "Incremented", amount: 2 }], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const ids: string[] = [];
    for await (const id of readJournal.fetchIds()) {
      ids.push(id);
    }

    expect(ids).toHaveLength(2);
    expect(ids).toContain("counter:c1");
    expect(ids).toContain("counter:c2");
  });

  it("lastOrdinal returns max sequence number", async () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [
      { tag: "Incremented", amount: 1 },
      { tag: "Incremented", amount: 2 },
      { tag: "Incremented", amount: 3 },
    ], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const last = await readJournal.lastOrdinal("counter:c1");
    expect(last).toBe(3);
  });

  it("lastOrdinal returns 0 for unknown entity", async () => {
    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const last = await readJournal.lastOrdinal("counter:unknown");
    expect(last).toBe(0);
  });

  it("events streams events in range", async () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [
      { tag: "Incremented", amount: 1 },
      { tag: "Incremented", amount: 2 },
      { tag: "Incremented", amount: 3 },
    ], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const events: Array<[any, number]> = [];
    for await (const entry of readJournal.events("counter:c1", 2)) {
      events.push(entry);
    }

    expect(events).toHaveLength(2);
    expect(events[0][1]).toBe(2);
    expect(events[1][1]).toBe(3);
  });

  it("events with upper bound", async () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [
      { tag: "Incremented", amount: 1 },
      { tag: "Incremented", amount: 2 },
      { tag: "Incremented", amount: 3 },
    ], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const events: Array<[any, number]> = [];
    for await (const entry of readJournal.events("counter:c1", 1, 3)) {
      events.push(entry);
    }

    expect(events).toHaveLength(2);
    expect(events[0][1]).toBe(1);
    expect(events[1][1]).toBe(2);
  });

  it("streamIds returns same as fetchIds", async () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [{ tag: "Incremented", amount: 1 }], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const ids: string[] = [];
    for await (const id of readJournal.streamIds()) {
      ids.push(id);
    }
    expect(ids).toEqual(["counter:c1"]);
  });

  it("pollIds returns IDs with events since timestamp", () => {
    journal.persistEvents(CategoryId("counter"), EntityId("c1"), [{ tag: "Incremented", amount: 1 }], SequenceNr(0), eventCodec);

    const readJournal = createSqliteReadJournal(journal.db, eventCodec);
    const ids = readJournal.pollIds(0);
    expect(ids).toContain("counter:c1");
  });
});

// --- SQLite Projection Store ---

describe("createSqliteProjectionStore", () => {
  let journal: SqliteJournal;

  beforeEach(() => {
    journal = createSqliteJournal({ path: ":memory:" });
  });

  afterEach(() => {
    journal.close();
  });

  it("get returns undefined for missing view", () => {
    const store = createSqliteProjectionStore(journal.db);
    expect(store.get("proj", "missing")).toBeUndefined();
  });

  it("put and get round-trip", () => {
    const store = createSqliteProjectionStore(journal.db);
    store.put("proj", "v1", { viewId: "v1", view: { count: 42 }, sequenceNr: SequenceNr(3) });
    const result = store.get("proj", "v1");
    expect(result?.view).toEqual({ count: 42 });
    expect(result?.sequenceNr).toBe(3);
  });

  it("list returns all views for a projection", () => {
    const store = createSqliteProjectionStore(journal.db);
    store.put("proj", "v1", { viewId: "v1", view: { a: 1 }, sequenceNr: SequenceNr(1) });
    store.put("proj", "v2", { viewId: "v2", view: { a: 2 }, sequenceNr: SequenceNr(2) });
    store.put("other", "v3", { viewId: "v3", view: { a: 3 }, sequenceNr: SequenceNr(3) });

    expect(store.list("proj")).toHaveLength(2);
    expect(store.list("other")).toHaveLength(1);
  });

  it("tracks offsets", () => {
    const store = createSqliteProjectionStore(journal.db);
    expect(store.getOffset("proj", "cat", "e1")).toBe(0);

    store.setOffset("proj", "cat", "e1", SequenceNr(5));
    expect(store.getOffset("proj", "cat", "e1")).toBe(5);
  });

  it("clear removes views and offsets", () => {
    const store = createSqliteProjectionStore(journal.db);
    store.put("proj", "v1", { viewId: "v1", view: {}, sequenceNr: SequenceNr(1) });
    store.setOffset("proj", "cat", "e1", SequenceNr(5));
    store.put("other", "v2", { viewId: "v2", view: {}, sequenceNr: SequenceNr(1) });

    store.clear("proj");

    expect(store.get("proj", "v1")).toBeUndefined();
    expect(store.getOffset("proj", "cat", "e1")).toBe(0);
    expect(store.get("other", "v2")).toBeDefined();
  });

  it("upserts views on put", () => {
    const store = createSqliteProjectionStore(journal.db);
    store.put("proj", "v1", { viewId: "v1", view: { count: 1 }, sequenceNr: SequenceNr(1) });
    store.put("proj", "v1", { viewId: "v1", view: { count: 99 }, sequenceNr: SequenceNr(10) });

    expect(store.get("proj", "v1")?.view).toEqual({ count: 99 });
  });

  it("works with runProjection end-to-end", () => {
    type Evt = { tag: "Added"; value: number };
    const evtCodec = tagCodec<Evt>("Added");

    journal.persistEvents(CategoryId("items"), EntityId("i1"), [{ tag: "Added", value: 10 }], SequenceNr(0), evtCodec);
    journal.persistEvents(CategoryId("items"), EntityId("i2"), [{ tag: "Added", value: 20 }], SequenceNr(0), evtCodec);

    const sumProjection = projection<Evt, { total: number }>({
      projectionId: "sum",
      category: "items",
      evolve: (view, event) => ({ total: view.total + event.value }),
      initialState: () => ({ total: 0 }),
    });

    const store = createSqliteProjectionStore(journal.db);
    runProjection(sumProjection, journal, store, { eventCodec: evtCodec });

    expect(store.get("sum", "i1")?.view).toEqual({ total: 10 });
    expect(store.get("sum", "i2")?.view).toEqual({ total: 20 });
    expect(store.list("sum")).toHaveLength(2);
  });
});
