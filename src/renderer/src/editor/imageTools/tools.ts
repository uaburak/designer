/**
 * The image tools on the document (docs/ai.md §2.6, §4): which selected layers are images, their pixels, each tool's
 * run — local (the worker, runners.ts) or through main's image route (`ai:image`) — and its result applied as **one
 * undo step** named after the tool. Every run is recorded in the usage ledger (`store.ai.record`, the file's key; the
 * store takes the org from the file). React-free: the toolbar (ImageToolbar.tsx) and the tests drive it.
 *
 * Where the result goes (Figma's help 24004542669463 and docs/ai.md §2.6):
 * - Remove background, Boost resolution, Edit with prompt: Figma's APPEND (atlas 18 §7.2) — the image paint is copied
 *   above itself with the new picture (its scale mode, crop and adjustments kept) and the original paint is hidden,
 *   kept in the list. Several selected images are one step.
 * - Erase, Expand: the layer's picture as it shows (its scale mode applied) becomes a Fill-mode picture; Expand grows
 *   the layer in the dragged directions.
 * - Isolate (atlas 18 §7.6): the lassoed object becomes a new image layer just above; the original becomes the
 *   background — named "Background", proportions locked, constraints Scale / Scale, the object erased from it when
 *   LaMa is already on this computer. Not on instances.
 * - Blur (docs/studio.md §6.2, ours): the picture swapped, the lassoed areas blurred as a low-resolution print.
 * - Make an image: the selected layer's fill, else a new image layer in the middle of the view.
 */
import { t as tr } from "@/i18n";
import type { Guid, Message, NodeChange } from "@/engine/codec";
import { keyBetween } from "@shared/schema/fractionalIndex";
import { AiRunError, type AiApi } from "../../../../shared/ai/api";
import { creditsFor, type AiAction, type AiImageRequest, type AiModelId, type AiModelInfo, type AiRoute, type AiRunEvent, type AiUsage } from "../../../../shared/ai/types";
import type { EditorController } from "../controller";
import type { ImportedImage } from "../images";
import { hashBytes, imagePaint, paintImageHash, progressivePaintFields, type FullPaint } from "../model/paints";
import { encodePng } from "../agents/png";
import { viewCentre } from "../canvas/viewInsets";
import { newNodeGuid } from "../variables";
import { blank, blurArea, expandCanvas, rasterizePolygon, recomposite, resize, type Insets, type Point, type Rect, type Rgba } from "./pixels";
import * as runners from "./runners";

// ---- What is an image layer ------------------------------------------------------------------------------------------

export interface ImageTarget {
  id: Guid;
  node: NodeChange;
  /** The image paint's index in fillPaints (the topmost visible one) */
  index: number;
  paint: FullPaint;
  hash: string;
}

/** A layer's topmost visible image fill, or null. */
export function imageTargetOf(node: NodeChange | null): ImageTarget | null {
  if (!node) return null;
  const fills = (node.fillPaints ?? []) as FullPaint[];
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i];
    if (p.type !== "IMAGE" || p.visible === false) continue;
    const hash = paintImageHash(p);
    if (hash) return { id: node.guid, node, index: i, paint: p, hash };
  }
  return null;
}

/** The selected layers that are images (an image fill on top), in selection order. */
export function imageTargets(ed: EditorController, ids: readonly Guid[] = ed.selection): ImageTarget[] {
  return ids.map((id) => imageTargetOf(ed.engine.readNode(id))).filter((t): t is ImageTarget => !!t);
}

// ---- The paint drawn in the layer's space (the engine's imageMatrix, render/Renderer.cpp) -------------------------------

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
const translate = (x: number, y: number): M => [1, 0, x, 0, 1, y];
const rotate = (a: number): M => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0];

/** Node space → the image's uv (0…1, y down), per the paint's scale mode — the engine's own formula. */
export function imageMatrix(paint: FullPaint, w0: number, h0: number, iw0: number, ih0: number): M {
  const w = Math.max(w0, 1e-9), h = Math.max(h0, 1e-9), iw = Math.max(iw0, 1), ih = Math.max(ih0, 1);
  let turns = Math.round(((paint as { rotation?: number }).rotation ?? 0) / 90) % 4;
  if (turns < 0) turns += 4;
  const angle = (turns * Math.PI) / 2;
  const sideways = turns % 2 === 1;
  const rw = sideways ? ih : iw, rh = sideways ? iw : ih;
  const mode = paint.imageScaleMode ?? "FILL";
  if (mode === "STRETCH") {
    const t = paint.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    return mul([t.m00, t.m01, t.m02, t.m10, t.m11, t.m12], [1 / w, 0, 0, 0, 1 / h, 0]);
  }
  if (mode === "TILE") {
    const s = (paint as { scale?: number }).scale && (paint as { scale?: number }).scale! > 0 ? (paint as { scale?: number }).scale! : 1;
    return mul([1 / (iw * s), 0, 0, 0, 1 / (ih * s), 0], rotate(-angle));
  }
  const s = mode === "FILL" ? Math.max(w / rw, h / rh) : Math.min(w / rw, h / rh);
  return mul(mul(mul(translate(0.5, 0.5), [1 / (iw * s), 0, 0, 0, 1 / (ih * s), 0]), rotate(-angle)), translate(-w / 2, -h / 2));
}

