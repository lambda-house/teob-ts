import { describe, it, expect, beforeEach } from "vitest";
import {
  projection,
  createInMemoryProjectionStore,
  runProjection,
  runMultiStreamProjection,
  rebuildProjection,
  rebuildMultiStreamProjection,
  type ProjectionStore,
} from "../src/projection/index.js";
import { createInMemoryJournal, type Journal } from "../src/inmem/journal.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec } from "../src/core/codec.js";

// --- Test event types ---

type OrderEvent =
  | { tag: "OrderPlaced"; total: number; customerId: string }
  | { tag: "OrderShipped"; trackingId: string }
  | { tag: "OrderCancelled" };

type PaymentEvent =
  | { tag: "PaymentReceived"; amount: number; customerId: string };

const orderCodec = tagCodec<OrderEvent>();
const paymentCodec = tagCodec<PaymentEvent>();

// --- Test helpers ---

function persistEvent<E>(
  journal: Journal,
  category: string,
  entityId: string,
  event: E,
  seqNr: number,
  codec = tagCodec<E>(),
) {
  journal.persistEvents(
    CategoryId(category),
    EntityId(entityId),
    [event],
    SequenceNr(seqNr - 1), // startSequenceNr is pre-increment
    codec,
  );
}

// --- Single-stream projection ---

type OrderSummaryView = {
  status: string;
  total: number;
  trackingId: string | undefined;
};

const orderSummary = projection<OrderEvent, OrderSummaryView>({
  projectionId: "order-summary",
  category: "order",
  evolve: (view, event) => {
    switch (event.tag) {
      case "OrderPlaced":
        return { ...view, status: "placed", total: event.total };
      case "OrderShipped":
        return { ...view, status: "shipped", trackingId: event.trackingId };
      case "OrderCancelled":
        return { ...view, status: "cancelled" };
      default:
        return view;
    }
  },
  initialState: () => ({ status: "draft", total: 0, trackingId: undefined }),
});

// --- Multi-stream projection ---

type CustomerDashboardView = {
  orderCount: number;
  totalPaid: number;
};

const customerDashboard = projection<OrderEvent | PaymentEvent, CustomerDashboardView>({
  projectionId: "customer-dashboard",
  sources: [
    {
      category: "order",
      getViewId: (event, _entityId) => {
        if ("customerId" in event) return event.customerId;
        return "unknown";
      },
    },
    {
      category: "payment",
      getViewId: (event, _entityId) => {
        if ("customerId" in event) return event.customerId;
        return "unknown";
      },
    },
  ],
  evolve: (view, event) => {
    switch (event.tag) {
      case "OrderPlaced":
        return { ...view, orderCount: view.orderCount + 1 };
      case "PaymentReceived":
        return { ...view, totalPaid: view.totalPaid + event.amount };
      default:
        return view;
    }
  },
  initialState: () => ({ orderCount: 0, totalPaid: 0 }),
});

// --- Tests ---

describe("projection() factory", () => {
  it("creates a single-stream projection descriptor", () => {
    expect(orderSummary.projectionId).toBe("order-summary");
    expect(orderSummary.category).toBe("order");
    expect(orderSummary.initialState()).toEqual({ status: "draft", total: 0, trackingId: undefined });
  });

  it("creates a multi-stream projection descriptor", () => {
    expect(customerDashboard.projectionId).toBe("customer-dashboard");
    expect(customerDashboard.sources).toHaveLength(2);
    expect(customerDashboard.sources[0].category).toBe("order");
    expect(customerDashboard.sources[1].category).toBe("payment");
  });
});

describe("InMemoryProjectionStore", () => {
  let store: ProjectionStore;

  beforeEach(() => {
    store = createInMemoryProjectionStore();
  });

  it("get returns undefined for missing view", () => {
    expect(store.get("proj", "missing")).toBeUndefined();
  });

  it("put and get a view", () => {
    store.put("proj", "v1", { viewId: "v1", view: { count: 42 }, sequenceNr: SequenceNr(3) });
    const result = store.get("proj", "v1");
    expect(result).toEqual({ viewId: "v1", view: { count: 42 }, sequenceNr: SequenceNr(3) });
  });

  it("list returns all views for a projection", () => {
    store.put("proj", "v1", { viewId: "v1", view: { a: 1 }, sequenceNr: SequenceNr(1) });
    store.put("proj", "v2", { viewId: "v2", view: { a: 2 }, sequenceNr: SequenceNr(2) });
    store.put("other", "v3", { viewId: "v3", view: { a: 3 }, sequenceNr: SequenceNr(3) });

    const views = store.list("proj");
    expect(views).toHaveLength(2);
  });

  it("list returns empty for unknown projection", () => {
    expect(store.list("unknown")).toEqual([]);
  });

  it("getOffset returns 0 for untracked entity", () => {
    expect(store.getOffset("proj", "cat", "e1")).toBe(0);
  });

  it("setOffset and getOffset round-trip", () => {
    store.setOffset("proj", "cat", "e1", SequenceNr(5));
    expect(store.getOffset("proj", "cat", "e1")).toBe(5);
  });

  it("clear removes views and offsets for a projection", () => {
    store.put("proj", "v1", { viewId: "v1", view: {}, sequenceNr: SequenceNr(1) });
    store.setOffset("proj", "cat", "e1", SequenceNr(5));
    store.put("other", "v2", { viewId: "v2", view: {}, sequenceNr: SequenceNr(1) });

    store.clear("proj");

    expect(store.get("proj", "v1")).toBeUndefined();
    expect(store.getOffset("proj", "cat", "e1")).toBe(0);
    // Other projection unaffected
    expect(store.get("other", "v2")).toBeDefined();
  });

  it("put overwrites existing view", () => {
    store.put("proj", "v1", { viewId: "v1", view: { count: 1 }, sequenceNr: SequenceNr(1) });
    store.put("proj", "v1", { viewId: "v1", view: { count: 2 }, sequenceNr: SequenceNr(2) });
    expect(store.get("proj", "v1")?.view).toEqual({ count: 2 });
  });
});

