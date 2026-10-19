/**
 * Social's export (docs/social.md §8, round 18d): the renderer side of the export presets (src/shared/social/presets.ts
 * holds them as data). Each post gets a preset — "auto" picks its format's still or animated one (§8: an animated post,
 * a timeline with something on it, takes the animated preset) — and a plan: the file's name ("‹Campaign› / ‹post
 * name› — ‹format›.‹ext›"), the size, frame rate, codec and bitrate it renders with, and what its format's limits say
 * about it before anything is drawn (length, frame rate, bitrate, container and codec, a document's pages). Rendering
 * goes through the editor's two exports — the static one (exporting.ts: PNG, JPEG, PDF; a LinkedIn document is Export
 * frames to PDF's renderer over its slides in `index` order) and Motion's Animated export (motion/export/: MP4 through
 * WebCodecs) — and the file's size is checked afterwards: a JPEG over its limit is written again a step lower in quality
 * until it fits (the YouTube thumbnail's rule, §8, for every JPEG with a limit [ours]); a PNG over it becomes a JPEG 0.92
 * when the format takes JPEG (LinkedIn's rule, §8, for every such format [ours]); what still doesn't fit is a warning on
 * the file. Several files make one zip (`zipStored`, the editor's own writer). A post whose file was made is marked
 * exported (`markExported`, one undo step). The chrome (ExportPostsDialog) and the agents' `export_posts` call these.
 */
import type { Guid } from "@/engine/codec";
import { t, tp } from "@/i18n";
import { presetById, SOCIAL_EXPORT_PRESETS } from "@shared/social/presets";
import { resolveFormat } from "@shared/social/formats";
import type { AnimatedExportSettings } from "@shared/motion/types";
import type { ExportSettings } from "@shared/schema/document.generated";
import type { PlatformFormat, SocialExportPreset, SocialPostData } from "@shared/social/types";
import type { SocialFormat } from "@shared/studio/types";
import type { EditorController } from "../../controller";
import { exportAllowed, renderExport, saveFiles, type ExportedFile } from "../../exporting";
import { zipStored } from "../../model/exports";
import { renderAnimated, scaleOf, takeAnimatedExport, timelineOf, type AnimatedExportJob } from "../../motion/export/exportAnimated";
import { planFrames } from "../../motion/export/frames";
import { bitrateOf, MAX_VIDEO_SIDE } from "../../motion/export/video";
import { canWritePosts, editorWriter, type Writer } from "../actions";
import { readCampaigns, readPost, writePost } from "../posts";
import { isAnimated, readBoard } from "../socialState";

/** "auto": each post's own preset (§8). */
export const AUTO_PRESET = "auto";
/** The JPEG qualities tried in turn while a file is over its limit (§8's YouTube thumbnail) [steps ours]. */
export const JPEG_STEPS: readonly number[] = [0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4, 0.3];
/** The codec each video container is written with (motion/export/video.ts tries these first). */
const VIDEO_CODEC: Record<"MP4" | "WEBM", { codec: "h264" | "vp9"; container: "mp4" | "webm"; label: string }> = {
  MP4: { codec: "h264", container: "mp4", label: "H.264" },
  WEBM: { codec: "vp9", container: "webm", label: "VP9" },
};
const MB = 1024 * 1024;

const isPlatformFormat = (f: SocialFormat | null): f is PlatformFormat => !!f && "platform" in f;
const kindOf = (p: SocialExportPreset): "still" | "animated" => (p.animated ? "animated" : "still");

/** The catalogue id a post's format is checked by (a brand's own size has none: the generic presets). */
const catalogueId = (formatId: string): string => (formatId.startsWith("brand:") ? "" : formatId);

/** §8's "auto": the format's animated preset for an animated post, else its still one; the generic ones otherwise. */
export function autoPreset(formatId: string, animated: boolean): SocialExportPreset {
  const kind = animated ? "animated" : "still";
  const id = catalogueId(formatId);
  return SOCIAL_EXPORT_PRESETS.find((p) => p.formatIds.includes(id) && kindOf(p) === kind) ?? presetById(animated ? "generic-video" : "generic-image")!;
}

