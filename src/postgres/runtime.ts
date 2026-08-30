import type { EntityId, CategoryId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Effect } from "../core/effect.js";
import type { Aggregate } from "../core/aggregate.js";
import type { EffectControl, Either, ReplyError, CategoryRegistration } from "../core/effect-control.js";
import { right, left } from "../core/effect-control.js";
import type { Codec } from "../core/codec.js";
import type { EntityRuntime, AskResult } from "../core/runtime.js";
import type { PostgresJournal } from "./journal.js";
import {
  persistEventsAsync,
  loadEventsAsync,
  persistSnapshotAsync,
  loadSnapshotAsync,
} from "./journal.js";
import type { TimerId } from "../core/types.js";

// Mailbox

type EntityMessage<Command, Reply> =
  | { tag: "Tell"; command: Command }
  | { tag: "Ask"; command: Command; resolve: (r: Either<ReplyError, { reply: Reply | undefined; sequenceNr: SequenceNr; preSequenceNr: SequenceNr }>) => void }
  | { tag: "TimerFired"; timerId: TimerId; command: Command }
  | { tag: "Stop" };

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
      if (waiter) waiter(item);
      else queue.push(item);
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

// Registration

export interface PgAggregateRegistration<Command, Reply, Event, State> {
  aggregate: Aggregate<Command, Reply, Event, State>;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
}

export function pgRegistration<Command, Reply, Event, State>(
  aggregate: Aggregate<Command, Reply, Event, State>,
  eventCodec: Codec<Event>,
  stateCodec: Codec<State>,
): PgAggregateRegistration<Command, Reply, Event, State> {
  return { aggregate, eventCodec, stateCodec };
}

// Entity runner with async postgres journal

function createPgEntityRunner<Command, Reply, Event, State>(opts: {
  aggregate: Aggregate<Command, Reply, Event, State>;
  entityId: EntityId;
  journal: PostgresJournal;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
  runtimeRef: { current: EntityRuntime | undefined };
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

  const activeTimers = new Map<string, { cancel: () => void }>();

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
      const existing = activeTimers.get(timerId);
      if (existing) existing.cancel();
      const handle = setTimeout(() => {
        activeTimers.delete(timerId);
        mailbox.offer({ tag: "TimerFired", timerId, command });
      }, delayMs);
      activeTimers.set(timerId, { cancel: () => clearTimeout(handle) });
    },
    async schedulePeriodic(timerId: TimerId, command: Command, initialDelayMs: number, intervalMs: number) {
      const existing = activeTimers.get(timerId);
      if (existing) existing.cancel();
      let interval: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => {
        mailbox.offer({ tag: "TimerFired", timerId, command });
        interval = setInterval(() => mailbox.offer({ tag: "TimerFired", timerId, command }), intervalMs);
      }, initialDelayMs);
      activeTimers.set(timerId, {
        cancel: () => { clearTimeout(timeout); if (interval) clearInterval(interval); },
      });
    },
    async cancelTimer(timerId: TimerId) {
      const existing = activeTimers.get(timerId);
      if (existing) { existing.cancel(); activeTimers.delete(timerId); }
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
      (async () => {
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
          if (result.ok) mailbox.offer({ tag: "Tell", command: onSuccess(result.value) });
          else mailbox.offer({ tag: "Tell", command: onFailure(result.error) });
        } catch (err) {
          if (err instanceof Error && err.message === "__sync_timeout__" && onTimeout) {
            mailbox.offer({ tag: "Tell", command: onTimeout });
          }
        }
      })();
    },
  };

  // Async effect execution

  type ReplyCallback = (r: Either<ReplyError, { reply: Reply | undefined; sequenceNr: SequenceNr }>) => void;

  async function executeEffect(
    effect: Effect<Event, Reply>,
    replyTo: ReplyCallback | undefined,
  ): Promise<void> {
    switch (effect.tag) {
      case "Persist": {
        const newSeqNr = await persistEventsAsync(
          journal, categoryId, entityId, effect.events, entityState.sequenceNr, eventCodec,
        );
        let state = entityState.state;
        for (const event of effect.events) state = aggregate.apply(state, event);
        entityState = {
          state,
          sequenceNr: newSeqNr,
          stashedCommands: entityState.stashedCommands,
          eventsSinceSnapshot: entityState.eventsSinceSnapshot + effect.events.length,
        };
        if (snapshotEvery > 0 && entityState.eventsSinceSnapshot >= snapshotEvery) {
          await persistSnapshotAsync(journal, categoryId, entityId, entityState.state, entityState.sequenceNr, stateCodec);
          entityState = { ...entityState, eventsSinceSnapshot: 0 };
        }
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Run":
        await effect.sideEffect();
        await executeEffect(effect.andThen, replyTo);
        break;
      case "Reply":
        replyTo?.(right({ reply: effect.value, sequenceNr: entityState.sequenceNr }));
        break;
      case "Snapshot":
        await persistSnapshotAsync(journal, categoryId, entityId, entityState.state, entityState.sequenceNr, stateCodec);
        entityState = { ...entityState, eventsSinceSnapshot: 0 };
        await executeEffect(effect.andThen, replyTo);
        break;
      case "Stop":
        mailbox.offer({ tag: "Stop" });
        break;
      case "Stash":
        break;
      case "Unstash": {
        const stashed = entityState.stashedCommands as Command[];
        entityState = { ...entityState, stashedCommands: [] };
        for (const cmd of stashed) mailbox.offer({ tag: "Tell", command: cmd });
        await executeEffect(effect.andThen, replyTo);
        break;
      }
      case "Done":
        replyTo?.(right({ reply: undefined as Reply | undefined, sequenceNr: entityState.sequenceNr }));
        break;
    }
  }

  // Async recovery from postgres

  async function recover(): Promise<void> {
    const snap = await loadSnapshotAsync(journal, categoryId, entityId, stateCodec);
    let state = snap ? snap.state : aggregate.initial(entityId);
    let seqNr = snap ? snap.sequenceNr : mkSeqNr(0);

    const events = await loadEventsAsync(journal, categoryId, entityId, seqNr, eventCodec);
    for (const { sequenceNr, event } of events) {
      state = aggregate.apply(state, event);
      seqNr = sequenceNr;
    }

    entityState = { state, sequenceNr: seqNr, stashedCommands: [], eventsSinceSnapshot: 0 };
  }

  async function processCommand(
    command: Command,
    replyTo: ReplyCallback | undefined,
  ): Promise<void> {
    const effect = await aggregate.decide(entityState.state, command, ctx);
    if (effect.tag === "Stash") {
      entityState = { ...entityState, stashedCommands: [...entityState.stashedCommands, command] };
      return;
    }
    await executeEffect(effect, replyTo);
  }

  async function run(): Promise<void> {
    await recover();
    if (aggregate.onRecoveryComplete) await aggregate.onRecoveryComplete(entityState.state, ctx);

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
          for (const timer of activeTimers.values()) timer.cancel();
          activeTimers.clear();
          return;
      }
    }
  }

  const running = run();
  return { mailbox, running };
}