describe("runProjection (single-stream)", () => {
  let journal: Journal;
  let store: ProjectionStore;

  beforeEach(() => {
    journal = createInMemoryJournal();
    store = createInMemoryProjectionStore();
  });

  it("projects events into view documents", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "c1" }, 1);
    persistEvent(journal, "order", "order-1", { tag: "OrderShipped", trackingId: "TR-123" }, 2);

    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    const view = store.get<OrderSummaryView>("order-summary", "order-1");
    expect(view?.view).toEqual({ status: "shipped", total: 100, trackingId: "TR-123" });
    expect(view?.sequenceNr).toBe(2);
  });

  it("projects multiple entities independently", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 50, customerId: "c1" }, 1);
    persistEvent(journal, "order", "order-2", { tag: "OrderPlaced", total: 200, customerId: "c2" }, 1);
    persistEvent(journal, "order", "order-2", { tag: "OrderCancelled" }, 2);

    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    expect(store.get<OrderSummaryView>("order-summary", "order-1")?.view).toEqual({
      status: "placed", total: 50, trackingId: undefined,
    });
    expect(store.get<OrderSummaryView>("order-summary", "order-2")?.view).toEqual({
      status: "cancelled", total: 200, trackingId: undefined,
    });
  });

  it("list returns all projected views", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 10, customerId: "c1" }, 1);
    persistEvent(journal, "order", "order-2", { tag: "OrderPlaced", total: 20, customerId: "c2" }, 1);

    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    const views = store.list<OrderSummaryView>("order-summary");
    expect(views).toHaveLength(2);
  });

  it("is resumable — only processes new events", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "c1" }, 1);
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    // Add more events
    persistEvent(journal, "order", "order-1", { tag: "OrderShipped", trackingId: "TR-999" }, 2);
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    const view = store.get<OrderSummaryView>("order-summary", "order-1");
    expect(view?.view.status).toBe("shipped");
    expect(view?.view.trackingId).toBe("TR-999");
    expect(view?.sequenceNr).toBe(2);
  });

  it("handles empty journal gracefully", () => {
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });
    expect(store.list("order-summary")).toEqual([]);
  });

  it("ignores events from other categories", () => {
    persistEvent(journal, "payment", "p1", { tag: "PaymentReceived", amount: 50, customerId: "c1" }, 1, paymentCodec);
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });
    expect(store.list("order-summary")).toEqual([]);
  });

  it("uses auto-derived codec when not specified", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 75, customerId: "c1" }, 1);
    runProjection(orderSummary, journal, store); // no eventCodec
    expect(store.get<OrderSummaryView>("order-summary", "order-1")?.view.total).toBe(75);
  });
});

describe("runMultiStreamProjection", () => {
  let journal: Journal;
  let store: ProjectionStore;

  beforeEach(() => {
    journal = createInMemoryJournal();
    store = createInMemoryProjectionStore();
  });

  it("aggregates events from multiple categories into shared views", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "customer-A" }, 1);
    persistEvent(journal, "order", "order-2", { tag: "OrderPlaced", total: 50, customerId: "customer-A" }, 1);
    persistEvent(journal, "payment", "pay-1", { tag: "PaymentReceived", amount: 75, customerId: "customer-A" }, 1, paymentCodec);

    runMultiStreamProjection(customerDashboard, journal, store);

    const view = store.get<CustomerDashboardView>("customer-dashboard", "customer-A");
    expect(view?.view).toEqual({ orderCount: 2, totalPaid: 75 });
  });

  it("creates separate views for different view IDs", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "A" }, 1);
    persistEvent(journal, "order", "order-2", { tag: "OrderPlaced", total: 50, customerId: "B" }, 1);

    runMultiStreamProjection(customerDashboard, journal, store);

    expect(store.get<CustomerDashboardView>("customer-dashboard", "A")?.view.orderCount).toBe(1);
    expect(store.get<CustomerDashboardView>("customer-dashboard", "B")?.view.orderCount).toBe(1);
  });

  it("is resumable across categories", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "A" }, 1);
    runMultiStreamProjection(customerDashboard, journal, store);

    persistEvent(journal, "payment", "pay-1", { tag: "PaymentReceived", amount: 50, customerId: "A" }, 1, paymentCodec);
    runMultiStreamProjection(customerDashboard, journal, store);

    expect(store.get<CustomerDashboardView>("customer-dashboard", "A")?.view).toEqual({
      orderCount: 1, totalPaid: 50,
    });
  });

  it("handles empty sources gracefully", () => {
    runMultiStreamProjection(customerDashboard, journal, store);
    expect(store.list("customer-dashboard")).toEqual([]);
  });
});

