export type EpistemicStatus = "raw" | "observation" | "fact" | "opinion";

export type CapabilityLayer = "experience" | "pattern" | "principle" | "heuristic" | "procedure";

export type Maturity = "observed" | "recurring" | "reliable" | "foundational";

export type CapabilitySource =
  | { kind: "agent_observation"; agentId: string; roundId: string }
  | { kind: "human_authored"; author: string };

export interface EvidenceRef {
  roundId: string;
  summary: string;
  timestamp: string;
}

export interface EntityTag {
  key: string;
  value: string;
}

export interface Capability {
  id: string;
  scopeKey: string;
  name: string;
  layer: CapabilityLayer;
  maturity: Maturity;
  epistemicStatus: EpistemicStatus;
  confidence?: number;
  content: string;
  evidence: EvidenceRef[];
  validFrom: string;
  invalidAt?: string;
  source: CapabilitySource;
  entities: EntityTag[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const NAME_MAX = 80;

/**
 * Auto-derive a short label from `content` for the `name` field. Takes
 * the first sentence (split on `.`/`!`/`?`/`\n`) and truncates to NAME_MAX.
 */
export function deriveName(content: string): string {
  const trimmed = content.trim();
  const m = trimmed.match(/^[\s\S]+?[.!?\n]/);
  const first = (m ? m[0] : trimmed).replace(/[\s.!?]+$/, "");
  if (first.length <= NAME_MAX) return first;
  return first.slice(0, NAME_MAX - 1) + "…";
}

let idCounter = 0;
function shortId(): string {
  // 8 hex chars, opaque to consumers.
  const ts = Date.now().toString(16).slice(-4);
  const rnd = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  idCounter = (idCounter + 1) & 0xffff;
  // Use idCounter to avoid same-millisecond collisions.
  const counter = idCounter.toString(16).padStart(4, "0");
  return `${ts}${rnd}${counter}`.slice(0, 8);
}

export function generateCapabilityId(): string {
  return `cap-${shortId()}`;
}

export interface NewCapabilityInput {
  scopeKey: string;
  layer: CapabilityLayer;
  content: string;
  source: CapabilitySource;
  entities?: EntityTag[];
  metadata?: Record<string, unknown>;
  epistemicStatus?: EpistemicStatus;
  name?: string;
  now?: string;
  confidence?: number;
}

export function newCapability(input: NewCapabilityInput): Capability {
  const now = input.now ?? new Date().toISOString();
  return {
    id: generateCapabilityId(),
    scopeKey: input.scopeKey,
    name: input.name ?? deriveName(input.content),
    layer: input.layer,
    maturity: "observed",
    epistemicStatus: input.epistemicStatus ?? "raw",
    confidence: input.confidence,
    content: input.content,
    evidence: [],
    validFrom: now,
    invalidAt: undefined,
    source: input.source,
    entities: input.entities ?? [],
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}
