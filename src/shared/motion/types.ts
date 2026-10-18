/**
 * Figma Motion (docs/motion.md) — the types the engine bindings, the Motion chrome, export, Dev Mode and the plugin
 * API share. Document shapes (KeyframeValueData, TimelineData, EasingData…) are the generated ones in
 * src/shared/schema/document.generated.ts; these are the shapes around them. Times are µs inside, seconds at the
 * plugin API, ms in the UI. [unverified] defaults are ours.
 */

/** A GUID as the engine bindings print it: "sessionID:localID". */
export type GuidString = string;
/** Microseconds (an integer). */
export type Micros = number;

export const DEFAULT_DURATION_US: Micros = 2_000_000; // help.figma.com 41405906446999 (probe 5.1)
export const DEFAULT_SNAPPING_FPS = 60; // Figma's frames-mode default (timeline settings, §6.2)

// ---- Fields ----------------------------------------------------------------------------------------------------

/** Figma's public keyframe fields (developers.figma.com Motion `KeyframePropertyFieldName`). */
export const KEYFRAME_PROPERTY_FIELDS = [
  "CORNER_RADIUS", "STROKE_WEIGHT", "STACK_SPACING", "STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT",
  "STACK_PADDING_BOTTOM", "WIDTH", "HEIGHT", "RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
  "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "BORDER_TOP_WEIGHT", "BORDER_BOTTOM_WEIGHT",
  "BORDER_LEFT_WEIGHT", "BORDER_RIGHT_WEIGHT", "STACK_COUNTER_SPACING", "OPACITY", "GRID_ROW_GAP", "GRID_COLUMN_GAP",
  "TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY", "ROTATION", "SCALE_X", "SCALE_Y", "SCALE_XY",
  "PATH_TRIM_START", "PATH_TRIM_END",
] as const;
export type KeyframePropertyFieldName = (typeof KEYFRAME_PROPERTY_FIELDS)[number];

/** Figma's effect keyframe fields (`EffectKeyframeFieldName`). */
export const EFFECT_KEYFRAME_FIELDS = [
  "OFFSET_X", "OFFSET_Y", "RADIUS", "SPREAD", "COLOR", "REFRACTION_RADIUS", "SPECULAR_ANGLE", "SPECULAR_INTENSITY",
  "CHROMATIC_ABERRATION", "SPLAY", "REFRACTION_INTENSITY", "START_RADIUS", "NOISE_SIZE_X", "NOISE_SIZE_Y", "DENSITY",
  "EFFECT_OPACITY", "SECONDARY_COLOR",
] as const;
export type EffectKeyframeFieldName = (typeof EFFECT_KEYFRAME_FIELDS)[number];

/** Figma's `KeyframeField` (plugin API). Paint fields without `propertyId` are the SOLID colour; `opacity: true` is ours (the paint's opacity). */
export type KeyframeField =
  | { type: "PROPERTY"; name: KeyframePropertyFieldName }
  | { type: "INDEXED_ITEM"; collection: "fills" | "strokes"; index: number; propertyId?: string; opacity?: boolean }
  | { type: "INDEXED_ITEM"; collection: "effects"; index: number; field?: EffectKeyframeFieldName; propertyId?: string };

export type KeyframeValueTypeName = "FLOAT" | "COLOR" | "TEXT_DATA" | "VECTOR" | "BOOL" | "CIRCLE" | "LINE" | "CIRCLE_POINT" | "COLOR_POINT";

export interface FieldInfo {
  /** The schema's VariableField number (docs/motion.md §4.5) */
  variableField: number;
  value: KeyframeValueTypeName;
  /** Stored ↔ node units (Figma's): "x100" (OPACITY, normalised effect fields), "-rad" (ROTATION: node degrees CCW+ ↔ stored −radians); absent = as is */
  stored?: "x100" | "-rad";
  /** Figma's write clamp, in node units */
  clamp?: [number, number];
  kind: "absolute" | "additive" | "multiplicative";
  /** Changes layout: the motion layer re-lays out the node */
  layout?: boolean;
  /** The UI's row name in the timeline [unverified] */
  label: string;
}

