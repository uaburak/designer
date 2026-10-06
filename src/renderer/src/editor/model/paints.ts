/**
 * Paints as the Fill / Stroke rows and the colour picker see them
 * (schema/document.kiwi `Paint`, docs/engine.md §6.5): every type —
 * SOLID, GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND, IMAGE — mapped 1:1
 * to the DS picker's paint (`PickerPaint`, Figma's names), the row's label
 * and swatch, image references (20-byte SHA-1 `image.hash`) and the image
 * adjustments (`paintFilter`). Plain data; no engine, no React.
 */
import { colorAt, paintCss, sortStops, type PickerPaint } from "@/ds/util/paint";
import type { Matrix, Paint, PaintFilter } from "@/engine/codec";
import { colorToHex, toPercent } from "./color";

export type { PaintType } from "@/engine/codec";
import type { ImageScaleMode as SchemaScaleMode, PaintType } from "@/engine/codec";

export type { PaintFilter };

/** A paint with every field (codec.ts types them all since E5). */
export type FullPaint = Paint;

/** `Image.hash` on the engine's JSON wire: the 20 bytes as numbers (a 40-digit hex string is read too). */
export type ImageHash = number[] | string;

export const IDENTITY_MATRIX: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
/** Figma's new linear gradient runs top to bottom ([[0, 1, 0], [−1, 0, 1]] in its files). */
export const DEFAULT_LINEAR_TRANSFORM: Matrix = { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 };

export const isGradientType = (t: string): boolean => t.startsWith("GRADIENT_");

/** The 20-byte hash as lower-case hex (the store's blob key), or null. */
export function hashHex(hash: ImageHash | Uint8Array | undefined | null): string | null {
  if (!hash) return null;
  if (typeof hash === "string") return /^[0-9a-f]{40}$/i.test(hash) ? hash.toLowerCase() : null;
  const bytes = Array.from(hash as ArrayLike<number>);
  if (bytes.length !== 20) return null;
  return bytes.map((b) => (b & 255).toString(16).padStart(2, "0")).join("");
}

/** Hex → the wire's byte array. */
export function hashBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 40; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** The paint's image (hex hash), or null. */
export const paintImageHash = (p: FullPaint): string | null => (p.type === "IMAGE" ? hashHex(p.image?.hash) : null);

/** A new IMAGE paint for an imported image (Figma: Fill mode, full opacity). */
export function imagePaint(hex: string, size: { width: number; height: number }, name?: string): FullPaint {
  return {
    type: "IMAGE",
    image: { hash: hashBytes(hex), ...(name ? { name } : {}) },
    imageScaleMode: "FILL",
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
    transform: IDENTITY_MATRIX,
    originalImageWidth: size.width,
    originalImageHeight: size.height,
  };
}

// ---- The DS picker's paint ---------------------------------------------------------------------

const toPickerScale = (m: SchemaScaleMode | undefined): PickerPaint["imageScaleMode"] => (m === "STRETCH" ? "CROP" : m ?? "FILL");
const toSchemaScale = (m: PickerPaint["imageScaleMode"]): SchemaScaleMode => (m === "CROP" ? "STRETCH" : m ?? "FILL");

/** The picker's view of a paint (its other fields are the editor's to keep). */
export function toPicker(p: FullPaint): PickerPaint {
  const type = (["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"].includes(p.type) ? p.type : "SOLID") as PaintType;
  const blendMode = p.blendMode && p.blendMode !== "PASS_THROUGH" ? p.blendMode : undefined;
  const base: PickerPaint = { type, opacity: p.opacity ?? 1, ...(blendMode ? { blendMode } : {}) };
  if (type === "SOLID") return { ...base, color: { ...(p.color ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 } };
  if (type === "IMAGE") return { ...base, imageScaleMode: toPickerScale(p.imageScaleMode) };
  return { ...base, stops: (p.stops ?? []).map((s) => ({ color: { ...s.color }, position: s.position })) };
}

/**
 * The picker's edit put back on the paint: a type change brings Figma's defaults (a new gradient's top-to-bottom
 * transform, an image's Fill mode) and drops what the old type had; a same-type edit keeps every other field.
 */
export function fromPicker(base: FullPaint, next: PickerPaint): FullPaint {
  const out: FullPaint = { ...base, type: next.type, opacity: next.opacity ?? base.opacity ?? 1 };
  if (next.blendMode) out.blendMode = next.blendMode;
  if (next.type === "SOLID") {
    out.color = next.color ? { ...next.color, a: 1 } : (base.color ?? { r: 0, g: 0, b: 0, a: 1 });
    delete out.stops;
    if (base.type !== "SOLID") delete out.transform;
    dropImage(out);
  } else if (next.type === "IMAGE") {
    out.imageScaleMode = toSchemaScale(next.imageScaleMode);
    delete out.stops;
    delete out.color;
    if (base.type !== "IMAGE") out.transform = IDENTITY_MATRIX;
  } else {
    out.stops = (next.stops ?? []).map((s) => ({ color: { ...s.color }, position: s.position }));
    delete out.color;
    dropImage(out);
    if (!isGradientType(base.type)) out.transform = next.type === "GRADIENT_LINEAR" ? DEFAULT_LINEAR_TRANSFORM : IDENTITY_MATRIX;
  }
  return out;
}

function dropImage(p: FullPaint) {
  for (const k of ["image", "imageScaleMode", "rotation", "scale", "paintFilter", "originalImageWidth", "originalImageHeight"] as const) delete p[k];
}

// ---- A row's view ------------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = {
  GRADIENT_LINEAR: "Linear",
  GRADIENT_RADIAL: "Radial",
  GRADIENT_ANGULAR: "Angular",
  GRADIENT_DIAMOND: "Diamond",
  IMAGE: "Image",
};

