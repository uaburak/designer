/**
 * Figma's public Motion shapes over the engine (docs/motion.md §9; round 8f) — the Plugin API's `manualKeyframeTracks`,
 * `applyManualKeyframeTrack`, `animationStyles`, `applyAnimationStyle`, `timelines`, `setTimelineDuration`,
 * `animations` and `figma.motion.figmaAnimationStyles()`, written from Figma's own Plugin API guide for agents (the
 * figma-use-motion skill of Figma's MCP plugin, 2.2.157: shapes, the field allowlist, the errors' rules). The Plugin
 * API (plugins/api/motion.ts) and the agents' motion tools (agents/motionTools.ts) both call these, so the two speak
 * one vocabulary; each write is the motion commands the chrome runs (MOTION_ADD_KEYFRAME, MOTION_SET_KEYFRAMES,
 * MOTION_DELETE_*, MOTION_SET_TIMELINE, the presets' commands through ./presets).
 *
 * Seconds here, µs inside; values in public units (opacity 0–1, rotation degrees CCW+, scale multipliers, colours
 * 0–1), which the engine's timeline model and MOTION_ADD_KEYFRAME already speak. Figma's "animation styles" of the
 * Plugin API are its presets (`styleId` "Opacity", "TextStagger" …): one applied style is one of our preset clips,
 * its `id` the clip's. Our composite styles (Fade in, Slide in … — ANIMATION_STYLES) aren't in Figma's API; the
 * agents' apply_animation_style applies them.
 */
import type { Guid } from "@/engine/codec";
import {
  ANIMATION_PRESETS,
  EFFECT_KEYFRAME_FIELDS,
  KEYFRAME_FIELDS,
  KEYFRAME_PROPERTY_FIELDS,
  MOTION_EASING_TYPES,
  TIMING_PROP_KEYS,
  fieldKey,
  type EffectKeyframeFieldName,
  type KeyframeField,
  type KeyframePropertyFieldName,
  type KeyframeValue,
  type Micros,
  type MotionEasing,
  type PlaybackName,
  type PresetDef,
  type PresetKey,
  type PresetPropValue,
  type TimelineClip,
  type TimelineLayer,
  type TimelineModel,
  type TimelineTrack,
} from "@shared/motion/types";
import type { EditorController } from "../controller";
import { addPreset, clipProps, editPreset, presetAllowed, presetDef, presetDurationUs, removePresets, type PresetTarget } from "./presets";

export class MotionApiError extends Error {}

const fail = (message: string): never => {
  throw new MotionApiError(message);
};

const US = 1e6;
const seconds = (us: Micros) => Math.round(us) / US;
const micros = (s: number) => Math.round(s * US);

// ---- Shapes ---------------------------------------------------------------------------------------------------------

export interface PublicKeyframe {
  id?: string;
  /** Seconds from the timeline's start (≥ 0) */
  timelinePosition: number;
  value: KeyframeValue;
  /** Into this keyframe (unused on the first) */
  easing?: MotionEasing;
}

export interface PublicTrack {
  id?: string;
  keyframes: PublicKeyframe[];
}

/** `node.manualKeyframeTracks`: node fields by name, fills / strokes by paint index, effects by index then field. */
export type ManualKeyframeTracks = Partial<Record<KeyframePropertyFieldName, PublicTrack>> & {
  fills?: Record<number, PublicTrack>;
  strokes?: Record<number, PublicTrack>;
  effects?: Record<number, Partial<Record<EffectKeyframeFieldName, PublicTrack>>>;
};

/** One entry of `node.animationStyles` (an applied first-party style: one of our preset clips). */
export interface PublicAnimationStyle {
  id: string;
  type: "FIGMA";
  styleId: string;
  name: string;
  /** Seconds */
  duration: number;
  /** Seconds: the clip's start (our Delay) */
  timelineOffset: number;
  /** The style's props by key, `easing` among them; `visible` false: the clip's eye is off [ours] */
  props: Record<string, PresetPropValue>;
  visible: boolean;
}

export interface PublicTimeline {
  /** The timeline root's id (Figma: `figma.getNodeByIdAsync(timeline.id)` is the top-level frame) */
  id: string;
  /** Seconds */
  duration: number;
}

// ---- Fields and values ------------------------------------------------------------------------------------------