/** Image px per layer unit (the density to render the layer's picture at, ≥ 1, ≤ 4). */
export function pictureDensity(paint: FullPaint, size: { x: number; y: number }, image: { width: number; height: number }): number {
  const m = imageMatrix(paint, size.x, size.y, image.width, image.height);
  const d = Math.max(image.width * Math.hypot(m[0], m[3]), image.height * Math.hypot(m[1], m[4]));
  return Math.min(4, Math.max(1, d));
}

/** The paint's picture as the layer shows it, `width` × `height` px over the layer's size (outside the image: clear). */
export function drawPaint(src: Rgba, paint: FullPaint, size: { x: number; y: number }, width: number, height: number): Rgba {
  const m = imageMatrix(paint, size.x, size.y, src.width, src.height);
  const out = blank(width, height);
  const tile = paint.imageScaleMode === "TILE";
  const kx = size.x / width, ky = size.y / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) * kx, ny = (y + 0.5) * ky;
      let u = m[0] * nx + m[1] * ny + m[2], v = m[3] * nx + m[4] * ny + m[5];
      if (tile) {
        u -= Math.floor(u);
        v -= Math.floor(v);
      } else if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const fx = Math.min(src.width - 1, Math.max(0, u * src.width - 0.5)), fy = Math.min(src.height - 1, Math.max(0, v * src.height - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c] * (1 - tx) + src.data[(y0 * src.width + x1) * 4 + c] * tx;
        const b = src.data[(y1 * src.width + x0) * 4 + c] * (1 - tx) + src.data[(y1 * src.width + x1) * 4 + c] * tx;
        out.data[o + c] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  return out;
}

// ---- Pixels in and out ------------------------------------------------------------------------------------------------

export interface ImageIO {
  /** An image of the file's (by hash) as pixels */
  read(hash: string): Promise<Rgba>;
  /** Pixels into the file's images (a PNG): the import's hash, size and progressive copies */
  put(image: Rgba, name: string): Promise<ImportedImage>;
}

/** Bytes → pixels with the platform's decoder (any format the canvas reads). */
export async function decodeImage(bytes: Uint8Array): Promise<Rgba> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
}

export function browserImageIO(ed: EditorController): ImageIO {
  return {
    async read(hash) {
      const bytes = await ed.images.bytes(hash);
      if (!bytes) throw new AiRunError("unsupported", tr("This image isn't available on this computer."));
      return decodeImage(bytes);
    },
    async put(image, name) {
      const png = await encodePng(image.width, image.height, image.data);
      const [img] = await ed.images.import([new File([png as BlobPart], `${name}.png`, { type: "image/png" })]);
      if (!img) throw new AiRunError("bad-output", tr("The new picture couldn't be added to the file."));
      return { ...img, name };
    },
  };
}

// ---- Credits, the ledger, the route ------------------------------------------------------------------------------------

export interface ToolHooks {
  /** Refuses (AiRunError disabled / over-limit) before a run that costs credits */
  checkCredits(action: AiAction): Promise<void>;
  record(e: { action: AiAction; providerId: string; model?: string; images: number; credits: number; local: boolean; ok: boolean }): void;
  /** Main's AI (image runs, model downloads); null in a browser */
  api: Pick<AiApi, "image" | "cancel" | "onEvent" | "models" | "modelDownload"> | null;
  /** Asks before a model's first download (its size); true = download */
  confirmDownload(info: AiModelInfo): Promise<boolean>;
  /** A model's download progress (0…1) */
  onDownload?(id: AiModelId, share: number): void;
}

export interface ToolEnv {
  ed: EditorController;
  io: ImageIO;
  hooks: ToolHooks;
}

