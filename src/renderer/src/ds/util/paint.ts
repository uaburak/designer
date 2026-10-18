import { hslToRgb, linearToSrgb, mixRgba, oklabToRgb, rgbaToCss, rgbToHsl, rgbToOklab, srgbToLinear, type RGBA } from "./color";

/**
 * The paint the ColorPicker edits — the subset of Figma's Paint it touches,
 * under Figma's own names (kiwi `Paint`: type, color, opacity, stops,
 * blendMode, imageScaleMode), so the editor maps it 1:1. Fields it does not
 * know (transform, image hash, variable bindings…) pass through untouched.
 */
export type PaintType = "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "PATTERN" | "IMAGE" | "VIDEO";
export type GradientType = Exclude<PaintType, "SOLID" | "PATTERN" | "IMAGE" | "VIDEO">;
/** PATTERN: how the tiles sit (schema PatternTileType) */
export type PatternTileType = "RECTANGULAR" | "HORIZONTAL_HEXAGONAL" | "VERTICAL_HEXAGONAL";
/** PATTERN: the anchor point on one axis (schema PatternAlignment) */
export type PatternAlignment = "START" | "CENTER" | "END";
export type BlendMode =
  | "NORMAL" | "DARKEN" | "MULTIPLY" | "LINEAR_BURN" | "COLOR_BURN" | "LIGHTEN" | "SCREEN" | "LINEAR_DODGE" | "COLOR_DODGE"
  | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY";
export type ImageScaleMode = "FILL" | "FIT" | "CROP" | "TILE";
/** A gradient stop: its colour (alpha included) and position 0..1. */
export type ColorStop = { color: RGBA; position: number };
/** Gradients: the space the stops blend in (schema Paint 41) and, for OKLCH / HSL, the way round the hue (Paint 42). */
export type InterpolationColorSpace = "DEFAULT" | "OKLAB" | "OKLCH" | "HSL" | "SRGB_LINEAR";
export type InterpolationHueMethod = "SHORTER" | "LONGER" | "INCREASING" | "DECREASING";

export interface PickerPaint {
  type: PaintType;
  /** SOLID: the colour (alpha kept at 1; the paint's `opacity` is its alpha, as Figma writes it) */
  color?: RGBA;
  /** The paint's opacity, 0..1 (default 1) */
  opacity?: number;
  /** Gradients: at least one (MIN_STOPS) */
  stops?: ColorStop[];
  /** Gradients: "Color interpolation" (absent: DEFAULT, the document's own space) */
  interpolationColorSpace?: InterpolationColorSpace;
  interpolationHueMethod?: InterpolationHueMethod;
  blendMode?: BlendMode;
  /** IMAGE */
  imageScaleMode?: ImageScaleMode;
  /** PATTERN (Figma's Paint fields): "Tile type", "Scale" (1 = 100 %), "Spacing" (a share of the tile), "Alignment" */
  patternTileType?: PatternTileType;
  scale?: number;
  patternSpacing?: { x: number; y: number };
  horizontalAlignment?: PatternAlignment;
  verticalAlignment?: PatternAlignment;
}

export const PAINT_TYPES: { value: PaintType; label: string; icon: string }[] = [
  { value: "SOLID", label: "Solid", icon: "24.fill.solid.small" },
  { value: "GRADIENT_LINEAR", label: "Linear", icon: "24.gradient.linear.small" },
  { value: "GRADIENT_RADIAL", label: "Radial", icon: "24.gradient.radial.small" },
  { value: "GRADIENT_ANGULAR", label: "Angular", icon: "24.gradient.angular.small" },
  { value: "GRADIENT_DIAMOND", label: "Diamond", icon: "24.gradient.diamond.small" },
  { value: "PATTERN", label: "Pattern", icon: "24.fill.pattern.small" },
  { value: "IMAGE", label: "Image", icon: "24.fill.image.small" },
  { value: "VIDEO", label: "Video", icon: "24.video" },
];

/**
 * The picker's paint tabs (Figma's live picker, popovers/fill-picker-*.txt: Solid, Gradient, Pattern, Image, Video, then
 * Shader — a browser of shader fills, not a paint here): one "Gradient" for the four gradient types, picked from its
 * "Paint type" dropdown.
 */