describe("rebuildProjection", () => {
  let journal: Journal;
  let store: ProjectionStore;

  beforeEach(() => {
    journal = createInMemoryJournal();
    store = createInMemoryProjectionStore();
  });

  it("clears and rebuilds from scratch", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "c1" }, 1);
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    // Verify initial state
    expect(store.get<OrderSummaryView>("order-summary", "order-1")?.view.total).toBe(100);

    // Rebuild — should produce same result
    rebuildProjection(orderSummary, journal, store, { eventCodec: orderCodec });
    expect(store.get<OrderSummaryView>("order-summary", "order-1")?.view.total).toBe(100);
  });

  it("removes stale views on rebuild", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "c1" }, 1);
    runProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    // Manually add a stale view that shouldn't exist
    store.put("order-summary", "stale-entity", {
      viewId: "stale-entity",
      view: { status: "ghost", total: 0, trackingId: undefined },
      sequenceNr: SequenceNr(99),
    });

    rebuildProjection(orderSummary, journal, store, { eventCodec: orderCodec });

    expect(store.get("order-summary", "stale-entity")).toBeUndefined();
    expect(store.get<OrderSummaryView>("order-summary", "order-1")?.view.total).toBe(100);
  });
});

describe("rebuildMultiStreamProjection", () => {
  let journal: Journal;
  let store: ProjectionStore;

  beforeEach(() => {
    journal = createInMemoryJournal();
    store = createInMemoryProjectionStore();
  });

  it("clears and rebuilds multi-stream projection", () => {
    persistEvent(journal, "order", "order-1", { tag: "OrderPlaced", total: 100, customerId: "A" }, 1);
    persistEvent(journal, "payment", "pay-1", { tag: "PaymentReceived", amount: 50, customerId: "A" }, 1, paymentCodec);

    runMultiStreamProjection(customerDashboard, journal, store);
    expect(store.get<CustomerDashboardView>("customer-dashboard", "A")?.view.orderCount).toBe(1);

    rebuildMultiStreamProjection(customerDashboard, journal, store);
    expect(store.get<CustomerDashboardView>("customer-dashboard", "A")?.view).toEqual({
      orderCount: 1, totalPaid: 50,
    });
  });
});

describe("integration: projection with entity runtime", () => {
  it("projects events written by aggregate runtime", async () => {
    // Use the inmem runtime to write events, then project them
    const { createInMemoryRuntime, registration } = await import("../src/inmem/runtime.js");
    const { persist, reply } = await import("../src/core/effect.js");
    const { categoryTypes } = await import("../src/core/effect-control.js");
    const { objectCodec } = await import("../src/core/codec.js");

    type Cmd = { tag: "Place"; total: number } | { tag: "GetStatus" };
    type Evt = { tag: "Placed"; total: number };
    type Rpl = { tag: "Status"; status: string };
    type St = { placed: boolean; total: number };

    const agg = {
      category: CategoryId("order"),
      initial: () => ({ placed: false, total: 0 }),
      async decide(state: St, command: Cmd) {
        switch (command.tag) {
          case "Place":
            return persist({ tag: "Placed" as const, total: command.total });
          case "GetStatus":
            return reply({ tag: "Status" as const, status: state.placed ? "placed" : "draft" });
        }
      },
      apply(state: St, event: Evt): St {
        switch (event.tag) {
          case "Placed":
            return { placed: true, total: event.total };
        }
      },
    };

    const evtCodec = tagCodec<Evt>("Placed");
    const stCodec = objectCodec<St>("OrderState");
    const cat = categoryTypes<Cmd, Rpl>(CategoryId("order"));

    const { runtime, journal } = createInMemoryRuntime([registration(agg, evtCodec, stCodec)]);

    // Write events via runtime
    await runtime.ask(EntityId("o1"), { tag: "Place", total: 250 }, cat);
    await runtime.ask(EntityId("o2"), { tag: "Place", total: 100 }, cat);

    // Project
    const orderView = projection<Evt, { total: number; count: number }>({
      projectionId: "order-totals",
      category: "order",
      evolve: (view, event) => {
        switch (event.tag) {
          case "Placed":
            return { total: event.total, count: view.count + 1 };
        }
      },
      initialState: () => ({ total: 0, count: 0 }),
    });

    const store = createInMemoryProjectionStore();
    runProjection(orderView, journal, store, { eventCodec: evtCodec });

    expect(store.get("order-totals", "o1")?.view).toEqual({ total: 250, count: 1 });
    expect(store.get("order-totals", "o2")?.view).toEqual({ total: 100, count: 1 });
    expect(store.list("order-totals")).toHaveLength(2);

    await runtime.shutdown();
  });
});
