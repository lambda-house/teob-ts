// window.ts — retained/tiled fold state for windowed features.
//
// A feature like "sessions in the last 7 days" cannot be a running counter —
// the window has to forget. These types keep the contributing data in the
// view's own state, so the fold stays a pure function of the journal and the
// window is rebuildable like everything else. All state is plain JSON-safe
// data (times in epoch millis), so it survives objectCodec round-trips.
//
// Two rules make both types correct where a naive counter is not:
//
// - neither the window nor the hop is stored. They are supplied at every call,
//   so shortening or lengthening a window in code takes effect on the next
//   read rather than requiring a rebuild of state written under the old one
// - eviction happens on read as well as on write, against `now` rather than
//   the last event. A silent entity's window drains as time passes; anchoring
//   on the last update is the mistake that makes a dead entity look
//   permanently busy

// ---- EventWindow ----------------------------------------------------------

/** A single retained entry: when it happened and what it carried. */
export interface WindowEntry<A> {
  at: number;
  value: A;
}

/**
 * Retained, timestamped entries for windowed features.
 *
 * Use this where the aggregate needs the individual entries — durations
 * between transitions, share-of-time, distinct counts. For additive
 * aggregates over high-volume streams, {@link TileWindow} costs far less
 * memory.
 */
export interface EventWindow<A> {
  /** Newest first. */
  entries: WindowEntry<A>[];
}

function retainEntries<A>(
  candidates: WindowEntry<A>[],
  now: number,
  windowMs: number,
): WindowEntry<A>[] {
  const cutoff = now - windowMs;
  return candidates.filter((e) => e.at >= cutoff).sort((a, b) => b.at - a.at);
}

export const EventWindow = {
  empty<A>(): EventWindow<A> {
    return { entries: [] };
  },

  /** Record an entry and drop anything that fell out of the window as of `at`. */
  add<A>(w: EventWindow<A>, at: number, value: A, windowMs: number): EventWindow<A> {
    return { entries: retainEntries([{ at, value }, ...w.entries], at, windowMs) };
  },

  /** Entries still inside the window at `now`, newest first. */
  within<A>(w: EventWindow<A>, now: number, windowMs: number): WindowEntry<A>[] {
    return retainEntries(w.entries, now, windowMs);
  },

  values<A>(w: EventWindow<A>, now: number, windowMs: number): A[] {
    return retainEntries(w.entries, now, windowMs).map((e) => e.value);
  },

  size<A>(w: EventWindow<A>, now: number, windowMs: number): number {
    return retainEntries(w.entries, now, windowMs).length;
  },

  /**
   * Oldest retained entry at `now` — the start of the observed period, which
   * is not the window start until the window has actually filled. Reporting a
   * rate over an unfilled window without this reads as a dip.
   */
  oldest<A>(w: EventWindow<A>, now: number, windowMs: number): number | undefined {
    const live = retainEntries(w.entries, now, windowMs);
    return live.length > 0 ? live[live.length - 1].at : undefined;
  },
};

// ---- TileWindow -----------------------------------------------------------

/**
 * A hop-sized bucket holding the *intermediate representation* of an additive
 * aggregate.
 *
 * Storing `(count, sum, …)` rather than a finished average is the whole point:
 * the average of two averages is not the average of their union, so a tile
 * that stored only `mean` could not be merged with its neighbours. Keeping the
 * components makes every supported aggregate exactly recomputable from any set
 * of tiles.
 */
export interface Tile {
  count: number;
  sum: number;
  min: number;
  max: number;
  sumOfSquares: number;
}

