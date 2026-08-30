// envelope.ts — event metadata that rides beside the payload through persist.
// decide()/apply() never see or need the envelope: it is attached to event objects
// under a symbol (invisible to JSON.stringify and to structural typing).

import type { CategoryId, EntityId, SequenceNr } from "./types.js";

/** Well-known origin values; free-form strings allowed. */
export type Origin = "ha" | "resync" | "backfill" | "nodered" | "timer" | "user" | "system" | (string & {});

export interface EventEnvelope {
  /** ULID, unique per event, assigned at persist time if not stamped. */
  eventId: string;
  /** Id of the thing that caused this event: an obsId, a parent eventId, an HA context id. */
  causationId?: string;
  /** Episode/flow correlation id (saga/flow instance). */
  correlationId?: string;
  origin?: Origin;
  /** Envelope schema version. Always 1 in M0. */
  v: number;
}

export const ENVELOPE: unique symbol = Symbol.for("teob.envelope");

/**
 * Stamp envelope metadata onto an event object (non-enumerable symbol property).
 * Returns the same object. eventId/v are filled at persist time if omitted.
 */
export function stampEnvelope<E extends object>(
  event: E,
  meta: Partial<Omit<EventEnvelope, "v">> & { origin?: Origin },
): E {
  Object.defineProperty(event, ENVELOPE, {
    value: { ...meta },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return event;
}

/** Read a stamp (partial envelope) off an event, if present. */
export function envelopeStampOf(event: unknown): Partial<EventEnvelope> | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  return (event as Record<symbol, Partial<EventEnvelope> | undefined>)[ENVELOPE];
}

// ---- post-persist hook (emitted by the entity runner, consumed by app wiring) ----

export interface PersistedEventRecord {
  sequenceNr: SequenceNr;
  manifest: string;
  /** codec.encode(event) — JSON-safe payload as persisted. */
  encoded: unknown;
  envelope: EventEnvelope;
}

export interface PersistedBatch {
  category: CategoryId;
  entityId: EntityId;
  records: PersistedEventRecord[];
  /** ms epoch at persist time. */
  at: number;
}

export type OnPersisted = (batch: PersistedBatch) => void;

// ---- journal read-side query surface (implemented by sqlite journal;
//      consumed structurally by http/views.ts) ----

export interface JournalQueryRow {
  /** Global cursor — sqlite rowid. Strictly increasing in insert order. */
  globalSeq: number;
  category: string;
  entityId: string;
  sequenceNr: number;
  manifest: string;
  /** JSON.parse of the stored payload (no codec involved on the read side). */
  payload: unknown;
  /** Journal row timestamp, unix SECONDS (legacy column). */
  ts: number;
  envelope: EventEnvelope | null; // null for pre-migration rows
}

export interface JournalQuery {
  category?: string;
  entityId?: string;
  /** Exclusive global cursor: order=desc ⇒ rows with globalSeq < cursor; asc ⇒ >. */
  cursor?: number;
  /** Inclusive lower bound, ms epoch (converted to seconds internally). */
  sinceMs?: number;
  /** Rows whose envelope.causationId equals this value. */
  causationId?: string;
  correlationId?: string;
  /** Default 100, hard max 1000. */
  limit?: number;
  /** Default "desc" (timeline order). */
  order?: "asc" | "desc";
}

export interface JournalReader {
  queryEvents(q: JournalQuery): JournalQueryRow[];
  eventByEventId(eventId: string): JournalQueryRow | undefined;
  /**
   * Walk causationId parent links starting at eventId (the event itself first,
   * then its cause, then the cause's cause...). Stops at a missing parent or maxDepth.
   */
  causationChain(eventId: string, opts?: { maxDepth?: number }): JournalQueryRow[]; // default maxDepth 25
}
