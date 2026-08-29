// Effect ADT — declarative, chainable effect descriptions

import type { DeferredReply } from "./deferred.js";

export type Effect<Event, Reply> =
  | { tag: "Persist"; events: Event[]; andThen: Effect<Event, Reply> }
  | { tag: "Run"; sideEffect: () => Promise<void>; andThen: Effect<Event, Reply> }
  | { tag: "Reply"; value: Reply }
  | { tag: "ReplyDeferred"; deferred: DeferredReply<Reply> }
  | { tag: "Snapshot"; andThen: Effect<Event, Reply> }
  | { tag: "Stop" }
  | { tag: "Stash" }
  | { tag: "Unstash"; andThen: Effect<Event, Reply> }
  | { tag: "Done" };

// Constructors

export function persist<Event, Reply>(...events: Event[]): Effect<Event, Reply> {
  return { tag: "Persist", events, andThen: { tag: "Done" } };
}

export function reply<Event, Reply>(value: Reply): Effect<Event, Reply> {
  return { tag: "Reply", value };
}

export function run<Event, Reply>(sideEffect: () => Promise<void>): Effect<Event, Reply> {
  return { tag: "Run", sideEffect, andThen: { tag: "Done" } };
}

export function snapshot<Event, Reply>(): Effect<Event, Reply> {
  return { tag: "Snapshot", andThen: { tag: "Done" } };
}

export function stop<Event, Reply>(): Effect<Event, Reply> {
  return { tag: "Stop" };
}

export function stash<Event, Reply>(): Effect<Event, Reply> {
  return { tag: "Stash" };
}

export function unstash<Event, Reply>(): Effect<Event, Reply> {
  return { tag: "Unstash", andThen: { tag: "Done" } };
}

export function replyDeferred<Event, Reply>(deferred: DeferredReply<Reply>): Effect<Event, Reply> {
  return { tag: "ReplyDeferred", deferred };
}

export function done<Event, Reply>(): Effect<Event, Reply> {
  return { tag: "Done" };
}

// Chainable extensions — return a new effect with the chain appended

function appendToChain<Event, Reply>(
  effect: Effect<Event, Reply>,
  next: Effect<Event, Reply>,
): Effect<Event, Reply> {
  switch (effect.tag) {
    case "Persist":
      return { ...effect, andThen: appendToChain(effect.andThen, next) };
    case "Run":
      return { ...effect, andThen: appendToChain(effect.andThen, next) };
    case "Snapshot":
      return { ...effect, andThen: appendToChain(effect.andThen, next) };
    case "Unstash":
      return { ...effect, andThen: appendToChain(effect.andThen, next) };
    case "Done":
      return next;
    default:
      return effect; // Reply, ReplyDeferred, Stop, Stash are terminal
  }
}

export function andRun<Event, Reply>(
  effect: Effect<Event, Reply>,
  sideEffect: () => Promise<void>,
): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "Run", sideEffect, andThen: { tag: "Done" } });
}

export function andReply<Event, Reply>(
  effect: Effect<Event, Reply>,
  value: Reply,
): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "Reply", value });
}

export function andSnapshot<Event, Reply>(effect: Effect<Event, Reply>): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "Snapshot", andThen: { tag: "Done" } });
}

export function andStop<Event, Reply>(effect: Effect<Event, Reply>): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "Stop" });
}

export function andReplyDeferred<Event, Reply>(
  effect: Effect<Event, Reply>,
  deferred: DeferredReply<Reply>,
): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "ReplyDeferred", deferred });
}

export function andUnstash<Event, Reply>(effect: Effect<Event, Reply>): Effect<Event, Reply> {
  return appendToChain(effect, { tag: "Unstash", andThen: { tag: "Done" } });
}

// Check if an effect chain contains a Reply

export function hasReply<Event, Reply>(effect: Effect<Event, Reply>): boolean {
  switch (effect.tag) {
    case "Reply":
    case "ReplyDeferred":
      return true;
    case "Persist":
    case "Run":
    case "Snapshot":
    case "Unstash":
      return hasReply(effect.andThen);
    default:
      return false;
  }
}

// Extract all events from an effect chain

export function extractEvents<Event, Reply>(effect: Effect<Event, Reply>): Event[] {
  switch (effect.tag) {
    case "Persist":
      return [...effect.events, ...extractEvents(effect.andThen)];
    case "Run":
    case "Snapshot":
    case "Unstash":
      return extractEvents(effect.andThen);
    default:
      return [];
  }
}