const PROPERTY_FIELDS: ReadonlySet<string> = new Set(KEYFRAME_PROPERTY_FIELDS);
const EFFECT_FIELDS: ReadonlySet<string> = new Set(EFFECT_KEYFRAME_FIELDS);
const EASINGS: ReadonlySet<string> = new Set(MOTION_EASING_TYPES);
const COLOR_EFFECT_FIELDS: ReadonlySet<string> = new Set(["COLOR", "SECONDARY_COLOR"]);

/** A field descriptor as the API takes it: a name ("OPACITY") or Figma's KeyframeField object. */
export function fieldFrom(v: unknown, at = "field"): KeyframeField {
  if (typeof v === "string") v = { type: "PROPERTY", name: v };
  const f = (v ?? {}) as Record<string, unknown>;
  if (f.type === "PROPERTY") {
    const name = String(f.name ?? "");
    if (!PROPERTY_FIELDS.has(name)) fail(`${at}: "${name}" can't be keyframed — one of ${KEYFRAME_PROPERTY_FIELDS.join(", ")}, or {type: "INDEXED_ITEM", collection: "fills" | "strokes" | "effects", index}`);
    return { type: "PROPERTY", name: name as KeyframePropertyFieldName };
  }
  if (f.type === "INDEXED_ITEM") {
    const index = f.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) fail(`${at}.index: a paint or effect index (0, 1 …)`);
    if (f.collection === "fills" || f.collection === "strokes") return { type: "INDEXED_ITEM", collection: f.collection, index: index as number, ...(f.opacity === true ? { opacity: true } : {}) };
    if (f.collection === "effects") {
      const field = String(f.field ?? "");
      if (!EFFECT_FIELDS.has(field)) fail(`${at}.field: an effect field — one of ${EFFECT_KEYFRAME_FIELDS.join(", ")}`);
      return { type: "INDEXED_ITEM", collection: "effects", index: index as number, field: field as EffectKeyframeFieldName };
    }
    fail(`${at}.collection: "fills", "strokes" or "effects"`);
  }
  return fail(`${at}: a field name ("OPACITY") or {type: "PROPERTY", name} | {type: "INDEXED_ITEM", collection, index[, field]}`);
}

/** The value type a field takes. */
function valueType(f: KeyframeField): KeyframeValue["type"] {
  if (f.type === "PROPERTY") return KEYFRAME_FIELDS[f.name].value as KeyframeValue["type"];
  if (f.collection === "effects") return COLOR_EFFECT_FIELDS.has(f.field ?? "") ? "COLOR" : "FLOAT";
  return "opacity" in f && f.opacity ? "FLOAT" : "COLOR";
}

const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);

function valueFrom(f: KeyframeField, v: unknown, at: string): KeyframeValue {
  const want = valueType(f);
  const kv = (v ?? {}) as { type?: unknown; value?: unknown };
  // A bare number / {x, y} / {r, g, b} is read as the field's type.
  const raw = typeof v === "number" || (v && typeof v === "object" && !("type" in (v as object))) ? { type: want, value: v } : kv;
  if (raw.type !== want) fail(`${at}: ${fieldKey(f)} takes {type: "${want}", value}${raw.type ? ` (not ${String(raw.type)})` : ""}`);
  const x = raw.value as Record<string, unknown>;
  if (want === "FLOAT") {
    if (!finite(raw.value)) fail(`${at}.value: a number`);
    return { type: "FLOAT", value: raw.value as number };
  }
  if (want === "VECTOR") {
    if (!x || !finite(x.x) || !finite(x.y)) fail(`${at}.value: {x, y}`);
    return { type: "VECTOR", value: { x: x.x as number, y: x.y as number } };
  }
  if (!x || !finite(x.r) || !finite(x.g) || !finite(x.b)) fail(`${at}.value: {r, g, b, a} in 0–1`);
  return { type: "COLOR", value: { r: x.r as number, g: x.g as number, b: x.b as number, a: finite(x.a) ? (x.a as number) : 1 } };
}