/** The single table of keyframable node fields (C++ engine/src/motion/Fields.h mirrors it; a test compares). */
export const KEYFRAME_FIELDS: Record<KeyframePropertyFieldName, FieldInfo> = {
  OPACITY: { variableField: 31, value: "FLOAT", kind: "absolute", stored: "x100", clamp: [0, 1], label: "Opacity" },
  CORNER_RADIUS: { variableField: 1, value: "FLOAT", kind: "absolute", label: "Corner radius" },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { variableField: 14, value: "FLOAT", kind: "absolute", label: "Top left radius" },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { variableField: 15, value: "FLOAT", kind: "absolute", label: "Top right radius" },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { variableField: 16, value: "FLOAT", kind: "absolute", label: "Bottom left radius" },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { variableField: 17, value: "FLOAT", kind: "absolute", label: "Bottom right radius" },
  STROKE_WEIGHT: { variableField: 4, value: "FLOAT", kind: "absolute", label: "Stroke weight" },
  BORDER_TOP_WEIGHT: { variableField: 18, value: "FLOAT", kind: "absolute", label: "Top stroke" },
  BORDER_BOTTOM_WEIGHT: { variableField: 19, value: "FLOAT", kind: "absolute", label: "Bottom stroke" },
  BORDER_LEFT_WEIGHT: { variableField: 20, value: "FLOAT", kind: "absolute", label: "Left stroke" },
  BORDER_RIGHT_WEIGHT: { variableField: 21, value: "FLOAT", kind: "absolute", label: "Right stroke" },
  STACK_SPACING: { variableField: 5, value: "FLOAT", kind: "absolute", layout: true, label: "Gap" },
  STACK_COUNTER_SPACING: { variableField: 23, value: "FLOAT", kind: "absolute", layout: true, label: "Row gap" },
  STACK_PADDING_LEFT: { variableField: 6, value: "FLOAT", kind: "absolute", layout: true, label: "Left padding" },
  STACK_PADDING_TOP: { variableField: 7, value: "FLOAT", kind: "absolute", layout: true, label: "Top padding" },
  STACK_PADDING_RIGHT: { variableField: 8, value: "FLOAT", kind: "absolute", layout: true, label: "Right padding" },
  STACK_PADDING_BOTTOM: { variableField: 9, value: "FLOAT", kind: "absolute", layout: true, label: "Bottom padding" },
  GRID_ROW_GAP: { variableField: 41, value: "FLOAT", kind: "absolute", layout: true, label: "Row gap" },
  GRID_COLUMN_GAP: { variableField: 42, value: "FLOAT", kind: "absolute", layout: true, label: "Column gap" },
  WIDTH: { variableField: 12, value: "FLOAT", kind: "absolute", layout: true, label: "Width" },
  HEIGHT: { variableField: 13, value: "FLOAT", kind: "absolute", layout: true, label: "Height" },
  TRANSLATION_X: { variableField: 46, value: "FLOAT", kind: "additive", label: "Position X" },
  TRANSLATION_Y: { variableField: 47, value: "FLOAT", kind: "additive", label: "Position Y" },
  TRANSLATION_XY: { variableField: 69, value: "VECTOR", kind: "additive", label: "Position" },
  ROTATION: { variableField: 48, value: "FLOAT", kind: "additive", stored: "-rad", label: "Rotation" },
  SCALE_X: { variableField: 49, value: "FLOAT", kind: "multiplicative", label: "Scale X" },
  SCALE_Y: { variableField: 50, value: "FLOAT", kind: "multiplicative", label: "Scale Y" },
  SCALE_XY: { variableField: 70, value: "VECTOR", kind: "multiplicative", label: "Scale" },
  PATH_TRIM_START: { variableField: 54, value: "FLOAT", kind: "absolute", clamp: [0, 1], label: "Path trim start" },
  PATH_TRIM_END: { variableField: 55, value: "FLOAT", kind: "absolute", clamp: [0, 1], label: "Path trim end" },
};

// ---- Values and easing -----------------------------------------------------------------------------------------

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Figma's `KeyframeValue` (plugin API). */
export type KeyframeValue =
  | { type: "FLOAT"; value: number }
  | { type: "COLOR"; value: RGBA }
  | { type: "TEXT_DATA"; value: string }
  | { type: "VECTOR"; value: { x: number; y: number } }
  | { type: "BOOL"; value: boolean }
  | { type: "CIRCLE"; value: { x: number; y: number; radius: number } }
  | { type: "LINE"; value: { x: number; y: number; x2: number; y2: number } }
  | { type: "CIRCLE_POINT"; value: { x: number; y: number; radius: number; angle: number } }
  | { type: "COLOR_POINT"; value: { x: number; y: number; color: RGBA } };

/** Figma's public easing names (MotionEasing.type), in the Easing menu's order (Hold first, §6.3). */
export const MOTION_EASING_TYPES = [
  "HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK",
  "GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_CUBIC_BEZIER", "CUSTOM_SPRING",
] as const;
export type MotionEasingType = (typeof MOTION_EASING_TYPES)[number];

export interface MotionEasing {
  type: MotionEasingType;
  easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number };
  easingFunctionSpring?: { bounce: number };
}

/** An easing as stored: a value, or bound to an EASING variable. */
export type EasingRef = MotionEasing | { variable: GuidString };

/** The Easing menu's labels (help.figma.com 41414048690839). */
export const EASING_LABELS: Record<MotionEasingType, string> = {
  LINEAR: "Linear",
  EASE_IN: "Ease in",
  EASE_OUT: "Ease out",
  EASE_IN_AND_OUT: "Ease in and out",
  EASE_IN_BACK: "Ease in back",
  EASE_OUT_BACK: "Ease out back",
  EASE_IN_AND_OUT_BACK: "Ease in and out back",
  HOLD: "Hold",
  GENTLE: "Gentle",
  QUICK: "Quick",
  BOUNCY: "Bouncy",
  SLOW: "Slow",
  CUSTOM_CUBIC_BEZIER: "Custom bezier",
  CUSTOM_SPRING: "Custom spring",
};

/** Public name → the schema's EasingType. */
export const EASING_SCHEMA_TYPE: Record<MotionEasingType, string> = {
  LINEAR: "LINEAR",
  EASE_IN: "EASE_IN", // 15; IN_CUBIC (0) on a keyframe means "no easing" (§4.7)
  EASE_OUT: "OUT_CUBIC",
  EASE_IN_AND_OUT: "INOUT_CUBIC",
  EASE_IN_BACK: "IN_BACK_CUBIC",
  EASE_OUT_BACK: "OUT_BACK_CUBIC",
  EASE_IN_AND_OUT_BACK: "INOUT_BACK_CUBIC",
  HOLD: "HOLD",
  GENTLE: "GENTLE_SPRING",
  QUICK: "SPRING_PRESET_ONE",
  BOUNCY: "SPRING_PRESET_TWO",
  SLOW: "SPRING_PRESET_THREE",
  CUSTOM_CUBIC_BEZIER: "CUSTOM_CUBIC",
  CUSTOM_SPRING: "CUSTOM_SPRING",
};

