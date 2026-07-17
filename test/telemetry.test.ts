import { describe, it, expect, beforeEach } from "vitest";
import {
  withTelemetry,
  withJournalTelemetry,
  createTelemetryProvider,
  loadTelemetryProvider,
} from "../src/telemetry/index.js";
import { createSingleRuntime, createInMemoryRuntime, registration } from "../src/inmem/runtime.js";
import { createInMemoryJournal } from "../src/inmem/journal.js";
import { CategoryId, EntityId, SequenceNr } from "../src/core/types.js";
import { tagCodec, objectCodec } from "../src/core/codec.js";
import { persist, reply, andReply } from "../src/core/effect.js";
import { categoryTypes } from "../src/core/effect-control.js";
import type { Aggregate } from "../src/core/aggregate.js";

// --- Mock OTel ---

interface MockSpan {
  name: string;
  attributes: Record<string, any>;
  status: { code: number; message?: string } | undefined;
  ended: boolean;
}

function createMockTracer() {
  const spans: MockSpan[] = [];

  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, any> }) {
      const span: MockSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        status: undefined,
        ended: false,
      };
      spans.push(span);
      return {
        setAttribute(key: string, value: any) { span.attributes[key] = value; },
        setStatus(s: { code: number; message?: string }) { span.status = s; },
        end() { span.ended = true; },
      };
    },
  };

  return { tracer, spans };
}

interface MockMetric {
  name: string;
  value: number;
  attributes: Record<string, any>;
}

function createMockMeter() {
  const counters: MockMetric[] = [];
  const histograms: MockMetric[] = [];

  const meter = {
    createCounter(name: string) {
      return {
        add(value: number, attrs?: Record<string, any>) {
          counters.push({ name, value, attributes: attrs ?? {} });
        },
      };
    },
    createHistogram(name: string) {
      return {
        record(value: number, attrs?: Record<string, any>) {
          histograms.push({ name, value, attributes: attrs ?? {} });
        },
      };
    },
  };

  return { meter, counters, histograms };
}

// --- Test aggregate ---

type Cmd = { tag: "Increment" } | { tag: "GetCount" };
type Evt = { tag: "Incremented" };
type Rpl = { tag: "Count"; count: number };
type St = { count: number };

const counterAggregate: Aggregate<Cmd, Rpl, Evt, St> = {
  category: CategoryId("counter"),
  initial: () => ({ count: 0 }),
  async decide(state, command) {
    switch (command.tag) {
      case "Increment":
        return andReply(persist({ tag: "Incremented" }), { tag: "Count", count: state.count + 1 });
      case "GetCount":
        return reply({ tag: "Count", count: state.count });
    }
  },
  apply(state, event) {
    switch (event.tag) {
      case "Incremented": return { count: state.count + 1 };
    }
  },
};

const counterCategory = categoryTypes<Cmd, Rpl>(CategoryId("counter"));

// --- Tests ---

describe("loadTelemetryProvider", () => {
  it("returns no-op provider when OTel is not installed", () => {
    const provider = loadTelemetryProvider();
    // Should not throw, returns no-op
    const span = provider.tracer.startSpan("test");
    span.setAttribute("key", "value");
    span.setStatus({ code: 1 });
    span.end();

    const counter = provider.meter.createCounter("test");
    counter.add(1);

    const histogram = provider.meter.createHistogram("test");
    histogram.record(42);
  });
});

