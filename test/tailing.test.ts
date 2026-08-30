// B10: concurrent subscription of read-model sources and saga steps over
// endless tails — sequential draining would never subscribe past the first.

import { describe, it, expect } from "vitest";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import type { Codec } from "../src/core/codec.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { createInMemoryRuntime } from "../src/inmem/runtime.js";
import {
  createInMemoryProjectionStore,
  projection,
  runTailingProjection,
} from "../src/projection/index.js";
import {
  createInMemorySagaStore,
  runTailingSaga,
  runTailingStatefulSaga,
  saga,
  statefulSaga,
} from "../src/saga/index.js";

type Evt = { tag: string; n?: number };
const codec: Codec<Evt> = {
  manifest: (e) => e.tag,
  encode: (e) => e,
  decode: (_m, d) => d as Evt,
};

const CAT_A = CategoryId("tp-a");
const CAT_B = CategoryId("tp-b");

function setup() {
  const journal = createInMemoryJournal();
  const source = journal.categoryEventSource(
    new Map([
      [CAT_A as string, codec],
      [CAT_B as string, codec],
    ]),
    { pollIntervalMs: 5 },
  );
  const { runtime } = createInMemoryRuntime([]);
  return { journal, source, runtime };
}

describe("runTailingProjection", () => {
  it("folds live events from a single-stream source", async () => {
    const { journal, source } = setup();
    const store = createInMemoryProjectionStore();
    const proj = projection<Evt, { total: number }>({
      projectionId: "totals",
      category: CAT_A,
      initialState: () => ({ total: 0 }),
      evolve: (v, e) => ({ total: v.total + (e.n ?? 0) }),
    });

    const abort = new AbortController();
    const sourceAborted = journal.categoryEventSource(new Map([[CAT_A as string, codec]]), {
      pollIntervalMs: 5,
      signal: abort.signal,
    });
    const running = runTailingProjection(proj, sourceAborted, store, { signal: abort.signal });

    journal.persistEvents(CAT_A, EntityId("e1"), [{ tag: "Added", n: 2 }], SequenceNr(0), codec);
    journal.persistEvents(CAT_A, EntityId("e1"), [{ tag: "Added", n: 3 }], SequenceNr(1), codec);

    const view = await store.awaitView<{ total: number }>("totals", "e1", (v) => v.total === 5, 2_000);
    expect(view.total).toBe(5);
    abort.abort();
    await running;
  });

  it("subscribes multi-stream sources CONCURRENTLY — the second source folds while the first stays open", async () => {
    const { journal } = setup();
    const store = createInMemoryProjectionStore();
    const proj = projection<Evt, { events: string[] }>({
      projectionId: "merged",
      sources: [
        { category: CAT_A, getViewId: () => "shared" },
        { category: CAT_B, getViewId: () => "shared" },
      ],
      initialState: () => ({ events: [] }),
      evolve: (v, e) => ({ events: [...v.events, e.tag] }),
    });

    const abort = new AbortController();
    const source = journal.categoryEventSource(
      new Map([
        [CAT_A as string, codec],
        [CAT_B as string, codec],
      ]),
      { pollIntervalMs: 5, signal: abort.signal },
    );
    const running = runTailingProjection(proj, source, store, { signal: abort.signal });

    // ONLY the second source receives events. Under sequential draining the
    // runner would still be stuck inside CAT_A's endless tail and this view
    // would never materialize.
    journal.persistEvents(CAT_B, EntityId("b1"), [{ tag: "FromB" }], SequenceNr(0), codec);

    const view = await store.awaitView<{ events: string[] }>("merged", "shared", (v) => v.events.length === 1, 2_000);
    expect(view.events).toEqual(["FromB"]);

    // And the first source still folds when its events arrive later.
    journal.persistEvents(CAT_A, EntityId("a1"), [{ tag: "FromA" }], SequenceNr(0), codec);
    const both = await store.awaitView<{ events: string[] }>("merged", "shared", (v) => v.events.length === 2, 2_000);
    expect(both.events.sort()).toEqual(["FromA", "FromB"]);

    abort.abort();
    await running;
  });
});

describe("runTailingSaga (stateless)", () => {
  it("executes on matching events live, and keeps the offset on failure for a restart retry", async () => {
    const { journal, runtime } = setup();
    const store = createInMemorySagaStore();
    const seen: number[] = [];
    let failOnce = true;
    const def = saga<Evt>({
      name: "notify",
      from: CAT_A,
      on: "Boom",
      execute: async (e) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("handler failed");
        }
        seen.push(e.n ?? -1);
      },
    });

    const abort = new AbortController();
    const source = journal.categoryEventSource(new Map([[CAT_A as string, codec]]), {
      pollIntervalMs: 5,
      signal: abort.signal,
    });
    const errors: unknown[] = [];
    const running = runTailingSaga(def, source, runtime, store, {
      signal: abort.signal,
      onError: (e) => errors.push(e),
    });

    journal.persistEvents(CAT_A, EntityId("e1"), [{ tag: "Boom", n: 1 }], SequenceNr(0), codec);
    await new Promise((r) => setTimeout(r, 100));

    // The handler failed once: offset NOT advanced.
    expect(errors).toHaveLength(1);
    expect(store.getOffset("notify", CAT_A, "e1")).toBe(0);
    expect(seen).toEqual([]);

    // Non-matching tags advance the offset silently.
    journal.persistEvents(CAT_A, EntityId("e2"), [{ tag: "Other" }], SequenceNr(0), codec);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getOffset("notify", CAT_A, "e2")).toBe(1);

    abort.abort();
    await running;
  });
});

