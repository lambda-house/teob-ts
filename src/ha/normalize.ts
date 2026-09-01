// ha/normalize.ts — pure mapping from an HA entity state to a typed scalar.

import type { HaEntityState } from "./types.js";
import type { NormalizedValue } from "./signal-store.js";

const NULL_STATES = new Set(["unavailable", "unknown", "none", ""]);

const TRUE_STATES = new Set(["on", "open", "detected", "home", "wet", "locked", "true"]);
const FALSE_STATES = new Set([
  "off",
  "closed",
  "clear",
  "not_home",
  "away",
  "dry",
  "unlocked",
  "false",
]);

/** Pure. Maps an HaEntityState to {value, unit}. */
export function normalizeState(state: HaEntityState): NormalizedValue {
  const unitAttr = state.attributes["unit_of_measurement"];
  const unit = typeof unitAttr === "string" ? unitAttr : null;
  const s = state.state;

  if (NULL_STATES.has(s)) return { value: null, unit };

  const n = Number(s);
  if (Number.isFinite(n)) return { value: n, unit };

  if (TRUE_STATES.has(s)) return { value: true, unit };
  if (FALSE_STATES.has(s)) return { value: false, unit };

  return { value: s, unit };
}
