// Shared journal contract — every backend (inmem, sqlite, postgres) runs the
// same cases, so behavior cannot drift between the journal all tests use and
// the ones production uses (port of Scala JournalContractBehaviors, TEO-143).

import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../../src/core/types.js";
import { DuplicateSequenceNrError } from "../../src/core/journal-store.js";
import type { Codec } from "../../src/core/codec.js";

export type TestEvent = { tag: "E"; n: number };
export const testEventCodec: Codec<TestEvent> = {
  manifest: () => "E",
  encode: (e) => e,
  decode: (_m, data) => data as TestEvent,
};

type TestState = { total: number };
const testStateCodec: Codec<TestState> = {
  manifest: () => "State",
  encode: (s) => s,
  decode: (_m, data) => data as TestState,
};

/** Async facade over a journal backend — sync backends wrap, postgres passes through. */
export interface JournalHarness {
  persistEvents(
    category: CategoryId,
    entityId: EntityId,
    events: TestEvent[],
    startSequenceNr: SequenceNr,
  ): Promise<SequenceNr>;
  loadEvents(
    category: CategoryId,
    entityId: EntityId,
    fromSequenceNr: SequenceNr,
  ): Promise<Array<{ sequenceNr: SequenceNr; event: TestEvent }>>;
  persistSnapshot(
    category: CategoryId,
    entityId: EntityId,
    state: TestState,
    sequenceNr: SequenceNr,
  ): Promise<void>;
  loadSnapshot(
    category: CategoryId,
    entityId: EntityId,
  ): Promise<{ sequenceNr: SequenceNr; state: TestState } | undefined>;
  close(): Promise<void>;
}