/** Ready to run locally: downloaded already, or downloaded now after the confirmation. False: declined. */
export async function ensureModel(hooks: ToolHooks, id: AiModelId): Promise<boolean> {
  if (!hooks.api) throw new AiRunError("unsupported", tr("Local AI models run in the desktop app."));
  const { info, state } = await hooks.api.models();
  const s = state.find((x) => x.id === id);
  if (s?.state === "ready") return true;
  const m = info.find((x) => x.id === id);
  if (!m) throw new AiRunError("no-model", tr("This model isn't available."));
  if (!(await hooks.confirmDownload(m))) return false;
  hooks.onDownload?.(id, 0);
  const done = await hooks.api.modelDownload(id);
  if (done.state !== "ready") throw new AiRunError("no-model", done.error ?? tr("The model couldn't be downloaded."));
  return true;
}

/** An `ai:image` run as a promise: the picture (decoded) and its usage. */
export function imageRun(api: Pick<AiApi, "image" | "cancel" | "onEvent">, req: AiImageRequest, signal?: AbortSignal, onStatus?: (text: string) => void): Promise<{ image: { data: string; mime: string; width: number; height: number }; usage?: AiUsage }> {
  return new Promise((resolve, reject) => {
    let image: { data: string; mime: string; width: number; height: number } | null = null;
    let usage: AiUsage | undefined;
    let error: AiRunError | null = null;
    const onAbort = () => void api.cancel(req.runId);
    const off = api.onEvent(({ runId, event }: { runId: string; event: AiRunEvent }) => {
      if (runId !== req.runId) return;
      if (event.type === "status") onStatus?.(event.text);
      else if (event.type === "image") image = { data: event.data, mime: event.mime, width: event.width, height: event.height };
      else if (event.type === "usage") usage = event.usage;
      else if (event.type === "error") error = new AiRunError(event.code, event.message);
      else if (event.type === "done") {
        off();
        signal?.removeEventListener("abort", onAbort);
        if (event.cancelled) reject(new AiRunError("cancelled", "Cancelled."));
        else if (error || !image) reject(error ?? new AiRunError("bad-output", tr("No picture came back.")));
        else resolve({ image, ...(usage ? { usage } : {}) });
      }
    });
    if (signal?.aborted) {
      off();
      return reject(new AiRunError("cancelled", "Cancelled."));
    }
    signal?.addEventListener("abort", onAbort);
    api.image(req).catch((err: unknown) => {
      off();
      signal?.removeEventListener("abort", onAbort);
      reject(err instanceof AiRunError ? err : new AiRunError("no-provider", err instanceof Error ? err.message : String(err)));
    });
  });
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Pixels as a PNG's base64, the long side capped (uploads stay small). */
async function pngB64(image: Rgba, maxSide = 2048): Promise<string> {
  const k = Math.min(1, maxSide / Math.max(image.width, image.height));
  const img = k < 1 ? resize(image, image.width * k, image.height * k) : image;
  return b64(await encodePng(img.width, img.height, img.data));
}

/** Decoding an API's picture: injected for the tests (no canvas in Node). */
export let decodeAnswer: (bytes: Uint8Array) => Promise<Rgba> = decodeImage;
export function setAnswerDecoder(fn: ((bytes: Uint8Array) => Promise<Rgba>) | null) {
  decodeAnswer = fn ?? decodeImage;
}

let runSeq = 0;
const newRunId = (action: string) => `img-${action}-${Date.now().toString(36)}-${++runSeq}`;

/** One API image run, recorded in the ledger whatever its outcome. */
async function apiImage(env: ToolEnv, req: Omit<AiImageRequest, "runId">, signal?: AbortSignal): Promise<Rgba> {
  const api = env.hooks.api;
  if (!api) throw new AiRunError("unsupported", tr("AI images are made in the desktop app."));
  const route = req.route;
  try {
    const { image, usage } = await imageRun(api, { ...req, runId: newRunId(req.action) }, signal);
    // Who answered as main says (a run without a route — Expand — was recorded as "image"; found 2026-10-12)
    env.hooks.record({ action: req.action, providerId: usage?.providerId ?? route?.providerId ?? "image", model: usage?.model ?? route?.model, images: 1, credits: usage?.credits ?? creditsFor(req.action, { model: route?.model }), local: false, ok: true });
    return decodeAnswer(fromB64(image.data));
  } catch (err) {
    if (!(err instanceof AiRunError && (err.code === "cancelled" || err.code === "over-limit" || err.code === "disabled"))) env.hooks.record({ action: req.action, providerId: route?.providerId ?? "image", model: route?.model, images: 0, credits: 0, local: false, ok: false });
    throw err;
  }
}

/** A local run, checked against the credits first and recorded after. */
async function local<T>(env: ToolEnv, action: AiAction, model: AiModelId, megapixels: number, fn: () => Promise<T>): Promise<T> {
  await env.hooks.checkCredits(action);
  if (!(await ensureModel(env.hooks, model))) throw new AiRunError("cancelled", "Cancelled.");
  try {
    const out = await fn();
    env.hooks.record({ action, providerId: "local", model, images: 1, credits: creditsFor(action, { megapixels }), local: true, ok: true });
    return out;
  } catch (err) {
    env.hooks.record({ action, providerId: "local", model, images: 0, credits: 0, local: true, ok: false });
    throw err;
  }
}

// ---- Writing results (one undo step each) ------------------------------------------------------------------------------

/** `fn`'s writes as one undo step labelled `label`. */
export function writeStep(ed: EditorController, label: string, fn: () => void): void {
  const status = ed.engine.txnBegin(label);
  if (status !== 0) throw new AiRunError("unsupported", tr("Finish what you're doing on the canvas first, then try again."));
  try {
    fn();
  } catch (err) {
    ed.engine.txnCancel();
    throw err;
  }
  ed.engine.txnCommit();
}

/** The image paint with another picture (everything else of the paint kept). */
export function withPicture(p: FullPaint, img: ImportedImage): FullPaint {
  const { thumbHash: _t, imageThumbnail: _i, ...rest } = p as FullPaint & { thumbHash?: unknown; imageThumbnail?: unknown };
  return { ...rest, image: { ...((p.image as object) ?? {}), hash: hashBytes(img.hash) }, originalImageWidth: img.width, originalImageHeight: img.height, ...progressivePaintFields(img) } as FullPaint;
}

/** A Fill-mode paint of a picture drawn at the layer's size, keeping the old paint's opacity, blend and adjustments. */
export function fillPicture(old: FullPaint, img: ImportedImage): FullPaint {
  const fresh = imagePaint(img.hash, img, (old.image as { name?: string } | undefined)?.name);
  const keep = old as FullPaint & { filters?: unknown };
  return { ...fresh, opacity: old.opacity ?? 1, blendMode: old.blendMode ?? "NORMAL", ...(keep.filters ? { filters: keep.filters } : {}) } as FullPaint;
}

function setFill(ed: EditorController, t: ImageTarget, paint: FullPaint, extra: Partial<NodeChange> = {}) {
  const fills = [...((ed.engine.readNode(t.id)?.fillPaints ?? t.node.fillPaints ?? []) as FullPaint[])];
  fills[t.index] = paint;
  const status = ed.engine.setProps([t.id], { fillPaints: fills as never, ...(extra as object) });
  if (status !== 0) throw new AiRunError("unsupported", tr("This layer can't be changed (status {status}).", { status }));
}

/** Figma's APPEND (atlas 18 §7.2): `paint` goes just above the image paint, which is hidden and kept in the list. */
export function appendFill(ed: EditorController, t: ImageTarget, paint: FullPaint) {
  const fills = [...((ed.engine.readNode(t.id)?.fillPaints ?? t.node.fillPaints ?? []) as FullPaint[])];
  fills.splice(t.index, 1, { ...fills[t.index], visible: false } as FullPaint, { ...paint, visible: true } as FullPaint);
  const status = ed.engine.setProps([t.id], { fillPaints: fills as never });
  if (status !== 0) throw new AiRunError("unsupported", tr("This layer can't be changed (status {status}).", { status }));
}

const nameOf = (t: ImageTarget) => (t.node.name || "Image").slice(0, 100);

// ---- The tools ------------------------------------------------------------------------------------------------------

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?(share: number): void;
}