/** The named bezier curves (Figma's easing table, engine/src/motion/Easing.h). */
export const BEZIER_PRESETS: Partial<Record<MotionEasingType, [number, number, number, number]>> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

/** The spring presets, stored physical (Figma's [mass, stiffness, damping]; the bounce shown is clamp(1 − ζ, 0, 1)). */
export const SPRING_PRESETS: Partial<Record<MotionEasingType, { mass: number; stiffness: number; damping: number }>> = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

/** A keyframe written without an easing (and an IN_CUBIC / missing one read): Figma's CUSTOM_CUBIC (0.5, 0, 0.5, 1). */
export const DEFAULT_KEYFRAME_EASING: MotionEasing = { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } };

/** figma.motion.physicalSpringToNormalized: bounce = clamp(1 − ζ, 0, 1), ζ = damping / (2·√(stiffness·mass)); positive finite values only. */
export function physicalSpringToNormalized(s: { mass: number; stiffness: number; damping: number }): number {
  if (![s.mass, s.stiffness, s.damping].every((x) => Number.isFinite(x) && x > 0)) throw new Error("physicalSpringToNormalized: mass, stiffness and damping must be positive numbers");
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  return Math.min(1, Math.max(0, 1 - zeta));
}

/** A bounce as a physical spring (Figma's): ζ = clamp(1 − bounce, 1e−4, 1), ω₀ and mass kept from `prev` when valid (else 10 rad/s, 1). */
export function normalizedToPhysicalSpring(bounce: number, prev?: { mass: number; stiffness: number; damping: number }): { mass: number; stiffness: number; damping: number } {
  const zeta = Math.min(1, Math.max(1e-4, 1 - bounce));
  const valid = !!prev && [prev.mass, prev.stiffness].every((x) => Number.isFinite(x) && x > 0);
  const mass = valid ? Math.min(100, Math.max(0.01, prev!.mass)) : 1;
  const w0 = valid ? Math.sqrt(prev!.stiffness / prev!.mass) : 10;
  const stiffness = w0 * w0 * mass;
  return { mass, stiffness, damping: 2 * zeta * Math.sqrt(stiffness * mass) };
}

// ---- Timeline ----------------------------------------------------------------------------------------------------

/** The UI's names; the schema's PlaybackStyle is LOOP / ONCE / BOOMERANG. The order is the Playback button's cycle. */
export type PlaybackName = "LOOP" | "ONCE" | "PING_PONG";
export const PLAYBACK_CYCLE: readonly PlaybackName[] = ["LOOP", "ONCE", "PING_PONG"];
export const PLAYBACK_LABELS: Record<PlaybackName, string> = { LOOP: "Loop", ONCE: "Once", PING_PONG: "Ping-pong" };

/** The timeline settings' units and snapping grids (Figma's, §6.2): FrameRate numerator / denominator. */
export type TimelineUnit = "ms" | "frames";
export const SNAPPING_GRIDS: Record<TimelineUnit, readonly [number, number][]> = {
  ms: [[10, 1], [20, 1], [100, 1]],
  frames: [[60, 1], [30, 1], [30000, 1001], [24, 1], [24000, 1001], [12, 1]],
};

/** engine.setMotion's argument (view state, never in the document). Omitted keys keep their value. */
export interface MotionViewState {
  on?: boolean;
  /** The timeline root shown; null: the root of the selection */
  root?: GuidString | null;
  timeUs?: Micros;
  autoKeyframe?: boolean;
  showMotionPath?: boolean;
  /** Round 8j: evaluate inside the open transaction (a style's canvas preview, cancelled after; cleared when it ends) */
  inTransaction?: boolean;
}

export interface TimelineKeyframe {
  id: GuidString;
  timeUs: Micros;
  value: KeyframeValue;
  /** The value bound to a variable */
  valueVariable?: GuidString;
  /** Easing into this keyframe (unused on the first); bound to a variable: the variable's value in the layer's modes */
  easing: EasingRef;
  /** The EASING variable it is bound to (round 8i) */
  easingVariable?: GuidString;
  /** A Position keyframe's motion path handles, relative to its value (MOTION_SET_PATH_HANDLES) */
  pathHandles?: { in: { x: number; y: number }; out: { x: number; y: number } };
}

export interface TimelineTrack {
  id: GuidString;
  field: KeyframeField;
  label: string;
  keyframes: TimelineKeyframe[];
}

export interface TimelineClip {
  /** The ANIMATION_PRESET_INSTANCE */
  id: GuidString;
  preset: PresetKey;
  name: string;
  startUs: Micros;
  durationUs: Micros;
  disabled: boolean;
  easing: EasingRef;
  /** Keyed by each prop's defID ("0:<hash>", src/renderer/src/editor/motion/presets.ts `propId`); Delay, Duration and Easing are the clip's own */
  props: Record<string, PresetPropValue>;
  /** The composite style that generated it, if any: its entry in the layer's `styleIdsForAnimation` and the style's key */
  style?: { id: GuidString; key: string };
  /** Delay / Duration bound to TIMING variables, Easing to an EASING one (round 8i): start, length and easing are their values */
  variables?: PresetVariables;
}

/** A clip's Delay, Duration and Easing bound to variables (round 8i; null in an edit unbinds). */
export interface PresetVariables {
  delay?: GuidString;
  duration?: GuidString;
  easing?: GuidString;
}

