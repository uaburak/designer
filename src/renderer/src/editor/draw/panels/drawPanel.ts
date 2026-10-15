/**
 * Draw mode's right sidebar (docs/draw.md §5.3–§5.5, §5.8; round 7d): which Design panel sections show in each mode,
 * the stroke kinds (Basic / Dynamic / Brush) read from a layer and written through the Draw commands, and the
 * transform modifiers (Linear / Radial repeat) as the Transform section edits them.
 *
 * Every command goes through `runDraw` (7c's drawTools.ts): until round 7b builds the engine side the stubs answer
 * E_UNSUPPORTED and nothing changes — the panel still shows what the document holds.
 */
import { Status } from "@/engine/abi";
import { guidString } from "@/engine/guids";
import type { ChangeInfo } from "@/ds";
import {
  DYNAMIC_DEFAULTS,
  DYNAMIC_RANGE,
  REPEAT_COUNT_RANGE,
  REPEAT_DEFAULTS,
  SCATTER_DEFAULTS,
  SCATTER_RANGE,
  STRETCH_DEFAULTS,
  type BrushEntry,
  type DynamicSettings,
  type GuidString,
  type RepeatKind,
  type RepeatModifierInput,
  type ScatterSettings,
  type StretchSettings,
  type StrokeKind,
} from "@shared/draw/types";
import { strokeBrushOf as sharedStrokeBrushOf, strokeKindOfFields } from "@shared/draw/apiShapes";
import type { EditorController } from "../../controller";
import type { Mode } from "../../devmode/devMode";
import { chooseBrush, drawToolsOf, runDraw } from "../drawTools";
import { isFrameNode, isInstanceSublayer, isTextNode, typeOf, type PanelNode } from "../../panels/design/shared";

// ---- Sections ------------------------------------------------------------------------------------------------------

/** The Design tab's sections after the header (Header / component block and the relaunch buttons always show). */
export type DesignSection = "position" | "layout" | "appearance" | "transform" | "typography" | "fill" | "stroke" | "effects" | "selectionColors" | "layoutGuide" | "export";

/** A text or a text on a path: Typography shows for it. */
export const isTypeNode = (n: PanelNode): boolean => isTextNode(n) || typeOf(n) === "TEXT_PATH";

/** Layers a transform group can wrap (Group ⌘G's rules: not sections, not an instance's own layers). */
export const canTransform = (nodes: readonly PanelNode[]): boolean => nodes.length > 0 && nodes.every((n) => typeOf(n) !== "SECTION" && !isInstanceSublayer(n));

/**
 * The sections in order, by mode (docs/draw.md §5.3). Design: as before, plus Transform when the selection is
 * transform groups [ours]. Draw: Figma's hands-on list — Alignment, Dimensions, Appearance, Transform, Typography,
 * Fill, Stroke, Effects, Export — without auto layout, layout guides, constraints, variable modes or Selection
 * colors [unverified]. ("position" holds Alignment, X / Y and rotation; "layout" is Dimensions in Draw.)
 */
export function designSections(mode: Mode, nodes: readonly PanelNode[]): DesignSection[] {
  const sections = nodes.some((n) => typeOf(n) === "SECTION");
  const texts = nodes.some(isTypeNode);
  const out: DesignSection[] = ["position", "layout", "appearance"];
  if (mode === "draw" ? canTransform(nodes) : nodes.length > 0 && nodes.every((n) => typeOf(n) === "TRANSFORM")) out.push("transform");
  if (texts) out.push("typography");
  out.push("fill", "stroke");
  if (!sections) out.push("effects");
  if (mode !== "draw") {
    out.push("selectionColors");
    if (nodes.every(isFrameNode) && !sections) out.push("layoutGuide");
  }
  out.push("export");
  return out;
}

/** The right panel's tabs by mode: Draw has no Prototype tab (docs/draw.md §5.3 [unverified]). */
export const rightPanelTabs = (mode: Mode): ("design" | "prototype")[] => (mode === "draw" ? ["design"] : ["design", "prototype"]);

// ---- Stroke kinds --------------------------------------------------------------------------------------------------

/** A GUID field as the bindings print it ("s:l"), from either form the engine reads it in. */
export { guidString };

/** The fields the stroke kinds live in (schema 446–452, 482; not typed by the facade yet). */
export type StrokeKindFields = {
  strokeBrushGuid?: unknown;
  dynamicStrokeSettings?: Partial<DynamicSettings> | Record<string, number> | null;
  scatterStrokeSettings?: Partial<ScatterSettings> | null;
  stretchStrokeSettings?: { orientation?: "FORWARD" | "REVERSE" } | null;
};