export type PaintTab = "SOLID" | "GRADIENT" | "PATTERN" | "IMAGE" | "VIDEO";
export const PAINT_TABS: { value: PaintTab; label: string; icon: string }[] = [
  { value: "SOLID", label: "Solid", icon: "24.fill.solid.small" },
  { value: "GRADIENT", label: "Gradient", icon: "24.gradient.linear.small" },
  { value: "PATTERN", label: "Pattern", icon: "24.fill.pattern.small" },
  { value: "IMAGE", label: "Image", icon: "24.fill.image.small" },
  { value: "VIDEO", label: "Video", icon: "24.video" },
];
export const GRADIENT_TYPES: { value: GradientType; label: string }[] = [
  { value: "GRADIENT_LINEAR", label: "Linear" },
  { value: "GRADIENT_RADIAL", label: "Radial" },
  { value: "GRADIENT_ANGULAR", label: "Angular" },
  { value: "GRADIENT_DIAMOND", label: "Diamond" },
];
export const paintTab = (t: PaintType): PaintTab => (isGradient(t) ? "GRADIENT" : (t as PaintTab));
/** An image or a video (its poster frame): previewed and scaled the same way. */
export const isMedia = (t: PaintType) => t === "IMAGE" || t === "VIDEO";

/** Figma's blend-mode menu, in its groups ("-" between them). */
export const BLEND_MODES: (BlendMode | "-")[] = [
  "NORMAL", "-", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "-", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE",
  "-", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "-", "DIFFERENCE", "EXCLUSION", "-", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
];
export const BLEND_LABEL: Record<BlendMode, string> = {
  NORMAL: "Normal", DARKEN: "Darken", MULTIPLY: "Multiply", LINEAR_BURN: "Plus darker", COLOR_BURN: "Color burn", LIGHTEN: "Lighten",
  SCREEN: "Screen", LINEAR_DODGE: "Plus lighter", COLOR_DODGE: "Color dodge", OVERLAY: "Overlay", SOFT_LIGHT: "Soft light",
  HARD_LIGHT: "Hard light", DIFFERENCE: "Difference", EXCLUSION: "Exclusion", HUE: "Hue", SATURATION: "Saturation", COLOR: "Color", LUMINOSITY: "Luminosity",
};