describe("withTelemetry", () => {
  let mockTracer: ReturnType<typeof createMockTracer>;
  let mockMeter: ReturnType<typeof createMockMeter>;

  beforeEach(() => {
    mockTracer = createMockTracer();
    mockMeter = createMockMeter();
  });

  function createInstrumentedRuntime() {
    const { runtime } = createSingleRuntime(
      counterAggregate,
      tagCodec<Evt>("Incremented"),
      objectCodec<St>("CounterState"),
    );
    const provider = createTelemetryProvider(mockTracer.tracer, mockMeter.meter);
    return withTelemetry(runtime, { provider });
  }

  it("creates spans for tell", async () => {
    const runtime = createInstrumentedRuntime();

    await runtime.tell(EntityId("c1"), { tag: "Increment" }, counterCategory);

    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("tell counter");
    expect(mockTracer.spans[0].attributes["teob.command"]).toBe("Increment");
    expect(mockTracer.spans[0].attributes["teob.entity_id"]).toBe("c1");
    expect(mockTracer.spans[0].attributes["teob.category"]).toBe("counter");
    expect(mockTracer.spans[0].ended).toBe(true);
    expect(mockTracer.spans[0].status?.code).toBe(1); // OK

    await runtime.shutdown();
  });

  it("creates spans for ask", async () => {
    const runtime = createInstrumentedRuntime();

    const result = await runtime.ask(EntityId("c1"), { tag: "Increment" }, counterCategory);
    expect(result.ok).toBe(true);

    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("ask counter");
    expect(mockTracer.spans[0].attributes["teob.command"]).toBe("Increment");
    expect(mockTracer.spans[0].ended).toBe(true);

    await runtime.shutdown();
  });

  it("ask returns meta with sequence_nr in span", async () => {
    const runtime = createInstrumentedRuntime();

    const result = await runtime.ask(EntityId("c1"), { tag: "Increment" }, counterCategory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta?.sequenceNr).toBe(1);
    }

    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("ask counter");
    expect(mockTracer.spans[0].attributes["teob.sequence_nr"]).toBe(1);
    expect(mockTracer.spans[0].ended).toBe(true);

    await runtime.shutdown();
  });

  it("records command count metrics", async () => {
    const runtime = createInstrumentedRuntime();

    await runtime.ask(EntityId("c1"), { tag: "Increment" }, counterCategory);
    await runtime.ask(EntityId("c1"), { tag: "GetCount" }, counterCategory);

    expect(mockMeter.counters).toHaveLength(2);
    expect(mockMeter.counters[0].name).toBe("teob.command.count");
    expect(mockMeter.counters[0].attributes.command).toBe("Increment");
    expect(mockMeter.counters[1].attributes.command).toBe("GetCount");

    await runtime.shutdown();
  });

  it("records command duration histograms", async () => {
    const runtime = createInstrumentedRuntime();

    await runtime.ask(EntityId("c1"), { tag: "Increment" }, counterCategory);

    expect(mockMeter.histograms).toHaveLength(1);
    expect(mockMeter.histograms[0].name).toBe("teob.command.duration");
    expect(mockMeter.histograms[0].value).toBeGreaterThanOrEqual(0);
    expect(mockMeter.histograms[0].attributes.category).toBe("counter");

    await runtime.shutdown();
  });

  it("delegates categories/start/shutdown to underlying runtime", async () => {
    const runtime = createInstrumentedRuntime();

    const cats = runtime.categories();
    expect(cats.has(CategoryId("counter"))).toBe(true);

    await runtime.start();
    await runtime.shutdown();
  });

  it("marks span as error when ask returns error", async () => {
    const runtime = createInstrumentedRuntime();

    // Ask for non-existent category
    const badCat = categoryTypes(CategoryId("nonexistent"));
    const result = await runtime.ask(EntityId("c1"), { tag: "Increment" }, badCat);
    expect(result.ok).toBe(false);

    expect(mockTracer.spans[0].status?.code).toBe(2); // ERROR

    await runtime.shutdown();
  });

  it("works with no-op provider (zero overhead)", async () => {
    const { runtime } = createSingleRuntime(
      counterAggregate,
      tagCodec<Evt>("Incremented"),
      objectCodec<St>("CounterState"),
    );
    // No provider = uses loadTelemetryProvider which returns no-ops
    const instrumented = withTelemetry(runtime);

    const result = await instrumented.ask(EntityId("c1"), { tag: "Increment" }, counterCategory);
    expect(result.ok).toBe(true);

    await instrumented.shutdown();
  });
});