export interface TimelineLayer {
  node: GuidString;
  name: string;
  /** The Layers panel's icon name */
  icon: string;
  depth: number;
  /** An animated instance: one purple bar, moved by its offset only */
  instance?: { offsetUs: Micros; durationUs: Micros; mainTimeline: GuidString };
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /** First keyframe / clip start → last keyframe / clip end (the layer bar) */
  startUs: Micros;
  endUs: Micros;
}

export interface TimelineAudioClip {
  id: GuidString;
  trackId: GuidString;
  name: string;
  mediaHash: string;
  offsetUs: Micros;
  startUs: Micros;
  durationUs: Micros;
  volume: number;
  mute: boolean;
}

export interface TimelineModel {
  root: GuidString;
  rootName: string;
  timelineId: GuidString;
  durationUs: Micros;
  playback: PlaybackName;
  snappingFps: number;
  layers: TimelineLayer[];
  audioTracks: { id: GuidString; name: string; gain: number; mute: boolean }[];
  audio: TimelineAudioClip[];
}

/** engine.motionFieldStates: per node, per field key (fieldKey()), the right panel's diamond. */
export type DiamondState = "none" | "track" | "keyframe";
export type FieldStates = Record<GuidString, Record<string, { state: DiamondState; keyframe?: GuidString }>>;

/** A field's stable key: "OPACITY", "fills[0]", "fills[0].opacity", "fills[0]#<propertyId>", "effects[1].RADIUS". */
export function fieldKey(f: KeyframeField): string {
  if (f.type === "PROPERTY") return f.name;
  const base = `${f.collection}[${f.index}]`;
  if (f.propertyId) return `${base}#${f.propertyId}`;
  if ("field" in f && f.field) return `${base}.${f.field}`;
  if ("opacity" in f && f.opacity) return `${base}.opacity`;
  return base;
}

// ---- Presets and styles ------------------------------------------------------------------------------------------

/** Figma's active first-party presets (§4.6); Fade, Move, Rotate, Resize, Path Draw and Path Travel are deprecated there. */
export type PresetKey = "new" | "opacity" | "position" | "scale" | "rotation" | "size" | "cornerRadius" | "path" | "text" | "textStagger";
export type PresetPropValue = number | boolean | string | MotionEasing | { variable: GuidString };

/** A preset's prop as Figma's propDefs carry it ({name, type NUMBER | TEXT | BOOL | EASING, default, selectConfig.options, inputConfig}). */
export interface PresetPropDef {
  key: string;
  label: string;
  kind: "enum" | "number" | "bool" | "easing";
  /** enum: [value, label][] */
  options?: [string, string][];
  unit?: "s" | "%" | "°" | "px";
  min?: number;
  max?: number;
  /** A NUMBER that resolves as timing (Delay, Duration: TIMING variables bind to it) */
  timing?: boolean;
  /** Shown only for these values of the preset's `type` prop (Figma's flyout hides the rest) [ours] */
  shownFor?: string[];
  /** Shown only while this BOOL prop is on (a text stagger's sub-animation) [ours] */
  shownWith?: string;
  default: PresetPropValue;
}

export interface PresetDef {
  key: PresetKey;
  /** The Animations + menu's label */
  name: string;
  props: PresetPropDef[];
  /** Offered only for text layers (Text, Text stagger), or for layers with strokes (Path) */
  needs?: "text" | "strokes";
}

// Shared by every preset (Figma's): Delay 0 s, Duration 0.5 s (min 0.01), Easing OUT_CUBIC. Delay is the clip's start
// (`timelineOffset`), Duration its length (`timelineDuration`), Easing its `easingData` (round 8h).
const TIMING_PROPS = (duration = 0.5): PresetPropDef[] => [
  { key: "delay", label: "Delay", kind: "number", unit: "s", min: 0, timing: true, default: 0 },
  { key: "duration", label: "Duration", kind: "number", unit: "s", min: 0.01, timing: true, default: duration },
  { key: "easing", label: "Easing", kind: "easing", default: { type: "EASE_OUT" } },
];
/** The props every preset shares, kept on the clip itself rather than among its props. */
export const TIMING_PROP_KEYS: readonly string[] = ["delay", "duration", "easing"];

const DIRECTIONS: [string, string][] = [["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"], ["top_left", "Top left"], ["top_right", "Top right"], ["bottom_left", "Bottom left"], ["bottom_right", "Bottom right"]];

