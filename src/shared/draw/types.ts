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
}

/** Stroke settings' Stroke Type. Implicit in the document: BRUSH = strokeBrushGuid set, DYNAMIC = dynamicStrokeSettings set. */
export type StrokeKind = "BASIC" | "DYNAMIC" | "BRUSH";

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

/** Ranges from the plugin API (upper bounds marked ours where Figma gives none). */
export const DYNAMIC_RANGE = { frequency: [0.01, 20], wiggle: [0, 100 /* ours */], smoothen: [0, 1] } as const;
export const SCATTER_RANGE = {
  gap: [0.25, 20 /* ours */],
  wiggle: [0, 20 /* ours */],
  sizeJitter: [0, 3],
  angularJitter: [-180, 180],
  rotation: [-180, 180],
} as const;
/** [unverified] defaults (ours until a Figma sample shows its own). */
export const DYNAMIC_DEFAULTS: DynamicSettings = { frequency: 2, wiggle: 1, smoothen: 0.5 };
export const SCATTER_DEFAULTS: ScatterSettings = { gap: 1, wiggle: 0, angularJitter: 0, rotation: 0, sizeJitter: 0 };
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
export const REPEAT_COUNT_RANGE = [1, 1000] as const;
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
  SET_STROKE_BRUSH: { refs?: GuidString[]; brush: GuidString };
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
