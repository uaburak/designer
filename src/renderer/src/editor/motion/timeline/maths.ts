/**
 * The timeline's geometry (docs/motion.md §6.2): time ↔ x, the ruler's labels, snapping to the timeline's frames
 * (`keyframeSnappingFps`) and, with ⇧ held, to the playhead and the other keyframes; the layer bar's extent; the
 * marquee, the height dragged by the top edge and the keyframes copied (increment 2); an audio clip moved and trimmed
 * (round 8e); the layer bar moved or stretched, the snapping grids of the timeline settings (round 8i). Figma's
 * timeline worker draws the origin at x = 18 px and 16 × 16 diamonds (docs/research/rea/motion.md).
 */
import { easingAt } from "@shared/motion/easing";
import type { GuidString, KeyframeValue, Micros, MotionClipboard, TimelineAudioClip, TimelineLayer, TimelineTrack } from "@shared/motion/types";

/** Where t = 0 sits in the track area (px from its left edge). */
export const ORIGIN_PX = 18;
/** The diamonds' size. */
export const DIAMOND_PX = 16;
/** The zoom slider's box at the ruler's right end (Figma's capture: 160 wide); the duration fits left of it. */
export const ZOOM_BOX_PX = 160;
/** The ruler's label steps (ms), the first whose labels are at least `minLabelPx` apart (Figma's captures: 200 ms at 100 px a step, 500 ms where 200 would be 63). */
const LABEL_STEPS_MS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

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
export function rulerTicks(durationUs: Micros, s: Scale, unit: "ms" | "frames", fps: number, minLabelPx = 80): Tick[] {
  const stepMs = LABEL_STEPS_MS.find((ms) => ms * 1000 * s.pxPerUs >= minLabelPx) ?? LABEL_STEPS_MS[LABEL_STEPS_MS.length - 1];
  const stepUs = stepMs * 1000;
  const minorUs = stepUs / 5;
  const out: Tick[] = [];
  for (let t = 0; t <= durationUs + 1; t += minorUs) {
    const major = Math.abs(t / stepUs - Math.round(t / stepUs)) < 1e-6;
    out.push({ timeUs: Math.round(t), x: timeToX(t, s), label: major ? rulerLabel(Math.round(t), unit, fps) : null });
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

/**
 * A ruler label as Figma's timeline writes it (the owner's capture, 2026-10-18: "0s 500ms 1s 500ms 2s"): whole seconds
 * as "1s", the rest as the milliseconds past the last second; frames as the frame number.
 */
export function rulerLabel(timeUs: Micros, unit: "ms" | "frames", fps: number): string {
  if (unit === "frames") return String(Math.round(timeUs / frameUs(fps)));
  const ms = Math.round(timeUs / 1000);
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms % 1000}ms`;
}

/** The header's time fields (Figma's "1855 2000 ms"): the number alone, the unit beside the fields. */
export function timeNumber(timeUs: Micros, unit: "ms" | "frames", fps: number): string {
  if (unit === "frames") return String(Math.round(timeUs / frameUs(fps)));
  return String(Math.round(timeUs / 1000));
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

/**
 * A track's value at `timeUs` (the property row's value, Figma's "190.6, 246" / "100%"): its keyframes' values eased
 * into each keyframe by its easing (a bound easing read as linear), the first before the first, the last after the last.
 */
export function trackValueAt(track: TimelineTrack, timeUs: Micros): KeyframeValue | null {
  const ks = [...track.keyframes].sort((a, b) => a.timeUs - b.timeUs);
  if (!ks.length) return null;
  if (timeUs <= ks[0].timeUs) return ks[0].value;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1];
    const b = ks[i];
    if (timeUs > b.timeUs) continue;
    const p = (timeUs - a.timeUs) / Math.max(1, b.timeUs - a.timeUs);
    const e = "type" in b.easing ? easingAt(b.easing, p) : p;
    const mix = (x: number, y: number) => x + (y - x) * e;
    if (a.value.type === "FLOAT" && b.value.type === "FLOAT") return { type: "FLOAT", value: mix(a.value.value, b.value.value) };
    if (a.value.type === "VECTOR" && b.value.type === "VECTOR") return { type: "VECTOR", value: { x: mix(a.value.value.x, b.value.value.x), y: mix(a.value.value.y, b.value.value.y) } };
    if (a.value.type === "COLOR" && b.value.type === "COLOR") {
      const ca = a.value.value;
      const cb = b.value.value;
      return { type: "COLOR", value: { r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: mix(ca.a, cb.a) } };
    }
    return e >= 1 ? b.value : a.value;
  }
  return ks[ks.length - 1].value;
}

const tenth = (v: number) => String(Math.round(v * 10) / 10);
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();

/** A property row's value as Figma writes it: opacity, trims and scale in %, rotation in °, the rest to a tenth. */
export function formatTrackValue(track: TimelineTrack, value: KeyframeValue | null): string {
  if (!value) return "";
  const name = track.field.type === "PROPERTY" ? track.field.name : null;
  const percent = name === "OPACITY" || name === "PATH_TRIM_START" || name === "PATH_TRIM_END" || !!name?.startsWith("SCALE") || (track.field.type === "INDEXED_ITEM" && "opacity" in track.field && !!track.field.opacity);
  switch (value.type) {
    case "FLOAT":
      return percent ? `${Math.round(value.value * 100)}%` : name === "ROTATION" ? `${tenth(value.value)}°` : tenth(value.value);
    case "VECTOR":
      return percent ? `${Math.round(value.value.x * 100)}%, ${Math.round(value.value.y * 100)}%` : `${tenth(value.value.x)}, ${tenth(value.value.y)}`;
    case "COLOR":
      return hex2(value.value.r) + hex2(value.value.g) + hex2(value.value.b);
    default:
      return "";
  }
}

/** The keyframe time before (−1) / after (1) `timeUs` on a track — the property row's ‹ and › — else null. */
export function adjacentKeyframe(track: TimelineTrack, timeUs: Micros, dir: -1 | 1): Micros | null {
  const times = track.keyframes.map((k) => k.timeUs).sort((a, b) => a - b);
  if (dir < 0) return [...times].reverse().find((t) => t < timeUs - 500) ?? null;
  return times.find((t) => t > timeUs + 500) ?? null;
}

/**
 * The layer bar dragged by `dUs` (round 8i, docs/motion.md §6.2): "move" shifts the whole span (never before 0), "end"
 * stretches it from its start, "start" from its end; never shorter than `minUs`. `snap` places the dragged edge.
 */
export function retimeLayer(ext: { startUs: Micros; endUs: Micros }, edge: "move" | "start" | "end", dUs: number, snap: (us: number) => Micros, minUs: Micros): { startUs: Micros; endUs: Micros } {
  const length = ext.endUs - ext.startUs;
  if (edge === "move") {
    const start = Math.max(0, snap(ext.startUs + dUs));
    return { startUs: start, endUs: start + length };
  }
  if (edge === "end") return { startUs: ext.startUs, endUs: Math.max(ext.startUs + minUs, snap(ext.endUs + dUs)) };
  return { startUs: Math.min(ext.endUs - minUs, Math.max(0, snap(ext.startUs + dUs))), endUs: ext.endUs };
}

/**
 * The timeline settings' snapping grid (Figma's, docs/motion.md §6.2): its presets per unit — in ms the grid's step
 * (100 / 50 / 10 ms, i.e. 10 / 20 / 100 fps), in frames the frame rates — and a typed one: a step in ms becomes
 * 1000 / ms fps clamped 1–1000, a frame rate is rounded and clamped 1–120. Off (ms) snaps to the millisecond [ours].
 */
export const GRID_OFF_FPS = 1000;
export function gridFromMs(ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(1000, Math.max(1, 1000 / ms));
}
export function gridFromFps(fps: number): number | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.min(120, Math.max(1, Math.round(fps)));
}
/** A grid's label in a unit: "100 ms", "Off"; "29.97 fps". */
export function gridLabel(fps: number, unit: "ms" | "frames"): string {
  if (unit === "ms") return fps >= GRID_OFF_FPS ? "Off" : `${Math.round((1000 / fps) * 100) / 100} ms`;
  return `${Math.round(fps * 1000) / 1000} fps`;
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
