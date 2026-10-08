/**
 * Paints as the Fill / Stroke rows and the colour picker see them
 * (schema/document.kiwi `Paint`, docs/engine.md §6.5): every type —
 * SOLID, GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND, IMAGE — mapped 1:1
 * to the DS picker's paint (`PickerPaint`, Figma's names), the row's label
 * and swatch, image references (20-byte SHA-1 `image.hash`), the image's
 * progressive-display fields (`thumbHash`, `imageThumbnail`) and the image
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

/** IMAGE, or VIDEO: a video fill draws its poster frame (`image`) as an image fill does. */
export const isImageLike = (p: { type?: string }): boolean => p.type === "IMAGE" || p.type === "VIDEO";

/** The paint's image (hex hash; a video's poster frame), or null. */
export const paintImageHash = (p: FullPaint): string | null => (isImageLike(p) ? hashHex(p.image?.hash) : null);

/**
 * What a paint carries for progressive display (docs/schema.md: `thumbHash` field 25, `imageThumbnail` field 9):
 * Evan Wallace's ThumbHash of the image (drawn in the first frame), and Figma's low-res copy of it — the image
 * itself when it is at most 512 px, as Figma's own files have it — fetched instead of the full image when the paint
 * covers no more than 512 device px.
 */
export interface ProgressiveImage {
  thumbHash: Uint8Array | number[] | null;
  /** The tier's hash (hex); `width` / `height` when known. */
  thumbnail: { hash: string; width?: number; height?: number } | null;
}

/** The two fields on the wire: `thumbHash` as numbers (kiwi byte[]), `imageThumbnail` an Image with the tier's 20-byte hash. */
export interface ProgressivePaintFields {
  thumbHash?: number[];
  imageThumbnail?: { hash: number[] };
}

/** The Paint fields for `progressive` on the engine's wire: byte[] as numbers; nothing for what isn't known. */
export function progressivePaintFields(progressive: Partial<ProgressiveImage> | null | undefined): ProgressivePaintFields {
  const out: ProgressivePaintFields = {};
  if (progressive?.thumbHash?.length) out.thumbHash = Array.from(progressive.thumbHash as ArrayLike<number>);
  if (progressive?.thumbnail?.hash && /^[0-9a-f]{40}$/i.test(progressive.thumbnail.hash)) out.imageThumbnail = { hash: hashBytes(progressive.thumbnail.hash.toLowerCase()) };
  return out;
}

