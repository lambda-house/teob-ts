// ulid.ts — zero-dependency monotonic ULID (Crockford base32).
// 48-bit ms timestamp + 80-bit randomness from node:crypto randomFillSync.
// Same-ms (or clock-backwards) calls increment the random part, so ids are
// strictly lexicographically increasing within a process.

import { randomFillSync } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits (top 2 unused of 48-bit time)
const RANDOM_LEN = 16; // 16 chars * 5 bits = 80 bits

const DECODE: Record<string, number> = {};
for (let i = 0; i < ENCODING.length; i++) DECODE[ENCODING[i]] = i;
// Crockford decode aliases
DECODE["O"] = 0;
DECODE["I"] = 1;
DECODE["L"] = 1;

const RANDOM_MASK = (1n << 80n) - 1n;
const randomBuf = new Uint8Array(10);

let lastTime = -1;
let lastRandom = 0n;

function freshRandom(): bigint {
  randomFillSync(randomBuf);
  let value = 0n;
  for (const b of randomBuf) value = (value << 8n) | BigInt(b);
  return value;
}

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = "";
  let v = value;
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ENCODING[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/** Monotonic ULID. `now` defaults to Date.now(); injectable for tests. */
export function ulid(now?: number): string {
  const time = now ?? Date.now();
  if (time <= lastTime) {
    // Same millisecond (or clock went backwards): keep the previous timestamp
    // and increment the random part to preserve strict monotonicity.
    lastRandom = (lastRandom + 1n) & RANDOM_MASK;
  } else {
    lastTime = time;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom);
}

/** Extract the ms timestamp from a ULID. */
export function ulidTime(id: string): number {
  if (id.length < TIME_LEN) throw new Error(`Invalid ULID: ${id}`);
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = DECODE[id[i].toUpperCase()];
    if (v === undefined) throw new Error(`Invalid ULID character "${id[i]}" in: ${id}`);
    t = t * 32 + v;
  }
  return t;
}
