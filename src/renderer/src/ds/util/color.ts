/** Colour helpers for Swatch and ColorInput (pure). */

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080",
  pink: "#ffc0cb", brown: "#a52a2a", lime: "#00ff00", navy: "#000080", teal: "#008080", silver: "#c0c0c0",
};

/** "#RGB", "RGB", "#RRGGBB", "rrggbb" or a CSS colour name → "#rrggbb" (lower case); null otherwise. */
export function normalizeHex(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  const d = t.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(d)) return `#${d}`;
  if (/^[0-9a-f]{3}$/.test(d)) return `#${d.split("").map((c) => c + c).join("")}`;
  return null;
}

/** A hex colour's 6 digits, upper case, without "#" (Figma's fill row). */
export const hexDigits = (color: string) => color.replace("#", "").slice(0, 6).toUpperCase();

/** "#rrggbb" + opacity 0–100 → rgba() for CSS. */
export function withOpacity(hex: string, opacity: number): string {
  const h = normalizeHex(hex) ?? "#000000";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(100, opacity)) / 100})`;
}

// ── Colour models (ColorPicker) ──────────────────────────────────────────────

/** A colour as Figma stores it: channels and alpha in 0..1. */
export type RGBA = { r: number; g: number; b: number; a: number };
/** Hue 0..360, saturation and value/brightness 0..1. */
export type HSV = { h: number; s: number; v: number };
/** Hue 0..360, saturation and lightness 0..1. */
export type HSL = { h: number; s: number; l: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const byte = (n: number) => Math.round(clamp01(n) * 255);

export function rgbToHsv({ r, g, b }: Pick<RGBA, "r" | "g" | "b">): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max > 0 ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): { r: number; g: number; b: number } {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

export function rgbToHsl({ r, g, b }: Pick<RGBA, "r" | "g" | "b">): HSL {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: rgbToHsv({ r, g, b }).h, s: clamp01(s), l };
}

export function hslToRgb({ h, s, l }: HSL): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const v = l + c / 2;
  return hsvToRgb({ h, s: v === 0 ? 0 : c / v, v });
}

/** "#rrggbb" (6 digits, lower case) of a colour's RGB. */
export function rgbToHex({ r, g, b }: Pick<RGBA, "r" | "g" | "b">): string {
  return `#${[r, g, b].map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
}

/** A hex colour ("#rgb", "#rrggbb", "#rrggbbaa", or a name) as RGBA 0..1; null when it is not one. */
export function hexToRgba(raw: string): RGBA | null {
  const t = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(t)) {
    const n = (i: number) => parseInt(t.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: n(6) };
  }
  const hex = normalizeHex(raw);
  if (!hex) return null;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(1), g: n(3), b: n(5), a: 1 };
}

/** A colour as CSS: rgba(…) with 0–255 channels. */
export function rgbaToCss({ r, g, b, a }: RGBA): string {
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Math.round(clamp01(a) * 100) / 100})`;
}

/** What the CSS colour model's field accepts: hex (3/6/8 digits), rgb()/rgba() with 0–255 or %, hsl()/hsla(), or a name. */
export function parseCssColor(raw: string): RGBA | null {
  const t = raw.trim().toLowerCase();
  const hex = hexToRgba(t);
  if (hex) return hex;
  const num = (s: string, max: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * max : parseFloat(s));
  let m = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((s) => num(s, 255) / 255);
    const a = m[4] === undefined ? 1 : num(m[4], 1);
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a) };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (m) {
    const rgb = hslToRgb({ h: parseFloat(m[1]), s: parseFloat(m[2]) / 100, l: parseFloat(m[3]) / 100 });
    const a = m[4] === undefined ? 1 : num(m[4], 1);
    return { ...rgb, a: clamp01(a) };
  }
  return null;
}

/** The colour between two stops at `t` (0..1), channel by channel, alpha too. */
export function mixRgba(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k };
}

/** Two colours equal at 8-bit precision. */
export const sameRgba = (x: RGBA, y: RGBA) => byte(x.r) === byte(y.r) && byte(x.g) === byte(y.g) && byte(x.b) === byte(y.b) && Math.round(x.a * 100) === Math.round(y.a * 100);
