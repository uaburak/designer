/** Colour helpers for Swatch and ColorInput (pure). */

/** The 148 CSS colour names (both gray / grey spellings), as Figma's colour fields take them (atlas 07 §5.4). */
const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff", beige: "f5f5dc",
  bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff", blueviolet: "8a2be2", brown: "a52a2a",
  burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00", chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed",
  cornsilk: "fff8dc", crimson: "dc143c", cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b",
  darkgray: "a9a9a9", darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f", darkslateblue: "483d8b",
  darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1", darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff",
  dimgray: "696969", dimgrey: "696969", dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22",
  fuchsia: "ff00ff", gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c",
  indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa", lavenderblush: "fff0f5", lawngreen: "7cfc00",
  lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080", lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3",
  lightgreen: "90ee90", lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a", lightseagreen: "20b2aa", lightskyblue: "87cefa",
  lightslategray: "778899", lightslategrey: "778899", lightsteelblue: "b0c4de", lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32",
  linen: "faf0e6", magenta: "ff00ff", maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3",
  mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc", mediumvioletred: "c71585",
  midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5", navajowhite: "ffdead", navy: "000080",
  oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23", orange: "ffa500", orangered: "ff4500", orchid: "da70d6",
  palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee", palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9",
  peru: "cd853f", pink: "ffc0cb", plum: "dda0dd", powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399",
  red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460",
  seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb", slateblue: "6a5acd",
  slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f", steelblue: "4682b4", tan: "d2b48c",
  teal: "008080", thistle: "d8bfd8", tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3",
  white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
};

/** A CSS colour name (any case) → "#rrggbb", or null. */
export const namedColor = (name: string): string | null => {
  const k = name.trim().toLowerCase();
  return Object.hasOwn(NAMED, k) ? `#${NAMED[k]}` : null;
};

/** "#RGB", "RGB", "#RRGGBB", "rrggbb" or a CSS colour name → "#rrggbb" (lower case); null otherwise. */
export function normalizeHex(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  const named = namedColor(t);
  if (named) return named;
  const d = t.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(d)) return `#${d}`;
  if (/^[0-9a-f]{3}$/.test(d)) return `#${d.split("").map((c) => c + c).join("")}`;
  return null;
}

/**
 * Figma's hex digits (atlas 07 §5.4): 1 → the grey of the digit repeated, 2 → the grey of the byte, 3 → #RGB,
 * 4 → #RGBA, 5 → #RGB and a two-digit alpha, 6 → #RRGGBB, 7 → #RRGGBB and one alpha digit (doubled), 8 or more →
 * #RRGGBBAA (the rest dropped). Without `alpha` the alpha digits are ignored. Null unless `digits` is all hex.
 */
export function hexDigitsToRgba(digits: string, alpha = true): RGBA | null {
  const d = digits.toLowerCase();
  if (!/^[0-9a-f]+$/.test(d)) return null;
  const twice = (s: string) => s.split("").map((c) => c + c).join("");
  let rgb: string;
  let a: string | null = null;
  if (d.length === 1) rgb = d.repeat(6);
  else if (d.length === 2) rgb = d.repeat(3);
  else if (d.length < 6) {
    rgb = twice(d.slice(0, 3));
    if (d.length === 4) a = twice(d[3]);
    if (d.length === 5) a = d.slice(3, 5);
  } else {
    rgb = d.slice(0, 6);
    if (d.length === 7) a = twice(d[6]);
    if (d.length >= 8) a = d.slice(6, 8);
  }
  const n = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: n(rgb, 0), g: n(rgb, 2), b: n(rgb, 4), a: alpha && a !== null ? n(a, 0) : 1 };
}

/**
 * What a colour field takes (atlas 07 §5.4): any string `parseColor` reads — a name, rgb(), hsl(), oklch()…, or the
 * first run of hex digits after any junk ("#ff8", "0c8ce9;", "12345") — as "#rrggbb" and, when the text carried an
 * alpha (4, 5, 7 or 8 hex digits, an rgba()…), that alpha as an opacity 0–100 (rounded); null otherwise.
 */
export function parseHexInput(raw: string): { hex: string; opacity?: number } | null {
  const c = parseColor(raw);
  if (!c) return null;
  const hex = rgbToHex(c.color);
  return c.alpha ? { hex, opacity: Math.round(clamp01(c.color.a) * 100) } : { hex };
}

/** A hex colour's 6 digits, upper case, without "#" (Figma's fill row). */
export const hexDigits = (color: string) => color.replace("#", "").slice(0, 6).toUpperCase();

export type HexChannel = "r" | "g" | "b";

