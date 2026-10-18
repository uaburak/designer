import type { RGBA } from "./color";

/**
 * The colour picker's "Check color contrast" (atlas 07 §5.7; Figma's color_contrast modules in `5519` / `2108`): WCAG
 * 2 contrast of a fill over what's behind it, against the standard its layer calls for, and the nearest colour of the
 * same hue and alpha that meets it (the auto-correct).
 */

/** What a layer is read as: Figma's categories (a selection of several kinds is "mixed"). */
export type ContrastCategory = "normalText" | "largeText" | "graphics" | "mixed";
export type ContrastLevel = "AA" | "AAA";

/** Figma's ratios per category (graphics have no AAA). */
export const CONTRAST_RATIOS: Record<ContrastCategory, Record<ContrastLevel, number | null>> = {
  normalText: { AA: 4.5, AAA: 7 },
  largeText: { AA: 3, AAA: 4.5 },
  graphics: { AA: 3, AAA: null },
  mixed: { AA: 3, AAA: 4.5 },
};

/** A text is large when every run is 24 px or more, or 19 px or more and bold (700+); other layers are graphics. */
export function contrastCategoryOf(type: string, runs: readonly { fontSize?: number; fontWeight?: number }[] = []): Exclude<ContrastCategory, "mixed"> {
  if (type !== "TEXT") return "graphics";
  return runs.length > 0 && runs.every((r) => (r.fontSize ?? 0) >= 24 || ((r.fontSize ?? 0) >= 19 && (r.fontWeight ?? 0) >= 700)) ? "largeText" : "normalText";
}

/** The selection's category: one kind its own; several, "mixed" — unless one is normal text (then no standard applies). */
export function selectionCategory(kinds: ReadonlySet<Exclude<ContrastCategory, "mixed">>): ContrastCategory | null {
  if (kinds.size === 1) return [...kinds][0];
  return kinds.has("normalText") ? null : "mixed";
}