/** Remove background: each image's picture without its background (one step for all). Answers how many changed. */
export async function removeBackground(env: ToolEnv, targets: readonly ImageTarget[], o: RunOptions = {}): Promise<number> {
  const results: { t: ImageTarget; img: ImportedImage }[] = [];
  for (const t of targets) {
    const src = await env.io.read(t.hash);
    const out = await local(env, "remove-background", "isnet", (src.width * src.height) / 1e6, () => runners.removeBackground(src));
    if (o.signal?.aborted) throw new AiRunError("cancelled", "Cancelled.");
    results.push({ t, img: await env.io.put(out, nameOf(t)) });
    o.onProgress?.(results.length / targets.length);
  }
  if (results.length) writeStep(env.ed, "Remove background", () => results.forEach(({ t, img }) => appendFill(env.ed, t, withPicture(t.paint, img))));
  return results.length;
}

/** Boost resolution's limits (atlas 18 §7.4): the image's own pixels 16…2048 on each side; the answer ≤ 4096. */
export const BOOST_MIN_SIDE = 16;
export const BOOST_MAX_SIDE = 2048;
export const BOOST_MAX_OUTPUT = 4096;

/** "Already at 4×": Figma's error with a "Boost anyway" button (which boosts the image 2×). */
export class BoostAlreadyMaxError extends AiRunError {
  constructor() {
    super("unsupported", tr("This image already has the highest resolution for its size."));
  }
}