/** A public easing; Figma's schema names only (never OUT_CUBIC, EASE_IN_OUT …). */
export function easingFrom(v: unknown, at = "easing"): MotionEasing {
  const e = (typeof v === "string" ? { type: v } : (v ?? {})) as Record<string, unknown>;
  if (e.type === "VARIABLE_ALIAS") fail(`${at}: easing variables can't be bound from here yet`);
  const type = String(e.type ?? "");
  if (!EASINGS.has(type)) fail(`${at}.type: one of ${MOTION_EASING_TYPES.join(", ")}${type === "EASE_IN_OUT" ? " (EASE_IN_AND_OUT, not EASE_IN_OUT)" : ""}`);
  if (type === "CUSTOM_CUBIC_BEZIER") {
    const b = e.easingFunctionCubicBezier as Record<string, unknown> | undefined;
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(finite)) fail(`${at}.easingFunctionCubicBezier: {x1, y1, x2, y2}`);
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: b!.x1 as number, y1: b!.y1 as number, x2: b!.x2 as number, y2: b!.y2 as number } };
  }
  if (type === "CUSTOM_SPRING") {
    const s = e.easingFunctionSpring as Record<string, unknown> | undefined;
    if (!s || !finite(s.bounce)) fail(`${at}.easingFunctionSpring: {bounce} (0–1)`);
    return { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: s!.bounce as number } };
  }
  return { type: type as MotionEasing["type"] };
}

// ---- Nodes and timelines ----------------------------------------------------------------------------------------

type Read = { type?: string; parentIndex?: { guid?: Guid }; strokePaints?: unknown[] };
const readOf = (ed: EditorController, id: Guid) => ed.engine.readNode(id, { fields: ["type", "parentIndex", "strokePaints"] }) as Read | null;

/** The top-level frame a layer plays in (itself for one); null for a page, or a layer not on one. */
export function timelineRootOf(ed: EditorController, id: Guid): Guid | null {
  let cur = id;
  let n = readOf(ed, cur);
  for (let i = 0; n && i < 400; i++) {
    const parent = n.parentIndex?.guid;
    if (!parent) return null;
    const p = readOf(ed, parent);
    if (!p) return null;
    if (p.type === "CANVAS") return n.type === "CANVAS" ? null : cur;
    cur = parent;
    n = p;
  }
  return null;
}

/** The engine's timeline model of a layer's root (null: no Motion in this build, or not on a page). */
export function timelineOf(ed: EditorController, id: Guid): TimelineModel | null {
  const root = timelineRootOf(ed, id);
  if (!root) return null;
  try {
    return ed.engine.motionTimeline(root);
  } catch {
    return null;
  }
}

const layerIn = (model: TimelineModel | null, id: Guid): TimelineLayer | undefined => model?.layers.find((l) => l.node === id);

/** A layer that may be animated: on a page, under a top-level frame (Figma: "Do not animate top-level frames"). */
function animatable(ed: EditorController, id: Guid): Guid {
  const n = readOf(ed, id);
  if (!n) fail(`No layer ${id} in this file`);
  const root = timelineRootOf(ed, id);
  if (!root) fail(`${id} isn't on a page: only layers inside a top-level frame can be animated`);
  if (root === id) fail("Do not animate top-level frames: animate their children or descendants instead (the frame is the timeline)");
  return root!;
}

const run = (ed: EditorController, fn: () => number, what: string) => {
  let status: number;
  try {
    status = fn();
  } catch (e) {
    return fail(`${what}: Motion isn't available in this build (${e instanceof Error ? e.message : String(e)})`);
  }
  if (status !== 0) fail(`${what} was refused by the engine (status ${status})`);
};

// ---- Manual keyframe tracks -------------------------------------------------------------------------------------

const publicTrack = (t: TimelineTrack): PublicTrack => ({
  id: t.id,
  keyframes: t.keyframes.map((k) => ({ id: k.id, timelinePosition: seconds(k.timeUs), value: k.value, ...("type" in k.easing ? { easing: k.easing } : {}) })),
});

/** `node.manualKeyframeTracks` (a fill's opacity track, ours, isn't in Figma's object and isn't listed). */
export function manualKeyframeTracks(ed: EditorController, id: Guid): ManualKeyframeTracks {
  const out: ManualKeyframeTracks = {};
  for (const t of layerIn(timelineOf(ed, id), id)?.tracks ?? []) {
    const f = t.field;
    if (f.type === "PROPERTY") out[f.name] = publicTrack(t);
    else if (f.collection === "effects" && f.field) ((out.effects ??= {})[f.index] ??= {})[f.field] = publicTrack(t);
    else if (f.collection !== "effects" && !f.propertyId && !("opacity" in f && f.opacity)) (out[f.collection] ??= {})[f.index] = publicTrack(t);
  }
  return out;
}

const sameField = (a: KeyframeField, b: KeyframeField) => fieldKey(a) === fieldKey(b);
const trackOf = (ed: EditorController, id: Guid, f: KeyframeField) => layerIn(timelineOf(ed, id), id)?.tracks.find((t) => sameField(t.field, f));

