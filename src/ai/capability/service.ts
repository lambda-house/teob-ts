import type {
  Capability,
  CapabilitySource,
  EvidenceRef,
} from "./types.js";
import { newCapability } from "./types.js";
import type { CapabilityStore } from "./store.js";
import type {
  CapabilityDecider,
  CapabilityDecision,
} from "./decider.js";
import { CapabilityOptics } from "./optics.js";
import { CapabilityImmutableError } from "./errors.js";

export interface CapabilityServiceOpts {
  store: CapabilityStore;
  decider: CapabilityDecider;
  similarLimit?: number;
  clock?: () => string;
}

export interface ProcessObservationArgs {
  scopeKey: string;
  content: string;
  source: CapabilitySource;
}

export class CapabilityService {
  private readonly store: CapabilityStore;
  private readonly decider: CapabilityDecider;
  private readonly similarLimit: number;
  private readonly clock: () => string;

  constructor(opts: CapabilityServiceOpts) {
    this.store = opts.store;
    this.decider = opts.decider;
    this.similarLimit = opts.similarLimit ?? 5;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Decide what to do with a raw observation and apply the resulting
   * decision to the store. Returns the decision so callers can log/audit it.
   */
  async processObservation(args: ProcessObservationArgs): Promise<CapabilityDecision> {
    const now = this.clock();
    const similar = await this.store.findSimilar(args.content, args.scopeKey, this.similarLimit);
    const decision = await this.decider.decide({
      observation: args.content,
      similar,
      source: args.source,
      now,
    });

    switch (decision.kind) {
      case "add": {
        const created = newCapability({
          scopeKey: args.scopeKey,
          layer: decision.layer,
          content: decision.content,
          source: args.source,
          entities: decision.entities,
          name: decision.name,
          now,
        });
        await this.store.save(created);
        return decision;
      }
      case "strengthen": {
        await this.store.update(decision.targetId, CapabilityOptics.strengthen(decision.evidence, now));
        return decision;
      }
      case "revise": {
        try {
          await this.store.update(decision.targetId, CapabilityOptics.revise(decision.newContent, now));
        } catch (err) {
          if (err instanceof CapabilityImmutableError) {
            return { kind: "noop", reason: "target was human-authored; revise blocked" };
          }
          throw err;
        }
        return decision;
      }
      case "noop":
        return decision;
    }
  }
}

// re-export helpers for callers
export type { Capability, CapabilitySource, EvidenceRef };