/**
 * The size Boost resolution makes (atlas 18 §7.4, Figma's upscale-image): against the layer's on-canvas size (sides
 * swapped for a picture turned 90° / 270°) — 2× the layer when the image is below 2× on either axis, else 4×, scaled
 * by max(k·W / w, k·H / h); a Tile-mode picture and "Boost anyway" 2× the image; never over 4096 on a side.
 */
export function boostSize(t: Pick<ImageTarget, "paint" | "node">, image: { width: number; height: number }, anyway = false): { width: number; height: number } {
  const { width: w, height: h } = image;
  if (w > BOOST_MAX_SIDE || h > BOOST_MAX_SIDE) throw new AiRunError("unsupported", tr("This image is too large to boost. Its sides can be up to {n} px.", { n: BOOST_MAX_SIDE }));
  if (w < BOOST_MIN_SIDE || h < BOOST_MIN_SIDE) throw new AiRunError("unsupported", tr("This image is too small to boost. Its sides need to be at least {n} px.", { n: BOOST_MIN_SIDE }));
  let s = 2;
  if (!anyway && t.paint.imageScaleMode !== "TILE") {
    const turns = ((Math.round(((t.paint as { rotation?: number }).rotation ?? 0) / 90) % 4) + 4) % 4;
    const size = t.node.size ?? { x: w, y: h };
    const W = turns % 2 ? size.y : size.x, H = turns % 2 ? size.x : size.y;
    if (w >= 4 * W && h >= 4 * H) throw new BoostAlreadyMaxError();
    const k = w < 2 * W || h < 2 * H ? 2 : 4;
    s = Math.max((k * W) / w, (k * H) / h);
  }
  const clamp = Math.min(1, BOOST_MAX_OUTPUT / (w * s), BOOST_MAX_OUTPUT / (h * s));
  return { width: Math.max(1, Math.round(w * s * clamp)), height: Math.max(1, Math.round(h * s * clamp)) };
}

/**
 * Boost resolution: each picture to `boostSize` — Swin2SR ×4, again while short of it, then resized to it — one step.
 * An image outside the limits is left out when others are boosted; alone, its error is the run's.
 */
export async function boostResolution(env: ToolEnv, targets: readonly ImageTarget[], o: RunOptions & { anyway?: boolean } = {}): Promise<number> {
  const results: { t: ImageTarget; img: ImportedImage }[] = [];
  const planned: { t: ImageTarget; src: Rgba; size: { width: number; height: number } }[] = [];
  let refused: unknown = null;
  for (const t of targets) {
    const src = await env.io.read(t.hash);
    try {
      planned.push({ t, src, size: boostSize(t, src, o.anyway) });
    } catch (err) {
      refused ??= err;
    }
  }
  if (!planned.length && refused) throw refused;
  let i = 0;
  for (const { t, src, size } of planned) {
    const passes = Math.max(1, Math.ceil(Math.log(Math.max(size.width / src.width, size.height / src.height)) / Math.log(4) - 1e-9));
    const out = await local(env, "boost-resolution", "swin2sr-x4", (size.width * size.height) / 1e6, async () => {
      let img = src;
      for (let p = 0; p < passes; p++) img = await runners.boostResolution(img, { signal: o.signal, onTile: (done, total) => o.onProgress?.((i + (p + done / total) / passes) / planned.length) });
      return img.width === size.width && img.height === size.height ? img : resize(img, size.width, size.height);
    });
    results.push({ t, img: await env.io.put(out, nameOf(t)) });
    i++;
  }
  if (results.length) writeStep(env.ed, "Boost resolution", () => results.forEach(({ t, img }) => appendFill(env.ed, t, withPicture(t.paint, img))));
  return results.length;
}

/** The layer's picture as it shows, at its native density: the pixels and the layer-units → pixels scale. */
export async function layerPicture(env: ToolEnv, t: ImageTarget): Promise<{ image: Rgba; k: number }> {
  const src = await env.io.read(t.hash);
  const size = t.node.size ?? { x: src.width, y: src.height };
  let k = pictureDensity(t.paint, size, src);
  k = Math.min(k, 4096 / Math.max(size.x, size.y));
  return { image: drawPaint(src, t.paint, size, Math.max(1, Math.round(size.x * k)), Math.max(1, Math.round(size.y * k))), k };
}

/** A lasso in the layer's units → a mask over its picture. */
export const lassoMask = (lasso: readonly Point[], k: number, width: number, height: number) => rasterizePolygon(lasso.map((p) => ({ x: p.x * k, y: p.y * k })), width, height);