/** Figma's checks before a track is written: the root, WIDTH / HEIGHT's node types, combined vs separated tracks. */
function checkTrack(ed: EditorController, id: Guid, f: KeyframeField): void {
  animatable(ed, id);
  if (f.type !== "PROPERTY") return;
  const type = readOf(ed, id)?.type;
  if ((f.name === "WIDTH" || f.name === "HEIGHT") && (type === "GROUP" || type === "VECTOR" || type === "BOOLEAN_OPERATION")) fail(`${f.name} can't be animated on a ${type === "BOOLEAN_OPERATION" ? "boolean group" : type.toLowerCase()}`);
  const pairs: Record<string, string[]> = { TRANSLATION_XY: ["TRANSLATION_X", "TRANSLATION_Y"], SCALE_XY: ["SCALE_X", "SCALE_Y"], TRANSLATION_X: ["TRANSLATION_XY"], TRANSLATION_Y: ["TRANSLATION_XY"], SCALE_X: ["SCALE_XY"], SCALE_Y: ["SCALE_XY"] };
  const other = (pairs[f.name] ?? []).find((name) => trackOf(ed, id, { type: "PROPERTY", name: name as KeyframePropertyFieldName }));
  if (other) fail(`keyframe tracks must be either combined or separated: the layer has a ${other} track — remove it first, or write ${other}`);
}

/** The keyframes as given, checked: times ≥ 0, values of the field's type, public easings. */
function keyframesFrom(f: KeyframeField, list: unknown, at: string): PublicKeyframe[] {
  if (!Array.isArray(list)) return fail(`${at}.keyframes: an array of {timelinePosition (s), value, easing?}`);
  return list.map((k, i) => {
    const o = (k ?? {}) as Record<string, unknown>;
    const p = o.timelinePosition;
    if (!finite(p) || (p as number) < 0) fail(`${at}.keyframes[${i}].timelinePosition: seconds, 0 or more`);
    return {
      ...(typeof o.id === "string" ? { id: o.id } : {}),
      timelinePosition: p as number,
      value: valueFrom(f, o.value, `${at}.keyframes[${i}].value`),
      ...(o.easing !== undefined ? { easing: easingFrom(o.easing, `${at}.keyframes[${i}].easing`) } : {}),
    };
  });
}

/**
 * `node.applyManualKeyframeTrack(field, track)`: the field's track becomes `track` — keyframes with an id it has are
 * edited in place, the ones it doesn't list are deleted, the rest added (no keyframes: the track is removed). With
 * `merge`, nothing is deleted (the agents' set_keyframes). Returns the track as it now is.
 */
export function applyManualKeyframeTrack(ed: EditorController, id: Guid, field: unknown, track: unknown, opts: { merge?: boolean } = {}): PublicTrack | null {
  const f = fieldFrom(field);
  checkTrack(ed, id, f);
  const keys = keyframesFrom(f, (track as { keyframes?: unknown } | null)?.keyframes, "track");
  const existing = trackOf(ed, id, f);
  const have = new Map((existing?.keyframes ?? []).map((k) => [k.id, k]));
  if (!keys.length) {
    if (existing && !opts.merge) run(ed, () => ed.engine.runMotionCommand("MOTION_DELETE_TRACKS", { node: id, fields: [f] }), "Delete animation");
    return opts.merge && existing ? publicTrack(existing) : null;
  }
  const kept = new Set(keys.map((k) => k.id).filter((k): k is string => !!k && have.has(k)));
  const gone = opts.merge ? [] : [...have.keys()].filter((k) => !kept.has(k));
  if (gone.length) run(ed, () => ed.engine.runMotionCommand("MOTION_DELETE_KEYFRAMES", { ids: gone }), "Delete keyframes");
  const edits = keys.filter((k) => k.id && kept.has(k.id)).map((k) => ({ id: k.id!, timeUs: micros(k.timelinePosition), value: k.value, ...(k.easing ? { easing: k.easing } : {}) }));
  if (edits.length) run(ed, () => ed.engine.runMotionCommand("MOTION_SET_KEYFRAMES", { edits }), "Edit keyframe");
  for (const k of keys.filter((x) => !x.id || !kept.has(x.id))) {
    run(ed, () => ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [id], field: f, timeUs: micros(k.timelinePosition), value: k.value, ...(k.easing ? { easing: k.easing } : {}) }), "Add keyframe");
  }
  const now = trackOf(ed, id, f);
  return now ? publicTrack(now) : null;
}