/**
 * The channels ↑ ↓ step in a 6-digit hex field ("RRGGBB", no "#") for a caret or selection from `start` to `end`
 * (Figma's panel hex formatter, `getIncrementTargets`, atlas 07 §5.4): a caret steps the pair it is in or ends (0–2 R,
 * 3–4 G, 5–6 B); a selection every pair it touches.
 */
export function hexTargets(start: number, end: number): Set<HexChannel> {
  const caret = start === end;
  const out = new Set<HexChannel>();
  if (start <= 1 || (caret && start === 2)) out.add("r");
  if ((start <= 3 && end > 2) || (caret && start === 4)) out.add("g");
  if ((start <= 5 && end > 4) || (caret && start === 6)) out.add("b");
  return out;
}

/** "#rrggbb" with `delta` (0–255 units: Figma's nudge 1, ⇧ 10) added to the `targets` channels, each clamped. */
export function stepHex(hex: string, targets: Set<HexChannel>, delta: number): string {
  const h = normalizeHex(hex) ?? "#000000";
  const at = { r: 1, g: 3, b: 5 } as const;
  return (
    "#" +
    (["r", "g", "b"] as const)
      .map((c) => {
        const v = parseInt(h.slice(at[c], at[c] + 2), 16);
        return Math.max(0, Math.min(255, targets.has(c) ? v + delta : v)).toString(16).padStart(2, "0");
      })
      .join("")
  );
}

/** The digits selected after a step (Figma's `getSelection`): from the first stepped pair to the last. */
export function hexSelection(targets: Set<HexChannel>): { start: number; end: number } {
  return { start: targets.has("r") ? 0 : targets.has("g") ? 2 : 4, end: targets.has("b") ? 6 : targets.has("g") ? 4 : 2 };
}

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

// ── Colour strings (any colour field: the hex, the CSS model, a stop) ─────────────────────────────

/** The sRGB transfer curve and back. */
const toLinear = (v: number) => (Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (Math.abs(v) <= 0.0031308 ? v * 12.92 : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055));

/** Linear-light sRGB → the sRGB colour (clamped to the gamut, as an sRGB document clamps). */
const fromLinearRgb = (r: number, g: number, b: number) => ({ r: clamp01(fromLinear(r)), g: clamp01(fromLinear(g)), b: clamp01(fromLinear(b)) });

/** Display P3 → sRGB (the same curve; the primaries through the P3 → sRGB matrix). */
export function p3ToSrgb(r: number, g: number, b: number): { r: number; g: number; b: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  return fromLinearRgb(1.2249401 * lr - 0.2249404 * lg, -0.0420569 * lr + 1.0420571 * lg, -0.0196376 * lr - 0.0786361 * lg + 1.0982735 * lb);
}

/** sRGB → Display P3 (the same curve; every sRGB colour is inside P3, so nothing clamps). */
export function srgbToP3(r: number, g: number, b: number): { r: number; g: number; b: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  return fromLinearRgb(0.8224621 * lr + 0.177538 * lg, 0.0331941 * lr + 0.9668058 * lg, 0.0170827 * lr + 0.0723974 * lg + 0.9105199 * lb);
}

/** sRGB → OKLab [L 0..1, a, b] (Björn Ottosson's matrices, as CSS Color 4 and the engine's GradientRamp). */
export function rgbToOklab({ r, g, b }: Pick<RGBA, "r" | "g" | "b">): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** A channel through the sRGB curve: to linear light, or back. */
export const srgbToLinear = toLinear;
export const linearToSrgb = fromLinear;

/** OKLab (L 0..1) → sRGB (Björn Ottosson's matrices, as CSS Color 4). */
export function oklabToRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return fromLinearRgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}

/** CIE Lab (L 0..100) → sRGB: D65 white 95.047 / 100 / 108.883, then the sRGB curve (atlas 07 §5.4). */
export function labToRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [x, y, z] = [0.95047 * inv(fx), 1 * inv(fy), 1.08883 * inv(fz)];
  return fromLinearRgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
}

/** A CSS function's arguments: its `count` values (commas or spaces between them) and the alpha after "/" (or one more). */
function cssArgs(t: string, name: RegExp, count = 3): { args: string[]; alpha?: string } | null {
  const m = new RegExp(`^(?:${name.source})\\((.*)\\)$`).exec(t);
  if (!m) return null;
  const [body, slash] = m[m.length - 1].split("/");
  const args = body.trim().split(/\s*,\s*|\s+/).filter(Boolean);
  if (slash !== undefined) return { args, alpha: slash.trim() };
  return args.length === count + 1 ? { args: args.slice(0, count), alpha: args[count] } : { args };
}

