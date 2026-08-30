// tailing.ts — long-running sagas over live category tails (port of Scala
// TEO-137's concurrent-subscription semantics).
//
// Stateful-saga step subscriptions run CONCURRENTLY: the source contract
// allows endless streams, and draining them sequentially would never
// subscribe past step 0. Cross-step ordering per correlation id is enforced
// by the step counter: an event for step N waits (bounded) until the counter
// reaches N. If the counter still lags after the wait, the event's offset is
// NOT advanced, so a restarted runner re-reads and retries it.

import type { CategoryId } from "../core/types.js";
import type { EntityRuntime } from "../core/runtime.js";
import { abortableSleep, type CategoryEventSource } from "../core/event-source.js";
import {
  createSagaContext,
  type SagaDefinition,
  type SagaOffsetStore,
  type StatefulSagaDefinition,
} from "./index.js";

export interface RunTailingSagaOptions {
  /** Ends the tails (see TailOptions given to the source's journal). */
  signal?: AbortSignal;
  /** Failures are reported here; they never kill the tail. Default: console.error. */
  onError?: (err: unknown) => void;
  /** Step-counter poll interval while waiting for a predecessor. Default 50ms. */
  turnPollMs?: number;
  /** Upper bound on the predecessor wait. Default 10s. */
  maxTurnWaitMs?: number;
}

function tagOf(event: unknown): string | undefined {
  return typeof event === "object" && event !== null && "tag" in event
    ? String((event as { tag: unknown }).tag)
    : undefined;
}

/**
 * Follow a stateless saga's source category and execute on every new matching
 * event. On handler failure the offset is NOT advanced — a restarted runner
 * re-reads and retries the event (at-least-once).
 */
export async function runTailingSaga(
  sagaDef: SagaDefinition,
  source: CategoryEventSource,
  runtime: EntityRuntime,
  store: SagaOffsetStore,
  opts?: RunTailingSagaOptions,
): Promise<void> {
  const onError = opts?.onError ?? ((err: unknown) => console.error("[tailing-saga]", err));
  const ctx = createSagaContext(runtime);

  for await (const rec of source.tailCategoryEvents(sagaDef.from as CategoryId)) {
    if (opts?.signal?.aborted) return;
    const last = store.getOffset(sagaDef.name, sagaDef.from, rec.entityId);
    if (rec.sequenceNr <= last) continue;

    if (tagOf(rec.event) !== sagaDef.on) {
      store.setOffset(sagaDef.name, sagaDef.from, rec.entityId, rec.sequenceNr);
      continue;
    }
    try {
      await sagaDef.execute(rec.event, rec.entityId, ctx);
      store.setOffset(sagaDef.name, sagaDef.from, rec.entityId, rec.sequenceNr);
    } catch (err) {
      onError(err); // offset kept — a restart retries this event
    }
  }
}

/** Poll the step counter until it reaches stepIdx (or the bounded wait elapses). */
async function awaitTurn(
  store: SagaOffsetStore,
  sagaName: string,
  correlationId: string,
  stepIdx: number,
  turnPollMs: number,
  maxTurnWaitMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const deadline = Date.now() + maxTurnWaitMs;
  for (;;) {
    const current = store.getStep(sagaName, correlationId);
    if (current >= stepIdx || Date.now() >= deadline || signal?.aborted) return current;
    await abortableSleep(turnPollMs, signal);
  }
}

/**
 * Follow every step's source category concurrently. Steps run in order per
 * correlation id (the entity id): an event for step N waits — bounded — for
 * the step counter to reach N. On step failure the saga-level compensate
 * handler runs, the step counter does not advance, and the offset DOES (the
 * event was consumed and compensated).
 */
export async function runTailingStatefulSaga(
  sagaDef: StatefulSagaDefinition,
  source: CategoryEventSource,
  runtime: EntityRuntime,
  store: SagaOffsetStore,
  opts?: RunTailingSagaOptions,
): Promise<void> {
  const onError = opts?.onError ?? ((err: unknown) => console.error("[tailing-saga]", err));
  const turnPollMs = opts?.turnPollMs ?? 50;
  const maxTurnWaitMs = opts?.maxTurnWaitMs ?? 10_000;
  const ctx = createSagaContext(runtime);

  await Promise.all(
    sagaDef.steps.map(async (step, stepIdx) => {
      for await (const rec of source.tailCategoryEvents(step.from as CategoryId)) {
        if (opts?.signal?.aborted) return;
        const offsetKey = `${step.from}:step${stepIdx}`;
        const entity = rec.entityId as string;
        const last = store.getOffset(sagaDef.name, offsetKey, entity);
        if (rec.sequenceNr <= last) continue;
        const advance = () => store.setOffset(sagaDef.name, offsetKey, entity, rec.sequenceNr);

        if (tagOf(rec.event) !== step.on) {
          advance();
          continue;
        }

        const current = await awaitTurn(store, sagaDef.name, entity, stepIdx, turnPollMs, maxTurnWaitMs, opts?.signal);
        if (current === stepIdx) {
          try {
            await step.execute(rec.event, rec.entityId, ctx);
            store.setStep(sagaDef.name, entity, stepIdx + 1);
          } catch (err) {
            onError(err);
            try {
              await sagaDef.compensate?.(stepIdx, rec.event, rec.entityId, ctx);
            } catch (compErr) {
              onError(compErr);
            }
            // Step counter does not advance on failure.
          }
          advance();
        } else if (current > stepIdx) {
          advance(); // already past this step: replayed duplicate
        } else {
          // Predecessor never completed within the wait: keep the offset so a
          // restart retries the event.
          onError(
            new Error(
              `Saga '${sagaDef.name}' step ${stepIdx} for entity ${entity} not ready ` +
                `(step counter at ${current}) after ${maxTurnWaitMs}ms; skipping without advancing offset`,
            ),
          );
        }
      }
    }),
  );
}
