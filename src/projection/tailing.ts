// tailing.ts — long-running projection over live category tails.
//
// Sources are subscribed CONCURRENTLY: the CategoryEventSource contract allows
// endless (tailing) streams, and draining them sequentially would never
// subscribe past the first source (port of Scala TEO-137).
//
// Scala serializes the fold with a mutex so two sources feeding one view key
// cannot lose updates. In TS the fold (offsetGuardedFold) is fully
// synchronous, so no interleaving is possible mid-fold on the single thread —
// the mutex has no counterpart here by construction. If the fold ever grows
// an await, that guarantee is gone: re-introduce serialization then.

import type { CategoryId } from "../core/types.js";
import type { CategoryEventSource } from "../core/event-source.js";
import {
  offsetGuardedFold,
  type MultiStreamProjection,
  type Projection,
  type ProjectionStore,
  type SingleStreamProjection,
} from "./index.js";

export interface RunTailingProjectionOptions {
  /** Ends every source tail (see TailOptions given to the source's journal). */
  signal?: AbortSignal;
  /** A throwing evolve must not kill the tail. Default: console.error. */
  onError?: (err: unknown) => void;
}

function isMultiStream<E, V>(p: Projection<E, V>): p is MultiStreamProjection<E, V> {
  return "sources" in p;
}

/**
 * Follow the projection's source categories and fold every new event as it is
 * written. Resolves only when all tails end (i.e. after the source's signal
 * aborts) — run it as a background task.
 */
export async function runTailingProjection<Event extends { tag: string }, View>(
  proj: Projection<Event, View>,
  source: CategoryEventSource,
  store: ProjectionStore,
  opts?: RunTailingProjectionOptions,
): Promise<void> {
  const onError = opts?.onError ?? ((err: unknown) => console.error("[tailing-projection]", err));

  const sources = isMultiStream(proj)
    ? proj.sources
    : [
        {
          category: (proj as SingleStreamProjection<Event, View>).category,
          getViewId: (_e: Event, entityId: string) => entityId,
        },
      ];

  await Promise.all(
    sources.map(async (src) => {
      for await (const rec of source.tailCategoryEvents(src.category as CategoryId)) {
        if (opts?.signal?.aborted) return;
        try {
          offsetGuardedFold(store, {
            projectionId: proj.projectionId,
            category: src.category,
            entityId: rec.entityId,
            sequenceNr: rec.sequenceNr,
            viewId: src.getViewId(rec.event as Event, rec.entityId),
            initialState: proj.initialState,
            evolve: proj.evolve,
            event: rec.event as Event,
          });
        } catch (err) {
          onError(err);
        }
      }
    }),
  );
}