/** Erase: the lassoed area filled from its surroundings (LaMa; without the model, the image route with a mask). */
export async function eraseArea(env: ToolEnv, t: ImageTarget, lasso: readonly Point[], o: RunOptions & { route?: AiRoute } = {}): Promise<void> {
  const { image, k } = await layerPicture(env, t);
  const mask = lassoMask(lasso, k, image.width, image.height);
  if (!mask.some((v) => v)) throw new AiRunError("unsupported", tr("Select an area on the image first."));
  let out: Rgba;
  await env.hooks.checkCredits("erase-object");
  if (await ensureModel(env.hooks, "lama").catch(() => false)) {
    out = await local(env, "erase-object", "lama", (image.width * image.height) / 1e6, () => runners.erase(image, mask));
  } else {
    // OpenAI's convention: transparent = change.
    const m = blank(image.width, image.height);
    for (let i = 0; i < mask.length; i++) m.data[i * 4 + 3] = mask[i] ? 0 : 255;
    const answer = await apiImage(env, { action: "erase-object", image: await pngB64(image), mask: await pngB64(m), size: { width: image.width, height: image.height }, ...(o.route ? { route: o.route } : {}) }, o.signal);
    out = resize(answer, image.width, image.height);
    for (let i = 0; i < mask.length; i++) if (!mask[i]) out.data.set(image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  const img = await env.io.put(out, nameOf(t));
  writeStep(env.ed, "Erase", () => setFill(env.ed, t, fillPicture(t.paint, img)));
}

/**
 * Isolate (atlas 18 §7.6): the lassoed object as a new image layer above the image; the image becomes its background
 * — "Background", proportions locked, constraints Scale / Scale, the object erased from its picture when LaMa is
 * already downloaded (no download is asked for here). Not on instances. Answers the new layer.
 */
export async function isolateArea(env: ToolEnv, t: ImageTarget, lasso: readonly Point[]): Promise<Guid> {
  if (t.node.type === "INSTANCE") throw new AiRunError("unsupported", tr("Isolate doesn't work on instances. Detach the instance first."));
  const { image, k } = await layerPicture(env, t);
  const mask = lassoMask(lasso, k, image.width, image.height);
  const cut = await local(env, "isolate-object", "isnet", (image.width * image.height) / 1e6, () => runners.isolate(image, mask));
  if (!cut) throw new AiRunError("unsupported", tr("Select an area on the image first."));
  const lama = env.hooks.api ? (await env.hooks.api.models().catch(() => null))?.state.find((m) => m.id === "lama")?.state === "ready" : false;
  const background = lama ? await env.io.put(await runners.erase(image, mask), nameOf(t)) : null;
  const img = await env.io.put(cut.image, `${nameOf(t)} (isolated)`);
  let id = "" as Guid;
  writeStep(env.ed, "Isolate", () => {
    if (background) setFill(env.ed, t, fillPicture(t.paint, background));
    const status = env.ed.engine.setProps([t.id], { name: tr("Background"), proportionsConstrained: true, horizontalConstraint: "SCALE", verticalConstraint: "SCALE" } as never);
    if (status !== 0) throw new AiRunError("unsupported", tr("This layer can't be changed (status {status}).", { status }));
    id = insertImageLayerAbove(env.ed, t.node, img, { x: cut.rect.x / k, y: cut.rect.y / k, width: cut.rect.width / k, height: cut.rect.height / k });
  });
  env.ed.engine.setSelection([id]);
  return id;
}

/**
 * Blur (docs/studio.md §6.2): areas of the picture — lassos or boxes, in the layer's units — as a low-resolution print,
 * local and free, one undo step. It works on the image itself (the areas mapped through the paint's scale mode), so the
 * paint keeps its settings and every pixel outside the areas stays byte for byte; a Tile-mode picture is drawn as it
 * shows first, as Erase does.
 */
export async function blurAreas(env: ToolEnv, t: ImageTarget, areas: readonly (readonly Point[])[]): Promise<void> {
  let out: Rgba;
  let paint: (img: ImportedImage) => FullPaint;
  let masked = false;
  if (t.paint.imageScaleMode === "TILE") {
    const { image, k } = await layerPicture(env, t);
    out = image;
    for (const a of areas) {
      const mask = lassoMask(a, k, image.width, image.height);
      if (!mask.some((v) => v)) continue;
      masked = true;
      out = blurArea(out, mask);
    }
    paint = (img) => fillPicture(t.paint, img);
  } else {
    const src = await env.io.read(t.hash);
    const size = t.node.size ?? { x: src.width, y: src.height };
    const m = imageMatrix(t.paint, size.x, size.y, src.width, src.height);
    const toPx = (p: Point): Point => ({ x: (m[0] * p.x + m[1] * p.y + m[2]) * src.width, y: (m[3] * p.x + m[4] * p.y + m[5]) * src.height });
    out = src;
    for (const a of areas) {
      const mask = rasterizePolygon(a.map(toPx), src.width, src.height);
      if (!mask.some((v) => v)) continue;
      masked = true;
      out = blurArea(out, mask);
    }
    paint = (img) => withPicture(t.paint, img);
  }
  if (!masked) throw new AiRunError("unsupported", tr("Select an area on the image first."));
  const img = await env.io.put(out, nameOf(t));
  writeStep(env.ed, "Blur", () => setFill(env.ed, t, paint(img)));
}

/** Blur on boxes in the layer's units (Studio's review, §6.2). */
export const blurBoxes = (env: ToolEnv, t: ImageTarget, boxes: readonly Rect[]): Promise<void> =>
  blurAreas(
    env,
    t,
    boxes.map((b) => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }])
  );

