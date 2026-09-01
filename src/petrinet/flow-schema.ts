/**
 * Flow schema definition and validation.
 *
 * Validates that a Petri Net schema is well-formed:
 *   - No duplicate place/transition IDs
 *   - All transitions reference existing places
 *   - Token type compatibility between places and transitions
 *   - All places are used in at least one transition
 *   - Exactly one inbound place, at least one outbound place
 *   - Graph is connected
 *   - All nodes lie on a path from inbound to outbound (soundness)
 *   - No token flow gaps
 */

import type { PlaceDef, TransitionDef, PlaceId, FlowId } from "./types.js";
import { placeInstanceFromDef, transitionInstanceFromDef } from "./types.js";
import type { ExecutableFlow } from "./executable-flow.js";
import { createExecutableFlow } from "./executable-flow.js";

export interface ValidationError {
  message: string;
}

export interface FlowSchema {
  readonly places: readonly PlaceDef[];
  readonly transitions: readonly TransitionDef[];
}

/** Create a FlowSchema. */
export function flowSchema(places: PlaceDef[], transitions: TransitionDef[]): FlowSchema {
  return { places, transitions };
}

/** Validate and compile a FlowSchema into an ExecutableFlow. */
export function compileSchema(
  schema: FlowSchema,
  flowId: FlowId,
  opts?: { maxTransitionRetries?: number; backoffBaseMillis?: number },
): { flow: ExecutableFlow } | { errors: ValidationError[] } {
  const errors = validate(schema);
  if (errors.length > 0) return { errors };

  const places = new Map(
    schema.places.map((p) => [p.id, placeInstanceFromDef(p)]),
  );
  const transitions = new Map(
    schema.transitions.map((t) => [t.id, transitionInstanceFromDef(t)]),
  );

  return { flow: createExecutableFlow(flowId, places, transitions, opts) };
}

