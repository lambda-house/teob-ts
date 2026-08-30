import type { EntityId, CategoryId } from "./types.js";
import type { Effect } from "./effect.js";
import type { EffectControl } from "./effect-control.js";

// Aggregate — pure business logic definition (DDD Aggregate pattern)
// Decision function returns an Effect (declarative), event applicator is pure

export interface Aggregate<Command, Reply, Event, State> {
  category: CategoryId;
  initial(id: EntityId): State;
  decide(
    state: State,
    command: Command,
    ctx: EffectControl<Command, Reply>,
  ): Promise<Effect<Event, Reply>>;
  apply(state: State, event: Event): State;
  onRecoveryComplete?(state: State, ctx: EffectControl<Command, Reply>): Promise<void>;
  snapshotEvery?: number; // snapshot every N events, default 100
  /** Invariants that must hold after every event application. Used for testing. */
  invariants?: Array<Invariant<State>>;
}

/** A named predicate that must hold on entity state. */
export interface Invariant<State> {
  name: string;
  check(state: State): boolean;
}