/** A new rectangle filled with `img`, just above `node` in its parent, at `rect` in node's own units. */
export function insertImageLayerAbove(ed: EditorController, node: NodeChange, img: ImportedImage, rect: Rect): Guid {
  const parent = node.parentIndex?.guid;
  if (!parent) throw new AiRunError("unsupported", tr("This layer has no parent."));
  const siblings = (ed.engine.readNode(parent, { childIds: true })?.childIds ?? []).map((c) => ed.engine.readNode(c)).filter((n): n is NodeChange => !!n);
  const mine = node.parentIndex!.position;
  const above = siblings.map((s) => s.parentIndex?.position ?? "").filter((p) => p > mine).sort()[0] ?? null;
  const t = node.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  return insertImageLayer(ed, parent, keyBetween(mine, above), img, { width: rect.width, height: rect.height }, { m00: t.m00, m01: t.m01, m02: t.m02 + t.m00 * rect.x + t.m01 * rect.y, m10: t.m10, m11: t.m11, m12: t.m12 + t.m10 * rect.x + t.m11 * rect.y });
}

/** A new rectangle filled with `img` (Fill mode) under `parent` at `position`. */
function insertImageLayer(ed: EditorController, parent: Guid, position: string, img: ImportedImage, box: { x?: number; y?: number; width: number; height: number }, transform?: NonNullable<NodeChange["transform"]>): Guid {
  const guid = newNodeGuid(ed);
  const change: NodeChange = {
    guid,
    phase: "CREATED",
    type: "ROUNDED_RECTANGLE",
    name: img.name,
    parentIndex: { guid: parent, position },
    size: { x: box.width, y: box.height },
    transform: transform ?? { m00: 1, m01: 0, m02: box.x ?? 0, m10: 0, m11: 1, m12: box.y ?? 0 },
    fillPaints: [imagePaint(img.hash, img, img.name)] as never,
    strokeWeight: 1,
    strokeAlign: "INSIDE",
    visible: true,
    opacity: 1,
  } as NodeChange;
  const message: Message = { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [change] };
  const status = ed.engine.applyChanges(message, "user");
  if (status !== 0) throw new AiRunError("unsupported", tr("The new layer couldn't be added (status {status}).", { status }));
  return guid;
}

/**
 * Expand (owner §10.1): the picture on the larger canvas (the new area transparent) sent to the image route as an
 * Edit asking to fill the empty area; the untouched original re-composited over the answer; the layer grows by
 * `pad` (layer units) in the dragged directions. An image with transparent pixels is refused, as Figma does.
 */
export async function expandImage(env: ToolEnv, t: ImageTarget, pad: Insets, o: RunOptions & { prompt?: string; route?: AiRoute } = {}): Promise<void> {
  if (pad.left + pad.top + pad.right + pad.bottom <= 0) return;
  // Figma refuses an image with transparent pixels (atlas 18 §7.5).
  const src = await env.io.read(t.hash);
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] < 255) throw new AiRunError("unsupported", tr("Expand doesn't work on images with transparent pixels."));
  const { image, k } = await layerPicture(env, t);
  const px: Insets = { left: Math.round(pad.left * k), top: Math.round(pad.top * k), right: Math.round(pad.right * k), bottom: Math.round(pad.bottom * k) };
  const { canvas, mask, at } = expandCanvas(image, px);
  await env.hooks.checkCredits("expand-image");
  const answer = await apiImage(env, { action: "expand-image", image: await pngB64(canvas), mask: await pngB64(mask), size: { width: canvas.width, height: canvas.height }, ...(o.prompt ? { prompt: o.prompt } : {}), ...(o.route ? { route: o.route } : {}) }, o.signal);
  const out = recomposite(answer, image, canvas.width, canvas.height, at);
  const img = await env.io.put(out, nameOf(t));
  const size = t.node.size ?? { x: image.width / k, y: image.height / k };
  const xf = t.node.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  // Figma's result paint is STRETCH (Crop) with the image fitted to the grown layer (atlas 18 §7.5): the picture here
  // is the layer's own, re-composited at the new size, so its transform is the identity.
  const paint = { ...fillPicture(t.paint, img), imageScaleMode: "STRETCH" } as FullPaint;
  writeStep(env.ed, "Expand", () =>
    setFill(env.ed, t, paint, {
      size: { x: size.x + pad.left + pad.right, y: size.y + pad.top + pad.bottom },
      transform: { ...xf, m02: xf.m02 - (xf.m00 * pad.left + xf.m01 * pad.top), m12: xf.m12 - (xf.m10 * pad.left + xf.m11 * pad.top) },
    })
  );
}

