/**
 * Identifiers and clocks (docs/data.md §1): random base62 ids made by the store, and the hybrid logical clock that
 * stamps every journal frame and record mutation for later last-writer-wins.
 */
import { randomBytes } from "node:crypto";
import type { Hlc } from "../../shared/store/types";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** n random base62 characters (rejection sampling, no modulo bias). */
export function base62(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248) out += ALPHABET[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

export const newWid = () => base62(16);
export const newFileKey = () => base62(22);
export const newFolderId = () => base62(16);
export const newVersionId = () => base62(16);
export const newPreviewId = () => base62(22);

/** Time source; tests drive it by hand. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/**
 * HLC strings "<ms base36, 9 chars>.<counter base36, 3 chars>.<deviceOrdinal base36, 2 chars>" (16 ASCII bytes,
 * the journal frame's HLC field). Monotonic per process even if the wall clock steps back.
 */
export class HlcClock {
  private lastMs = 0;
  private counter = 0;

  constructor(
    private readonly deviceOrdinal: number,
    private readonly clock: Clock = systemClock,
  ) {}

  now(): Hlc {
    const ms = this.clock.now();
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.counter = 0;
    } else {
      this.counter++;
      if (this.counter >= 36 ** 3) {
        this.lastMs++;
        this.counter = 0;
      }
    }
    return formatHlc(this.lastMs, this.counter, this.deviceOrdinal);
  }

  /** Moves the clock past a stamp seen elsewhere (receive rule), so later local stamps sort after it. */
  observe(hlc: Hlc): void {
    const p = parseHlc(hlc);
    if (p.ms > this.lastMs || (p.ms === this.lastMs && p.counter > this.counter)) {
      this.lastMs = p.ms;
      this.counter = p.counter;
    }
  }
}

export function formatHlc(ms: number, counter: number, deviceOrdinal: number): Hlc {
  return `${ms.toString(36).padStart(9, "0")}.${counter.toString(36).padStart(3, "0")}.${deviceOrdinal.toString(36).padStart(2, "0")}`;
}

export function parseHlc(hlc: Hlc): { ms: number; counter: number; deviceOrdinal: number } {
  const m = /^([0-9a-z]{9})\.([0-9a-z]{3})\.([0-9a-z]{2})$/.exec(hlc);
  if (!m) throw new Error(`not an HLC: ${hlc}`);
  return { ms: parseInt(m[1], 36), counter: parseInt(m[2], 36), deviceOrdinal: parseInt(m[3], 36) };
}

export const compareHlc = (a: Hlc, b: Hlc): number => (a < b ? -1 : a > b ? 1 : 0);
