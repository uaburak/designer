import { mixRgba, rgbaToCss, type RGBA } from "./color";

/**
 * The paint the ColorPicker edits — the subset of Figma's Paint it touches,
 * under Figma's own names (kiwi `Paint`: type, color, opacity, stops,
 * blendMode, imageScaleMode), so the editor maps it 1:1. Fields it does not
 * know (transform, image hash, variable bindings…) pass through untouched.
 */
export type PaintType = "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE";
export type GradientType = Exclude<PaintType, "SOLID" | "IMAGE">;
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
}

export const PAINT_TYPES: { value: PaintType; label: string; icon: string }[] = [
  { value: "SOLID", label: "Solid", icon: "24.fill.solid.small" },
  { value: "GRADIENT_LINEAR", label: "Linear", icon: "24.gradient.linear.small" },
  { value: "GRADIENT_RADIAL", label: "Radial", icon: "24.gradient.radial.small" },
  { value: "GRADIENT_ANGULAR", label: "Angular", icon: "24.gradient.angular.small" },
  { value: "GRADIENT_DIAMOND", label: "Diamond", icon: "24.gradient.diamond.small" },
  { value: "IMAGE", label: "Image", icon: "24.fill.image.small" },
];

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

export const isGradient = (t: PaintType): t is GradientType => t.startsWith("GRADIENT_");

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

/**
 * The paint as another type: SOLID → a gradient from its colour to the same
 * colour transparent (Figma's default); a gradient → SOLID: its first stop;
 * gradient ↔ gradient keeps the stops; IMAGE fills by default.
 */
export function convertPaint<P extends PickerPaint>(paint: P, type: PaintType): P {
  if (type === paint.type) return paint;
  const base = targetColor(paint, 0);
  if (isGradient(type)) {
    const stops = paint.stops && paint.stops.length >= 2 ? paint.stops : [{ color: { ...base, a: 1 }, position: 0 }, { color: { ...base, a: 0 }, position: 1 }];
    return { ...paint, type, stops, opacity: isGradient(paint.type) ? paint.opacity : 1 };
  }
  if (type === "SOLID") {
    const first = sortStops(paint.stops ?? [])[0]?.color ?? paint.color ?? BLACK;
    return { ...paint, type, color: { r: first.r, g: first.g, b: first.b, a: 1 }, opacity: isGradient(paint.type) ? first.a : paint.opacity ?? 1 };
  }
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
    if (paint.type === "IMAGE") return "transparent";
    return rgbaToCss(targetColor(paint, 0));
  }
  const list = sortStops(paint.stops ?? []).map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 1000) / 10}%`).join(", ");
  if (direction === "bar" || paint.type === "GRADIENT_LINEAR") return `linear-gradient(90deg, ${list})`;
  if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_DIAMOND") return `radial-gradient(circle, ${list})`;
  return `conic-gradient(from 90deg, ${list})`;
}
