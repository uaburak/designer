/**
 * The frames of an animated export (docs/motion.md §7.2): the range the playback style gives ([0, d] once or looping,
 * [0, 2d] there and back for Ping-pong), frame k at t = k / fps, rendered by `engine.motionRenderFrame` (the root's box
 * with the motion layer at t), the event loop given a turn between frames, stopped by an AbortSignal.
 */
import type { Engine } from "@/engine/Engine";
import type { Guid, Pixels } from "@/engine/codec";
import type { Micros, PlaybackName } from "@shared/motion/types";

/** Figma-sized limits [ours, §7.7]: ten minutes, 36 000 frames. */
export const MAX_RANGE_US: Micros = 10 * 60 * 1_000_000;
export const MAX_FRAMES = 36_000;

export interface FramePlan {
  fps: number;
  /** The exported span (Ping-pong: twice the duration) */
  rangeUs: Micros;
  /** Frames in the file */
  frames: number;
  /** µs between frames */
  stepUs: Micros;
}

/** The frames an export makes: the span and their count; null when the limits are passed. */
export function planFrames(durationUs: Micros, playback: PlaybackName, fps: number): FramePlan | null {
  const rangeUs = playback === "PING_PONG" ? 2 * durationUs : durationUs;
  if (!(fps > 0) || !(durationUs > 0) || rangeUs > MAX_RANGE_US) return null;
  const frames = Math.max(1, Math.round((rangeUs * fps) / 1e6));
  if (frames > MAX_FRAMES) return null;
  return { fps, rangeUs, frames, stepUs: 1e6 / fps };
}

/** The timeline time of frame k: Ping-pong folds the second half back. */
export function frameTime(k: number, plan: FramePlan, durationUs: Micros, playback: PlaybackName): Micros {
  const t = Math.round(k * plan.stepUs);
  if (playback === "PING_PONG" && t > durationUs) return Math.max(0, 2 * durationUs - t);
  return Math.min(durationUs, t);
}

/** What the encoders read: the frame count and size, a frame by index (null: cancelled or not drawable). */
export interface FrameSource {
  width: number;
  height: number;
  count: number;
  at(k: number): Promise<Pixels | null>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long an export waits for fonts and images the root draws (exportCore.ts does the same for static exports). */
const READY_TIMEOUT_MS = 10_000;

/**
 * A frame source over the engine: the first call waits for what the root draws (fonts, images) up to ten seconds, the
 * rest draw what there is; each frame gives the event loop a turn so the progress row and Cancel stay live.
 */
export async function engineFrames(engine: Engine, root: Guid, durationUs: Micros, playback: PlaybackName, plan: FramePlan, scale: number, signal?: AbortSignal): Promise<FrameSource | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let first = engine.motionRenderFrame(root, frameTime(0, plan, durationUs, playback), scale);
  while (!first && engine.motionRenderBusy && Date.now() < deadline && !engine.destroyed && !signal?.aborted) {
    await sleep(60);
    first = engine.motionRenderFrame(root, frameTime(0, plan, durationUs, playback), scale);
  }
  if (!first) first = engine.motionRenderFrame(root, frameTime(0, plan, durationUs, playback), scale, { allowPending: true });
  if (!first) return null;
  const cache: { k: number; pixels: Pixels } = { k: 0, pixels: first };
  return {
    width: first.width,
    height: first.height,
    count: plan.frames,
    async at(k) {
      if (signal?.aborted || engine.destroyed) return null;
      if (cache.k === k) return cache.pixels;
      await sleep(0);
      const p = engine.motionRenderFrame(root, frameTime(k, plan, durationUs, playback), scale, { allowPending: true });
      if (!p) return null;
      cache.k = k;
      cache.pixels = p;
      return p;
    },
  };
}

/** Straight RGBA over an opaque colour (video has no alpha): in place. */
export function flattenOnto(p: Pixels, rgb: [number, number, number]): Pixels {
  const px = p.pixels;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255) continue;
    const f = a / 255;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * f + rgb[c] * (1 - f));
    px[i + 3] = 255;
  }
  return p;
}

/** MP4 / WebM want even sizes: the last column / row repeated. */
export function padToEven(p: Pixels): Pixels {
  const w = p.width + (p.width % 2);
  const h = p.height + (p.height % 2);
  if (w === p.width && h === p.height) return p;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(y, p.height - 1);
    out.set(p.pixels.subarray(sy * p.width * 4, (sy + 1) * p.width * 4), y * w * 4);
    if (w > p.width) out.copyWithin((y * w + w - 1) * 4, (y * w + w - 2) * 4, (y * w + w - 1) * 4);
  }
  return { width: w, height: h, pixels: out };
}
