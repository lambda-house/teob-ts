/**
 * Runtime executable Petri Net flow.
 *
 * Manages token placement, transition lifecycle (start/complete/fail),
 * and retry logic with Fibonacci backoff.
 */

import type {
  Token, PlaceId, TransitionId, SpanId, FlowId,
  PlaceInstance, TransitionInstance,
} from "./types.js";

/** Fibonacci helper: f(1)=1, f(2)=1, f(3)=2, ... */
function fibonacci(n: number): number {
  if (n <= 1) return 1;
  let a = 1, b = 1;
  for (let i = 2; i < n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}

/** Time provider abstraction for testing. */
export interface TimeProvider {
  nowMillis(): number;
}

const systemTime: TimeProvider = { nowMillis: () => Date.now() };
let currentTime: TimeProvider = systemTime;

/** Override the time provider (for testing). */
export function setTimeProvider(tp: TimeProvider): void {
  currentTime = tp;
}

/** Reset to system time. */
export function resetTimeProvider(): void {
  currentTime = systemTime;
}

/** The executable flow state. Immutable — all mutations return new instances. */
export interface ExecutableFlow {
  readonly id: FlowId;
  readonly places: ReadonlyMap<PlaceId, PlaceInstance>;
  readonly transitions: ReadonlyMap<TransitionId, TransitionInstance>;
  readonly updated: number;
  readonly seq: number;
  readonly maxTransitionRetries: number;
  readonly backoffBaseMillis: number;
}

/** Create an ExecutableFlow from place and transition instances. */
export function createExecutableFlow(
  id: FlowId,
  places: Map<PlaceId, PlaceInstance>,
  transitions: Map<TransitionId, TransitionInstance>,
  opts?: { maxTransitionRetries?: number; backoffBaseMillis?: number },
): ExecutableFlow {
  return {
    id,
    places,
    transitions,
    updated: currentTime.nowMillis(),
    seq: 0,
    maxTransitionRetries: opts?.maxTransitionRetries ?? 10,
    backoffBaseMillis: opts?.backoffBaseMillis ?? 1,
  };
}

// --- Immutable update helpers ---

function updatePlace(
  flow: ExecutableFlow,
  placeId: PlaceId,
  fn: (p: PlaceInstance) => PlaceInstance,
): ExecutableFlow {
  const place = flow.places.get(placeId);
  if (!place) return flow;
  const newPlaces = new Map(flow.places);
  newPlaces.set(placeId, fn(place));
  return { ...flow, places: newPlaces };
}

function updateTransition(
  flow: ExecutableFlow,
  transitionId: TransitionId,
  fn: (t: TransitionInstance) => TransitionInstance,
): ExecutableFlow {
  const transition = flow.transitions.get(transitionId);
  if (!transition) return flow;
  const newTransitions = new Map(flow.transitions);
  newTransitions.set(transitionId, fn(transition));
  return { ...flow, transitions: newTransitions };
}

function tick(flow: ExecutableFlow): ExecutableFlow {
  return { ...flow, updated: currentTime.nowMillis(), seq: flow.seq + 1 };
}

// --- Token operations ---

/** Add a token to a place. Returns unchanged flow if place doesn't accept the token tag. */
export function addToken(flow: ExecutableFlow, placeId: PlaceId, token: Token, spanId?: SpanId): ExecutableFlow {
  const place = flow.places.get(placeId);
  if (!place || !place.accepts.has(token.tag)) return flow;
  return tick(updatePlace(flow, placeId, (p) => ({
    ...p,
    tokens: [...p.tokens, token],
    lastSpan: spanId ?? p.lastSpan,
  })));
}

/** Add multiple tokens to a place. */
export function addTokens(flow: ExecutableFlow, placeId: PlaceId, tokens: Token[], spanId?: SpanId): ExecutableFlow {
  return tokens.reduce((f, tok) => addToken(f, placeId, tok, spanId), flow);
}

/** Seed initial tokens into places. */
export function withInitialTokens(flow: ExecutableFlow, pairs: [PlaceId, Token][]): ExecutableFlow {
  return pairs.reduce((f, [placeId, token]) => addToken(f, placeId, token), flow);
}

// --- Transition lifecycle ---

/** Find transitions that are ready to fire. Returns [transitionInstance, consumableTokens] pairs. */
export function transitionsReady(flow: ExecutableFlow): Array<[TransitionInstance, Token[]]> {
  const now = currentTime.nowMillis();
  const result: Array<[TransitionInstance, Token[]]> = [];

  for (const transition of flow.transitions.values()) {
    if (transition.state === "Ongoing") continue;
    if (transition.nextRetryAt !== undefined && transition.nextRetryAt > now) continue;

    const fromPlace = flow.places.get(transition.from);
    if (!fromPlace || fromPlace.tokens.length === 0) continue;

    // Check if all required token types are present
    const hasAll = [...transition.consumes].every((requiredTag) =>
      fromPlace.tokens.some((t) => t.tag === requiredTag),
    );
    if (hasAll) {
      result.push([transition, [...fromPlace.tokens]]);
    }
  }

  return result;
}

/** Record a transition starting: consume tokens from its input place. */
export function recordTransitionStart(
  flow: ExecutableFlow,
  fromPlaceId: PlaceId,
  transitionId: TransitionId,
): ExecutableFlow {
  const transition = flow.transitions.get(transitionId);
  if (!transition) return flow;

  const place = flow.places.get(fromPlaceId);
  if (!place) return flow;

  // Consume matching tokens
  const consumed: Token[] = [];
  const remaining = [...place.tokens];
  for (const requiredTag of transition.consumes) {
    const idx = remaining.findIndex((t) => t.tag === requiredTag);
    if (idx >= 0) {
      consumed.push(remaining.splice(idx, 1)[0]);
    }
  }

  let updated = updatePlace(flow, fromPlaceId, (p) => ({ ...p, tokens: remaining }));
  updated = updateTransition(updated, transitionId, (t) => ({
    ...t,
    consumed,
    state: "Ongoing" as const,
  }));
  return tick(updated);
}

/** Record a transition completing: place produced tokens into destination places. */
export function recordTransitionCompletion(
  flow: ExecutableFlow,
  transitionId: TransitionId,
  tokensByPlace: Map<PlaceId, Token[]>,
  spanId: SpanId,
): ExecutableFlow {
  let updated = flow;

  // Add tokens to their destination places
  for (const [placeId, tokens] of tokensByPlace) {
    for (const token of tokens) {
      updated = addToken(updated, placeId, token, spanId);
    }
  }

  // Collect all produced tokens
  const allProduced: Token[] = [];
  for (const tokens of tokensByPlace.values()) {
    allProduced.push(...tokens);
  }

  updated = updateTransition(updated, transitionId, (t) => ({
    ...t,
    state: "Completed" as const,
    produced: allProduced,
    retryAttempts: 0,
    nextRetryAt: undefined,
  }));

  return tick(updated);
}

/** Record a transition failing: return consumed tokens to the source place, schedule retry. */
export function recordTransitionFailure(
  flow: ExecutableFlow,
  transitionId: TransitionId,
  fromPlaceId: PlaceId,
): ExecutableFlow {
  const transition = flow.transitions.get(transitionId);
  if (!transition) return flow;

  const consumed = transition.consumed ?? [];

  // Return consumed tokens to the source place
  let updated = updatePlace(flow, fromPlaceId, (p) => ({
    ...p,
    tokens: [...p.tokens, ...consumed],
  }));

  const nextAttempts = transition.retryAttempts + 1;

  if (nextAttempts <= flow.maxTransitionRetries) {
    const delay = Math.max(1, fibonacci(nextAttempts)) * flow.backoffBaseMillis;
    updated = updateTransition(updated, transitionId, (t) => ({
      ...t,
      state: "NotStarted" as const,
      retryAttempts: nextAttempts,
      nextRetryAt: currentTime.nowMillis() + delay,
    }));
  } else {
    updated = updateTransition(updated, transitionId, (t) => ({
      ...t,
      state: "Failed" as const,
      retryAttempts: nextAttempts,
      nextRetryAt: undefined,
    }));
  }

  return tick(updated);
}

/** Find the destination place for a token produced by a transition. */
export function placeForResult(flow: ExecutableFlow, transitionId: TransitionId, token: Token): PlaceInstance | undefined {
  const transition = flow.transitions.get(transitionId);
  if (!transition) return undefined;
  const placeId = transition.produces.get(token.tag);
  if (!placeId) return undefined;
  return flow.places.get(placeId);
}

/** Generate DOT graph string for visualization. */
export function toDotString(flow: ExecutableFlow): string {
  const lines: string[] = [];
  lines.push(`digraph "${flow.id}" {`);

  for (const place of flow.places.values()) {
    const penwidth = place.type === "Inbound" || place.type === "Outbound" ? 3 : 1;
    const fillcolor = place.tokens.length > 0 ? "yellow" : "lightgray";
    lines.push(`  "${place.id}" [shape=house, style=filled, penwidth=${penwidth}, fillcolor=${fillcolor}, fontsize=10, label="${place.id}"];`);
  }

  for (const transition of flow.transitions.values()) {
    const fillcolor =
      transition.state === "NotStarted" ? "white" :
      transition.state === "Ongoing" ? "lightyellow" :
      transition.state === "Completed" ? "lightgreen" : "lightred";
    lines.push(`  "${transition.id}" [shape=cds, style=filled, fillcolor=${fillcolor}, label="${transition.id}"];`);
  }

  // Edges
  for (const transition of flow.transitions.values()) {
    // Input edge: from place → transition
    const consumeLabel = [...transition.consumes].join(", ");
    lines.push(`  "${transition.from}" -> "${transition.id}" [label="${consumeLabel}"];`);

    // Output edges: transition → to places
    for (const [tokenTag, placeId] of transition.produces) {
      lines.push(`  "${transition.id}" -> "${placeId}" [label="${tokenTag}"];`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}
