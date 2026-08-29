/**
 * Flow aggregate for Petri Net based entity management.
 *
 * Provides command/event/reply types and state management for entities
 * driven by Petri Net flows. Transitions fire automatically when tokens
 * are available.
 *
 * Use `flowAggregate()` to create a TEOB `Aggregate` from a flow schema
 * and externals, registerable with any `EntityRuntime`.
 */

import type {
  Token, PlaceId, TransitionId, SpanId, TransitionState,
  PlaceInstance,
} from "./types.js";
import type { ExecutableFlow } from "./executable-flow.js";
import {
  addToken,
  recordTransitionStart,
  recordTransitionCompletion,
  recordTransitionFailure,
  transitionsReady,
  placeForResult,
} from "./executable-flow.js";
import type { Aggregate } from "../core/aggregate.js";
import type { EffectControl } from "../core/effect-control.js";
import type { CategoryId, EntityId } from "../core/types.js";
import type { Effect } from "../core/effect.js";
import { persist, reply as replyEffect, run, done, replyDeferred as replyDeferredEffect } from "../core/effect.js";
import { andRun, andReply, andReplyDeferred } from "../core/effect.js";
import type { DeferredReply } from "../core/deferred.js";
import { createDeferredReply } from "../core/deferred.js";

// --- Commands ---

export type FlowCommand =
  | { tag: "InboundToken"; token: Token; expectsRepliesAt: PlaceId[]; spanId: SpanId }
  | { tag: "GetFlowInstanceView" }
  | { tag: "TransitionResult"; transitionId: TransitionId; tokens: Token[]; spanId: SpanId }
  | { tag: "TransitionError"; transitionId: TransitionId; message: string; spanId: SpanId };

// --- Replies ---

export type FlowReply =
  | { tag: "TokenRejected"; token: Token; spanId: SpanId }
  | { tag: "OutboundTokens"; tokens: Map<PlaceId, Token[]>; spanId: SpanId }
  | { tag: "FlowInstanceView"; places: Map<PlaceId, Token[]>; transitions: Map<TransitionId, TransitionState> };

// --- Events ---

export type FlowEvent =
  | { tag: "TokenAdded"; placeId: PlaceId; token: Token; spanId: SpanId }
  | { tag: "TransitionFired"; transitionId: TransitionId; from: PlaceId; consumed: Token[]; spanId: SpanId }
  | { tag: "TransitionCompleted"; transitionId: TransitionId; to: Map<PlaceId, Token[]>; spanId: SpanId }
  | { tag: "TransitionFailed"; transitionId: TransitionId; from: PlaceId; spanId: SpanId };

// --- State ---

export interface FlowState {
  readonly flow: ExecutableFlow;
  readonly tokenHistory: ReadonlyMap<SpanId, PlaceId>;
}

// --- Side effects produced by command handling ---

export interface FlowSideEffect {
  readonly type: "ExecuteTransition" | "OutboundToken" | "Log";
  readonly transitionId?: TransitionId;
  readonly placeId?: PlaceId;
  readonly token?: Token;
  readonly consumed?: Token[];
  readonly spanId?: SpanId;
  readonly message?: string;
}

/** Result of handling a command. */
export interface FlowCommandResult {
  readonly events: FlowEvent[];
  readonly reply?: FlowReply;
  readonly sideEffects: FlowSideEffect[];
}

// --- Externals interface ---

/** Transition executor — given consumed tokens, returns produced tokens or an error message. */
export type TransitionExecutor = (
  transitionId: TransitionId,
  consumed: Token[],
) => Promise<Token[] | { error: string }>;

/** Outbound handler — called when tokens arrive at an outbound place. */
export type OutboundHandler = (placeId: PlaceId, token: Token) => Promise<void>;

/** Flow externals — define the side effect implementations. */
export interface FlowExternals {
  /** Map of transition ID → executor function. */
  readonly transitions: Map<TransitionId, TransitionExecutor>;
  /** Map of outbound place ID → handler function. */
  readonly outbound: Map<PlaceId, OutboundHandler>;
}

// --- State update (pure reducer) ---

/** Apply a FlowEvent to a FlowState, returning the new state. */
export function updateFlowState(state: FlowState, event: FlowEvent): FlowState {
  switch (event.tag) {
    case "TokenAdded":
      return {
        flow: addToken(state.flow, event.placeId, event.token),
        tokenHistory: new Map([...state.tokenHistory, [event.spanId, event.placeId]]),
      };
    case "TransitionFired":
      return {
        ...state,
        flow: recordTransitionStart(state.flow, event.from, event.transitionId),
      };
    case "TransitionCompleted":
      return {
        ...state,
        flow: recordTransitionCompletion(state.flow, event.transitionId, event.to, event.spanId),
      };
    case "TransitionFailed":
      return {
        ...state,
        flow: recordTransitionFailure(state.flow, event.transitionId, event.from),
      };
  }
}

