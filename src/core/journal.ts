import type { EntityId, CategoryId, SequenceNr } from "./types.js";

/**
 * ReadJournal exposes an API to stream persistence ids and their events.
 *
 * Uses AsyncIterable instead of fs2.Stream for idiomatic Node.js streaming.
 */
export interface ReadJournal<PersistenceId, Event, Ordinal> {
  /**
   * Fetch persistence ids from the journal.
   * If `since` is provided, returns ids with events after that timestamp.
   */
  fetchIds(since?: Date): AsyncIterable<PersistenceId>;

  /** Get the last known event ordinal for a persistence id. */
  lastOrdinal(persistenceId: PersistenceId): Promise<Ordinal>;

  /** Stream all persistence ids (live — may include newly-seen ids). */
  streamIds(): AsyncIterable<PersistenceId>;

  /**
   * Stream events for the given id in the interval [from, to).
   * @param from Lower bound for event sequence.
   * @param to   Optional upper bound (exclusive).
   */
  events(
    persistenceId: PersistenceId,
    from: Ordinal,
    to?: Ordinal,
  ): AsyncIterable<[Event, Ordinal]>;
}

/** Convenience type alias for entity-oriented read journals. */
export type EntityReadJournal<Event> = ReadJournal<string, Event, SequenceNr>;
