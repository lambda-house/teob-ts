import { describe, it, expect } from "vitest";
import {
  relativeRise,
  incrementWatcher,
  sustainedAbove,
  type Detector,
  type DetectorSample,
} from "../src/ha/detectors.js";
import { ulid } from "../src/core/ulid.js";

const sample = (at: number, value: number): DetectorSample => ({ at, value, obsId: ulid() });

/** Run a sequence, returning all emitted events and the final state. */
function run<S, T extends string>(d: Detector<S, T>, samples: DetectorSample[]) {
  let state = d.init();
  const events = [];
  for (const s of samples) {
    const r = d.step(state, s);
    state = r.state;
    events.push(...r.out);
  }
  return { state, events };
}

function deepFreeze<T>(obj: T): T {
  if (typeof obj === "object" && obj !== null) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

/** Tiny deterministic PRNG for property-style runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// relativeRise
// ---------------------------------------------------------------------------

describe("relativeRise", () => {
  const params = { baselineHalflifeMs: 60_000, risePct: 20, clearPct: 5, warmupMs: 10_000 };

  it("detects a rise vs the EWMA baseline and clears near it (happy path)", () => {
    const d = relativeRise(params);
    const { events } = run(d, [
      sample(0, 100),       // seed
      sample(5_000, 100),   // warmup
      sample(15_000, 100),  // warm, steady ⇒ ema 100
      sample(20_000, 130),  // 130 >= 100*1.2 ⇒ RiseDetected
      sample(25_000, 140),  // still risen ⇒ silent
      sample(30_000, 104),  // 104 <= 100*1.05 ⇒ RiseCleared
    ]);
    expect(events.map((e) => e.tag)).toEqual(["RiseDetected", "RiseCleared"]);
    expect(events[0]).toMatchObject({ at: 20_000, value: 130 });
    expect(events[1]).toMatchObject({ at: 30_000, value: 104 });
  });

  it("emits nothing during warmup even for a huge spike", () => {
    const d = relativeRise(params);
    const { events } = run(d, [sample(0, 100), sample(5_000, 10_000)]);
    expect(events).toEqual([]);
  });

  it("freezes the baseline while risen (steam must not poison it)", () => {
    const d = relativeRise(params);
    let state = d.init();
    for (const s of [sample(0, 100), sample(15_000, 100)]) state = d.step(state, s).state;
    const emaBefore = state.ema;

    // Rise, then hammer high values — the frozen ema must not move.
    let r = d.step(state, sample(20_000, 200));
    expect(r.out.map((e) => e.tag)).toEqual(["RiseDetected"]);
    state = r.state;
    for (const t of [21_000, 22_000, 23_000]) {
      r = d.step(state, sample(t, 500));
      expect(r.out).toEqual([]);
      state = r.state;
    }
    expect(state.ema).toBe(emaBefore);
    expect(state.phase).toBe("risen");

    // Clearing is still judged against the ORIGINAL baseline.
    r = d.step(state, sample(24_000, emaBefore! * 1.05));
    expect(r.out.map((e) => e.tag)).toEqual(["RiseCleared"]);
  });

  it("threshold boundaries are inclusive (>= rise, <= clear)", () => {
    const d = relativeRise(params);
    let state = d.init();
    for (const s of [sample(0, 100), sample(15_000, 100)]) state = d.step(state, s).state;
    // Exactly at the rise threshold fires.
    let r = d.step(state, sample(20_000, 120));
    expect(r.out.map((e) => e.tag)).toEqual(["RiseDetected"]);
    // Exactly at the clear threshold fires.
    r = d.step(r.state, sample(21_000, 105));
    expect(r.out.map((e) => e.tag)).toEqual(["RiseCleared"]);
  });

  it("default warmup is 10 minutes", () => {
    const d = relativeRise({ baselineHalflifeMs: 60_000, risePct: 20, clearPct: 5 });
    const { events } = run(d, [sample(0, 100), sample(599_999, 1_000)]);
    expect(events).toEqual([]);
    const r2 = run(d, [sample(0, 100), sample(600_000, 1_000)]);
    expect(r2.events.map((e) => e.tag)).toEqual(["RiseDetected"]);
  });
});

// ---------------------------------------------------------------------------
// incrementWatcher
// ---------------------------------------------------------------------------

describe("incrementWatcher", () => {
  const params = { minIncrement: 5, windowMs: 60_000 };

  it("emits the delta once the increment is reached within the window, then re-anchors", () => {
    const d = incrementWatcher(params);
    const { events } = run(d, [
      sample(0, 1_000),      // anchor
      sample(10_000, 1_002), // Δ2 ⇒ silent
      sample(20_000, 1_006), // Δ6 ⇒ IncrementDetected(6), re-anchor at 1006
      sample(30_000, 1_008), // Δ2 vs new anchor ⇒ silent
      sample(40_000, 1_011), // Δ5 ⇒ IncrementDetected(5)
    ]);
    expect(events.map((e) => [e.tag, e.value, e.at])).toEqual([
      ["IncrementDetected", 6, 20_000],
      ["IncrementDetected", 5, 40_000],
    ]);
  });

  it("re-anchors silently on counter reset", () => {
    const d = incrementWatcher(params);
    const { events, state } = run(d, [
      sample(0, 1_000),
      sample(10_000, 3), // reset (3 < 1000) ⇒ silent re-anchor
      sample(20_000, 9), // Δ6 vs anchor 3 ⇒ emit
    ]);
    expect(events.map((e) => [e.tag, e.value])).toEqual([["IncrementDetected", 6]]);
    expect(state).toEqual({ anchorAt: 20_000, anchorValue: 9 });
  });

  it("re-anchors silently on window expiry — a slow drip never fires", () => {
    const d = incrementWatcher(params);
    const { events } = run(d, [
      sample(0, 0),
      sample(70_000, 100),  // window expired ⇒ silent re-anchor, despite Δ100
      sample(80_000, 106),  // Δ6 within window ⇒ emit
    ]);
    expect(events.map((e) => [e.tag, e.value])).toEqual([["IncrementDetected", 6]]);
  });

  it("boundary: delta exactly at minIncrement fires; window boundary is inclusive", () => {
    const d = incrementWatcher(params);
    const { events } = run(d, [sample(0, 0), sample(60_000, 5)]);
    expect(events.map((e) => [e.tag, e.value])).toEqual([["IncrementDetected", 5]]);
  });
});

// ---------------------------------------------------------------------------
// sustainedAbove
// ---------------------------------------------------------------------------

describe("sustainedAbove", () => {
  const params = { threshold: 70, sustainMs: 300_000, clearBelow: 65 };

  it("confirms only on a later sample after sustainMs, clears below clearBelow", () => {
    const d = sustainedAbove(params);
    const { events } = run(d, [
      sample(0, 80),        // ⇒ pending, no output
      sample(100_000, 85),  // still pending
      sample(300_000, 90),  // 300s elapsed ⇒ ThresholdSustained
      sample(400_000, 66),  // >= clearBelow ⇒ still active
      sample(500_000, 60),  // < 65 ⇒ ThresholdCleared
    ]);
    expect(events.map((e) => [e.tag, e.at, e.value])).toEqual([
      ["ThresholdSustained", 300_000, 90],
      ["ThresholdCleared", 500_000, 60],
    ]);
  });

  it("confirmation happens only on the NEXT sample, even with sustainMs 0", () => {
    const d = sustainedAbove({ threshold: 70, sustainMs: 0 });
    let r = d.step(d.init(), sample(0, 99));
    expect(r.out).toEqual([]); // the triggering sample only arms pending
    r = d.step(r.state, sample(1, 99));
    expect(r.out.map((e) => e.tag)).toEqual(["ThresholdSustained"]);
  });

  it("a dip below threshold while pending resets the sustain clock", () => {
    const d = sustainedAbove(params);
    const { events, state } = run(d, [
      sample(0, 80),
      sample(100_000, 60),  // dip ⇒ idle
      sample(200_000, 80),  // pending again, new pendingSince
      sample(400_000, 80),  // only 200s since re-arm ⇒ nothing
    ]);
    expect(events).toEqual([]);
    expect(state).toEqual({ phase: "pending", pendingSince: 200_000 });
  });

  it("clearBelow defaults to threshold", () => {
    const d = sustainedAbove({ threshold: 70, sustainMs: 0 });
    const { events } = run(d, [sample(0, 80), sample(1_000, 80), sample(2_000, 69)]);
    expect(events.map((e) => e.tag)).toEqual(["ThresholdSustained", "ThresholdCleared"]);
  });
});

// ---------------------------------------------------------------------------
// property-style: purity, immutability, JSON-serializable state
// ---------------------------------------------------------------------------

describe("detector properties (purity + JSON round-trip)", () => {
  const detectors: Array<{ name: string; make: () => Detector<any, string> }> = [
    {
      name: "relativeRise",
      make: () =>
        relativeRise({ baselineHalflifeMs: 30_000, risePct: 15, clearPct: 3, warmupMs: 5_000 }),
    },
    { name: "incrementWatcher", make: () => incrementWatcher({ minIncrement: 3, windowMs: 20_000 }) },
    { name: "sustainedAbove", make: () => sustainedAbove({ threshold: 50, sustainMs: 10_000, clearBelow: 45 }) },
  ];

  for (const { name, make } of detectors) {
    it(`${name}: step is pure, never mutates state, and state survives JSON round-trip`, () => {
      const rnd = lcg(0xc0ffee ^ name.length);
      const d = make();
      let state = d.init();
      let at = 0;
      for (let i = 0; i < 300; i++) {
        at += Math.floor(rnd() * 5_000) + 1;
        const s: DetectorSample = { at, value: Math.floor(rnd() * 120), obsId: ulid() };

        deepFreeze(state); // any mutation would throw in strict mode
        const r1 = d.step(state, s);
        const r2 = d.step(state, s); // purity: same inputs ⇒ same outputs
        expect(r2).toEqual(r1);

        // JSON round-trip of the state is behavior-preserving.
        const revived = JSON.parse(JSON.stringify(state));
        const r3 = d.step(revived, s);
        expect(r3).toEqual(r1);

        state = r1.state;
      }
      // Final state itself is plain JSON data.
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    });
  }
});
