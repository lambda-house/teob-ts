/**
 * Core types for Petri Net flow modeling.
 *
 * Tokens flow through Places via Transitions. Places can be inbound (receive external tokens),
 * outbound (emit tokens externally), or internal. Transitions consume tokens from one place
 * and produce tokens to one or more places.
 */

/** A token flowing through the Petri Net. Must have a unique tag discriminator. */
export interface Token {
  readonly tag: string;
}

/** Place type classification. */
export type PlaceType = "Inbound" | "Outbound" | "Internal";

/** Transition execution state. */
export type TransitionState = "NotStarted" | "Ongoing" | "Completed" | "Failed";

/** Unique identifiers. */
export type PlaceId = string;
export type TransitionId = string;
export type SpanId = string;
export type FlowId = string;

/** Place definition — a location in the net that holds tokens. */
export interface PlaceDef {
  readonly id: PlaceId;
  /** Token tags this place accepts. */
  readonly accepts: ReadonlySet<string>;
  readonly type: PlaceType;
}

/** Transition definition — consumes tokens from one place, produces tokens to other places. */
export interface TransitionDef {
  readonly id: TransitionId;
  /** Place this transition consumes from. */
  readonly from: PlaceId;
  /** Token tags this transition consumes. */
  readonly consumes: ReadonlySet<string>;
  /** Map of produced token tag → destination place id. */
  readonly to: ReadonlyMap<string, PlaceId>;
}

/** Runtime state of a place with its current tokens. */
export interface PlaceInstance {
  readonly id: PlaceId;
  readonly accepts: ReadonlySet<string>;
  readonly type: PlaceType;
  readonly tokens: readonly Token[];
  readonly lastSpan?: SpanId;
}

/** Runtime state of a transition. */
export interface TransitionInstance {
  readonly id: TransitionId;
  readonly from: PlaceId;
  readonly consumes: ReadonlySet<string>;
  readonly consumed?: readonly Token[];
  readonly produces: ReadonlyMap<string, PlaceId>;
  readonly produced: readonly Token[];
  readonly state: TransitionState;
  readonly retryAttempts: number;
  readonly nextRetryAt?: number;
}

/** Create a PlaceDef. */
export function placeDef(id: PlaceId, accepts: string[], type: PlaceType): PlaceDef {
  return { id, accepts: new Set(accepts), type };
}

/** Create a TransitionDef. */
export function transitionDef(
  id: TransitionId,
  from: PlaceId,
  consumes: string[],
  to: Record<string, PlaceId>,
): TransitionDef {
  return { id, from, consumes: new Set(consumes), to: new Map(Object.entries(to)) };
}

/** Create a PlaceInstance from a PlaceDef. */
export function placeInstanceFromDef(def_: PlaceDef): PlaceInstance {
  return { id: def_.id, accepts: def_.accepts, type: def_.type, tokens: [], lastSpan: undefined };
}

/** Create a TransitionInstance from a TransitionDef. */
export function transitionInstanceFromDef(def_: TransitionDef): TransitionInstance {
  return {
    id: def_.id,
    from: def_.from,
    consumes: def_.consumes,
    consumed: undefined,
    produces: def_.to,
    produced: [],
    state: "NotStarted",
    retryAttempts: 0,
    nextRetryAt: undefined,
  };
}
