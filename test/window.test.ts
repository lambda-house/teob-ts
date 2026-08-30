import { describe, it, expect } from "vitest";
import { EventWindow, Tile, TileWindow } from "../src/core/window.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("EventWindow", () => {
  it("retains entries inside the window, newest first", () => {
    let w = EventWindow.empty<string>();
    w = EventWindow.add(w, 1000, "a", HOUR);
    w = EventWindow.add(w, 2000, "b", HOUR);
    w = EventWindow.add(w, 3000, "c", HOUR);
    expect(EventWindow.values(w, 3000, HOUR)).toEqual(["c", "b", "a"]);
    expect(EventWindow.size(w, 3000, HOUR)).toBe(3);
  });

  it("evicts on add against the event time", () => {
    let w = EventWindow.empty<number>();
    w = EventWindow.add(w, 0, 1, 10 * MIN);
    w = EventWindow.add(w, 11 * MIN, 2, 10 * MIN);
    expect(w.entries.map((e) => e.value)).toEqual([2]);
  });

  it("evicts on read against now, not the last event — a dead entity drains", () => {
    let w = EventWindow.empty<number>();
    w = EventWindow.add(w, 0, 1, 10 * MIN);
    w = EventWindow.add(w, MIN, 2, 10 * MIN);
    // Nothing new for 20 minutes: the window must read as empty.
    expect(EventWindow.size(w, 21 * MIN, 10 * MIN)).toBe(0);
    expect(EventWindow.values(w, 21 * MIN, 10 * MIN)).toEqual([]);
  });

  it("does not store the window — shrinking it takes effect on the next read", () => {
    let w = EventWindow.empty<number>();
    w = EventWindow.add(w, 0, 1, DAY);
    w = EventWindow.add(w, 2 * HOUR, 2, DAY);
    expect(EventWindow.size(w, 2 * HOUR, DAY)).toBe(2);
    // Same state, read with a 1-hour window.
    expect(EventWindow.values(w, 2 * HOUR, HOUR)).toEqual([2]);
  });

  it("oldest reports the observed-period start, present only while entries remain", () => {
    let w = EventWindow.empty<number>();
    expect(EventWindow.oldest(w, 0, HOUR)).toBeUndefined();
    w = EventWindow.add(w, 5 * MIN, 1, HOUR);
    w = EventWindow.add(w, 20 * MIN, 2, HOUR);
    expect(EventWindow.oldest(w, 30 * MIN, HOUR)).toBe(5 * MIN);
    // The first entry falls out; observed period now starts at the second.
    expect(EventWindow.oldest(w, 70 * MIN, HOUR)).toBe(20 * MIN);
  });

  it("keeps the boundary entry exactly at the cutoff", () => {
    let w = EventWindow.empty<number>();
    w = EventWindow.add(w, 0, 1, 10 * MIN);
    // at cutoff (now - window == entry.at) the entry is retained
    expect(EventWindow.size(w, 10 * MIN, 10 * MIN)).toBe(1);
    expect(EventWindow.size(w, 10 * MIN + 1, 10 * MIN)).toBe(0);
  });
});

describe("Tile", () => {
  it("keeps an exactly mergeable intermediate representation", () => {
    const left = [1, 2, 3].reduce(Tile.add, Tile.empty());
    const right = [4, 5].reduce(Tile.add, Tile.empty());
    const whole = [1, 2, 3, 4, 5].reduce(Tile.add, Tile.empty());
    expect(Tile.merge(left, right)).toEqual(whole);
  });
});

describe("TileWindow", () => {
  it("buckets values by hop and aggregates exactly", () => {
    let w = TileWindow.empty();
    w = TileWindow.add(w, 10 * MIN, 10, HOUR, DAY);
    w = TileWindow.add(w, 20 * MIN, 20, HOUR, DAY);   // same hour bucket
    w = TileWindow.add(w, 90 * MIN, 30, HOUR, DAY);   // next hour bucket
    expect(Object.keys(w.tiles)).toHaveLength(2);

    const agg = TileWindow.aggregate(w, 2 * HOUR, HOUR, DAY);
    expect(agg.count).toBe(3);
    expect(agg.sum).toBe(60);
    expect(agg.min).toBe(10);
    expect(agg.max).toBe(30);
    expect(agg.mean).toBeCloseTo(20);
    // population variance of {10,20,30} = 200/3
    expect(agg.variance).toBeCloseTo(200 / 3);
    expect(agg.standardDeviation).toBeCloseTo(Math.sqrt(200 / 3));
  });

  it("returns an empty aggregate with undefined min/max/mean when nothing is live", () => {
    const agg = TileWindow.aggregate(TileWindow.empty(), 0, HOUR, DAY);
    expect(agg.count).toBe(0);
    expect(agg.min).toBeUndefined();
    expect(agg.max).toBeUndefined();
    expect(agg.mean).toBeUndefined();
    expect(agg.standardDeviation).toBeUndefined();
  });

  it("counts a tile whole while any part remains in the window (sawtooth edge)", () => {
    let w = TileWindow.empty();
    w = TileWindow.add(w, 0, 1, HOUR, 7 * DAY);
    // 7 days later the tile [0, 1h) still overlaps the window's trailing edge.
    const stillIn = TileWindow.aggregate(w, 7 * DAY + 30 * MIN, HOUR, 7 * DAY);
    expect(stillIn.count).toBe(1);
    // Once the whole tile has left (start + hop <= now - window) it is gone.
    const gone = TileWindow.aggregate(w, 7 * DAY + HOUR, HOUR, 7 * DAY);
    expect(gone.count).toBe(0);
  });

  it("evicts against now on read — a dead entity's aggregate drains", () => {
    let w = TileWindow.empty();
    w = TileWindow.add(w, 0, 5, HOUR, DAY);
    expect(TileWindow.aggregate(w, HOUR, HOUR, DAY).count).toBe(1);
    expect(TileWindow.aggregate(w, 2 * DAY, HOUR, DAY).count).toBe(0);
  });

  it("keys tiles by start instant so a changed hop leaves old buckets meaningful", () => {
    let w = TileWindow.empty();
    w = TileWindow.add(w, 90 * MIN, 7, HOUR, DAY); // hourly hop: bucket starts at 60min
    expect(Object.keys(w.tiles)).toEqual([String(HOUR)]);
    // Re-read the same state under a 30-min hop: the old bucket still covers
    // its original time range and stays in the window.
    const agg = TileWindow.aggregate(w, 2 * HOUR, 30 * MIN, DAY);
    expect(agg.count).toBe(1);
  });

  it("bounded memory: many events, one tile per hop", () => {
    let w = TileWindow.empty();
    for (let i = 0; i < 1000; i++) {
      w = TileWindow.add(w, i * 1000, i, HOUR, DAY); // 1000 s < 1 h
    }
    expect(Object.keys(w.tiles)).toHaveLength(1);
    expect(TileWindow.aggregate(w, 1000 * 1000, HOUR, DAY).count).toBe(1000);
  });

  it("survives a JSON round-trip (codec-safe state)", () => {
    let w = TileWindow.empty();
    w = TileWindow.add(w, 10 * MIN, 10, HOUR, DAY);
    const back = JSON.parse(JSON.stringify(w)) as typeof w;
    expect(TileWindow.aggregate(back, HOUR, HOUR, DAY)).toEqual(
      TileWindow.aggregate(w, HOUR, HOUR, DAY),
    );
  });

  it("rejects a non-positive hop", () => {
    expect(() => TileWindow.tileStart(0, 0)).toThrow("tile hop must be positive");
  });
});
