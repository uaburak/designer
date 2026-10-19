/**
 * Animation presets and composite styles from the chrome (docs/motion.md §4.6, §6.5; round 8h): the preset's code run
 * (the `figma:motion` runtime, @shared/motion/presets) and its output handed to the engine in the same command, so
 * each user action is one undo step — Add animation (MOTION_ADD_ANIMATION), a setting changed (MOTION_SET_ANIMATION
 * with the output run again), Remove animation, Apply animation style (the style expanded here into its presets), and
 * Detach animation style.
 *
 * A preset's props are the clip's `componentPropAssignments`, keyed by defID: `propId` names each prop (sessionID 0,
 * an FNV-1a hash of its key), so the engine stores them without knowing any preset. Delay, Duration and Easing are the
 * clip's own start, length and easing.
 *
 * Round 8i: custom (user) animation styles — a STYLE node of type ANIMATION whose content (`styleAnimations`) is
 * template clips — made from a layer's clips ("Create animation style"), updated from one, applied like Figma's own
 * (their templates' code run for the layer, in one step), deleted (DELETE_STYLE: the layers keep their clips). Round
 * 8j: an update reaches the layers the style is applied to (the new content's runs go with the command), and the
 * Plugin API writes a style's content as templates (entries added and removed).
 */
import { ANIMATION_PRESETS, ANIMATION_STYLES, TIMING_PROP_KEYS, type GuidString, type Micros, type MotionEasing, type PresetDef, type PresetKey, type PresetOutput, type PresetPropValue, type PresetVariables, type StylePresetRun, type TimelineClip } from "@shared/motion/types";
import { presetProps, runPreset } from "@shared/motion/presets";
import { easingFromData, type EasingData } from "@shared/motion/easing";
import type { EditorController } from "../controller";
import { guidStr, type GuidValue } from "../model/components";
import { deleteStyle, internalCanvasOf } from "../variables";
import { motionUi } from "./motionState";

/** Figma's shared defaults: Duration 0.5 s, Easing Ease out (OUT_CUBIC). */
export const PRESET_DURATION_US: Micros = 500_000;
export const PRESET_EASING: MotionEasing = { type: "EASE_OUT" };

export const presetDef = (key: PresetKey): PresetDef | undefined => ANIMATION_PRESETS.find((p) => p.key === key);

