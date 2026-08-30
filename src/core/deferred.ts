/**
 * DeferredReply — a promise-based deferred for async reply delivery.
 *
 * When an aggregate returns `Effect.ReplyDeferred(deferred)`, the runtime
 * keeps the caller's `ask()` open until `deferred.complete(value)` is called
 * — potentially by a different command processing later.
 *
 * This is the TypeScript equivalent of Scala TEOB's `Deferred[F, R]`.
 */

/** Public interface for a deferred reply. */
export interface DeferredReply<R> {
  /** Complete the deferred with a value, resolving the waiting caller. */
  complete(value: R): void;
  /** Whether the deferred has already been completed. */
  readonly isCompleted: boolean;
}

/**
 * Internal interface — the runtime uses `_promise` to await the result
 * and `_attachResolver` to wire the caller's resolve callback.
 */
export interface DeferredReplyInternal<R> extends DeferredReply<R> {
  /** The promise the runtime awaits. Resolves when complete() is called. */
  readonly _promise: Promise<R>;
}

/** Create a new deferred reply. */
export function createDeferredReply<R>(): DeferredReplyInternal<R> {
  let resolve: ((value: R) => void) | undefined;
  let completed = false;
  let bufferedValue: R | undefined;
  let hasBuffered = false;

  const promise = new Promise<R>((res) => {
    resolve = (value: R) => {
      res(value);
    };
    // If complete() was called before the promise executor ran (shouldn't happen, but safe)
    if (hasBuffered) {
      res(bufferedValue as R);
    }
  });

  return {
    complete(value: R) {
      if (completed) return; // idempotent
      completed = true;
      if (resolve) {
        resolve(value);
      } else {
        // Buffer if promise executor hasn't run yet
        bufferedValue = value;
        hasBuffered = true;
      }
    },
    get isCompleted() {
      return completed;
    },
    _promise: promise,
  };
}