// Module

interface PgModule {
  categoryId: CategoryId;
  tell(entityId: EntityId, command: unknown): Promise<void>;
  ask(entityId: EntityId, command: unknown): Promise<Either<ReplyError, AskResult<unknown>>>;
  shutdown(): Promise<void>;
}

function createPgModule<Command, Reply, Event, State>(
  reg: PgAggregateRegistration<Command, Reply, Event, State>,
  journal: PostgresJournal,
  runtimeRef: { current: EntityRuntime | undefined },
): PgModule {
  const entities = new Map<string, ReturnType<typeof createPgEntityRunner<Command, Reply, Event, State>>>();

  function getOrCreate(entityId: EntityId) {
    let entity = entities.get(entityId);
    if (!entity) {
      entity = createPgEntityRunner({
        aggregate: reg.aggregate,
        entityId,
        journal,
        eventCodec: reg.eventCodec,
        stateCodec: reg.stateCodec,
        runtimeRef,
      });
      entities.set(entityId, entity);
    }
    return entity;
  }

  return {
    categoryId: reg.aggregate.category,
    async tell(entityId: EntityId, command: unknown) {
      getOrCreate(entityId).mailbox.offer({ tag: "Tell", command: command as Command });
    },
    async ask(entityId: EntityId, command: unknown): Promise<Either<ReplyError, AskResult<unknown>>> {
      const entity = getOrCreate(entityId);
      return new Promise<Either<ReplyError, AskResult<unknown>>>((resolve) => {
        const timer = setTimeout(() => resolve(left({ tag: "Timeout" })), 30_000);
        entity.mailbox.offer({
          tag: "Ask",
          command: command as Command,
          resolve: (result) => {
            clearTimeout(timer);
            if (result.ok) {
              const v = result.value;
              resolve({ ok: true, value: { reply: v.reply as unknown, meta: { sequenceNr: v.sequenceNr, preSequenceNr: v.preSequenceNr } } });
            } else {
              resolve(result as Either<ReplyError, AskResult<unknown>>);
            }
          },
        });
      });
    },
    async shutdown() {
      for (const entity of entities.values()) entity.mailbox.offer({ tag: "Stop" });
      for (const entity of entities.values()) await entity.running;
      entities.clear();
    },
  };
}

// Public API

export function createPostgresRuntime(
  journal: PostgresJournal,
  registrations: PgAggregateRegistration<any, any, any, any>[],
): EntityRuntime {
  const runtimeRef: { current: EntityRuntime | undefined } = { current: undefined };
  const modules = new Map<string, PgModule>();

  for (const reg of registrations) {
    modules.set(reg.aggregate.category, createPgModule(reg, journal, runtimeRef));
  }

  const runtime: EntityRuntime = {
    async tell<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>) {
      const mod = modules.get(cat.categoryId);
      if (!mod) throw new Error(`Category not found: ${cat.categoryId}`);
      await mod.tell(entityId, command);
    },
    async ask<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<Either<ReplyError, AskResult<R>>> {
      const mod = modules.get(cat.categoryId);
      if (!mod) return left({ tag: "CategoryNotFound", categoryId: cat.categoryId });
      return (await mod.ask(entityId, command)) as Either<ReplyError, AskResult<R>>;
    },
    categories(): Set<CategoryId> {
      return new Set(modules.keys() as Iterable<CategoryId>);
    },
    async start() {},
    async shutdown() {
      for (const mod of modules.values()) await mod.shutdown();
    },
  };

  runtimeRef.current = runtime;
  return runtime;
}
