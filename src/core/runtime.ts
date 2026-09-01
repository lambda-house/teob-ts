import type { EntityId, CategoryId, SequenceNr } from "./types.js";
import type { CategoryRegistration, Either, ReplyError } from "./effect-control.js";

// EntityRuntime — type-erased command dispatch

/** Metadata about the entity state before/after command processing. */
export interface AskMeta {
  /** The entity's sequence number after processing the command. */
  sequenceNr: SequenceNr;
  /** The entity's sequence number before processing the command. */
  preSequenceNr: SequenceNr;
}

/** Result of an ask: the reply plus optional metadata (sequence numbers for ETag support). */
export interface AskResult<R> {
  reply: R | undefined;
  /** Present when the runtime supports metadata (inmem, postgres, sqlite). */
  meta?: AskMeta;
}

export interface EntityRuntime {
  tell<C, R>(entityId: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<void>;
  ask<C, R>(
    entityId: EntityId,
    command: C,
    cat: CategoryRegistration<C, R>,
  ): Promise<Either<ReplyError, AskResult<R>>>;
  categories(): Set<CategoryId>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}
