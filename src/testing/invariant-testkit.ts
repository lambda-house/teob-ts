/**
 * InvariantTestKit — property-based testing for aggregates.
 *
 * Generates random command sequences via fast-check, applies them to an
 * aggregate, and asserts that all invariants hold after every step.
 *
 * Requires `fast-check` as a peer/dev dependency.
 */

import * as fc from "fast-check";
import type { Aggregate } from "../core/aggregate.js";
import type { Invariant } from "../core/aggregate.js";
import type { EntityId } from "../core/types.js";
import { checkInvariants, type InvariantViolation } from "../core/invariant.js";
import { commandResultFromEffect, createMockControl } from "./aggregate-testkit.js";

export interface TraceStep<State, Event, Command> {
  command: Command;
  stateBefore: State;
  events: Event[];
  stateAfter: State;
  violations: InvariantViolation[];
}

export interface RunTrace<State, Event, Command> {
  aggregateId: string;
  steps: TraceStep<State, Event, Command>[];
  initialViolations: InvariantViolation[];
  totalViolations: number;
}

export interface RunCommandSequenceOpts<Cmd, R, S, E> {
  aggregate: Aggregate<Cmd, R, E, S>;
  aggregateId: string;
  commands: Cmd[];
  invariants?: Array<Invariant<S>>;
}

/**
 * Apply a sequence of commands to an aggregate, recording every step's
 * state, emitted events, and invariant violations.
 */
export async function runCommandSequence<Cmd, R, S, E>(
  opts: RunCommandSequenceOpts<Cmd, R, S, E>,
): Promise<RunTrace<S, E, Cmd>> {
  const invariants = opts.invariants ?? opts.aggregate.invariants ?? [];
  const entityId = opts.aggregateId as EntityId;
  let state = opts.aggregate.initial(entityId);
  const initialViolations = checkInvariants(invariants, state, opts.aggregateId, 0);
  let totalViolations = initialViolations.length;
  const steps: TraceStep<S, E, Cmd>[] = [];
  let seq = 0;
  for (const command of opts.commands) {
    const stateBefore = state;
    const { ctx } = createMockControl<Cmd, R>(entityId, opts.aggregate.category);
    const effect = await opts.aggregate.decide(state, command, ctx);
    const result = commandResultFromEffect(effect);
    for (const event of result.events) {
      seq += 1;
      state = opts.aggregate.apply(state, event);
    }
    const stepViolations = checkInvariants(invariants, state, opts.aggregateId, seq);
    totalViolations += stepViolations.length;
    steps.push({
      command,
      stateBefore,
      events: result.events,
      stateAfter: state,
      violations: stepViolations,
    });
  }
  return {
    aggregateId: opts.aggregateId,
    steps,
    initialViolations,
    totalViolations,
  };
}

export interface InvariantPropertyOpts<Cmd, R, S, E> {
  aggregate: Aggregate<Cmd, R, E, S>;
  commandArb: fc.Arbitrary<Cmd>;
  invariants: Array<Invariant<S>>;
  maxCommands?: number;
  aggregateIdArb?: fc.Arbitrary<string>;
}

/**
 * Build a fast-check async property that asserts no invariant violation occurs
 * across a randomly-generated command sequence.
 */
export function invariantProperty<Cmd, R, S, E>(
  opts: InvariantPropertyOpts<Cmd, R, S, E>,
): fc.IAsyncPropertyWithHooks<[string, Cmd[]]> {
  const max = opts.maxCommands ?? 100;
  const idArb = opts.aggregateIdArb ?? fc.string({ minLength: 1, maxLength: 16 });
  const cmdsArb = fc.array(opts.commandArb, { minLength: 0, maxLength: max });
  return fc.asyncProperty(idArb, cmdsArb, async (aggregateId, commands) => {
    const trace = await runCommandSequence({
      aggregate: opts.aggregate,
      aggregateId,
      commands,
      invariants: opts.invariants,
    });
    if (trace.totalViolations > 0) {
      throw new Error(formatViolation(trace));
    }
  });
}

export interface AssertInvariantsOpts<Cmd, R, S, E> extends InvariantPropertyOpts<Cmd, R, S, E> {
  numRuns?: number;
  seed?: number;
}

/**
 * Run the invariant property under fast-check and throw on violation.
 *
 * Convenience wrapper for use inside a vitest/jest `test()` body.
 */
export async function assertInvariants<Cmd, R, S, E>(
  opts: AssertInvariantsOpts<Cmd, R, S, E>,
): Promise<void> {
  await fc.assert(invariantProperty(opts), {
    numRuns: opts.numRuns ?? 100,
    seed: opts.seed,
  });
}

function formatViolation<S, E, Cmd>(trace: RunTrace<S, E, Cmd>): string {
  const lines: string[] = [];
  lines.push(`Invariant violation in run on aggregate "${trace.aggregateId}"`);
  if (trace.initialViolations.length > 0) {
    lines.push("Initial state violations:");
    for (const v of trace.initialViolations) {
      lines.push(`  ${v.name}: ${v.stateSnippet}`);
    }
  }
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    if (step.violations.length === 0) continue;
    lines.push("");
    lines.push(`Step ${i + 1} command: ${safeJson(step.command)}`);
    lines.push(`  before: ${safeJson(step.stateBefore)}`);
    lines.push(`  events: ${safeJson(step.events)}`);
    lines.push(`  after:  ${safeJson(step.stateAfter)}`);
    for (const v of step.violations) {
      lines.push(`  ✗ ${v.name} @ seq ${v.sequenceNr}`);
    }
  }
  return lines.join("\n");
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
