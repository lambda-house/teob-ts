import { describe, it, expect } from "vitest";
import { tagCodec, objectCodec, upcast, codecWithUpcasts } from "../src/core/codec.js";

type TestEvent =
  | { tag: "Created"; name: string }
  | { tag: "Updated"; name: string; count: number }
  | { tag: "Deleted" };

type TestState = { id: string; count: number };

describe("tagCodec for sum types", () => {
  const codec = tagCodec<TestEvent>();

  it("should provide correct manifest", () => {
    expect(codec.manifest({ tag: "Created", name: "test" })).toBe("Created");
    expect(codec.manifest({ tag: "Updated", name: "test", count: 1 })).toBe("Updated");
    expect(codec.manifest({ tag: "Deleted" })).toBe("Deleted");
  });

  it("should encode to JSON-serializable object", () => {
    const result = codec.encode({ tag: "Created", name: "hello" });
    expect(result).toEqual({ tag: "Created", name: "hello" });
  });

  it("should decode from JSON with manifest", () => {
    const data = { tag: "Created", name: "world" };
    const result = codec.decode("Created", data);
    expect(result).toEqual({ tag: "Created", name: "world" });
  });

  it("should decode complex variant", () => {
    const data = { tag: "Updated", name: "item", count: 42 };
    const result = codec.decode("Updated", data);
    expect(result).toEqual({ tag: "Updated", name: "item", count: 42 });
  });

  it("should decode singleton variant", () => {
    const data = { tag: "Deleted" };
    const result = codec.decode("Deleted", data);
    expect(result).toEqual({ tag: "Deleted" });
  });
});

describe("objectCodec for product types", () => {
  const codec = objectCodec<TestState>("TestState");

  it("should provide constant manifest", () => {
    expect(codec.manifest({ id: "a", count: 1 })).toBe("TestState");
    expect(codec.manifest({ id: "b", count: 2 })).toBe("TestState");
  });

  it("should encode to JSON-serializable object", () => {
    const result = codec.encode({ id: "test", count: 42 });
    expect(result).toEqual({ id: "test", count: 42 });
  });

  it("should decode from JSON", () => {
    const data = { id: "entity", count: 100 };
    const result = codec.decode("TestState", data);
    expect(result).toEqual({ id: "entity", count: 100 });
  });
});

// --- Event Upcasting ---

type EventV3 =
  | { tag: "OrderPlaced"; total: number; currency: string; region: string }
  | { tag: "OrderCancelled" };

describe("upcast", () => {
  it("creates an upcast definition", () => {
    const u = upcast("OrderPlaced", "OrderPlaced", (data: unknown) => {
      const d = data as any;
      return { ...d, currency: d.currency ?? "USD" };
    });
    expect(u.sourceManifest).toBe("OrderPlaced");
    expect(u.targetManifest).toBe("OrderPlaced");
    expect(u.transform({ tag: "OrderPlaced", total: 100 })).toEqual({
      tag: "OrderPlaced", total: 100, currency: "USD",
    });
  });
});

