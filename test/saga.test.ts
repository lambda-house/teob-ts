import { describe, it, expect, beforeEach } from "vitest";
import {
  saga,
  statefulSaga,
  runSaga,
  runStatefulSaga,
  createInMemorySagaStore,
  type SagaOffsetStore,
} from "../src/saga/index.js";
import { createInMemoryRuntime, registration } from "../src/inmem/runtime.js";
import { createInMemoryJournal, type Journal } from "../src/inmem/journal.js";
import type { EntityRuntime } from "../src/core/runtime.js";
import type { Aggregate } from "../src/core/aggregate.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { persist, reply } from "../src/core/effect.js";
import { categoryTypes } from "../src/core/effect-control.js";

// --- Test aggregates ---

// Order aggregate
type OrderCommand =
  | { tag: "Place"; total: number }
  | { tag: "Cancel"; reason: string }
  | { tag: "MarkPaid" }
  | { tag: "GetStatus" };

type OrderEvent =
  | { tag: "OrderPlaced"; total: number }
  | { tag: "OrderCancelled"; reason: string }
  | { tag: "OrderPaid" };

type OrderReply = { tag: "Status"; status: string };
type OrderState = { status: string; total: number };

const orderAggregate: Aggregate<OrderCommand, OrderReply, OrderEvent, OrderState> = {
  category: CategoryId("order"),
  initial: () => ({ status: "draft", total: 0 }),
  async decide(state, command) {
    switch (command.tag) {
      case "Place": return persist({ tag: "OrderPlaced", total: command.total });
      case "Cancel": return persist({ tag: "OrderCancelled", reason: command.reason });
      case "MarkPaid": return persist({ tag: "OrderPaid" });
      case "GetStatus": return reply({ tag: "Status", status: state.status });
    }
  },
  apply(state, event) {
    switch (event.tag) {
      case "OrderPlaced": return { ...state, status: "placed", total: event.total };
      case "OrderCancelled": return { ...state, status: "cancelled" };
      case "OrderPaid": return { ...state, status: "paid" };
    }
  },
};

// Payment aggregate
type PaymentCommand =
  | { tag: "Charge"; amount: number }
  | { tag: "GetStatus" };

type PaymentEvent = { tag: "PaymentCharged"; amount: number };
type PaymentReply = { tag: "Ok" } | { tag: "Status"; charged: boolean };
type PaymentState = { charged: boolean; amount: number };

const paymentAggregate: Aggregate<PaymentCommand, PaymentReply, PaymentEvent, PaymentState> = {
  category: CategoryId("payment"),
  initial: () => ({ charged: false, amount: 0 }),
  async decide(state, command) {
    switch (command.tag) {
      case "Charge": return persist({ tag: "PaymentCharged", amount: command.amount });
      case "GetStatus": return reply({ tag: "Status", charged: state.charged });
    }
  },
  apply(state, event) {
    switch (event.tag) {
      case "PaymentCharged": return { charged: true, amount: event.amount };
    }
  },
};

const orderCategory = categoryTypes<OrderCommand, OrderReply>(CategoryId("order"));
const paymentCategory = categoryTypes<PaymentCommand, PaymentReply>(CategoryId("payment"));

const orderEventCodec = tagCodec<OrderEvent>("OrderPlaced", "OrderCancelled", "OrderPaid");
const orderStateCodec = objectCodec<OrderState>("OrderState");
const paymentEventCodec = tagCodec<PaymentEvent>("PaymentCharged");
const paymentStateCodec = objectCodec<PaymentState>("PaymentState");

// --- Helpers ---

function createTestRuntime(): { runtime: EntityRuntime; journal: Journal } {
  return createInMemoryRuntime([
    registration(orderAggregate, orderEventCodec, orderStateCodec),
    registration(paymentAggregate, paymentEventCodec, paymentStateCodec),
  ]);
}

// --- Tests ---