/**
 * The presets a post may take (the dialog's menu): its format's own, then the generic ones; an animated post's video
 * presets first, a still post's only still ones (there is nothing to play).
 */
export function presetsFor(formatId: string, animated: boolean): SocialExportPreset[] {
  const id = catalogueId(formatId);
  const fits = (p: SocialExportPreset) => animated || kindOf(p) === "still";
  const own = SOCIAL_EXPORT_PRESETS.filter((p) => p.formatIds.includes(id) && fits(p));
  const generic = SOCIAL_EXPORT_PRESETS.filter((p) => !p.formatIds.length && fits(p));
  const order = (p: SocialExportPreset) => (kindOf(p) === (animated ? "animated" : "still") ? 0 : 1);
  return [...own, ...generic].sort((a, b) => order(a) - order(b));
}

const clean = (s: string) => s.replace(/[/\\]+/g, "-").trim();

/** "Spring sale / Hero — Instagram post.jpg": the campaign as a folder (none: no folder), "/" in the names kept out. */
export function postFileName(campaign: string | null, post: string, format: string, ext: string): string {
  const base = `${clean(post) || t("Untitled")} — ${clean(format)}.${ext}`;
  return campaign && clean(campaign) ? `${clean(campaign)}/${base}` : base;
}

/**
 * A carousel's slide (§5.2: "slides may be videos"): "Spring sale / Hero — Instagram carousel / 02 — Field.mp4" — a
 * folder named as its cover's file, the slides numbered in `index` order so the files sort as the carousel goes.
 */
export function carouselFileName(coverFile: string, n: number, slide: string, ext: string): string {
  return `${coverFile.replace(/\.[^./]+$/, "")}/${String(n).padStart(2, "0")} — ${clean(slide) || t("Untitled")}.${ext}`;
}

/** "3 s", "15 min", "1 min 30 s". */
export function secondsLabel(sec: number): string {
  const s = Math.round(sec * 10) / 10;
  if (s < 60) return t("{n} s", { n: String(s) });
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? t("{m} min {s} s", { m: String(m), s: String(rest) }) : t("{n} min", { n: String(m) });
}

/** The format's video limits as the timeline's Social header shows them: "Instagram reel · 3 s – 15 min · 30 fps". */
export function videoLimitsLabel(format: SocialFormat, fps?: number): string {
  const v = isPlatformFormat(format) ? format.video : undefined;
  const parts = [t(format.name)];
  if (v) parts.push(v.minSec > 0 ? `${secondsLabel(v.minSec)} – ${secondsLabel(v.maxSec)}` : t("up to {max}", { max: secondsLabel(v.maxSec) }));
  if (fps) parts.push(`${fps} fps`);
  return parts.join(" · ");
}

/** Whether a length is outside the format's video limits (no limits: never). */
export function lengthOutside(format: SocialFormat | null, durationSec: number): boolean {
  const v = isPlatformFormat(format) ? format.video : undefined;
  return !!v && (durationSec < v.minSec - 1e-6 || durationSec > v.maxSec + 1e-6);
}

/**
 * The timeline's Social header for a post (§8): its format's name and video limits with the frame rate its video
 * preset exports at, and the length Duration keeps within; null when `root` isn't a post.
 */
export function timelineHeader(ed: EditorController, root: Guid): { text: string; minUs?: number; maxUs?: number } | null {
  const data = readPost(ed, root);
  const format = data ? resolveFormat(data.formatId) : null;
  if (!data || !format) return null;
  const v = isPlatformFormat(format) ? format.video : undefined;
  const text = videoLimitsLabel(format, autoPreset(data.formatId, true).animated?.fps);
  return v ? { text, minUs: v.minSec * 1e6, maxUs: v.maxSec * 1e6 } : { text };
}

