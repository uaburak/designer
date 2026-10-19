/**
 * Animated export (docs/motion.md §7.1, §7.7): a timeline root with `AnimatedExportSettings` → one file — MP4 / WebM
 * through WebCodecs (video.ts) with the timeline's audio muxed (audioTrack.ts), GIF through gifenc (gif.ts), animated
 * SVG (svg.ts) and Lottie (lottie/) from the engine's shapes and samples (vectorAnim.ts); dotLottie holds every frame's
 * animation in one file. The frames come from the engine (frames.ts); the file is saved the way static exports are
 * (exporting.ts: the desktop's Save dialog, a download in a browser). One export at a time per file (round 8e: the
 * lock below; a second one is refused while one runs).
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
import { animationId, writeDotLottie } from "./lottie/dotLottie";
import { writeLottie, type LottieAsset } from "./lottie/lottie";
import { writeAnimatedSvg } from "./svg";
import { base64, rasterLayers, rasterPng, sampleScene, type AnimScene } from "./vectorAnim";
import { VideoExportError, encodeVideo } from "./video";

export const ANIMATED_EXTENSION: Record<AnimatedFormat, string> = { MP4: "mp4", WEBM: "webm", GIF: "gif", SVG: "svg", LOTTIE: "json", DOTLOTTIE: "lottie" };
/** The formats this build writes; the rest are listed disabled in the panel. */
export const ANIMATED_FORMATS_BUILT: readonly AnimatedFormat[] = ["MP4", "WEBM", "GIF", "SVG", "LOTTIE", "DOTLOTTIE"];

// ---- One export at a time per file (docs/motion.md §7.7) -------------------------------------------------------------

const running = new WeakSet<EditorController>();
const lockListeners = new Set<() => void>();

/** Whether an animated export of this editor's file is running (the Animated tab disables Export meanwhile). */
export const animatedExportRunning = (ed: EditorController): boolean => running.has(ed);
export function onAnimatedExportLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => void lockListeners.delete(listener);
}
function setRunning(ed: EditorController, on: boolean): void {
  if (on) running.add(ed);
  else running.delete(ed);
  lockListeners.forEach((l) => l());
}

/**
 * Takes the file's one animated export (this tab's, and Social's export of posts with videos, docs/social.md §8): its
 * release, or null while another export holds it.
 */
export function takeAnimatedExport(ed: EditorController): (() => void) | null {
  if (running.has(ed)) return null;
  setRunning(ed, true);
  return () => setRunning(ed, false);
}

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
  if (settings.format === "SVG" || settings.format === "LOTTIE") {
    const v = await vectorOf(ed, job, settings.format === "LOTTIE" ? "embed" : "svg");
    if ("error" in v) return v;
    return { bytes: new TextEncoder().encode(settings.format === "SVG" ? v.svg! : JSON.stringify(v.lottie)) };
  }
  if (settings.format === "DOTLOTTIE") {
    const v = await vectorOf(ed, job, "files");
    if ("error" in v) return v;
    return { bytes: await writeDotLottie([{ id: animationId(job.name, 0), json: v.lottie! }], v.images) };
  }
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

/** A PNG's size from its header (IHDR). */
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length >= 24 ? { width: v.getUint32(16), height: v.getUint32(20) } : { width: 0, height: 0 };
};

/**
 * A root's vector animation: sampled at the frame rate, its raster layers drawn at the Size — as an animated SVG, or
 * Lottie JSON with the images embedded ("embed") or as files for dotLottie ("files").
 */
