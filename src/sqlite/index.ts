// SQLite runtime — persistent event sourcing with zero-config local storage

export { createSqliteJournal, type SqliteJournal, type SqliteJournalOptions } from "./journal.js";
export { createSqliteReadJournal, type SqliteReadJournal } from "./read-journal.js";

import type { Aggregate } from "../core/aggregate.js";
import type { Codec } from "../core/codec.js";
import type { EntityRuntime } from "../core/runtime.js";
import type { AggregateRegistration } from "../inmem/runtime.js";
import { createInMemoryRuntime, registration } from "../inmem/runtime.js";
import { createSqliteJournal, type SqliteJournal, type SqliteJournalOptions } from "./journal.js";
import type { Journal } from "../core/journal-store.js";

export { registration, type AggregateRegistration } from "../inmem/runtime.js";

import type { OnPersisted } from "../core/envelope.js";

export interface SqliteRuntimeOptions extends SqliteJournalOptions {
  /** Fired synchronously after every journal write. Must be non-throwing and fast. */
  onPersisted?: OnPersisted;
}

/**
 * Create an entity runtime backed by SQLite.
 *
 * Uses the same entity runner as the in-memory runtime but persists
 * events and snapshots to a SQLite database file.
 *
 * ```ts
 * const { runtime, journal } = createSqliteRuntime(
 *   { path: "./data/journal.db" },
 *   [registration(myAggregate, eventCodec, stateCodec)]
 * );
 * ```
 */
export function createSqliteRuntime(
  opts: SqliteRuntimeOptions,
  registrations: AggregateRegistration<any, any, any, any>[],
): { runtime: EntityRuntime; journal: SqliteJournal } {
  const journal = createSqliteJournal(opts);

  // Reuse the inmem runtime infrastructure — it works with any Journal implementation
  // We need to create the runtime with the sqlite journal instead of inmem journal.
  // The createInMemoryRuntime creates its own journal, so we need to wire it differently.
  // Instead, we'll use the same Module/entity-runner pattern but inject our journal.

  // Import the internal pieces we need
  const { runtime } = createInMemoryRuntimeWithJournal(registrations, journal, opts.onPersisted);

  return { runtime, journal };
}

// Internal: create a runtime using an external journal
// This mirrors createInMemoryRuntime but accepts a journal parameter
import type { EntityId, CategoryId } from "../core/types.js";
import type { CategoryRegistration, Either, ReplyError } from "../core/effect-control.js";
import { left } from "../core/effect-control.js";
import type { AskResult } from "../core/runtime.js";
import { createEntityRunner } from "../inmem/entity-runner.js";

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
  onPersisted?: OnPersisted,
): Module {
  const entities = new Map<string, ReturnType<typeof createEntityRunner<Command, Reply, Event, State>>>();

  function getOrCreate(entityId: EntityId) {
    let entity = entities.get(entityId);
    if (!entity) {
      entity = createEntityRunner({
        aggregate: reg.aggregate,
        entityId,
        journal,
        eventCodec: reg.eventCodec,
        stateCodec: reg.stateCodec,
        runtimeRef,
        onPersisted,
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

function createInMemoryRuntimeWithJournal(
  registrations: AggregateRegistration<any, any, any, any>[],
  journal: Journal,
  onPersisted?: OnPersisted,
): { runtime: EntityRuntime } {
  const runtimeRef: { current: EntityRuntime | undefined } = { current: undefined };
  const modules = new Map<string, Module>();

  for (const reg of registrations) {
    modules.set(reg.aggregate.category, createModule(reg, journal, runtimeRef, onPersisted));
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
  return { runtime };
}
