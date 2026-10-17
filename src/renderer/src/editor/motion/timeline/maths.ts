/**
 * The timeline's geometry (docs/motion.md §6.2): time ↔ x, the ruler's labels, snapping to the timeline's frames
 * (`keyframeSnappingFps`) and, with ⇧ held, to the playhead and the other keyframes; the layer bar's extent. Figma's
 * timeline worker draws the origin at x = 18 px and 16 × 16 diamonds (docs/research/rea/motion.md).
 */
import type { Micros, TimelineLayer } from "@shared/motion/types";

/** Where t = 0 sits in the track area (px from its left edge). */
export const ORIGIN_PX = 18;
/** The diamonds' size. */
export const DIAMOND_PX = 16;
/** The ruler's label steps (ms), the first whose labels are at least `minLabelPx` apart. */
const LABEL_STEPS_MS = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000];

export interface Scale {
  /** Pixels per microsecond */
  pxPerUs: number;
}

/** A scale that fits `durationUs` in `widthPx` (the origin and a right margin left out). */
export function fitScale(durationUs: Micros, widthPx: number, rightMarginPx = 24): Scale {
  const usable = Math.max(1, widthPx - ORIGIN_PX - rightMarginPx);
  return { pxPerUs: usable / Math.max(1, durationUs) };
}

export const timeToX = (timeUs: Micros, s: Scale): number => ORIGIN_PX + timeUs * s.pxPerUs;
export const xToTime = (x: number, s: Scale): Micros => Math.max(0, Math.round((x - ORIGIN_PX) / s.pxPerUs));

export interface Tick {
  timeUs: Micros;
  x: number;
  /** A labelled tick ("250 ms" / "0:01"), else a minor one */
  label: string | null;
}

/** The ruler's ticks over [0, durationUs]: labels every step, minor ticks at a fifth of it. */
export function rulerTicks(durationUs: Micros, s: Scale, unit: "ms" | "frames", fps: number, minLabelPx = 56): Tick[] {
  const stepMs = LABEL_STEPS_MS.find((ms) => ms * 1000 * s.pxPerUs >= minLabelPx) ?? LABEL_STEPS_MS[LABEL_STEPS_MS.length - 1];
  const stepUs = stepMs * 1000;
  const minorUs = stepUs / 5;
  const out: Tick[] = [];
  for (let t = 0; t <= durationUs + 1; t += minorUs) {
    const major = Math.abs(t / stepUs - Math.round(t / stepUs)) < 1e-6;
    out.push({ timeUs: Math.round(t), x: timeToX(t, s), label: major ? formatTime(Math.round(t), unit, fps) : null });
  }
  return out;
}

/** One frame of the snapping grid, µs. */
export const frameUs = (fps: number): Micros => (fps > 0 ? 1e6 / fps : 1e6 / 60);

/** The nearest frame of the grid. */
export const snapToFrame = (timeUs: Micros, fps: number): Micros => Math.max(0, Math.round(timeUs / frameUs(fps)) * frameUs(fps));

/** ⇧ held: the nearest of `targets` within `thresholdUs`, else the frame snap. */
export function snapTime(timeUs: Micros, fps: number, targets: readonly Micros[] = [], thresholdUs: Micros = 0): Micros {
  let best: Micros | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.abs(t - timeUs);
    if (d <= thresholdUs && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best ?? snapToFrame(timeUs, fps);
}

/** The playhead's display: ms ("1250 ms"), or frames at the snapping fps ("75 f"). */
export function formatTime(timeUs: Micros, unit: "ms" | "frames", fps: number): string {
  if (unit === "frames") return `${Math.round(timeUs / frameUs(fps))} f`;
  const ms = timeUs / 1000;
  return `${Number.isInteger(ms) ? ms : ms.toFixed(1)} ms`;
}

/** A typed time → µs (ms, or frames in the frames unit; "1.5s" is seconds). */
export function parseTime(text: string, unit: "ms" | "frames", fps: number): Micros | null {
  const m = text.trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|f)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0) return null;
  const suffix = m[2] ?? (unit === "frames" ? "f" : "ms");
  if (suffix === "s") return Math.round(v * 1e6);
  if (suffix === "f") return Math.round(v * frameUs(fps));
  return Math.round(v * 1000);
}

/** The layer bar: from the first keyframe / clip start to the last keyframe / clip end (none: null). */
export function layerExtent(layer: TimelineLayer): { startUs: Micros; endUs: Micros } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const t of layer.tracks)
    for (const k of t.keyframes) {
      start = Math.min(start, k.timeUs);
      end = Math.max(end, k.timeUs);
    }
  for (const c of layer.clips) {
    start = Math.min(start, c.startUs);
    end = Math.max(end, c.startUs + c.durationUs);
  }
  return start === Infinity ? null : { startUs: start, endUs: end };
}

/** Every keyframe time of the model but the given ones (⇧-snap targets). */
export function otherKeyframeTimes(layers: readonly TimelineLayer[], except: ReadonlySet<string>): Micros[] {
  const out: Micros[] = [];
  for (const l of layers)
    for (const t of l.tracks)
      for (const k of t.keyframes)
        if (!except.has(k.id)) out.push(k.timeUs);
  return out;
}
