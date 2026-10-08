/**
 * Export end to end (docs/editor.md "Export"): the engine draws (engine_export:
 * PNG / JPEG pixels, SVG and PDF files — export/ in the engine), this file
 * encodes the pixels (OffscreenCanvas.convertToBlob, PNG with Figma's 72 × scale
 * DPI), hands the vector writers the images they inline, names the files
 * (layer name + suffix, "/" for folders) and saves them through main
 * (`file:export-assets`: the system's Save dialog, or a folder for several) —
 * a view never writes files — or, in a browser, downloads them (a ZIP for
 * several). Also Copy as PNG (⇧⌘C, 2x as Figma's), Copy as SVG, Copy as code
 * (CSS), Copy as text, and File › Export frames to PDF….
 */
import { showToast } from "@/ds";
import type { ExportOutput, Guid, NodeChange, Pixels } from "@/engine/codec";
import { exportMime, planExportPaths } from "../../../shared/exportFiles";
import type { EditorController } from "./controller";
import { editorBridge } from "./desktop";
import { engineExports } from "./engineCompat";
import { sniffImageMime } from "./images";
import {
  cssOf,
  exportFileName,
  exportSettingsOf,
  formatOf,
  isVectorFormat,
  pngWithDpi,
  qualityOf,
  readingOrder,
  zipStored,
  type CssNode,
  type ExportSettings,
} from "./model/exports";

/** Whether this engine build exports (the export ABI is there). */
export const canExport = (ed: EditorController) => !ed.engine.destroyed && engineExports(ed.engine, "export");

export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
}

/** How long an export waits for fonts and images it draws before drawing what there is. */
const READY_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The engine's export, waiting (a while) for what it draws to arrive. */
async function exportWhenReady(ed: EditorController, refs: readonly Guid[], settings: ExportSettings): Promise<ExportOutput> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let out = ed.engine.exportNodes(refs, settings);
  while (out.status === "busy" && Date.now() < deadline && !ed.engine.destroyed) {
    await sleep(60);
    out = ed.engine.exportNodes(refs, settings);
  }
  if (out.status === "busy") out = ed.engine.exportNodes(refs, settings, { allowPending: true });
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
async function handImages(ed: EditorController, refs: readonly Guid[], settings: ExportSettings): Promise<void> {
  const info = ed.engine.exportInfo(refs, settings);
  const store = ed.images.store;
  if (!info || !info.images.length || !store) return;
  const pdf = formatOf(settings) === "PDF";
  for (const hash of info.images) {
    const bytes = await store.get(hash);
    if (!bytes) continue;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) ?? "" }));
    } catch {
      bitmap = null;
    }
    if (!bitmap) continue;
    const { width, height } = bitmap;
    if (!pdf) {
      ed.engine.exportImage(hash, { kind: "file", width, height, data: bytes });
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
    let jpeg = sniffImageMime(bytes) === "image/jpeg" && opaque ? bytes : null;
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
    ed.engine.exportImage(hash, { kind: "jpeg", width, height, data: jpeg, alpha: opaque ? null : alpha });
  }
}

