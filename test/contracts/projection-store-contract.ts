// Shared ProjectionStore contract — the inmem and sqlite stores run the same
// cases so they cannot drift (port of Scala ReadModelStoreContractBehaviors,
// TEO-150/154: monotonic view+offset writes, atomic putWithOffset,
// subscribe/await).

import { describe, it, expect } from "vitest";
import { EntityId, SequenceNr } from "../../src/core/types.js";
import { offsetGuardedFold } from "../../src/projection/index.js";
import type { ProjectionStore, ViewEnvelope } from "../../src/projection/index.js";

type Score = { name: string; points: number };

const view = (name: string, points: number, seq: number): ViewEnvelope<Score> => ({
  viewId: "k1",
  view: { name, points },
  sequenceNr: SequenceNr(seq),
});

export function describeProjectionStoreContract(
  name: string,
  makeStore: () => Promise<{ store: ProjectionStore; close(): Promise<void> }>,
): void {
  let n = 0;
  const freshRm = () => `rm-${Date.now().toString(36)}-${n++}`;
  const CAT = "score";
  const ENT = "alice";

  async function withStore(f: (s: ProjectionStore) => Promise<void>): Promise<void> {
    const h = await makeStore();
    try {
      await f(h.store);
    } finally {
      await h.close();
    }
  }

  describe(`${name} projection-store contract`, () => {
    it("get returns undefined for a missing key", () =>
      withStore(async (s) => {
        expect(s.get(freshRm(), "nope")).toBeUndefined();
      }));

    it("put then get round-trips a view", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.put(rm, "k1", view("alice", 10, 1));
        expect(s.get<Score>(rm, "k1")).toEqual(view("alice", 10, 1));
      }));

    it("put overwrites the previous view for a key when newer", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.put(rm, "k1", view("alice", 10, 1));
        s.put(rm, "k1", view("alice", 20, 2));
        expect(s.get<Score>(rm, "k1")?.view.points).toBe(20);
      }));

    it("put ignores a write carrying an older sequence number", () =>
      withStore(async (s) => {
        // A rebuild racing the live projection must not roll the view back.
        const rm = freshRm();
        s.put(rm, "k1", view("alice", 20, 5));
        s.put(rm, "k1", view("stale", 1, 2));
        expect(s.get<Score>(rm, "k1")?.view).toEqual({ name: "alice", points: 20 });
        s.put(rm, "k1", view("alice", 30, 6));
        expect(s.get<Score>(rm, "k1")?.view.points).toBe(30);
      }));

    it("putWithOffset persists the view and the offset together", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.putWithOffset(rm, "k1", view("alice", 10, 4), CAT, ENT);
        expect(s.get<Score>(rm, "k1")?.view.points).toBe(10);
        expect(s.getOffset(rm, CAT, ENT)).toBe(4);
      }));

    it("putWithOffset keeps the view and offset from diverging under a stale writer", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.putWithOffset(rm, "k1", view("alice", 20, 5), CAT, ENT);
        s.putWithOffset(rm, "k1", view("stale", 1, 2), CAT, ENT);
        // Both halves refuse to regress; an advanced offset over a rolled-back
        // view would silently skip everything in between.
        expect(s.get<Score>(rm, "k1")?.view).toEqual({ name: "alice", points: 20 });
        expect(s.getOffset(rm, CAT, ENT)).toBe(5);
      }));

    it("putWithOffset from a second source entity applies regardless of the view's seqNr", () =>
      withStore(async (s) => {
        // Multi-source: entity A at seq 9 and entity B at seq 2 feed one view.
        // B's event is new FOR B — it must fold, and the view seqNr must not regress.
        const rm = freshRm();
        s.putWithOffset(rm, "k1", view("a", 9, 9), CAT, "A");
        s.putWithOffset(rm, "k1", view("ab", 11, 2), CAT, "B");
        expect(s.get<Score>(rm, "k1")?.view).toEqual({ name: "ab", points: 11 });
        expect(s.get<Score>(rm, "k1")?.sequenceNr).toBe(9); // forward-only
        expect(s.getOffset(rm, CAT, "A")).toBe(9);
        expect(s.getOffset(rm, CAT, "B")).toBe(2);
      }));

    it("list returns all views for a projection and only that projection", () =>
      withStore(async (s) => {
        const rm1 = freshRm();
        const rm2 = freshRm();
        s.put(rm1, "k1", view("a", 1, 1));
        s.put(rm1, "k2", { viewId: "k2", view: { name: "b", points: 2 }, sequenceNr: SequenceNr(1) });
        s.put(rm2, "k1", view("c", 3, 1));
        expect(s.list(rm1)).toHaveLength(2);
        expect(s.list(rm2)).toHaveLength(1);
        expect(s.list(freshRm())).toEqual([]);
      }));

    it("getOffset returns zero when never set", () =>
      withStore(async (s) => {
        expect(s.getOffset(freshRm(), CAT, ENT)).toBe(0);
      }));

    it("setOffset then getOffset round-trips per (category, entity)", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.setOffset(rm, CAT, "a", SequenceNr(3));
        s.setOffset(rm, CAT, "b", SequenceNr(7));
        expect(s.getOffset(rm, CAT, "a")).toBe(3);
        expect(s.getOffset(rm, CAT, "b")).toBe(7);
      }));

    it("setOffset stays unconditional — an explicit rewind is legitimate", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.setOffset(rm, CAT, ENT, SequenceNr(9));
        s.setOffset(rm, CAT, ENT, SequenceNr(3));
        expect(s.getOffset(rm, CAT, ENT)).toBe(3);
      }));

    it("offsets are isolated between projections", () =>
      withStore(async (s) => {
        const rm1 = freshRm();
        const rm2 = freshRm();
        s.setOffset(rm1, CAT, ENT, SequenceNr(5));
        expect(s.getOffset(rm2, CAT, ENT)).toBe(0);
      }));

    it("offsets are isolated between categories", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.setOffset(rm, "cat-a", ENT, SequenceNr(5));
        expect(s.getOffset(rm, "cat-b", ENT)).toBe(0);
      }));

    it("clear removes views and offsets for exactly the given projection", () =>
      withStore(async (s) => {
        const rm1 = freshRm();
        const rm2 = freshRm();
        s.putWithOffset(rm1, "k1", view("a", 1, 1), CAT, ENT);
        s.putWithOffset(rm2, "k1", view("b", 2, 1), CAT, ENT);
        s.clear(rm1);
        expect(s.get(rm1, "k1")).toBeUndefined();
        expect(s.getOffset(rm1, CAT, ENT)).toBe(0);
        expect(s.get(rm2, "k1")).toBeDefined();
        expect(s.getOffset(rm2, CAT, ENT)).toBe(1);
      }));

    it("subscribe emits the current view then subsequent updates", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.put(rm, "k1", view("alice", 10, 1));
        const seen: number[] = [];
        const unsub = s.subscribe(rm, "k1", (e) => seen.push((e.view as Score).points));
        s.put(rm, "k1", view("alice", 20, 2));
        unsub();
        s.put(rm, "k1", view("alice", 30, 3));
        expect(seen).toEqual([10, 20]);
      }));

    it("subscribe on a missing key emits the first put", () =>
      withStore(async (s) => {
        const rm = freshRm();
        const seen: number[] = [];
        s.subscribe(rm, "k1", (e) => seen.push((e.view as Score).points));
        s.put(rm, "k1", view("alice", 10, 1));
        expect(seen).toEqual([10]);
      }));

    it("a stale ignored write does not notify subscribers", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.putWithOffset(rm, "k1", view("alice", 20, 5), CAT, ENT);
        const seen: number[] = [];
        s.subscribe(rm, "k1", (e) => seen.push((e.view as Score).points));
        s.put(rm, "k1", view("stale", 1, 2)); // ignored by the view guard
        s.putWithOffset(rm, "k1", view("stale", 1, 2), CAT, ENT); // ignored by the offset guard
        expect(seen).toEqual([20]); // only the initial current-view emission
      }));

    it("awaitView returns immediately when the current view satisfies the predicate", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.put(rm, "k1", view("alice", 10, 1));
        const got = await s.awaitView<Score>(rm, "k1", (v) => v.points >= 10, 500);
        expect(got.points).toBe(10);
      }));

    it("awaitView completes when a later put satisfies the predicate", () =>
      withStore(async (s) => {
        const rm = freshRm();
        const pending = s.awaitView<Score>(rm, "k1", (v) => v.points >= 20, 1_000);
        s.put(rm, "k1", view("alice", 10, 1));
        s.put(rm, "k1", view("alice", 20, 2));
        expect((await pending).points).toBe(20);
      }));

    it("awaitView rejects on timeout", () =>
      withStore(async (s) => {
        const rm = freshRm();
        await expect(s.awaitView<Score>(rm, "k1", () => true, 50)).rejects.toThrow("timed out");
      }));

    it("offsetGuardedFold never double-folds a redelivered event", () =>
      withStore(async (s) => {
        // The crash-restart shape: the same event arrives again. With separate
        // put/setOffset calls this double-folds the view permanently; the
        // guarded fold makes redelivery a no-op.
        const rm = freshRm();
        let evolveCalls = 0;
        const fold = () =>
          offsetGuardedFold<{ add: number }, Score>(s, {
            projectionId: rm,
            category: CAT,
            entityId: EntityId(ENT),
            sequenceNr: SequenceNr(1),
            viewId: "k1",
            initialState: () => ({ name: "alice", points: 0 }),
            evolve: (v, e) => {
              evolveCalls++;
              return { ...v, points: v.points + e.add };
            },
            event: { add: 10 },
          });
        expect(fold()).toBe(true);
        expect(fold()).toBe(false); // redelivery
        expect(evolveCalls).toBe(1);
        expect(s.get<Score>(rm, "k1")?.view.points).toBe(10);
        expect(s.getOffset(rm, CAT, ENT)).toBe(1);
      }));

    it("subscribeAll delivers puts made after the subscription attaches", () =>
      withStore(async (s) => {
        const rm = freshRm();
        s.put(rm, "before", { viewId: "before", view: { name: "x", points: 0 }, sequenceNr: SequenceNr(1) });
        const seen: string[] = [];
        const unsub = s.subscribeAll(rm, (e) => seen.push(e.viewId));
        s.put(rm, "k1", view("a", 1, 1));
        s.putWithOffset(rm, "k2", { viewId: "k2", view: { name: "b", points: 2 }, sequenceNr: SequenceNr(1) }, CAT, ENT);
        unsub();
        s.put(rm, "k3", { viewId: "k3", view: { name: "c", points: 3 }, sequenceNr: SequenceNr(1) });
        expect(seen).toEqual(["k1", "k2"]);
      }));
  });
}
