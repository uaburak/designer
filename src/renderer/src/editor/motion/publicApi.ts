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
  type EasingRef,
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
import { presetProps } from "@shared/motion/presets";
import {
  PRESET_EASING,
  addPreset,
  applyCustomStyle,
  clipProps,
  createCustomStyle,
  customStyles,
  deleteCustomStyle,
  editPreset,
  presetAllowed,
  presetDef,
  presetDurationUs,
  removePresets,
  setCustomStyleTemplates,
  type CustomStyle,
  type PresetTarget,
  type StyleTemplate,
} from "./presets";

export class MotionApiError extends Error {}

const fail = (message: string): never => {
  throw new MotionApiError(message);
};

const US = 1e6;
const seconds = (us: Micros) => Math.round(us) / US;
const micros = (s: number) => Math.round(s * US);

// ---- Shapes ---------------------------------------------------------------------------------------------------------

/** Figma's VariableAlias: an easing bound to an EASING variable (round 8j). */
export interface VariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

export type PublicEasing = MotionEasing | VariableAlias;

export interface PublicKeyframe {
  id?: string;
  /** Seconds from the timeline's start (≥ 0) */
  timelinePosition: number;
  value: KeyframeValue;
  /** Into this keyframe (unused on the first); an EASING variable's alias when bound */
  easing?: PublicEasing;
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

/** A public easing; Figma's schema names only (never OUT_CUBIC, EASE_IN_OUT …). A variable's alias: easingRefFrom. */
export function easingFrom(v: unknown, at = "easing"): MotionEasing {
  const e = (typeof v === "string" ? { type: v } : (v ?? {})) as Record<string, unknown>;
  if (e.type === "VARIABLE_ALIAS") fail(`${at}: an easing value here, not a variable`);
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

/**
 * An easing or Figma's VariableAlias of an EASING variable (round 8j; `{type: "VARIABLE_ALIAS", id}`, as
 * `figma.variables.createVariableAlias` makes): the alias as the engine binds it, `{variable}`.
 */
export function easingRefFrom(ed: EditorController, v: unknown, at = "easing"): EasingRef {
  const e = (v ?? {}) as Record<string, unknown>;
  if (e.type !== "VARIABLE_ALIAS") return easingFrom(v, at);
  const id = String(e.id ?? "");
  const variable = id ? ed.engine.variable(id) : null;
  if (!variable) fail(`${at}.id: no variable ${JSON.stringify(id)} in this file`);
  if (variable!.resolvedType !== "EASING") fail(`${at}: ${variable!.name} is a ${variable!.resolvedType} variable — easings bind to EASING variables`);
  return { variable: id };
}

const aliasOf = (variable: string): VariableAlias => ({ type: "VARIABLE_ALIAS", id: variable });

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
  keyframes: t.keyframes.map((k) => ({ id: k.id, timelinePosition: seconds(k.timeUs), value: k.value, ...(k.easingVariable ? { easing: aliasOf(k.easingVariable) } : "type" in k.easing ? { easing: k.easing } : {}) })),
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

/** A keyframe as written: its easing a value or an EASING variable's binding. */
type KeyframeIn = Omit<PublicKeyframe, "easing"> & { easing?: EasingRef };

/** The keyframes as given, checked: times ≥ 0, values of the field's type, public easings or EASING variables' aliases. */
function keyframesFrom(ed: EditorController, f: KeyframeField, list: unknown, at: string): KeyframeIn[] {
  if (!Array.isArray(list)) return fail(`${at}.keyframes: an array of {timelinePosition (s), value, easing?}`);
  return list.map((k, i) => {
    const o = (k ?? {}) as Record<string, unknown>;
    const p = o.timelinePosition;
    if (!finite(p) || (p as number) < 0) fail(`${at}.keyframes[${i}].timelinePosition: seconds, 0 or more`);
    return {
      ...(typeof o.id === "string" ? { id: o.id } : {}),
      timelinePosition: p as number,
      value: valueFrom(f, o.value, `${at}.keyframes[${i}].value`),
      ...(o.easing !== undefined ? { easing: easingRefFrom(ed, o.easing, `${at}.keyframes[${i}].easing`) } : {}),
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
  const keys = keyframesFrom(ed, f, (track as { keyframes?: unknown } | null)?.keyframes, "track");
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
  // An Easing bound to an EASING variable reads as its alias (round 8j).
  props: { ...clipProps(c), ...(c.variables?.easing ? { easing: aliasOf(c.variables.easing) as unknown as PresetPropValue } : "type" in c.easing ? { easing: c.easing } : {}) },
  visible: !c.disabled,
});

/**
 * An applied custom style (Figma's custom binding, round 8j): the style entry's id, the style's id and name, and where
 * it starts — no duration or props (the style carries its own timing).
 */
export interface PublicCustomBinding {
  id: string;
  type: "CUSTOM";
  styleId: string;
  name: string;
  /** Seconds */
  timelineOffset: number;
}

export type PublicAppliedStyle = PublicAnimationStyle | PublicCustomBinding;

/**
 * `node.animationStyles`, in the layer's stacking order: a first-party style per clip, a custom style's clips as its
 * one binding (where its first clip is, less its first entry's place in the style).
 */
export function animationStylesOf(ed: EditorController, id: Guid): PublicAppliedStyle[] {
  const custom = new Map(customStyles(ed).map((s) => [s.id, s]));
  const out: PublicAppliedStyle[] = [];
  const bindings = new Map<string, { entry: PublicCustomBinding; firstUs: Micros; leadUs: Micros }>();
  for (const c of clipsOf(ed, id)) {
    const style = c.style ? custom.get(c.style.key) : undefined;
    if (!style || !c.style) {
      out.push(publicStyle(c));
      continue;
    }
    const had = bindings.get(c.style.id);
    if (had) had.firstUs = Math.min(had.firstUs, c.startUs);
    else {
      const entry: PublicCustomBinding = { id: c.style.id, type: "CUSTOM", styleId: style.id, name: style.name, timelineOffset: 0 };
      bindings.set(entry.id, { entry, firstUs: c.startUs, leadUs: style.templates.length ? Math.min(...style.templates.map((t) => t.offsetUs)) : 0 });
      out.push(entry);
    }
  }
  for (const b of bindings.values()) b.entry.timelineOffset = seconds(Math.max(0, b.firstUs - b.leadUs));
  return out;
}

/** Where a layer's last clip ends (seconds; 0 without clips): the agents extend the timeline to it. */
export function animationsEnd(ed: EditorController, id: Guid): number {
  return seconds(Math.max(0, ...clipsOf(ed, id).map((c) => c.startUs + c.durationUs)));
}

function targetOf(ed: EditorController, id: Guid): PresetTarget {
  const n = readOf(ed, id);
  return { type: n?.type ?? "FRAME", strokes: (n?.strokePaints?.length ?? 0) > 0 };
}

export interface StyleConfig {
  /** "FIGMA" (the default) or "CUSTOM": a custom style takes only `timelineOffset` (round 8j) */
  type?: "FIGMA" | "CUSTOM";
  /** Seconds: the clip's length (`props.duration` wins, as Figma's) */
  duration?: number;
  /** Seconds: the clip's start; `props.delay` adds to it */
  timelineOffset?: number;
  props?: Record<string, unknown>;
  visible?: boolean;
}

/** A clip's timing from a config; its Easing a value, or an EASING variable's alias (`easingVariable`, round 8j). */
function timing(ed: EditorController, config: StyleConfig, at: string): { startUs?: Micros; durationUs?: Micros; easing?: MotionEasing; easingVariable?: string } {
  const p = config.props ?? {};
  const duration = p.duration ?? config.duration;
  if (duration !== undefined && (!finite(duration) || (duration as number) <= 0)) fail(`${at}duration: seconds, more than 0`);
  const offset = config.timelineOffset;
  const delay = p.delay;
  if (offset !== undefined && (!finite(offset) || offset < 0)) fail(`${at}timelineOffset: seconds, 0 or more`);
  if (delay !== undefined && (!finite(delay) || (delay as number) < 0)) fail(`${at}props.delay: seconds, 0 or more`);
  const start = offset !== undefined || delay !== undefined ? (offset ?? 0) + ((delay as number) ?? 0) : undefined;
  const easing = p.easing !== undefined ? easingRefFrom(ed, p.easing, `${at}props.easing`) : undefined;
  return {
    ...(start !== undefined ? { startUs: micros(start) } : {}),
    ...(duration !== undefined ? { durationUs: micros(duration as number) } : {}),
    ...(easing ? ("variable" in easing ? { easingVariable: easing.variable } : { easing }) : {}),
  };
}

/**
 * `node.applyAnimationStyle(styleId, config?)`: a new clip (from the timeline's start unless timed); returns its id.
 * `{type: "CUSTOM"}` applies a custom style (round 8j) and returns its binding's id.
 */
export function applyAnimationStyle(ed: EditorController, id: Guid, styleId: unknown, config: StyleConfig = {}): string {
  if (config.type === "CUSTOM") return applyCustomBinding(ed, id, styleId, config);
  if (config.type !== undefined && config.type !== "FIGMA") fail(`type: "FIGMA" or "CUSTOM"`);
  if (customStyles(ed).some((s) => s.id === styleId)) fail(`${String(styleId)} is a custom animation style: apply it with {type: "CUSTOM", timelineOffset}`);
  const def = presetOf(styleId);
  animatable(ed, id);
  const target = targetOf(ed, id);
  if (!presetAllowed(def, [target])) fail(def.needs === "text" ? `${STYLE_IDS[def.key]} animates text layers only` : `${STYLE_IDS[def.key]} needs a layer with strokes`);
  const props = propsFromFigma(def, (config.props ?? {}) as Record<string, unknown>);
  const t = timing(ed, config, "");
  const [clip] = addPreset(ed, def.key, [id], target, { props, startUs: t.startUs ?? 0, durationUs: t.durationUs ?? presetDurationUs(def), easing: t.easing });
  if (!clip) fail(`${STYLE_IDS[def.key]} couldn't be applied to ${id}`);
  if (config.visible === false || t.easingVariable) editPreset(ed, clipsOf(ed, id).find((c) => c.id === clip)!, { ...(config.visible === false ? { disabled: true } : {}), ...(t.easingVariable ? { variables: { easing: t.easingVariable } } : {}) }, target);
  return clip;
}

/** An applied style edited (its props merged, its timing, its eye): the agents' edit_animation and `animationStyles =`. */
export function editAnimationStyle(ed: EditorController, id: Guid, styleEntryId: string, change: StyleConfig & { styleId?: string }): PublicAnimationStyle {
  const clip = clipsOf(ed, id).find((c) => c.id === styleEntryId);
  if (!clip) return fail(`${id} has no animation style ${styleEntryId} (node.animationStyles lists them)`);
  const def = change.styleId !== undefined ? presetOf(change.styleId) : presetDef(clip.preset)!;
  const retype = def.key !== clip.preset;
  const props = change.props ? propsFromFigma(def, change.props) : undefined;
  const { easingVariable, ...t } = timing(ed, change, "");
  const target = targetOf(ed, id);
  // A value unbinds a bound Easing; an alias binds it.
  const variables = easingVariable ? { easing: easingVariable } : t.easing && clip.variables?.easing ? { easing: null } : undefined;
  const patch = {
    ...(retype ? { preset: def.key } : {}),
    ...(props && Object.keys(props).length ? { props } : {}),
    ...t,
    ...(change.visible !== undefined ? { disabled: !change.visible } : {}),
    ...(variables ? { variables } : {}),
  };
  if (Object.keys(patch).length && !editPreset(ed, clip, patch, target)) fail(`The animation style ${styleEntryId} couldn't be changed`);
  return publicStyle(clipsOf(ed, id).find((c) => c.id === styleEntryId)!);
}

/** The clips a custom binding generated on a layer. */
const bindingClips = (ed: EditorController, id: Guid, binding: string): string[] => clipsOf(ed, id).filter((c) => c.style?.id === binding).map((c) => c.id);

/** `node.removeAnimationStyle(id)`: an applied style's clip, or a custom binding's clips (round 8j). */
export function removeAnimationStyle(ed: EditorController, id: Guid, styleEntryId: string): void {
  const clips = clipsOf(ed, id).some((c) => c.id === styleEntryId) ? [styleEntryId] : bindingClips(ed, id, styleEntryId);
  if (!clips.length) fail(`${id} has no animation style ${styleEntryId}`);
  if (!removePresets(ed, clips)) fail(`The animation style ${styleEntryId} couldn't be removed`);
}

/** `node.animationStyles = [...]`: entries with an id it has are edited, the others applied, the ones left out removed. */
export function setAnimationStyles(ed: EditorController, id: Guid, list: unknown): void {
  if (!Array.isArray(list)) fail("animationStyles: an array of {styleId, name, duration, timelineOffset, props} or {type: \"CUSTOM\", styleId, timelineOffset}");
  animatable(ed, id);
  const current = animationStylesOf(ed, id);
  const have = new Map(current.map((s) => [s.id, s]));
  const entries = (list as Record<string, unknown>[]).map((e) => (e && typeof e === "object" ? e : fail("animationStyles: each entry an object")));
  const keep = new Set(entries.map((e) => String(e.id ?? "")).filter((x) => have.has(x)));
  const gone = current.filter((s) => !keep.has(s.id)).flatMap((s) => (s.type === "CUSTOM" ? bindingClips(ed, id, s.id) : [s.id]));
  if (gone.length && !removePresets(ed, gone)) fail("The animation styles couldn't be removed");
  for (const e of entries) {
    const config: StyleConfig & { styleId?: string } = {
      ...(e.type === "CUSTOM" || e.type === "FIGMA" ? { type: e.type } : {}),
      ...(e.duration !== undefined ? { duration: e.duration as number } : {}),
      ...(e.timelineOffset !== undefined ? { timelineOffset: e.timelineOffset as number } : {}),
      ...(e.props ? { props: e.props as Record<string, unknown> } : {}),
      ...(typeof e.visible === "boolean" ? { visible: e.visible } : {}),
    };
    const was = keep.has(String(e.id)) ? have.get(String(e.id))! : null;
    if (e.type === "CUSTOM") {
      // A kept binding with its style and start as they are is left alone; a new style or start applies it again in place.
      if (was?.type === "CUSTOM" && (e.styleId ?? was.styleId) === was.styleId && (config.timelineOffset ?? was.timelineOffset) === was.timelineOffset) continue;
      applyCustomBinding(ed, id, e.styleId ?? (was?.type === "CUSTOM" ? was.styleId : undefined), { ...config, timelineOffset: config.timelineOffset ?? (was ? was.timelineOffset : 0) }, was ? was.id : undefined);
    } else if (was?.type === "CUSTOM") fail(`animationStyles: ${was.id} is a custom style's binding — write it as {type: "CUSTOM", id, styleId, timelineOffset}`);
    else if (was) editAnimationStyle(ed, id, was.id, { ...config, ...(e.styleId !== undefined ? { styleId: String(e.styleId) } : {}) });
    else applyAnimationStyle(ed, id, e.styleId, config);
  }
}

// ---- Custom animation styles (round 8j) -------------------------------------------------------------------------

/**
 * One entry of a custom style (Figma's `CustomAnimationStyle.animationEntries`): a first-party definition with its
 * settings — `styleId` names the entry itself (Figma: "not the source definition"); Delay, Duration and Easing are
 * in `props`, as `addAnimationEntryAsync` takes them.
 */
export interface PublicAnimationEntry {
  id: string;
  styleId: string;
  name: string;
  /** Seconds */
  duration: number;
  props: Record<string, PresetPropValue>;
}

/** A local custom animation style (Figma's `CustomAnimationStyle`, `type` "CUSTOM_ANIMATION"). */
export interface PublicCustomStyle {
  id: string;
  name: string;
  type: "CUSTOM_ANIMATION";
  remote: false;
  animationEntries: PublicAnimationEntry[];
}

const publicEntry = (t: StyleTemplate): PublicAnimationEntry => ({
  id: t.id,
  styleId: t.id,
  name: t.name,
  duration: seconds(t.durationUs),
  props: { ...presetProps(t.preset, t.props), delay: seconds(t.offsetUs), duration: seconds(t.durationUs), easing: t.easing },
});

const publicCustom = (s: CustomStyle): PublicCustomStyle => ({ id: s.id, name: s.name, type: "CUSTOM_ANIMATION", remote: false, animationEntries: s.templates.map(publicEntry) });

/** `figma.getLocalCustomAnimationStylesAsync()`: the file's custom styles in their order. */
export function customAnimationStyles(ed: EditorController): PublicCustomStyle[] {
  return customStyles(ed).map(publicCustom);
}

/** A custom style by its id (or, for the agents, its name when that is unique). */
function customStyleOf(ed: EditorController, styleId: unknown): CustomStyle {
  const all = customStyles(ed);
  const byId = all.find((s) => s.id === styleId);
  if (byId) return byId;
  const named = all.filter((s) => s.name === styleId);
  if (named.length === 1) return named[0];
  if (named.length > 1) fail(`${named.length} custom animation styles are named ${JSON.stringify(styleId)}: pass one's id (${named.map((s) => s.id).join(", ")})`);
  return fail(`No custom animation style ${JSON.stringify(styleId)}: figma.getLocalCustomAnimationStylesAsync() lists them`);
}

/** A custom style read back by id (null once it is gone). */
export function customAnimationStyle(ed: EditorController, styleId: string): PublicCustomStyle | null {
  const s = customStyles(ed).find((x) => x.id === styleId);
  return s ? publicCustom(s) : null;
}

/** `figma.createCustomAnimationStyle()`: a new, empty local style. */
export function createCustomAnimationStyle(ed: EditorController, name = "Animation style"): PublicCustomStyle {
  const id = createCustomStyle(ed, null, name);
  if (!id) return fail("The custom animation style couldn't be made: Motion isn't available in this build");
  return customAnimationStyle(ed, id)!;
}

/** `style.name = …`: slash-delimited names make folders. */
export function renameCustomAnimationStyle(ed: EditorController, styleId: string, name: unknown): void {
  const style = customStyleOf(ed, styleId);
  if (typeof name !== "string" || !name.trim()) fail("name: a non-empty string");
  if (ed.engine.setProps([style.id as Guid], { name: String(name) }) !== 0) fail(`The custom animation style ${style.id} couldn't be renamed`);
}

/**
 * `style.addAnimationEntryAsync(definitionStyleId, props)`: a first-party definition appended — `props` its settings
 * with Delay (its place in the style), Duration and Easing among them (seconds) — and the layers the style is applied
 * to take the new content. Returns the entry.
 */
export function addAnimationEntry(ed: EditorController, styleId: string, definition: unknown, props: unknown): PublicAnimationEntry {
  const style = customStyleOf(ed, styleId);
  const entry = entryTemplate(ed, definition, props, "props.");
  if (!setCustomStyleTemplates(ed, style.id, [...style.templates, entry])) fail(`${entry.name} couldn't be added to ${style.name}`);
  return publicEntry(customStyleOf(ed, style.id).templates.at(-1)!);
}

/** A style's whole content at once, in order (the agents' save_animation_style `entries`); its layers follow. */
export function setAnimationEntries(ed: EditorController, styleId: string, entries: { definition: unknown; props: unknown }[]): void {
  const style = customStyleOf(ed, styleId);
  const templates = entries.map((e, i) => entryTemplate(ed, e.definition, e.props, `entries[${i}].props.`));
  if (!setCustomStyleTemplates(ed, style.id, templates)) fail(`${style.name}'s entries couldn't be written`);
}

/** An entry as the style keeps it: the definition, its props, Delay as its place, Duration, Easing (a value). */
function entryTemplate(ed: EditorController, definition: unknown, props: unknown, at: string): Omit<StyleTemplate, "id"> {
  if (customStyles(ed).some((s) => s.id === definition)) fail("Custom styles do not nest: add a first-party definition's styleId (figma.motion.figmaAnimationStyles())");
  const def = presetOf(definition);
  const raw = (props && typeof props === "object" ? props : {}) as Record<string, unknown>;
  const t = timing(ed, { props: raw }, at);
  if (t.easingVariable) fail(`${at}easing: an entry's Easing is a value (variables bind on the layers' animations)`);
  return { preset: def.key, name: def.name, props: propsFromFigma(def, raw), offsetUs: t.startUs ?? 0, durationUs: t.durationUs ?? presetDurationUs(def), easing: t.easing ?? PRESET_EASING };
}

/** `style.removeAnimationEntry(entryId)`: the entry gone from the style and from the layers it is applied to. */
export function removeAnimationEntry(ed: EditorController, styleId: string, entryId: unknown): void {
  const style = customStyleOf(ed, styleId);
  if (!style.templates.some((t) => t.id === entryId)) fail(`${style.name} has no entry ${String(entryId)} (style.animationEntries lists them)`);
  if (!setCustomStyleTemplates(ed, style.id, style.templates.filter((t) => t.id !== entryId))) fail(`The entry ${String(entryId)} couldn't be removed`);
}

/** `style.remove()`: the style deleted; the layers it was applied to keep their animations. */
export function removeCustomAnimationStyle(ed: EditorController, styleId: string): void {
  deleteCustomStyle(ed, customStyleOf(ed, styleId).id);
}

/**
 * A custom style applied to a layer at `timelineOffset` (seconds) — or, with `binding`, that binding applied again in
 * place (a new style or start, its id kept). Figma's input is strict: no duration or props on a custom style.
 */
function applyCustomBinding(ed: EditorController, id: Guid, styleId: unknown, config: StyleConfig, binding?: string): string {
  if (config.duration !== undefined || config.props !== undefined) fail("{type: \"CUSTOM\"} takes only timelineOffset: a custom style carries its own timing and props");
  const style = customStyleOf(ed, styleId);
  animatable(ed, id);
  if (!style.templates.length) fail(`The custom animation style ${style.name} has no entries: add some with style.addAnimationEntryAsync()`);
  const offset = config.timelineOffset ?? 0;
  if (!finite(offset) || offset < 0) fail("timelineOffset: seconds, 0 or more");
  const target = targetOf(ed, id);
  for (const t of style.templates) if (!presetAllowed(presetDef(t.preset)!, [target])) fail(`${style.name} has ${t.name}, which ${presetDef(t.preset)!.needs === "text" ? "animates text layers only" : "needs a layer with strokes"}`);
  const before = new Set(clipsOf(ed, id).map((c) => c.style?.id).filter(Boolean));
  if (!applyCustomStyle(ed, style, [id], target, micros(offset), binding)) fail(`${style.name} couldn't be applied to ${id}`);
  return binding ?? clipsOf(ed, id).find((c) => c.style?.key === style.id && !before.has(c.style.id))?.style?.id ?? fail(`${style.name} couldn't be applied to ${id}`);
}