describe("saga() factory", () => {
  it("creates a saga definition", () => {
    const s = saga({
      name: "test-saga",
      on: "OrderPlaced",
      from: "order",
      execute: async () => {},
    });
    expect(s.name).toBe("test-saga");
    expect(s.on).toBe("OrderPlaced");
    expect(s.from).toBe("order");
  });
});

describe("statefulSaga() factory", () => {
  it("creates a stateful saga definition", () => {
    const s = statefulSaga({
      name: "fulfillment",
      steps: [
        { on: "OrderPlaced", from: "order", execute: async () => {} },
        { on: "PaymentCharged", from: "payment", execute: async () => {} },
      ],
    });
    expect(s.name).toBe("fulfillment");
    expect(s.steps).toHaveLength(2);
  });
});

describe("createInMemorySagaStore", () => {
  it("returns 0 for untracked offsets", () => {
    const store = createInMemorySagaStore();
    expect(store.getOffset("saga", "cat", "e1")).toBe(0);
  });

  it("tracks offsets", () => {
    const store = createInMemorySagaStore();
    store.setOffset("saga", "cat", "e1", SequenceNr(5));
    expect(store.getOffset("saga", "cat", "e1")).toBe(5);
  });

  it("returns 0 for untracked steps", () => {
    const store = createInMemorySagaStore();
    expect(store.getStep("saga", "e1")).toBe(0);
  });

  it("tracks steps", () => {
    const store = createInMemorySagaStore();
    store.setStep("saga", "e1", 2);
    expect(store.getStep("saga", "e1")).toBe(2);
  });
});

describe("runSaga (stateless)", () => {
  let runtime: EntityRuntime;
  let journal: Journal;
  let store: SagaOffsetStore;

  beforeEach(() => {
    ({ runtime, journal } = createTestRuntime());
    store = createInMemorySagaStore();
  });

  it("triggers execute on matching event", async () => {
    // Place an order
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    // Define saga: when OrderPlaced, charge payment
    const executed: string[] = [];
    const paymentOnOrder = saga({
      name: "payment-on-order",
      on: "OrderPlaced",
      from: "order",
      execute: async (event: any, entityId, ctx) => {
        executed.push(`${entityId}:${event.total}`);
        await ctx.tell(EntityId(entityId), { tag: "Charge", amount: event.total }, paymentCategory);
      },
    });

    await runSaga(paymentOnOrder, journal, runtime, store, { eventCodec: orderEventCodec });

    expect(executed).toEqual(["order-1:100"]);
  });

  it("ignores non-matching event tags", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 50 }, orderCategory);
    await runtime.ask(EntityId("order-1"), { tag: "Cancel", reason: "changed mind" }, orderCategory);

    const executed: string[] = [];
    const cancelSaga = saga({
      name: "on-cancel",
      on: "OrderCancelled",
      from: "order",
      execute: async (_event: any, entityId) => {
        executed.push(entityId);
      },
    });

    await runSaga(cancelSaga, journal, runtime, store, { eventCodec: orderEventCodec });

    // Only OrderCancelled triggers, not OrderPlaced
    expect(executed).toEqual(["order-1"]);
  });

  it("is resumable — only processes new events", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const executed: string[] = [];
    const s = saga({
      name: "test",
      on: "OrderPlaced",
      from: "order",
      execute: async (_e, eid) => { executed.push(eid); },
    });

    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(executed).toEqual(["order-1"]);

    // Run again — should not re-trigger
    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(executed).toEqual(["order-1"]);

    // New event — should trigger
    await runtime.ask(EntityId("order-2"), { tag: "Place", total: 50 }, orderCategory);
    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(executed).toEqual(["order-1", "order-2"]);
  });

  it("handles multiple entities", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);
    await runtime.ask(EntityId("order-2"), { tag: "Place", total: 200 }, orderCategory);
    await runtime.ask(EntityId("order-3"), { tag: "Place", total: 300 }, orderCategory);

    const totals: number[] = [];
    const s = saga({
      name: "collect",
      on: "OrderPlaced",
      from: "order",
      execute: async (event: any) => { totals.push(event.total); },
    });

    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(totals).toEqual([100, 200, 300]);
  });

  it("saga can use ask for request-reply", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const replies: any[] = [];
    const s = saga({
      name: "query-saga",
      on: "OrderPlaced",
      from: "order",
      execute: async (_event, entityId, ctx) => {
        const result = await ctx.ask(EntityId(entityId), { tag: "GetStatus" }, orderCategory);
        if (result.ok) replies.push(result.value);
      },
    });

    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(replies).toEqual([{ tag: "Status", status: "placed" }]);
  });

  it("handles empty journal", async () => {
    const s = saga({
      name: "empty",
      on: "OrderPlaced",
      from: "order",
      execute: async () => { throw new Error("should not execute"); },
    });

    await runSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    // No error = pass
  });
});

