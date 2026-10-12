/**
 * The local image tools' model calls (docs/ai.md §2.6) — the pre- and post-processing around one ONNX run each, pure
 * apart from `runModel` (the worker; tests put a fake runner there):
 * - Remove background: BiRefNet lite at 1024², ImageNet mean / std, the logits' sigmoid as the matte, resized back and
 *   applied as alpha.
 * - Boost resolution: Swin2SR x4 per 128 px tile (tiles.ts), each padded to a multiple of 8 (its window), values 0…1.
 * - Erase: LaMa on a 512² crop around the lasso (image 0…1, mask 0 / 1; its output is 0…255), put back inside a
 *   feathered mask.
 * - Isolate: the lasso's crop through BiRefNet, the matte intersected with the lasso.
 */
import type { AiModelId } from "../../../../shared/ai/types";
import { applyMatte, blank, blendMasked, crop, dilate, feather, fromChw, grow, maskBounds, matteFromLogits, resize, resizeMap, toChw, type Rect, type Rgba } from "./pixels";
import { upscaleTiled } from "./tiles";
import { runModel, type OnnxTensor } from "./worker";

/** Each model's ONNX file (the pins in src/main/ai/models.ts). */
export const MODEL_FILE: Partial<Record<AiModelId, string>> = {
  "birefnet-lite": "onnx/model_fp16.onnx",
  "swin2sr-x4": "onnx/model_fp16.onnx",
  lama: "inpainting_lama_2025jan.onnx",
};

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
export const BIREFNET_SIZE = 1024;
export const LAMA_SIZE = 512;

async function onnx(id: AiModelId, inputs: OnnxTensor[]): Promise<OnnxTensor[]> {
  const out = (await runModel(id, { kind: "onnx", file: MODEL_FILE[id]!, inputs })) as OnnxTensor[];
  if (!Array.isArray(out) || !out.length) throw new Error("The model gave no answer.");
  return out;
}

const count = (dims: number[]) => dims.reduce((a, b) => a * b, 1);

/** The picture's foreground matte (0…255, the picture's size). */
export async function foregroundMatte(image: Rgba): Promise<Uint8Array> {
  const input = resize(image, BIREFNET_SIZE, BIREFNET_SIZE);
  const out = await onnx("birefnet-lite", [{ data: toChw(input, IMAGENET_MEAN, IMAGENET_STD), dims: [1, 3, BIREFNET_SIZE, BIREFNET_SIZE] }]);
  // BiRefNet answers its last (finest) prediction last.
  const pred = [...out].reverse().find((t) => count(t.dims) === BIREFNET_SIZE * BIREFNET_SIZE);
  if (!pred) throw new Error("The background model answered an unexpected shape.");
  return resizeMap(matteFromLogits(pred.data), BIREFNET_SIZE, BIREFNET_SIZE, image.width, image.height);
}

export async function removeBackground(image: Rgba): Promise<Rgba> {
  return applyMatte(image, await foregroundMatte(image));
}

/** One tile ×4 (padded to Swin2SR's window by repeating the edge, the padding cropped off the answer). */
export async function upscaleTile(tile: Rgba): Promise<Rgba> {
  const pw = Math.ceil(tile.width / 8) * 8, ph = Math.ceil(tile.height / 8) * 8;
  const padded = blank(pw, ph);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const sx = x < tile.width ? x : 2 * tile.width - 1 - x;
      const sy = y < tile.height ? y : 2 * tile.height - 1 - y;
      const i = (Math.max(0, sy) * tile.width + Math.max(0, sx)) * 4, o = (y * pw + x) * 4;
      padded.data.set(tile.data.subarray(i, i + 4), o);
    }
  const [out] = await onnx("swin2sr-x4", [{ data: toChw(padded), dims: [1, 3, ph, pw] }]);
  const [, , oh, ow] = out.dims;
  if (oh !== ph * 4 || ow !== pw * 4) throw new Error("The resolution model answered an unexpected shape.");
  return crop(fromChw(out.data, ow, oh, 255), { x: 0, y: 0, width: tile.width * 4, height: tile.height * 4 });
}

export function boostResolution(image: Rgba, o: { onTile?(done: number, total: number): void; signal?: AbortSignal } = {}): Promise<Rgba> {
  return upscaleTiled(image, upscaleTile, o);
}

/** The square-ish region LaMa sees around the mask: the mask's bounds with as much context again around them. */
export function inpaintRegion(bounds: Rect, width: number, height: number): Rect {
  const side = Math.min(Math.max(width, height), Math.max(64, Math.ceil(Math.max(bounds.width, bounds.height) * 2)));
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const w = Math.min(width, side), h = Math.min(height, side);
  const x = Math.round(Math.min(Math.max(0, cx - w / 2), width - w));
  const y = Math.round(Math.min(Math.max(0, cy - h / 2), height - h));
  return { x, y, width: w, height: h };
}

/** The area under `mask` (the picture's size, 0 / 255) filled in from its surroundings. */
export async function erase(image: Rgba, mask: Uint8Array): Promise<Rgba> {
  const bounds = maskBounds(mask, image.width, image.height);
  if (!bounds) return image;
  const region = inpaintRegion(bounds, image.width, image.height);
  const sub = crop(image, region);
  const subMask = new Uint8Array(region.width * region.height);
  for (let y = 0; y < region.height; y++) subMask.set(mask.subarray((region.y + y) * image.width + region.x, (region.y + y) * image.width + region.x + region.width), y * region.width);
  const grown = dilate(subMask, region.width, region.height, 4);
  const img512 = resize(sub, LAMA_SIZE, LAMA_SIZE);
  const mask512 = resizeMap(grown, region.width, region.height, LAMA_SIZE, LAMA_SIZE);
  const maskData = Float32Array.from(mask512, (v) => (v > 0 ? 1 : 0));
  const [out] = await onnx("lama", [
    { data: toChw(img512), dims: [1, 3, LAMA_SIZE, LAMA_SIZE] },
    { data: maskData, dims: [1, 1, LAMA_SIZE, LAMA_SIZE] },
  ]);
  let max = 0;
  for (let i = 0; i < out.data.length; i += 97) max = Math.max(max, out.data[i]);
  const filled = resize(fromChw(out.data, LAMA_SIZE, LAMA_SIZE, max <= 1.5 ? 255 : 1), region.width, region.height);
  // Alpha stays the picture's own.
  for (let i = 0; i < sub.width * sub.height; i++) filled.data[i * 4 + 3] = sub.data[i * 4 + 3];
  return blendMasked(image, filled, feather(dilate(subMask, region.width, region.height, 2), region.width, region.height, 3), region.x, region.y);
}

/** The lassoed object as its own picture (transparent around it) and where it sits in the original. */
export async function isolate(image: Rgba, mask: Uint8Array): Promise<{ image: Rgba; rect: Rect } | null> {
  const bounds = maskBounds(mask, image.width, image.height);
  if (!bounds) return null;
  const rect = grow(bounds, 2, image.width, image.height);
  const sub = crop(image, rect);
  const lasso = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) lasso.set(mask.subarray((rect.y + y) * image.width + rect.x, (rect.y + y) * image.width + rect.x + rect.width), y * rect.width);
  const matte = await foregroundMatte(sub);
  const soft = feather(lasso, rect.width, rect.height, 1);
  for (let i = 0; i < matte.length; i++) matte[i] = Math.min(matte[i], soft[i]);
  return { image: applyMatte(sub, matte), rect };
}
