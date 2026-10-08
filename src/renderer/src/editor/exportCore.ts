/**
 * The engine's export (E7) as a file's bytes, for any engine and image source — the editor (exporting.ts, the file's
 * image store) and the developer preview viewer (src/viewer, the preview's images). PNG / JPEG are drawn by the engine
 * and encoded here (PNG with Figma's 72 × scale DPI); SVG / PDF are written by the engine with the images they inline
 * handed to it first. No editor state: this module only needs an Engine.
 */
import type { Engine } from "@/engine/Engine";
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

/** Straight RGBA → a PNG or JPEG file. */
export async function encodePixels(p: Pixels, type: "image/png" | "image/jpeg", quality?: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), 0, 0);
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
    if (format === "JPEG") return { bytes: await encodePixels(out.pixels, "image/jpeg", qualityOf(settings)) };
    const scale = settings.constraint?.type === "CONTENT_SCALE" || !settings.constraint ? (settings.constraint?.value ?? 1) : 1;
    return { bytes: pngWithDpi(await encodePixels(out.pixels, "image/png"), 72 * scale) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (isVectorFormat(format)) engine.clearExportImages();
  }
}