/** Validate and compile, throwing on errors. */
export function compileSchemaOrFail(
  schema: FlowSchema,
  flowId: FlowId,
  opts?: { maxTransitionRetries?: number; backoffBaseMillis?: number },
): ExecutableFlow {
  const result = compileSchema(schema, flowId, opts);
  if ("errors" in result) {
    throw new Error(`FlowSchema validation failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.flow;
}

/** Validate a FlowSchema, returning all errors found. */
export function validate(schema: FlowSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  const placeMap = new Map(schema.places.map((p) => [p.id, p]));
  const transMap = new Map(schema.transitions.map((t) => [t.id, t]));

  // 1. No duplicate IDs
  if (placeMap.size !== schema.places.length) {
    errors.push({ message: "Duplicate Place IDs detected" });
  }
  if (transMap.size !== schema.transitions.length) {
    errors.push({ message: "Duplicate Transition IDs detected" });
  }

  // 2. All transitions reference existing places (from)
  for (const t of schema.transitions) {
    if (!placeMap.has(t.from)) {
      errors.push({ message: `Transition ${t.id} references non-existent 'from' Place: ${t.from}` });
    }
  }

  // 3. All 'to' places must exist
  for (const t of schema.transitions) {
    for (const [tokenTag, placeId] of t.to) {
      if (!placeMap.has(placeId)) {
        errors.push({ message: `Transition ${t.id} routes token ${tokenTag} to non-existent Place: ${placeId}` });
      }
    }
  }

  // 4. Token type compatibility
  for (const t of schema.transitions) {
    const fromPlace = placeMap.get(t.from);
    if (fromPlace) {
      for (const tag of t.consumes) {
        if (!fromPlace.accepts.has(tag)) {
          errors.push({ message: `Transition ${t.id} consumes token ${tag} not accepted by Place ${fromPlace.id}` });
        }
      }
    }
    for (const [tokenTag, placeId] of t.to) {
      const destPlace = placeMap.get(placeId);
      if (destPlace && !destPlace.accepts.has(tokenTag)) {
        errors.push({ message: `Transition ${t.id} sends token ${tokenTag} to Place ${destPlace.id} which doesn't accept it` });
      }
    }
  }

  // 5. Every place is used in at least one transition
  const usedPlaces = new Set<PlaceId>();
  for (const t of schema.transitions) {
    usedPlaces.add(t.from);
    for (const placeId of t.to.values()) {
      usedPlaces.add(placeId);
    }
  }
  for (const p of schema.places) {
    if (!usedPlaces.has(p.id)) {
      errors.push({ message: `Place ${p.id} is unused in any transition` });
    }
  }

  // 6. Every transition must consume and produce
  for (const t of schema.transitions) {
    if (t.consumes.size === 0 || t.to.size === 0) {
      errors.push({ message: `Transition ${t.id} is incomplete (must consume and produce)` });
    }
  }

  // 7. Exactly one inbound place
  const inboundPlaces = schema.places.filter((p) => p.type === "Inbound");
  if (inboundPlaces.length === 0) {
    errors.push({ message: "No Inbound place defined in the flow" });
  } else if (inboundPlaces.length > 1) {
    errors.push({ message: "Multiple Inbound places defined in the flow" });
  }

  // 7.1 At least one outbound place
  const outboundPlaces = schema.places.filter((p) => p.type === "Outbound");
  if (outboundPlaces.length === 0) {
    errors.push({ message: "No Outbound place defined in the flow" });
  }

  // 8. Tokens accepted by inbound place should not be produced by transitions from other places
  for (const inbound of inboundPlaces) {
    for (const t of schema.transitions) {
      if (t.from !== inbound.id) {
        for (const producedTag of t.to.keys()) {
          if (inbound.accepts.has(producedTag)) {
            errors.push({
              message: `Token ${producedTag} accepted by Inbound place ${inbound.id} is produced by transition ${t.id} that does not consume from Inbound`,
            });
          }
        }
      }
    }
  }

  // 9. Graph connectivity (undirected BFS)
  const adjacency = new Map<PlaceId, Set<PlaceId>>();
  for (const t of schema.transitions) {
    if (!adjacency.has(t.from)) adjacency.set(t.from, new Set());
    for (const placeId of t.to.values()) {
      if (!adjacency.has(placeId)) adjacency.set(placeId, new Set());
      adjacency.get(t.from)!.add(placeId);
      adjacency.get(placeId)!.add(t.from);
    }
  }

  if (adjacency.size > 0) {
    const start = adjacency.keys().next().value!;
    const visited = new Set<PlaceId>();
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (visited.size !== adjacency.size) {
      errors.push({ message: "Flow graph is not connected" });
    }
  }

  // 9.1 Directed soundness — all nodes on a path from inbound to outbound
  if (inboundPlaces.length > 0 && outboundPlaces.length > 0) {
    const sourcePlaceId = inboundPlaces[0].id;
    const sinkPlaceIds = new Set(outboundPlaces.map((p) => p.id));

    // Forward: place → transitions → places
    const placeToTransitions = new Map<PlaceId, Set<string>>();
    const transitionToPlaces = new Map<string, Set<PlaceId>>();
    for (const t of schema.transitions) {
      if (!placeToTransitions.has(t.from)) placeToTransitions.set(t.from, new Set());
      placeToTransitions.get(t.from)!.add(t.id);
      if (!transitionToPlaces.has(t.id)) transitionToPlaces.set(t.id, new Set());
      for (const placeId of t.to.values()) {
        transitionToPlaces.get(t.id)!.add(placeId);
      }
    }

    // Forward reachability from source
    const reachablePlaces = new Set<PlaceId>();
    const reachableTransitions = new Set<string>();
    const fwdQueue: PlaceId[] = [sourcePlaceId];
    while (fwdQueue.length > 0) {
      const p = fwdQueue.shift()!;
      if (reachablePlaces.has(p)) continue;
      reachablePlaces.add(p);
      for (const tid of placeToTransitions.get(p) ?? []) {
        if (!reachableTransitions.has(tid)) {
          reachableTransitions.add(tid);
          for (const destP of transitionToPlaces.get(tid) ?? []) {
            if (!reachablePlaces.has(destP)) fwdQueue.push(destP);
          }
        }
      }
    }

    // Reverse: place ← transitions ← places
    const transitionFromPlaces = new Map<string, Set<PlaceId>>();
    const placeFromTransitions = new Map<PlaceId, Set<string>>();
    for (const t of schema.transitions) {
      if (!transitionFromPlaces.has(t.id)) transitionFromPlaces.set(t.id, new Set());
      transitionFromPlaces.get(t.id)!.add(t.from);
      for (const placeId of t.to.values()) {
        if (!placeFromTransitions.has(placeId)) placeFromTransitions.set(placeId, new Set());
        placeFromTransitions.get(placeId)!.add(t.id);
      }
    }

    // Backward reachability from sinks
    const coReachPlaces = new Set<PlaceId>();
    const coReachTransitions = new Set<string>();
    const bwdQueue: PlaceId[] = [...sinkPlaceIds];
    while (bwdQueue.length > 0) {
      const p = bwdQueue.shift()!;
      if (coReachPlaces.has(p)) continue;
      coReachPlaces.add(p);
      for (const tid of placeFromTransitions.get(p) ?? []) {
        if (!coReachTransitions.has(tid)) {
          coReachTransitions.add(tid);
          for (const srcP of transitionFromPlaces.get(tid) ?? []) {
            if (!coReachPlaces.has(srcP)) bwdQueue.push(srcP);
          }
        }
      }
    }

    // Check all places and transitions are on a path
    for (const p of schema.places) {
      if (!reachablePlaces.has(p.id) || !coReachPlaces.has(p.id)) {
        errors.push({ message: `Place ${p.id} is not on any path from inbound to outbound (un-sound)` });
      }
    }
    for (const t of schema.transitions) {
      if (!reachableTransitions.has(t.id) || !coReachTransitions.has(t.id)) {
        errors.push({ message: `Transition ${t.id} is not on any path from inbound to outbound (dead or isolated)` });
      }
    }
  }

  // 10. Gap detection — no non-inbound place accepts tokens that no transition produces
  const producedTokensByPlace = new Map<PlaceId, Set<string>>();
  for (const t of schema.transitions) {
    for (const [tokenTag, placeId] of t.to) {
      if (!producedTokensByPlace.has(placeId)) producedTokensByPlace.set(placeId, new Set());
      producedTokensByPlace.get(placeId)!.add(tokenTag);
    }
  }
  for (const p of schema.places) {
    if (p.type === "Inbound") continue;
    for (const acceptedTag of p.accepts) {
      const produced = producedTokensByPlace.get(p.id);
      if (!produced || !produced.has(acceptedTag)) {
        errors.push({
          message: `Gap detected: No transition produces ${acceptedTag} token for place ${p.id} which accepts it`,
        });
      }
    }
  }

  return errors;
}
