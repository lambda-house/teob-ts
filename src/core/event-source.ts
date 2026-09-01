// event-source.ts — streaming reads over a journal: category event records,
// tail options, and the CategoryEventSource contract consumed by tailing
// projections and sagas. A source's stream may be ENDLESS (a live tail):
// consumers must subscribe sources concurrently, never drain them one by one.

import type { CategoryId, EntityId, SequenceNr } from "./types.js";
import type { EventEnvelope } from "./envelope.js";

/** One decoded journal event with its global insertion-order cursor. */
export interface CategoryEventRecord<E = unknown> {
  /**
   * Global cursor in insertion order (SQLite rowid / inmem counter).
   * Tails key on THIS, never on (entityId, sequenceNr): a keyset cursor over
   * the composite key cannot follow live writes — once it passes an entity, a
   * new event for that entity sorts behind the cursor and is missed forever.
   */
  globalSeq: number;
  category: CategoryId;
  entityId: EntityId;
  sequenceNr: SequenceNr;
  event: E;
  envelope: EventEnvelope | null;
}

export interface TailOptions {
  /** Resume strictly after this global cursor. Default 0 — from the beginning. */
  afterGlobalSeq?: number;
  /**
   * Delay before re-polling once caught up (a short page). A full page means
   * more backlog and is fetched immediately — catching up is never throttled.
   * Default 250ms.
   */
  pollIntervalMs?: number;
  /** Page size for keyset reads. Default 256. */
  pageSize?: number;
  /** Aborting ends the tail; an idle tail wakes immediately. */
  signal?: AbortSignal;
}

/**
 * Source of per-category event streams. `tailCategoryEvents` never completes
 * on its own — it follows the journal, so run it in a background task and
 * abort via the source's TailOptions signal (or the one given at creation).
 */
export interface CategoryEventSource {
  tailCategoryEvents(category: CategoryId): AsyncIterable<CategoryEventRecord>;
}

/** Sleep that resolves early (without throwing) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
