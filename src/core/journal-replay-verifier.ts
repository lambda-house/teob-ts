import type { Aggregate } from "./aggregate.js";
import type { EntityId } from "./types.js";
import type { ReadJournal } from "./journal.js";
import { checkInvariants, type InvariantViolation as RichInvariantViolation } from "./invariant.js";
import type { Invariant } from "./aggregate.js";

// --------------------------------------------------------------------------
// Legacy shape (synchronous, kept for back-compat with existing callers).
// --------------------------------------------------------------------------

export interface ReplayResult {
  entityId: string;
  eventsReplayed: number;
  violations: InvariantViolation[];
}

export interface InvariantViolation {
  invariantName: string;
  afterEvent: number;
  eventDescription: string;
}

/**
 * Replay events through an aggregate and check invariants after each event.
 * Useful for verifying that a journal's event history satisfies all invariants.
 */
export function replayAndVerify<Command, Reply, Event, State>(
  aggregate: Aggregate<Command, Reply, Event, State>,
  entityId: EntityId,
  events: Event[],
): ReplayResult {
  const invariants = aggregate.invariants ?? [];
  const violations: InvariantViolation[] = [];

  let state = aggregate.initial(entityId);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    state = aggregate.apply(state, event);

    for (const inv of invariants) {
      if (!inv.check(state)) {
        violations.push({
          invariantName: inv.name,
          afterEvent: i + 1,
          eventDescription: JSON.stringify(event),
        });
      }
    }
  }

  return {
    entityId,
    eventsReplayed: events.length,
    violations,
  };
}

// --------------------------------------------------------------------------
// Async ReadJournal-based verification (Plan 05 upgrade).
// --------------------------------------------------------------------------

export interface EntityVerification<State> {
  aggregateId: string;
  eventsProcessed: number;
  violations: RichInvariantViolation[];
  finalState: State;
  isValid: boolean;
}

export interface VerificationReport<State> {
  entities: EntityVerification<State>[];
  totalEvents: number;
  totalViolations: number;
  isValid: boolean;
  summary(): string;
}

export interface VerifyEntityOpts<PersistenceId, S, E, Ord> {
  journal: ReadJournal<PersistenceId, E, Ord>;
  aggregate: Aggregate<unknown, unknown, E, S>;
  aggregateId: PersistenceId;
  fromOrdinal: Ord;
  toOrdinal?: Ord;
  invariants?: Array<Invariant<S>>;
  /** How to extract a human-readable id from a PersistenceId. */
  formatId?: (id: PersistenceId) => string;
  /** How to extract a numeric sequence number from an ordinal. */
  ordinalToSeq?: (o: Ord) => number;
}