export function isGradient(t: PaintType): t is GradientType {
  return t.startsWith("GRADIENT_");
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Stops by position (a copy). */
export const sortStops = (stops: ColorStop[]) => [...stops].sort((a, b) => a.position - b.position);

/**
 * The gradient editor's "Color interpolation" (atlas 07 §7.3): the spaces in Figma's order, and the hue methods its
 * second select offers for OKLCH and HSL (Increasing, the default, and Decreasing; the files' Shorter / Longer read too).
 * The English of the options is unattested (keys `interpolation_color_space.*`, `interpolation_hue_method.*`).
 */
export const INTERPOLATION_SPACES: { value: InterpolationColorSpace; label: string }[] = [
  { value: "DEFAULT", label: "Default" },
  { value: "OKLAB", label: "OKLAB" },
  { value: "OKLCH", label: "OKLCH" },
  { value: "HSL", label: "HSL" },
  { value: "SRGB_LINEAR", label: "sRGB linear" },
];
export const HUE_METHODS: { value: InterpolationHueMethod; label: string }[] = [
  { value: "INCREASING", label: "Increasing" },
  { value: "DECREASING", label: "Decreasing" },
];
/** Whether a space blends round the hue circle (its hue method select shows). */
export const hasHue = (space: InterpolationColorSpace | undefined) => space === "OKLCH" || space === "HSL";

/** A gradient blended in `space`: a hue space starts Increasing (the UI's default), the others carry no hue method; Default is the field's absence. */
export function withInterpolation<P extends Pick<PickerPaint, "interpolationColorSpace" | "interpolationHueMethod">>(paint: P, space: InterpolationColorSpace): P {
  const next: P = { ...paint, interpolationColorSpace: space };
  if (hasHue(space)) next.interpolationHueMethod = paint.interpolationHueMethod === "DECREASING" ? "DECREASING" : "INCREASING";
  else delete next.interpolationHueMethod;
  if (space === "DEFAULT") delete next.interpolationColorSpace;
  return next;
}

/** The fewest stops a gradient keeps (Figma's GradientControl `minStops`, default 1 in the fill picker). */
export const MIN_STOPS = 1;

/** Two hues (degrees; NaN: none — a grey) put the chosen way round, as CSS Color 4 and the engine's GradientRamp. */
function fixHues(h1: number, h2: number, method: InterpolationHueMethod): [number, number] {
  if (Number.isNaN(h1) && Number.isNaN(h2)) return [0, 0];
  if (Number.isNaN(h1)) h1 = h2;
  if (Number.isNaN(h2)) h2 = h1;
  const d = h2 - h1;
  if (method === "SHORTER") {
    if (d > 180) h1 += 360;
    else if (d < -180) h2 += 360;
  } else if (method === "LONGER") {
    if (d > 0 && d < 180) h1 += 360;
    else if (d > -180 && d <= 0) h2 += 360;
  } else if (method === "INCREASING") {
    if (h2 < h1) h2 += 360;
  } else if (h1 < h2) h1 += 360;
  return [h1, h2];
}

/**
 * The colour `t` (0..1) of the way from `a` to `b` in a gradient's interpolation space — the engine's
 * `interpolateColor` (render/GradientRamp.cpp): alpha premultiplied into the non-hue components, the hue the chosen
 * way round. DEFAULT blends the channels straight, as the picker always has (unverified against Figma).
 */
export function mixInSpace(a: RGBA, b: RGBA, t: number, space: InterpolationColorSpace = "DEFAULT", hue: InterpolationHueMethod = "SHORTER"): RGBA {
  if (space === "DEFAULT") return mixRgba(a, b, t);
  const k = Math.min(1, Math.max(0, t));
  const alpha = a.a + (b.a - a.a) * k;
  const blend = (p: number, q: number) => {
    const v = p * a.a + (q * b.a - p * a.a) * k;
    return alpha > 1e-12 ? v / alpha : p + (q - p) * k;
  };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  let rgb: { r: number; g: number; b: number };
  if (space === "SRGB_LINEAR") {
    const [p, q] = [a, b].map((c) => [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)]);
    rgb = { r: linearToSrgb(blend(p[0], q[0])), g: linearToSrgb(blend(p[1], q[1])), b: linearToSrgb(blend(p[2], q[2])) };
  } else if (space === "OKLAB") {
    const [p, q] = [rgbToOklab(a), rgbToOklab(b)];
    rgb = oklabToRgb(blend(p[0], q[0]), blend(p[1], q[1]), blend(p[2], q[2]));
  } else if (space === "OKLCH") {
    // L, C, H; a chroma under 4e-6 has no hue (CSS's threshold for OKLCH).
    const lch = (c: RGBA) => {
      const [L, x, y] = rgbToOklab(c);
      const C = Math.hypot(x, y);
      const h = (Math.atan2(y, x) * 180) / Math.PI;
      return [L, C, C < 4e-6 ? NaN : h < 0 ? h + 360 : h];
    };
    const [p, q] = [lch(a), lch(b)];
    const [h1, h2] = fixHues(p[2], q[2], hue);
    const [L, C, H] = [blend(p[0], q[0]), blend(p[1], q[1]), ((h1 + (h2 - h1) * k) * Math.PI) / 180];
    rgb = oklabToRgb(L, C * Math.cos(H), C * Math.sin(H));
  } else {
    const hsl = (c: RGBA) => {
      const v = rgbToHsl(c);
      return [v.s > 1e-9 ? v.h : NaN, v.s, v.l];
    };
    const [p, q] = [hsl(a), hsl(b)];
    const [h1, h2] = fixHues(p[0], q[0], hue);
    rgb = hslToRgb({ h: h1 + (h2 - h1) * k, s: clamp(blend(p[1], q[1])), l: clamp(blend(p[2], q[2])) });
  }
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b), a: alpha };
}

/** The gradient's colour at `position` (0..1): interpolated between the stops around it, in its interpolation space. */
export function colorAt(stops: ColorStop[], position: number, space?: InterpolationColorSpace, hue?: InterpolationHueMethod): RGBA {
  const s = sortStops(stops);
  if (!s.length) return BLACK;
  if (position <= s[0].position) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (position <= s[i].position) {
      const a = s[i - 1];
      const b = s[i];
      const span = b.position - a.position;
      return mixInSpace(a.color, b.color, span > 0 ? (position - a.position) / span : 0, space, hue);
    }
  }
  return s[s.length - 1].color;
}

/** The colour the picker edits: SOLID's colour with the paint's opacity as alpha, or one stop's colour. */
export function targetColor(paint: PickerPaint, stop: number): RGBA {
  if (isGradient(paint.type)) return paint.stops?.[stop]?.color ?? paint.stops?.[0]?.color ?? BLACK;
  const c = paint.color ?? BLACK;
  return { r: c.r, g: c.g, b: c.b, a: paint.opacity ?? 1 };
}

