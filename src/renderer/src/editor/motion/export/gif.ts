/**
 * GIF export (docs/motion.md §7.4) on gifenc: one global palette per export from up to 32 sampled frames (256 colours;
 * rgba4444 with 1-bit alpha when a sampled pixel is transparent), `applyPalette` per frame, no dithering; delays in
 * centiseconds with an accumulator (30 fps alternates 3 / 4 cs); above 50 fps the file is 50 fps; Loop → NETSCAPE 0.
 */
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { Pixels } from "@/engine/codec";
import type { FrameSource } from "./frames";

export const GIF_MAX_FPS = 50;
const PALETTE_SAMPLES = 32;
/** Pixels sampled per frame for the palette (every nth), so a 4K frame doesn't feed the whole image to the quantizer. */
const PALETTE_PIXELS = 65_536;

export interface GifOptions {
  fps: number;
  loop: boolean;
}

/** The frame delays (cs) for `count` frames at `fps`: each frame's share, the rounding carried (30 fps → 3, 4, 3, 3, 4…). */
export function gifDelays(count: number, fps: number): number[] {
  const stepMs = 1000 / Math.min(fps, GIF_MAX_FPS);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += stepMs;
    const cs = Math.max(1, Math.round(acc / 10));
    acc -= cs * 10;
    out.push(cs);
  }
  return out;
}

/** Which frames feed the palette: up to 32, evenly spread. */
export function paletteSampleIndices(count: number, samples = PALETTE_SAMPLES): number[] {
  const n = Math.min(count, samples);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.min(count - 1, Math.floor((i * count) / n)));
  return [...new Set(out)];
}

/** Every nth pixel of a frame, as RGBA rows the quantizer takes. */
function samplePixels(p: Pixels, budget: number): Uint8Array {
  const total = p.width * p.height;
  const stride = Math.max(1, Math.floor(total / budget));
  const n = Math.floor(total / stride);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) out.set(p.pixels.subarray(i * stride * 4, i * stride * 4 + 4), i * 4);
  return out;
}

const hasTransparency = (p: Uint8Array): boolean => {
  for (let i = 3; i < p.length; i += 4) if (p[i] < 128) return true;
  return false;
};

/** Frames above 50 fps are thinned: the frame indices written at the file's rate. */
export function gifFrameIndices(count: number, fps: number): number[] {
  if (fps <= GIF_MAX_FPS) return Array.from({ length: count }, (_, i) => i);
  const outCount = Math.max(1, Math.round((count * GIF_MAX_FPS) / fps));
  return Array.from({ length: outCount }, (_, i) => Math.min(count - 1, Math.round((i * fps) / GIF_MAX_FPS)));
}

export async function encodeGif(source: FrameSource, opts: GifOptions, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array | null> {
  // Pass 1: the palette from sampled frames.
  const indices = gifFrameIndices(source.count, opts.fps);
  const samples: Uint8Array[] = [];
  for (const k of paletteSampleIndices(indices.length)) {
    const p = await source.at(indices[k]);
    if (!p) return null;
    samples.push(samplePixels(p, PALETTE_PIXELS));
  }
  const all = new Uint8Array(samples.reduce((n, s) => n + s.length, 0));
  let off = 0;
  for (const s of samples) {
    all.set(s, off);
    off += s.length;
  }
  const transparent = hasTransparency(all);
  const format = transparent ? "rgba4444" : "rgb565";
  const palette = quantize(all, 256, { format, oneBitAlpha: transparent });
  const transparentIndex = transparent ? Math.max(0, palette.findIndex((c) => c.length > 3 && c[3] === 0)) : 0;
  // Pass 2: every frame through the palette.
  const gif = GIFEncoder();
  const delays = gifDelays(indices.length, opts.fps);
  for (let i = 0; i < indices.length; i++) {
    if (signal?.aborted) return null;
    const p = await source.at(indices[i]);
    if (!p) return null;
    const index = applyPalette(p.pixels, palette, format);
    gif.writeFrame(index, p.width, p.height, { palette: i === 0 ? palette : undefined, first: i === 0, delay: delays[i], repeat: opts.loop ? 0 : -1, transparent, transparentIndex, dispose: transparent ? 2 : 0 });
    onProgress?.(i + 1, indices.length);
  }
  gif.finish();
  return gif.bytes();
}
