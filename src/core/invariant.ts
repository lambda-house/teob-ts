import type { Invariant } from "./aggregate.js";

export type { Invariant } from "./aggregate.js";

/**
 * A single invariant violation, captured during replay or test runs.
 *
 * `aggregateId` and `sequenceNr` identify *where* in the event stream the
 * violation appeared; `stateSnippet` is a truncated JSON dump of the state
 * after the offending event was applied.
 */
export interface InvariantViolation {
  name: string;
  aggregateId: string;
  sequenceNr: number;
  stateSnippet: string;
}

const SNIPPET_MAX = 200;

function snippetOf(state: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(state);
  } catch {
    s = String(state);
  }
  if (s.length <= SNIPPET_MAX) return s;
  return s.slice(0, SNIPPET_MAX - 3) + "...";
}

/**
 * Evaluate every invariant against the given state and return any failures.
 * Pure, synchronous.
 */
export function checkInvariants<S>(
  invariants: Array<Invariant<S>>,
  state: S,
  aggregateId: string,
  sequenceNr: number,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const inv of invariants) {
    let ok: boolean;
    try {
      ok = inv.check(state);
    } catch {
      ok = false;
    }
    if (!ok) {
      out.push({
        name: inv.name,
        aggregateId,
        sequenceNr,
        stateSnippet: snippetOf(state),
      });
    }
  }
  return out;
}