/** ThumbHash bytes as they may arrive (Uint8Array, kiwi byte[] as numbers, or base64 text), or null. */
export function thumbHashBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v.length ? v : null;
  if (Array.isArray(v)) return v.length && v.every((b) => typeof b === "number") ? Uint8Array.from(v as number[]) : null;
  if (typeof v === "string" && v) {
    try {
      const bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The paint's `thumbHash` bytes, or null. */
export const paintThumbHash = (p: FullPaint): Uint8Array | null => thumbHashBytes(p.thumbHash);

/** The paint's low-res copy (`imageThumbnail.hash`, hex), or null. */
export const paintThumbnailHash = (p: FullPaint): string | null => hashHex((p.imageThumbnail as { hash?: ImageHash } | undefined)?.hash);

/** A VIDEO paint's video file (Paint.video.hash, the store's blob), as hex. */
export const paintVideoHash = (p: FullPaint): string | null =>
  p.type === "VIDEO" ? hashHex((p as { video?: { hash?: ImageHash } }).video?.hash) : null;

/** An IMAGE paint with an image but without a ThumbHash or a low-res copy: a candidate for the write-back. */
export const paintLacksProgressive = (p: FullPaint): boolean => isImageLike(p) && !!paintImageHash(p) && (!paintThumbHash(p) || !paintThumbnailHash(p));

/** The paint with `progressive`'s fields added where it lacks them (nothing else changes). */
export function withProgressive(p: FullPaint, progressive: ProgressiveImage): FullPaint {
  const fields = progressivePaintFields(progressive);
  const out: FullPaint = { ...p };
  if (fields.thumbHash && !paintThumbHash(p)) out.thumbHash = fields.thumbHash;
  if (fields.imageThumbnail && !paintThumbnailHash(p)) out.imageThumbnail = fields.imageThumbnail;
  return out;
}

/**
 * A new IMAGE paint for an imported image (Figma: Fill mode, full opacity), with its ThumbHash and low-res copy
 * when `size` carries them (an `ImportedImage` does).
 */
export function imagePaint(hex: string, size: { width: number; height: number } & Partial<ProgressiveImage>, name?: string): FullPaint {
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
    ...progressivePaintFields(size),
  };
}

/**
 * A new VIDEO paint (help.figma.com 8878274530455: "videos are a type of fill"): the video file (`video.hash`) and its
 * poster frame as the paint's image (what the canvas, exports and thumbnails draw — Figma stores one too), Fill mode.
 */
export function videoPaint(videoHex: string, poster: { hash: string; width: number; height: number } & Partial<ProgressiveImage>, name?: string): FullPaint {
  return { ...imagePaint(poster.hash, poster, name), type: "VIDEO", video: { hash: hashBytes(videoHex) } } as FullPaint;
}

/** The paint for an import: a video's VIDEO paint, else an IMAGE paint. */
export function mediaPaint(img: { hash: string; width: number; height: number; name?: string; video?: string } & Partial<ProgressiveImage>): FullPaint {
  return img.video ? videoPaint(img.video, img, img.name) : imagePaint(img.hash, img, img.name);
}

/**
 * Prototype › Video for a placed video: autoplay, loop and sound on (unverified: Design+Code's Figma handbook; the
 * help doesn't give Figma's defaults).
 */
export const DEFAULT_VIDEO_PLAYBACK = { autoplay: true, mediaLoop: true, muted: false } as const;

// ---- The DS picker's paint ---------------------------------------------------------------------

const toPickerScale = (m: SchemaScaleMode | undefined): PickerPaint["imageScaleMode"] => (m === "STRETCH" ? "CROP" : m ?? "FILL");
const toSchemaScale = (m: PickerPaint["imageScaleMode"]): SchemaScaleMode => (m === "CROP" ? "STRETCH" : m ?? "FILL");

/** The picker's view of a paint (its other fields are the editor's to keep). */
export function toPicker(p: FullPaint): PickerPaint {
  const type = (["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE", "VIDEO"].includes(p.type) ? p.type : "SOLID") as PickerPaint["type"];
  const blendMode = p.blendMode && p.blendMode !== "PASS_THROUGH" ? p.blendMode : undefined;
  const base: PickerPaint = { type, opacity: p.opacity ?? 1, ...(blendMode ? { blendMode } : {}) };
  if (type === "SOLID") return { ...base, color: { ...(p.color ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 } };
  // A video fill is shown and scaled as its poster image (scale mode, adjustments).
  if (type === "IMAGE" || type === "VIDEO") return { ...base, imageScaleMode: toPickerScale(p.imageScaleMode) };
  return { ...base, stops: (p.stops ?? []).map((s) => ({ color: { ...s.color }, position: s.position })) };
}

/**
 * The picker's edit put back on the paint: a type change brings Figma's defaults (a new gradient's top-to-bottom
 * transform, an image's Fill mode) and drops what the old type had; a same-type edit keeps every other field. Image ↔
 * Video keeps the picture (the poster frame), leaving Video drops the video.
 */
export function fromPicker(base: FullPaint, next: PickerPaint): FullPaint {
  const media = (t: string) => t === "IMAGE" || t === "VIDEO";
  const out: FullPaint = { ...base, type: next.type, opacity: next.opacity ?? base.opacity ?? 1 };
  if (base.type === "VIDEO" && next.type !== "VIDEO") delete (out as { video?: unknown }).video;
  if (next.blendMode) out.blendMode = next.blendMode;
  if (next.type === "SOLID") {
    out.color = next.color ? { ...next.color, a: 1 } : (base.color ?? { r: 0, g: 0, b: 0, a: 1 });
    delete out.stops;
    if (base.type !== "SOLID") delete out.transform;
    dropImage(out);
  } else if (media(next.type)) {
    out.imageScaleMode = toSchemaScale(next.imageScaleMode);
    delete out.stops;
    delete out.color;
    if (!media(base.type)) out.transform = IDENTITY_MATRIX;
  } else {
    out.stops = (next.stops ?? []).map((s) => ({ color: { ...s.color }, position: s.position }));
    delete out.color;
    dropImage(out);
    if (!isGradientType(base.type)) out.transform = next.type === "GRADIENT_LINEAR" ? DEFAULT_LINEAR_TRANSFORM : IDENTITY_MATRIX;
  }
  return out;
}

function dropImage(p: FullPaint) {
  for (const k of ["image", "imageThumbnail", "thumbHash", "imageScaleMode", "rotation", "scale", "paintFilter", "originalImageWidth", "originalImageHeight"] as const) delete p[k];
}

// ---- A row's view ------------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = {
  GRADIENT_LINEAR: "Linear",
  GRADIENT_RADIAL: "Radial",
  GRADIENT_ANGULAR: "Angular",
  GRADIENT_DIAMOND: "Diamond",
  IMAGE: "Image",
  VIDEO: "Video",
};

/** The row's text: the hex for a solid, Figma's type name otherwise ("Linear", "Image"). */
export function paintLabel(p: FullPaint): string {
  return p.type === "SOLID" ? colorToHex(p.color ?? { r: 0, g: 0, b: 0 }) : TYPE_LABEL[p.type] ?? "Paint";
}

/** The swatch's CSS background: the colour, the gradient, or the image (its object URL) covering the chit. */
export function paintSwatch(p: FullPaint, imageUrl?: string | null): string {
  if (isImageLike(p)) return imageUrl ? `center / cover no-repeat url("${imageUrl}")` : "var(--figma-color-bg-tertiary)";
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

/**
 * The picker's "Rotate gradient": the gradient turned 90° clockwise about the layer's middle — its transform (layer
 * → gradient space) after the quarter turn the layer space takes first (left-to-right becomes top-to-bottom, Figma's
 * new linear gradient).
 */
export function gradientRotated90(p: FullPaint): FullPaint {
  const g = p.transform ?? IDENTITY_MATRIX;
  const m = DEFAULT_LINEAR_TRANSFORM;
  return {
    ...p,
    transform: {
      m00: g.m00 * m.m00 + g.m01 * m.m10,
      m01: g.m00 * m.m01 + g.m01 * m.m11,
      m02: g.m00 * m.m02 + g.m01 * m.m12 + g.m02,
      m10: g.m10 * m.m00 + g.m11 * m.m10,
      m11: g.m10 * m.m01 + g.m11 * m.m11,
      m12: g.m10 * m.m02 + g.m11 * m.m12 + g.m12,
    },
  };
}

// ---- Gradients in Selection colors ---------------------------------------------------------------

/** A gradient's identity in Selection colors: its type and stops (not its transform, as Figma groups them). */
export function gradientKey(p: FullPaint): string {
  return `${p.type}|${orderedStops(p)
    .map((s) => `${colorToHex(s.color)}${Math.round((s.color.a ?? 1) * 100)}@${Math.round(s.position * 1000)}`)
    .join(",")}|${Math.round((p.opacity ?? 1) * 100)}`;
}
