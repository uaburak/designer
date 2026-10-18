/**
 * The timeline's geometry (docs/motion.md §6.2): time ↔ x, the ruler's labels, snapping to the timeline's frames
 * (`keyframeSnappingFps`) and, with ⇧ held, to the playhead and the other keyframes; the layer bar's extent; the
 * marquee, the height dragged by the top edge and the keyframes copied (increment 2); an audio clip moved and trimmed
 * (round 8e). Figma's
 * timeline worker draws the origin at x = 18 px and 16 × 16 diamonds (docs/research/rea/motion.md).
 */
import type { GuidString, Micros, MotionClipboard, TimelineAudioClip, TimelineLayer } from "@shared/motion/types";

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

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The marquee between the press and the pointer (either corner first). */
export const marqueeBox = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
  left: Math.min(a.x, b.x),
  top: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

/** Do the two boxes overlap (a diamond the marquee touches is in it)? */
export const overlaps = (a: Box, b: Box): boolean => a.left <= b.left + b.width && b.left <= a.left + a.width && a.top <= b.top + b.height && b.top <= a.top + a.height;

/** The timeline's height dragged by its top edge (docs/motion.md §6.2): at least 120, at most 60 % of the window. */
export const TIMELINE_MIN_PX = 120;
export const clampTimelineHeight = (px: number, windowPx: number): number => Math.round(Math.max(TIMELINE_MIN_PX, Math.min(px, windowPx * 0.6)));

/**
 * Keyframes copied from the timeline (§6.2: ⌘C / ⌘V copy and paste keyframes at the playhead, ours): per layer, per
 * track, each keyframe's value and easing at its distance from the earliest one copied.
 */
export interface KeyframeCopy {
  node: GuidString;
  tracks: MotionClipboard["tracks"];
}

export function copyKeyframes(layers: readonly TimelineLayer[], ids: ReadonlySet<GuidString>): KeyframeCopy[] {
  let first = Infinity;
  for (const l of layers) for (const t of l.tracks) for (const k of t.keyframes) if (ids.has(k.id)) first = Math.min(first, k.timeUs);
  const out: KeyframeCopy[] = [];
  for (const l of layers) {
    const tracks = l.tracks
      .map((t) => ({ field: t.field, keyframes: t.keyframes.filter((k) => ids.has(k.id)).map((k) => ({ dtUs: k.timeUs - first, value: k.value, easing: k.easing })) }))
      .filter((t) => t.keyframes.length);
    if (tracks.length) out.push({ node: l.node, tracks });
  }
  return out;
}

/**
 * An audio clip dragged (round 8e, docs/motion.md §6.6): "move" shifts it in time; "start" trims its head (the region
 * starts later in the file and on the timeline), "end" its tail; never before the file's start or past its end
 * (`lengthUs`, null while the file isn't decoded), never shorter than `minUs`. `toUs` is the dragged edge's new time.
 */
export function trimAudio(clip: TimelineAudioClip, edge: "move" | "start" | "end", toUs: Micros, lengthUs: Micros | null, minUs: Micros): { offsetUs?: Micros; startUs?: Micros; durationUs?: Micros } {
  const end = clip.offsetUs + clip.durationUs;
  if (edge === "move") return { offsetUs: Math.max(0, Math.round(toUs)) };
  if (edge === "end") {
    const most = lengthUs === null ? Infinity : lengthUs - clip.startUs;
    return { durationUs: Math.round(Math.max(minUs, Math.min(most, toUs - clip.offsetUs))) };
  }
  // The head: back as far as the file's start (and the timeline's), on as far as the tail less minUs.
  const offset = Math.round(Math.min(end - minUs, Math.max(0, clip.offsetUs - clip.startUs, toUs)));
  return { offsetUs: offset, startUs: clip.startUs + (offset - clip.offsetUs), durationUs: end - offset };
}