/** A post's export as planned:what it renders with, the file it makes and what its format's limits say. */
export interface PostExportPlan {
  post: Guid;
  /** The frames drawn: the post, or a document's slides in `index` order (one PDF) */
  slides: Guid[];
  name: string;
  formatId: string;
  format: SocialFormat | null;
  preset: SocialExportPreset;
  /** Whether "auto" picked the preset */
  auto: boolean;
  file: string;
  /** The static export's settings (PNG / JPEG / PDF) */
  still?: ExportSettings;
  /** Motion's Animated export settings (MP4) */
  animated?: AnimatedExportSettings;
  width: number;
  height: number;
  fps?: number;
  codec?: string;
  /** bits per second (a video's) */
  bitrate?: number;
  durationSec?: number;
  /** The most bytes the file may have (the preset's or the format's limit, the lower), null: no limit */
  maxBytes: number | null;
  /** Found before rendering: outside the format's limits (the file is still made) */
  warnings: string[];
}

/** The limit in MB a file is checked against: the preset's and the format's, the lower. */
function limitMB(preset: SocialExportPreset, format: SocialFormat | null): number | null {
  const own = isPlatformFormat(format) ? (preset.animated ? format.video?.maxMB : format.image?.maxMB) : undefined;
  const list = [preset.maxMB, own].filter((x): x is number => typeof x === "number" && x > 0);
  return list.length ? Math.min(...list) : null;
}

/** A document's slides: the posts of its group on the page, in `index` order (the post alone when it has none). */
function groupSlides(ed: EditorController, id: Guid, data: SocialPostData): Guid[] {
  if (!data.group) return [id];
  const posts = readBoard(ed, ed.store.page).posts.filter((p) => p.data.group?.id === data.group!.id);
  return posts.length ? posts.sort((a, b) => a.data.group!.index - b.data.group!.index).map((p) => p.id) : [id];
}

/**
 * The Export dialog's fields over a post's preset (round 18 leftovers): a JPEG's quality, a video's quality and frame
 * rate. A PNG and a PDF have none; the size stays the preset's (the format's).
 */
export interface PlanOverrides {
  /** 0–1; the steps down from it when the file is over its limit */
  jpegQuality?: number;
  videoQuality?: AnimatedExportSettings["quality"];
  fps?: AnimatedExportSettings["fps"];
}

