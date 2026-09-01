// --- Type Classes ---

/** Apply an event to a state, producing a new state. */
export interface ApplyEvent<State, Event, Ordinal> {
  apply(state: State, event: Event, ordinal: Ordinal): Promise<State>;
}

/** Check consistency between ordinals (event orderings). */
export interface Consistency<A> {
  /** next == current + 1 */
  consistent(current: A, next: A): boolean;
  /** next <= current (duplicate / already processed) */
  fromThePast(current: A, next: A): boolean;
  /** next > current + 1 (gap detected) */
  fromTheFuture(current: A, next: A): boolean;
}

/** Consistency implementation for numeric ordinals (SequenceNr). */
export const numberConsistency: Consistency<number> = {
  consistent: (current, next) => next === current + 1,
  fromThePast: (current, next) => next <= current,
  fromTheFuture: (current, next) => next > current + 1,
};

/** Extract persistence id from an event. */
export interface HasPersistenceId<Event, PersistenceId> {
  (event: Event): PersistenceId;
}

/** Extract ordinal from a state. */
export interface HasOrdinal<State, Ordinal> {
  (state: State): Ordinal;
}

/** Fetch current state for a persistence id. */
export interface GetState<PersistenceId, State> {
  (id: PersistenceId): Promise<State>;
}

/** Fetch the last known ordinal for a persistence id. */
export interface GetLastOrdinal<PersistenceId, Ordinal> {
  (id: PersistenceId): Promise<Ordinal>;
}

/** Fetch the interval [from, to?) of ordinals to process. */
export interface GetOrdinalInterval<PersistenceId, Ordinal> {
  (persistenceId: PersistenceId): Promise<[Ordinal, Ordinal | undefined]>;
}

/** Handle gaps in event streams. */
export interface OnGap<PersistenceId, Event, Ordinal, State> {
  (id: PersistenceId, event: Event, ordinal: Ordinal, state: State): Promise<State>;
}

/** Strategy: fail on gap. */
export function onGapFail<PersistenceId, Event, Ordinal, State>(): OnGap<
  PersistenceId,
  Event,
  Ordinal,
  State
> {
  return (id, event, ordinal, state) => {
    throw new Error(
      `Gap detected for ${id}, ordinal=${ordinal}, event=${JSON.stringify(event)}`,
    );
  };
}

/** Strategy: ignore gaps. */
export function onGapIgnore<PersistenceId, Event, Ordinal, State>(): OnGap<
  PersistenceId,
  Event,
  Ordinal,
  State
> {
  return (_id, _event, _ordinal, state) => Promise.resolve(state);
}

// --- Aggregation ---

export type AggregationId = string;

/**
 * Aggregation describes a computation over a stream of events.
 */
export interface Aggregation<PersistenceId, Event, Ordinal> {
  aggregationId: AggregationId;

  /** Compute the interval [from, maybeTo) for processing new events. */
  interval(persistenceId: PersistenceId): Promise<[Ordinal, Ordinal | undefined]>;

  /** Process an event stream for the given interval. */
  subscribe(events: AsyncIterable<[Event, Ordinal]>): Promise<void>;
}

/** Create an Aggregation instance. */
export function createAggregation<PersistenceId, Event, Ordinal, State>(opts: {
  aggregationId: AggregationId;
  getOrdinalInterval: GetOrdinalInterval<PersistenceId, Ordinal>;
  getState: GetState<PersistenceId, State>;
  applyEvent: ApplyEvent<State, Event, Ordinal>;
  onGap: OnGap<PersistenceId, Event, Ordinal, State>;
  eventHasId: HasPersistenceId<Event, PersistenceId>;
  stateHasOrdinal: HasOrdinal<State, Ordinal>;
  consistency: Consistency<Ordinal>;
}): Aggregation<PersistenceId, Event, Ordinal> {
  const {
    aggregationId,
    getOrdinalInterval,
    getState,
    applyEvent,
    onGap,
    eventHasId,
    stateHasOrdinal,
    consistency,
  } = opts;

  return {
    aggregationId,

    interval(persistenceId) {
      return getOrdinalInterval(persistenceId);
    },

    async subscribe(events) {
      let currentState: State | undefined;

      for await (const [event, ordinal] of events) {
        const id = eventHasId(event);

        if (currentState === undefined) {
          currentState = await getState(id);
        }

        const stateOrd = stateHasOrdinal(currentState);

        if (consistency.consistent(stateOrd, ordinal)) {
          currentState = await applyEvent.apply(currentState, event, ordinal);
        } else if (consistency.fromThePast(stateOrd, ordinal)) {
          // Skip — already processed
        } else if (consistency.fromTheFuture(stateOrd, ordinal)) {
          currentState = await onGap(id, event, ordinal, currentState);
        }
      }
    },
  };
}