/** The row's text: the hex for a solid, Figma's type name otherwise ("Linear", "Image"). */
export function paintLabel(p: FullPaint): string {
  return p.type === "SOLID" ? colorToHex(p.color ?? { r: 0, g: 0, b: 0 }) : TYPE_LABEL[p.type] ?? "Paint";
}

/** The swatch's CSS background: the colour, the gradient, or the image (its object URL) covering the chit. */
export function paintSwatch(p: FullPaint, imageUrl?: string | null): string {
  if (p.type === "IMAGE") return imageUrl ? `center / cover no-repeat url("${imageUrl}")` : "var(--figma-color-bg-tertiary)";
  if (isGradientType(p.type)) return paintCss(toPicker(p));
  return colorToHex(p.color ?? { r: 0, g: 0, b: 0 });
}

export const paintOpacityPercent = (p: FullPaint) => toPercent(p.opacity ?? 1);

/** Gradient stops in order, for the swatch and Selection colors. */
export const orderedStops = (p: FullPaint) => sortStops((p.stops ?? []).map((s) => ({ color: { ...s.color, a: s.color.a ?? 1 }, position: s.position })));

/** The gradient's colour at `t` (0…1). */
export const gradientColorAt = (p: FullPaint, t: number) => colorAt(orderedStops(p), t);

// ---- Image adjustments ---------------------------------------------------------------------------

/** Figma's image adjustment sliders, in its order, and the PaintFilterMessage field each writes. */
export const IMAGE_ADJUSTMENTS: { field: keyof PaintFilter & string; label: string }[] = [
  { field: "exposure", label: "Exposure" },
  { field: "contrast", label: "Contrast" },
  { field: "vibrance", label: "Saturation" },
  { field: "temperature", label: "Temperature" },
  { field: "tint", label: "Tint" },
  { field: "highlights", label: "Highlights" },
  { field: "shadows", label: "Shadows" },
];

/** The paint with one adjustment set (−100…100 in the UI, −1…1 stored; 0 removes it). */
export function withAdjustment(p: FullPaint, field: string, uiValue: number): FullPaint {
  const filter: PaintFilter = { ...(p.paintFilter ?? {}) };
  const v = Math.max(-1, Math.min(1, uiValue / 100));
  if (v === 0) delete filter[field];
  else filter[field] = v;
  const out: FullPaint = { ...p, paintFilter: filter };
  if (!Object.keys(filter).length) delete out.paintFilter;
  return out;
}

/** "Rotate 90°": Figma turns the image clockwise in steps of 90 (`rotation`, degrees). */
export function rotated90(p: FullPaint): FullPaint {
  return { ...p, rotation: (((p.rotation ?? 0) + 90) % 360 + 360) % 360 };
}

// ---- Gradients in Selection colors ---------------------------------------------------------------

/** A gradient's identity in Selection colors: its type and stops (not its transform, as Figma groups them). */
export function gradientKey(p: FullPaint): string {
  return `${p.type}|${orderedStops(p)
    .map((s) => `${colorToHex(s.color)}${Math.round((s.color.a ?? 1) * 100)}@${Math.round(s.position * 1000)}`)
    .join(",")}|${Math.round((p.opacity ?? 1) * 100)}`;
}