/** The settings a preset gives a post, the file's name and the checks before rendering; null: not a post. */
export function planPostExport(ed: EditorController, id: Guid, presetId: string = AUTO_PRESET, over: PlanOverrides = {}): PostExportPlan | null {
  const data = readPost(ed, id);
  if (!data) return null;
  const node = ed.engine.readNode(id, { fields: ["name", "size"] }) as { name?: string; size?: { x: number; y: number } } | null;
  const name = node?.name ?? "";
  const w = node?.size?.x ?? 0;
  const h = node?.size?.y ?? 0;
  const format = resolveFormat(data.formatId);
  const animated = isAnimated(ed, id);
  const auto = presetId === AUTO_PRESET || !presetById(presetId);
  const preset = auto ? autoPreset(data.formatId, animated) : presetById(presetId)!;
  const campaign = data.campaignId ? (readCampaigns(ed, ed.store.page).find((c) => c.id === data.campaignId)?.name ?? null) : null;
  const formatName = format ? t(format.name) : data.formatId;
  const maxMB = limitMB(preset, format);
  const plan: Omit<PostExportPlan, "file"> = { post: id, slides: [id], name, formatId: data.formatId, format, preset, auto, width: w, height: h, maxBytes: maxMB ? maxMB * MB : null, warnings: [] };
  const v = isPlatformFormat(format) ? format.video : undefined;
  if (preset.still) {
    const s = preset.still;
    const ext = s.format === "JPEG" ? "jpg" : s.format.toLowerCase();
    plan.still = { imageType: s.format, constraint: { type: "CONTENT_SCALE", value: s.scale }, colorProfile: "SRGB", ...(s.format === "JPEG" ? { quality: over.jpegQuality ?? s.quality ?? JPEG_STEPS[0] } : {}), ...(s.format === "PDF" ? { contentsOnly: true } : {}) };
    plan.width = Math.round(w * s.scale);
    plan.height = Math.round(h * s.scale);
    if (s.format === "PDF") {
      plan.slides = groupSlides(ed, id, data);
      const items = isPlatformFormat(format) ? format.items : undefined;
      if (items && (plan.slides.length < items.min || plan.slides.length > items.max)) plan.warnings.push(t("{n} pages: {format} takes {min}–{max}", { n: String(plan.slides.length), format: formatName, min: String(items.min), max: String(items.max) }));
    }
    return { ...plan, file: postFileName(campaign, name, formatName, ext) };
  }
  const a: AnimatedExportSettings = { ...preset.animated!, ...(over.videoQuality ? { quality: over.videoQuality } : {}), ...(over.fps ? { fps: over.fps } : {}) };
  const codec = VIDEO_CODEC[a.format === "WEBM" ? "WEBM" : "MP4"];
  const scale = scaleOf(a.size, w, h);
  // Even sides, as the encoder pads them (motion/export/frames.ts padToEven).
  plan.width = Math.ceil(Math.round(w * scale) / 2) * 2;
  plan.height = Math.ceil(Math.round(h * scale) / 2) * 2;
  plan.animated = a;
  plan.fps = a.fps;
  plan.codec = codec.label;
  plan.bitrate = bitrateOf(plan.width, plan.height, a.fps, a.quality);
  const tl = timelineOf(ed, id);
  const frames = tl ? planFrames(tl.durationUs, tl.playback, a.fps) : null;
  if (frames) plan.durationSec = frames.rangeUs / 1e6;
  if (!animated) plan.warnings.push(t("Nothing on its timeline moves: the video shows one still picture"));
  if (Math.max(plan.width, plan.height) > MAX_VIDEO_SIDE) plan.warnings.push(t("{w} × {h} is larger than video export's {max} px", { w: String(plan.width), h: String(plan.height), max: String(MAX_VIDEO_SIDE) }));
  if (v) {
    if (plan.durationSec !== undefined && lengthOutside(format, plan.durationSec))
      plan.warnings.push(t("{length} is outside {format}'s {min} – {max}", { length: secondsLabel(plan.durationSec), format: formatName, min: secondsLabel(v.minSec), max: secondsLabel(v.maxSec) }));
    if (a.fps < v.fps[0] || a.fps > v.fps[1]) plan.warnings.push(t("{fps} fps is outside {format}'s {min}–{max} fps", { fps: String(a.fps), format: formatName, min: String(v.fps[0]), max: String(v.fps[1]) }));
    if (v.maxMbps && plan.bitrate > v.maxMbps * 1e6) plan.warnings.push(t("{rate} Mbps is over {format}'s {max} Mbps", { rate: (plan.bitrate / 1e6).toFixed(1), format: formatName, max: String(v.maxMbps) }));
    if (!v.containers.includes(codec.container) || !v.codecs.includes(codec.codec)) plan.warnings.push(t("{format} doesn't take {codec} in {container}", { format: formatName, codec: codec.label, container: codec.container.toUpperCase() }));
  }
  return { ...plan, file: postFileName(campaign, name, formatName, a.format === "WEBM" ? "webm" : "mp4") };
}

/**
 * A carousel's slides (§5.2), one plan each in `index` order — a still slide its picture, an animated one its video
 * within the format's video limits (Instagram's: a Reel's) — their files in one folder named as the cover's, numbered;
 * the slides' count checked against the format's `items` on the cover. Null when `id` isn't a grouped carousel slide.
 */
