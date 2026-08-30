// SQLite runtime — persistent event sourcing with zero-config local storage

export { createSqliteJournal, type SqliteJournal, type SqliteJournalOptions } from "./journal.js";
export { createSqliteReadJournal, type SqliteReadJournal } from "./read-journal.js";
export { createSqliteCleanJournal, type SqliteCleanJournal } from "./clean-journal.js";

import type { EntityRuntime } from "../core/runtime.js";
import type { OnPersisted } from "../core/envelope.js";
import type { AggregateRegistration } from "../inmem/runtime.js";
import { createInMemoryRuntime } from "../inmem/runtime.js";
import { createSqliteJournal, type SqliteJournal, type SqliteJournalOptions } from "./journal.js";

export { registration, type AggregateRegistration } from "../inmem/runtime.js";

export interface SqliteRuntimeOptions extends SqliteJournalOptions {
  /** Fired synchronously after every journal write. Must be non-throwing and fast. */
  onPersisted?: OnPersisted;
  /** Ask timeout in ms (also bounds ReplyDeferred waits). Defaults to 30s. */
  askTimeoutMs?: number;
  /** Recover from events only, skipping snapshots (escape hatch for bad snapshots). */
  ignoreSnapshotsOnRecovery?: boolean;
}

/**
 * Create an entity runtime backed by SQLite.
 *
 * The in-memory runtime's entity runner works over any Journal — this wires
 * it to a SQLite journal, so events and snapshots persist to a database file.
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
  const { runtime } = createInMemoryRuntime(registrations, {
    journal,
    onPersisted: opts.onPersisted,
    askTimeoutMs: opts.askTimeoutMs,
    ignoreSnapshotsOnRecovery: opts.ignoreSnapshotsOnRecovery,
  });
  return { runtime, journal };
}