const kindFields = (n: PanelNode) => n as unknown as StrokeKindFields;

/**
 * The kind is implicit (docs/draw.md §4.3, Figma's rule — the shared `strokeKindOfFields`): a brush GUID other than
 * Figma's -1:-1 = Brush, Dynamic settings other than the neutral {1, 0, 0} = Dynamic, else Basic.
 */
export const strokeKindOf = (n: PanelNode): StrokeKind => strokeKindOfFields(kindFields(n));

/** The layer's BRUSH node (null for none, Figma's -1:-1 included). */
export const strokeBrushOf = (n: PanelNode): GuidString | null => sharedStrokeBrushOf(kindFields(n));

export const dynamicOf = (n: PanelNode): DynamicSettings => ({ ...DYNAMIC_DEFAULTS, ...(kindFields(n).dynamicStrokeSettings ?? {}) });
export const scatterOf = (n: PanelNode): ScatterSettings => ({ ...SCATTER_DEFAULTS, ...(kindFields(n).scatterStrokeSettings ?? {}) });
/** The document's BrushOrientation (FORWARD / REVERSE) as Figma's Direction (Forward / Backward). */
export const stretchOf = (n: PanelNode): StretchSettings => (kindFields(n).stretchStrokeSettings?.orientation === "REVERSE" ? { direction: "BACKWARD" } : STRETCH_DEFAULTS);

/** Dynamic's fields as the panel shows them (Figma's labels, docs/draw.md §5.4). */
export const DYNAMIC_FIELDS: { id: keyof DynamicSettings; label: string; step: number }[] = [
  { id: "frequency", label: "Frequency", step: 0.1 },
  { id: "wiggle", label: "Wiggle", step: 0.1 },
  { id: "smoothen", label: "Smoothen", step: 0.01 },
];

/** Scatter's fields (labels from the plugin API's field names [unverified]). */
export const SCATTER_FIELDS: { id: keyof ScatterSettings; label: string; step: number; unit?: string }[] = [
  { id: "gap", label: "Gap", step: 0.05 },
  { id: "wiggle", label: "Wiggle", step: 0.1 },
  { id: "sizeJitter", label: "Size jitter", step: 0.05 },
  { id: "angularJitter", label: "Angular jitter", step: 1, unit: "°" },
  { id: "rotation", label: "Rotation", step: 1, unit: "°" },
];

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * The brush Stroke Type › Brush starts with: the last one used (the Brush tool's, or the last picked in a Stroke
 * panel) — a built-in installed into the file first. Null when it can't be (no artwork yet, no engine support).
 */
export function lastBrush(ed: EditorController): GuidString | null {
  const shown = drawToolsOf(ed).brush;
  return shown.guid ?? chooseBrush(ed, { ...shown });
}

/**
 * Stroke Type (docs/draw.md §5.4): Basic → SET_STROKE_KIND BASIC; Dynamic → SET_STROKE_KIND DYNAMIC with the
 * defaults; Brush → SET_STROKE_BRUSH with the last-used brush. Each is one undo step ("Change stroke", the engine's).
 */
export function setStrokeKind(ed: EditorController, refs: readonly GuidString[], kind: StrokeKind): number {
  if (kind === "BRUSH") {
    const brush = lastBrush(ed);
    if (!brush) return Status.E_UNSUPPORTED;
    return runDraw(ed, "SET_STROKE_BRUSH", { refs: [...refs], brush });
  }
  if (kind === "DYNAMIC") return runDraw(ed, "SET_STROKE_KIND", { refs: [...refs], kind, dynamic: { ...DYNAMIC_DEFAULTS } });
  return runDraw(ed, "SET_STROKE_KIND", { refs: [...refs], kind });
}

/** The Brush picker's pick: the layers' brush (and the last-used brush from now on). */
export function pickStrokeBrush(ed: EditorController, refs: readonly GuidString[], entry: BrushEntry): number {
  const brush = chooseBrush(ed, entry);
  if (!brush) return Status.E_UNSUPPORTED;
  return runDraw(ed, "SET_STROKE_BRUSH", { refs: [...refs], brush });
}

/** One Dynamic field (clamped to the plugin API's range); a scrub is one undo step. */
export function setDynamic(ed: EditorController, refs: readonly GuidString[], id: keyof DynamicSettings, v: number, info: ChangeInfo): void {
  ed.edit("Change stroke", info, () => void runDraw(ed, "SET_STROKE_KIND", { refs: [...refs], kind: "DYNAMIC", dynamic: { [id]: clamp(v, DYNAMIC_RANGE[id]) } }));
}