/** One export of `refs` with `settings` as a file's bytes (PNG / JPEG encoded here), or an error message. */
export async function renderExport(ed: EditorController, refs: readonly Guid[], settings: ExportSettings): Promise<{ bytes: Uint8Array } | { error: string }> {
  if (!canExport(ed)) return { error: "Export needs a newer engine build" };
  const format = formatOf(settings);
  try {
    if (isVectorFormat(format)) await handImages(ed, refs, settings);
    const out = await exportWhenReady(ed, refs, settings);
    if (out.status === "error") return { error: out.message || "Nothing to export" };
    if (out.status !== "ok") return { error: "Export failed" };
    if ("bytes" in out) return { bytes: out.bytes };
    if (format === "JPEG") return { bytes: await encodePixels(out.pixels, "image/jpeg", qualityOf(settings)) };
    const scale = settings.constraint?.type === "CONTENT_SCALE" || !settings.constraint ? (settings.constraint?.value ?? 1) : 1;
    return { bytes: pngWithDpi(await encodePixels(out.pixels, "image/png"), 72 * scale) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (isVectorFormat(format)) ed.engine.clearExportImages();
  }
}

/** A layer and what it exports. */
export interface ExportItem {
  ref: Guid | null;  // null: the page's canvas
  name: string;
  settings: ExportSettings[];
}

/** The files of `items`, each setting of each layer (Figma's "Export N layers"), named and in order. */
export async function renderItems(ed: EditorController, items: readonly ExportItem[]): Promise<{ files: ExportedFile[]; failed: string[] }> {
  const files: ExportedFile[] = [];
  const failed: string[] = [];
  for (const item of items) {
    for (const s of item.settings) {
      const r = await renderExport(ed, item.ref ? [item.ref] : [], s);
      if ("error" in r) failed.push(`${item.name}: ${r.error}`);
      else files.push({ name: exportFileName(item.name, s), bytes: r.bytes });
    }
  }
  return { files, failed };
}

/** Saves exported files: through main on the desktop (its Save dialog, or a folder for several), else a download. */
export async function saveFiles(ed: EditorController, files: readonly ExportedFile[]): Promise<boolean> {
  if (!files.length) return false;
  const bridge = editorBridge();
  if (bridge?.files?.exportAssets) {
    const r = await bridge.files.exportAssets(files.map((f) => ({ name: f.name, bytes: f.bytes })));
    return !("cancelled" in r);
  }
  // A browser: one file as it is, several in a ZIP named after the design file.
  const paths = planExportPaths(files.map((f) => f.name));
  const one = files.length === 1;
  const bytes = one ? files[0].bytes : zipStored(files.map((f, i) => ({ name: paths[i], bytes: f.bytes })));
  const name = one ? paths[0].split("/").pop()! : `${ed.ui.get().fileName || "Export"}.zip`;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: one ? exportMime(name) : "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** Renders and saves; toasts what failed. */
export async function exportItems(ed: EditorController, items: readonly ExportItem[]): Promise<void> {
  const { files, failed } = await renderItems(ed, items);
  if (failed.length) showToast({ message: failed.length === 1 ? `Couldn't export ${failed[0]}` : `Couldn't export ${failed.length} files` });
  if (files.length) await saveFiles(ed, files);
}

// ---- The selection's export items ----

/** The selected layers with their export settings (only those that have some, as Figma's Export button does). */
export function selectionItems(ed: EditorController): ExportItem[] {
  return ed.engine
    .readNodes(ed.selection)
    .map((n) => ({ ref: n.guid, name: n.name ?? "", settings: exportSettingsOf(n as { exportSettings?: unknown }) }))
    .filter((i) => i.settings.length > 0);
}

// ---- Copy as ----

async function writeClipboard(items: Record<string, Blob>, text?: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    }
    if (text !== undefined && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not focused, or no permission: fall through.
  }
  return false;
}

/** Copy as PNG (⇧⌘C): the selection as one image at 2x. */
export async function copyAsPng(ed: EditorController): Promise<void> {
  const refs = ed.selection;
  if (!refs.length) return;
  const r = await renderExport(ed, refs, { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 }, contentsOnly: true });
  if ("error" in r) return void showToast({ message: "Couldn't copy as PNG" });
  const ok = await writeClipboard({ "image/png": new Blob([r.bytes as BlobPart], { type: "image/png" }) });
  showToast({ message: ok ? "Copied as PNG" : "Couldn't copy as PNG" });
}