/** `node.removeManualKeyframeTrack(field)`. False when the layer had no such track. */
export function removeManualKeyframeTrack(ed: EditorController, id: Guid, field: unknown): boolean {
  const f = fieldFrom(field);
  animatable(ed, id);
  if (!trackOf(ed, id, f)) return false;
  run(ed, () => ed.engine.runMotionCommand("MOTION_DELETE_TRACKS", { node: id, fields: [f] }), "Delete animation");
  return true;
}

/** Keyframes by id (the agents' remove_keyframes); an emptied track goes with its binding. */
export function deleteKeyframes(ed: EditorController, ids: string[]): void {
  if (ids.length) run(ed, () => ed.engine.runMotionCommand("MOTION_DELETE_KEYFRAMES", { ids }), "Delete keyframes");
}

/** The descriptors of a `manualKeyframeTracks` object's entries. */
function entriesOf(v: unknown): [KeyframeField, unknown][] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("manualKeyframeTracks: an object {OPACITY: {keyframes}, fills: {0: {keyframes}}, effects: {0: {RADIUS: {keyframes}}} …}");
  const out: [KeyframeField, unknown][] = [];
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (t === undefined || t === null) continue;
    if (k === "fills" || k === "strokes") for (const [i, tr] of Object.entries(t as Record<string, unknown>)) out.push([fieldFrom({ type: "INDEXED_ITEM", collection: k, index: Number(i) }, `manualKeyframeTracks.${k}[${i}]`), tr]);
    else if (k === "effects") {
      for (const [i, byField] of Object.entries(t as Record<string, unknown>))
        for (const [name, tr] of Object.entries((byField ?? {}) as Record<string, unknown>)) out.push([fieldFrom({ type: "INDEXED_ITEM", collection: "effects", index: Number(i), field: name }, `manualKeyframeTracks.effects[${i}].${name}`), tr]);
    } else out.push([fieldFrom(k, `manualKeyframeTracks.${k}`), t]);
  }
  return out;
}

/** `node.manualKeyframeTracks = {...}`: each listed track written, the tracks it leaves out removed. */
export function setManualKeyframeTracks(ed: EditorController, id: Guid, value: unknown): void {
  const wanted = entriesOf(value);
  animatable(ed, id);
  const keys = new Set(wanted.map(([f]) => fieldKey(f)));
  const drop = (layerIn(timelineOf(ed, id), id)?.tracks ?? []).map((t) => t.field).filter((f) => !keys.has(fieldKey(f)) && !(f.type === "INDEXED_ITEM" && f.collection !== "effects" && ("opacity" in f && f.opacity || f.propertyId)));
  // Removed first, so a TRANSLATION_X / Y pair can become one TRANSLATION_XY track in the same write.
  if (drop.length) run(ed, () => ed.engine.runMotionCommand("MOTION_DELETE_TRACKS", { node: id, fields: drop }), "Delete animation");
  for (const [f, t] of wanted) applyManualKeyframeTrack(ed, id, f, t);
}

/** `node.animations`: the manual tracks in timeline order, each {field, keyframes} (Figma: manual tracks only). */
export function animationsOf(ed: EditorController, id: Guid): { field: KeyframeField; keyframes: PublicKeyframe[] }[] {
  return (layerIn(timelineOf(ed, id), id)?.tracks ?? []).map((t) => ({ field: t.field, keyframes: publicTrack(t).keyframes }));
}

// ---- Timelines --------------------------------------------------------------------------------------------------

/** `node.timelines`: the containing top-level frame's timeline (none off a page). */
export function timelinesOf(ed: EditorController, id: Guid): PublicTimeline[] {
  const model = timelineOf(ed, id);
  return model ? [{ id: model.timelineId, duration: seconds(model.durationUs) }] : [];
}

