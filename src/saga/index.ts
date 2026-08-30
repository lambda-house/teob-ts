// saga — lightweight event-driven choreography and orchestration

import type { EntityId, CategoryId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { CategoryRegistration, Either, ReplyError } from "../core/effect-control.js";
import type { EntityRuntime } from "../core/runtime.js";
import type { Codec } from "../core/codec.js";
import { tagCodec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";

// --- Saga Context ---

/** Context available inside saga execute functions. */
export interface SagaContext {
  /** Send a command without waiting for a reply. */
  tell<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<void>;
  /** Send a command and wait for a reply. */
  ask<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<Either<ReplyError, R | undefined>>;
}

export function createSagaContext(runtime: EntityRuntime): SagaContext {
  return {
    tell: (entityId, command, cat) => runtime.tell(entityId, command, cat),
    async ask(entityId, command, cat) {
      const result = await runtime.ask(entityId, command, cat);
      if (!result.ok) return result;
      return { ok: true as const, value: result.value.reply };
    },
  };
}

// --- Stateless Saga (choreography) ---

/** A stateless saga that reacts to a single event type. */
export interface SagaDefinition<Event = any> {
  name: string;
  /** Event tag to trigger on. */
  on: string;
  /** Source category. */
  from: string;
  /** Handler: receives the event, entity ID, and a context for dispatching commands. */
  execute: (event: Event, entityId: EntityId, ctx: SagaContext) => Promise<void>;
}

/** Create a stateless saga definition. */
export function saga<Event = any>(config: SagaDefinition<Event>): SagaDefinition<Event> {
  return config;
}

// --- Stateful Saga (orchestration) ---

/** A step in a stateful saga. */
export interface SagaStep<Event = any> {
  /** Event tag to trigger this step. */
  on: string;
  /** Source category for this step's trigger event. */
  from: string;
  /** Handler for this step. */
  execute: (event: Event, entityId: EntityId, ctx: SagaContext) => Promise<void>;
}

/** A stateful saga with ordered steps and optional compensation. */
export interface StatefulSagaDefinition<Event = any> {
  name: string;
  steps: SagaStep<Event>[];
  /** Called when a step fails. Receives the failed step index. */
  compensate?: (failedStep: number, event: Event, entityId: EntityId, ctx: SagaContext) => Promise<void>;
}

/** Create a stateful saga definition. */
export function statefulSaga<Event = any>(config: StatefulSagaDefinition<Event>): StatefulSagaDefinition<Event> {
  return config;
}

// --- Saga Runner ---

/** Offset store for tracking processed events. */
export interface SagaOffsetStore {
  getOffset(sagaName: string, category: string, entityId: string): SequenceNr;
  setOffset(sagaName: string, category: string, entityId: string, sequenceNr: SequenceNr): void;
  /** Get step progress for stateful sagas. Key: sagaName + correlationId. */
  getStep(sagaName: string, correlationId: string): number;
  setStep(sagaName: string, correlationId: string, step: number): void;
}

/** Create an in-memory saga offset store. */
export function createInMemorySagaStore(): SagaOffsetStore {
  const offsets = new Map<string, SequenceNr>();
  const steps = new Map<string, number>();

  return {
    getOffset(sagaName, category, entityId) {
      return offsets.get(`${sagaName}:${category}:${entityId}`) ?? mkSeqNr(0);
    },
    setOffset(sagaName, category, entityId, sequenceNr) {
      offsets.set(`${sagaName}:${category}:${entityId}`, sequenceNr);
    },
    getStep(sagaName, correlationId) {
      return steps.get(`${sagaName}:${correlationId}`) ?? 0;
    },
    setStep(sagaName, correlationId, step) {
      steps.set(`${sagaName}:${correlationId}`, step);
    },
  };
}

/** Options for running sagas. */
export interface RunSagaOptions {
  eventCodec?: Codec<any>;
}

/**
 * Run a stateless saga against journal events.
 *
 * Scans all events from the saga's source category, triggers the execute
 * handler for matching event tags, and tracks offsets for resumability.
 */
export async function runSaga(
  sagaDef: SagaDefinition,
  journal: Journal,
  runtime: EntityRuntime,
  store: SagaOffsetStore,
  opts?: RunSagaOptions,
): Promise<void> {
  const codec = opts?.eventCodec ?? tagCodec();
  const ctx = createSagaContext(runtime);
  const categoryId = sagaDef.from as CategoryId;

  const allEvents = journal.allEvents(categoryId, codec);

  for (const { entityId, sequenceNr, event } of allEvents) {
    const lastSeqNr = store.getOffset(sagaDef.name, sagaDef.from, entityId);
    if (sequenceNr <= lastSeqNr) continue;

    if (typeof event === "object" && event !== null && "tag" in event) {
      if ((event as any).tag === sagaDef.on) {
        await sagaDef.execute(event, entityId, ctx);
      }
    }

    store.setOffset(sagaDef.name, sagaDef.from, entityId, sequenceNr);
  }
}

/**
 * Run a stateful saga against journal events.
 *
 * Processes steps in order. Each step listens for a specific event tag from a
 * specific category. Steps are tracked per correlation ID (entity ID by default).
 * If a step's execute throws, the compensate handler is called.
 */
export async function runStatefulSaga(
  sagaDef: StatefulSagaDefinition,
  journal: Journal,
  runtime: EntityRuntime,
  store: SagaOffsetStore,
  opts?: RunSagaOptions,
): Promise<void> {
  const codec = opts?.eventCodec ?? tagCodec();
  const ctx = createSagaContext(runtime);

  // Process events from each step's source category
  for (let stepIdx = 0; stepIdx < sagaDef.steps.length; stepIdx++) {
    const step = sagaDef.steps[stepIdx];
    const categoryId = step.from as CategoryId;
    const allEvents = journal.allEvents(categoryId, codec);

    for (const { entityId, sequenceNr, event } of allEvents) {
      const offsetKey = `${step.from}:step${stepIdx}`;
      const lastSeqNr = store.getOffset(sagaDef.name, offsetKey, entityId);
      if (sequenceNr <= lastSeqNr) continue;

      if (typeof event === "object" && event !== null && "tag" in event) {
        if ((event as any).tag === step.on) {
          // Check if this entity is at the right step
          const currentStep = store.getStep(sagaDef.name, entityId);
          if (currentStep === stepIdx) {
            try {
              await step.execute(event, entityId, ctx);
              store.setStep(sagaDef.name, entityId, stepIdx + 1);
            } catch (err) {
              if (sagaDef.compensate) {
                await sagaDef.compensate(stepIdx, event, entityId, ctx);
              }
            }
          }
        }
      }

      store.setOffset(sagaDef.name, offsetKey, entityId, sequenceNr);
    }
  }
}

// --- SQLite-backed offset store ---

export { createSqliteSagaStore } from "./sqlite-offset-store.js";

// --- Tailing runners (endless sources) ---

export * from "./tailing.js";
