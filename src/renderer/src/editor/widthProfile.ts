/**
 * Width profiles (round 12; live popovers/stroke-advanced-settings.txt: Stroke settings › "Width profile", a 96 × 24
 * dropdown showing the profile as a 62 × 4 image, then "Flip width points"). The presets and what they do are the
 * plugin API's (developers.figma.com VariableWidthStrokeProperties: UNIFORM, WEDGE, TAPER, QUARTER_TAPER, EYE,
 * MIRRORED_TAPER); their points, the smooth curve between points and the names in the list are ours (unverified) —
 * the same as the engine's (engine/src/geometry/VariableWidth.cpp), which draws and applies them (SET_WIDTH_PROFILE,
 * FLIP_WIDTH_POINTS).
 */
import type { WidthPoint, WidthProfile } from "@/engine/codec";

export type { WidthPoint, WidthProfile };

/** The list, in the API's order, with the names the list reads (unverified). */
export const WIDTH_PROFILES: { value: WidthProfile; label: string }[] = [
  { value: "UNIFORM", label: "Uniform" },
  { value: "WEDGE", label: "Wedge" },
  { value: "TAPER", label: "Taper" },
  { value: "QUARTER_TAPER", label: "Quarter taper" },
  { value: "EYE", label: "Eye" },
  { value: "MIRRORED_TAPER", label: "Mirrored taper" },
];

const sym = (position: number, width: number): WidthPoint => ({ position, ascent: width / 2, descent: width / 2 });

/** A preset's points (UNIFORM: none). */
export function presetPoints(profile: WidthProfile): WidthPoint[] {
  switch (profile) {
    case "WEDGE":
      return [sym(0, 1), sym(1, 0)];
    case "TAPER":
      return [sym(0, 1), sym(1, 0.25)];
    case "QUARTER_TAPER":
      return [sym(0, 0.25), sym(0.25, 1), sym(1, 0.25)];
    case "EYE":
      return [sym(0, 0), sym(0.5, 1), sym(1, 0)];
    case "MIRRORED_TAPER":
      return [sym(0, 0.25), sym(0.5, 1), sym(1, 0.25)];
    default:
      return [];
  }
}

/** A node's stored points (`variableWidthPoints` as the JSON codec gives them), sorted, defaults filled in. */
export function readWidthPoints(raw: unknown): WidthPoint[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({ position: Math.min(1, Math.max(0, num(p.position, 0))), ascent: Math.max(0, num(p.ascent, 0.5)), descent: Math.max(0, num(p.descent, 0.5)) }))
    .sort((a, b) => a.position - b.position);
}

/** The preset these points are, else "CUSTOM". */
export function matchProfile(points: readonly WidthPoint[]): WidthProfile | "CUSTOM" {
  if (!points.length) return "UNIFORM";
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  for (const { value } of WIDTH_PROFILES) {
    const preset = presetPoints(value);
    if (preset.length === points.length && preset.every((p, i) => near(p.position, points[i].position) && near(p.ascent, points[i].ascent) && near(p.descent, points[i].descent)))
      return value;
  }
  return "CUSTOM";
}

/** Fritsch–Carlson monotone cubic through (x, y) at u (the engine's curve between width points). */
function monotone(x: number[], y: number[], u: number): number {
  const n = x.length;
  if (!n) return 0.5;
  if (n === 1 || u <= x[0]) return y[0];
  if (u >= x[n - 1]) return y[n - 1];
  const delta: number[] = [];
  for (let k = 0; k + 1 < n; k++) {
    const h = x[k + 1] - x[k];
    delta.push(h > 1e-12 ? (y[k + 1] - y[k]) / h : 0);
  }
  const m: number[] = new Array<number>(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let k = 1; k + 1 < n; k++) m[k] = delta[k - 1] * delta[k] <= 0 ? 0 : (delta[k - 1] + delta[k]) / 2;
  for (let k = 0; k + 1 < n; k++) {
    if (delta[k] === 0) {
      m[k] = m[k + 1] = 0;
      continue;
    }
    const a = m[k] / delta[k];
    const b = m[k + 1] / delta[k];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * a * delta[k];
      m[k + 1] = tau * b * delta[k];
    }
  }
  let k = 0;
  while (k + 2 < n && u > x[k + 1]) k++;
  const h = x[k + 1] - x[k];
  if (h <= 1e-12) return y[k + 1];
  const t = (u - x[k]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h * m[k + 1];
  return Math.max(0, v);
}

/** The shares left / right of the path at u (0…1). */
export function profileAt(points: readonly WidthPoint[], u: number): { ascent: number; descent: number } {
  if (!points.length) return { ascent: 0.5, descent: 0.5 };
  const x: number[] = [];
  const a: number[] = [];
  const d: number[] = [];
  for (const p of points) {
    if (x.length && Math.abs(p.position - x[x.length - 1]) < 1e-9) {
      a[a.length - 1] = p.ascent;
      d[d.length - 1] = p.descent;
      continue;
    }
    x.push(p.position);
    a.push(p.ascent);
    d.push(p.descent);
  }
  return { ascent: monotone(x, a, u), descent: monotone(x, d, u) };
}

/**
 * The profile as the dropdown draws it (live: a 62 × 4 image): the stroke's outline along a straight line `width` long,
 * `height` across at the full weight (wider points are cut to it). An SVG path, y down.
 */
export function profilePath(points: readonly WidthPoint[], width = 62, height = 4): string {
  const steps = 62;
  const top: string[] = [];
  const bottom: string[] = [];
  const mid = height / 2;
  const f = (n: number) => Math.round(n * 100) / 100;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const { ascent, descent } = profileAt(points, u);
    const x = f(u * width);
    top.push(`${x} ${f(mid - Math.min(mid, ascent * height))}`);
    bottom.push(`${x} ${f(mid + Math.min(mid, descent * height))}`);
  }
  return `M${top.join("L")}L${bottom.reverse().join("L")}Z`;
}
