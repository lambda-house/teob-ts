import type {
  Capability,
  CapabilityLayer,
  EntityTag,
  EpistemicStatus,
  EvidenceRef,
  Maturity,
} from "./types.js";
import { CapabilityImmutableError } from "./errors.js";

export interface Lens<S, A> {
  get(s: S): A;
  replace(a: A, s: S): S;
  modify(f: (a: A) => A, s: S): S;
}

export function lens<S, A>(get: (s: S) => A, replace: (a: A, s: S) => S): Lens<S, A> {
  return {
    get,
    replace,
    modify: (f, s) => replace(f(get(s)), s),
  };
}

// Pre-built lenses
export const maturityL: Lens<Capability, Maturity> = lens(
  (c) => c.maturity,
  (m, c) => ({ ...c, maturity: m }),
);
export const contentL: Lens<Capability, string> = lens(
  (c) => c.content,
  (v, c) => ({ ...c, content: v }),
);
export const evidenceL: Lens<Capability, EvidenceRef[]> = lens(
  (c) => c.evidence,
  (v, c) => ({ ...c, evidence: v }),
);
export const updatedAtL: Lens<Capability, string> = lens(
  (c) => c.updatedAt,
  (v, c) => ({ ...c, updatedAt: v }),
);
export const invalidAtL: Lens<Capability, string | undefined> = lens(
  (c) => c.invalidAt,
  (v, c) => ({ ...c, invalidAt: v }),
);
export const confidenceL: Lens<Capability, number | undefined> = lens(
  (c) => c.confidence,
  (v, c) => ({ ...c, confidence: v }),
);
export const epistemicL: Lens<Capability, EpistemicStatus> = lens(
  (c) => c.epistemicStatus,
  (v, c) => ({ ...c, epistemicStatus: v }),
);
export const layerL: Lens<Capability, CapabilityLayer> = lens(
  (c) => c.layer,
  (v, c) => ({ ...c, layer: v }),
);
export const entitiesL: Lens<Capability, EntityTag[]> = lens(
  (c) => c.entities,
  (v, c) => ({ ...c, entities: v }),
);

// --- accumulator ops -----------------------------------------------------

const PROMOTE_THRESHOLDS: ReadonlyArray<{ from: Maturity; atCount: number; to: Maturity }> = [
  { from: "observed", atCount: 2, to: "recurring" },
  { from: "recurring", atCount: 4, to: "reliable" },
];

/**
 * Apply automatic maturity promotion based on number of evidence refs.
 * Foundational maturity is reachable only via explicit `promote` (human-driven).
 */
export function autoPromote(c: Capability): Capability {
  const count = c.evidence.length;
  for (const rule of PROMOTE_THRESHOLDS) {
    if (c.maturity === rule.from && count >= rule.atCount) {
      return { ...c, maturity: rule.to };
    }
  }
  return c;
}

export const CapabilityOptics = {
  /**
   * Append the given evidence ref, then auto-promote maturity, and touch
   * `updatedAt`. Idempotent in the sense that strengthening the same content
   * twice is meaningful — each call adds an evidence row.
   */
  strengthen(ref: EvidenceRef, now: string) {
    return (c: Capability): Capability => {
      const withEvidence: Capability = {
        ...c,
        evidence: [...c.evidence, ref],
        updatedAt: now,
      };
      return autoPromote(withEvidence);
    };
  },

  /**
   * Replace the content of a capability. Refuses if the source was
   * `human_authored` — those are considered immutable to agent updates.
   */
  revise(newContent: string, now: string) {
    return (c: Capability): Capability => {
      if (c.source.kind === "human_authored") {
        throw new CapabilityImmutableError(c.id);
      }
      return { ...c, content: newContent, updatedAt: now };
    };
  },

  /** Explicitly set maturity. Only path to `foundational`. */
  promote(to: Maturity, now: string) {
    return (c: Capability): Capability => ({ ...c, maturity: to, updatedAt: now });
  },

  /** Soft-delete: set invalidAt; record is preserved. */
  retire(now: string) {
    return (c: Capability): Capability => ({ ...c, invalidAt: now, updatedAt: now });
  },

  autoPromote,
};
