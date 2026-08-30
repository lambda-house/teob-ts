// telemetry — OpenTelemetry integration for TEOB entity runtimes

import type { EntityId, CategoryId, SequenceNr } from "../core/types.js";
import type { CategoryRegistration, Either, ReplyError } from "../core/effect-control.js";
import type { EntityRuntime, AskResult } from "../core/runtime.js";
import type { Codec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";

// --- OTel API types (peer dependency) ---
// We use dynamic imports to avoid hard dependency on @opentelemetry/api.
// When OTel is not installed, we use no-op fallbacks.

interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

interface Tracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): Span;
}

interface Counter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface Histogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface Meter {
  createCounter(name: string, options?: { description?: string }): Counter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): Histogram;
}

// --- No-op implementations ---

const noopSpan: Span = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const noopTracer: Tracer = {
  startSpan() { return noopSpan; },
};

const noopCounter: Counter = { add() {} };
const noopHistogram: Histogram = { record() {} };

const noopMeter: Meter = {
  createCounter() { return noopCounter; },
  createHistogram() { return noopHistogram; },
};

// --- Telemetry provider ---

export interface TelemetryProvider {
  tracer: Tracer;
  meter: Meter;
}

/**
 * Try to load @opentelemetry/api. Returns no-op provider if not available.
 */
export function loadTelemetryProvider(serviceName: string = "teob"): TelemetryProvider {
  try {
    // Dynamic require to avoid hard dependency
    const api = require("@opentelemetry/api");
    return {
      tracer: api.trace.getTracer(serviceName),
      meter: api.metrics.getMeter(serviceName),
    };
  } catch {
    return { tracer: noopTracer, meter: noopMeter };
  }
}

/** Create a telemetry provider from explicit tracer/meter instances. */
export function createTelemetryProvider(tracer: Tracer, meter: Meter): TelemetryProvider {
  return { tracer, meter };
}

// --- Instrumented Runtime ---

export interface WithTelemetryOptions {
  /** Custom telemetry provider. If not provided, auto-loads from @opentelemetry/api. */
  provider?: TelemetryProvider;
  /** Service name for OTel spans. Defaults to "teob". */
  serviceName?: string;
}

/**
 * Wrap an EntityRuntime with OpenTelemetry instrumentation.
 *
 * Adds:
 * - Spans for command processing (tell/ask)
 * - Command count counter
 * - Command duration histogram
 *
 * If @opentelemetry/api is not installed, returns a pass-through wrapper with zero overhead.
 */
export function withTelemetry(
  runtime: EntityRuntime,
  opts?: WithTelemetryOptions,
): EntityRuntime {
  const provider = opts?.provider ?? loadTelemetryProvider(opts?.serviceName);
  const { tracer, meter } = provider;

  const commandCount = meter.createCounter("teob.command.count", {
    description: "Number of commands processed",
  });

  const commandDuration = meter.createHistogram("teob.command.duration", {
    description: "Command processing duration",
    unit: "ms",
  });

  function startCommandSpan(
    operation: string,
    entityId: EntityId,
    categoryId: string,
    command: unknown,
  ): { span: Span; startTime: number } {
    const commandTag = typeof command === "object" && command !== null && "tag" in command
      ? (command as any).tag
      : "unknown";

    const span = tracer.startSpan(`${operation} ${categoryId}`, {
      attributes: {
        "teob.entity_id": entityId,
        "teob.category": categoryId,
        "teob.command": commandTag,
        "teob.operation": operation,
      },
    });

    return { span, startTime: Date.now() };
  }

  function endCommandSpan(
    span: Span,
    startTime: number,
    categoryId: string,
    command: unknown,
    error?: boolean,
  ): void {
    const duration = Date.now() - startTime;
    const commandTag = typeof command === "object" && command !== null && "tag" in command
      ? (command as any).tag
      : "unknown";

    const attrs = { category: categoryId, command: commandTag };

    commandCount.add(1, attrs);
    commandDuration.record(duration, attrs);

    if (error) {
      span.setStatus({ code: 2, message: "error" }); // SpanStatusCode.ERROR = 2
    } else {
      span.setStatus({ code: 1 }); // SpanStatusCode.OK = 1
    }

    span.end();
  }

  return {
    async tell<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<void> {
      const { span, startTime } = startCommandSpan("tell", entityId, cat.categoryId, command);
      try {
        await runtime.tell(entityId, command, cat);
        endCommandSpan(span, startTime, cat.categoryId, command);
      } catch (err) {
        endCommandSpan(span, startTime, cat.categoryId, command, true);
        throw err;
      }
    },

    async ask<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<Either<ReplyError, AskResult<R>>> {
      const { span, startTime } = startCommandSpan("ask", entityId, cat.categoryId, command);
      try {
        const result = await runtime.ask(entityId, command, cat);
        endCommandSpan(span, startTime, cat.categoryId, command, !result.ok);
        if (result.ok && result.value.meta) {
          span.setAttribute("teob.sequence_nr", result.value.meta.sequenceNr);
        }
        return result;
      } catch (err) {
        endCommandSpan(span, startTime, cat.categoryId, command, true);
        throw err;
      }
    },

    categories(): Set<CategoryId> {
      return runtime.categories();
    },

    async start(): Promise<void> {
      return runtime.start();
    },

    async shutdown(): Promise<void> {
      return runtime.shutdown();
    },
  };
}

