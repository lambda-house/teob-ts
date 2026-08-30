import type { EntityId, CategoryId } from "../core/types.js";
import type { Aggregate } from "../core/aggregate.js";
import type { Codec } from "../core/codec.js";
import type { EntityRuntime, AskResult } from "../core/runtime.js";
import type { CategoryRegistration, Either, ReplyError } from "../core/effect-control.js";
import { left } from "../core/effect-control.js";
import type { OnPersisted } from "../core/envelope.js";
import { createEntityRunner } from "./entity-runner.js";
import { createInMemoryJournal, type Journal } from "./journal.js";

// Runtime-level options

export interface RuntimeOptions {
  /** Fired synchronously after every journal write. Must be non-throwing and fast. */
  onPersisted?: OnPersisted;
  /**
   * Back the runtime with this journal instead of a fresh in-memory one —
   * how the SQLite runtime injects its journal, and how tests restart a
   * runtime over existing history.
   */
  journal?: Journal;
  /** Ask timeout in ms (also bounds ReplyDeferred waits). Defaults to 30s. */
  askTimeoutMs?: number;
  /** Recover from events only, skipping snapshots (escape hatch for bad snapshots). */
  ignoreSnapshotsOnRecovery?: boolean;
}

// Aggregate registration — packages an aggregate with its codecs

export interface AggregateRegistration<Command, Reply, Event, State> {
  aggregate: Aggregate<Command, Reply, Event, State>;
  eventCodec: Codec<Event>;
  stateCodec: Codec<State>;
}

export function registration<Command, Reply, Event, State>(
  aggregate: Aggregate<Command, Reply, Event, State>,
  eventCodec: Codec<Event>,
  stateCodec: Codec<State>,
): AggregateRegistration<Command, Reply, Event, State> {
  return { aggregate, eventCodec, stateCodec };
}

// Module — type-erased container for a single aggregate category

interface Module {
  categoryId: CategoryId;
  tell(entityId: EntityId, command: unknown): Promise<void>;
  ask(entityId: EntityId, command: unknown): Promise<Either<ReplyError, AskResult<unknown>>>;
  shutdown(): Promise<void>;
}

function createModule<Command, Reply, Event, State>(
  reg: AggregateRegistration<Command, Reply, Event, State>,
  journal: Journal,
  runtimeRef: { current: EntityRuntime | undefined },
  runtimeOpts?: RuntimeOptions,
): Module {
  const entities = new Map<
    string,
    ReturnType<typeof createEntityRunner<Command, Reply, Event, State>>
  >();
  const askTimeoutMs = runtimeOpts?.askTimeoutMs ?? 30_000;

  function getOrCreate(entityId: EntityId) {
    let entity = entities.get(entityId);
    // A terminated runner (passivated via Stop, or crashed) is replaced by a
    // fresh incarnation that recovers from the journal — commands never go to
    // a dead mailbox.
    if (!entity || entity.isTerminated()) {
      const created: ReturnType<typeof createEntityRunner<Command, Reply, Event, State>> =
        createEntityRunner({
          aggregate: reg.aggregate,
          entityId,
          journal,
          eventCodec: reg.eventCodec,
          stateCodec: reg.stateCodec,
          runtimeRef,
          onPersisted: runtimeOpts?.onPersisted,
          askTimeoutMs,
          ignoreSnapshotsOnRecovery: runtimeOpts?.ignoreSnapshotsOnRecovery,
          onTerminate: () => {
            if (entities.get(entityId) === created) entities.delete(entityId);
          },
        });
      entity = created;
      entities.set(entityId, entity);
    }
    return entity;
  }

  return {
    categoryId: reg.aggregate.category,

    async tell(entityId: EntityId, command: unknown) {
      const entity = getOrCreate(entityId);
      entity.mailbox.offer({ tag: "Tell", command: command as Command });
    },

    async ask(entityId: EntityId, command: unknown): Promise<Either<ReplyError, AskResult<unknown>>> {
      const entity = getOrCreate(entityId);
      return new Promise<Either<ReplyError, AskResult<unknown>>>((resolve) => {
        const timer = setTimeout(() => {
          resolve(left({ tag: "Timeout" }));
        }, askTimeoutMs);
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
      const running = [...entities.values()];
      for (const entity of running) {
        entity.mailbox.offer({ tag: "Stop" });
      }
      for (const entity of running) {
        // A crashed runner's promise is already rejected — shutdown proceeds.
        await entity.running.catch(() => {});
      }
      entities.clear();
    },
  };
}

// Create in-memory runtime

export function createInMemoryRuntime(
  registrations: AggregateRegistration<any, any, any, any>[],
  runtimeOpts?: RuntimeOptions,
): { runtime: EntityRuntime; journal: Journal } {
  const journal = runtimeOpts?.journal ?? createInMemoryJournal();
  const runtimeRef: { current: EntityRuntime | undefined } = { current: undefined };

  const modules = new Map<string, Module>();
  for (const reg of registrations) {
    const mod = createModule(reg, journal, runtimeRef, runtimeOpts);
    modules.set(reg.aggregate.category, mod);
  }

  const runtime: EntityRuntime = {
    async tell<C, R>(
      entityId: EntityId,
      command: C,
      cat: CategoryRegistration<C, R>,
    ): Promise<void> {
      const mod = modules.get(cat.categoryId);
      if (!mod) throw new Error(`Category not found: ${cat.categoryId}`);
      await mod.tell(entityId, command);
    },

    async ask<C, R>(
      entityId: EntityId,
      command: C,
      cat: CategoryRegistration<C, R>,
    ): Promise<Either<ReplyError, AskResult<R>>> {
      const mod = modules.get(cat.categoryId);
      if (!mod) return left({ tag: "CategoryNotFound", categoryId: cat.categoryId });
      return (await mod.ask(entityId, command)) as Either<ReplyError, AskResult<R>>;
    },

    categories(): Set<CategoryId> {
      return new Set(modules.keys() as Iterable<CategoryId>);
    },

    async start() {
      // Entities start lazily on first command
    },

    async shutdown() {
      for (const mod of modules.values()) {
        await mod.shutdown();
      }
    },
  };

  runtimeRef.current = runtime;
  return { runtime, journal };
}

// Convenience: single aggregate runtime

export function createSingleRuntime<Command, Reply, Event, State>(
  aggregate: Aggregate<Command, Reply, Event, State>,
  eventCodec: Codec<Event>,
  stateCodec: Codec<State>,
  runtimeOpts?: RuntimeOptions,
): { runtime: EntityRuntime; journal: Journal } {
  return createInMemoryRuntime([registration(aggregate, eventCodec, stateCodec)], runtimeOpts);
}