/** `node.setTimelineDuration(id, seconds)`; the agents' set_timeline adds the playback and the snapping rate. */
export function setTimeline(ed: EditorController, id: Guid, timelineId: string | null, patch: { duration?: number; playback?: PlaybackName; fps?: number }): PublicTimeline {
  const model = timelineOf(ed, id);
  if (!model) return fail(`${id} isn't in a top-level frame: it has no timeline`);
  if (timelineId !== null && timelineId !== model.timelineId) fail(`Timeline ${timelineId} isn't this node's (${model.timelineId}): use node.timelines`);
  if (patch.duration !== undefined && (!finite(patch.duration) || patch.duration <= 0 || patch.duration > 600)) fail("duration: seconds, more than 0 and at most 600");
  if (patch.playback !== undefined && !["LOOP", "ONCE", "PING_PONG"].includes(patch.playback)) fail("playback: LOOP, ONCE or PING_PONG");
  if (patch.fps !== undefined && (!finite(patch.fps) || patch.fps < 1 || patch.fps > 1000)) fail("fps: the snapping rate, 1–1000 frames per second");
  run(ed, () => ed.engine.runMotionCommand("MOTION_SET_TIMELINE", { root: model.root, ...(patch.duration !== undefined ? { durationUs: micros(patch.duration) } : {}), ...(patch.playback ? { playback: patch.playback } : {}), ...(patch.fps !== undefined ? { snappingFps: patch.fps } : {}) }), "Change duration");
  return timelinesOf(ed, id)[0];
}

// ---- Animation styles (presets) ---------------------------------------------------------------------------------

/** Figma's style ids of the first-party presets (Opacity and TextStagger seen in Figma's guide; the rest by the same rule [unverified]). */
export const STYLE_IDS: Record<PresetKey, string> = { new: "New", opacity: "Opacity", position: "Position", scale: "Scale", rotation: "Rotation", size: "Size", cornerRadius: "CornerRadius", path: "Path", text: "Text", textStagger: "TextStagger" };
const KEY_OF_STYLE = new Map(Object.entries(STYLE_IDS).map(([k, v]) => [v.toLowerCase(), k as PresetKey]));

/** A preset by Figma's style id or our key ("Opacity", "opacity", "TextStagger", "textStagger"). */
export function presetOf(styleId: unknown): PresetDef {
  const key = KEY_OF_STYLE.get(String(styleId ?? "").toLowerCase()) ?? (presetDef(String(styleId) as PresetKey) ? (String(styleId) as PresetKey) : null);
  const def = key ? presetDef(key) : undefined;
  if (!def) return fail(`No animation style ${JSON.stringify(styleId)}: figma.motion.figmaAnimationStyles() lists them (${FIGMA_STYLES.map((d) => STYLE_IDS[d.key]).join(", ")})`);
  return def;
}

/** Figma's discoverable styles: its presets, without New and the internal Text typewriter (Figma's guide). */
const FIGMA_STYLES: readonly PresetDef[] = ANIMATION_PRESETS.filter((p) => p.key !== "new" && p.key !== "text");

const propDoc = (d: PresetDef["props"][number]): string => {
  const def = typeof d.default === "object" ? JSON.stringify(d.default) : String(d.default);
  const kind = d.kind === "enum" ? `one of ${d.options!.map(([v]) => v).join(" | ")}` : d.kind === "easing" ? "an easing {type}" : d.kind === "bool" ? "boolean" : `number${d.unit ? ` (${d.unit === "s" ? "seconds" : d.unit})` : ""}`;
  return `${d.key} // ${kind}; default: ${def}`;
};

/** `figma.motion.figmaAnimationStyles()`: {styleId, name, description, props} — props as documentation strings, as Figma's are. */
export function figmaAnimationStyles(): { styleId: string; name: string; description: string; props: Record<string, string> }[] {
  return FIGMA_STYLES.map((d) => ({
    styleId: STYLE_IDS[d.key],
    name: d.name,
    description: d.needs === "text" ? `${d.name}: animates a text layer's characters, words, lines or paragraphs` : d.needs === "strokes" ? `${d.name}: animates a stroked layer's path trim` : `${d.name} animation`,
    props: Object.fromEntries(d.props.map((p) => [p.key, propDoc(p)])),
  }));
}

/**
 * Figma's prop names where ours differ (its guide's TextStagger and Opacity): `positionEnabled` → `position`,
 * `direction` / `distance` → `positionDirection` / `positionDistance`, a `*Visible: false` mutes the style (off here),
 * `rotationDirection: "counterClockwise"` turns the amount the other way, Opacity's `timing: "in" | "out"` → `type`.
 * Our own keys pass as they are; Blur (Figma's TextStagger blur) isn't built and is refused.
 */