describe("runStatefulSaga", () => {
  let runtime: EntityRuntime;
  let journal: Journal;
  let store: SagaOffsetStore;

  beforeEach(() => {
    ({ runtime, journal } = createTestRuntime());
    store = createInMemorySagaStore();
  });

  it("executes steps in order", async () => {
    // Step 1 trigger: OrderPlaced
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const stepLog: string[] = [];

    const s = statefulSaga({
      name: "fulfillment",
      steps: [
        {
          on: "OrderPlaced",
          from: "order",
          execute: async (event: any, entityId) => {
            stepLog.push(`step0:${entityId}:${event.total}`);
          },
        },
        {
          on: "OrderPaid",
          from: "order",
          execute: async (_event, entityId) => {
            stepLog.push(`step1:${entityId}`);
          },
        },
      ],
    });

    // Run — only step 0 should fire (OrderPlaced exists)
    await runStatefulSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(stepLog).toEqual(["step0:order-1:100"]);

    // Add step 1 trigger
    await runtime.ask(EntityId("order-1"), { tag: "MarkPaid" }, orderCategory);
    await runStatefulSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(stepLog).toEqual(["step0:order-1:100", "step1:order-1"]);
  });

  it("calls compensate on step failure", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const compensated: string[] = [];

    const s = statefulSaga({
      name: "failing",
      steps: [
        {
          on: "OrderPlaced",
          from: "order",
          execute: async () => {
            throw new Error("payment failed");
          },
        },
      ],
      compensate: async (failedStep, _event, entityId) => {
        compensated.push(`compensate:step${failedStep}:${entityId}`);
      },
    });

    await runStatefulSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    expect(compensated).toEqual(["compensate:step0:order-1"]);
  });

  it("does not advance step on failure", async () => {
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const s = statefulSaga({
      name: "stuck",
      steps: [
        {
          on: "OrderPlaced",
          from: "order",
          execute: async () => { throw new Error("fail"); },
        },
        {
          on: "OrderPaid",
          from: "order",
          execute: async () => {},
        },
      ],
    });

    await runStatefulSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    // Step should still be 0, not advanced
    expect(store.getStep("stuck", "order-1")).toBe(0);
  });

  it("skips steps for wrong entity step", async () => {
    // Only OrderPlaced exists, but we only have a step 1 definition
    await runtime.ask(EntityId("order-1"), { tag: "Place", total: 100 }, orderCategory);

    const executed: string[] = [];

    // Start at step 1 by manually setting step
    store.setStep("out-of-order", "order-1", 1);

    const s = statefulSaga({
      name: "out-of-order",
      steps: [
        {
          on: "OrderPlaced",
          from: "order",
          execute: async (_, eid) => { executed.push(`step0:${eid}`); },
        },
        {
          on: "OrderPaid",
          from: "order",
          execute: async (_, eid) => { executed.push(`step1:${eid}`); },
        },
      ],
    });

    await runStatefulSaga(s, journal, runtime, store, { eventCodec: orderEventCodec });
    // step0 should not fire since entity is already at step 1
    expect(executed).toEqual([]);
  });
});
