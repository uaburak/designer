/**
 * The right panel's Easing page (docs/motion.md §6.14; Figma's, docs/research/figma/live/2026-10-18/motion-easing.txt):
 * what it reads and draws without React — the selected segments (their end keyframes) found in the timeline's model,
 * their shared easing (Mixed when they differ), the 208 × 208 graph's layout for a curve (fitted so overshooting
 * handles stay in view, as Figma's) and for a spring, the presets popover's glyphs, the Bezier field's text and Flip
 * curve.
 */
import { MIXED, type Mixed } from "@/ds";
import { bezierOf, easingAt, isSpringEasing, type Bezier } from "@shared/motion/easing";
import { BEZIER_PRESETS, type EasingRef, type GuidString, type Micros, type MotionEasing, type MotionEasingType, type TimelineModel } from "@shared/motion/types";

/** A selected segment: its end keyframe (whose easing it is), its layer, its start and end on the timeline. */
export interface SegmentTarget {
  id: GuidString;
  node: GuidString;
  startUs: Micros;
  endUs: Micros;
  /** Its easing (a bound one's value in the layer's modes) */
  easing: MotionEasing;
  /** The EASING variable it is bound to */
  variable?: GuidString;
}

/** The segments `ids` names (end keyframes with a keyframe before them), on the layers `nodes` holds. */
export function segmentTargets(model: TimelineModel | null, ids: readonly GuidString[], nodes: ReadonlySet<GuidString>): SegmentTarget[] {
  if (!model || !ids.length) return [];
  const want = new Set(ids);
  const out: SegmentTarget[] = [];
  for (const l of model.layers) {
    if (!nodes.has(l.node)) continue;
    for (const tr of l.tracks)
      tr.keyframes.forEach((k, i) => {
        if (i === 0 || !want.has(k.id)) return;
        const easing = "type" in k.easing ? k.easing : { type: "LINEAR" as const };
        out.push({ id: k.id, node: l.node, startUs: tr.keyframes[i - 1].timeUs, endUs: k.timeUs, easing, variable: k.easingVariable ?? ("variable" in k.easing ? k.easing.variable : undefined) });
      });
  }
  return out;
}

const refKey = (t: SegmentTarget) => (t.variable ? `v:${t.variable}` : JSON.stringify(t.easing));

/** The segments' easing as one value (a variable binding, or the easing), Mixed when they differ. */
export function sharedEasing(targets: readonly SegmentTarget[]): Mixed<EasingRef> | null {
  if (!targets.length) return null;
  const first = refKey(targets[0]);
  if (targets.some((t) => refKey(t) !== first)) return MIXED;
  return targets[0].variable ? { variable: targets[0].variable } : targets[0].easing;
}

// ---- The graph (208 × 208) ------------------------------------------------------------------------------------------

export const GRAPH = 208;
/** Curve: x across from 44 to 164 (a unit of 120); 0 and 1 up at 164 and 44 unless a handle overshoots past 32 px. */
const CX0 = 44;
const CX1 = 164;
const EDGE = 12;
const SLACK = 32 / 120;

export interface CurveLayout {
  x(p: number): number;
  y(v: number): number;
  p(x: number): number;
  v(y: number): number;
}

/**
 * The curve graph's mapping for a bezier: 0 and 1 at 164 and 44 (a unit of 120); a handle above 1 + 32/120 puts the
 * top at 12 instead, one below −32/120 the bottom at 196 (Figma's capture: 0.45, 1.45, 0.8, 1 — 0 at 164, 1.45 at 12).
 */
export function curveLayout(b: Bezier | null): CurveLayout {
  const hi = Math.max(1, b?.[1] ?? 0, b?.[3] ?? 0);
  const lo = Math.min(0, b?.[1] ?? 0, b?.[3] ?? 0);
  const [topV, topY] = hi > 1 + SLACK ? [hi, EDGE] : [1, CX0];
  const [botV, botY] = lo < -SLACK ? [lo, GRAPH - EDGE] : [0, CX1];
  const unit = (botY - topY) / (topV - botV);
  const ux = CX1 - CX0;
  return { x: (p) => CX0 + p * ux, y: (v) => botY - (v - botV) * unit, p: (x) => (x - CX0) / ux, v: (y) => botV + (botY - y) / unit };
}

/** Spring (Figma's svg): time across 23 → 185, 0 at 185 and the target (the guideline) at 104. */
export const SPRING_X0 = 23;
export const SPRING_X1 = 185;
export const SPRING_Y0 = 185;
export const SPRING_Y1 = 104;
export const springX = (p: number) => SPRING_X0 + p * (SPRING_X1 - SPRING_X0);
export const springY = (v: number) => SPRING_Y0 - v * (SPRING_Y0 - SPRING_Y1);