function propsFromFigma(def: PresetDef, raw: Record<string, unknown>): Record<string, PresetPropValue> {
  const p: Record<string, unknown> = { ...raw };
  if (def.key === "textStagger") {
    for (const s of ["position", "rotation", "scale", "opacity"]) {
      if (p[`${s}Enabled`] !== undefined) p[s] = p[`${s}Enabled`] === true;
      if (p[`${s}Visible`] === false) p[s] = false;
      delete p[`${s}Enabled`];
      delete p[`${s}Visible`];
    }
    if (p.direction !== undefined) p.positionDirection = p.direction;
    if (p.distance !== undefined) p.positionDistance = p.distance;
    if (String(p.rotationDirection ?? "").toLowerCase() === "counterclockwise") p.rotationAmount = -Math.abs(Number(p.rotationAmount ?? 180));
    if (p.blurEnabled === true && p.blurVisible !== false) fail("TextStagger's blur isn't built yet: leave blurEnabled off");
    for (const k of ["direction", "distance", "rotationDirection", "blurEnabled", "blurVisible", "blurAmount"]) delete p[k];
  }
  if (def.key === "opacity" && (p.timing === "in" || p.timing === "out") && p.type === undefined) p.type = p.timing === "in" ? "fadeIn" : "fadeOut";
  delete p.timing;
  const out: Record<string, PresetPropValue> = {};
  for (const [k, v] of Object.entries(p)) {
    if (TIMING_PROP_KEYS.includes(k)) continue;
    const d = def.props.find((x) => x.key === k);
    if (!d) fail(`${STYLE_IDS[def.key]} has no prop ${k} (${def.props.filter((x) => !TIMING_PROP_KEYS.includes(x.key)).map((x) => x.key).join(", ")})`);
    if (d!.kind === "enum" && !d!.options!.some(([o]) => o === v)) fail(`${STYLE_IDS[def.key]}.${k}: one of ${d!.options!.map(([o]) => o).join(", ")}`);
    if (d!.kind === "number" && !finite(v)) fail(`${STYLE_IDS[def.key]}.${k}: a number`);
    if (d!.kind === "bool" && typeof v !== "boolean") fail(`${STYLE_IDS[def.key]}.${k}: true or false`);
    out[k] = v as PresetPropValue;
  }
  return out;
}

const clipsOf = (ed: EditorController, id: Guid): TimelineClip[] => layerIn(timelineOf(ed, id), id)?.clips ?? [];

const publicStyle = (c: TimelineClip): PublicAnimationStyle => ({
  id: c.id,
  type: "FIGMA",
  styleId: STYLE_IDS[c.preset] ?? c.preset,
  name: c.name,
  duration: seconds(c.durationUs),
  timelineOffset: seconds(c.startUs),
  props: { ...clipProps(c), ...("type" in c.easing ? { easing: c.easing } : {}) },
  visible: !c.disabled,
});

/** `node.animationStyles`, in the layer's stacking order. */
export function animationStylesOf(ed: EditorController, id: Guid): PublicAnimationStyle[] {
  return clipsOf(ed, id).map(publicStyle);
}

function targetOf(ed: EditorController, id: Guid): PresetTarget {
  const n = readOf(ed, id);
  return { type: n?.type ?? "FRAME", strokes: (n?.strokePaints?.length ?? 0) > 0 };
}

export interface StyleConfig {
  /** Seconds: the clip's length (`props.duration` wins, as Figma's) */
  duration?: number;
  /** Seconds: the clip's start; `props.delay` adds to it */
  timelineOffset?: number;
  props?: Record<string, unknown>;
  visible?: boolean;
}

function timing(config: StyleConfig, at: string): { startUs?: Micros; durationUs?: Micros; easing?: MotionEasing } {
  const p = config.props ?? {};
  const duration = p.duration ?? config.duration;
  if (duration !== undefined && (!finite(duration) || (duration as number) <= 0)) fail(`${at}duration: seconds, more than 0`);
  const offset = config.timelineOffset;
  const delay = p.delay;
  if (offset !== undefined && (!finite(offset) || offset < 0)) fail(`${at}timelineOffset: seconds, 0 or more`);
  if (delay !== undefined && (!finite(delay) || (delay as number) < 0)) fail(`${at}props.delay: seconds, 0 or more`);
  const start = offset !== undefined || delay !== undefined ? (offset ?? 0) + ((delay as number) ?? 0) : undefined;
  return {
    ...(start !== undefined ? { startUs: micros(start) } : {}),
    ...(duration !== undefined ? { durationUs: micros(duration as number) } : {}),
    ...(p.easing !== undefined ? { easing: easingFrom(p.easing, `${at}props.easing`) } : {}),
  };
}