function defaultFormatId<PersistenceId>(id: PersistenceId): string {
  if (typeof id === "string") return id;
  if (id && typeof id === "object" && "entityId" in (id as object)) {
    return String((id as unknown as { entityId: unknown }).entityId);
  }
  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

function defaultOrdinalToSeq<Ord>(o: Ord): number {
  if (typeof o === "number") return o;
  if (typeof o === "bigint") return Number(o);
  const n = Number(o);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Verify a single entity's full event history.
 *
 * Streams events from the read journal and applies each one through the
 * aggregate, checking all invariants after every event. Stops at `toOrdinal`
 * if provided.
 */
export async function verifyEntity<PersistenceId, S, E, Ord>(
  opts: VerifyEntityOpts<PersistenceId, S, E, Ord>,
): Promise<EntityVerification<S>> {
  const formatId = opts.formatId ?? defaultFormatId;
  const ordinalToSeq = opts.ordinalToSeq ?? defaultOrdinalToSeq;
  const invariants = opts.invariants ?? opts.aggregate.invariants ?? [];

  const aggregateId = formatId(opts.aggregateId);
  const initialIdParam = (typeof opts.aggregateId === "string"
    ? opts.aggregateId
    : aggregateId) as unknown as EntityId;

  let state = opts.aggregate.initial(initialIdParam);
  let eventsProcessed = 0;
  const violations: RichInvariantViolation[] = [];

  for await (const [event, ord] of opts.journal.events(
    opts.aggregateId,
    opts.fromOrdinal,
    opts.toOrdinal,
  )) {
    state = opts.aggregate.apply(state, event);
    eventsProcessed += 1;
    const seq = ordinalToSeq(ord);
    const stepViolations = checkInvariants(invariants, state, aggregateId, seq);
    if (stepViolations.length > 0) violations.push(...stepViolations);
  }

  return {
    aggregateId,
    eventsProcessed,
    violations,
    finalState: state,
    isValid: violations.length === 0,
  };
}

export interface VerifyAllOpts<PersistenceId, S, E, Ord> {
  journal: ReadJournal<PersistenceId, E, Ord>;
  aggregate: Aggregate<unknown, unknown, E, S>;
  invariants?: Array<Invariant<S>>;
  fromOrdinal: Ord;
  formatId?: (id: PersistenceId) => string;
  ordinalToSeq?: (o: Ord) => number;
}

/**
 * Verify every entity in the journal. Streams persistence ids and verifies
 * each in turn.
 */
export async function verifyAll<PersistenceId, S, E, Ord>(
  opts: VerifyAllOpts<PersistenceId, S, E, Ord>,
): Promise<VerificationReport<S>> {
  const entities: EntityVerification<S>[] = [];
  let totalEvents = 0;
  let totalViolations = 0;

  for await (const id of opts.journal.fetchIds()) {
    const v = await verifyEntity({
      journal: opts.journal,
      aggregate: opts.aggregate,
      aggregateId: id,
      fromOrdinal: opts.fromOrdinal,
      invariants: opts.invariants,
      formatId: opts.formatId,
      ordinalToSeq: opts.ordinalToSeq,
    });
    entities.push(v);
    totalEvents += v.eventsProcessed;
    totalViolations += v.violations.length;
  }

  return {
    entities,
    totalEvents,
    totalViolations,
    isValid: totalViolations === 0,
    summary() {
      return formatReport(entities, totalEvents, totalViolations);
    },
  };
}

function formatReport<S>(
  entities: EntityVerification<S>[],
  totalEvents: number,
  totalViolations: number,
): string {
  const lines: string[] = [];
  lines.push(
    `Verification report: ${entities.length} entities, ${totalEvents} events, ${totalViolations} violations`,
  );
  lines.push("");
  let cleanCount = 0;
  for (const e of entities) {
    if (e.isValid) {
      cleanCount += 1;
      continue;
    }
    lines.push(`  ${e.aggregateId} (${e.eventsProcessed} events): ✗`);
    for (const v of e.violations) {
      lines.push(`    seq ${v.sequenceNr}: ${v.name} — state: ${v.stateSnippet}`);
    }
  }
  if (cleanCount > 0) {
    lines.push(`  ${cleanCount} other entities: ✓`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Convenience overload that accepts an iterable of events directly. Useful
// for bridging from synchronous in-memory journals (`Journal.allEvents`).
// --------------------------------------------------------------------------

export interface VerifyEventStreamOpts<S, E> {
  aggregate: Aggregate<unknown, unknown, E, S>;
  aggregateId: string;
  events: Iterable<E> | AsyncIterable<E>;
  invariants?: Array<Invariant<S>>;
}

export async function verifyEventStream<S, E>(
  opts: VerifyEventStreamOpts<S, E>,
): Promise<EntityVerification<S>> {
  const invariants = opts.invariants ?? opts.aggregate.invariants ?? [];
  let state = opts.aggregate.initial(opts.aggregateId as EntityId);
  let n = 0;
  const violations: RichInvariantViolation[] = [];
  const iter: AsyncIterable<E> = isAsyncIterable(opts.events)
    ? opts.events
    : toAsyncIterable(opts.events);
  for await (const event of iter) {
    state = opts.aggregate.apply(state, event);
    n += 1;
    const stepViolations = checkInvariants(invariants, state, opts.aggregateId, n);
    if (stepViolations.length > 0) violations.push(...stepViolations);
  }
  return {
    aggregateId: opts.aggregateId,
    eventsProcessed: n,
    violations,
    finalState: state,
    isValid: violations.length === 0,
  };
}

function isAsyncIterable<E>(x: Iterable<E> | AsyncIterable<E>): x is AsyncIterable<E> {
  return typeof (x as AsyncIterable<E>)[Symbol.asyncIterator] === "function";
}

async function* toAsyncIterable<E>(it: Iterable<E>): AsyncIterable<E> {
  for (const x of it) yield x;
}