describe("codecWithUpcasts", () => {
  const base = tagCodec<EventV3>("OrderPlaced", "OrderCancelled");

  it("passes through current version events unchanged", () => {
    const codec = codecWithUpcasts(base, [
      upcast("OrderPlaced", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, currency: o.currency ?? "USD" };
      }),
    ]);
    const data = { tag: "OrderPlaced", total: 50, currency: "EUR", region: "EU" };
    const result = codec.decode("OrderPlaced", data);
    // currency is already present, so transform sets it to existing value
    expect(result).toEqual({ tag: "OrderPlaced", total: 50, currency: "EUR", region: "EU" });
  });

  it("applies single upcast for old event", () => {
    const codec = codecWithUpcasts(base, [
      upcast("OrderPlaced", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, currency: o.currency ?? "USD", region: o.region ?? "US" };
      }),
    ]);
    // V1 event missing currency and region
    const result = codec.decode("OrderPlaced", { tag: "OrderPlaced", total: 100 });
    expect(result).toEqual({ tag: "OrderPlaced", total: 100, currency: "USD", region: "US" });
  });

  it("chains multiple upcasts V1 → V2 → V3", () => {
    const codec = codecWithUpcasts(base, [
      // V1 → V2: add currency
      upcast("OrderPlacedV1", "OrderPlacedV2", (d: unknown) => {
        const o = d as any;
        return { ...o, tag: "OrderPlaced", currency: "USD" };
      }),
      // V2 → V3: add region
      upcast("OrderPlacedV2", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, region: o.region ?? "US" };
      }),
    ]);
    // Old V1 event
    const result = codec.decode("OrderPlacedV1", { tag: "OrderPlacedV1", total: 42 });
    expect(result).toEqual({ tag: "OrderPlaced", total: 42, currency: "USD", region: "US" });
  });

  it("does not apply upcasts to unrelated manifests", () => {
    const codec = codecWithUpcasts(base, [
      upcast("OrderPlaced", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, currency: "USD" };
      }),
    ]);
    const result = codec.decode("OrderCancelled", { tag: "OrderCancelled" });
    expect(result).toEqual({ tag: "OrderCancelled" });
  });

  it("preserves manifests from base codec", () => {
    const codec = codecWithUpcasts(base, []);
    expect(codec.manifests).toEqual(["OrderPlaced", "OrderCancelled"]);
  });

  it("preserves manifests as undefined when base has none", () => {
    const noManifests = tagCodec<EventV3>();
    const codec = codecWithUpcasts(noManifests, []);
    expect(codec.manifests).toBeUndefined();
  });

  it("delegates manifest and encode to base codec", () => {
    const codec = codecWithUpcasts(base, []);
    const event: EventV3 = { tag: "OrderPlaced", total: 10, currency: "USD", region: "US" };
    expect(codec.manifest(event)).toBe("OrderPlaced");
    expect(codec.encode(event)).toEqual(event);
  });

  it("handles in-place upcast (same source and target manifest)", () => {
    const codec = codecWithUpcasts(base, [
      upcast("OrderPlaced", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, currency: o.currency ?? "USD", region: o.region ?? "US" };
      }),
    ]);
    const result = codec.decode("OrderPlaced", { tag: "OrderPlaced", total: 75 });
    expect(result).toEqual({ tag: "OrderPlaced", total: 75, currency: "USD", region: "US" });
  });

  it("applies only matching upcasts in a chain with mixed manifests", () => {
    const codec = codecWithUpcasts(base, [
      upcast("OrderPlacedV1", "OrderPlaced", (d: unknown) => {
        const o = d as any;
        return { ...o, tag: "OrderPlaced", currency: "USD", region: "US" };
      }),
      upcast("OrderCancelledV1", "OrderCancelled", (d: unknown) => {
        const o = d as any;
        return { ...o, tag: "OrderCancelled" };
      }),
    ]);
    const placed = codec.decode("OrderPlacedV1", { tag: "OrderPlacedV1", total: 10 });
    expect(placed).toEqual({ tag: "OrderPlaced", total: 10, currency: "USD", region: "US" });

    const cancelled = codec.decode("OrderCancelledV1", { tag: "OrderCancelledV1", reason: "changed mind" });
    expect(cancelled).toEqual({ tag: "OrderCancelled", reason: "changed mind" });
  });

  it("works with objectCodec as base", () => {
    type StateV2 = { id: string; count: number; active: boolean };
    const base = objectCodec<StateV2>("MyState");
    const codec = codecWithUpcasts(base, [
      upcast("MyState", "MyState", (d: unknown) => {
        const o = d as any;
        return { ...o, active: o.active ?? true };
      }),
    ]);
    const result = codec.decode("MyState", { id: "x", count: 5 });
    expect(result).toEqual({ id: "x", count: 5, active: true });
  });

  it("empty upcast chain behaves like base codec", () => {
    const codec = codecWithUpcasts(base, []);
    const data = { tag: "OrderPlaced", total: 10, currency: "EUR", region: "DE" };
    expect(codec.decode("OrderPlaced", data)).toEqual(data);
  });
});
