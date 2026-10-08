import { clampRound } from "./evaluate";

/**
 * Scrubbing and stepping (help.figma.com 360039956914): drag the field's label (or, holding ⌥, the field itself)
 * left to decrease, right to increase — 1 unit a px at 1x. Moving the pointer toward the top of the screen speeds
 * it up, toward the bottom slows it down: 2x, 1x, 1/2, 1/4 (`scrubRate`, from how far the pointer is above or
 * below where the drag started). Shift: the big nudge (10 a px). ↑ ↓ step by `step` (1), Shift by `bigStep` (10).
 */
export type ScrubOptions = { step?: number; bigStep?: number; shift?: boolean; alt?: boolean; min?: number; max?: number; precision?: number; rate?: number };

/** The speeds, top of the screen first. */
export const SCRUB_SPEEDS = [2, 1, 0.5, 0.25] as const;
/** How far (px) above / below the start the pointer moves to change speed. */
const SPEED_BAND = 60;

/** The scrub speed for a pointer `dy` px below (positive) or above (negative) where the drag started. */
export function scrubRate(dy: number): (typeof SCRUB_SPEEDS)[number] {
  if (dy <= -SPEED_BAND) return 2;
  if (dy < SPEED_BAND) return 1;
  if (dy < SPEED_BAND * 3) return 0.5;
  return 0.25;
}

/**
 * The value `dx` px of drag from `start`: Shift ×10; `rate` the speed (2, 1, 1/2, 1/4). Integer fields keep whole
 * units (the slow speeds take more pixels per unit).
 */
export function scrubValue(start: number, dx: number, { step = 1, bigStep = 10, shift = false, min = -Infinity, max = Infinity, precision = 2, rate = 1 }: ScrubOptions = {}): number {
  const perPx = (shift ? bigStep : step) * rate;
  const delta = precision === 0 ? Math.trunc(dx * perPx) : dx * perPx;
  return clampRound(start + delta, min, max, precision);
}

export function stepValue(value: number, dir: 1 | -1, { step = 1, bigStep = 10, shift = false, min = -Infinity, max = Infinity, precision = 2 }: ScrubOptions = {}): number {
  return clampRound(value + dir * (shift ? bigStep : step), min, max, precision);
}

/** A press that moved less than this is a click (it focuses the field). */
export const SCRUB_THRESHOLD = 2;