function planCarousel(ed: EditorController, id: Guid, presetOf: (id: Guid) => string, overOf: (id: Guid) => PlanOverrides): PostExportPlan[] | null {
  const data = readPost(ed, id);
  const format = data ? resolveFormat(data.formatId) : null;
  if (!data?.group || !isPlatformFormat(format) || format.kind !== "carousel") return null;
  const plans = groupSlides(ed, id, data).flatMap((s) => planPostExport(ed, s, presetOf(s), overOf(s)) ?? []);
  const cover = plans[0]?.file ?? "";
  plans.forEach((p, i) => (p.file = carouselFileName(cover, i + 1, p.name, p.file.slice(p.file.lastIndexOf(".") + 1))));
  const items = format.items;
  if (plans[0] && items && (plans.length < items.min || plans.length > items.max)) plans[0].warnings.push(tp(plans.length, "{n} slide: {format} takes {min}–{max}", "{n} slides: {format} takes {min}–{max}", { format: t(format.name), min: String(items.min), max: String(items.max) }));
  return plans;
}

/**
 * The plans of `ids` (a preset per post: one for all, or by post id; missing: "auto"; the dialog's fields by post id):
 * posts only, in the order given; a document's slides make one plan (its first slide's), the others folded into it; a
 * carousel's slides come together, in `index` order, in one folder.
 */
export function planExports(ed: EditorController, ids: readonly Guid[], preset: string | Readonly<Record<Guid, string>> = AUTO_PRESET, overrides: Readonly<Record<Guid, PlanOverrides>> = {}): PostExportPlan[] {
  const out: PostExportPlan[] = [];
  const folded = new Set<Guid>();
  const presetOf = (id: Guid) => (typeof preset === "string" ? preset : (preset[id] ?? AUTO_PRESET));
  const overOf = (id: Guid) => overrides[id] ?? {};
  for (const id of ids) {
    if (folded.has(id)) continue;
    const carousel = planCarousel(ed, id, presetOf, overOf);
    if (carousel) {
      carousel.forEach((p) => folded.add(p.post));
      out.push(...carousel);
      continue;
    }
    const plan = planPostExport(ed, id, presetOf(id), overOf(id));
    if (!plan) continue;
    if (plan.slides.length > 1) {
      const first = plan.slides[0];
      plan.slides.forEach((s) => folded.add(s));
      if (first !== id) {
        const again = planPostExport(ed, first, plan.auto ? AUTO_PRESET : plan.preset.id, overOf(first));
        if (again) {
          out.push(again);
          continue;
        }
      }
    }
    out.push(plan);
  }
  return out;
}

// ---- Rendering ------------------------------------------------------------------------------------------------------

/** The two exports a plan renders through (tests pass their own: the static one encodes with OffscreenCanvas). */
export interface ExportRenderers {
  still(ed: EditorController, refs: readonly Guid[], settings: ExportSettings): Promise<{ bytes: Uint8Array } | { error: string }>;
  animated(ed: EditorController, job: AnimatedExportJob, onProgress?: (p: { frame: number; frames: number }) => void, signal?: AbortSignal): Promise<{ bytes: Uint8Array } | { error: string }>;
}

export const EDITOR_RENDERERS: ExportRenderers = { still: renderExport, animated: renderAnimated };

/** A rendered post: its file, and what was found once it was made. */
export interface PostExportResult {
  post: Guid;
  name: string;
  preset: string;
  file: string | null;
  bytes: number;
  warnings: string[];
  error?: string;
}

const mbLabel = (bytes: number) => (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0);

/**
 * A still under its limit (§8): a JPEG written again a step lower in quality while it is over; a PNG over it becomes a
 * JPEG (0.92, then the steps) when the format takes JPEG. Returns the bytes, the settings they were written with, and
 * whether it still doesn't fit.
 */
