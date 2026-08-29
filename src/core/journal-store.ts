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