// --- Event generation ---

/** Generate follow-up events when a token is added to a place. */
function followUpEvents(
  state: FlowState,
  token: Token,
  place: PlaceInstance,
  spanId: SpanId,
): FlowEvent[] {
  const events: FlowEvent[] = [];

  // TokenAdded event
  events.push({ tag: "TokenAdded", placeId: place.id, token, spanId });

  // Check if any transitions can fire after adding this token
  const flowAfterAdd = addToken(state.flow, place.id, token);
  const ready = transitionsReady(flowAfterAdd);
  for (const [transition, _tokens] of ready) {
    events.push({
      tag: "TransitionFired",
      transitionId: transition.id,
      from: place.id,
      consumed: _tokens,
      spanId,
    });
  }

  return events;
}

/** Generate events for a command. */
export function eventsOnCommand(state: FlowState, command: FlowCommand): FlowEvent[] {
  switch (command.tag) {
    case "InboundToken": {
      const events: FlowEvent[] = [];
      for (const place of state.flow.places.values()) {
        if (place.type === "Inbound" && place.accepts.has(command.token.tag)) {
          events.push(...followUpEvents(state, command.token, place, command.spanId));
        }
      }
      return events;
    }

    case "TransitionResult": {
      const events: FlowEvent[] = [];
      const tokensByPlace = new Map<PlaceId, Token[]>();

      for (const token of command.tokens) {
        const destPlace = placeForResult(state.flow, command.transitionId, token);
        if (destPlace) {
          if (!tokensByPlace.has(destPlace.id)) tokensByPlace.set(destPlace.id, []);
          tokensByPlace.get(destPlace.id)!.push(token);
        }
      }

      events.push({
        tag: "TransitionCompleted",
        transitionId: command.transitionId,
        to: tokensByPlace,
        spanId: command.spanId,
      });

      // Follow-up events for tokens landing in new places
      for (const [placeId, tokens] of tokensByPlace) {
        const place = state.flow.places.get(placeId);
        if (place) {
          for (const token of tokens) {
            events.push(...followUpEvents(state, token, place, command.spanId));
          }
        }
      }

      return events;
    }

    case "TransitionError": {
      const transition = state.flow.transitions.get(command.transitionId);
      if (!transition) return [];
      return [{
        tag: "TransitionFailed",
        transitionId: command.transitionId,
        from: transition.from,
        spanId: command.spanId,
      }];
    }

    case "GetFlowInstanceView":
      return [];
  }
}

/** Handle a command: generate events, compute reply and side effects. */
export function handleFlowCommand(state: FlowState, command: FlowCommand): FlowCommandResult {
  const events = eventsOnCommand(state, command);
  const sideEffects: FlowSideEffect[] = [];
  let reply: FlowReply | undefined;

  if (command.tag === "GetFlowInstanceView") {
    const placesMap = new Map<PlaceId, Token[]>();
    for (const [id, p] of state.flow.places) {
      placesMap.set(id, [...p.tokens]);
    }
    const transMap = new Map<TransitionId, TransitionState>();
    for (const [id, t] of state.flow.transitions) {
      transMap.set(id, t.state);
    }
    reply = { tag: "FlowInstanceView", places: placesMap, transitions: transMap };
    return { events, reply, sideEffects };
  }

  // Apply events to get new state
  const newState = events.reduce(updateFlowState, state);

  // Build side effects
  for (const event of events) {
    if (event.tag === "TransitionFired") {
      sideEffects.push({
        type: "ExecuteTransition",
        transitionId: event.transitionId,
        consumed: event.consumed,
        spanId: event.spanId,
      });
    } else if (event.tag === "TokenAdded") {
      const place = newState.flow.places.get(event.placeId);
      if (place && place.type === "Outbound") {
        sideEffects.push({
          type: "OutboundToken",
          placeId: event.placeId,
          token: event.token,
          spanId: event.spanId,
        });
      }
    } else if (event.tag === "TransitionCompleted") {
      sideEffects.push({
        type: "Log",
        transitionId: event.transitionId,
        message: `${event.transitionId} completed`,
      });
    }
  }

  // Check for immediate outbound reply
  if (command.tag === "InboundToken" && command.expectsRepliesAt.length > 0) {
    for (const placeId of command.expectsRepliesAt) {
      const place = newState.flow.places.get(placeId);
      if (place && place.type === "Outbound" && place.tokens.length > 0 && place.lastSpan === command.spanId) {
        const tokensByPlace = new Map<PlaceId, Token[]>();
        tokensByPlace.set(placeId, [...place.tokens]);
        reply = { tag: "OutboundTokens", tokens: tokensByPlace, spanId: command.spanId };
        break;
      }
    }
  }

  return { events, reply, sideEffects };
}