export async function fitStill(render: (s: ExportSettings) => Promise<{ bytes: Uint8Array } | { error: string }>, settings: ExportSettings, maxBytes: number | null, jpegAllowed: boolean): Promise<{ bytes: Uint8Array; settings: ExportSettings; over: boolean } | { error: string }> {
  const first = await render(settings);
  if ("error" in first || maxBytes === null || first.bytes.length <= maxBytes) return "error" in first ? first : { bytes: first.bytes, settings, over: false };
  if (settings.imageType !== "JPEG" && !(settings.imageType === "PNG" && jpegAllowed)) return { bytes: first.bytes, settings, over: true };
  // A JPEG goes on from the step under its quality; a PNG starts at the first.
  const start = settings.imageType === "JPEG" ? JPEG_STEPS.findIndex((q) => q < (settings.quality ?? JPEG_STEPS[0]) - 1e-6) : 0;
  if (start < 0) return { bytes: first.bytes, settings, over: true };
  let last: { bytes: Uint8Array; settings: ExportSettings } = { bytes: first.bytes, settings };
  for (let i = start; i < JPEG_STEPS.length; i++) {
    const s: ExportSettings = { ...settings, imageType: "JPEG", quality: JPEG_STEPS[i] };
    const r = await render(s);
    if ("error" in r) return r;
    last = { bytes: r.bytes, settings: s };
    if (r.bytes.length <= maxBytes) return { ...last, over: false };
  }
  return { ...last, over: true };
}

/** One plan rendered: the file (renamed .jpg when a PNG became a JPEG), and its size checked. */
export async function renderPlan(ed: EditorController, plan: PostExportPlan, renderers: ExportRenderers = EDITOR_RENDERERS, onProgress?: (p: { frame: number; frames: number }) => void, signal?: AbortSignal): Promise<{ file: ExportedFile; warnings: string[] } | { error: string }> {
  const warnings = [...plan.warnings];
  const over = (bytes: number) => plan.maxBytes !== null && bytes > plan.maxBytes;
  const overText = (bytes: number) => t("{size} MB is over the {max} MB limit", { size: mbLabel(bytes), max: mbLabel(plan.maxBytes ?? 0) });
  if (plan.still) {
    const types = isPlatformFormat(plan.format) ? plan.format.image?.types : undefined;
    const r = await fitStill((s) => renderers.still(ed, plan.slides, s), plan.still, plan.maxBytes, !!types?.includes("jpeg"));
    if ("error" in r) return r;
    if (r.over) warnings.push(overText(r.bytes.length));
    else if (r.settings.imageType !== plan.still.imageType) warnings.push(t("Saved as JPEG: the PNG was over {max} MB", { max: mbLabel(plan.maxBytes ?? 0) }));
    else if (r.settings.quality !== plan.still.quality) warnings.push(t("JPEG quality lowered to {q} to fit {max} MB", { q: String(r.settings.quality), max: mbLabel(plan.maxBytes ?? 0) }));
    const file = r.settings.imageType === plan.still.imageType ? plan.file : plan.file.replace(/\.[^.]+$/, ".jpg");
    return { file: { name: file, bytes: r.bytes }, warnings };
  }
  const r = await renderers.animated(ed, { root: plan.post, name: plan.name, settings: plan.animated! }, onProgress, signal);
  if ("error" in r) return r;
  if (over(r.bytes.length)) warnings.push(overText(r.bytes.length));
  return { file: { name: plan.file, bytes: r.bytes }, warnings };
}

export interface PostsProgress {
  /** The post being rendered (0-based) */
  index: number;
  total: number;
  name: string;
  frame: number;
  frames: number;
}

export interface ExportPostsOptions {
  /** A preset for every post, or by post id; missing: "auto" */
  preset?: string | Readonly<Record<Guid, string>>;
  /** The dialog's fields over the presets, by post id */
  overrides?: Readonly<Record<Guid, PlanOverrides>>;
  /** One zip of every file (default: when more than one) */
  zip?: boolean;
  /** The zip's name without ".zip" (default: the campaign's when every post is in one, else the design file's) */
  zipName?: string;
  renderers?: ExportRenderers;
  onProgress?(p: PostsProgress): void;
  signal?: AbortSignal;
}

export interface ExportPostsResult {
  /** What is saved: the posts' files, or the one zip */
  files: ExportedFile[];
  posts: PostExportResult[];
  /** The posts whose file was made (a document's slides too): marked exported once the files are kept */
  exported: Guid[];
}

/** The zip's name: the campaign's when every post shares one, else the design file's. */
function zipNameOf(ed: EditorController, plans: readonly PostExportPlan[]): string {
  const folders = new Set(plans.map((p) => (p.file.includes("/") ? p.file.split("/")[0] : "")));
  const one = folders.size === 1 ? [...folders][0] : "";
  return one || ed.ui.get().fileName || t("Posts");
}