const lin = (v: number) => {
  const a = Math.abs(v);
  return a <= 0.04045 ? v / 12.92 : Math.sign(v) * ((a + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance (alpha ignored). */
export const wcagLuminance = (c: Pick<RGBA, "r" | "g" | "b">) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

/** `fg` over `bg`, alpha composited (Figma's colour stacking). */
export function over(bg: RGBA, fg: RGBA): RGBA {
  const n = bg.a, r = fg.a, i = n * (1 - r), a = i + r;
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const o = i / a, s = r / a;
  return { r: bg.r * o + fg.r * s, g: bg.g * o + fg.g * s, b: bg.b * o + fg.b * s, a };
}

/** The ratio as Figma shows it: `fg` over `bg`, cut (not rounded) to 2 decimals. */
export function contrastOf(fg: RGBA, bg: RGBA): number {
  const [x, y] = [wcagLuminance(over(bg, fg)), wcagLuminance(bg)].sort((a, b) => b - a);
  return Math.trunc(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** HSV (all 0–1, hue in turns) → RGB, Figma's. */
function hsvRgb(c: { h: number; s: number; v: number; a: number }): RGBA {
  const t = (c.h - Math.floor(c.h)) * 6, n = c.v * c.s, r = n * (1 - Math.abs((t % 2) - 1));
  const red = c.s <= 0 ? 0 : t < 1 ? n : t < 2 ? r : t < 4 ? 0 : t < 5 ? r : n;
  const green = c.s <= 0 ? 0 : t < 1 ? r : t < 3 ? n : t < 4 ? r : 0;
  const blue = c.s <= 0 || t < 2 ? 0 : t < 3 ? r : t < 5 ? n : r;
  const m = c.v - n;
  return { r: red + m, g: green + m, b: blue + m, a: c.a };
}

type Hsva = { h: number; s: number; v: number; a: number };

/**
 * Along one coordinate of `start` (brightness when `byValue`, else saturation), the value whose colour over `bg` has
 * `target` luminance — Figma's bisection (150 steps, within 0.0002), or null when it leaves 0–1.
 */
function solve(start: Hsva, bg: RGBA, byValue: boolean, target: number): number | null {
  const lum = (c: Hsva) => wcagLuminance(over(bg, hsvRgb(c)));
  let step = 1;
  let d = start;
  let u = byValue ? d.v : d.s;
  let diff = lum(d) - target;
  let sign = Math.sign(diff);
  for (let k = 150; k; k--) {
    if (Math.abs(diff) < 2e-4) return u;
    const now = Math.sign(diff);
    if (now !== sign) {
      step /= 2;
      sign = now;
    } else if (u < 0 || u > 1) break;
    u += step * (byValue ? -diff : diff);
    d = { h: d.h, s: byValue ? d.s : u, v: byValue ? u : d.v, a: d.a };
    diff = lum(d) - target;
  }
  return null;
}

/**
 * The line in the picker's square (saturation → brightness, at `hue` and `alpha`) where the colour over `bg` has
 * `target` luminance: Figma's walk in saturation steps of 0.02, each brightness found from the slope so far, and the
 * line's end on the top edge when it leaves through it; null when there is none.
 */
export function isoLuminanceLine(hue: number, alpha: number, bg: RGBA, target: number): Hsva[] | null {
  const out: Hsva[] = [];
  let prev = 0, slope = 0, i = 0, last: Hsva = { h: hue, s: 0, v: 0, a: alpha };
  for (i = 0; i < 1.02; i += 0.02) {
    i = Math.min(1, i);
    last = { h: hue, s: i, v: prev + 0.02 * slope, a: alpha };
    const v = solve(last, bg, true, target);
    if (v === null) break;
    slope = i === 0 ? 0 : (v - prev) / 0.02;
    prev = v;
    out.push({ h: hue, s: i, v, a: alpha });
  }
  if (i < 1.02 && out.length > 0) {
    const s = solve({ h: hue, s: last.s, v: 1, a: alpha }, bg, false, target);
    if (s !== null) out.push({ h: hue, s, v: 1, a: alpha });
  }
  return out.length ? out : null;
}

/** The two lines where the contrast with `bg` is exactly `ratio`: lighter colours above one, darker below the other. */
export function contrastLines(ratio: number, hue: number, alpha: number, bg: RGBA): { lighter: Hsva[] | null; darker: Hsva[] | null } {
  const l = wcagLuminance(bg);
  const lighter = ratio * (l + 0.05) - 0.05, darker = (l + 0.05) / ratio - 0.05;
  return {
    lighter: lighter >= 0 && lighter <= 1 ? isoLuminanceLine(hue, alpha, bg, lighter) : null,
    darker: darker >= 0 && darker <= 1 ? isoLuminanceLine(hue, alpha, bg, darker) : null,
  };
}

/** Figma's colour distance for the candidate (its CIELAB ΔE 94 over `rgb / 255`, kept as it is). */
function distance(a: RGBA, b: RGBA): number {
  const lab = (e: RGBA) => {
    const ch = (v: number) => {
      const x = 1 - (1 - v / 255) * e.a;
      return x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92;
    };
    const i = ch(e.r), g = ch(e.g), o = ch(e.b);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const t = f((0.4124 * i + 0.3576 * g + 0.1805 * o) / 0.95047), n = f(0.2126 * i + 0.7152 * g + 0.0722 * o), r = f((0.0193 * i + 0.1192 * g + 0.9505 * o) / 1.08883);
    return { l: 116 * n - 16, a: 500 * (t - n), b: 200 * (n - r) };
  };
  const x = lab(a), y = lab(b);
  const dl = x.l - y.l, da = x.a - y.a, db = x.b - y.b;
  const c1 = Math.hypot(x.a, x.b), dc = c1 - Math.hypot(y.a, y.b);
  const dh = Math.sqrt(Math.max(0, da * da + db * db - dc * dc));
  return Math.sqrt(dl * dl + (dc / (1 + 0.045 * c1)) ** 2 + (dh / (1 + 0.015 * c1)) ** 2) / 0.002741735;
}

/**
 * The auto-correct (Figma's): of the colours on the two lines for `ratio` (+0.05, a margin over it) at the fill's hue
 * and alpha, the one nearest `fg` that's inside sRGB; null when there's none.
 */
export function autoCorrect({ ratio, hue, alpha, fg, bg }: { ratio: number; hue: number; alpha: number; fg: RGBA; bg: RGBA }): RGBA | null {
  const { lighter, darker } = contrastLines(ratio + 0.05, hue, alpha, bg);
  const all = [...(lighter ?? []), ...(darker ?? [])];
  if (!all.length) return null;
  return all.reduce((best, c) => {
    const rgb = hsvRgb(c);
    return rgb.r > 1 || rgb.g > 1 || rgb.b > 1 ? best : distance(fg, rgb) < distance(fg, best) ? rgb : best;
  }, hsvRgb(all[0]));
}
