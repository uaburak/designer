/**
 * Boost resolution's tiling (docs/ai.md §2.6): Swin2SR x4 runs on 128 px tiles overlapping by 16 px (bounded memory
 * on a 16 GB Mac), the tiles' outputs blended with linear ramps across the overlaps; the output's long side is capped
 * at 4096 (the input is scaled down first when ×4 would pass it). The model is RGB-only: alpha is resized on its own.
 */
import { blank, crop, resize, type Rect, type Rgba } from "./pixels";

export const TILE = 128;
export const OVERLAP = 16;
export const SCALE = 4;
export const MAX_OUTPUT = 4096;

/** Tile origins along one axis: steps of tile − overlap, the last one flush with the end. */
function starts(length: number, tile: number, overlap: number): number[] {
  if (length <= tile) return [0];
  const step = tile - overlap;
  const out: number[] = [];
  for (let s = 0; s + tile < length; s += step) out.push(s);
  out.push(length - tile);
  return out;
}

/** The tiles covering w × h. */
export function tilePlan(width: number, height: number, tile = TILE, overlap = OVERLAP): Rect[] {
  const out: Rect[] = [];
  for (const y of starts(height, tile, overlap)) for (const x of starts(width, tile, overlap)) out.push({ x, y, width: Math.min(tile, width), height: Math.min(tile, height) });
  return out;
}

/** The input size to upscale so the output's long side stays ≤ `cap`. */
export function boostInputSize(width: number, height: number, scale = SCALE, cap = MAX_OUTPUT): { width: number; height: number } {
  const long = Math.max(width, height) * scale;
  if (long <= cap) return { width, height };
  const k = cap / long;
  return { width: Math.max(1, Math.floor(width * k)), height: Math.max(1, Math.floor(height * k)) };
}

/** A tile's blend weight at (x, y) of its w × h: ramps over the overlap on sides that have a neighbour. */
function weight(x: number, w: number, ramp: number, lo: boolean, hi: boolean): number {
  let v = 1;
  if (lo && x < ramp) v = Math.min(v, (x + 0.5) / ramp);
  if (hi && x >= w - ramp) v = Math.min(v, (w - x - 0.5) / ramp);
  return v;
}

/**
 * Upscales `src` ×`scale` tile by tile with `run` (one tile in, its ×scale out). `onTile(done, total)` reports progress;
 * `signal` stops between tiles.
 */
export async function upscaleTiled(src0: Rgba, run: (tile: Rgba) => Promise<Rgba>, o: { scale?: number; tile?: number; overlap?: number; cap?: number; onTile?(done: number, total: number): void; signal?: AbortSignal } = {}): Promise<Rgba> {
  const scale = o.scale ?? SCALE, tile = o.tile ?? TILE, overlap = o.overlap ?? OVERLAP;
  const size = boostInputSize(src0.width, src0.height, scale, o.cap ?? MAX_OUTPUT);
  const src = size.width === src0.width && size.height === src0.height ? src0 : resize(src0, size.width, size.height);
  const W = src.width * scale, H = src.height * scale;
  const acc = new Float32Array(W * H * 3);
  const wsum = new Float32Array(W * H);
  const plan = tilePlan(src.width, src.height, tile, overlap);
  const ramp = overlap * scale;
  let done = 0;
  for (const t of plan) {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("Cancelled");
    const out = await run(crop(src, t));
    if (out.width !== t.width * scale || out.height !== t.height * scale) throw new Error(`A tile came back ${out.width} × ${out.height}, not ×${scale}`);
    const lo = { x: t.x > 0, y: t.y > 0 };
    const hi = { x: t.x + t.width < src.width, y: t.y + t.height < src.height };
    for (let y = 0; y < out.height; y++) {
      const wy = weight(y, out.height, ramp, lo.y, hi.y);
      for (let x = 0; x < out.width; x++) {
        const w = wy * weight(x, out.width, ramp, lo.x, hi.x);
        const di = (t.y * scale + y) * W + t.x * scale + x;
        const si = (y * out.width + x) * 4;
        acc[di * 3] += out.data[si] * w;
        acc[di * 3 + 1] += out.data[si + 1] * w;
        acc[di * 3 + 2] += out.data[si + 2] * w;
        wsum[di] += w;
      }
    }
    o.onTile?.(++done, plan.length);
  }
  const alpha = resize(src, W, H);
  const result = blank(W, H);
  for (let i = 0; i < W * H; i++) {
    const w = wsum[i] || 1;
    result.data[i * 4] = Math.round(acc[i * 3] / w);
    result.data[i * 4 + 1] = Math.round(acc[i * 3 + 1] / w);
    result.data[i * 4 + 2] = Math.round(acc[i * 3 + 2] / w);
    result.data[i * 4 + 3] = alpha.data[i * 4 + 3];
  }
  return result;
}
