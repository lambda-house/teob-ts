export class CapabilityImmutableError extends Error {
  readonly tag = "CapabilityImmutable" as const;
  constructor(public capabilityId: string) {
    super(`Capability ${capabilityId} is human-authored and cannot be revised`);
  }
}
