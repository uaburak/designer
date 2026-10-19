/**
 * Our `figma:motion` runtime (docs/motion.md §3.6, §4.6; round 8h): what an animation preset's code is written against
 * — Figma's module names (`tween`, `animate`, `defineProperties`, `EasingType`) and its output's shape (an
 * AnimationPreset: keyframe tracks, each with its field and operation, keyframes in µs from the clip's start). The
 * output is materialised by MOTION_ADD_ANIMATION / MOTION_SET_PRESET_TRACKS as KEYFRAME_TRACK nodes the layer's fields
 * bind through ANIMATION_PRESET parameters; the engine knows no preset. The first-party presets (./presets) are our
 * own code against it; custom presets later run the same module in the plugin sandbox.
 *
 * Values are in public units (§4.5: opacity 0–1, rotation in degrees counter-clockwise, px); a SCALE track's are
 * multipliers. Times at the module's surface are seconds, as Figma's props are.
 */
import type { KeyframeField, KeyframePropertyFieldName, KeyframeValue, Micros, MotionEasing, MotionEasingType, PresetOutput, PresetPropDef, PresetPropValue, PresetTrackOutput } from "./types";

export type KeyframeOperation = PresetTrackOutput["operation"];

/** Figma's EasingType names as the module exports them (the public MotionEasing types). */
export const EasingType: { readonly [K in MotionEasingType]: K } = {
  HOLD: "HOLD", LINEAR: "LINEAR", EASE_IN: "EASE_IN", EASE_OUT: "EASE_OUT", EASE_IN_AND_OUT: "EASE_IN_AND_OUT",
  EASE_IN_BACK: "EASE_IN_BACK", EASE_OUT_BACK: "EASE_OUT_BACK", EASE_IN_AND_OUT_BACK: "EASE_IN_AND_OUT_BACK",
  GENTLE: "GENTLE", QUICK: "QUICK", BOUNCY: "BOUNCY", SLOW: "SLOW", CUSTOM_CUBIC_BEZIER: "CUSTOM_CUBIC_BEZIER", CUSTOM_SPRING: "CUSTOM_SPRING",
};

/** A tweened value: a number (FLOAT, or uniform on an XY field) or a point (VECTOR). */
export type TweenValue = number | { x: number; y: number };

export interface TweenOptions {
  mode: KeyframeOperation;
  /** Seconds from the clip's start (0) */
  timelinePosition?: number;
  /** Seconds; negative throws */
  duration: number;
  from: TweenValue;
  to: TweenValue;
  easing?: MotionEasing;
  enabled?: boolean;
}

/** A track without its field: what `tween` returns and `animate` places. */
export type Tween = Omit<PresetTrackOutput, "field">;

const valueOf = (v: TweenValue): KeyframeValue => (typeof v === "number" ? { type: "FLOAT", value: v } : { type: "VECTOR", value: { x: v.x, y: v.y } });
const us = (s: number): Micros => Math.round(s * 1e6);

/** Figma's tween: exactly two keyframes at [position, position + duration], both carrying the easing. */
export function tween({ mode, timelinePosition = 0, duration, from, to, easing, enabled = true }: TweenOptions): Tween {
  if (!(duration >= 0)) throw new Error("tween: duration must not be negative");
  const at = us(timelinePosition);
  return {
    operation: mode,
    enabled,
    keyframes: [
      { timeUs: at, value: valueOf(from), ...(easing ? { easing } : {}) },
      { timeUs: at + us(duration), value: valueOf(to), ...(easing ? { easing } : {}) },
    ],
  };
}

/** Collapses keyframes at the same µs position to the last one, in time order (Figma's upsert, docs/motion.md §4.2). */
export function collapsePositions(keys: PresetTrackOutput["keyframes"]): PresetTrackOutput["keyframes"] {
  const at = new Map<Micros, PresetTrackOutput["keyframes"][number]>();
  for (const k of keys) at.set(k.timeUs, k);
  return [...at.values()].sort((a, b) => a.timeUs - b.timeUs);
}

/** A track of a field: a public field name or a KeyframeField, played by one or more tweens (their keyframes merged). */
export function animate(field: KeyframePropertyFieldName | KeyframeField, ...tweens: Tween[]): PresetTrackOutput {
  const f: KeyframeField = typeof field === "string" ? { type: "PROPERTY", name: field } : field;
  if (!tweens.length) return { field: f, operation: "SET", keyframes: [] };
  return {
    field: f,
    operation: tweens[0].operation,
    keyframes: collapsePositions(tweens.flatMap((t) => t.keyframes)),
    ...(tweens.every((t) => t.enabled === false) ? { enabled: false } : {}),
  };
}

/** A preset's props, declared (Figma's defineProperties): returned as they are, typed. */
export function defineProperties<T extends readonly PresetPropDef[]>(defs: T): T {
  return defs;
}

/** What a preset's code is given: its props (defaults filled), its clip's length and easing, and what it animates. */
export interface PresetContext {
  props: Record<string, PresetPropValue>;
  /** Seconds */
  duration: number;
  easing: MotionEasing;
  node: { type: string; strokes: boolean };
}

export type PresetCode = (ctx: PresetContext) => PresetOutput;
