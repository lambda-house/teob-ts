import type { CategoryId, EntityId, SequenceNr } from "../core/types.js";
import { SequenceNr as mkSeqNr } from "../core/types.js";
import type { Codec } from "../core/codec.js";
import type { Journal } from "../core/journal-store.js";
import type { EventEnvelope } from "../core/envelope.js";

export type { Journal } from "../core/journal-store.js";

// Stored event entry

interface StoredEvent {
  sequenceNr: SequenceNr;
  manifest: string;
  data: unknown;
  envelope?: EventEnvelope;
}

interface StoredSnapshot {
  sequenceNr: SequenceNr;
  manifest: string;
  data: unknown;
}

function persistenceKey(categoryId: CategoryId, entityId: EntityId): string {
  return `${categoryId}:${entityId}`;
}

// In-memory journal implementation

export function createInMemoryJournal(): Journal {
  const events = new Map<string, StoredEvent[]>();
  const snapshots = new Map<string, StoredSnapshot>();

  return {
    persistEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      newEvents: E[],
      startSequenceNr: SequenceNr,
      codec: Codec<E>,
      envelopes?: EventEnvelope[],
    ): SequenceNr {
      if (newEvents.length === 0) return startSequenceNr;

      const key = persistenceKey(categoryId, entityId);
      const existing = events.get(key) ?? [];

      const stored = newEvents.map((event, idx): StoredEvent => ({
        sequenceNr: mkSeqNr(startSequenceNr + idx + 1),
        manifest: codec.manifest(event),
        data: codec.encode(event),
        ...(envelopes?.[idx] !== undefined && { envelope: envelopes[idx] }),
      }));

      events.set(key, [...existing, ...stored]);
      return mkSeqNr(startSequenceNr + newEvents.length);
    },

    loadEvents<E>(
      categoryId: CategoryId,
      entityId: EntityId,
      fromSequenceNr: SequenceNr,
      codec: Codec<E>,
    ): Array<{ sequenceNr: SequenceNr; event: E }> {
      const key = persistenceKey(categoryId, entityId);
      const stored = events.get(key) ?? [];
      return stored
        .filter((e) => e.sequenceNr > fromSequenceNr)
        .map((e) => ({
          sequenceNr: e.sequenceNr,
          event: codec.decode(e.manifest, e.data),
        }));
    },

    persistSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      state: S,
      sequenceNr: SequenceNr,
      codec: Codec<S>,
    ): void {
      const key = persistenceKey(categoryId, entityId);
      snapshots.set(key, {
        sequenceNr,
        manifest: codec.manifest(state),
        data: codec.encode(state),
      });
    },

    loadSnapshot<S>(
      categoryId: CategoryId,
      entityId: EntityId,
      codec: Codec<S>,
    ): { sequenceNr: SequenceNr; state: S } | undefined {
      const key = persistenceKey(categoryId, entityId);
      const snap = snapshots.get(key);
      if (!snap) return undefined;
      return {
        sequenceNr: snap.sequenceNr,
        state: codec.decode(snap.manifest, snap.data),
      };
    },

    allEvents<E>(
      categoryId: CategoryId,
      codec: Codec<E>,
    ): Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> {
      const result: Array<{ entityId: EntityId; sequenceNr: SequenceNr; event: E }> = [];
      const prefix = `${categoryId}:`;
      for (const [key, stored] of events) {
        if (!key.startsWith(prefix)) continue;
        const entityId = key.slice(prefix.length) as EntityId;
        for (const e of stored) {
          result.push({
            entityId,
            sequenceNr: e.sequenceNr,
            event: codec.decode(e.manifest, e.data),
          });
        }
      }
      return result;
    },
  };
}
