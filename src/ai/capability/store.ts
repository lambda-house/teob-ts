import type { Capability, CapabilityLayer, Maturity } from "./types.js";

export interface FindByScopeOpts {
  scopeKey: string;
  layer?: CapabilityLayer;
  maturity?: Maturity;
  includeRetired?: boolean;
}

export interface CapabilityStore {
  save(c: Capability): Promise<Capability>;
  get(id: string): Promise<Capability | undefined>;
  findSimilar(query: string, scopeKey: string, limit: number): Promise<Capability[]>;
  findByScope(opts: FindByScopeOpts): Promise<Capability[]>;
  /** Capabilities valid at the given timestamp (validFrom <= asOf < invalidAt). */
  findValid(scopeKey: string, asOf: string): Promise<Capability[]>;
  update(id: string, transform: (c: Capability) => Capability): Promise<Capability>;
  all(scopeKey: string): Promise<Capability[]>;
}