/** Edit with prompt: the picture edited by the image route (its paint's settings kept). */
export async function editWithPrompt(env: ToolEnv, t: ImageTarget, prompt: string, o: RunOptions & { reference?: Rgba; route?: AiRoute } = {}): Promise<void> {
  const src = await env.io.read(t.hash);
  await env.hooks.checkCredits("edit-image");
  const answer = await apiImage(env, { action: "edit-image", prompt, image: await pngB64(src), size: { width: src.width, height: src.height }, ...(o.reference ? { reference: await pngB64(o.reference, 1024) } : {}), ...(o.route ? { route: o.route } : {}) }, o.signal);
  const img = await env.io.put(answer, nameOf(t));
  writeStep(env.ed, "Edit image", () => appendFill(env.ed, t, withPicture(t.paint, img)));
}

/** Layers that take a fill for Make an image (Figma: the selected layer, else a new image layer). */
const FILLABLE = new Set(["FRAME", "ROUNDED_RECTANGLE", "RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "VECTOR", "SYMBOL", "INSTANCE", "BOOLEAN_OPERATION"]);

/** Make an image: fills the one selected layer that takes fills, else places a new image layer. Answers its id. */
export async function makeImage(env: ToolEnv, prompt: string, o: RunOptions & { reference?: Rgba; route?: AiRoute; target?: Guid | null } = {}): Promise<Guid | null> {
  const ids = o.target !== undefined ? (o.target ? [o.target] : []) : env.ed.selection;
  const node = ids.length === 1 ? env.ed.withRealType(env.ed.engine.readNode(ids[0])!) : null;
  const fill = node && FILLABLE.has(node.type ?? "") ? node : null;
  const size = fill?.size ? { width: Math.max(1, Math.round(fill.size.x)), height: Math.max(1, Math.round(fill.size.y)) } : { width: 1024, height: 1024 };
  await env.hooks.checkCredits("make-image");
  const answer = await apiImage(env, { action: "make-image", prompt, size, ...(o.reference ? { reference: await pngB64(o.reference, 1024) } : {}), ...(o.route ? { route: o.route } : {}) }, o.signal);
  const name = prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "Image";
  const img = await env.io.put(answer, name);
  if (fill) {
    writeStep(env.ed, "Make an image", () => {
      const status = env.ed.engine.setProps([fill.guid], { fillPaints: [imagePaint(img.hash, img, name)] as never });
      if (status !== 0) throw new AiRunError("unsupported", tr("This layer can't take the picture (status {status}).", { status }));
    });
    return fill.guid;
  }
  // A new image layer the picture's size, in the middle of the view, on top of the page.
  const page = env.ed.store.page;
  const mid = viewCentre(env.ed.canvas);
  const cam = env.ed.engine.getCamera();
  const centre = { x: (mid.x - cam.x) / cam.zoom, y: (mid.y - cam.y) / cam.zoom };
  let id = "" as Guid;
  writeStep(env.ed, "Make an image", () => {
    id = insertImageLayer(env.ed, page, topPosition(env.ed, page), img, { x: Math.round(centre.x - img.width / 2), y: Math.round(centre.y - img.height / 2), width: img.width, height: img.height });
  });
  env.ed.engine.setSelection([id]);
  return id;
}

/** A key after every child of `parent` (the top of its stack). */
function topPosition(ed: EditorController, parent: Guid): string {
  const last = (ed.engine.readNode(parent, { childIds: true })?.childIds ?? [])
    .map((c) => ed.engine.readNode(c)?.parentIndex?.position ?? "")
    .sort()
    .at(-1);
  return keyBetween(last ?? "", null);
}
