import type { EntityId, CategoryId, TimerId } from "./types.js";

// Type-safe cross-entity communication registry
// Register category types to enable type-checked tell/ask

export interface CategoryRegistration<Command, Reply> {
  categoryId: CategoryId;
  _command?: Command; // phantom
  _reply?: Reply; // phantom
}

export function categoryTypes<Command, Reply>(
  categoryId: CategoryId,
): CategoryRegistration<Command, Reply> {
  return { categoryId };
}

export type ReplyError =
  | { tag: "Timeout" }
  | { tag: "CategoryNotFound"; categoryId: CategoryId }
  | { tag: "General"; message: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

// EffectControl — context available inside command handlers

export interface EffectControl<Command, Reply> {
  readonly entityId: EntityId;
  readonly categoryId: CategoryId;

  // Self-messaging
  tellSelf(command: Command): Promise<void>;

  // Cross-entity communication (type-safe via CategoryRegistration)
  tell<C, R>(id: EntityId, command: C, cat: CategoryRegistration<C, R>): Promise<void>;
  ask<C, R>(
    id: EntityId,
    command: C,
    cat: CategoryRegistration<C, R>,
  ): Promise<Either<ReplyError, R | undefined>>;

  // Timers
  scheduleOnce(timerId: TimerId, command: Command, delayMs: number): Promise<void>;
  schedulePeriodic(
    timerId: TimerId,
    command: Command,
    initialDelayMs: number,
    intervalMs: number,
  ): Promise<void>;
  cancelTimer(timerId: TimerId): Promise<void>;

  // Logging
  log(level: LogLevel, message: string): void;

  // External effects with callbacks
  sync<Success, Failure>(opts: {
    effect: () => Promise<Either<Failure, Success>>;
    onSuccess: (s: Success) => Command;
    onFailure: (f: Failure) => Command;
    onTimeout?: Command;
    timeoutMs?: number;
  }): Promise<void>;
}

export type Either<L, R> = { ok: true; value: R } | { ok: false; error: L };

export function right<L, R>(value: R): Either<L, R> {
  return { ok: true, value };
}

export function left<L, R>(error: L): Either<L, R> {
  return { ok: false, error };
}
