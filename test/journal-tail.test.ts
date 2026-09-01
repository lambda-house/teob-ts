import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { Codec } from "../src/core/codec.js";
import type { CategoryEventRecord } from "../src/core/event-source.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { createSqliteJournal } from "../src/sqlite/journal.js";

type E = { tag: "E"; n: number };
const codec: Codec<E> = {
  manifest: () => "E",
  encode: (e) => e,
  decode: (_m, d) => d as E,
};
const cat = CategoryId("tail-cat");
const e = (n: number): E => ({ tag: "E", n });

/** Collect exactly `count` records from an endless tail, then abort it. */
async function collect<T>(
  iterable: AsyncIterable<T>,
  count: number,
  abort: AbortController,
  timeoutMs = 3_000,
): Promise<T[]> {
  const out: T[] = [];
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    for await (const item of iterable) {
      out.push(item);
      if (out.length >= count) break;
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return out;
}

type MakeJournal = () => {
  journal: ReturnType<typeof createInMemoryJournal> | ReturnType<typeof createSqliteJournal>;
  close(): void;
};

function tailContract(name: string, make: MakeJournal, opts: { insertionOrderBacklog: boolean }) {
  describe(`${name} tailAllEvents`, () => {
    it("emits the backlog, then follows live writes", async () => {
      const { journal, close } = make();
      journal.persistEvents(cat, EntityId("a"), [e(1), e(2)], SequenceNr(0), codec);
      journal.persistEvents(cat, EntityId("b"), [e(10)], SequenceNr(0), codec);

      const abort = new AbortController();
      const tail = journal.tailAllEvents(cat, codec, { signal: abort.signal, pollIntervalMs: 10 });
      const collecting = collect(tail as AsyncIterable<CategoryEventRecord<E>>, 5, abort);

      // Live writes land after the tail started.
      await new Promise((r) => setTimeout(r, 20));
      journal.persistEvents(cat, EntityId("a"), [e(3)], SequenceNr(2), codec);
      journal.persistEvents(cat, EntityId("c"), [e(20)], SequenceNr(0), codec);

      const got = await collecting;
      expect(got).toHaveLength(5);
      const byEntity = (id: string) => got.filter((r) => r.entityId === id).map((r) => r.event.n);
      expect(byEntity("a")).toEqual([1, 2, 3]);
      expect(byEntity("b")).toEqual([10]);
      expect(byEntity("c")).toEqual([20]);
      // Per-entity sequence order always holds; global order is monotone in globalSeq for live events.
      const aSeqs = got.filter((r) => r.entityId === "a").map((r) => r.sequenceNr);
      expect(aSeqs).toEqual([1, 2, 3]);
      close();
    });

    it("never double-delivers across the backlog/live seam", async () => {
      const { journal, close } = make();
      for (let i = 0; i < 10; i++) {
        journal.persistEvents(cat, EntityId("x"), [e(i + 1)], SequenceNr(i), codec);
      }
      const abort = new AbortController();
      const tail = journal.tailAllEvents(cat, codec, { signal: abort.signal, pollIntervalMs: 5, pageSize: 3 });

      const out: number[] = [];
      const done = (async () => {
        for await (const r of tail as AsyncIterable<CategoryEventRecord<E>>) {
          out.push(r.event.n);
          if (out.length === 1) {
            // Persist DURING consumption — must arrive exactly once.
            journal.persistEvents(cat, EntityId("x"), [e(11)], SequenceNr(10), codec);
          }
          if (out.length >= 11) break;
        }
      })();
      const timer = setTimeout(() => abort.abort(), 3_000);
      await done;
      clearTimeout(timer);
      abort.abort();

      expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      close();
    });

    it("aborting ends the iteration promptly, even while idle", async () => {
      const { journal, close } = make();
      journal.persistEvents(cat, EntityId("a"), [e(1)], SequenceNr(0), codec);
      const abort = new AbortController();
      const tail = journal.tailAllEvents(cat, codec, { signal: abort.signal, pollIntervalMs: 60_000 });

      const start = Date.now();
      const run = (async () => {
        const seen: number[] = [];
        for await (const r of tail as AsyncIterable<CategoryEventRecord<E>>) {
          seen.push(r.event.n);
        }
        return seen;
      })();
      setTimeout(() => abort.abort(), 50);
      const seen = await run;
      expect(seen).toEqual([1]);
      expect(Date.now() - start).toBeLessThan(5_000); // not a poll-interval wait
      close();
    });

    it("resumes strictly after afterGlobalSeq", async () => {
      const { journal, close } = make();
      journal.persistEvents(cat, EntityId("a"), [e(1), e(2), e(3)], SequenceNr(0), codec);

      // First pass: remember the cursor after two records.
      const abort1 = new AbortController();
      const first = await collect(
        journal.tailAllEvents(cat, codec, { signal: abort1.signal, pollIntervalMs: 5 }) as AsyncIterable<CategoryEventRecord<E>>,
        2,
        abort1,
      );
      const cursor = first[first.length - 1].globalSeq;

      const abort2 = new AbortController();
      const rest = await collect(
        journal.tailAllEvents(cat, codec, {
          signal: abort2.signal,
          pollIntervalMs: 5,
          afterGlobalSeq: cursor,
        }) as AsyncIterable<CategoryEventRecord<E>>,
        1,
        abort2,
      );
      expect(rest.map((r) => r.event.n)).toEqual([3]);
      close();
    });

    it("categoryEventSource rejects a category without a codec", () => {
      const { journal, close } = make();
      const source = journal.categoryEventSource(new Map([[cat as string, codec]]));
      expect(() => source.tailCategoryEvents(CategoryId("unknown"))).toThrow("No event codec");
      close();
    });
  });

  if (opts.insertionOrderBacklog) {
    describe(`${name} insertion-order guarantees`, () => {
      it("emits the backlog in global insertion order (rowid), not entity-grouped", async () => {
        const { journal, close } = make();
        journal.persistEvents(cat, EntityId("b"), [e(1)], SequenceNr(0), codec);
        journal.persistEvents(cat, EntityId("a"), [e(2)], SequenceNr(0), codec);
        journal.persistEvents(cat, EntityId("b"), [e(3)], SequenceNr(1), codec);

        const abort = new AbortController();
        const got = await collect(
          journal.tailAllEvents(cat, codec, { signal: abort.signal, pollIntervalMs: 5 }) as AsyncIterable<CategoryEventRecord<E>>,
          3,
          abort,
        );
        expect(got.map((r) => r.event.n)).toEqual([1, 2, 3]);
        const seqs = got.map((r) => r.globalSeq);
        expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
        close();
      });
    });
  }
}

tailContract("inmem", () => {
  const journal = createInMemoryJournal();
  return { journal, close: () => {} };
}, { insertionOrderBacklog: false });

tailContract("sqlite", () => {
  const journal = createSqliteJournal({ path: ":memory:" });
  return { journal, close: () => journal.close() };
}, { insertionOrderBacklog: true });

describe("sqlite tailEvents (single entity)", () => {
  it("emits backlog then live events for one entity only", async () => {
    const journal = createSqliteJournal({ path: ":memory:" });
    journal.persistEvents(cat, EntityId("a"), [e(1), e(2)], SequenceNr(0), codec);
    journal.persistEvents(cat, EntityId("other"), [e(99)], SequenceNr(0), codec);

    const abort = new AbortController();
    const tail = journal.tailEvents(cat, EntityId("a"), codec, {
      signal: abort.signal,
      pollIntervalMs: 10,
    });
    const collecting = collect(tail as AsyncIterable<{ sequenceNr: number; event: E }>, 3, abort);
    await new Promise((r) => setTimeout(r, 20));
    journal.persistEvents(cat, EntityId("a"), [e(3)], SequenceNr(2), codec);

    const got = await collecting;
    expect(got.map((r) => r.event.n)).toEqual([1, 2, 3]);
    journal.close();
  });
});