/** A prop's defID on the clip: "0:<FNV-1a 32 of its key>". */
export function propId(key: string): GuidString {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0:${h >>> 0}`;
}

/** The props as the clip stores them (by defID), Delay, Duration and Easing left out. */
export function storedProps(props: Record<string, PresetPropValue>): Record<string, PresetPropValue> {
  const out: Record<string, PresetPropValue> = {};
  for (const [k, v] of Object.entries(props)) if (!TIMING_PROP_KEYS.includes(k) && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) out[propId(k)] = v;
  return out;
}

/** A clip's props by key, its preset's defaults where it stores none. */
export function clipProps(clip: Pick<TimelineClip, "preset" | "props">): Record<string, PresetPropValue> {
  const raw: Record<string, PresetPropValue> = {};
  for (const d of presetDef(clip.preset)?.props ?? []) {
    const v = clip.props[propId(d.key)];
    if (v !== undefined) raw[d.key] = v;
  }
  return presetProps(clip.preset, raw);
}

/** What a preset's code knows of the layer it animates. */
export interface PresetTarget {
  type: string;
  strokes: boolean;
}

/** The preset's code run for a clip's settings. */
export function presetOutput(key: PresetKey, props: Record<string, PresetPropValue>, durationUs: Micros, easing: MotionEasing, target: PresetTarget = { type: "FRAME", strokes: false }): PresetOutput {
  return runPreset(key, { props, duration: durationUs / 1e6, easing, node: target });
}

/** Whether a preset may go on these layers (Path needs strokes, Text and Text stagger text layers). */
export function presetAllowed(def: PresetDef, targets: readonly PresetTarget[]): boolean {
  if (!targets.length) return false;
  if (def.needs === "text") return targets.every((n) => n.type === "TEXT");
  if (def.needs === "strokes") return targets.every((n) => n.strokes);
  return true;
}

const run = (fn: () => number): boolean => {
  try {
    return fn() === 0;
  } catch {
    return false; // the loaded wasm predates the Motion commands
  }
};

/** What Add animation may set besides the preset's defaults (the plugin API's and the agents' applyAnimationStyle, round 8f). */
export interface PresetSettings {
  props?: Record<string, PresetPropValue>;
  startUs?: Micros;
  durationUs?: Micros;
  easing?: MotionEasing;
}

/** The preset's default Duration. */
export const presetDurationUs = (def: PresetDef): Micros => Math.round(Number(def.props.find((p) => p.key === "duration")?.default ?? 0.5) * 1e6);

/**
 * Add animation (the + menu): the preset at its defaults on the layers, starting at the playhead — or with `settings`'
 * start, length, easing and props. Returns the clips made.
 */
export function addPreset(ed: EditorController, key: PresetKey, nodes: GuidString[], target?: PresetTarget, settings: PresetSettings = {}): GuidString[] {
  const def = presetDef(key);
  if (!def || !nodes.length) return [];
  const durationUs = Math.max(1, Math.round(settings.durationUs ?? presetDurationUs(def)));
  const easing = settings.easing ?? PRESET_EASING;
  const props = presetProps(key, settings.props);
  try {
    const r = ed.engine.runMotionCommandCreating("MOTION_ADD_ANIMATION", {
      nodes,
      preset: key,
      name: def.name,
      props: storedProps(props),
      startUs: Math.max(0, Math.round(settings.startUs ?? motionUi(ed).timeUs)),
      durationUs,
      easing,
      output: presetOutput(key, props, durationUs, easing, target),
    });
    return r.status === 0 ? [...r.created] : [];
  } catch {
    return [];
  }
}

/**
 * A clip's settings changed: Delay (its start), Duration, Easing, its type or props (the code run again); round 8i:
 * Delay / Duration / Easing bound to TIMING / EASING variables (`variables`, null unbinds).
 */
export function editPreset(
  ed: EditorController,
  clip: TimelineClip,
  patch: { preset?: PresetKey; props?: Record<string, PresetPropValue>; startUs?: Micros; durationUs?: Micros; easing?: MotionEasing; disabled?: boolean; variables?: { [K in keyof PresetVariables]?: GuidString | null } },
  target?: PresetTarget
): boolean {
  const key = patch.preset ?? clip.preset;
  const retype = patch.preset !== undefined && patch.preset !== clip.preset;
  // A new type starts from its own defaults; new props merge over the clip's.
  const props = retype ? presetProps(key, patch.props) : patch.props ? { ...clipProps(clip), ...patch.props } : undefined;
  const easing = patch.easing ?? ("type" in clip.easing ? clip.easing : PRESET_EASING);
  const durationUs = patch.durationUs ?? clip.durationUs;
  const args = {
    id: clip.id,
    ...(retype ? { preset: key, name: presetDef(key)?.name ?? key } : {}),
    ...(props ? { props: storedProps(props), output: presetOutput(key, props, durationUs, easing, target) } : {}),
    ...(patch.startUs !== undefined ? { startUs: Math.max(0, Math.round(patch.startUs)) } : {}),
    ...(patch.durationUs !== undefined ? { durationUs: Math.max(1, Math.round(patch.durationUs)) } : {}),
    ...(patch.easing ? { easing: patch.easing } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    ...(patch.variables ? { variables: patch.variables } : {}),
  };
  return run(() => ed.engine.runMotionCommand("MOTION_SET_ANIMATION", args));
}

export function removePresets(ed: EditorController, ids: GuidString[]): boolean {
  return ids.length > 0 && run(() => ed.engine.runMotionCommand("MOTION_REMOVE_ANIMATIONS", { ids }));
}

/** Apply animation style: its presets at their defaults (and the style's own props), each at its offset from the playhead (or `startUs`); a custom style's templates as they are. */
export function applyStyle(ed: EditorController, styleKey: string, nodes: GuidString[], target?: PresetTarget, startUs?: Micros): boolean {
  const custom = customStyles(ed).find((s) => s.id === styleKey);
  if (custom) return applyCustomStyle(ed, custom, nodes, target, startUs);
  const style = ANIMATION_STYLES.find((s) => s.key === styleKey);
  if (!style || !nodes.length) return false;
  const presets: StylePresetRun[] = style.presets.map((p) => {
    const def = presetDef(p.preset);
    const props = presetProps(p.preset, p.props);
    const durationUs = def ? presetDurationUs(def) : PRESET_DURATION_US;
    return { preset: p.preset, name: def?.name ?? p.preset, props: storedProps(props), offsetUs: p.offsetMs * 1000, durationUs, easing: PRESET_EASING, output: presetOutput(p.preset, props, durationUs, PRESET_EASING, target) };
  });
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { nodes, style: style.key, startUs: Math.max(0, Math.round(startUs ?? motionUi(ed).timeUs)), presets }));
}

/** How long a style plays from its start (µs): its last preset's end — a composite style's at their defaults, a custom one's templates. */
export function styleSpanUs(ed: EditorController, styleKey: string): Micros {
  const custom = customStyles(ed).find((s) => s.id === styleKey);
  if (custom) return Math.max(0, ...custom.templates.map((t) => t.offsetUs + t.durationUs));
  const style = ANIMATION_STYLES.find((s) => s.key === styleKey);
  return Math.max(0, ...(style?.presets ?? []).map((p) => p.offsetMs * 1000 + presetDurationUs(presetDef(p.preset)!)));
}

/** Detach animation style: the style's entry forgotten, its presets kept as they are. */
export function detachStyle(ed: EditorController, binding: GuidString): boolean {
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { detach: binding }));
}

// ---- Custom animation styles (round 8i) ------------------------------------------------------------------------------

/** A custom style's template clip: its preset, props (by key), place from the style's start, length and easing. */
export interface StyleTemplate {
  /** The template's node (the Plugin API's entry id) */
  id: GuidString;
  preset: PresetKey;
  name: string;
  props: Record<string, PresetPropValue>;
  offsetUs: Micros;
  durationUs: Micros;
  easing: MotionEasing;
}

export interface CustomStyle {
  id: GuidString;
  name: string;
  templates: StyleTemplate[];
}

type StoredNode = {
  guid: GuidString;
  name?: string;
  styleType?: string;
  isSoftDeleted?: boolean;
  childIds?: GuidString[];
  backingAnimationPresetId?: { assetRef?: { key?: string } };
  timelineOffset?: number;
  timelineDuration?: number;
  easingData?: EasingData;
  componentPropAssignments?: { defID?: GuidValue; value?: { floatValue?: number; boolValue?: boolean; textValue?: { characters?: string } } }[];
};

/** A template clip's props by key (its preset's defIDs read back). */
function templateProps(key: PresetKey, list: StoredNode["componentPropAssignments"]): Record<string, PresetPropValue> {
  const byId = new Map((list ?? []).map((a) => [guidStr(a.defID), a.value]));
  const out: Record<string, PresetPropValue> = {};
  for (const d of presetDef(key)?.props ?? []) {
    const v = byId.get(propId(d.key));
    if (!v) continue;
    if (typeof v.floatValue === "number") out[d.key] = v.floatValue;
    else if (typeof v.boolValue === "boolean") out[d.key] = v.boolValue;
    else if (v.textValue?.characters !== undefined) out[d.key] = v.textValue.characters;
  }
  return out;
}

/** The file's custom animation styles (STYLE nodes of type ANIMATION on the internal canvas) with their templates. */
export function customStyles(ed: EditorController): CustomStyle[] {
  try {
    const internal = internalCanvasOf(ed);
    if (!internal || ed.engine.destroyed) return [];
    const kids = (ed.engine.readNodes([internal], { childIds: true })[0] as unknown as StoredNode | undefined)?.childIds ?? [];
    const nodes = (kids.length ? ed.engine.readNodes(kids, { fields: ["name", "styleType", "isSoftDeleted"] }) : []) as unknown as StoredNode[];
    return nodes
      .filter((n) => n.styleType === "ANIMATION" && !n.isSoftDeleted)
      .map((n) => {
        const ids = (ed.engine.readNodes([n.guid], { childIds: true })[0] as unknown as StoredNode | undefined)?.childIds ?? [];
        const templates = (ids.length ? (ed.engine.readNodes(ids) as unknown as StoredNode[]) : []).flatMap((c): StyleTemplate[] => {
          const key = c.backingAnimationPresetId?.assetRef?.key as PresetKey | undefined;
          if (!key || !presetDef(key)) return [];
          return [{ id: c.guid, preset: key, name: c.name ?? presetDef(key)!.name, props: templateProps(key, c.componentPropAssignments), offsetUs: c.timelineOffset ?? 0, durationUs: c.timelineDuration ?? PRESET_DURATION_US, easing: c.easingData ? easingFromData(c.easingData) : PRESET_EASING }];
        });
        return { id: n.guid, name: n.name ?? "", templates };
      });
  } catch {
    return [];
  }
}

/**
 * Templates as the runs MOTION_APPLY_STYLE takes: each one's code run (the preset code reads only its settings, so one
 * output serves every layer), its place from the style's start.
 */
export function templateRuns(templates: readonly Omit<StyleTemplate, "id">[], target?: PresetTarget): StylePresetRun[] {
  return templates.map((p) => {
    const props = presetProps(p.preset, p.props);
    return { preset: p.preset, name: p.name, props: storedProps(props), offsetUs: p.offsetUs, durationUs: p.durationUs, easing: p.easing, output: presetOutput(p.preset, props, p.durationUs, p.easing, target) };
  });
}

/** A layer's clips as a style's templates, timed from the earliest one (as the engine makes them from `from`). */
export function clipTemplates(clips: readonly TimelineClip[]): Omit<StyleTemplate, "id">[] {
  const earliest = Math.min(...clips.map((c) => c.startUs));
  return clips.map((c) => ({ preset: c.preset, name: c.name, props: clipProps(c), offsetUs: c.startUs - earliest, durationUs: c.durationUs, easing: "type" in c.easing ? c.easing : PRESET_EASING }));
}

/**
 * A custom style on the layers: its templates' code run for the layer, each at its place from the playhead (or
 * `startUs`); with `binding` (round 8j), that entry of the one layer applied again in place (its id kept).
 */
export function applyCustomStyle(ed: EditorController, style: CustomStyle, nodes: GuidString[], target?: PresetTarget, startUs?: Micros, binding?: GuidString): boolean {
  if (!style.templates.length || !nodes.length) return false;
  const presets = templateRuns(style.templates, target);
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { nodes, style: style.id, startUs: Math.max(0, Math.round(startUs ?? motionUi(ed).timeUs)), presets, ...(binding ? { binding } : {}) }));
}

/** "Create animation style": a new custom style from the layer's clips (their timing from the earliest one); without `from`, an empty one (the Plugin API's createCustomAnimationStyle). */
export function createCustomStyle(ed: EditorController, from: GuidString | null, name: string): GuidString | null {
  try {
    const r = ed.engine.runMotionCommandCreating("MOTION_APPLY_STYLE", { create: from ? { name, from } : { name, templates: [] } });
    return r.status === 0 ? (r.created[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * "Update animation style": the custom style's templates replaced by the layer's clips (`clips`, the layer's as the
 * timeline shows them); round 8j: the layers the style was applied to take the new content in the same step.
 */
export function updateCustomStyle(ed: EditorController, style: GuidString, from: GuidString, clips: readonly TimelineClip[]): boolean {
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { create: { from, style, presets: templateRuns(clipTemplates(clips)) } }));
}

/**
 * A custom style's content written as `templates` (the Plugin API's entries added or removed), reaching its layers
 * too; a template with its `id` is kept as it is (entries keep their ids).
 */
export function setCustomStyleTemplates(ed: EditorController, style: GuidString, templates: readonly (Omit<StyleTemplate, "id"> & { id?: GuidString })[]): boolean {
  const runs = templateRuns(templates);
  const kept = runs.map((r, i) => (templates[i].id ? { ...r, id: templates[i].id } : r));
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { create: { style, templates: kept, presets: runs } }));
}

/** "Delete style": the style goes; the layers it was applied to keep their clips. */
export function deleteCustomStyle(ed: EditorController, style: GuidString): void {
  deleteStyle(ed, style);
}

