/**
 * Animated export (docs/motion.md §7.1, §7.7): a timeline root with `AnimatedExportSettings` → one file — MP4 / WebM
 * through WebCodecs (video.ts), GIF through gifenc (gif.ts); SVG, Lottie and dotLottie come with their writers (§7.5,
 * §7.6, a later increment). The frames come from the engine (frames.ts); the file is saved the way static exports are
 * (exporting.ts: the desktop's Save dialog, a download in a browser). One export at a time per file.
 */
import type { Guid } from "@/engine/codec";
import { t } from "@/i18n";
import { ANIMATED_FORMAT_LABELS, type AnimatedExportSettings, type AnimatedFormat, type Micros, type PlaybackName } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { exportAllowed, saveFiles, type ExportedFile } from "../../exporting";
import { mixAudio } from "../audio/audio";
import { motionRead } from "../motionState";
import { audioBufferSource } from "./audioTrack";
import { engineFrames, planFrames } from "./frames";
import { encodeGif } from "./gif";
import { VideoExportError, encodeVideo } from "./video";

export const ANIMATED_EXTENSION: Record<AnimatedFormat, string> = { MP4: "mp4", WEBM: "webm", GIF: "gif", SVG: "svg", LOTTIE: "json", DOTLOTTIE: "lottie" };
/** The formats this build writes; the rest are listed disabled in the panel. */
export const ANIMATED_FORMATS_BUILT: readonly AnimatedFormat[] = ["MP4", "WEBM", "GIF"];

export interface AnimatedExportJob {
  root: Guid;
  name: string;
  settings: AnimatedExportSettings;
}

export interface AnimatedProgress {
  /** Which job (several frames) */
  job: number;
  jobs: number;
  frame: number;
  frames: number;
  phase: "render" | "encode" | "done";
}

export const animatedFileName = (name: string, format: AnimatedFormat): string => `${name || "Animation"}.${ANIMATED_EXTENSION[format]}`;

/** The scale of a Size setting for a root of `width` × `height` (a custom size: the width's factor, the height following). */
export function scaleOf(size: AnimatedExportSettings["size"], width: number, height: number): number {
  if ("scale" in size) return Math.max(0.01, size.scale);
  const sx = size.width > 0 && width > 0 ? size.width / width : 0;
  const sy = size.height > 0 && height > 0 ? size.height / height : 0;
  return Math.max(0.01, sx || sy || 1);
}

/** A timeline root's span and playback as the engine holds them (null: not a timeline root, or no Motion in this wasm). */
export function timelineOf(ed: EditorController, root: Guid): { durationUs: Micros; playback: PlaybackName; name: string; width: number; height: number } | null {
  const model = motionRead(() => ed.engine.motionTimeline(root), null);
  if (!model || model.root !== root) return null;
  const node = ed.engine.readNode(root) as { name?: string; size?: { x: number; y: number } } | null;
  return { durationUs: model.durationUs, playback: model.playback, name: node?.name ?? model.rootName, width: node?.size?.x ?? 0, height: node?.size?.y ?? 0 };
}

/** One job's file, or why not. */
export async function renderAnimated(ed: EditorController, job: AnimatedExportJob, onProgress?: (p: Omit<AnimatedProgress, "job" | "jobs">) => void, signal?: AbortSignal): Promise<{ bytes: Uint8Array } | { error: string }> {
  const { settings } = job;
  if (!ANIMATED_FORMATS_BUILT.includes(settings.format)) return { error: t("{format} export isn't built yet", { format: ANIMATED_FORMAT_LABELS[settings.format] }) };
  const tl = timelineOf(ed, job.root);
  if (!tl) return { error: t("Select a top-level frame to export animations") };
  const plan = planFrames(tl.durationUs, tl.playback, settings.fps);
  if (!plan) return { error: t("The animation is too long to export") };
  const scale = scaleOf(settings.size, tl.width, tl.height);
  const source = await engineFrames(ed.engine, job.root, tl.durationUs, tl.playback, plan, scale, signal);
  if (!source) return { error: signal?.aborted ? t("Export cancelled") : t("Couldn't draw the animation") };
  const progress = (frame: number, frames: number) => onProgress?.({ frame, frames, phase: "encode" });
  try {
    if (settings.format === "GIF") {
      const bytes = await encodeGif(source, { fps: settings.fps, loop: settings.loop }, progress, signal);
      return bytes ? { bytes } : { error: signal?.aborted ? t("Export cancelled") : t("Couldn't draw the animation") };
    }
    if (settings.format !== "MP4" && settings.format !== "WEBM") return { error: t("{format} export isn't built yet", { format: ANIMATED_FORMAT_LABELS[settings.format] }) };
    // The timeline's audio over the exported span, mixed (§7.3; none: no audio track).
    const model = motionRead(() => ed.engine.motionTimeline(job.root), null);
    const mix = model?.audio.length ? await mixAudio(ed, model, plan.rangeUs).catch(() => null) : null;
    const bytes = await encodeVideo(source, { format: settings.format, fps: settings.fps, quality: settings.quality, audio: mix ? audioBufferSource(mix) : null }, progress, signal);
    return { bytes };
  } catch (e) {
    if (e instanceof VideoExportError) return { error: e.code === "cancelled" ? t("Export cancelled") : e.code === "unsupported" ? t("This format isn't supported on this device") : e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Renders every job and saves the files; the errors, per job, for the caller to toast. */
export async function exportAnimated(ed: EditorController, jobs: readonly AnimatedExportJob[], onProgress?: (p: AnimatedProgress) => void, signal?: AbortSignal): Promise<{ saved: boolean; errors: string[] }> {
  if (!exportAllowed(ed)) return { saved: false, errors: [] };
  const files: ExportedFile[] = [];
  const errors: string[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const r = await renderAnimated(ed, job, (p) => onProgress?.({ ...p, job: i, jobs: jobs.length }), signal);
    if ("error" in r) errors.push(`${job.name}: ${r.error}`);
    else files.push({ name: animatedFileName(job.name, job.settings.format), bytes: r.bytes });
    if (signal?.aborted) break;
  }
  onProgress?.({ job: jobs.length, jobs: jobs.length, frame: 0, frames: 0, phase: "done" });
  const saved = files.length > 0 && !signal?.aborted ? await saveFiles(ed, files) : false;
  return { saved, errors };
}
