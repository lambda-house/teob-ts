import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  projection,
  createInMemoryProjectionStore,
  createProjectionRunner,
  type ProjectionRunner,
  type ProjectionStore,
} from "../src/projection/index.js";
import { createInMemoryJournal, type Journal } from "../src/inmem/journal.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec } from "../src/core/codec.js";

type OrderEvent = { tag: "OrderPlaced"; total: number };
type PaymentEvent = { tag: "PaymentReceived"; amount: number };
const orderCodec = tagCodec<OrderEvent>();

function persistEvent<E>(journal: Journal, category: string, entityId: string, event: E, seqNr: number, codec = tagCodec<E>()) {
  journal.persistEvents(CategoryId(category), EntityId(entityId), [event], SequenceNr(seqNr - 1), codec);
}

/** Flush queued microtasks (the runner schedules immediate cycles on the microtask queue). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type TotalsView = { count: number; sum: number };

describe("createProjectionRunner", () => {
  let journal: Journal;
  let store: ProjectionStore;
  let evolveCalls: number;

  const totals = () =>
    projection<OrderEvent, TotalsView>({
      projectionId: "totals",
      category: "order",
      initialState: () => ({ count: 0, sum: 0 }),
      evolve: (view, event) => {
        evolveCalls++;
        return { count: view.count + 1, sum: view.sum + event.total };
      },
    });

  beforeEach(() => {
    journal = createInMemoryJournal();
    store = createInMemoryProjectionStore();
    evolveCalls = 0;
  });

  it("runOnce applies events incrementally", () => {
    const runner = createProjectionRunner({
      entries: [{ projection: totals(), eventCodec: orderCodec }],
      journal,
      store,
    });

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 10 }, 1, orderCodec);
    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 20 }, 2, orderCodec);
    runner.runOnce();
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 2, sum: 30 });
    expect(evolveCalls).toBe(2);

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 5 }, 3, orderCodec);
    runner.runOnce();
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 3, sum: 35 });
    // Incremental: previously processed events are NOT re-applied
    expect(evolveCalls).toBe(3);
    expect(runner.stats().cycles).toBe(2);
    expect(runner.stats().lastCycleAt).not.toBeNull();
    expect(runner.stats().lastCycleDurationMs).not.toBeNull();
  });

  it("poll loop picks up new events within 2 ticks", async () => {
    const runner = createProjectionRunner({
      entries: [{ projection: totals(), eventCodec: orderCodec }],
      journal,
      store,
      pollIntervalMs: 10,
    });
    runner.start();
    runner.start(); // idempotent

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 7 }, 1, orderCodec);
    await vi.waitFor(
      () => {
        expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 1, sum: 7 });
      },
      { timeout: 500, interval: 5 },
    );

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 3 }, 2, orderCodec);
    await vi.waitFor(
      () => {
        expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 2, sum: 10 });
      },
      { timeout: 500, interval: 5 },
    );

    await runner.stop();
    const cyclesAtStop = runner.stats().cycles;
    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 1 }, 3, orderCodec);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.stats().cycles).toBe(cyclesAtStop);
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 2, sum: 10 });
  });

  it("nudge while idle coalesces many calls into one cycle", async () => {
    const runner = createProjectionRunner({
      entries: [{ projection: totals(), eventCodec: orderCodec }],
      journal,
      store,
    });
    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 1 }, 1, orderCodec);

    runner.nudge();
    runner.nudge();
    runner.nudge();
    runner.nudge();
    runner.nudge();
    expect(runner.stats().cycles).toBe(0); // deferred to a microtask
    await flushMicrotasks();
    expect(runner.stats().cycles).toBe(1);
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 1, sum: 1 });
  });

  it("nudges arriving mid-cycle coalesce into at most one extra cycle", async () => {
    const runnerRef: { current: ProjectionRunner | undefined } = { current: undefined };
    const nudgy = projection<OrderEvent, TotalsView>({
      projectionId: "nudgy",
      category: "order",
      initialState: () => ({ count: 0, sum: 0 }),
      evolve: (view, event) => {
        // Simulate onPersisted firing during a cycle: many nudges mid-cycle
        runnerRef.current?.nudge();
        runnerRef.current?.nudge();
        runnerRef.current?.nudge();
        return { count: view.count + 1, sum: view.sum + event.total };
      },
    });
    const runner = createProjectionRunner({
      entries: [{ projection: nudgy, eventCodec: orderCodec }],
      journal,
      store,
    });
    runnerRef.current = runner;

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 4 }, 1, orderCodec);
    runner.runOnce();
    expect(runner.stats().cycles).toBe(1);
    await flushMicrotasks();
    // The three mid-cycle nudges produced exactly one extra cycle
    expect(runner.stats().cycles).toBe(2);
    await flushMicrotasks();
    expect(runner.stats().cycles).toBe(2);
    expect(store.get<TotalsView>("nudgy", "o-1")?.view).toEqual({ count: 1, sum: 4 });
  });

  it("rebuild clears and reapplies all events; unknown projectionId throws", () => {
    const runner = createProjectionRunner({
      entries: [{ projection: totals(), eventCodec: orderCodec }],
      journal,
      store,
    });
    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 10 }, 1, orderCodec);
    persistEvent(journal, "order", "o-2", { tag: "OrderPlaced", total: 20 }, 1, orderCodec);
    runner.runOnce();
    expect(evolveCalls).toBe(2);

    // Corrupt a view to prove rebuild really clears + reapplies from the journal
    store.put("totals", "o-1", { viewId: "o-1", view: { count: 99, sum: 999 }, sequenceNr: SequenceNr(1) });

    runner.rebuild("totals");
    expect(evolveCalls).toBe(4); // all events re-applied
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 1, sum: 10 });
    expect(store.get<TotalsView>("totals", "o-2")?.view).toEqual({ count: 1, sum: 20 });

    expect(() => runner.rebuild("nope")).toThrow(/Unknown projection: nope/);
  });

  it("a throwing projection reaches onError and the loop survives", () => {
    const errors: unknown[] = [];
    const boom = projection<OrderEvent, TotalsView>({
      projectionId: "boom",
      category: "order",
      initialState: () => ({ count: 0, sum: 0 }),
      evolve: () => {
        throw new Error("evolve exploded");
      },
    });
    const runner = createProjectionRunner({
      entries: [
        { projection: boom, eventCodec: orderCodec },
        { projection: totals(), eventCodec: orderCodec },
      ],
      journal,
      store,
      onError: (err) => errors.push(err),
    });

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 10 }, 1, orderCodec);
    runner.runOnce();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("evolve exploded");
    // The healthy projection in the same cycle still ran
    expect(store.get<TotalsView>("totals", "o-1")?.view).toEqual({ count: 1, sum: 10 });

    // The loop survives: next cycle runs and errors again (offset never advanced)
    runner.runOnce();
    expect(errors).toHaveLength(2);
    expect(runner.stats().cycles).toBe(2);
  });

  it("dispatches multi-stream projections and rebuilds them", () => {
    type ActivityEvent = OrderEvent | PaymentEvent;
    type ActivityView = { events: string[] };
    const activity = projection<ActivityEvent, ActivityView>({
      projectionId: "activity",
      sources: [
        { category: "order", getViewId: () => "all" },
        { category: "payment", getViewId: () => "all" },
      ],
      initialState: () => ({ events: [] }),
      evolve: (view, event) => ({ events: [...view.events, event.tag] }),
    });
    const runner = createProjectionRunner({
      entries: [{ projection: activity }],
      journal,
      store,
    });

    persistEvent(journal, "order", "o-1", { tag: "OrderPlaced", total: 10 } as ActivityEvent, 1);
    persistEvent(journal, "payment", "p-1", { tag: "PaymentReceived", amount: 10 } as ActivityEvent, 1);
    runner.runOnce();
    const view = store.get<ActivityView>("activity", "all")?.view;
    expect(view?.events.sort()).toEqual(["OrderPlaced", "PaymentReceived"]);

    runner.rebuild("activity");
    expect(store.get<ActivityView>("activity", "all")?.view.events).toHaveLength(2);
  });

  it("onCycle fires with timing info after every cycle", () => {
    const cycles: Array<{ at: number; durationMs: number }> = [];
    const runner = createProjectionRunner({
      entries: [{ projection: totals(), eventCodec: orderCodec }],
      journal,
      store,
      onCycle: (info) => cycles.push(info),
    });
    runner.runOnce();
    runner.runOnce();
    expect(cycles).toHaveLength(2);
    expect(cycles[0].at).toBeGreaterThan(0);
    expect(cycles[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
