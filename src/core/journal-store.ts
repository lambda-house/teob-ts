import type { CategoryId, EntityId, SequenceNr } from "./types.js";
import type { Codec } from "./codec.js";
import type { EventEnvelope } from "./envelope.js";

/**
 * Journal — synchronous event/snapshot storage interface.
 *
 * The base interface uses synchronous methods, matching in-memory usage.
 * Async backends (e.g. PostgreSQL) extend this with async variants
 * and throw from the sync methods.
 */
export interface Journal {
  /**
   * Append events after `startSequenceNr`.
   *
   * Throws {@link DuplicateSequenceNrError} if any event would reuse a sequence
   * number already stored for the entity — every backend rejects a stale or
   * duplicate write the same way, and the journal is left unchanged (the whole
   * batch is all-or-nothing).
   */
  persistEvents<E>(
    categoryId: CategoryId,
    entityId: EntityId,
    events: E[],
    startSequenceNr: SequenceNr,
    codec: Codec<E>,
    /** Parallel to events; supplied by the entity runner. Implementations may ignore it. */
    envelopes?: EventEnvelope[],
  ): SequenceNr;

  loadEvents<E>(
    categoryId: CategoryId,
    entityId: EntityId,
    fromSequenceNr: SequenceNr,
    codec: Codec<E>,
  ): Array<{ sequenceNr: SequenceNr; event: E }>;

  persistSnapshot<S>(
    categoryId: CategoryId,
    entityId: EntityId,
    state: S,
    sequenceNr: SequenceNr,
    codec: Codec<S>,
  ): void;

  loadSnapshot<S>(
    categoryId: CategoryId,
    entityId: EntityId,
    codec: Codec<S>,
  ): { sequenceNr: SequenceNr; state: S } | undefined;

  allEvents<E>(
    categoryId: CategoryId,
    codec: Codec<E>,
  ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }>;
}

/**
 * An event was persisted with a sequence number already stored for the entity.
 *
 * Raised by {@link Journal.persistEvents} so every backend rejects a
 * stale/duplicate write the same way, rather than one enforcing it (SQLite's
 * primary key) while another silently appends a second row at the same
 * sequence number.
 */
/**
 * A stored snapshot exists but cannot be decoded with the current state codec.
 *
 * Raised by {@link Journal.loadSnapshot} so runtimes can distinguish an
 * unreadable snapshot (recoverable by falling back to full event replay) from
 * journal I/O failures (not recoverable by replay).
 */
export class SnapshotDecodeError extends Error {
  readonly tag = "SnapshotDecodeError" as const;

  constructor(
    readonly category: CategoryId,
    readonly entityId: EntityId,
    readonly cause_: unknown,
  ) {
    super(`Failed to decode snapshot for ${category}/${entityId}: ${String(cause_)}`);
    this.name = "SnapshotDecodeError";
  }
}

export class DuplicateSequenceNrError extends Error {
  readonly tag = "DuplicateSequenceNrError" as const;

  constructor(
    readonly category: CategoryId,
    readonly entityId: EntityId,
    readonly sequenceNr: SequenceNr,
  ) {
    super(`Duplicate sequence number ${sequenceNr} for ${category}/${entityId}`);
    this.name = "DuplicateSequenceNrError";
  }
}
