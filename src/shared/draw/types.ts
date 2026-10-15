/**
 * Figma Draw (docs/draw.md) — the types the engine bindings, the Draw chrome, the brush assets and the plugin API share.
 * Document shapes (TransformModifier, TextPathStart, DynamicStrokeSettings…) are the generated ones in
 * src/shared/schema/document.generated.ts; these are the shapes around them. [unverified] defaults are ours.
 */

/** A GUID as the engine bindings print it: "sessionID:localID". */
export type GuidString = string;

export type BrushType = "STRETCH" | "SCATTER";

/** Figma's built-in brushes (developers.figma.com ComplexStrokeProperties `brushName`), in Figma's order. */
export const STRETCH_BRUSH_NAMES = [
  "HEIST", "BLOCKBUSTER", "GRINDHOUSE", "BIOPIC", "SPAGHETTI_WESTERN", "SLASHER", "HARDBOILED", "VERITE",
  "EPIC", "SCREWBALL", "ROM_COM", "NOIR", "PROPAGANDA", "MELODRAMA", "NEW_WAVE",
] as const;
export const SCATTER_BRUSH_NAMES = [
  "BUBBLEGUM", "WITCH_HOUSE", "SHOEGAZE", "HONKY_TONK", "SCREAMO", "DRONE", "DOO_WOP", "SPOKEN_WORD", "VAPORWAVE", "OI",
] as const;
export type StretchBrushName = (typeof STRETCH_BRUSH_NAMES)[number];
export type ScatterBrushName = (typeof SCATTER_BRUSH_NAMES)[number];
export type BuiltinBrushName = StretchBrushName | ScatterBrushName;