export const Tile = {
  empty(): Tile {
    return { count: 0, sum: 0, min: Number.MAX_VALUE, max: -Number.MAX_VALUE, sumOfSquares: 0 };
  },

  add(t: Tile, value: number): Tile {
    return {
      count: t.count + 1,
      sum: t.sum + value,
      min: Math.min(t.min, value),
      max: Math.max(t.max, value),
      sumOfSquares: t.sumOfSquares + value * value,
    };
  },

  of(value: number): Tile {
    return Tile.add(Tile.empty(), value);
  },

  merge(a: Tile, b: Tile): Tile {
    return {
      count: a.count + b.count,
      sum: a.sum + b.sum,
      min: Math.min(a.min, b.min),
      max: Math.max(a.max, b.max),
      sumOfSquares: a.sumOfSquares + b.sumOfSquares,
    };
  },
};

/** The aggregate a window of tiles resolves to. */
export interface WindowedAggregate {
  count: number;
  sum: number;
  min: number | undefined;
  max: number | undefined;
  /** Population variance. */
  variance: number;
  mean: number | undefined;
  standardDeviation: number | undefined;
}

/**
 * Pre-aggregated windowed state for high-volume additive features.
 *
 * Where {@link EventWindow} retains every contributing entry, this retains one
 * bucket per hop — so a 30-day window at an hourly hop costs 720 small records
 * regardless of how many events landed in them (the technique commercial
 * feature stores call tiling).
 *
 * Sawtooth edge: the window's trailing edge advances in hop steps rather than
 * continuously — a tile is counted whole while any of it remains in the
 * window. A 7-day window at an hourly hop is therefore 7 days plus up to one
 * hour of overhang. Shrink the hop to tighten it; the imprecision is what buys
 * the bounded memory.
 */
export interface TileWindow {
  /** Keyed by the tile's start epoch-millis (as a string, for JSON safety). */
  tiles: Record<string, Tile>;
}

function retainTiles(
  tiles: Record<string, Tile>,
  now: number,
  hopMs: number,
  windowMs: number,
): Record<string, Tile> {
  const cutoff = now - windowMs;
  const kept: Record<string, Tile> = {};
  for (const [start, tile] of Object.entries(tiles)) {
    // A tile with any part still inside the window survives — the sawtooth edge.
    if (Number(start) + hopMs > cutoff) kept[start] = tile;
  }
  return kept;
}

export const TileWindow = {
  empty(): TileWindow {
    return { tiles: {} };
  },

  /**
   * Start of the hop bucket containing `at`. Tiles are keyed by this, not by
   * an index, so a changed hop leaves old buckets meaningful — they stay the
   * time ranges they always were.
   */
  tileStart(at: number, hopMs: number): number {
    if (hopMs <= 0) throw new Error("tile hop must be positive");
    return Math.floor(at / hopMs) * hopMs;
  },

  /** Add a value to its hop bucket, dropping buckets that fell out of the window as of `at`. */
  add(w: TileWindow, at: number, value: number, hopMs: number, windowMs: number): TileWindow {
    const start = String(TileWindow.tileStart(at, hopMs));
    const existing = w.tiles[start];
    const updated = {
      ...w.tiles,
      [start]: existing === undefined ? Tile.of(value) : Tile.add(existing, value),
    };
    return { tiles: retainTiles(updated, at, hopMs, windowMs) };
  },

  /** Merge every tile still in the window at `now`. */
  aggregate(w: TileWindow, now: number, hopMs: number, windowMs: number): WindowedAggregate {
    const live = Object.values(retainTiles(w.tiles, now, hopMs, windowMs));
    const merged = live.reduce(Tile.merge, Tile.empty());

    if (merged.count === 0) {
      return {
        count: 0, sum: 0, min: undefined, max: undefined,
        variance: 0, mean: undefined, standardDeviation: undefined,
      };
    }
    const mean = merged.sum / merged.count;
    // Population variance from the IR: E[x²] − E[x]², floored because rounding
    // can push it just below zero.
    const variance = Math.max(0, merged.sumOfSquares / merged.count - mean * mean);
    return {
      count: merged.count,
      sum: merged.sum,
      min: merged.min,
      max: merged.max,
      variance,
      mean,
      standardDeviation: Math.sqrt(variance),
    };
  },

  isEmpty(w: TileWindow): boolean {
    return Object.keys(w.tiles).length === 0;
  },
};
