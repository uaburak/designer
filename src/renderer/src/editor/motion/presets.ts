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
 */
import { ANIMATION_PRESETS, ANIMATION_STYLES, TIMING_PROP_KEYS, type GuidString, type Micros, type MotionEasing, type PresetDef, type PresetKey, type PresetOutput, type PresetPropValue, type StylePresetRun, type TimelineClip } from "@shared/motion/types";
import { presetProps, runPreset } from "@shared/motion/presets";
import type { EditorController } from "../controller";
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

/** Add animation (the + menu): the preset at its defaults on the layers, starting at the playhead. Returns the clips made. */
export function addPreset(ed: EditorController, key: PresetKey, nodes: GuidString[], target?: PresetTarget): GuidString[] {
  const def = presetDef(key);
  if (!def || !nodes.length) return [];
  const durationUs = Math.round(Number(def.props.find((p) => p.key === "duration")?.default ?? 0.5) * 1e6);
  const props = presetProps(key);
  try {
    const r = ed.engine.runMotionCommandCreating("MOTION_ADD_ANIMATION", {
      nodes,
      preset: key,
      name: def.name,
      props: storedProps(props),
      startUs: motionUi(ed).timeUs,
      durationUs,
      easing: PRESET_EASING,
      output: presetOutput(key, props, durationUs, PRESET_EASING, target),
    });
    return r.status === 0 ? [...r.created] : [];
  } catch {
    return [];
  }
}

/** A clip's settings changed: Delay (its start), Duration, Easing, its type or props (the code run again). */
export function editPreset(
  ed: EditorController,
  clip: TimelineClip,
  patch: { preset?: PresetKey; props?: Record<string, PresetPropValue>; startUs?: Micros; durationUs?: Micros; easing?: MotionEasing; disabled?: boolean },
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
  };
  return run(() => ed.engine.runMotionCommand("MOTION_SET_ANIMATION", args));
}

export function removePresets(ed: EditorController, ids: GuidString[]): boolean {
  return ids.length > 0 && run(() => ed.engine.runMotionCommand("MOTION_REMOVE_ANIMATIONS", { ids }));
}

/** Apply animation style: its presets at their defaults (and the style's own props), each at its offset from the playhead. */
export function applyStyle(ed: EditorController, styleKey: string, nodes: GuidString[], target?: PresetTarget): boolean {
  const style = ANIMATION_STYLES.find((s) => s.key === styleKey);
  if (!style || !nodes.length) return false;
  const presets: StylePresetRun[] = style.presets.map((p) => {
    const def = presetDef(p.preset);
    const props = presetProps(p.preset, p.props);
    const durationUs = Math.round(Number(def?.props.find((d) => d.key === "duration")?.default ?? 0.5) * 1e6);
    return { preset: p.preset, name: def?.name ?? p.preset, props: storedProps(props), offsetUs: p.offsetMs * 1000, durationUs, easing: PRESET_EASING, output: presetOutput(p.preset, props, durationUs, PRESET_EASING, target) };
  });
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { nodes, style: style.key, startUs: motionUi(ed).timeUs, presets }));
}

/** Detach animation style: the style's entry forgotten, its presets kept as they are. */
export function detachStyle(ed: EditorController, binding: GuidString): boolean {
  return run(() => ed.engine.runMotionCommand("MOTION_APPLY_STYLE", { detach: binding }));
}