export function describeJournalContract(
  name: string,
  makeHarness: () => Promise<JournalHarness>,
  opts?: { category?: string },
): void {
  const cat = CategoryId(opts?.category ?? "jc");
  const e = (n: number): TestEvent => ({ tag: "E", n });
  let entitySeq = 0;
  const freshId = () => EntityId(`jc-${Date.now().toString(36)}-${entitySeq++}`);

  async function withHarness(f: (h: JournalHarness) => Promise<void>): Promise<void> {
    const h = await makeHarness();
    try {
      await f(h);
    } finally {
      await h.close();
    }
  }

  describe(`${name} journal contract`, () => {
    it("persists a batch and returns the sequence number after the last event", () =>
      withHarness(async (j) => {
        const id = freshId();
        const seq = await j.persistEvents(cat, id, [e(1), e(2), e(3)], SequenceNr(0));
        expect(seq).toBe(3);
        const rows = await j.loadEvents(cat, id, SequenceNr(0));
        expect(rows.map((r) => r.event.n)).toEqual([1, 2, 3]);
        expect(rows.map((r) => r.sequenceNr)).toEqual([1, 2, 3]);
      }));

    it("threads the returned sequence number across sequential persists", () =>
      withHarness(async (j) => {
        const id = freshId();
        let seq = await j.persistEvents(cat, id, [e(1)], SequenceNr(0));
        seq = await j.persistEvents(cat, id, [e(2), e(3)], seq);
        seq = await j.persistEvents(cat, id, [e(4)], seq);
        expect(seq).toBe(4);
        const rows = await j.loadEvents(cat, id, SequenceNr(0));
        expect(rows.map((r) => r.event.n)).toEqual([1, 2, 3, 4]);
      }));

    it("an empty batch is a no-op that returns the start sequence number", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistEvents(cat, id, [e(1)], SequenceNr(0));
        const seq = await j.persistEvents(cat, id, [], SequenceNr(1));
        expect(seq).toBe(1);
        expect((await j.loadEvents(cat, id, SequenceNr(0))).length).toBe(1);
      }));

    it("loadEvents replays only events after the exclusive fromSequenceNr", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistEvents(cat, id, [e(1), e(2), e(3), e(4)], SequenceNr(0));
        const rows = await j.loadEvents(cat, id, SequenceNr(2));
        expect(rows.map((r) => r.event.n)).toEqual([3, 4]);
      }));

    it("keeps events of different entities separate", () =>
      withHarness(async (j) => {
        const a = freshId();
        const b = freshId();
        await j.persistEvents(cat, a, [e(1)], SequenceNr(0));
        await j.persistEvents(cat, b, [e(2)], SequenceNr(0));
        expect((await j.loadEvents(cat, a, SequenceNr(0))).map((r) => r.event.n)).toEqual([1]);
        expect((await j.loadEvents(cat, b, SequenceNr(0))).map((r) => r.event.n)).toEqual([2]);
      }));

    it("rejects a reused sequence number with the typed error carrying the colliding number", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistEvents(cat, id, [e(1)], SequenceNr(0));
        let caught: unknown;
        try {
          await j.persistEvents(cat, id, [e(9)], SequenceNr(0));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DuplicateSequenceNrError);
        const dup = caught as DuplicateSequenceNrError;
        expect(dup.category).toBe(cat);
        expect(dup.entityId).toBe(id);
        expect(dup.sequenceNr).toBe(1);
      }));

    it("a rejected single write leaves the journal unchanged", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistEvents(cat, id, [e(1)], SequenceNr(0));
        await expect(j.persistEvents(cat, id, [e(9)], SequenceNr(0))).rejects.toBeInstanceOf(
          DuplicateSequenceNrError,
        );
        const rows = await j.loadEvents(cat, id, SequenceNr(0));
        expect(rows.map((r) => r.event.n)).toEqual([1]);
      }));

    it("a duplicate mid-batch rejects the whole batch, leaves no partial prefix, and the journal stays usable", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistEvents(cat, id, [e(1), e(2)], SequenceNr(0));
        // Occupy seq 4 (sparse), leaving seq 3 free: the batch {3,4} fails on
        // its SECOND row, and the clean first row must be rolled back.
        await j.persistEvents(cat, id, [e(4)], SequenceNr(3));

        let caught: unknown;
        try {
          await j.persistEvents(cat, id, [e(30), e(40)], SequenceNr(2));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DuplicateSequenceNrError);
        expect((caught as DuplicateSequenceNrError).sequenceNr).toBe(4);

        const rows = await j.loadEvents(cat, id, SequenceNr(0));
        expect(rows.map((r) => r.event.n)).toEqual([1, 2, 4]);

        // Still usable: the freed seqNr 3 can be written afterwards.
        await j.persistEvents(cat, id, [e(3)], SequenceNr(2));
        expect((await j.loadEvents(cat, id, SequenceNr(0))).length).toBe(4);
      }));

    it("round-trips a snapshot", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistSnapshot(cat, id, { total: 42 }, SequenceNr(7));
        const snap = await j.loadSnapshot(cat, id);
        expect(snap).toEqual({ sequenceNr: 7, state: { total: 42 } });
      }));

    it("loadSnapshot returns undefined when nothing was snapshotted", () =>
      withHarness(async (j) => {
        expect(await j.loadSnapshot(cat, freshId())).toBeUndefined();
      }));

    it("a later snapshot replaces an earlier one", () =>
      withHarness(async (j) => {
        const id = freshId();
        await j.persistSnapshot(cat, id, { total: 1 }, SequenceNr(1));
        await j.persistSnapshot(cat, id, { total: 2 }, SequenceNr(2));
        const snap = await j.loadSnapshot(cat, id);
        expect(snap).toEqual({ sequenceNr: 2, state: { total: 2 } });
      }));
  });
}

/** Wrap a synchronous Journal (inmem, sqlite) in the async harness. */
export function syncJournalHarness(
  journal: {
    persistEvents<E>(c: CategoryId, i: EntityId, ev: E[], s: SequenceNr, codec: Codec<E>): SequenceNr;
    loadEvents<E>(c: CategoryId, i: EntityId, f: SequenceNr, codec: Codec<E>): Array<{ sequenceNr: SequenceNr; event: E }>;
    persistSnapshot<S>(c: CategoryId, i: EntityId, st: S, s: SequenceNr, codec: Codec<S>): void;
    loadSnapshot<S>(c: CategoryId, i: EntityId, codec: Codec<S>): { sequenceNr: SequenceNr; state: S } | undefined;
  },
  close?: () => void,
): JournalHarness {
  return {
    persistEvents: async (c, i, ev, s) => journal.persistEvents(c, i, ev, s, testEventCodec),
    loadEvents: async (c, i, f) => journal.loadEvents(c, i, f, testEventCodec),
    persistSnapshot: async (c, i, st, s) => journal.persistSnapshot(c, i, st, s, testStateCodec),
    loadSnapshot: async (c, i) => journal.loadSnapshot(c, i, testStateCodec),
    close: async () => close?.(),
  };
}