async function vectorOf(ed: EditorController, job: AnimatedExportJob, mode: "svg" | "embed" | "files"): Promise<{ svg?: string; lottie?: object; images: { name: string; bytes: Uint8Array }[] } | { error: string }> {
  const tl = timelineOf(ed, job.root)!;
  const plan = planFrames(tl.durationUs, tl.playback, job.settings.fps)!;
  const scale = scaleOf(job.settings.size, tl.width, tl.height);
  const scene: AnimScene | null = sampleScene(ed, job.root, plan, tl.durationUs, tl.playback);
  if (!scene) return { error: t("Couldn't draw the animation") };
  const rasters = new Map<string, { bytes: Uint8Array; width: number; height: number }>();
  for (const l of rasterLayers(scene.root)) {
    const bytes = await rasterPng(ed, l.shape.node, scale);
    if (bytes) rasters.set(l.shape.node, { bytes, ...pngSize(bytes) });
  }
  if (mode === "svg") return { svg: writeAnimatedSvg(scene, { scale, playback: tl.playback, durationMs: plan.rangeUs / 1000, rasters }), images: [] };
  const assets = new Map<string, LottieAsset>();
  const images: { name: string; bytes: Uint8Array }[] = [];
  let k = 0;
  for (const [node, r] of rasters) {
    const id = `image_${k++}`;
    if (mode === "embed") assets.set(node, { id, w: r.width, h: r.height, u: "", p: `data:image/png;base64,${base64(r.bytes)}`, e: 1 });
    else {
      images.push({ name: `${id}.png`, bytes: r.bytes });
      assets.set(node, { id, w: r.width, h: r.height, u: "/images/", p: `${id}.png`, e: 0 });
    }
  }
  return { lottie: writeLottie(scene, { name: job.name, scale, rasters: assets }), images };
}

/** Renders every job and saves the files; the errors, per job, for the caller to toast. */
export async function exportAnimated(ed: EditorController, jobs: readonly AnimatedExportJob[], onProgress?: (p: AnimatedProgress) => void, signal?: AbortSignal): Promise<{ saved: boolean; errors: string[] }> {
  if (!exportAllowed(ed)) return { saved: false, errors: [] };
  const release = takeAnimatedExport(ed);
  if (!release) return { saved: false, errors: [t("An animation is already being exported")] };
  try {
    return await exportJobs(ed, jobs, onProgress, signal);
  } finally {
    release();
  }
}

async function exportJobs(ed: EditorController, jobs: readonly AnimatedExportJob[], onProgress?: (p: AnimatedProgress) => void, signal?: AbortSignal): Promise<{ saved: boolean; errors: string[] }> {
  const files: ExportedFile[] = [];
  const errors: string[] = [];
  // dotLottie: one file with every frame's animation (§7.6), named after the first.
  const dot = jobs.filter((j) => j.settings.format === "DOTLOTTIE");
  if (dot.length > 1) {
    const animations: { id: string; json: object }[] = [];
    const images: { name: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < dot.length; i++) {
      onProgress?.({ job: i, jobs: dot.length, frame: 0, frames: 0, phase: "render" });
      const v = await vectorOf(ed, dot[i], "files");
      if ("error" in v) {
        errors.push(`${dot[i].name}: ${v.error}`);
        continue;
      }
      // Each animation's images under their own prefix, so two animations' image_0 don't collide.
      const prefix = `a${i}_`;
      const json = JSON.parse(JSON.stringify(v.lottie).replace(/"p":"image_/g, `"p":"${prefix}image_`)) as object;
      const id = animations.some((a) => a.id === animationId(dot[i].name, 0)) ? animationId(dot[i].name, i) : animationId(dot[i].name, 0);
      animations.push({ id, json });
      images.push(...v.images.map((im) => ({ name: prefix + im.name, bytes: im.bytes })));
      if (signal?.aborted) break;
    }
    if (animations.length) files.push({ name: animatedFileName(dot[0].name, "DOTLOTTIE"), bytes: await writeDotLottie(animations, images) });
  }
  const rest = dot.length > 1 ? jobs.filter((j) => j.settings.format !== "DOTLOTTIE") : jobs;
  for (let i = 0; i < rest.length; i++) {
    const job = rest[i];
    const r = await renderAnimated(ed, job, (p) => onProgress?.({ ...p, job: i, jobs: rest.length }), signal);
    if ("error" in r) errors.push(`${job.name}: ${r.error}`);
    else files.push({ name: animatedFileName(job.name, job.settings.format), bytes: r.bytes });
    if (signal?.aborted) break;
  }
  onProgress?.({ job: rest.length, jobs: rest.length, frame: 0, frames: 0, phase: "done" });
  const saved = files.length > 0 && !signal?.aborted ? await saveFiles(ed, files) : false;
  return { saved, errors };
}
