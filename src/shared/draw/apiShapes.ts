/**
 * Figma Draw's document fields read in the Plugin API's shapes (developers.figma.com, Update 123: TextPathStartData,
 * TransformModifier, ComplexStrokeProperties) — one reading for the plugin API (`editor/plugins/api/draw.ts`), the REST
 * JSON (`editor/rest/fileJson.ts`) and Dev Mode (`editor/devmode/`), docs/draw.md §7. Pure functions over the
 * document's fields (schema 432 / 446–455), GUIDs in either form.
 */
import {
  brushDisplayName,
  DYNAMIC_DEFAULTS,
  isNeutralDynamic,
  isNoBrushGuid,
  SCATTER_BRUSH_NAMES,
  SCATTER_DEFAULTS,
  splitTValue,
  STRETCH_BRUSH_NAMES,
  type BrushType,
  type DynamicSettings,
  type ScatterSettings,
  type StrokeKind,
} from "./types";

type Obj = Record<string, unknown>;

/** The Plugin API's TransformModifier (LinearRepeatModifier | RadialRepeatModifier). */
export interface ApiRepeatModifier {
  type: "REPEAT";
  count: number;
  unitType: "RELATIVE" | "PIXELS";
  offset: number;
  repeatType: "LINEAR" | "RADIAL";
  axis?: "HORIZONTAL" | "VERTICAL";
}

/** A document TransformModifier (schema `TransformModifier`, Figma's fields, JSON form). */
export interface DocTransformModifier {
  type?: string;
  offset?: { x: number; y: number };
  visible?: boolean;
  count?: number;
  repeatType?: string;
  axis?: string;
  unitType?: string;
  order?: string;
  skewX?: number;
  skewY?: number;
}

/** A document modifier as the API reads it; null for SYMMETRY / SKEW (the API offers REPEAT only). */
export function modifierToApi(m: DocTransformModifier): ApiRepeatModifier | null {
  if ((m.type ?? "REPEAT") !== "REPEAT") return null;
  const radial = m.repeatType === "RADIAL";
  const out: ApiRepeatModifier = { type: "REPEAT", count: m.count ?? 1, unitType: m.unitType === "RELATIVE" ? "RELATIVE" : "PIXELS", offset: m.offset?.x ?? 0, repeatType: radial ? "RADIAL" : "LINEAR" };
  // LINEAR axis HORIZONTAL ↔ X, VERTICAL ↔ Y; X_AND_Y (kept from files, not offered) reads as HORIZONTAL [ours].
  if (!radial) out.axis = m.axis === "Y" ? "VERTICAL" : "HORIZONTAL";
  return out;
}

export const docModifiersOf = (fields: object): DocTransformModifier[] => ((fields as Obj).transformModifiers as DocTransformModifier[] | undefined) ?? [];

/** A transform group's REPEAT modifiers in the API's shape, in document order. */
export function repeatModifiersOf(fields: object): ApiRepeatModifier[] {
  return docModifiersOf(fields)
    .map(modifierToApi)
    .filter((m): m is ApiRepeatModifier => !!m);
}

/** TextPathNode.textPathStartData: `textPathStart.tValue` as {segment, position} (docs/draw.md §4.4's encoding). */
export function textPathStartOf(fields: object): { segment: number; position: number } {
  const start = (fields as Obj).textPathStart as { tValue?: number } | undefined;
  return splitTValue(typeof start?.tValue === "number" ? start.tValue : 0);
}

/** Does the text run the other way along its path (Flip; `textPathStart.forward === false`)? */
export const textPathFlipped = (fields: object): boolean => ((fields as Obj).textPathStart as { forward?: boolean } | undefined)?.forward === false;

/** "s:l" for a GUID in either form. */
export function guidText(g: unknown): string | null {
  if (typeof g === "string") return g || null;
  if (g && typeof g === "object" && "sessionID" in g && "localID" in g) return `${(g as { sessionID: number }).sessionID}:${(g as { localID: number }).localID}`;
  return null;
}

const STRETCH_KEYS: readonly string[] = STRETCH_BRUSH_NAMES;
const SCATTER_KEYS: readonly string[] = SCATTER_BRUSH_NAMES;

/** A BRUSH node's built-in key (its display name and type), or "CUSTOM". */
export function brushNameOf(name: string | undefined, type: BrushType): string {
  return (type === "STRETCH" ? STRETCH_KEYS : SCATTER_KEYS).find((k) => brushDisplayName(k as never) === name) ?? "CUSTOM";
}

export type ApiComplexStroke =
  | { type: "BASIC" }
  | ({ type: "DYNAMIC" } & DynamicSettings)
  | { type: "BRUSH"; brushType: "STRETCH"; brushName: string; direction: "FORWARD" | "BACKWARD" }
  | ({ type: "BRUSH"; brushType: "SCATTER"; brushName: string } & ScatterSettings);

/** The stroke's GUID of its BRUSH node, when it has a brush stroke (Figma's -1:-1 is no brush). */
export function strokeBrushOf(fields: object): string | null {
  const g = guidText((fields as Obj).strokeBrushGuid);
  return g && !isNoBrushGuid(g) ? g : null;
}

/**
 * The implicit stroke kind, Figma's rule (docs/draw.md §4.3, rea/vector.md §1): a brush GUID other than -1:-1 →
 * BRUSH; dynamicStrokeSettings present and not the neutral {1, 0, 0} → DYNAMIC; else BASIC.
 */
export function strokeKindOfFields(fields: object): StrokeKind {
  const f = fields as Obj;
  if (strokeBrushOf(f)) return "BRUSH";
  const d = f.dynamicStrokeSettings;
  if (d && typeof d === "object" && !isNeutralDynamic(d as Partial<DynamicSettings>)) return "DYNAMIC";
  return "BASIC";
}

/**
 * node.complexStrokeProperties from the document's implicit kind (`strokeKindOfFields`). `brush` is the BRUSH node
 * the stroke names (its `name` and `brushType`), if found.
 */
export function complexStrokeOf(fields: object, brush: { name?: string; brushType?: unknown } | null): ApiComplexStroke {
  const f = fields as Obj;
  const kind = strokeKindOfFields(f);
  if (kind === "BRUSH") {
    const type: BrushType = brush?.brushType === "SCATTER" || (!brush?.brushType && f.scatterStrokeSettings) ? "SCATTER" : "STRETCH";
    const brushName = brushNameOf(brush?.name, type);
    if (type === "STRETCH") {
      const s = f.stretchStrokeSettings as { orientation?: string } | undefined;
      return { type: "BRUSH", brushType: "STRETCH", brushName, direction: s?.orientation === "REVERSE" ? "BACKWARD" : "FORWARD" };
    }
    return { type: "BRUSH", brushType: "SCATTER", brushName, ...SCATTER_DEFAULTS, ...((f.scatterStrokeSettings as Partial<ScatterSettings> | undefined) ?? {}) };
  }
  if (kind === "DYNAMIC") return { type: "DYNAMIC", ...DYNAMIC_DEFAULTS, ...(f.dynamicStrokeSettings as Partial<DynamicSettings>) };
  return { type: "BASIC" };
}