/** "SPAGHETTI_WESTERN" → "Spaghetti Western" (the shown name and the BRUSH node's name). */
export function brushDisplayName(key: BuiltinBrushName): string {
  return key.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

/** A brush's artwork: closed regions in its own box; the stroke runs along +x. */
export interface BrushArtwork {
  width: number;
  height: number;
  /** SVG path data, absolute commands (M L Q C Z) in the box's coordinates */
  d: string;
  windingRule: "NONZERO" | "ODD";
}

export interface BuiltinBrush {
  key: BuiltinBrushName;
  name: string;
  type: BrushType;
  artwork: BrushArtwork;
}

/** A brush in the menu: the file's BRUSH node, or a built-in not yet installed (guid null). */
export interface BrushEntry {
  guid: GuidString | null;
  name: string;
  type: BrushType;
  builtin: BuiltinBrushName | null;
}

/** engine.installBrush's argument (ABI engine_install_brush). */
export interface InstallBrushInput {
  name: string;
  type: BrushType;
  artwork: BrushArtwork;
  /** A scatter brush's own settings (its node's scatterStrokeSettings), over SCATTER_DEFAULTS; a custom brush: none. */
  settings?: Partial<ScatterSettings>;
}

/**
 * Stroke settings' Stroke Type. Implicit in the document (docs/draw.md §4.3, Figma's rule): BRUSH = strokeBrushGuid
 * set and not -1:-1; DYNAMIC = dynamicStrokeSettings present and not the neutral {1, 0, 0}; else BASIC.
 */
export type StrokeKind = "BASIC" | "DYNAMIC" | "BRUSH";

/**
 * Figma's "no brush" GUID -1:-1, written into strokeBrushGuid whenever a stroke becomes Dynamic or Basic — so every
 * Dynamic stroke in a Figma file carries it (docs/research/rea/vector.md §1). Read as "4294967295:4294967295" (kiwi's
 * uint) or "-1:-1".
 */
export const NO_BRUSH_GUID: GuidString = "4294967295:4294967295";
export const isNoBrushGuid = (g: string | null | undefined): boolean => g === NO_BRUSH_GUID || g === "-1:-1";

export interface DynamicSettings {
  frequency: number;
  wiggle: number;
  smoothen: number;
}
export interface ScatterSettings {
  gap: number;
  wiggle: number;
  angularJitter: number;
  rotation: number;
  sizeJitter: number;
}
export interface StretchSettings {
  /** Figma's Direction; the document's BrushOrientation FORWARD / REVERSE */
  direction: "FORWARD" | "BACKWARD";
}

/**
 * Ranges from the plugin API (upper bounds marked ours where Figma gives none). Wiggle: the plugin takes any value ≥ 0
 * and the document keeps it; the panel's field stops at 100, the engine's geometry cap (kDynWiggleCap).
 */
export const DYNAMIC_RANGE = { frequency: [0.01, 20], wiggle: [0, 100 /* ours */], smoothen: [0, 1] } as const;
/** Draw's sliders under the Dynamic fields: Figma's maxima (1968.min.js module 326635, rea/vector.md §2); minima as DYNAMIC_RANGE. */
export const DYNAMIC_SLIDER_MAX = { frequency: 2, wiggle: 5, smoothen: 1 } as const;
export const SCATTER_RANGE = {
  gap: [0.25, 20 /* ours */],
  wiggle: [0, 20 /* ours */],
  sizeJitter: [0, 3],
  angularJitter: [-180, 180],
  rotation: [-180, 180],
} as const;
/** A new Dynamic stroke: Figma's (live, read back 0.75 / 0.30000001192092896 / 0.5; rea/vector.md §2). */
export const DYNAMIC_DEFAULTS: DynamicSettings = { frequency: 0.75, wiggle: 0.3, smoothen: 0.5 };
/** Figma's neutral value: what Basic leaves in a present dynamicStrokeSettings; reads as Basic. */
export const DYNAMIC_NEUTRAL: DynamicSettings = { frequency: 1, wiggle: 0, smoothen: 0 };
/** Settings (absent fields as DYNAMIC_DEFAULTS, as the engine reads them) equal to the neutral value. */
export function isNeutralDynamic(s: Partial<DynamicSettings> | Record<string, unknown> | null | undefined): boolean {
  if (!s || typeof s !== "object") return false;
  const v = { ...DYNAMIC_DEFAULTS, ...(s as Partial<DynamicSettings>) };
  const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-6;
  return near(v.frequency, DYNAMIC_NEUTRAL.frequency) && near(v.wiggle, DYNAMIC_NEUTRAL.wiggle) && near(v.smoothen, DYNAMIC_NEUTRAL.smoothen);
}
/**
 * Figma's base scatter settings (figma_app.min.js module 258160 `F2`, rea/vector.md §5): applying a scatter brush writes
 * {...this, ...the BRUSH node's own scatterStrokeSettings, ...the user's values}; a custom brush's node gets this.
 */
export const SCATTER_DEFAULTS: ScatterSettings = { gap: 0.9, wiggle: 0, angularJitter: 0, rotation: 0, sizeJitter: 0 };
/** The Scatter sliders' ranges (Figma's UI maxima, rea/vector.md §5); the fields take SCATTER_RANGE. */
export const SCATTER_SLIDER_RANGE = {
  gap: [0.25, 3],
  wiggle: [0, 2],
  sizeJitter: [0, 3],
  angularJitter: [-180, 180],
  rotation: [-180, 180],
} as const;
/**
 * The built-in scatter brushes' own settings, the BRUSH node's scatterStrokeSettings (449) written on install: Figma's
 * numbers, read back live from each built-in (rea/vector.md §5) — identifiers of behaviour, not artwork.
 */
export const BUILTIN_SCATTER_SETTINGS: Readonly<Record<ScatterBrushName, ScatterSettings>> = {
  BUBBLEGUM: { gap: 0.25, wiggle: 0, angularJitter: 95, rotation: 45, sizeJitter: 0 },
  WITCH_HOUSE: { gap: 0.39, wiggle: 0, angularJitter: 61, rotation: 179, sizeJitter: 0 },
  SHOEGAZE: { gap: 0.37, wiggle: 0, angularJitter: 180, rotation: 0, sizeJitter: 0.11 },
  HONKY_TONK: { gap: 0.28, wiggle: 0, angularJitter: 180, rotation: 0, sizeJitter: 0.25 },
  SCREAMO: { gap: 0.45, wiggle: 0, angularJitter: 180, rotation: 179, sizeJitter: 0 },
  DRONE: { gap: 0.51, wiggle: 0.06, angularJitter: 180, rotation: 0, sizeJitter: 0.65 },
  DOO_WOP: { gap: 0.31, wiggle: 0, angularJitter: 180, rotation: 0, sizeJitter: 0 },
  SPOKEN_WORD: { gap: 0.25, wiggle: 0, angularJitter: 30, rotation: 0, sizeJitter: 0 },
  VAPORWAVE: { gap: 0.25, wiggle: 0, angularJitter: 180, rotation: 0, sizeJitter: 0.3 },
  OI: { gap: 0.25, wiggle: 0, angularJitter: 95, rotation: 45, sizeJitter: 0 },
};
/** A built-in's own scatter settings (undefined for a stretch brush). */
export const builtinScatterSettings = (key: BuiltinBrushName): ScatterSettings | undefined =>
  (BUILTIN_SCATTER_SETTINGS as Partial<Record<BuiltinBrushName, ScatterSettings>>)[key];
export const STRETCH_DEFAULTS: StretchSettings = { direction: "FORWARD" };

/** The Pencil's and the Brush's settings (the secondary toolbar), sent with engine.setDrawToolSettings. */
export interface DrawToolSettings {
  pencil: { color: string; opacity: number; weight: number; kind: "BASIC" | "DYNAMIC"; dynamic: DynamicSettings };
  /** brush: the installed BRUSH node (the chrome installs a built-in before selecting it) */
  brush: { color: string; opacity: number; weight: number; brush: GuidString | null };
}
export const DRAW_TOOL_DEFAULTS: DrawToolSettings = {
  pencil: { color: "#000000", opacity: 1, weight: 2, kind: "BASIC", dynamic: DYNAMIC_DEFAULTS },
  brush: { color: "#000000", opacity: 1, weight: 4, brush: null },
};
export const DRAW_WEIGHT_RANGE = [0.5, 100] as const; // ours

/** The engine's DRAW_TOOL_SAMPLED event (⌘-click on a stroke with the Pencil or the Brush). */
export interface DrawToolSampled {
  tool: "PENCIL" | "BRUSH";
  color: string;
  opacity: number;
  weight: number;
  kind: StrokeKind;
  dynamic?: DynamicSettings;
  brush?: GuidString;
}

/** A transform modifier as the chrome edits it (the document's TransformModifier, type REPEAT). */
export type RepeatKind = "LINEAR" | "RADIAL";
export interface RepeatModifierInput {
  repeatType: RepeatKind;
  count: number;
  /** LINEAR: the gap along the axis; RADIAL: the gap from the content to the centre (docs/draw.md §4.2) */
  offset: number;
  unitType: "PIXELS" | "RELATIVE";
  /** LINEAR only (X_AND_Y kept from files, not offered) */
  axis: "X" | "Y" | "X_AND_Y";
  order: "FORWARD" | "REVERSE";
  visible: boolean;
}
/** Count: an integer 2…40, Figma's plugin limits (live, rea/vector.md §6); files' counts are read leniently (1…1000). */
export const REPEAT_COUNT_RANGE = [2, 40] as const;
export const MAX_REPEAT_INSTANCES = 10_000;
/** [unverified] defaults for "Linear repeat" / "Radial repeat". */
export const REPEAT_DEFAULTS: Record<RepeatKind, RepeatModifierInput> = {
  LINEAR: { repeatType: "LINEAR", count: 3, offset: 16, unitType: "PIXELS", axis: "X", order: "FORWARD", visible: true },
  RADIAL: { repeatType: "RADIAL", count: 8, offset: 0, unitType: "PIXELS", axis: "X", order: "FORWARD", visible: true },
};

/** Command args (CommandId 310–321, docs/draw.md §4.7). `refs` absent = the selection. */
export interface DrawCommandArgs {
  ADD_TRANSFORM_MODIFIER: { refs?: GuidString[]; modifier: RepeatModifierInput };
  SET_TRANSFORM_MODIFIER: { ref: GuidString; index: number; modifier: Partial<RepeatModifierInput> };
  REMOVE_TRANSFORM_MODIFIER: { ref: GuidString; index: number };
  MOVE_TRANSFORM_MODIFIER: { ref: GuidString; from: number; to: number };
  APPLY_TRANSFORMS: { refs?: GuidString[] };
  SET_STROKE_KIND: { refs?: GuidString[]; kind: "BASIC" | "DYNAMIC"; dynamic?: Partial<DynamicSettings> };
  /** The brush's settings: {SCATTER_DEFAULTS, ...the BRUSH node's own, ...`scatter` / `stretch`} (the previous brush's replaced). */
  SET_STROKE_BRUSH: { refs?: GuidString[]; brush: GuidString; scatter?: Partial<ScatterSettings>; stretch?: Partial<StretchSettings> };
  SET_BRUSH_SETTINGS: { refs?: GuidString[]; scatter?: Partial<ScatterSettings>; stretch?: Partial<StretchSettings> };
  CREATE_BRUSH: { ref: GuidString; brushType: BrushType };
  CREATE_TEXT_PATH: { ref: GuidString; segment: number; position: number; replace: boolean };
  FLIP_TEXT_PATH: { refs?: GuidString[] };
  SET_TEXT_PATH_START: { ref: GuidString; segment: number; position: number };
}

/** The plugin API's TextPathStartData ↔ the document's TextPathStart.tValue ([unverified] encoding, §4.4). */
export function tValueOf(segment: number, position: number): number {
  return Math.max(0, Math.floor(segment)) + Math.min(1, Math.max(0, position));
}
export function splitTValue(tValue: number): { segment: number; position: number } {
  const segment = Math.max(0, Math.floor(tValue));
  return { segment, position: tValue - segment };
}
