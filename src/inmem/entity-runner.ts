import type { EntityId, CategoryId, SequenceNr, TimerId } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Effect } from "../core/effect.js";
import type { Aggregate } from "../core/aggregate.js";
import type { EffectControl, Either, ReplyError } from "../core/effect-control.js";
import { right, left } from "../core/effect-control.js";
import type { DeferredReplyInternal } from "../core/deferred.js";
import type { Codec } from "../core/codec.js";
import type { Journal } from "./journal.js";
import type { EntityRuntime } from "../core/runtime.js";
import type { EventEnvelope, OnPersisted } from "../core/envelope.js";
import { envelopeStampOf } from "../core/envelope.js";
import { ulid } from "../core/ulid.js";
import { SnapshotDecodeError } from "../core/journal-store.js";

// Mailbox message types

type EntityMessage<Command, Reply> =
  | { tag: "Tell"; command: Command }
  | { tag: "Ask"; command: Command; resolve: (r: Either<ReplyError, { reply: Reply | undefined; sequenceNr: SequenceNr; preSequenceNr: SequenceNr }>) => void }
  | { tag: "TimerFired"; timerId: TimerId; command: Command }
  | { tag: "Stop" };

// Async unbounded queue (mailbox)

interface Mailbox<T> {
  offer(item: T): void;
  take(): Promise<T>;
  /** Remove and return everything still queued (used when the entity terminates). */
  drain(): T[];
}

function createMailbox<T>(): Mailbox<T> {
  const queue: T[] = [];
  const waiters: Array<(item: T) => void> = [];

  return {
    offer(item: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        queue.push(item);
      }
    },
    take(): Promise<T> {
      const item = queue.shift();
      if (item !== undefined) return Promise.resolve(item);
      return new Promise<T>((resolve) => waiters.push(resolve));
    },
    drain(): T[] {
      return queue.splice(0, queue.length);
    },
  };
}

// Entity state

type ReplyCallback<Reply> = (
  r: Either<ReplyError, { reply: Reply | undefined; sequenceNr: SequenceNr }>,
) => void;

/** A stashed mailbox entry keeps the reply handle — a stashed ask must still answer. */
interface StashedEntry<Command, Reply> {
  command: Command;
  replyTo: ReplyCallback<Reply> | undefined;
}

interface EntityState<State, Command, Reply> {
  state: State;
  sequenceNr: SequenceNr;
  stashed: StashedEntry<Command, Reply>[];
  eventsSinceSnapshot: number;
}

// Create and run an entity