/** Execute side effects using the provided externals. Returns commands to self-send. */
export async function executeSideEffects(
  sideEffects: FlowSideEffect[],
  externals: FlowExternals,
): Promise<FlowCommand[]> {
  const selfCommands: FlowCommand[] = [];

  for (const effect of sideEffects) {
    if (effect.type === "ExecuteTransition" && effect.transitionId && effect.consumed && effect.spanId) {
      const executor = externals.transitions.get(effect.transitionId);
      if (executor) {
        const result = await executor(effect.transitionId, effect.consumed);
        if (Array.isArray(result)) {
          selfCommands.push({
            tag: "TransitionResult",
            transitionId: effect.transitionId,
            tokens: result,
            spanId: effect.spanId,
          });
        } else {
          selfCommands.push({
            tag: "TransitionError",
            transitionId: effect.transitionId,
            message: result.error,
            spanId: effect.spanId,
          });
        }
      }
    } else if (effect.type === "OutboundToken" && effect.placeId && effect.token) {
      const handler = externals.outbound.get(effect.placeId);
      if (handler) {
        await handler(effect.placeId, effect.token);
      }
    }
  }

  return selfCommands;
}

// --- Aggregate manifest ---

/** Configuration for creating a flow aggregate. */
export interface FlowAggregateConfig {
  /** The category ID for the entity. */
  category: CategoryId;
  /** Factory for the initial executable flow (called per entity instance). */
  initialFlow: () => ExecutableFlow;
  /** The externals providing transition executors and outbound handlers. */
  externals: FlowExternals;
}

/**
 * Create a TEOB `Aggregate` from a Petri Net flow.
 *
 * This is the TypeScript equivalent of Scala's `FlowAggregate.manifest()`.
 * The returned Aggregate can be registered with any EntityRuntime (inmem or postgres).
 *
 * Transitions fire automatically when tokens arrive. Side effects (transition execution,
 * outbound token handling) are executed via `Effect.Run`, and transition results are
 * fed back as self-commands via `EffectControl.tellSelf`.
 */
