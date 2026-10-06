/**
 * The rulers' numbers (pure): which values get a label at a zoom, where they
 * sit on screen, and how labels near the selection's edges fade — Figma's,
 * measured on the reference screenshots (docs/research/visual-diff.md: at
 * 100% a label every 50; the selection's edges labelled in blue, the
 * nearest labels faded or hidden).
 */

/** Label steps, in document units. */
export const RULER_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

/** The smallest step whose labels are at least `minSpacing` CSS px apart. */
export function rulerStep(zoom: number, minSpacing = 50): number {
  for (const s of RULER_STEPS) if (s * zoom >= minSpacing) return s;
  return RULER_STEPS[RULER_STEPS.length - 1];
}

/** Ruler value ↔ screen (CSS px along the ruler): screen = (origin + value) · zoom + offset. */
export interface RulerAxis {
  /** The camera's offset on this axis (engine Camera x or y) */
  offset: number;
  zoom: number;
  /** Where the ruler's 0 is, in page units (the selected frame's corner, or 0) */
  origin: number;
}

export const toScreen = (axis: RulerAxis, value: number) => (axis.origin + value) * axis.zoom + axis.offset;
export const toValue = (axis: RulerAxis, screen: number) => (screen - axis.offset) / axis.zoom - axis.origin;

/** The labelled values visible on [0, length] (a step's margin past each end, so labels slide in). */
export function rulerTicks(axis: RulerAxis, length: number, step = rulerStep(axis.zoom)): number[] {
  const first = Math.floor(toValue(axis, -step * axis.zoom) / step) * step;
  const last = toValue(axis, length + step * axis.zoom);
  const out: number[] = [];
  for (let v = first, i = 0; v <= last && i < 2000; v += step, i++) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** A label's text: whole numbers, at most two decimals, a real minus sign as Figma draws ("-450"). */
export function rulerLabel(value: number): string {
  const r = Math.round(value * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * A tick label's opacity near the selection's edge labels: hidden within
 * `hide` px of one (centre to centre), fading in until `full` px.
 */
export function labelAlpha(center: number, edgeCenters: readonly number[], hide = 44, full = 84): number {
  let alpha = 1;
  for (const e of edgeCenters) {
    const d = Math.abs(center - e);
    alpha = Math.min(alpha, Math.max(0, Math.min(1, (d - hide) / (full - hide))));
  }
  return alpha;
}
