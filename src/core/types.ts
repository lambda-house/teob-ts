// Branded types — nominal typing to prevent accidental mixing of IDs

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<string, "EntityId">;
export type CategoryId = Brand<string, "CategoryId">;
export type TimerId = Brand<string, "TimerId">;
export type SequenceNr = Brand<number, "SequenceNr">;

export const EntityId = (value: string): EntityId => value as EntityId;
export const CategoryId = (value: string): CategoryId => value as CategoryId;
export const TimerId = (value: string): TimerId => value as TimerId;
export const SequenceNr = (value: number): SequenceNr => value as SequenceNr;

export const nextSequenceNr = (s: SequenceNr): SequenceNr => SequenceNr(s + 1);

export type PersistenceId = { categoryId: CategoryId; entityId: EntityId };