export function flowAggregate(
  config: FlowAggregateConfig,
): Aggregate<FlowCommand, FlowReply, FlowEvent, FlowState> {
  const { category, initialFlow, externals } = config;

  // Transient deferred tracking (not persisted — lives in the aggregate factory closure).
  // Key: "entityId:spanId", Value: deferred + which outbound places to watch.
  interface PendingDeferred {
    deferred: DeferredReply<FlowReply>;
    expectsRepliesAt: PlaceId[];
    spanId: SpanId;
  }
  const pendingDeferreds = new Map<string, PendingDeferred>();
  const deferredKey = (entityId: EntityId, spanId: SpanId) => `${entityId}:${spanId}`;

  /** Check outbound places for tokens matching a pending deferred and complete it if found. */
  function tryCompleteDeferreds(entityId: EntityId, flowState: FlowState): void {
    for (const [key, pending] of pendingDeferreds) {
      if (!key.startsWith(`${entityId}:`)) continue;
      if (pending.deferred.isCompleted) {
        pendingDeferreds.delete(key);
        continue;
      }
      for (const placeId of pending.expectsRepliesAt) {
        const place = flowState.flow.places.get(placeId);
        if (place && place.type === "Outbound" && place.tokens.length > 0 && place.lastSpan === pending.spanId) {
          const tokensByPlace = new Map<PlaceId, Token[]>();
          tokensByPlace.set(placeId, [...place.tokens]);
          pending.deferred.complete({
            tag: "OutboundTokens",
            tokens: tokensByPlace,
            spanId: pending.spanId,
          });
          pendingDeferreds.delete(key);
          return; // one completion per command processing
        }
      }
    }
  }

  return {
    category,

    initial(_id: EntityId): FlowState {
      return { flow: initialFlow(), tokenHistory: new Map() };
    },

    async decide(
      state: FlowState,
      command: FlowCommand,
      ctx: EffectControl<FlowCommand, FlowReply>,
    ): Promise<Effect<FlowEvent, FlowReply>> {
      // GetFlowInstanceView — pure reply, no events
      if (command.tag === "GetFlowInstanceView") {
        const placesMap = new Map<PlaceId, Token[]>();
        for (const [id, p] of state.flow.places) {
          placesMap.set(id, [...p.tokens]);
        }
        const transMap = new Map<TransitionId, TransitionState>();
        for (const [id, t] of state.flow.transitions) {
          transMap.set(id, t.state);
        }
        return replyEffect<FlowEvent, FlowReply>({
          tag: "FlowInstanceView",
          places: placesMap,
          transitions: transMap,
        });
      }

      // Generate events from command
      const events = eventsOnCommand(state, command);
      if (events.length === 0) {
        // Even with no events, check if a pending deferred can be completed
        tryCompleteDeferreds(ctx.entityId, state);
        return done();
      }

      // Apply events to compute new state (for side effect context)
      const newState = events.reduce(updateFlowState, state);

      // Build the base persist effect
      let effect: Effect<FlowEvent, FlowReply> = persist<FlowEvent, FlowReply>(...events);

      // Build side effects: execute transitions and handle outbound tokens
      const sideEffects = buildSideEffectsFromEvents(events, newState, externals, ctx);
      for (const sideEffect of sideEffects) {
        effect = andRun(effect, sideEffect);
      }

      // Handle replies for InboundToken with expectsRepliesAt
      if (command.tag === "InboundToken" && command.expectsRepliesAt.length > 0) {
        // Check if outbound tokens are already available (immediate path)
        let immediateReply: FlowReply | undefined;
        for (const placeId of command.expectsRepliesAt) {
          const place = newState.flow.places.get(placeId);
          if (place && place.type === "Outbound" && place.tokens.length > 0 && place.lastSpan === command.spanId) {
            const tokensByPlace = new Map<PlaceId, Token[]>();
            tokensByPlace.set(placeId, [...place.tokens]);
            immediateReply = { tag: "OutboundTokens", tokens: tokensByPlace, spanId: command.spanId };
            break;
          }
        }

        if (immediateReply) {
          effect = andReply(effect, immediateReply);
        } else {
          // Create a deferred reply — the caller's ask() stays open
          const deferred = createDeferredReply<FlowReply>();
          const key = deferredKey(ctx.entityId, command.spanId);
          pendingDeferreds.set(key, {
            deferred,
            expectsRepliesAt: command.expectsRepliesAt,
            spanId: command.spanId,
          });
          effect = andReplyDeferred(effect, deferred);
        }
      }

      // For TransitionResult/TransitionError, check if any pending deferreds can be completed
      if (command.tag === "TransitionResult" || command.tag === "TransitionError") {
        tryCompleteDeferreds(ctx.entityId, newState);
      }

      return effect;
    },

    apply(state: FlowState, event: FlowEvent): FlowState {
      return updateFlowState(state, event);
    },
  };
}

/**
 * Build side effect functions from events for use with Effect.Run.
 * Transition results are fed back via tellSelf.
 */
function buildSideEffectsFromEvents(
  events: FlowEvent[],
  _newState: FlowState,
  externals: FlowExternals,
  ctx: EffectControl<FlowCommand, FlowReply>,
): Array<() => Promise<void>> {
  const sideEffects: Array<() => Promise<void>> = [];

  for (const event of events) {
    if (event.tag === "TransitionFired") {
      const { transitionId, consumed, spanId } = event;
      const executor = externals.transitions.get(transitionId);
      if (executor) {
        sideEffects.push(async () => {
          ctx.log("info", `${transitionId} fired`);
          const result = await executor(transitionId, consumed);
          if (Array.isArray(result)) {
            await ctx.tellSelf({
              tag: "TransitionResult",
              transitionId,
              tokens: result,
              spanId,
            });
          } else {
            await ctx.tellSelf({
              tag: "TransitionError",
              transitionId,
              message: result.error,
              spanId,
            });
          }
        });
      }
    } else if (event.tag === "TransitionCompleted") {
      sideEffects.push(async () => {
        ctx.log("info", `${event.transitionId} completed`);
      });
    } else if (event.tag === "TokenAdded") {
      const place = _newState.flow.places.get(event.placeId);
      if (place && place.type === "Outbound") {
        const handler = externals.outbound.get(event.placeId);
        if (handler) {
          const { placeId, token } = event;
          sideEffects.push(async () => {
            await handler(placeId, token);
          });
        }
      }
    }
  }

  return sideEffects;
}