describe("runTailingStatefulSaga", () => {
  it("runs steps in order per correlation id, bridging the observe-before-setStep gap", async () => {
    const { journal, runtime } = setup();
    const store = createInMemorySagaStore();
    const order: string[] = [];

    const def = statefulSaga<Evt>({
      name: "order-flow",
      steps: [
        { from: CAT_A, on: "Placed", execute: async () => { order.push("step0"); } },
        { from: CAT_B, on: "Paid", execute: async () => { order.push("step1"); } },
      ],
    });

    const abort = new AbortController();
    const source = journal.categoryEventSource(
      new Map([
        [CAT_A as string, codec],
        [CAT_B as string, codec],
      ]),
      { pollIntervalMs: 5, signal: abort.signal },
    );
    const running = runTailingStatefulSaga(def, source, runtime, store, {
      signal: abort.signal,
      turnPollMs: 10,
      maxTurnWaitMs: 2_000,
    });

    // Step 1's event lands FIRST — it must wait for the step counter.
    journal.persistEvents(CAT_B, EntityId("o1"), [{ tag: "Paid" }], SequenceNr(0), codec);
    await new Promise((r) => setTimeout(r, 30));
    journal.persistEvents(CAT_A, EntityId("o1"), [{ tag: "Placed" }], SequenceNr(0), codec);

    const deadline = Date.now() + 3_000;
    while (order.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(order).toEqual(["step0", "step1"]);
    expect(store.getStep("order-flow", "o1")).toBe(2);

    abort.abort();
    await running;
  });

  it("keeps the offset when the predecessor never completes within the bounded wait", async () => {
    const { journal, runtime } = setup();
    const store = createInMemorySagaStore();
    const def = statefulSaga<Evt>({
      name: "stuck-flow",
      steps: [
        { from: CAT_A, on: "Placed", execute: async () => {} },
        { from: CAT_B, on: "Paid", execute: async () => {} },
      ],
    });

    const abort = new AbortController();
    const source = journal.categoryEventSource(
      new Map([
        [CAT_A as string, codec],
        [CAT_B as string, codec],
      ]),
      { pollIntervalMs: 5, signal: abort.signal },
    );
    const errors: unknown[] = [];
    const running = runTailingStatefulSaga(def, source, runtime, store, {
      signal: abort.signal,
      turnPollMs: 10,
      maxTurnWaitMs: 60, // give up fast — step 0 never fires
      onError: (e) => errors.push(e),
    });

    journal.persistEvents(CAT_B, EntityId("o2"), [{ tag: "Paid" }], SequenceNr(0), codec);
    await new Promise((r) => setTimeout(r, 300));

    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0])).toContain("not ready");
    // Offset untouched: a restarted runner re-reads and retries the event.
    expect(store.getOffset("stuck-flow", `${CAT_B}:step1`, "o2")).toBe(0);
    expect(store.getStep("stuck-flow", "o2")).toBe(0);

    abort.abort();
    await running;
  });

  it("compensates on step failure without advancing the step counter, and consumes the event", async () => {
    const { journal, runtime } = setup();
    const store = createInMemorySagaStore();
    const compensated: number[] = [];
    const def = statefulSaga<Evt>({
      name: "comp-flow",
      steps: [
        {
          from: CAT_A,
          on: "Placed",
          execute: async () => {
            throw new Error("step exploded");
          },
        },
      ],
      compensate: async (failedStep) => {
        compensated.push(failedStep);
      },
    });

    const abort = new AbortController();
    const source = journal.categoryEventSource(new Map([[CAT_A as string, codec]]), {
      pollIntervalMs: 5,
      signal: abort.signal,
    });
    const errors: unknown[] = [];
    const running = runTailingStatefulSaga(def, source, runtime, store, {
      signal: abort.signal,
      onError: (e) => errors.push(e),
    });

    journal.persistEvents(CAT_A, EntityId("o3"), [{ tag: "Placed" }], SequenceNr(0), codec);
    const deadline = Date.now() + 2_000;
    while (compensated.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(compensated).toEqual([0]);
    expect(store.getStep("comp-flow", "o3")).toBe(0); // counter unchanged
    expect(store.getOffset("comp-flow", `${CAT_A}:step0`, "o3")).toBe(1); // consumed

    abort.abort();
    await running;
  });
});
