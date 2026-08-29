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
  };
}

// Entity state

interface EntityState<State> {
  state: State;
  sequenceNr: SequenceNr;
  stashedCommands: unknown[];
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
}): { mailbox: Mailbox<EntityMessage<Command, Reply>>; running: Promise<void> } {
  const { aggregate, entityId, journal, eventCodec, stateCodec, runtimeRef } = opts;
  const categoryId = aggregate.category;
  const mailbox = createMailbox<EntityMessage<Command, Reply>>();
  const snapshotEvery = aggregate.snapshotEvery ?? 100;

  let entityState: EntityState<State> = {
    state: aggregate.initial(entityId),
    sequenceNr: mkSeqNr(0),
    stashedCommands: [],
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

  type ReplyCallback = (r: Either<ReplyError, { reply: Reply | undefined; sequenceNr: SequenceNr }>) => void;

  async function executeEffect(
    effect: Effect<Event, Reply>,
    replyTo: ReplyCallback | undefined,
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
          stashedCommands: entityState.stashedCommands,
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
        // The caller's ask() stays open until the deferred is completed.
        // Wire the deferred's promise to resolve the caller when it completes.
        const deferred = effect.deferred as DeferredReplyInternal<Reply>;
        const seqNr = entityState.sequenceNr;
        deferred._promise.then((value) => {
          replyTo?.(right({ reply: value, sequenceNr: seqNr }));
        });
        // Don't resolve now — the caller waits until deferred.complete() is called
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
        const stashed = entityState.stashedCommands as Command[];
        entityState = { ...entityState, stashedCommands: [] };
        for (const cmd of stashed) {
          mailbox.offer({ tag: "Tell", command: cmd });
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
    // Load snapshot
    const snap = journal.loadSnapshot(categoryId, entityId, stateCodec);
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
      stashedCommands: [],
      eventsSinceSnapshot: 0,
    };
  }

  // Command processing

  async function processCommand(
    command: Command,
    replyTo: ReplyCallback | undefined,
  ): Promise<void> {
    const effect = await aggregate.decide(entityState.state, command, ctx);
    if (effect.tag === "Stash") {
      entityState = {
        ...entityState,
        stashedCommands: [...entityState.stashedCommands, command],
      };
      return;
    }
    await executeEffect(effect, replyTo);
  }

  // Main loop

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
          await processCommand(msg.command, (r) => {
            if (r.ok) {
              msg.resolve(right({ reply: r.value.reply, sequenceNr: r.value.sequenceNr, preSequenceNr: preSeqNr }));
            } else {
              msg.resolve(r as any);
            }
          });
          break;
        }
        case "TimerFired":
          await processCommand(msg.command, undefined);
          break;
        case "Stop":
          // Cleanup timers
          for (const timer of activeTimers.values()) timer.cancel();
          activeTimers.clear();
          return;
      }
    }
  }

  const running = run();
  return { mailbox, running };
}
