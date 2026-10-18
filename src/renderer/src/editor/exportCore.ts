/**
 * The engine's export (E7) as a file's bytes, for any engine and image source — the editor (exporting.ts, the file's
 * image store) and the developer preview viewer (src/viewer, the preview's images). PNG / JPEG are drawn by the engine
 * and encoded here (PNG with Figma's 72 × scale DPI); SVG / PDF are written by the engine with the images they inline
 * handed to it first. No editor state: this module only needs an Engine.
 */
import type { ColorProfile, Engine } from "@/engine/Engine";
import type { ExportOutput, Guid, Pixels } from "@/engine/codec";
import { formatOf, isVectorFormat, pngWithDpi, qualityOf, type ExportSettings } from "./model/exports";

/** An image file by its SHA-1 hash (the file's or the preview's images), or null. */
export type ImageBytes = (hash: string) => Promise<Uint8Array | null>;

/** How long an export waits for fonts and images it draws before drawing what there is. */
const READY_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The image type of a file's first bytes. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

/** The engine's export, waiting (a while) for what it draws to arrive. */
async function exportWhenReady(engine: Engine, refs: readonly Guid[], settings: ExportSettings): Promise<ExportOutput> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let out = engine.exportNodes(refs, settings);
  while (out.status === "busy" && Date.now() < deadline && !engine.destroyed) {
    await sleep(60);
    out = engine.exportNodes(refs, settings);
  }
  if (out.status === "busy") out = engine.exportNodes(refs, settings, { allowPending: true });
  return out;
}

/**
 * The profile an export's pixels are written in (atlas 15 §4, Color profile): sRGB or Display P3 as the setting says,
 * "Same as file" (DOCUMENT) the document's own.
 */
export function exportProfile(settings: ExportSettings, document: ColorProfile): ColorProfile {
  return settings.colorProfile === "SRGB" ? "SRGB" : settings.colorProfile === "DISPLAY_P3_V4" ? "DISPLAY_P3" : document;
}

// The linear-light matrices between the two profiles (ds/util/color.ts p3ToSrgb / srgbToP3); both use the sRGB curve.
const P3_TO_SRGB = [1.2249401, -0.2249404, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735];
const SRGB_TO_P3 = [0.8224621, 0.177538, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199];

/**
 * Straight RGBA pixels from one profile's numbers to the other's, so they look the same (into sRGB, P3 colours outside
 * it clamp): each byte through the sRGB curve (a 256-entry table), the matrix, and back (a 4096-entry table).
 */
export function convertPixels(pixels: Uint8Array, from: ColorProfile, to: ColorProfile): Uint8Array {
  if (from === to) return pixels;
  const m = from === "DISPLAY_P3" ? P3_TO_SRGB : SRGB_TO_P3;
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lin[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  const back = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    const v = i / 4095;
    back[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  }
  const enc = (v: number) => back[v <= 0 ? 0 : v >= 1 ? 4095 : Math.round(v * 4095)];
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = lin[pixels[i]], g = lin[pixels[i + 1]], b = lin[pixels[i + 2]];
    out[i] = enc(m[0] * r + m[1] * g + m[2] * b);
    out[i + 1] = enc(m[3] * r + m[4] * g + m[5] * b);
    out[i + 2] = enc(m[6] * r + m[7] * g + m[8] * b);
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

/** Straight RGBA → a PNG or JPEG file, tagged with its profile (a Display P3 file carries the P3 profile). */
export async function encodePixels(p: Pixels, type: "image/png" | "image/jpeg", quality?: number, profile: ColorProfile = "SRGB"): Promise<Uint8Array> {
  const colorSpace: PredefinedColorSpace = profile === "DISPLAY_P3" ? "display-p3" : "srgb";
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext("2d", { colorSpace });
  if (!ctx) throw new Error("no 2D canvas");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height, { colorSpace }), 0, 0);
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** The images an SVG / PDF export inlines, handed to the engine (SVG: the files; PDF: a JPEG of the colour + alpha). */
async function handImages(engine: Engine, images: ImageBytes | null, refs: readonly Guid[], settings: ExportSettings): Promise<void> {
  const info = engine.exportInfo(refs, settings);
  if (!info || !info.images.length || !images) return;
  const pdf = formatOf(settings) === "PDF";
  for (const hash of info.images) {
    const bytes = await images(hash);
    if (!bytes) continue;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: sniffMime(bytes) ?? "" }));
    } catch {
      bitmap = null;
    }
    if (!bitmap) continue;
    const { width, height } = bitmap;
    if (!pdf) {
      engine.exportImage(hash, { kind: "file", width, height, data: bytes });
      bitmap.close();
      continue;
    }
    // PDF: the colour as a JPEG (the original when it is one), the alpha plane when it isn't opaque.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, width, height).data;
    let opaque = true;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) {
      alpha[i] = data[i * 4 + 3];
      if (alpha[i] !== 255) opaque = false;
    }
    let jpeg = sniffMime(bytes) === "image/jpeg" && opaque ? bytes : null;
    if (!jpeg) {
      const flat = new OffscreenCanvas(width, height);
      const fctx = flat.getContext("2d");
      if (!fctx) continue;
      // The colour on white where it is transparent (the alpha plane keeps the shape).
      fctx.fillStyle = "#ffffff";
      fctx.fillRect(0, 0, width, height);
      fctx.drawImage(canvas, 0, 0);
      jpeg = new Uint8Array(await (await flat.convertToBlob({ type: "image/jpeg", quality: qualityOf(settings) })).arrayBuffer());
    }
    engine.exportImage(hash, { kind: "jpeg", width, height, data: jpeg, alpha: opaque ? null : alpha });
  }
}

/** One export of `refs` with `settings` as a file's bytes (PNG / JPEG encoded here), or an error message. */
export async function renderEngineExport(engine: Engine, images: ImageBytes | null, refs: readonly Guid[], settings: ExportSettings): Promise<{ bytes: Uint8Array } | { error: string }> {
  const format = formatOf(settings);
  try {
    if (isVectorFormat(format)) await handImages(engine, images, refs, settings);
    const out = await exportWhenReady(engine, refs, settings);
    if (out.status === "error") return { error: out.message || "Nothing to export" };
    if (out.status !== "ok") return { error: "Export failed" };
    if ("bytes" in out) return { bytes: out.bytes };
    // The engine draws in the document's profile: the pixels converted to the setting's, and tagged with it.
    const profile = exportProfile(settings, engine.colorProfile);
    const pixels = { ...out.pixels, pixels: convertPixels(out.pixels.pixels, engine.colorProfile, profile) };
    if (format === "JPEG") return { bytes: await encodePixels(pixels, "image/jpeg", qualityOf(settings), profile) };
    const scale = settings.constraint?.type === "CONTENT_SCALE" || !settings.constraint ? (settings.constraint?.value ?? 1) : 1;
    return { bytes: pngWithDpi(await encodePixels(pixels, "image/png", undefined, profile), 72 * scale) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (isVectorFormat(format)) engine.clearExportImages();
  }
}