/**
 * Renders `ids` with their presets into files (one zip when several); nothing is saved or written to the document.
 * Videos take the file's one animated export (Motion's lock, docs/motion.md §7.7) for the whole run: while the
 * Animated tab (or another Export) holds it, every post answers so and nothing renders.
 */
export async function exportPosts(ed: EditorController, ids: readonly Guid[], opts: ExportPostsOptions = {}): Promise<ExportPostsResult> {
  const plans = planExports(ed, ids, opts.preset, opts.overrides);
  const release = plans.some((p) => p.animated) ? takeAnimatedExport(ed) : () => {};
  if (!release) {
    const error = t("An animation is already being exported");
    return { files: [], posts: plans.map((p) => ({ post: p.post, name: p.name, preset: p.preset.id, file: null, bytes: 0, warnings: p.warnings, error })), exported: [] };
  }
  try {
    return await renderPlans(ed, plans, opts);
  } finally {
    release();
  }
}

async function renderPlans(ed: EditorController, plans: readonly PostExportPlan[], opts: ExportPostsOptions): Promise<ExportPostsResult> {
  const renderers = opts.renderers ?? EDITOR_RENDERERS;
  const made: ExportedFile[] = [];
  const posts: PostExportResult[] = [];
  const exported: Guid[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (opts.signal?.aborted) break;
    opts.onProgress?.({ index: i, total: plans.length, name: plan.name, frame: 0, frames: 0 });
    const r = await renderPlan(ed, plan, renderers, (p) => opts.onProgress?.({ index: i, total: plans.length, name: plan.name, ...p }), opts.signal);
    if ("error" in r) {
      posts.push({ post: plan.post, name: plan.name, preset: plan.preset.id, file: null, bytes: 0, warnings: plan.warnings, error: r.error });
      continue;
    }
    made.push(r.file);
    exported.push(...plan.slides);
    posts.push({ post: plan.post, name: plan.name, preset: plan.preset.id, file: r.file.name, bytes: r.file.bytes.length, warnings: r.warnings });
  }
  const zip = opts.zip ?? made.length > 1;
  const files = zip && made.length ? [{ name: `${(opts.zipName ?? zipNameOf(ed, plans)).replace(/[/\\]+/g, "-")}.zip`, bytes: zipStored(made) }] : made;
  // A single file leaves without its campaign folder.
  if (!zip && files.length === 1) files[0] = { ...files[0], name: files[0].name.split("/").pop()! };
  return { files, posts, exported };
}

/** The posts' status → exported and `exportedAt` now (one undo step through `w`); viewers' files leave nothing. */
export function markExported(ed: EditorController, w: Writer, ids: readonly Guid[]): void {
  const now = Date.now();
  const posts = ids.flatMap((id) => {
    const data = readPost(ed, id);
    return data ? [[id, data] as const] : [];
  });
  if (!posts.length) return;
  w("Export posts", () => {
    for (const [id, data] of posts) writePost(ed, id, { ...data, status: "exported", exportedAt: now });
  });
}

/**
 * The chrome's Export (the dialog): renders, saves the files (exporting.ts `saveFiles`: the desktop's Save dialog, a
 * download in a browser) and, once saved, marks the posts exported as one undo step (viewers' files leave nothing).
 */
export async function exportAndSavePosts(ed: EditorController, ids: readonly Guid[], opts: ExportPostsOptions = {}): Promise<{ saved: boolean; result: ExportPostsResult }> {
  if (!exportAllowed(ed)) return { saved: false, result: { files: [], posts: [], exported: [] } };
  const result = await exportPosts(ed, ids, opts);
  const saved = result.files.length > 0 && !opts.signal?.aborted ? await saveFiles(ed, result.files) : false;
  if (saved && canWritePosts(ed)) markExported(ed, editorWriter(ed), result.exported);
  return { saved, result };
}