/** A CSS number: "50%" as a share of `pct` (100 % = pct), "120deg" / "1.5turn" in degrees, else the number. */
function cssNumber(s: string, pct = 1): number {
  if (s === "none") return 0;
  if (s.endsWith("%")) return (parseFloat(s) / 100) * pct;
  if (s.endsWith("turn")) return parseFloat(s) * 360;
  if (s.endsWith("rad")) return (parseFloat(s) * 180) / Math.PI;
  return parseFloat(s);
}

/**
 * A colour string as Figma's colour fields read it (atlas 07 §5.4, in its order): rgb() / rgba() (0–255 or %),
 * color(display-p3 …) / color(srgb …), a CSS colour name, hsl() / hsla(), lab(), oklch(), oklab(), then hex —
 * `strict`: only "#?hex;?"; otherwise the first run of hex digits after any junk. `alpha: false` ignores alpha digits.
 * Returns the colour (sRGB, 0..1) and whether the text carried an alpha; null when nothing reads.
 */
export function parseColor(raw: string, { alpha = true, strict = false }: { alpha?: boolean; strict?: boolean } = {}): { color: RGBA; alpha: boolean } | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const done = (rgb: { r: number; g: number; b: number }, a?: string) => {
    const value = a === undefined ? 1 : cssNumber(a);
    if (![rgb.r, rgb.g, rgb.b, value].every(Number.isFinite)) return null;
    return { color: { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b), a: alpha ? clamp01(value) : 1 }, alpha: alpha && a !== undefined };
  };
  let f = cssArgs(t, /rgba?/);
  if (f?.args.length === 3) {
    const [r, g, b] = f.args.map((s) => cssNumber(s, 255) / 255);
    return done({ r, g, b }, f.alpha);
  }
  f = cssArgs(t, /color/, 4);
  if (f && f.args.length === 4 && (f.args[0] === "display-p3" || f.args[0] === "srgb")) {
    const [r, g, b] = f.args.slice(1).map((s) => cssNumber(s));
    return done(f.args[0] === "srgb" ? { r, g, b } : p3ToSrgb(r, g, b), f.alpha);
  }
  const named = namedColor(t);
  if (named) return done({ r: parseInt(named.slice(1, 3), 16) / 255, g: parseInt(named.slice(3, 5), 16) / 255, b: parseInt(named.slice(5, 7), 16) / 255 });
  f = cssArgs(t, /hsla?/);
  if (f?.args.length === 3) return done(hslToRgb({ h: cssNumber(f.args[0]), s: clamp01(cssNumber(f.args[1], 100) / 100), l: clamp01(cssNumber(f.args[2], 100) / 100) }), f.alpha);
  f = cssArgs(t, /lab/);
  if (f?.args.length === 3) return done(labToRgb(cssNumber(f.args[0], 100), cssNumber(f.args[1], 125), cssNumber(f.args[2], 125)), f.alpha);
  f = cssArgs(t, /oklch/);
  if (f?.args.length === 3) {
    const [L, C, H] = [cssNumber(f.args[0]), cssNumber(f.args[1], 0.4), (cssNumber(f.args[2]) * Math.PI) / 180];
    return done(oklabToRgb(L, C * Math.cos(H), C * Math.sin(H)), f.alpha);
  }
  f = cssArgs(t, /oklab/);
  if (f?.args.length === 3) return done(oklabToRgb(cssNumber(f.args[0]), cssNumber(f.args[1], 0.4), cssNumber(f.args[2], 0.4)), f.alpha);
  const digits = strict ? /^#?([0-9a-f]+);?$/.exec(t)?.[1] : /[0-9a-f]+/.exec(t)?.[0];
  const hex = digits ? hexDigitsToRgba(digits, alpha) : null;
  return hex && digits ? { color: hex, alpha: alpha && (digits.length >= 8 || [4, 5, 7].includes(digits.length)) } : null;
}

/** What the CSS colour model's field accepts: any colour string `parseColor` reads, as RGBA; null otherwise. */
export function parseCssColor(raw: string): RGBA | null {
  return parseColor(raw)?.color ?? null;
}

/** The colour between two stops at `t` (0..1), channel by channel, alpha too. */
export function mixRgba(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: RGBA): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG contrast ratio (1–21) of `fg` over `bg` — `fg`'s alpha composited on the opaque background first, as the
 * picker's "Check color contrast" reads a fill against what's behind it.
 */
export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const top = mixRgba({ ...bg, a: 1 }, { ...fg, a: 1 }, fg.a);
  const [a, b] = [luminance(top), luminance({ ...bg, a: 1 })].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Two colours equal at 8-bit precision. */
export const sameRgba = (x: RGBA, y: RGBA) => byte(x.r) === byte(y.r) && byte(x.g) === byte(y.g) && byte(x.b) === byte(y.b) && Math.round(x.a * 100) === Math.round(y.a * 100);