/** The easing drawn over a curve layout (a bezier exactly, Hold a step, anything else sampled). */
export function curvePathOf(e: MotionEasing, at: CurveLayout): string {
  const b = bezierOf(e);
  if (b) return `M${at.x(0)} ${at.y(0)} C${at.x(b[0])} ${at.y(b[1])} ${at.x(b[2])} ${at.y(b[3])} ${at.x(1)} ${at.y(1)}`;
  if (e.type === "HOLD") return `M${at.x(0)} ${at.y(0)} H${at.x(1)} V${at.y(1)}`;
  return sampled(e, 80, at.x, at.y);
}

/** A spring's response over the segment (normalised, §4.7) in the spring graph. */
export const springPathOf = (e: MotionEasing): string => sampled(e, 96, springX, springY);

function sampled(e: MotionEasing, n: number, x: (p: number) => number, y: (v: number) => number): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(`${x(i / n).toFixed(2)} ${y(easingAt(e, i / n)).toFixed(2)}`);
  return `M${pts.join(" L")}`;
}

/** A spring's first peak (p, value): where the knob sits — without a bounce, where it first comes within 1 % of the target. */
export function springPeak(e: MotionEasing): { p: number; v: number } {
  let reach: { p: number; v: number } | null = null;
  for (let i = 1; i < 120; i++) {
    const p = i / 120;
    const v = easingAt(e, p);
    if (v > 1 && v >= easingAt(e, (i + 1) / 120)) return { p, v };
    if (!reach && v >= 0.99) reach = { p, v: 1 };
  }
  return reach ?? { p: 1, v: 1 };
}

/** The bounce whose first peak reaches `v` (0–1, two decimals; the peak rises with the bounce). */
export function bounceForPeak(v: number): number {
  const peak = (bounce: number) => springPeak({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce } }).v;
  let lo = 0;
  let hi = 1;
  if (v <= peak(0)) return 0;
  if (v >= peak(1)) return 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (peak(mid) < v) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 100) / 100;
}

// ---- The presets popover's glyphs (24 × 24: a 4 × 4 dot grid, the curve from (6.5, 17.5) to (17.5, 6.5)) ------------

export const GLYPH_DOTS = [6.5, 10.1667, 13.8333, 17.5];

/** A preset's glyph curve: Hold Figma's step, the others 33 samples of the curve over the 11 px box. */
export function presetGlyphPath(type: MotionEasingType, easing?: MotionEasing): string {
  if (type === "HOLD") return "M6.5 17.5H17.5V6.5";
  const e: MotionEasing = easing && easing.type === type ? easing : { type };
  return sampled(e, 32, (p) => 6.5 + p * 11, (v) => 17.5 - v * 11);
}

// ---- The value row ----------------------------------------------------------------------------------------------------

const r2 = (v: number) => Math.round(v * 100) / 100;

/** "x1, y1, x2, y2" (Figma's field: two decimals at most). */
export const bezierText = (b: Bezier): string => b.map((v) => String(r2(v))).join(", ");

/** The field typed: four numbers, x clamped to 0–1 (CSS's rule), y free within −2…3 [ours: a bound]; else null. */
export function parseBezierText(text: string): Bezier | null {
  const parts = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const cx = (v: number) => Math.min(1, Math.max(0, v));
  const cy = (v: number) => Math.min(3, Math.max(-2, v));
  return [cx(parts[0]), cy(parts[1]), cx(parts[2]), cy(parts[3])];
}

/** A bezier as an easing: the named curve with exactly these numbers, else a custom bezier. */
export function easingOfBezier(b: Bezier): MotionEasing {
  const named = (Object.keys(BEZIER_PRESETS) as MotionEasingType[]).find((k) => BEZIER_PRESETS[k]!.every((v, i) => Math.abs(v - b[i]) < 1e-6));
  return named ? { type: named } : { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] } };
}

/** Flip curve: the curve turned end for end (x1, y1, x2, y2 → 1 − x2, 1 − y2, 1 − x1, 1 − y1); Ease in becomes Ease out. */
export function flipEasing(e: MotionEasing): MotionEasing | null {
  const b = bezierOf(e);
  if (!b) return null;
  return easingOfBezier([r2(1 - b[2]), r2(1 - b[3]), r2(1 - b[0]), r2(1 - b[1])]);
}

export const isSpring = (e: MotionEasing): boolean => isSpringEasing(e.type);
