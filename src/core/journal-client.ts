import type { ReadJournal } from "./journal.js";
import type { Aggregation } from "./aggregation.js";

export interface JournalClientConfig {
  /** Whether to eagerly preload all persistence ids on startup. */
  eagerPreload?: boolean;
  /** If eager preload, only preload ids updated since this date. */
  preloadSince?: Date;
  /** Initial delay before restarting a failed subscription (ms). Default 1000. */
  subscriptionRestartInitialDelayMs?: number;
  /** Maximum delay between restart attempts (ms). Default 30000. */
  subscriptionRestartMaxDelayMs?: number;
  /** Maximum restart attempts before giving up. Default 10. */
  subscriptionRestartMaxAttempts?: number;
  /** Max concurrent subscription starts. Default 4. */
  maxConcurrentSubscriptionStarts?: number;
}

function isTransientError(e: unknown): boolean {
  const msg = (e instanceof Error ? (e.message + (e.cause ?? "")) : String(e)).toLowerCase();
  return (
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("timeout") ||
    msg.includes("closed") ||
    msg.includes("reset") ||
    msg.includes("broken pipe") ||
    msg.includes("pool")
  );
}

/**
 * JournalClient subscribes to a ReadJournal and routes events to one or more Aggregations.
 *
 * For each persistence id discovered via streamIds (or fetchIds for eager preload),
 * it creates a subscription that feeds events to each aggregation.
 *
 * Returns a controller with a stop() method for graceful shutdown.
 */
export interface JournalClientHandle {
  /** Promise that resolves when the client finishes (or rejects on fatal error). */
  running: Promise<void>;
  /** Stop the journal client. */
  stop(): void;
}

export function startJournalClient<PersistenceId, Event, Ordinal>(
  readJournal: ReadJournal<PersistenceId, Event, Ordinal>,
  aggregations: Aggregation<PersistenceId, Event, Ordinal>[],
  config: JournalClientConfig = {},
): JournalClientHandle {
  const {
    eagerPreload = false,
    preloadSince,
    subscriptionRestartInitialDelayMs = 1000,
    subscriptionRestartMaxDelayMs = 30000,
    subscriptionRestartMaxAttempts = 10,
    maxConcurrentSubscriptionStarts = 4,
  } = config;

  const subscribed = new Map<string, Promise<void>>();
  const abortController = new AbortController();
  let concurrentStarts = 0;
  const startQueue: Array<() => void> = [];

  function subscriptionKey(aggId: string, id: PersistenceId): string {
    return `${aggId}:${String(id)}`;
  }

  async function waitForStartSlot(): Promise<void> {
    while (concurrentStarts >= maxConcurrentSubscriptionStarts) {
      await new Promise<void>((resolve) => startQueue.push(resolve));
    }
    concurrentStarts++;
  }

  function releaseStartSlot(): void {
    concurrentStarts--;
    const next = startQueue.shift();
    if (next) next();
  }

  async function subscribeWithRestart(
    agg: Aggregation<PersistenceId, Event, Ordinal>,
    id: PersistenceId,
    delayMs: number,
    attemptsLeft: number,
  ): Promise<void> {
    if (abortController.signal.aborted) return;

    try {
      const [from, maybeTo] = await agg.interval(id);
      const events = readJournal.events(id, from, maybeTo);
      await agg.subscribe(events);
    } catch (err) {
      if (abortController.signal.aborted) return;

      if (isTransientError(err) && attemptsLeft > 0) {
        const nextDelay = Math.min(delayMs * 2, subscriptionRestartMaxDelayMs);
        await new Promise((r) => setTimeout(r, delayMs));
        return subscribeWithRestart(agg, id, nextDelay, attemptsLeft - 1);
      }

      if (isTransientError(err)) {
        // Exhausted attempts but keep trying with max delay
        await new Promise((r) => setTimeout(r, subscriptionRestartMaxDelayMs));
        return subscribeWithRestart(agg, id, subscriptionRestartMaxDelayMs, 1);
      }

      // Fatal error
      throw err;
    }
  }

  async function startSubscription(
    agg: Aggregation<PersistenceId, Event, Ordinal>,
    id: PersistenceId,
  ): Promise<void> {
    const key = subscriptionKey(agg.aggregationId, id);
    if (subscribed.has(key)) return;

    await waitForStartSlot();
    try {
      const promise = subscribeWithRestart(
        agg,
        id,
        subscriptionRestartInitialDelayMs,
        subscriptionRestartMaxAttempts,
      ).finally(() => {
        subscribed.delete(key);
      });
      subscribed.set(key, promise);
      await promise;
    } finally {
      releaseStartSlot();
    }
  }

  async function processId(id: PersistenceId): Promise<void> {
    const promises = aggregations.map((agg) => startSubscription(agg, id));
    await Promise.all(promises);
  }

  const running = (async () => {
    // Phase 1: Eager preload
    if (eagerPreload) {
      for await (const id of readJournal.fetchIds(preloadSince)) {
        if (abortController.signal.aborted) return;
        // Fire-and-forget subscriptions (they run concurrently)
        processId(id).catch((err) => {
          if (!abortController.signal.aborted) {
            abortController.abort(err);
          }
        });
      }
    }

    // Phase 2: Stream live ids
    for await (const id of readJournal.streamIds()) {
      if (abortController.signal.aborted) return;
      processId(id).catch((err) => {
        if (!abortController.signal.aborted) {
          abortController.abort(err);
        }
      });
    }

    // Keep alive — wait for all subscriptions or abort
    await Promise.all(subscribed.values());
  })();

  return {
    running,
    stop() {
      abortController.abort(new Error("JournalClient stopped"));
    },
  };
}
