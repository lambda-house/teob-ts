import type { Capability } from "./types.js";
import type { CapabilityStore, FindByScopeOpts } from "./store.js";

/**
 * Tokenize a string into a lowercase keyword set.
 *  - splits on non-word characters
 *  - drops tokens shorter than 3 chars
 *  - drops common English stop words
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "but",
  "not",
  "you",
  "your",
  "with",
  "this",
  "that",
  "from",
  "into",
  "have",
  "has",
  "had",
  "all",
  "any",
  "can",
  "will",
  "out",
  "over",
  "under",
]);

export function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pure helper exposed alongside the store: rank capabilities by content
 * similarity to the query, descending.
 */
export function rankBySimilarity(
  items: Capability[],
  query: string,
): Array<{ capability: Capability; score: number }> {
  const qTok = tokenize(query);
  const ranked = items.map((c) => ({ capability: c, score: jaccard(qTok, tokenize(c.content)) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export class InMemoryCapabilityStore implements CapabilityStore {
  private byId = new Map<string, Capability>();

  async save(c: Capability): Promise<Capability> {
    this.byId.set(c.id, c);
    return c;
  }

  async get(id: string): Promise<Capability | undefined> {
    return this.byId.get(id);
  }

  async findSimilar(query: string, scopeKey: string, limit: number): Promise<Capability[]> {
    const candidates = [...this.byId.values()].filter(
      (c) => c.scopeKey === scopeKey && c.invalidAt === undefined,
    );
    const ranked = rankBySimilarity(candidates, query);
    return ranked
      .filter((r) => r.score > 0)
      .slice(0, limit)
      .map((r) => r.capability);
  }

  async findByScope(opts: FindByScopeOpts): Promise<Capability[]> {
    return [...this.byId.values()].filter((c) => {
      if (c.scopeKey !== opts.scopeKey) return false;
      if (opts.layer && c.layer !== opts.layer) return false;
      if (opts.maturity && c.maturity !== opts.maturity) return false;
      if (!opts.includeRetired && c.invalidAt !== undefined) return false;
      return true;
    });
  }

  async findValid(scopeKey: string, asOf: string): Promise<Capability[]> {
    return [...this.byId.values()].filter((c) => {
      if (c.scopeKey !== scopeKey) return false;
      if (c.validFrom > asOf) return false;
      if (c.invalidAt !== undefined && c.invalidAt <= asOf) return false;
      return true;
    });
  }

  async update(id: string, transform: (c: Capability) => Capability): Promise<Capability> {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`Capability not found: ${id}`);
    const next = transform(cur);
    this.byId.set(id, next);
    return next;
  }

  async all(scopeKey: string): Promise<Capability[]> {
    return [...this.byId.values()].filter((c) => c.scopeKey === scopeKey);
  }
}
