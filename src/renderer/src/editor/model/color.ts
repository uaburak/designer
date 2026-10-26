/** Document colours (0..1 channels, docs/schema.md §3.3) ↔ the panel's "#rrggbb" + opacity %. */
import type { Color, Paint } from "@/engine/codec";

const byte = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255);

/** "#rrggbb", lower case (the DS fields' format; they show it upper case). */
export function colorToHex(c: Pick<Color, "r" | "g" | "b">): string {
  return `#${[c.r, c.g, c.b].map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
}

/** "#rrggbb" → a Color with `a`. */
export function hexToColor(hex: string, a = 1): Color {
  const d = hex.replace("#", "");
  const n = (i: number) => parseInt(d.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a };
}

/** 0..1 → a whole percent (Figma shows paint opacity as an integer %). */
export const toPercent = (v: number) => Math.round(v * 100);

/** A solid paint's visible colour as a hex + percent pair. */
export function paintHex(paint: Paint): string {
  return colorToHex(paint.color ?? { r: 0, g: 0, b: 0 });
}

export function paintOpacity(paint: Paint): number {
  return toPercent(paint.opacity ?? 1);
}

/** Figma's default solid paint. */
export function solidPaint(hex: string, opacity = 1): Paint {
  return { type: "SOLID", color: hexToColor(hex), opacity, visible: true };
}

/** Equal colours, compared as the panel shows them (8-bit channels). */
export const sameColor = (a: Color | undefined, b: Color | undefined) =>
  !!a && !!b && byte(a.r) === byte(b.r) && byte(a.g) === byte(b.g) && byte(a.b) === byte(b.b) && Math.abs((a.a ?? 1) - (b.a ?? 1)) < 1 / 512;

/**
 * Figma's default page colour (#F5F5F5 exactly as a new page stores it) is the one a page shows in the theme's canvas
 * colour (the engine's Renderer::draw does the same). An #F5F5F5 the user picks is their colour, not the default: it is
 * stored a hair off (245.2 / 255, still F5 in every field) so it stays #F5F5F5 in the dark theme too.
 */
const F5 = Math.fround(245 / 255);
export const isDefaultPageColor = (c: Color | undefined) =>
  !!c && [c.r, c.g, c.b].every((v) => Math.abs(Math.fround(v) - F5) < 1e-5) && Math.abs((c.a ?? 1) - 1) < 1 / 512;
/** The page colour to store for one the user chose: a chosen #F5F5F5 is kept apart from the theme-following default. */
export function chosenPageColor(c: Color): Color {
  if (!sameColor(c, { r: F5, g: F5, b: F5, a: c.a ?? 1 })) return c;
  const v = 245.2 / 255;
  return { ...c, r: v, g: v, b: v };
}

/** Relative luminance (sRGB), for "is this page dark?" */
export function luminance(c: Pick<Color, "r" | "g" | "b">): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