/** The first-party presets and their defaults (Figma's propDefs, docs/research/rea/motion.md §2.18); the code is ours (./presets). */
export const ANIMATION_PRESETS: readonly PresetDef[] = [
  { key: "new", name: "New", props: [...TIMING_PROPS()] },
  { key: "opacity", name: "Opacity", props: [
    { key: "type", label: "Type", kind: "enum", options: [["fadeIn", "Fade in"], ["fadeOut", "Fade out"], ["custom", "Custom"]], default: "fadeIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["fadeIn", "fadeOut"], default: 0 },
    { key: "start", label: "Start", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["custom"], default: 0 },
    { key: "end", label: "End", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["custom"], default: 100 },
    ...TIMING_PROPS(),
  ] },
  { key: "position", name: "Position", props: [
    { key: "type", label: "Type", kind: "enum", options: [["slide_in", "Slide in"], ["slide_out", "Slide out"], ["custom", "Custom"]], default: "slide_in" },
    { key: "direction", label: "Direction", kind: "enum", options: DIRECTIONS, shownFor: ["slide_in", "slide_out"], default: "left" },
    { key: "distance", label: "Distance", kind: "number", unit: "px", shownFor: ["slide_in", "slide_out"], default: 200 },
    { key: "startX", label: "Start X", kind: "number", unit: "px", shownFor: ["custom"], default: 200 },
    { key: "startY", label: "Start Y", kind: "number", unit: "px", shownFor: ["custom"], default: 200 },
    { key: "endX", label: "End X", kind: "number", unit: "px", shownFor: ["custom"], default: 0 },
    { key: "endY", label: "End Y", kind: "number", unit: "px", shownFor: ["custom"], default: 0 },
    ...TIMING_PROPS(),
  ] },
  { key: "scale", name: "Scale", props: [
    { key: "type", label: "Type", kind: "enum", options: [["scaleIn", "Scale in"], ["scaleOut", "Scale out"], ["custom", "Custom"]], default: "scaleIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "%", min: 0, shownFor: ["scaleIn", "scaleOut"], default: 120 },
    { key: "start", label: "Start", kind: "number", unit: "%", min: 0, shownFor: ["custom"], default: 120 },
    { key: "end", label: "End", kind: "number", unit: "%", min: 0, shownFor: ["custom"], default: 100 },
    ...TIMING_PROPS(),
  ] },
  { key: "rotation", name: "Rotation", props: [
    { key: "type", label: "Type", kind: "enum", options: [["rotateIn", "Rotate in"], ["rotateOut", "Rotate out"], ["custom", "Custom"]], default: "rotateIn" },
    { key: "direction", label: "Direction", kind: "enum", options: [["clockwise", "Clockwise"], ["counterclockwise", "Counterclockwise"]], shownFor: ["rotateIn", "rotateOut"], default: "clockwise" },
    { key: "amount", label: "Amount", kind: "number", unit: "°", shownFor: ["rotateIn", "rotateOut"], default: 180 },
    { key: "start", label: "Start", kind: "number", unit: "°", shownFor: ["custom"], default: 180 },
    { key: "end", label: "End", kind: "number", unit: "°", shownFor: ["custom"], default: 0 },
    ...TIMING_PROPS(),
  ] },
  { key: "size", name: "Size", props: [
    { key: "type", label: "Type", kind: "enum", options: [["resize_in", "Resize in"], ["resize_out", "Resize out"], ["custom", "Custom"]], default: "resize_in" },
    { key: "amount", label: "Amount", kind: "number", unit: "px", shownFor: ["resize_in", "resize_out"], default: 50 },
    { key: "start", label: "Start", kind: "number", unit: "px", shownFor: ["custom"], default: 50 },
    { key: "end", label: "End", kind: "number", unit: "px", shownFor: ["custom"], default: 100 },
    ...TIMING_PROPS(),
  ] },
  { key: "cornerRadius", name: "Corner Radius", props: [
    { key: "type", label: "Type", kind: "enum", options: [["roundIn", "Round in"], ["roundOut", "Round out"], ["custom", "Custom"]], default: "roundIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "px", min: 0, shownFor: ["roundIn", "roundOut"], default: 10 },
    { key: "start", label: "Start", kind: "number", unit: "px", shownFor: ["custom"], default: 0 },
    { key: "end", label: "End", kind: "number", unit: "px", shownFor: ["custom"], default: 10 },
    ...TIMING_PROPS(),
  ] },
  { key: "path", name: "Path", needs: "strokes", props: [
    { key: "type", label: "Type", kind: "enum", options: [["draw", "Draw"], ["erase", "Erase"], ["travel", "Travel"], ["custom", "Custom"]], default: "draw" },
    { key: "segment", label: "Segment", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["travel"], default: 10 },
    { key: "start", label: "Start", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["custom"], default: 0 },
    { key: "end", label: "End", kind: "number", unit: "%", min: 0, max: 100, shownFor: ["custom"], default: 100 },
    ...TIMING_PROPS(),
  ] },
  { key: "text", name: "Text", needs: "text", props: [
    { key: "revealBy", label: "Reveal by", kind: "enum", options: [["character", "Character"], ["word", "Word"], ["line", "Line"]], default: "character" },
    ...TIMING_PROPS(1.5),
  ] },
  { key: "textStagger", name: "Text stagger", needs: "text", props: [
    { key: "animationDirection", label: "Direction", kind: "enum", options: [["in", "In"], ["out", "Out"]], default: "in" },
    { key: "textDelayGrouping", label: "Grouping", kind: "enum", options: [["CHARACTER", "Character"], ["CHARACTER_NO_WHITESPACE", "Character (no spaces)"], ["WORD", "Word"], ["LINE", "Line"], ["PARAGRAPH", "Paragraph"]], default: "CHARACTER" },
    { key: "presetStaggerOverlap", label: "Overlap", kind: "number", unit: "%", min: 0, max: 100, default: 50 },
    { key: "textDelayOrder", label: "Order", kind: "enum", options: [["LEFT_RIGHT", "Left to right"], ["RIGHT_LEFT", "Right to left"], ["CENTER_OUT", "Center out"], ["RANDOM", "Random"]], default: "LEFT_RIGHT" },
    { key: "clipContent", label: "Clip content", kind: "bool", default: false },
    // The sub-animations (Figma's: position on, top, 40; rotation off, 180°; scale off, 120 %; opacity off, 0 %; blur off, 20 px).
    { key: "position", label: "Position", kind: "bool", default: true },
    { key: "positionDirection", label: "Direction", kind: "enum", options: DIRECTIONS, shownWith: "position", default: "top" },
    { key: "positionDistance", label: "Distance", kind: "number", unit: "px", shownWith: "position", default: 40 },
    { key: "rotation", label: "Rotation", kind: "bool", default: false },
    { key: "rotationAmount", label: "Amount", kind: "number", unit: "°", shownWith: "rotation", default: 180 },
    { key: "scale", label: "Scale", kind: "bool", default: false },
    { key: "scaleAmount", label: "Amount", kind: "number", unit: "%", min: 0, shownWith: "scale", default: 120 },
    { key: "opacity", label: "Opacity", kind: "bool", default: false },
    { key: "opacityAmount", label: "Amount", kind: "number", unit: "%", min: 0, max: 100, shownWith: "opacity", default: 0 },
    ...TIMING_PROPS(),
  ] },
];

// The option and prop labels above are Figma's keys' meaning (motion.preset_flyout.*), their English wording [unverified].

export interface AnimationStyleDef {
  key: string;
  name: string;
  /** Text-only styles show only for text layers */
  textOnly?: boolean;
  /** The presets it inserts, each offset from the playhead; props not given take the preset's defaults */
  presets: { preset: PresetKey; offsetMs: number; props: Record<string, PresetPropValue> }[];
}

/**
 * Composite animation styles (round 8h) [unverified: names and contents ours until probe 5.10, `figma.motion.
 * figmaAnimationStyles()`, shows Figma's own; "Text enter" / "Text exit" are the help's names]: Figma's presets at
 * their defaults, stacked to play together.
 */
export const ANIMATION_STYLES: readonly AnimationStyleDef[] = [
  { key: "fadeIn", name: "Fade in", presets: [{ preset: "opacity", offsetMs: 0, props: { type: "fadeIn" } }] },
  { key: "fadeOut", name: "Fade out", presets: [{ preset: "opacity", offsetMs: 0, props: { type: "fadeOut" } }] },
  { key: "slideIn", name: "Slide in", presets: [{ preset: "position", offsetMs: 0, props: { type: "slide_in", direction: "top", distance: 40 } }, { preset: "opacity", offsetMs: 0, props: { type: "fadeIn" } }] },
  { key: "slideOut", name: "Slide out", presets: [{ preset: "position", offsetMs: 0, props: { type: "slide_out", direction: "bottom", distance: 40 } }, { preset: "opacity", offsetMs: 0, props: { type: "fadeOut" } }] },
  { key: "scaleIn", name: "Scale in", presets: [{ preset: "scale", offsetMs: 0, props: { type: "scaleIn", amount: 80 } }, { preset: "opacity", offsetMs: 0, props: { type: "fadeIn" } }] },
  { key: "scaleOut", name: "Scale out", presets: [{ preset: "scale", offsetMs: 0, props: { type: "scaleOut", amount: 80 } }, { preset: "opacity", offsetMs: 0, props: { type: "fadeOut" } }] },
  { key: "spinIn", name: "Spin in", presets: [{ preset: "rotation", offsetMs: 0, props: { type: "rotateIn" } }, { preset: "scale", offsetMs: 0, props: { type: "scaleIn", amount: 0 } }] },
  { key: "textEnter", name: "Text enter", textOnly: true, presets: [{ preset: "textStagger", offsetMs: 0, props: { animationDirection: "in", opacity: true } }] },
  { key: "textExit", name: "Text exit", textOnly: true, presets: [{ preset: "textStagger", offsetMs: 0, props: { animationDirection: "out", opacity: true } }] },
];

/** A materialised preset (the `figma:motion` runtime's AnimationPreset, §4.6): keyframes in µs from the clip's start, values in public units (a SCALE track's are multipliers). */
export interface PresetTrackOutput {
  field: KeyframeField;
  operation: "SET" | "OFFSET" | "SCALE";
  keyframes: { timeUs: Micros; value: KeyframeValue; easing?: MotionEasing }[];
  enabled?: boolean;
}

/** A text stagger (§4.10): how the text's elements play the preset's tracks one after another. */
export interface TextStaggerOutput {
  grouping: "CHARACTER" | "CHARACTER_NO_WHITESPACE" | "WORD" | "LINE" | "PARAGRAPH";
  order: "LEFT_RIGHT" | "RIGHT_LEFT" | "CENTER_OUT" | "RANDOM";
  /** 0–100: how much of each element's animation overlaps the next one's */
  overlap: number;
  clipContent?: boolean;
}

export interface PresetOutput {
  tracks: PresetTrackOutput[];
  textStagger?: TextStaggerOutput;
}

/** One preset of a composite style as MOTION_APPLY_STYLE takes it (the TypeScript side expands the style). */
export interface StylePresetRun {
  preset: PresetKey;
  name: string;
  props: Record<string, PresetPropValue>;
  offsetUs: Micros;
  durationUs: Micros;
  easing: MotionEasing;
  output: PresetOutput;
}

// ---- Commands ----------------------------------------------------------------------------------------------------

export interface KeyframeEdit {
  id: GuidString;
  timeUs?: Micros;
  value?: KeyframeValue;
  /** Bind the value to a variable (null unbinds) */
  valueVariable?: GuidString | null;
  easing?: EasingRef;
  /** TRANSLATION_XY keyframes: the motion path's handles, relative to the value */
  pathHandles?: { in: { x: number; y: number }; out: { x: number; y: number } };
}

export interface AudioEdit {
  id: GuidString;
  offsetUs?: Micros;
  startUs?: Micros;
  durationUs?: Micros;
  volume?: number;
  mute?: boolean;
  trackId?: GuidString;
}

/** An audio row's edit (MOTION_SET_AUDIO `tracks`; round 8e, ours): the row's eye mutes it. */
export interface AudioTrackEdit {
  id: GuidString;
  name?: string;
  gain?: number;
  mute?: boolean;
}

/** engine.runMotionCommand's arguments by CommandId (abi.ts 330–349). */
export interface MotionCommandArgs {
  MOTION_ADD_KEYFRAME: { nodes: GuidString[]; field: KeyframeField; timeUs?: Micros; value?: KeyframeValue; easing?: EasingRef };
  MOTION_SET_KEYFRAMES: { edits: KeyframeEdit[] };
  MOTION_DELETE_KEYFRAMES: { ids: GuidString[] };
  MOTION_DELETE_TRACKS: { node: GuidString; fields: KeyframeField[] };
  MOTION_SET_EASING: { ids: GuidString[]; easing: EasingRef };
  MOTION_SET_TIMELINE: { root: GuidString; durationUs?: Micros; playback?: PlaybackName; snappingFps?: number };
  /** `props` keyed by defID (as TimelineClip's); `output` the preset's code run (§4.6) */
  MOTION_ADD_ANIMATION: { nodes: GuidString[]; preset: PresetKey; name?: string; props?: Record<string, PresetPropValue>; startUs?: Micros; durationUs?: Micros; easing?: MotionEasing; output?: PresetOutput };
  /** Without `output`, a new duration stretches the clip's tracks and a new easing goes on its keyframes; `variables` binds Delay / Duration / Easing (null unbinds) */
  MOTION_SET_ANIMATION: { id: GuidString; preset?: PresetKey; name?: string; props?: Record<string, PresetPropValue>; startUs?: Micros; durationUs?: Micros; easing?: MotionEasing; disabled?: boolean; output?: PresetOutput; variables?: { [K in keyof PresetVariables]?: GuidString | null } };
  MOTION_REMOVE_ANIMATIONS: { ids: GuidString[] };
  /**
   * A style's presets on the layers (`style` a first-party key, or a custom style's GUID); or `detach`: a style entry
   * forgotten, its presets kept; or `create` (round 8i): a custom style from a layer's clips (`style`: replace that
   * one's content)
   */
  /**
   * Round 8j: `binding` applies an entry of the one layer again in place; `create.templates` (runs) instead of `from`
   * write a custom style's content; `create.presets` (runs with their output) carry an update to the style's layers
   */
  MOTION_APPLY_STYLE: {
    nodes?: GuidString[];
    style?: string;
    startUs?: Micros;
    presets?: StylePresetRun[];
    binding?: GuidString;
    detach?: GuidString;
    create?: ({ from: GuidString } | { templates: (Omit<StylePresetRun, "output"> & { id?: GuidString })[] }) & { name?: string; style?: GuidString; presets?: StylePresetRun[] };
  };
  MOTION_RETIME_LAYER: { node: GuidString; deltaUs?: Micros; scale?: { factor: number; pivotUs: Micros } };
  MOTION_SET_INSTANCE_OFFSET: { instance: GuidString; offsetUs: Micros };
  MOTION_SET_ANCHOR: { nodes: GuidString[]; x: number; y: number; keepInPlace?: boolean };
  MOTION_SET_PATH_HANDLES: { keyframe: GuidString; in: { x: number; y: number }; out: { x: number; y: number } };
  /** `node` a TEXT layer (its manual tracks staggered, round 8i) or a text preset's clip */
  MOTION_SET_TEXT_STAGGER: { node: GuidString; enabled: boolean; grouping?: "CHARACTER" | "CHARACTER_NO_WHITESPACE" | "WORD" | "LINE" | "PARAGRAPH"; delayMs?: number; order?: "LEFT_RIGHT" | "RIGHT_LEFT" | "CENTER_OUT" | "RANDOM" };
  MOTION_ADD_AUDIO: { root: GuidString; mediaHash: string; name: string; offsetUs: Micros; durationUs: Micros; trackId?: GuidString };
  MOTION_SET_AUDIO: { root: GuidString; edits?: AudioEdit[]; tracks?: AudioTrackEdit[] };
  MOTION_SPLIT_AUDIO: { root: GuidString; id: GuidString; atUs: Micros };
  MOTION_REMOVE_AUDIO: { root: GuidString; ids: GuidString[] };
  MOTION_PASTE_KEYFRAMES: { nodes: GuidString[]; atUs: Micros; clipboard: MotionClipboard };
  /** Position or scale as one XY track (round 8i: Figma's switchVectorKeyframesToCombined) */
  MOTION_COMBINE_TRACKS: { node: GuidString; kind: "POSITION" | "SCALE" };
  /** An XY track as an X and a Y track (Figma's switchVectorKeyframesToSplit) */
  MOTION_SPLIT_TRACKS: { node: GuidString; kind: "POSITION" | "SCALE" };
  MOTION_SET_PRESET_TRACKS: { id: GuidString; output: PresetOutput };
}

/** Keyframes copied from the timeline (the editor keeps it; relative times from the earliest). */
export interface MotionClipboard {
  tracks: { field: KeyframeField; keyframes: { dtUs: Micros; value: KeyframeValue; easing: EasingRef }[] }[];
}

// ---- Resolved model (Dev Mode code, SVG / Lottie export, plugin `animations`, agents) -----------------------------

export interface ResolvedKeyframe {
  timeUs: Micros;
  value: KeyframeValue;
  /** Into this keyframe */
  easing: MotionEasing;
}

export interface ResolvedProperty {
  field: KeyframeField;
  kind: FieldInfo["kind"];
  keyframes: ResolvedKeyframe[];
  /** Per-element stagger (text animations) */
  stagger?: { grouping: string; order: string; delayMs: number; elements: number };
}

export interface ResolvedLayer {
  node: GuidString;
  /** Instance-qualified path for derived layers ("I<instance>;<sublayer>"), else the GUID */
  path: string;
  name: string;
  /** The anchor as % of the size */
  anchor: { x: number; y: number };
  size: { width: number; height: number };
  properties: ResolvedProperty[];
}

export interface ResolvedMotion {
  root: GuidString;
  durationUs: Micros;
  playback: PlaybackName;
  layers: ResolvedLayer[];
}

// ---- Export --------------------------------------------------------------------------------------------------------

export type AnimatedFormat = "MP4" | "WEBM" | "GIF" | "SVG" | "LOTTIE" | "DOTLOTTIE";
export const ANIMATED_FORMATS: readonly AnimatedFormat[] = ["MP4", "WEBM", "GIF", "SVG", "LOTTIE", "DOTLOTTIE"];
export const ANIMATED_FORMAT_LABELS: Record<AnimatedFormat, string> = {
  MP4: "MP4", WEBM: "WebM", GIF: "GIF", SVG: "SVG", LOTTIE: "Lottie", DOTLOTTIE: "dotLottie",
};
export const FRAME_RATES = [24, 25, 30, 50, 60] as const; // [unverified]

export interface AnimatedExportSettings {
  format: AnimatedFormat;
  /** A multiplier, or an exact size */
  size: { scale: number } | { width: number; height: number };
  fps: (typeof FRAME_RATES)[number];
  /** MP4 / WebM */
  quality: "LOW" | "MEDIUM" | "HIGH";
  /** GIF */
  loop: boolean;
}
export const DEFAULT_ANIMATED_EXPORT: AnimatedExportSettings = { format: "MP4", size: { scale: 1 }, fps: 30, quality: "HIGH", loop: true };

export interface AnimatedExportProgress {
  frame: number;
  frames: number;
  phase: "render" | "encode" | "audio" | "mux" | "done";
}

/** A shape's paint: solid (the paint's opacity in its alpha), or a linear / radial gradient by its two ends in node space. */
export type MotionShapePaint =
  | { type: "SOLID"; color: RGBA }
  | { type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL"; stops: { position: number; color: RGBA }[]; from: { x: number; y: number }; to: { x: number; y: number } };

export interface MotionShapePath {
  /** SVG path data, absolute M / L / Q / C / Z, in the layer's space */
  d: string;
  windingRule: "NONZERO" | "EVENODD";
  paint: MotionShapePaint;
  /** The paint it draws (the samples' colours are by this index) */
  source: { collection: "fills" | "strokes"; index: number };
  /** A stroke on `d` as its centre line (a centred or open stroke; path trim trims it); absent: a filled area */
  stroke?: { weight: number; cap: "NONE" | "ROUND" | "SQUARE"; join: "MITER" | "BEVEL" | "ROUND"; miterLimit: number; dashes: number[] };
}

/**
 * engine.motionShapes(root): what the vector exports draw (round 8e; Lottie, dotLottie, animated SVG) — the root's
 * layers at base values, the root first and each layer after its parent, back to front.
 */
export interface MotionShapeLayer {
  node: GuidString;
  parent: GuidString | null;
  name: string;
  /** The node type's name */
  type: string;
  /** Local transform (2×3: a b c d e f) at base values; the root's is the identity (drawn at the origin) */
  transform: [number, number, number, number, number, number];
  size: { width: number; height: number };
  opacity: number;
  /** Clips its children (frames with clip content) */
  clips: boolean;
  /** Fills (bottom first, text as its glyphs' outlines), then strokes */
  paths: MotionShapePath[];
  /** Can't be shapes (images, videos, shaders, angular / diamond gradients, blurs, a mask inside): a raster of its base state */
  rasterize: boolean;
  /** Where that raster goes: its size at scale 1 and the transform from its pixels to the layer's space */
  raster?: { width: number; height: number; transform: [number, number, number, number, number, number] };
}

/** One layer's evaluated values at one time (engine.motionSamples). */
export interface MotionSample {
  /** Local transform (2×3) with the motion transform composed */
  t: [number, number, number, number, number, number];
  /** Opacity 0–1 */
  o: number;
  w: number;
  h: number;
  /** Path trim [start, end] when it cuts anything */
  trim?: [number, number];
  /** Each fill's / stroke's colour with its paint's opacity (null: not a solid paint) */
  fills: (RGBA | null)[];
  strokes: (RGBA | null)[];
  /** Stroke weight */
  sw: number;
}

/** engine.motionSamples(root, times): each of motionShapes' layers at each time. */
export interface MotionSamples {
  root: GuidString;
  times: Micros[];
  layers: { node: GuidString; frames: MotionSample[] }[];
}

// ---- Dev Mode ------------------------------------------------------------------------------------------------------

export type MotionCodeFormat = "CSS" | "REACT" | "JSON";
export const MOTION_CODE_FORMATS: readonly MotionCodeFormat[] = ["CSS", "REACT", "JSON"];
export const MOTION_CODE_LABELS: Record<MotionCodeFormat, string> = { CSS: "CSS", REACT: "React", JSON: "JSON" };

// ---- The easing editor's props (8d builds it, 8c uses it) -----------------------------------------------------------

export interface EasingEditorProps {
  value: EasingRef;
  /** A bound value's easing (the variable's in the layer's modes): what the graph shows while `value` is a variable */
  resolved?: MotionEasing;
  /** Live changes while dragging (no commit); `commit` once on release / Enter */
  onChange(value: EasingRef, commit: boolean): void;
  /** Offer the variable binding (EASING variables) */
  allowVariable?: boolean;
  /** Where to anchor the popover (a DOMRect's box; the shared types stay DOM-free) */
  anchor: { x: number; y: number; width: number; height: number };
  onClose(): void;
}
