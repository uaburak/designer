/**
 * The agents' motion tools (src/shared/agents/tools.ts: get_motion, set_keyframes, remove_keyframes, set_timeline,
 * add_animation, edit_animation, remove_animations, apply_animation_style, detach_animation_style, add_audio,
 * edit_audio, export_animation; docs/motion.md §9, round 8f). Thin: the keyframes and presets go through the Plugin
 * API's shapes (motion/publicApi.ts — Figma's `manualKeyframeTracks`, `animationStyles`), the rest through the motion
 * commands the chrome runs (MOTION_SET_TIMELINE, MOTION_APPLY_STYLE, the audio commands) and the Animated export
 * (motion/export/exportAnimated.ts). Seconds at the tools, as the Plugin API; one transaction per call.
 */
import type { Guid } from "@/engine/codec";
import { textResult, type ToolResult } from "@shared/agents/tools";
import { base64Bytes } from "@shared/agents/images";
import { ANIMATED_FORMATS, ANIMATION_STYLES, FRAME_RATES, type AnimatedExportSettings, type AnimatedFormat, type PlaybackName, type ResolvedMotion, type TimelineModel } from "@shared/motion/types";
import type { ToolEnv } from "./mcpTools";
import { explicitNodeIds, ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";
import { applyStyle, detachStyle, presetAllowed, presetDef, type PresetTarget } from "../motion/presets";
import { audioLibrary, MAX_AUDIO_BYTES } from "../motion/audio/audio";
import { animatedFileName, renderAnimated } from "../motion/export/exportAnimated";
import { base64 } from "../motion/export/vectorAnim";
import {
  animationStylesOf,
  applyAnimationStyle,
  applyManualKeyframeTrack,
  deleteKeyframes,
  editAnimationStyle,
  fieldFrom,
  manualKeyframeTracks,
  removeAnimationStyle,
  removeManualKeyframeTrack,
  setTimeline,
  timelineOf,
  timelineRootOf,
} from "../motion/publicApi";

const US = 1e6;
const sec = (us: number) => Math.round(us) / US;

function ids(env: ToolEnv, args: Spec, tool: string): Guid[] {
  const list = explicitNodeIds(args, tool).map(normId).filter(Boolean);
  const missing = list.filter((id) => !env.ed.engine.readNode(id, { fields: ["name"] }));
  if (missing.length) throw new ToolError(`No layer ${missing.join(", ")} in this file. Use get_metadata to find ids.`);
  if (!list.length) throw new ToolError(`${tool}: no nodes given — the ids aren't layer ids ("123:456").`);
  return list;
}

/** One layer's id for a call that names a timeline (any layer in it, or its top-level frame). */
function rootOf(env: ToolEnv, args: Spec, tool: string): { id: Guid; model: TimelineModel } {
  const id = normId(args.nodeId ?? (Array.isArray(args.nodeIds) ? args.nodeIds[0] : undefined));
  if (!id) throw new ToolError(`${tool}: nodeId — the top-level frame (or any layer in it) whose timeline this is.`);
  if (!env.ed.engine.readNode(id, { fields: ["name"] })) throw new ToolError(`No layer ${id} in this file. Use get_metadata to find ids.`);
  const model = timelineOf(env.ed, id);
  if (!model) throw new ToolError(`${tool}: ${id} isn't in a top-level frame (a page's direct child holds the timeline).`);
  return { id, model };
}

const num = (v: unknown, at: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${at}: a number`);
  return v;
};

// ---- Reads ------------------------------------------------------------------------------------------------------

/** A resolved model in seconds (the shape Dev Mode's JSON code shows in µs). */
const resolvedInSeconds = (r: ResolvedMotion) => ({
  root: r.root,
  duration: sec(r.durationUs),
  playback: r.playback,
  layers: r.layers.map((l) => ({ ...l, properties: l.properties.map((p) => ({ ...p, keyframes: p.keyframes.map((k) => ({ time: sec(k.timeUs), value: k.value, easing: k.easing })) })) })),
});

/** get_motion: the timeline of a layer's top-level frame — its layers' keyframe tracks, animations, styles and audio. */
export function getMotionTool(env: ToolEnv, args: Spec): ToolResult {
  const id = normId(args.nodeId) || env.ed.selection[0];
  if (!id) throw new ToolError("Nothing is selected: pass a nodeId (the top-level frame, or any layer in it).");
  const { model } = rootOf(env, { nodeId: id }, "get_motion");
  const out: Record<string, unknown> = {
    timeline: { id: model.timelineId, frame: model.rootName, duration: sec(model.durationUs), playback: model.playback, fps: Math.round(model.snappingFps * 1000) / 1000 },
    layers: model.layers.map((l) => {
      const styles = new Map<string, { id: string; style: string; animations: string[] }>();
      for (const c of l.clips) if (c.style) (styles.get(c.style.id) ?? styles.set(c.style.id, { id: c.style.id, style: c.style.key, animations: [] }).get(c.style.id)!).animations.push(c.id);
      return {
        id: l.node,
        name: l.name,
        ...(l.instance ? { instance: { offset: sec(l.instance.offsetUs), duration: sec(l.instance.durationUs) } } : {}),
        manualKeyframeTracks: manualKeyframeTracks(env.ed, l.node),
        animations: animationStylesOf(env.ed, l.node),
        ...(styles.size ? { animationStyles: [...styles.values()] } : {}),
      };
    }),
    audio: model.audio.map((a) => ({ id: a.id, name: a.name, row: a.trackId, offset: sec(a.offsetUs), trimStart: sec(a.startUs), duration: sec(a.durationUs), volume: a.volume, mute: a.mute })),
    units: "seconds; opacity 0–1, rotation degrees (counter-clockwise +), scale multipliers, colours 0–1",
  };
  if (args.resolved === true) {
    let r: ResolvedMotion | null = null;
    try {
      r = env.ed.engine.motionResolved(model.root);
    } catch {
      r = null;
    }
    if (r) out.resolved = resolvedInSeconds(r);
  }
  return textResult(out);
}

// ---- Keyframes and the timeline ---------------------------------------------------------------------------------

/** set_keyframes: one field's track on each layer — replaced (Figma's applyManualKeyframeTrack) or merged into. */
export function setKeyframesTool(env: ToolEnv, args: Spec): ToolResult {
  const nodes = ids(env, args, "set_keyframes");
  const field = fieldFrom(args.field);
  const merge = args.merge === true;
  const tracks: Record<string, unknown> = {};
  env.write("Add keyframe", () => {
    for (const id of nodes) tracks[id] = applyManualKeyframeTrack(env.ed, id, field, { keyframes: args.keyframes }, { merge });
    // The timeline grows to hold the last keyframe (Figma's guide: extend, never shorten).
    if (args.extendTimeline !== false) extendTo(env, nodes[0], Math.max(0, ...((args.keyframes as { timelinePosition?: number }[]) ?? []).map((k) => Number(k?.timelinePosition) || 0)));
  }, nodes);
  const r = textResult({ field, tracks, timeline: timelineSummary(env, nodes[0]) });
  r.touched = nodes;
  return r;
}

/** remove_keyframes: keyframes by id, or whole tracks (fields) of the layers. */
export function removeKeyframesTool(env: ToolEnv, args: Spec): ToolResult {
  const keyframeIds = Array.isArray(args.keyframeIds) ? args.keyframeIds.map(normId).filter(Boolean) : [];
  const fields = Array.isArray(args.fields) ? args.fields : args.field !== undefined ? [args.field] : [];
  if (!keyframeIds.length && !fields.length) throw new ToolError("remove_keyframes: give keyframeIds (get_motion lists them), or nodeIds with fields (whole tracks).");
  const nodes = fields.length ? ids(env, args, "remove_keyframes") : [];
  const removed: string[] = [];
  env.write("Delete keyframes", () => {
    deleteKeyframes(env.ed, keyframeIds);
    for (const id of nodes) for (const f of fields) if (removeManualKeyframeTrack(env.ed, id, f)) removed.push(`${id} ${typeof f === "string" ? f : JSON.stringify(f)}`);
  }, nodes);
  const r = textResult({ removedKeyframes: keyframeIds.length, removedTracks: removed });
  r.touched = nodes;
  return r;
}

const timelineSummary = (env: ToolEnv, id: Guid) => {
  const m = timelineOf(env.ed, id);
  return m ? { id: m.timelineId, duration: sec(m.durationUs), playback: m.playback, fps: Math.round(m.snappingFps * 1000) / 1000 } : null;
};

/** The timeline lengthened to `seconds` when it is shorter (inside the caller's write). */
function extendTo(env: ToolEnv, id: Guid, seconds: number): void {
  const m = timelineOf(env.ed, id);
  if (m && seconds > sec(m.durationUs) + 1e-6) setTimeline(env.ed, id, null, { duration: Math.min(600, seconds) });
}

/** set_timeline: a top-level frame's duration, playback and snapping rate. */
export function setTimelineTool(env: ToolEnv, args: Spec): ToolResult {
  const { id } = rootOf(env, args, "set_timeline");
  const playback = args.playback === undefined ? undefined : (String(args.playback).toUpperCase().replace("-", "_") as PlaybackName);
  const patch = { duration: num(args.duration, "duration"), playback, fps: num(args.fps, "fps") };
  if (patch.duration === undefined && !playback && patch.fps === undefined) throw new ToolError("set_timeline: give duration (seconds), playback (LOOP, ONCE, PING_PONG) and/or fps.");
  if (playback === "PING_PONG" && (timelineOf(env.ed, id)?.audio.length ?? 0) > 0) throw new ToolError("set_timeline: Ping-pong isn't available while the timeline has audio.");
  let t: unknown = null;
  env.write("Change duration", () => {
    t = setTimeline(env.ed, id, null, patch);
  });
  return textResult({ timeline: { ...(t as object), ...timelineSummary(env, id) } });
}

// ---- Animations (presets) and animation styles ------------------------------------------------------------------

/** add_animation: a preset (Figma's style id or our key) on each layer; returns the clips made. */
export function addAnimationTool(env: ToolEnv, args: Spec): ToolResult {
  const nodes = ids(env, args, "add_animation");
  const made: Record<string, string> = {};
  const config = { duration: num(args.duration, "duration"), timelineOffset: num(args.timelineOffset, "timelineOffset"), props: (args.props ?? {}) as Record<string, unknown>, ...(args.visible === false ? { visible: false } : {}) };
  env.write("Add animation", () => {
    for (const id of nodes) made[id] = applyAnimationStyle(env.ed, id, args.style ?? args.styleId ?? args.preset, config);
    const end = Math.max(0, ...nodes.flatMap((id) => animationStylesOf(env.ed, id).map((s) => s.timelineOffset + s.duration)));
    if (args.extendTimeline !== false) extendTo(env, nodes[0], end);
  }, nodes);
  const r = textResult({ animations: Object.fromEntries(nodes.map((id) => [id, animationStylesOf(env.ed, id).find((s) => s.id === made[id])])), timeline: timelineSummary(env, nodes[0]) });
  r.touched = nodes;
  return r;
}

/** The layer holding a clip (the clip's id is enough for the agent). */
function layerOfClip(env: ToolEnv, nodeId: unknown, clip: string): Guid {
  const id = normId(nodeId);
  if (id) return id;
  const sel = env.ed.selection[0];
  const model = sel ? timelineOf(env.ed, sel) : null;
  const hit = model?.layers.find((l) => l.clips.some((c) => c.id === clip));
  if (hit) return hit.node;
  throw new ToolError(`Pass nodeId: the layer animation ${clip} is on (get_motion lists each layer's animations).`);
}

/** edit_animation: one clip's props, timing, type or eye. */
export function editAnimationTool(env: ToolEnv, args: Spec): ToolResult {
  const clip = normId(args.animationId ?? args.id);
  if (!clip) throw new ToolError("edit_animation: animationId (get_motion lists each layer's animations).");
  const id = layerOfClip(env, args.nodeId, clip);
  let after: unknown = null;
  env.write("Edit animation", () => {
    after = editAnimationStyle(env.ed, id, clip, {
      ...(args.style !== undefined || args.styleId !== undefined ? { styleId: String(args.style ?? args.styleId) } : {}),
      duration: num(args.duration, "duration"),
      timelineOffset: num(args.timelineOffset, "timelineOffset"),
      ...(args.props ? { props: args.props as Record<string, unknown> } : {}),
      ...(typeof args.visible === "boolean" ? { visible: args.visible } : {}),
    });
  }, [id]);
  const r = textResult({ animation: after });
  r.touched = [id];
  return r;
}

/** remove_animations: clips by id. */
export function removeAnimationsTool(env: ToolEnv, args: Spec): ToolResult {
  const clips = (Array.isArray(args.animationIds) ? args.animationIds : [args.animationId]).map(normId).filter(Boolean);
  if (!clips.length) throw new ToolError("remove_animations: animationIds (get_motion lists each layer's animations).");
  const layers = clips.map((c) => layerOfClip(env, args.nodeId, c));
  env.write("Remove animation", () => clips.forEach((c, i) => removeAnimationStyle(env.ed, layers[i], c)), layers);
  const r = textResult({ removed: clips });
  r.touched = [...new Set(layers)];
  return r;
}

/** apply_animation_style: one of the composite styles (Fade in, Slide in …), its presets stacked under one entry. */
export function applyAnimationStyleTool(env: ToolEnv, args: Spec): ToolResult {
  const nodes = ids(env, args, "apply_animation_style");
  const key = String(args.style ?? "");
  const style = ANIMATION_STYLES.find((s) => s.key === key || s.name.toLowerCase() === key.toLowerCase());
  if (!style) throw new ToolError(`apply_animation_style: style — one of ${ANIMATION_STYLES.map((s) => `${s.key} ("${s.name}")`).join(", ")}. A single preset (Opacity, Position, TextStagger …) is add_animation.`);
  const start = num(args.timelineOffset, "timelineOffset") ?? 0;
  if (start < 0) throw new ToolError("timelineOffset: seconds, 0 or more");
  const targets: PresetTarget[] = nodes.map((id) => {
    const n = env.ed.engine.readNode(id, { fields: ["type", "strokePaints"] }) as { type?: string; strokePaints?: unknown[] } | null;
    return { type: n?.type ?? "FRAME", strokes: (n?.strokePaints?.length ?? 0) > 0 };
  });
  if (style.textOnly && !targets.every((t) => t.type === "TEXT")) throw new ToolError(`${style.name} animates text layers only.`);
  for (const id of nodes) if (timelineRootOf(env.ed, id) === id) throw new ToolError("Do not animate top-level frames: animate their children or descendants instead (the frame is the timeline).");
  env.write("Apply animation style", () => {
    for (const p of style.presets) if (!presetAllowed(presetDef(p.preset)!, targets)) throw new ToolError(`${style.name} can't go on these layers.`);
    if (!applyStyle(env.ed, style.key, nodes, targets[0], Math.round(start * US))) throw new ToolError(`${style.name} was refused by the engine.`);
    const end = Math.max(0, ...nodes.flatMap((id) => animationStylesOf(env.ed, id).map((s) => s.timelineOffset + s.duration)));
    if (args.extendTimeline !== false) extendTo(env, nodes[0], end);
  }, nodes);
  const r = textResult({ style: style.key, layers: Object.fromEntries(nodes.map((id) => [id, animationStylesOf(env.ed, id)])), timeline: timelineSummary(env, nodes[0]) });
  r.touched = nodes;
  return r;
}

/** detach_animation_style: a style entry forgotten, its animations kept as they are. */
export function detachAnimationStyleTool(env: ToolEnv, args: Spec): ToolResult {
  const entry = normId(args.styleEntryId ?? args.id);
  if (!entry) throw new ToolError("detach_animation_style: styleEntryId (get_motion's animationStyles[].id).");
  env.write("Detach animation style", () => {
    if (!detachStyle(env.ed, entry)) throw new ToolError(`No animation style entry ${entry} (get_motion lists them under a layer's animationStyles).`);
  });
  return textResult({ detached: entry });
}

// ---- Audio --------------------------------------------------------------------------------------------------------

/** add_audio: a sound file (main has read `path` into `data`) on a top-level frame's timeline at `offset`. */
export async function addAudioTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const { model } = rootOf(env, args, "add_audio");
  if (typeof args.data !== "string") throw new ToolError(`add_audio: give \`path\` (an AAC, MP3, WAV or M4A file in your working folder) or \`data\` (base64 bytes)${typeof args.path === "string" ? " — this path wasn't read by the app" : ""}`);
  const bytes = base64Bytes(args.data);
  if (!bytes) throw new ToolError("add_audio.data: not base64");
  if (bytes.length > MAX_AUDIO_BYTES) throw new ToolError("add_audio: audio files can be up to 100 MB");
  const offset = num(args.offset, "offset") ?? 0;
  if (offset < 0) throw new ToolError("offset: seconds, 0 or more");
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 120) : "Audio";
  // Stored and decoded first (as a dropped file is, audio.ts), then added in the agent's own step.
  const store = env.ed.images.store;
  const hash = store ? await store.put(bytes, typeof args.mime === "string" ? args.mime : "audio/mpeg") : null;
  if (!hash) throw new ToolError("add_audio: audio can't be added to this file.");
  const buffer = await audioLibrary(env.ed).decode(hash, bytes);
  if (!buffer) throw new ToolError("add_audio: the file couldn't be decoded (AAC, MP3, WAV or M4A).");
  let added: string[] = [];
  env.write("Add audio", () => {
    const r = env.ed.engine.runMotionCommandCreating("MOTION_ADD_AUDIO", { root: model.root, mediaHash: hash, name, offsetUs: Math.round(offset * US), durationUs: Math.round(buffer.duration * US) });
    if (r.status !== 0) throw new ToolError(`add_audio was refused by the engine (status ${r.status}).`);
    added = [...r.created];
  });
  const after = timelineOf(env.ed, model.root);
  return textResult({ added: (after?.audio ?? []).filter((a) => added.includes(a.id)).map((a) => ({ id: a.id, name: a.name, offset: sec(a.offsetUs), duration: sec(a.durationUs) })), timeline: timelineSummary(env, model.root) });
}

