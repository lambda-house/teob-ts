import type {
  Capability,
  CapabilityLayer,
  CapabilitySource,
  EntityTag,
  EvidenceRef,
} from "./types.js";
import { tokenize, jaccard, rankBySimilarity } from "./in-memory-store.js";

export type CapabilityDecision =
  | {
      kind: "add";
      name: string;
      layer: CapabilityLayer;
      content: string;
      entities: EntityTag[];
    }
  | { kind: "strengthen"; targetId: string; evidence: EvidenceRef }
  | { kind: "revise"; targetId: string; newContent: string; reason: string }
  | { kind: "noop"; reason: string };

export interface DeciderInput {
  observation: string;
  similar: Capability[];
  source: CapabilitySource;
  now: string;
}

export interface CapabilityDecider {
  decide(input: DeciderInput): Promise<CapabilityDecision>;
}

export interface RuleBasedDeciderOpts {
  /** ≥ this similarity → strengthen the existing capability. Default 0.5. */
  strengthenThreshold?: number;
  /** > this and < strengthenThreshold → revise. Default 0.3. */
  reviseThreshold?: number;
  /** Default layer for new capabilities. */
  defaultLayer?: CapabilityLayer;
}

/**
 * Rule-based decider — no LLM dependency. Suitable for tests, demos, and
 * deployments where deterministic behaviour is preferred over a smarter LLM.
 */
export class RuleBasedDecider implements CapabilityDecider {
  private readonly strengthenThreshold: number;
  private readonly reviseThreshold: number;
  private readonly defaultLayer: CapabilityLayer;

  constructor(opts: RuleBasedDeciderOpts = {}) {
    this.strengthenThreshold = opts.strengthenThreshold ?? 0.5;
    this.reviseThreshold = opts.reviseThreshold ?? 0.3;
    this.defaultLayer = opts.defaultLayer ?? "experience";
  }

  async decide(input: DeciderInput): Promise<CapabilityDecision> {
    if (input.similar.length === 0) {
      return this.addDecision(input);
    }
    const ranked = rankBySimilarity(input.similar, input.observation);
    const top = ranked[0];
    if (!top || top.score === 0) {
      return this.addDecision(input);
    }
    if (top.score >= this.strengthenThreshold) {
      const ev: EvidenceRef = makeEvidence(input);
      // Immutable sources can't be revised, but they can be strengthened.
      return { kind: "strengthen", targetId: top.capability.id, evidence: ev };
    }
    if (top.score > this.reviseThreshold) {
      // Revise only if mutable.
      if (top.capability.source.kind === "human_authored") {
        return { kind: "noop", reason: "similar capability is human-authored; cannot revise" };
      }
      return {
        kind: "revise",
        targetId: top.capability.id,
        newContent: input.observation,
        reason: `similarity ${top.score.toFixed(2)} between ${this.reviseThreshold} and ${this.strengthenThreshold}`,
      };
    }
    return this.addDecision(input);
  }

  private addDecision(input: DeciderInput): CapabilityDecision {
    return {
      kind: "add",
      name: deriveShortName(input.observation),
      layer: this.defaultLayer,
      content: input.observation,
      entities: [],
    };
  }
}

function deriveShortName(content: string): string {
  // Same heuristic as types.deriveName, copied here to avoid import cycle for
  // testability.
  const trimmed = content.trim();
  const m = trimmed.match(/^[\s\S]+?[.!?\n]/);
  const first = (m ? m[0] : trimmed).replace(/[\s.!?]+$/, "");
  return first.length <= 80 ? first : first.slice(0, 79) + "…";
}

function makeEvidence(input: DeciderInput): EvidenceRef {
  const summary = input.observation.length <= 100
    ? input.observation
    : input.observation.slice(0, 97) + "...";
  const roundId =
    input.source.kind === "agent_observation"
      ? input.source.roundId
      : `human:${input.source.author}`;
  return { roundId, summary, timestamp: input.now };
}

// Export utilities used elsewhere.
export { tokenize, jaccard };
