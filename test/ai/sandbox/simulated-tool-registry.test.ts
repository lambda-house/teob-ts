import { describe, it, expect } from "vitest";
import { SimulatedToolRegistry } from "../../../src/ai/sandbox/simulated-tool-registry.js";

describe("SimulatedToolRegistry", () => {
  it("dispatches to pure functions", async () => {
    const sims = new Map<string, (a: unknown) => unknown>([
      ["echo", (a) => ({ success: true, output: a })],
    ]);
    const reg = SimulatedToolRegistry.fromSimulations(sims as any);
    const r = await reg.execute({ name: "echo", arguments: { hi: 1 } });
    expect(r.success).toBe(true);
    expect(r.output).toEqual({ hi: 1 });
  });

  it("wraps thrown errors as failure", async () => {
    const sims = new Map<string, (a: unknown) => unknown>([
      [
        "boom",
        () => {
          throw new Error("kaboom");
        },
      ],
    ]);
    const reg = SimulatedToolRegistry.fromSimulations(sims as any);
    const r = await reg.execute({ name: "boom", arguments: {} });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Simulation error");
  });

  it("unknown tool fails gracefully", async () => {
    const reg = SimulatedToolRegistry.fromSimulations(new Map());
    const r = await reg.execute({ name: "absent", arguments: {} });
    expect(r.success).toBe(false);
    expect(r.error).toContain("not simulated");
  });
});