/** edit_audio: a clip moved, trimmed, its volume or mute, split at a time, or removed. */
export function editAudioTool(env: ToolEnv, args: Spec): ToolResult {
  const { model } = rootOf(env, args, "edit_audio");
  const clipId = normId(args.audioId ?? args.id);
  const clip = model.audio.find((a) => a.id === clipId);
  if (!clip) throw new ToolError(`edit_audio: audioId — one of ${model.audio.map((a) => `${a.id} (${a.name})`).join(", ") || "none: this timeline has no audio"}.`);
  const root = model.root;
  const e = env.ed.engine;
  const check = (status: number, what: string) => {
    if (status !== 0) throw new ToolError(`${what} was refused by the engine (status ${status}).`);
  };
  let made: string[] = [];
  env.write("Edit audio", () => {
    if (args.remove === true) return check(e.runMotionCommand("MOTION_REMOVE_AUDIO", { root, ids: [clip.id] }), "Delete audio");
    const volume = num(args.volume, "volume");
    if (volume !== undefined && (volume < 0 || volume > 1)) throw new ToolError("volume: 0–1");
    const edit = {
      id: clip.id,
      ...(args.offset !== undefined ? { offsetUs: Math.max(0, Math.round(num(args.offset, "offset")! * US)) } : {}),
      ...(args.trimStart !== undefined ? { startUs: Math.max(0, Math.round(num(args.trimStart, "trimStart")! * US)) } : {}),
      ...(args.duration !== undefined ? { durationUs: Math.max(1, Math.round(num(args.duration, "duration")! * US)) } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(typeof args.mute === "boolean" ? { mute: args.mute } : {}),
    };
    if (Object.keys(edit).length > 1) check(e.runMotionCommand("MOTION_SET_AUDIO", { root, edits: [edit] }), "Edit audio");
    const at = num(args.splitAt, "splitAt");
    if (at !== undefined) {
      const r = e.runMotionCommandCreating("MOTION_SPLIT_AUDIO", { root, id: clip.id, atUs: Math.round(at * US) });
      check(r.status, "Split audio");
      made = [...r.created];
    }
  });
  const after = timelineOf(env.ed, root);
  return textResult({ audio: (after?.audio ?? []).map((a) => ({ id: a.id, name: a.name, offset: sec(a.offsetUs), trimStart: sec(a.startUs), duration: sec(a.durationUs), volume: a.volume, mute: a.mute })), ...(made.length ? { created: made } : {}) });
}

// ---- Export -------------------------------------------------------------------------------------------------------

/** The largest file export_animation hands back (the result travels to main as base64). */
export const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

const MIME: Record<AnimatedFormat, string> = { MP4: "video/mp4", WEBM: "video/webm", GIF: "image/gif", SVG: "image/svg+xml", LOTTIE: "application/json", DOTLOTTIE: "application/zip" };

/** export_animation: a top-level frame's animation as MP4, WebM, GIF, animated SVG, Lottie or dotLottie — the file is saved in the agent's working folder. */
export async function exportAnimationTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const { model } = rootOf(env, args, "export_animation");
  const format = String(args.format ?? "MP4").toUpperCase() as AnimatedFormat;
  if (!ANIMATED_FORMATS.includes(format)) throw new ToolError(`format: one of ${ANIMATED_FORMATS.join(", ")}`);
  const fps = num(args.fps, "fps") ?? 30;
  if (!(FRAME_RATES as readonly number[]).includes(fps)) throw new ToolError(`fps: one of ${FRAME_RATES.join(", ")}`);
  const width = num(args.width, "width");
  const height = num(args.height, "height");
  const scale = num(args.scale, "scale") ?? 1;
  if (!(scale > 0 && scale <= 4)) throw new ToolError("scale: more than 0, at most 4");
  const quality = String(args.quality ?? "HIGH").toUpperCase() as AnimatedExportSettings["quality"];
  if (!["LOW", "MEDIUM", "HIGH"].includes(quality)) throw new ToolError("quality: LOW, MEDIUM or HIGH");
  const settings: AnimatedExportSettings = { format, size: width || height ? { width: width ?? 0, height: height ?? 0 } : { scale }, fps: fps as AnimatedExportSettings["fps"], quality, loop: args.loop !== false };
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : model.rootName;
  const r = await renderAnimated(env.ed, { root: model.root, name, settings });
  if ("error" in r) throw new ToolError(`export_animation: ${r.error}`);
  if (r.bytes.length > MAX_EXPORT_BYTES) throw new ToolError("export_animation: the file is larger than 200 MB — lower the size, frame rate or quality");
  const file = animatedFileName(name, format);
  const out = textResult({ file, format, bytes: r.bytes.length, duration: sec(model.durationUs), playback: model.playback, fps });
  out.files = [{ name: file, data: base64(r.bytes), mimeType: MIME[format] }];
  return out;
}
