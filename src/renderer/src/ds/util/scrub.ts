import { clampRound } from "./evaluate";

/**
 * Scrubbing and stepping (help.figma.com 360039956914): drag the field's label (or, holding ⌥, the field itself)
 * left to decrease, right to increase. Moving the pointer toward the top of the screen speeds it up, toward the
 * bottom slows it down: 2x, 1x, 1/2, 1/4 (`scrubRate`, from how far the pointer is above or below where the drag
 * started). Shift: the big nudge (10 a step). ↑ ↓ step by `step` (1), Shift by `bigStep` (10).
 *
 * A scrub moves in whole steps (round 16, the owner's report: "61.05" scrubbed to 62.05, 63.05 … — Figma's go
 * 62, 63 …): `SCRUB_PX_PER_STEP` px of drag at 1x is one step, and a fractional value lands on the step grid at the
 * first one (61.05 → 62 right, → 61 left), whole steps after. The rate: live Figma's X label dragged 90 CSS px moved
 * the value 22 (docs/research/figma/live/behaviour/fields.md §14) — 4 px a step, the old code's rate too
 * (docs/research/code/look.md); 1 px a step (our first rate) read as far too fast to the owner.
 */
export type ScrubOptions = { step?: number; bigStep?: number; shift?: boolean; alt?: boolean; min?: number; max?: number; precision?: number; rate?: number };

/** The speeds, top of the screen first. */
export const SCRUB_SPEEDS = [2, 1, 0.5, 0.25] as const;
/** How far (px) above / below the start the pointer moves to change speed. */
const SPEED_BAND = 60;
/** CSS px of horizontal drag for one step at 1x (2 at 2x, 8 at 1/2, 16 at 1/4). */
export const SCRUB_PX_PER_STEP = 4;

/** The scrub speed for a pointer `dy` px below (positive) or above (negative) where the drag started. */
export function scrubRate(dy: number): (typeof SCRUB_SPEEDS)[number] {
  if (dy <= -SPEED_BAND) return 2;
  if (dy < SPEED_BAND) return 1;
  if (dy < SPEED_BAND * 3) return 0.5;
  return 0.25;
}

/** Whole steps in `dx` px of drag at `rate` (toward zero: a step is taken once its pixels are all covered). */
export function scrubSteps(dx: number, rate = 1): number {
  return Math.trunc((dx * rate) / SCRUB_PX_PER_STEP + (dx >= 0 ? 1e-9 : -1e-9));
}

/**
 * The value `dx` px of drag from `start`: whole steps (`step`, Shift `bigStep`) at `rate`; a value off the step grid
 * lands on it at the first step, rounding the way the drag goes (61.05 → 62 / 61), then moves whole steps.
 */
export function scrubValue(start: number, dx: number, { step = 1, bigStep = 10, shift = false, min = -Infinity, max = Infinity, precision = 2, rate = 1 }: ScrubOptions = {}): number {
  const n = scrubSteps(dx, rate);
  if (n === 0) return start;
  const unit = step > 0 ? step : 1;
  const k = start / unit;
  const onGrid = Math.abs(k - Math.round(k)) < 1e-6;
  const base = onGrid ? Math.round(k) * unit : (n > 0 ? Math.floor(k) : Math.ceil(k)) * unit;
  return clampRound(base + n * (shift ? bigStep : step), min, max, precision);
}

/**
 * A value `delta` whole units from `start` as a scrub moves it (a Mixed field's scrub, each layer from its own value):
 * whole steps, a fractional start landing on a whole number at the first one, the way it goes — as `scrubValue`.
 */
export function scrubFrom(start: number, delta: number): number {
  if (delta === 0 || !Number.isInteger(delta) || Math.abs(start - Math.round(start)) < 1e-6) return Math.round((start + delta) * 100) / 100;
  return (delta > 0 ? Math.floor(start) : Math.ceil(start)) + delta;
}

export function stepValue(value: number, dir: 1 | -1, { step = 1, bigStep = 10, shift = false, min = -Infinity, max = Infinity, precision = 2 }: ScrubOptions = {}): number {
  return clampRound(value + dir * (shift ? bigStep : step), min, max, precision);
}

/** A press that moved less than this is a click (it focuses the field). */
export const SCRUB_THRESHOLD = 2;
