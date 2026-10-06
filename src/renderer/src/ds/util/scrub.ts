import { clampRound } from "./evaluate";

/**
 * Scrubbing and stepping (contract §4.5, G): 1 unit per px dragged, ×10
 * with Shift, ×0.1 with Alt when the field keeps decimals; ↑ ↓ step by
 * `step`, Shift by `bigStep`.
 */
export type ScrubOptions = { step?: number; bigStep?: number; shift?: boolean; alt?: boolean; min?: number; max?: number; precision?: number };

export function scrubValue(start: number, dx: number, { step = 1, shift = false, alt = false, min = -Infinity, max = Infinity, precision = 2 }: ScrubOptions = {}): number {
  const rate = shift ? 10 : alt && precision > 0 ? 0.1 : 1;
  return clampRound(start + dx * step * rate, min, max, precision);
}

export function stepValue(value: number, dir: 1 | -1, { step = 1, bigStep = 10, shift = false, min = -Infinity, max = Infinity, precision = 2 }: ScrubOptions = {}): number {
  return clampRound(value + dir * (shift ? bigStep : step), min, max, precision);
}

/** A press that moved less than this is a click (it focuses the field). */
export const SCRUB_THRESHOLD = 2;