export function createEntityRunner<Command, Reply, Event, State>(opts: {
  aggregate: Aggregate<Command, Reply, Event, State>;
  entityId: EntityId;
  journal: Journal;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
  runtimeRef: { current: EntityRuntime | undefined };
  /** Fired synchronously after every journal write. Must be non-throwing and fast. */
  onPersisted?: OnPersisted;
  /** Bounds ReplyDeferred waits. Defaults to 30s (the runtime's ask timeout). */
  askTimeoutMs?: number;
  /** Skip snapshots on recovery and replay from the first event. */
  ignoreSnapshotsOnRecovery?: boolean;
  /** Called exactly once when the runner terminates — normally (Stop) or by crash. */
  onTerminate?: (error?: unknown) => void;
}): {
  mailbox: Mailbox<EntityMessage<Command, Reply>>;
  running: Promise<void>;
  /** True once the message loop has exited; the module replaces terminated runners. */
  isTerminated: () => boolean;
} {
  const { aggregate, entityId, journal, eventCodec, stateCodec, runtimeRef } = opts;
  const categoryId = aggregate.category;
  const mailbox = createMailbox<EntityMessage<Command, Reply>>();
  const snapshotEvery = aggregate.snapshotEvery ?? 100;
  const askTimeoutMs = opts.askTimeoutMs ?? 30_000;

  let entityState: EntityState<State, Command, Reply> = {
    state: aggregate.initial(entityId),
    sequenceNr: mkSeqNr(0),
    stashed: [],
    eventsSinceSnapshot: 0,
  };

  // Timer management
  const activeTimers = new Map<string, { cancel: () => void }>();

  // EffectControl implementation
  const ctx: EffectControl<Command, Reply> = {
    entityId,
    categoryId,

    async tellSelf(command: Command) {
      mailbox.offer({ tag: "Tell", command });
    },

    async tell<C, R>(id: EntityId, command: C, cat: { categoryId: CategoryId }) {
      const runtime = runtimeRef.current;
      if (!runtime) throw new Error("Runtime not initialized");
      await runtime.tell(id, command, cat as any);
    },

    async ask<C, R>(
      id: EntityId,
      command: C,
      cat: { categoryId: CategoryId },
    ): Promise<Either<ReplyError, R | undefined>> {
      const runtime = runtimeRef.current;
      if (!runtime) return left({ tag: "General", message: "Runtime not initialized" });
      const result = await runtime.ask(id, command, cat as any);
      if (!result.ok) return result as Either<ReplyError, R | undefined>;
      return right(result.value.reply as R | undefined);
    },

    async scheduleOnce(timerId: TimerId, command: Command, delayMs: number) {
      cancelTimerInternal(timerId);
      const handle = setTimeout(() => {
        activeTimers.delete(timerId);
        mailbox.offer({ tag: "TimerFired", timerId, command });
      }, delayMs);
      activeTimers.set(timerId, { cancel: () => clearTimeout(handle) });
    },

    async schedulePeriodic(
      timerId: TimerId,
      command: Command,
      initialDelayMs: number,
      intervalMs: number,
    ) {
      cancelTimerInternal(timerId);
      let interval: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => {
        mailbox.offer({ tag: "TimerFired", timerId, command });
        interval = setInterval(() => {
          mailbox.offer({ tag: "TimerFired", timerId, command });
        }, intervalMs);
      }, initialDelayMs);
      activeTimers.set(timerId, {
        cancel: () => {
          clearTimeout(timeout);
          if (interval) clearInterval(interval);
        },
      });
    },

    async cancelTimer(timerId: TimerId) {
      cancelTimerInternal(timerId);
    },

    log(level, message) {
      const ts = new Date().toISOString();
      console.log(`${ts} [${level.toUpperCase()}] [${categoryId}/${entityId}] ${message}`);
    },

    async sync<Success, Failure>(syncOpts: {
      effect: () => Promise<Either<Failure, Success>>;
      onSuccess: (s: Success) => Command;
      onFailure: (f: Failure) => Command;
      onTimeout?: Command;
      timeoutMs?: number;
    }) {
      const { effect, onSuccess, onFailure, onTimeout, timeoutMs } = syncOpts;
      const run = async () => {
        try {
          let result: Either<Failure, Success>;
          if (timeoutMs && onTimeout) {
            result = await Promise.race([
              effect(),
              new Promise<Either<Failure, Success>>((_, reject) =>
                setTimeout(() => reject(new Error("__sync_timeout__")), timeoutMs),
              ),
            ]);
          } else {
            result = await effect();
          }
          if (result.ok) {
            mailbox.offer({ tag: "Tell", command: onSuccess(result.value) });
          } else {
            mailbox.offer({ tag: "Tell", command: onFailure(result.error) });
          }
        } catch (err) {
          if (err instanceof Error && err.message === "__sync_timeout__" && onTimeout) {
            mailbox.offer({ tag: "Tell", command: onTimeout });
          } else {
            throw err;
          }
        }
      };
      run(); // fire and forget
    },
  };

  function cancelTimerInternal(timerId: TimerId) {
    const existing = activeTimers.get(timerId);
    if (existing) {
      existing.cancel();
      activeTimers.delete(timerId);
    }
  }

  // Execute effect chain

  async function executeEffect(
    effect: Effect<Event, Reply>,
    replyTo: ReplyCallback<Reply> | undefined,
  ): Promise<void> {
    switch (effect.tag) {
      case "Persist": {
        const envelopes: EventEnvelope[] = effect.events.map((e) => {
          const stamp = envelopeStampOf(e);
          return {
            eventId: stamp?.eventId ?? ulid(),
            v: 1,
            ...(stamp?.causationId !== undefined && { causationId: stamp.causationId }),
            ...(stamp?.correlationId !== undefined && { correlationId: stamp.correlationId }),
            ...(stamp?.origin !== undefined && { origin: stamp.origin }),
          };
        });
        const startSeq = entityState.sequenceNr;
        const newSeqNr = journal.persistEvents(
          categoryId,
          entityId,
          effect.events,
          startSeq,
          eventCodec,
          envelopes,
        );
        let state = entityState.state;
        for (const event of effect.events) {
          state = aggregate.apply(state, event);
        }
        entityState = {
          state,
          sequenceNr: newSeqNr,
          stashed: entityState.stashed,
          eventsSinceSnapshot: entityState.eventsSinceSnapshot + effect.events.length,
        };
        // Auto-snapshot
        if (snapshotEvery > 0 && entityState.eventsSinceSnapshot >= snapshotEvery) {
          journal.persistSnapshot(categoryId, entityId, entityState.state, entityState.sequenceNr, stateCodec);
          entityState = { ...entityState, eventsSinceSnapshot: 0 };
        }
        opts.onPersisted?.({
          category: categoryId,
          entityId,
          at: Date.now(),
          records: effect.events.map((e, i) => ({
            sequenceNr: mkSeqNr(startSeq + i + 1),
            manifest: eventCodec.manifest(e),
            encoded: eventCodec.encode(e),
            envelope: envelopes[i],
          })),
        });
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Run": {
        await effect.sideEffect();
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Reply": {
        replyTo?.(right({ reply: effect.value, sequenceNr: entityState.sequenceNr }));
        break;
      }
      case "ReplyDeferred": {
        // The caller's ask() stays open until the deferred is completed —
        // bounded by the ask timeout, so an abandoned deferred neither hangs
        // the caller past the runtime's own bound nor leaks its handler.
        const deferred = effect.deferred as DeferredReplyInternal<Reply>;
        const seqNr = entityState.sequenceNr;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            replyTo?.(left({ tag: "Timeout" }));
          }
        }, askTimeoutMs);
        timer.unref?.();
        deferred._promise.then((value) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            replyTo?.(right({ reply: value, sequenceNr: seqNr }));
          }
        });
        break;
      }
      case "Snapshot": {
        journal.persistSnapshot(categoryId, entityId, entityState.state, entityState.sequenceNr, stateCodec);
        entityState = { ...entityState, eventsSinceSnapshot: 0 };
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Stop": {
        mailbox.offer({ tag: "Stop" });
        break;
      }
      case "Stash": {
        // Stashing handled by caller
        break;
      }
      case "Unstash": {
        // Replay inline (not via the mailbox): each entry keeps its original
        // reply handle, so a stashed ask still answers its caller.
        const stashed = entityState.stashed;
        entityState = { ...entityState, stashed: [] };
        for (const entry of stashed) {
          await processCommand(entry.command, entry.replyTo);
        }
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Done": {
        replyTo?.(right({ reply: undefined as Reply | undefined, sequenceNr: entityState.sequenceNr }));
        break;
      }
    }
  }

  // Recovery

  function recover(): void {
    // Load snapshot; an undecodable one (schema drift) must not brick the
    // entity — warn and fall back to full event replay. The snapshot stays in
    // place for inspection, and the next auto-snapshot overwrites it.
    let snap: { sequenceNr: SequenceNr; state: State } | undefined;
    if (!opts.ignoreSnapshotsOnRecovery) {
      try {
        snap = journal.loadSnapshot(categoryId, entityId, stateCodec);
      } catch (e) {
        if (e instanceof SnapshotDecodeError) {
          ctx.log("warn", `snapshot undecodable, falling back to full event replay: ${e.message}`);
          snap = undefined;
        } else {
          throw e;
        }
      }
    }
    let state = snap ? snap.state : aggregate.initial(entityId);
    let seqNr = snap ? snap.sequenceNr : mkSeqNr(0);

    // Replay events
    const events = journal.loadEvents(categoryId, entityId, seqNr, eventCodec);
    for (const { sequenceNr, event } of events) {
      state = aggregate.apply(state, event);
      seqNr = sequenceNr;
    }

    entityState = {
      state,
      sequenceNr: seqNr,
      stashed: [],
      eventsSinceSnapshot: 0,
    };
  }

  // Command processing

  async function processCommand(
    command: Command,
    replyTo: ReplyCallback<Reply> | undefined,
  ): Promise<void> {
    const effect = await aggregate.decide(entityState.state, command, ctx);
    if (effect.tag === "Stash") {
      entityState = {
        ...entityState,
        stashed: [...entityState.stashed, { command, replyTo }],
      };
      return;
    }
    await executeEffect(effect, replyTo);
  }

  // Main loop — supervised: a throwing decide/persist crashes the entity
  // (never leaving it half-applied), the in-flight ask fails with the cause
  // instead of timing out, and the module replaces the terminated runner on
  // the next command (fresh incarnation recovering from the journal).

  let terminated = false;

  function terminate(error?: unknown): void {
    terminated = true;
    for (const timer of activeTimers.values()) timer.cancel();
    activeTimers.clear();
    // Fail anything still queued: a queued ask must not hang until timeout.
    const reason = error === undefined ? "entity stopped" : `entity crashed: ${String((error as Error)?.message ?? error)}`;
    for (const msg of mailbox.drain()) {
      if (msg.tag === "Ask") {
        msg.resolve(left({ tag: "General", message: reason }));
      }
    }
    opts.onTerminate?.(error);
  }

  async function run(): Promise<void> {
    // Recovery phase
    recover();
    if (aggregate.onRecoveryComplete) {
      await aggregate.onRecoveryComplete(entityState.state, ctx);
    }

    // Message loop
    while (true) {
      const msg = await mailbox.take();
      switch (msg.tag) {
        case "Tell":
          await processCommand(msg.command, undefined);
          break;
        case "Ask": {
          const preSeqNr = entityState.sequenceNr;
          try {
            await processCommand(msg.command, (r) => {
              if (r.ok) {
                msg.resolve(right({ reply: r.value.reply, sequenceNr: r.value.sequenceNr, preSequenceNr: preSeqNr }));
              } else {
                msg.resolve(r as any);
              }
            });
          } catch (err) {
            // The asker learns the cause; the entity still crashes.
            msg.resolve(left({ tag: "General", message: String((err as Error)?.message ?? err) }));
            throw err;
          }
          break;
        }
        case "TimerFired":
          await processCommand(msg.command, undefined);
          break;
        case "Stop":
          return;
      }
    }
  }

  const running = run().then(
    () => terminate(),
    (err) => {
      terminate(err);
      throw err;
    },
  );
  // The module observes termination via onTerminate/isTerminated; a crash must
  // not surface as an unhandled rejection.
  running.catch(() => {});

  return { mailbox, running, isTerminated: () => terminated };
}
