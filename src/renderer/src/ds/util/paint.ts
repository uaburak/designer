import { mixRgba, rgbaToCss, type RGBA } from "./color";

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

export interface PickerPaint {
  type: PaintType;
  /** SOLID: the colour (alpha kept at 1; the paint's `opacity` is its alpha, as Figma writes it) */
  color?: RGBA;
  /** The paint's opacity, 0..1 (default 1) */
  opacity?: number;
  /** Gradients: at least two */
  stops?: ColorStop[];
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

/** The gradient's colour at `position` (0..1): interpolated between the stops around it. */
export function colorAt(stops: ColorStop[], position: number): RGBA {
  const s = sortStops(stops);
  if (!s.length) return BLACK;
  if (position <= s[0].position) return s[0].color;
  for (let i = 1; i < s.length; i++) {
    if (position <= s[i].position) {
      const a = s[i - 1];
      const b = s[i];
      const span = b.position - a.position;
      return mixRgba(a.color, b.color, span > 0 ? (position - a.position) / span : 0);
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

/** A new stop at `position`, in the gradient's colour there; returns the stops and its index. */
export function addStop(stops: ColorStop[], position: number): { stops: ColorStop[]; index: number } {
  const p = Math.min(1, Math.max(0, position));
  const next = [...stops, { color: colorAt(stops, p), position: p }];
  return { stops: next, index: next.length - 1 };
}

export const moveStop = (stops: ColorStop[], i: number, position: number) => stops.map((s, k) => (k === i ? { ...s, position: Math.min(1, Math.max(0, position)) } : s));
export const removeStop = (stops: ColorStop[], i: number) => (stops.length > 2 ? stops.filter((_, k) => k !== i) : stops);
/** Mirror the gradient (positions 1 − p). */
export const flipStops = (stops: ColorStop[]) => stops.map((s) => ({ ...s, position: 1 - s.position }));

/** CSS for a paint's preview (swatches, the stop bar): a colour, or a left-to-right gradient of its stops. */
export function paintCss(paint: PickerPaint, direction: "preview" | "bar" = "preview"): string {
  if (!isGradient(paint.type)) {
    if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") return "transparent";
    return rgbaToCss(targetColor(paint, 0));
  }
  const list = sortStops(paint.stops ?? []).map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  if (direction === "bar" || paint.type === "GRADIENT_LINEAR") return `linear-gradient(90deg, ${list})`;
  if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_DIAMOND") return `radial-gradient(circle, ${list})`;
  return `conic-gradient(from 90deg, ${list})`;
}