/** The paint with the edited colour put back (SOLID: alpha → opacity; a gradient: into its stop). */
export function withTargetColor<P extends PickerPaint>(paint: P, stop: number, color: RGBA): P {
  if (isGradient(paint.type)) {
    const stops = (paint.stops ?? []).map((s, i) => (i === stop ? { ...s, color } : s));
    return { ...paint, stops };
  }
  return { ...paint, color: { r: color.r, g: color.g, b: color.b, a: 1 }, opacity: color.a };
}

const DEFAULT_FILL = { r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255 };
const DEFAULT_GRADIENT_END: RGBA = { r: 0x73 / 255, g: 0x73 / 255, b: 0x73 / 255, a: 1 };
const sameRgb = (a: RGBA, b: { r: number; g: number; b: number }) => Math.round(a.r * 255) === Math.round(b.r * 255) && Math.round(a.g * 255) === Math.round(b.g * 255) && Math.round(a.b * 255) === Math.round(b.b * 255);

/**
 * The paint as another type: SOLID → a gradient from its colour to the same
 * colour transparent; for Figma's default fill D9D9D9 live shows D9D9D9 100 % → 737373 100 %
 * (popovers/fill-picker-gradient_linear.txt, taken in one clean sequence; other colours: unverified); a gradient → SOLID: its first stop;
 * gradient ↔ gradient keeps the stops; IMAGE fills by default.
 */
export function convertPaint<P extends PickerPaint>(paint: P, type: PaintType): P {
  if (type === paint.type) return paint;
  // (An image, video, pattern or shader paint has no colour of its own: live's Image → Video → Shader → Gradient sequence
  // still gave D9D9D9 — the rectangle's own fill —, so the default fill stands in for it.)
  const base = !paint.color && !isGradient(paint.type) ? { ...DEFAULT_FILL, a: paint.opacity ?? 1 } : targetColor(paint, 0);
  if (isGradient(type)) {
    const stops = paint.stops && paint.stops.length >= 2 ? paint.stops : [{ color: { ...base, a: 1 }, position: 0 }, { color: sameRgb(base, DEFAULT_FILL) ? DEFAULT_GRADIENT_END : { ...base, a: 0 }, position: 1 }];
    return { ...paint, type, stops, opacity: isGradient(paint.type) ? paint.opacity : 1 };
  }
  if (type === "SOLID") {
    const first = sortStops(paint.stops ?? [])[0]?.color ?? paint.color ?? BLACK;
    return { ...paint, type, color: { r: first.r, g: first.g, b: first.b, a: 1 }, opacity: isGradient(paint.type) ? first.a : paint.opacity ?? 1 };
  }
  if (type === "PATTERN")
    return { ...paint, type, scale: 1, patternSpacing: { x: 0, y: 0 }, patternTileType: "RECTANGULAR", horizontalAlignment: "START", verticalAlignment: "START" };
  return { ...paint, type, imageScaleMode: paint.imageScaleMode ?? "FILL" };
}

/** A new stop at `position`, in the gradient's colour there (in `paint`'s interpolation space); returns the stops and its index. */
export function addStop(stops: ColorStop[], position: number, paint?: Pick<PickerPaint, "interpolationColorSpace" | "interpolationHueMethod">): { stops: ColorStop[]; index: number } {
  const p = Math.min(1, Math.max(0, position));
  const next = [...stops, { color: colorAt(stops, p, paint?.interpolationColorSpace, paint?.interpolationHueMethod), position: p }];
  return { stops: next, index: next.length - 1 };
}

/**
 * Where "Add gradient stop" puts the new stop (atlas 07 §7.3): halfway between the selected stop and the next one; the
 * last selected, halfway between the last two; a lone stop, at 1 when it sits below 0.5, else at 0.
 */
export function nextStopPosition(stops: ColorStop[], selected: number): number {
  const s = sortStops(stops);
  if (s.length === 0) return 0;
  if (s.length === 1) return s[0].position < 0.5 ? 1 : 0;
  const at = Math.max(0, s.findIndex((x) => x === stops[selected]));
  const i = at >= s.length - 1 ? s.length - 2 : at;
  return (s[i].position + s[i + 1].position) / 2;
}