describe("withJournalTelemetry", () => {
  let mockTracer: ReturnType<typeof createMockTracer>;
  let mockMeter: ReturnType<typeof createMockMeter>;

  beforeEach(() => {
    mockTracer = createMockTracer();
    mockMeter = createMockMeter();
  });

  function instrumentJournal() {
    const journal = createInMemoryJournal();
    const provider = createTelemetryProvider(mockTracer.tracer, mockMeter.meter);
    const instrumented = withJournalTelemetry(journal, { provider });
    return { journal, instrumented };
  }

  it("creates span for persistEvents", () => {
    const { instrumented } = instrumentJournal();
    const evtCodec = tagCodec<Evt>("Incremented");

    instrumented.persistEvents(
      CategoryId("counter"), EntityId("c1"),
      [{ tag: "Incremented" }], SequenceNr(0), evtCodec,
    );

    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("journal.persist");
    expect(mockTracer.spans[0].attributes["teob.event_count"]).toBe(1);
    expect(mockTracer.spans[0].attributes["teob.category"]).toBe("counter");
    expect(mockTracer.spans[0].ended).toBe(true);
  });

  it("records teob.events.persisted counter", () => {
    const { instrumented } = instrumentJournal();
    const evtCodec = tagCodec<Evt>("Incremented");

    instrumented.persistEvents(
      CategoryId("counter"), EntityId("c1"),
      [{ tag: "Incremented" }, { tag: "Incremented" }], SequenceNr(0), evtCodec,
    );

    expect(mockMeter.counters).toHaveLength(1);
    expect(mockMeter.counters[0].name).toBe("teob.events.persisted");
    expect(mockMeter.counters[0].value).toBe(2);
  });

  it("creates span for loadEvents", () => {
    const { instrumented } = instrumentJournal();
    const evtCodec = tagCodec<Evt>("Incremented");

    // Persist first, then load
    instrumented.persistEvents(
      CategoryId("counter"), EntityId("c1"),
      [{ tag: "Incremented" }], SequenceNr(0), evtCodec,
    );
    mockTracer.spans.length = 0; // reset

    const events = instrumented.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), evtCodec);

    expect(events).toHaveLength(1);
    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("journal.loadEvents");
    expect(mockTracer.spans[0].attributes["teob.events_replayed"]).toBe(1);
  });

  it("records entity load duration histogram", () => {
    const { instrumented } = instrumentJournal();
    const evtCodec = tagCodec<Evt>("Incremented");

    instrumented.persistEvents(
      CategoryId("counter"), EntityId("c1"),
      [{ tag: "Incremented" }], SequenceNr(0), evtCodec,
    );
    mockMeter.histograms.length = 0;

    instrumented.loadEvents(CategoryId("counter"), EntityId("c1"), SequenceNr(0), evtCodec);

    expect(mockMeter.histograms).toHaveLength(1);
    expect(mockMeter.histograms[0].name).toBe("teob.entity.load.duration");
  });

  it("creates span for persistSnapshot", () => {
    const { instrumented } = instrumentJournal();
    const stCodec = objectCodec<St>("CounterState");

    instrumented.persistSnapshot(CategoryId("counter"), EntityId("c1"), { count: 5 }, SequenceNr(5), stCodec);

    const snap = mockTracer.spans.find((s) => s.name === "journal.persistSnapshot");
    expect(snap).toBeDefined();
    expect(snap!.attributes["teob.sequence_nr"]).toBe(5);
  });

  it("creates span for loadSnapshot", () => {
    const { instrumented } = instrumentJournal();
    const stCodec = objectCodec<St>("CounterState");

    instrumented.persistSnapshot(CategoryId("counter"), EntityId("c1"), { count: 5 }, SequenceNr(5), stCodec);
    mockTracer.spans.length = 0;

    const snap = instrumented.loadSnapshot(CategoryId("counter"), EntityId("c1"), stCodec);

    expect(snap).toBeDefined();
    expect(mockTracer.spans).toHaveLength(1);
    expect(mockTracer.spans[0].name).toBe("journal.loadSnapshot");
    expect(mockTracer.spans[0].attributes["teob.snapshot_found"]).toBe(true);
  });

  it("records snapshot_found=false when no snapshot", () => {
    const { instrumented } = instrumentJournal();
    const stCodec = objectCodec<St>("CounterState");

    instrumented.loadSnapshot(CategoryId("counter"), EntityId("missing"), stCodec);

    expect(mockTracer.spans[0].attributes["teob.snapshot_found"]).toBe(false);
  });

  it("delegates allEvents without span", () => {
    const { instrumented } = instrumentJournal();
    const evtCodec = tagCodec<Evt>("Incremented");

    instrumented.persistEvents(
      CategoryId("counter"), EntityId("c1"),
      [{ tag: "Incremented" }], SequenceNr(0), evtCodec,
    );

    const all = instrumented.allEvents(CategoryId("counter"), evtCodec);
    expect(all).toHaveLength(1);
  });
});