/** `node.applyAnimationStyle(styleId, config?)`: a new clip (from the timeline's start unless timed); returns its id. */
export function applyAnimationStyle(ed: EditorController, id: Guid, styleId: unknown, config: StyleConfig = {}): string {
  const def = presetOf(styleId);
  animatable(ed, id);
  const target = targetOf(ed, id);
  if (!presetAllowed(def, [target])) fail(def.needs === "text" ? `${STYLE_IDS[def.key]} animates text layers only` : `${STYLE_IDS[def.key]} needs a layer with strokes`);
  const props = propsFromFigma(def, (config.props ?? {}) as Record<string, unknown>);
  const t = timing(config, "");
  const [clip] = addPreset(ed, def.key, [id], target, { props, startUs: t.startUs ?? 0, durationUs: t.durationUs ?? presetDurationUs(def), easing: t.easing });
  if (!clip) fail(`${STYLE_IDS[def.key]} couldn't be applied to ${id}`);
  if (config.visible === false) editPreset(ed, clipsOf(ed, id).find((c) => c.id === clip)!, { disabled: true }, target);
  return clip;
}

/** An applied style edited (its props merged, its timing, its eye): the agents' edit_animation and `animationStyles =`. */
export function editAnimationStyle(ed: EditorController, id: Guid, styleEntryId: string, change: StyleConfig & { styleId?: string }): PublicAnimationStyle {
  const clip = clipsOf(ed, id).find((c) => c.id === styleEntryId);
  if (!clip) return fail(`${id} has no animation style ${styleEntryId} (node.animationStyles lists them)`);
  const def = change.styleId !== undefined ? presetOf(change.styleId) : presetDef(clip.preset)!;
  const retype = def.key !== clip.preset;
  const props = change.props ? propsFromFigma(def, change.props) : undefined;
  const t = timing(change, "");
  const target = targetOf(ed, id);
  const patch = {
    ...(retype ? { preset: def.key } : {}),
    ...(props && Object.keys(props).length ? { props } : {}),
    ...t,
    ...(change.visible !== undefined ? { disabled: !change.visible } : {}),
  };
  if (Object.keys(patch).length && !editPreset(ed, clip, patch, target)) fail(`The animation style ${styleEntryId} couldn't be changed`);
  return publicStyle(clipsOf(ed, id).find((c) => c.id === styleEntryId)!);
}

/** `node.removeAnimationStyle(id)`. */
export function removeAnimationStyle(ed: EditorController, id: Guid, styleEntryId: string): void {
  if (!clipsOf(ed, id).some((c) => c.id === styleEntryId)) fail(`${id} has no animation style ${styleEntryId}`);
  if (!removePresets(ed, [styleEntryId])) fail(`The animation style ${styleEntryId} couldn't be removed`);
}

/** `node.animationStyles = [...]`: entries with an id it has are edited, the others applied, the ones left out removed. */
export function setAnimationStyles(ed: EditorController, id: Guid, list: unknown): void {
  if (!Array.isArray(list)) fail("animationStyles: an array of {styleId, name, duration, timelineOffset, props}");
  animatable(ed, id);
  const have = new Set(clipsOf(ed, id).map((c) => c.id));
  const entries = (list as Record<string, unknown>[]).map((e) => (e && typeof e === "object" ? e : fail("animationStyles: each entry an object")));
  const keep = new Set(entries.map((e) => String(e.id ?? "")).filter((x) => have.has(x)));
  const gone = [...have].filter((x) => !keep.has(x));
  if (gone.length && !removePresets(ed, gone)) fail("The animation styles couldn't be removed");
  for (const e of entries) {
    const config: StyleConfig & { styleId?: string } = {
      ...(e.duration !== undefined ? { duration: e.duration as number } : {}),
      ...(e.timelineOffset !== undefined ? { timelineOffset: e.timelineOffset as number } : {}),
      ...(e.props ? { props: e.props as Record<string, unknown> } : {}),
      ...(typeof e.visible === "boolean" ? { visible: e.visible } : {}),
    };
    if (keep.has(String(e.id))) editAnimationStyle(ed, id, String(e.id), { ...config, ...(e.styleId !== undefined ? { styleId: String(e.styleId) } : {}) });
    else applyAnimationStyle(ed, id, e.styleId, config);
  }
}