export const moveStop = (stops: ColorStop[], i: number, position: number) => stops.map((s, k) => (k === i ? { ...s, position: Math.min(1, Math.max(0, position)) } : s));
export const removeStop = (stops: ColorStop[], i: number) => (stops.length > MIN_STOPS ? stops.filter((_, k) => k !== i) : stops);
/** A copy of stop `i` (its colour and any other field) at `position`, appended; returns the stops and its index (⌥-press). */
export function duplicateStop(stops: ColorStop[], i: number, position: number): { stops: ColorStop[]; index: number } {
  const next = [...stops, { ...stops[i], position: Math.min(1, Math.max(0, position)) }];
  return { stops: next, index: next.length - 1 };
}
/** "Redistribute stops": by their order, evenly from 0 to 1 (i / (n − 1)); a lone stop stays. */
export function redistributeStops(stops: ColorStop[]): ColorStop[] {
  if (stops.length < 2) return stops;
  const order = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position);
  const out = [...stops];
  order.forEach(({ s, i }, k) => (out[i] = { ...s, position: k / (stops.length - 1) }));
  return out;
}

/** A stop's position as the bar places it (atlas 07 §7.2): ⇧ snaps to 5 % steps. */
export const snapStop = (position: number, shift: boolean) => Math.min(1, Math.max(0, shift ? 0.05 * Math.round(position / 0.05) : position));
/** How near a neighbour a dropped stop is pulled onto it (2 %), and how far inside it then sits (keeping its order). */
export const STOP_MAGNET = 0.02;
const MAGNET_INSIDE = 0.0001;
/**
 * A stop dropped within 2 % of another stop goes to that stop ± 0.0001, on its own side, so the two touch and keep their
 * order; ⌥ turns this off.
 */
export function magnetStop(stops: ColorStop[], i: number, position: number): number {
  let best: number | null = null;
  for (let k = 0; k < stops.length; k++) {
    if (k === i) continue;
    const d = Math.abs(stops[k].position - position);
    if (d <= STOP_MAGNET && (best === null || d < Math.abs(stops[best].position - position))) best = k;
  }
  if (best === null) return position;
  const n = stops[best].position;
  return Math.min(1, Math.max(0, position < n || (position === n && n === 1) ? n - MAGNET_INSIDE : n + MAGNET_INSIDE));
}

/** Mirror the gradient (positions 1 − p). */
export const flipStops = (stops: ColorStop[]) => stops.map((s) => ({ ...s, position: 1 - s.position }));
/** "Flip gradient": the stops mirrored and an Increasing hue Decreasing (and back), so the colours run the same way. */
export function flipGradient<P extends PickerPaint>(paint: P): P {
  const hue = paint.interpolationHueMethod;
  const swapped = hue === "INCREASING" ? "DECREASING" : hue === "DECREASING" ? "INCREASING" : hue;
  return { ...paint, stops: flipStops(paint.stops ?? []), ...(hue ? { interpolationHueMethod: swapped } : {}) };
}

/** The CSS `in <space> [<hue> hue]` of a gradient's interpolation (empty for DEFAULT). */
export function cssInterpolation(paint: Pick<PickerPaint, "interpolationColorSpace" | "interpolationHueMethod">): string {
  const space = paint.interpolationColorSpace ?? "DEFAULT";
  if (space === "DEFAULT") return "";
  const name = { OKLAB: "oklab", OKLCH: "oklch", HSL: "hsl", SRGB_LINEAR: "srgb-linear" }[space];
  return hasHue(space) ? `in ${name} ${(paint.interpolationHueMethod ?? "SHORTER").toLowerCase()} hue` : `in ${name}`;
}

/** CSS for a paint's preview (swatches, the stop bar): a colour, or a left-to-right gradient of its stops. */
export function paintCss(paint: PickerPaint, direction: "preview" | "bar" = "preview"): string {
  if (!isGradient(paint.type)) {
    if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") return "transparent";
    return rgbaToCss(targetColor(paint, 0));
  }
  const sorted = sortStops(paint.stops ?? []);
  // (A lone stop: CSS wants two.)
  const list = (sorted.length === 1 ? [sorted[0], sorted[0]] : sorted).map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  // The stops blended in the paint's space, as CSS Color 4 does (the bar's preview, atlas 07 §7.3).
  const space = cssInterpolation(paint);
  const lead = (first: string) => (space ? `${first} ${space}` : first);
  if (direction === "bar" || paint.type === "GRADIENT_LINEAR") return `linear-gradient(${lead("90deg")}, ${list})`;
  if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_DIAMOND") return `radial-gradient(${lead("circle")}, ${list})`;
  return `conic-gradient(${lead("from 90deg")}, ${list})`;
}