/** Copy as SVG: the selection's SVG markup, as text. */
export async function copyAsSvg(ed: EditorController): Promise<void> {
  const refs = ed.selection;
  if (!refs.length) return;
  const r = await renderExport(ed, refs, { imageType: "SVG", constraint: { type: "CONTENT_SCALE", value: 1 }, contentsOnly: true, svgOutlineText: true });
  if ("error" in r) return void showToast({ message: "Couldn't copy as SVG" });
  const text = new TextDecoder().decode(r.bytes);
  const ok = await writeClipboard({ "text/plain": new Blob([text], { type: "text/plain" }) }, text);
  showToast({ message: ok ? "Copied as SVG" : "Couldn't copy as SVG" });
}

/** Copy as code: the selection's CSS (Figma's "Copy as code › CSS"). */
export async function copyAsCode(ed: EditorController): Promise<void> {
  const nodes = ed.engine.readNodes(ed.selection).map(ed.withRealType);
  if (!nodes.length) return;
  const text = nodes.map((n) => cssOf(n as unknown as CssNode)).join("\n");
  const ok = await writeClipboard({ "text/plain": new Blob([text], { type: "text/plain" }) }, text);
  showToast({ message: ok ? "Copied to clipboard" : "Couldn't copy" });
}

/** The selected text layers' characters (Copy as text), or "" when none is a text layer. */
export function selectionText(ed: EditorController): string {
  return ed.engine
    .readNodes(ed.selection)
    .map(ed.withRealType)
    .filter((n) => (n.type as string) === "TEXT")
    .map((n) => (n as NodeChange & { textData?: { characters?: string } }).textData?.characters ?? "")
    .join("\n");
}

/** Whether a text layer is among the selection (its first 50: menus ask this often). */
export function hasTextSelected(ed: EditorController): boolean {
  const refs = ed.selection.slice(0, 50);
  return refs.length > 0 && ed.engine.readNodes(refs, { fields: ["type"] }).some((n) => (n.type as string) === "TEXT");
}

export async function copyAsText(ed: EditorController): Promise<void> {
  const text = selectionText(ed);
  if (!text) return;
  const ok = await writeClipboard({ "text/plain": new Blob([text], { type: "text/plain" }) }, text);
  showToast({ message: ok ? "Copied to clipboard" : "Couldn't copy" });
}

// ---- File › Export frames to PDF… ----

/** The current page's top-level frames in reading order (Figma: every frame of the page, exported or not). */
export function pageFrames(ed: EditorController): { ref: Guid; name: string }[] {
  const page = ed.store.page;
  const pageNode = ed.engine.readNode(page, { childIds: true }) as (NodeChange & { childIds?: Guid[] }) | null;
  const ids = pageNode?.childIds ?? [];
  const frames = ed.engine
    .readNodes(ids)
    .map(ed.withRealType)
    .filter((n) => n.visible !== false && ["FRAME", "SYMBOL", "INSTANCE"].includes(n.type as string) && !(n as { resizeToFit?: boolean }).resizeToFit)
    .map((n) => ({ ref: n.guid, name: n.name ?? "", x: n.transform?.m02 ?? 0, y: n.transform?.m12 ?? 0, w: n.size?.x ?? 0, h: n.size?.y ?? 0 }));
  return readingOrder(frames).map((f) => ({ ref: f.ref, name: f.name }));
}

export async function exportFramesToPdf(ed: EditorController): Promise<void> {
  const frames = pageFrames(ed);
  if (!frames.length) return void showToast({ message: "There are no frames on this page to export" });
  const r = await renderExport(
    ed,
    frames.map((f) => f.ref),
    { imageType: "PDF", constraint: { type: "CONTENT_SCALE", value: 1 }, contentsOnly: true }
  );
  if ("error" in r) return void showToast({ message: "Couldn't export frames to PDF" });
  const pageName = ed.store.pages.find((p) => p.guid === ed.store.page)?.name ?? "Page";
  await saveFiles(ed, [{ name: `${ed.ui.get().fileName || pageName}.pdf`, bytes: r.bytes }]);
}