// --- Instrumented Journal ---

/**
 * Wrap a Journal with telemetry spans for persist and load operations.
 *
 * Adds spans for:
 * - `journal.persistEvents` with event count attribute
 * - `journal.loadEvents` with events loaded count
 * - `journal.persistSnapshot` / `journal.loadSnapshot`
 *
 * Also records `teob.events.persisted` counter.
 */
export function withJournalTelemetry(
  journal: Journal,
  opts?: WithTelemetryOptions,
): Journal {
  const provider = opts?.provider ?? loadTelemetryProvider(opts?.serviceName);
  const { tracer, meter } = provider;

  const eventsPersisted = meter.createCounter("teob.events.persisted", {
    description: "Number of events persisted",
  });

  const entityLoadDuration = meter.createHistogram("teob.entity.load.duration", {
    description: "Entity load (events replay) duration",
    unit: "ms",
  });

  return {
    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      events: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): SequenceNr {
      const span = tracer.startSpan("journal.persist", {
        attributes: {
          "teob.category": categoryId,
          "teob.entity_id": entityId,
          "teob.event_count": events.length,
        },
      });
      try {
        const result = journal.persistEvents(categoryId, entityId, events, startSequenceNr, codec);
        eventsPersisted.add(events.length, { category: categoryId });
        span.setAttribute("teob.sequence_nr", result as number);
        span.setStatus({ code: 1 });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        span.end();
        throw err;
      }
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      const start = Date.now();
      const span = tracer.startSpan("journal.loadEvents", {
        attributes: {
          "teob.category": categoryId,
          "teob.entity_id": entityId,
          "teob.from_sequence_nr": fromSequenceNr as number,
        },
      });
      try {
        const result = journal.loadEvents(categoryId, entityId, fromSequenceNr, codec);
        span.setAttribute("teob.events_replayed", result.length);
        entityLoadDuration.record(Date.now() - start, { category: categoryId });
        span.setStatus({ code: 1 });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        span.end();
        throw err;
      }
    },

    persistSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      state: S,
      sequenceNr: SequenceNr,
      codec: Codec<S>,
    ): void {
      const span = tracer.startSpan("journal.persistSnapshot", {
        attributes: {
          "teob.category": categoryId,
          "teob.entity_id": entityId,
          "teob.sequence_nr": sequenceNr as number,
        },
      });
      try {
        journal.persistSnapshot(categoryId, entityId, state, sequenceNr, codec);
        span.setStatus({ code: 1 });
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        throw err;
      } finally {
        span.end();
      }
    },

    loadSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      codec: Codec<S>,
    ): { sequenceNr: SequenceNr; state: S } | undefined {
      const span = tracer.startSpan("journal.loadSnapshot", {
        attributes: {
          "teob.category": categoryId,
          "teob.entity_id": entityId,
        },
      });
      try {
        const result = journal.loadSnapshot(categoryId, entityId, codec);
        span.setAttribute("teob.snapshot_found", result !== undefined);
        if (result) span.setAttribute("teob.sequence_nr", result.sequenceNr as number);
        span.setStatus({ code: 1 });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: 2, message: "error" });
        span.end();
        throw err;
      }
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      return journal.allEvents(categoryId, codec);
    },
  };
}

export { instrumentCallGateway } from "./instrumented-call-gateway.js";
export type { InstrumentedCallGatewayOpts } from "./instrumented-call-gateway.js";