/** One Scatter field (clamped); a scrub is one undo step. */
export function setScatter(ed: EditorController, refs: readonly GuidString[], id: keyof ScatterSettings, v: number, info: ChangeInfo): void {
  ed.edit("Change stroke", info, () => void runDraw(ed, "SET_BRUSH_SETTINGS", { refs: [...refs], scatter: { [id]: clamp(v, SCATTER_RANGE[id]) } }));
}

/** Stretch's Direction. */
export const setStretch = (ed: EditorController, refs: readonly GuidString[], direction: StretchSettings["direction"]): number => runDraw(ed, "SET_BRUSH_SETTINGS", { refs: [...refs], stretch: { direction } });

// ---- Transform modifiers -------------------------------------------------------------------------------------------

/** The document's TransformModifier (schema 455) as the engine reads it. */
export interface TransformModifierDoc {
  type?: "REPEAT" | "SYMMETRY" | "SKEW";
  offset?: { x: number; y: number };
  visible?: boolean;
  count?: number;
  repeatType?: RepeatKind;
  axis?: "X" | "Y" | "X_AND_Y";
  unitType?: "PIXELS" | "RELATIVE";
  order?: "FORWARD" | "REVERSE";
}

/** A modifier as the panel edits it (absent fields are the schema's zero values). */
export function repeatInputOf(m: TransformModifierDoc): RepeatModifierInput {
  return {
    repeatType: m.repeatType ?? "LINEAR",
    count: m.count ?? 1,
    offset: m.offset?.x ?? 0,
    unitType: m.unitType ?? "PIXELS",
    axis: m.axis ?? "X",
    order: m.order ?? "FORWARD",
    visible: m.visible !== false,
  };
}

/** A transform group's repeats, each with its index in `transformModifiers` (SYMMETRY / SKEW are kept, not listed). */
export function repeatsOf(n: PanelNode): { index: number; modifier: RepeatModifierInput }[] {
  const list = ((n as unknown as { transformModifiers?: TransformModifierDoc[] }).transformModifiers ?? []) as TransformModifierDoc[];
  return list.flatMap((m, index) => ((m.type ?? "REPEAT") === "REPEAT" ? [{ index, modifier: repeatInputOf(m) }] : []));
}

export const repeatLabel = (k: RepeatKind): string => (k === "LINEAR" ? "Linear repeat" : "Radial repeat");

/** "Additional transform modifier" › Linear / Radial repeat: wraps the selection in a transform group, or adds to one. */
export const addRepeat = (ed: EditorController, refs: readonly GuidString[], kind: RepeatKind): number => runDraw(ed, "ADD_TRANSFORM_MODIFIER", { refs: [...refs], modifier: { ...REPEAT_DEFAULTS[kind] } });

/** A modifier's fields (Count rounded and clamped to Figma's 2…40); a scrub coalesces into one "Change repeat". */
export function setRepeat(ed: EditorController, ref: GuidString, index: number, patch: Partial<RepeatModifierInput>, info: ChangeInfo = { final: true, source: "pick" }): void {
  const modifier = patch.count === undefined ? patch : { ...patch, count: Math.round(clamp(patch.count, REPEAT_COUNT_RANGE)) };
  ed.edit("Change repeat", info, () => void runDraw(ed, "SET_TRANSFORM_MODIFIER", { ref, index, modifier }));
}

export const removeRepeat = (ed: EditorController, ref: GuidString, index: number): number => runDraw(ed, "REMOVE_TRANSFORM_MODIFIER", { ref, index });

export const moveRepeat = (ed: EditorController, ref: GuidString, from: number, to: number): number => (from === to ? Status.OK : runDraw(ed, "MOVE_TRANSFORM_MODIFIER", { ref, from, to }));

/**
 * The Gap field's value: px, or RELATIVE as a percent of the content's size. Switching the unit keeps the number
 * shown (16 px → 16 %) [ours: the content's box isn't known to the panel].
 */
export const gapShown = (m: RepeatModifierInput): number => (m.unitType === "RELATIVE" ? Math.round(m.offset * 10000) / 100 : m.offset);
export const gapStored = (shown: number, unit: RepeatModifierInput["unitType"]): number => (unit === "RELATIVE" ? shown / 100 : shown);

/** A transform group (TRANSFORM 48). */
export const isTransformGroup = (n: PanelNode): boolean => typeOf(n) === "TRANSFORM";
