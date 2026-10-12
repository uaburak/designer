/**
 * The Plugin API for Figma Draw (docs/draw.md §7, docs/plugins.md "Draw"; Figma's Update 123, @figma/plugin-typings
 * 1.139.0): `TextPathNode` (`textPathStartData`), `TransformGroupNode` (`transformModifiers`), `ComplexStrokesMixin`
 * (`complexStrokeProperties`, `variableWidthStrokeProperties`), `figma.createTextPath`, `figma.transformGroup`,
 * `figma.loadBrushesAsync`.
 *
 * Reads come from the document's own fields (schema 432 / 446–455 / 482), so they work on any engine. Writes that need
 * the engine's Draw commands (CommandId 310–321, `Engine.runDrawCommand` / `installBrush` / `listBrushes`) are round
 * 7b's: until it lands, Engine.ts's stubs throw "not built" and these calls answer Figma-style "… is not supported in
 * DesignerV2 yet". `transformModifiers =` and `variableWidthStrokeProperties =` write document fields and work now.
 */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { brushDisplayName, DYNAMIC_RANGE, SCATTER_BRUSH_NAMES, SCATTER_DEFAULTS, SCATTER_RANGE, STRETCH_BRUSH_NAMES, type BrushType, type DrawCommandArgs, type GuidString } from "@shared/draw/types";
import { brushNameOf, complexStrokeOf, docModifiersOf, modifierToApi, repeatModifiersOf, strokeBrushOf, textPathStartOf, type ApiRepeatModifier, type DocTransformModifier } from "@shared/draw/apiShapes";
import { BUILTIN_BRUSHES } from "@shared/draw/brushes";
import { matchProfile, presetPoints, readWidthPoints, WIDTH_PROFILES, type WidthProfile } from "../../widthProfile";
import { ApiError } from "./codec";
import { mustNode, readNode, refOf, type ApiContext } from "./context";
import { writeFields } from "./nodes";

type Obj = Record<string, unknown>;

/** The engine's TRANSFORM (48) is the Plugin API's TRANSFORM_GROUP; TEXT_PATH (41) keeps its name. */
export const isTextPath = (n: Pick<NodeChange, "type">): boolean => (n.type as string) === "TEXT_PATH";
export const isTransformGroup = (n: Pick<NodeChange, "type">): boolean => (n.type as string) === "TRANSFORM";

// ---- The engine's Draw calls ---------------------------------------------------------------------------------------

/** An Engine.ts Draw call; its "not built" stub (until round 7b) becomes Figma's "not supported yet" error. */
function engineDraw<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /not built/.test(e.message)) throw new ApiError(`${what} is not supported in DesignerV2 yet`);
    throw e;
  }
}

function runDraw<K extends keyof DrawCommandArgs>(ctx: ApiContext, what: string, id: K, args: DrawCommandArgs[K]): void {
  ctx.write();
  const status = engineDraw(what, () => ctx.ed.engine.runDrawCommand(id, args));
  if (status === Status.E_UNSUPPORTED) throw new ApiError(`${what} is not supported in DesignerV2 yet`);
  if (status !== Status.OK) throw new ApiError(`in ${what}: the engine refused the change (status ${status})`);
}

const fieldsOfNode = (n: NodeChange): Obj => n as unknown as Obj;

// ---- Text on a path ------------------------------------------------------------------------------------------------

/** TextPathNode.textPathStartData (the shared reader, `@shared/draw/apiShapes`). */
export const textPathStartData = (n: NodeChange): { segment: number; position: number } => textPathStartOf(n);
function needStart(segment: unknown, position: unknown, what: string): { segment: number; position: number } {
  if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0) throw new ApiError(`in ${what}: segment must be a non-negative integer`);
  if (typeof position !== "number" || !(position >= 0 && position <= 1)) throw new ApiError(`in ${what}: position must be a number between 0 and 1`);
  return { segment, position };
}

export function setTextPathStartData(ctx: ApiContext, n: NodeChange, v: unknown): void {
  const o = (v ?? {}) as Obj;
  const start = needStart(o.segment, o.position, "set_textPathStartData");
  runDraw(ctx, "textPathStartData", "SET_TEXT_PATH_START", { ref: n.guid, ...start });
}

/** The types figma.createTextPath accepts (developers.figma.com: a vector, a rectangle, ellipse, polygon or star, or a line). */
const TEXT_PATH_SOURCES = new Set(["VECTOR", "ROUNDED_RECTANGLE", "RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "LINE"]);

/**
 * figma.createTextPath(node, startSegment, startPosition): CREATE_TEXT_PATH with `replace` — the source goes and a
 * TEXT_PATH takes its name, parent and index with a new GUID ("use the returned node", docs/draw.md §3.4).
 */
export function createTextPath(ctx: ApiContext, node: unknown, segment: unknown, position: unknown): unknown {
  const src = mustNode(ctx, node);
  if (!TEXT_PATH_SOURCES.has(src.type ?? "")) throw new ApiError("in createTextPath: the node must be a vector, rectangle, ellipse, polygon, star or line");
  const start = needStart(segment, position, "createTextPath");
  const parentId = src.parentIndex?.guid;
  const before = parentId ? ((readNode(ctx, parentId)?.childIds ?? []) as Guid[]) : [];
  const at = before.indexOf(src.guid);
  runDraw(ctx, "createTextPath", "CREATE_TEXT_PATH", { ref: src.guid, ...start, replace: true });
  const after = parentId ? ((readNode(ctx, parentId)?.childIds ?? []) as Guid[]) : [];
  const fresh = after.filter((id) => !before.includes(id));
  const made = (at >= 0 && after[at] && !before.includes(after[at]) ? after[at] : null) ?? fresh.find((id) => isTextPath(readNode(ctx, id, false) ?? {})) ?? fresh[0];
  if (!made) throw new ApiError("Couldn't create a text path from this node");
  return refOf(ctx, made);
}

// ---- Transform groups ----------------------------------------------------------------------------------------------

export { modifierToApi };

export function modifierFromApi(v: unknown, path: string): DocTransformModifier {
  if (!v || typeof v !== "object") throw new ApiError(`${path}: expected a TransformModifier`);
  const o = v as Obj;
  if (o.type !== "REPEAT") throw new ApiError(`${path}.type: invalid enum value '${String(o.type)}' (only 'REPEAT' is supported)`);
  if (o.repeatType !== "LINEAR" && o.repeatType !== "RADIAL") throw new ApiError(`${path}.repeatType: invalid enum value '${String(o.repeatType)}'`);
  if (o.unitType !== "RELATIVE" && o.unitType !== "PIXELS") throw new ApiError(`${path}.unitType: invalid enum value '${String(o.unitType)}'`);
  if (typeof o.count !== "number" || !Number.isFinite(o.count) || o.count < 1) throw new ApiError(`${path}.count: expected a number ≥ 1`);
  if (typeof o.offset !== "number" || !Number.isFinite(o.offset)) throw new ApiError(`${path}.offset: expected a number`);
  const out: DocTransformModifier = { type: "REPEAT", visible: true, count: Math.round(o.count), repeatType: o.repeatType, unitType: o.unitType, offset: { x: o.offset, y: 0 }, order: "FORWARD" };
  if (o.repeatType === "LINEAR") {
    if (o.axis !== "HORIZONTAL" && o.axis !== "VERTICAL") throw new ApiError(`${path}.axis: invalid enum value '${String(o.axis)}'`);
    out.axis = o.axis === "VERTICAL" ? "Y" : "X";
  } else out.axis = "X";
  return out;
}

export const transformModifiers = (n: NodeChange): ApiRepeatModifier[] => repeatModifiersOf(n);
/** `transformModifiers = [...]`: the REPEAT list replaced; SYMMETRY / SKEW the file had are kept after it. */
export function setTransformModifiers(ctx: ApiContext, n: NodeChange, v: unknown): void {
  if (!Array.isArray(v)) throw new ApiError("in set_transformModifiers: Expected an array of TransformModifier");
  const next = v.map((m, i) => modifierFromApi(m, `transformModifiers[${i}]`));
  const kept = docModifiersOf(n).filter((m) => (m.type ?? "REPEAT") !== "REPEAT");
  writeFields(ctx, n.guid, { transformModifiers: [...next, ...kept] } as unknown as NodeFields, "transformModifiers");
}

/**
 * figma.transformGroup(nodes, parent, index, modifiers): a TRANSFORM made around `nodes` (ADD_TRANSFORM_MODIFIER on
 * them, as Group ⌘G wraps), the modifiers written in order to the group [the doc's "each to the node at the same
 * position" read as a slip, docs/draw.md §4.2], then placed at `parent` / `index`.
 */
export function transformGroup(ctx: ApiContext, nodes: unknown, parent: unknown, index: number, modifiers: unknown): unknown {
  if (!Array.isArray(nodes) || !nodes.length) throw new ApiError("in transformGroup: First argument must be an array of at least one node");
  const ids = nodes.map((x) => mustNode(ctx, x).guid);
  if (typeof parent !== "string") throw new ApiError("in transformGroup: Second argument must be a parent node");
  const p = mustNode(ctx, parent);
  if (!Array.isArray(modifiers)) throw new ApiError("in transformGroup: Fourth argument must be an array of TransformModifier");
  const list = modifiers.map((m, i) => modifierFromApi(m, `modifiers[${i}]`));
  const first = list[0];
  runDraw(ctx, "transformGroup", "ADD_TRANSFORM_MODIFIER", {
    refs: ids,
    modifier: {
      repeatType: first?.repeatType === "RADIAL" ? "RADIAL" : "LINEAR",
      count: first?.count ?? 1,
      offset: first?.offset?.x ?? 0,
      unitType: first?.unitType === "RELATIVE" ? "RELATIVE" : "PIXELS",
      axis: first?.axis === "Y" ? "Y" : "X",
      order: "FORWARD",
      visible: true,
    },
  });
  const made = readNode(ctx, ids[0], false)?.parentIndex?.guid;
  const group = made ? readNode(ctx, made) : null;
  if (!group || !isTransformGroup(group)) throw new ApiError("Couldn't make a transform group of these nodes");
  writeFields(ctx, group.guid, { transformModifiers: list } as unknown as NodeFields, "transformModifiers");
  if (group.parentIndex?.guid !== p.guid || index >= 0) {
    const count = ((p.childIds ?? []) as Guid[]).filter((c) => c !== group.guid).length;
    ctx.ed.engine.moveNodes([group.guid], p.guid, index < 0 || index > count ? count : index);
  }
  return refOf(ctx, group.guid);
}

// ---- Complex strokes -------------------------------------------------------------------------------------------------

const STRETCH_KEYS: readonly string[] = STRETCH_BRUSH_NAMES;
const SCATTER_KEYS: readonly string[] = SCATTER_BRUSH_NAMES;

export { brushNameOf };

const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** node.complexStrokeProperties: BASIC / DYNAMIC / BRUSH, from the document's implicit kind (docs/draw.md §4.3). */
export function complexStrokeProperties(ctx: ApiContext, n: NodeChange): Obj {
  const brushGuid = strokeBrushOf(n);
  const brush = brushGuid ? (readNode(ctx, brushGuid, false) as unknown as { name?: string; brushType?: unknown } | null) : null;
  return complexStrokeOf(n, brush) as unknown as Obj;
}

function rangeCheck(o: Obj, key: string, range: readonly [number, number], path: string, upperOurs = false): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ApiError(`${path}.${key}: expected a number`);
  const [lo, hi] = range;
  if (v < lo || (!upperOurs && v > hi)) throw new ApiError(`${path}.${key}: must be between ${lo} and ${hi}`);
  return upperOurs ? clampTo(v, range) : v;
}

/** The installed BRUSH node of a built-in, by name and type (engine.listBrushes). */
function installedBrush(ctx: ApiContext, key: string, type: BrushType): GuidString | null {
  const name = brushDisplayName(key as never);
  const list = engineDraw("complexStrokeProperties", () => ctx.ed.engine.listBrushes());
  return list.find((b) => b.name === name && b.type === type)?.guid ?? null;
}

/** `complexStrokeProperties = …`: SET_STROKE_KIND, or SET_STROKE_BRUSH + SET_BRUSH_SETTINGS (a loaded built-in only). */
export function setComplexStrokeProperties(ctx: ApiContext, n: NodeChange, v: unknown): void {
  const path = "complexStrokeProperties";
  if (!v || typeof v !== "object") throw new ApiError(`in set_${path}: expected a ComplexStrokeProperties object`);
  const o = v as Obj;
  const refs = [n.guid];
  if (o.type === "BASIC") return runDraw(ctx, path, "SET_STROKE_KIND", { refs, kind: "BASIC" });
  if (o.type === "DYNAMIC") {
    // The plugin's ranges: frequency 0.01–20, wiggle ≥ 0, smoothen 0–1 (Figma gives wiggle no upper bound; ours clamps).
    const dynamic = { frequency: rangeCheck(o, "frequency", DYNAMIC_RANGE.frequency, path), wiggle: rangeCheck(o, "wiggle", DYNAMIC_RANGE.wiggle, path, true), smoothen: rangeCheck(o, "smoothen", DYNAMIC_RANGE.smoothen, path) };
    return runDraw(ctx, path, "SET_STROKE_KIND", { refs, kind: "DYNAMIC", dynamic });
  }
  if (o.type !== "BRUSH") throw new ApiError(`${path}.type: invalid enum value '${String(o.type)}'`);
  const type = o.brushType;
  if (type !== "STRETCH" && type !== "SCATTER") throw new ApiError(`${path}.brushType: invalid enum value '${String(type)}'`);
  const name = String(o.brushName ?? "");
  if (name === "CUSTOM") throw new ApiError("Setting a custom brush is not supported yet");
  if (!(type === "STRETCH" ? STRETCH_KEYS : SCATTER_KEYS).includes(name)) throw new ApiError(`${path}.brushName: invalid enum value '${name}' for a ${type.toLowerCase()} brush`);
  let settings: DrawCommandArgs["SET_BRUSH_SETTINGS"];
  if (type === "STRETCH") {
    const direction = o.direction ?? "FORWARD";
    if (direction !== "FORWARD" && direction !== "BACKWARD") throw new ApiError(`${path}.direction: invalid enum value '${String(direction)}'`);
    settings = { refs, stretch: { direction } };
  } else {
    const s = { ...SCATTER_DEFAULTS, ...o };
    settings = {
      refs,
      scatter: {
        gap: rangeCheck(s, "gap", SCATTER_RANGE.gap, path, true),
        wiggle: rangeCheck(s, "wiggle", SCATTER_RANGE.wiggle, path, true),
        sizeJitter: rangeCheck(s, "sizeJitter", SCATTER_RANGE.sizeJitter, path),
        angularJitter: rangeCheck(s, "angularJitter", SCATTER_RANGE.angularJitter, path),
        rotation: rangeCheck(s, "rotation", SCATTER_RANGE.rotation, path),
      },
    };
  }
  const brush = installedBrush(ctx, name, type);
  // Figma: "When setting a brush on a stroke, you must first ensure that the desired brushes are loaded with loadBrushesAsync".
  if (!brush) throw new ApiError(`The brush ${name} isn't loaded: call figma.loadBrushesAsync('${type}') first`);
  runDraw(ctx, path, "SET_STROKE_BRUSH", { refs, brush });
  runDraw(ctx, path, "SET_BRUSH_SETTINGS", settings);
}

/** figma.loadBrushesAsync(type): every built-in of that type installed into the file (BRUSH nodes on 0:2, §6). */
export function loadBrushes(ctx: ApiContext, type: unknown): void {
  if (type !== "STRETCH" && type !== "SCATTER") throw new ApiError(`in loadBrushesAsync: invalid brush type '${String(type)}' (expected 'STRETCH' or 'SCATTER')`);
  ctx.write();
  for (const b of BUILTIN_BRUSHES.filter((x) => x.type === type)) {
    const guid = engineDraw("loadBrushesAsync", () => ctx.ed.engine.installBrush({ name: b.name, type: b.type, artwork: b.artwork }));
    if (!guid) throw new ApiError(`loadBrushesAsync: the brush ${b.key} couldn't be installed`);
  }
}

// ---- Variable width ----------------------------------------------------------------------------------------------------

/** node.variableWidthStrokeProperties: null for dynamic and brush strokes (Figma: not with dynamic strokes), else the profile. */
export function variableWidthStrokeProperties(ctx: ApiContext, n: NodeChange): Obj | null {
  if (complexStrokeProperties(ctx, n).type !== "BASIC") return null;
  const points = readWidthPoints(fieldsOfNode(n).variableWidthPoints);
  const profile = matchProfile(points);
  if (profile !== "CUSTOM") return { widthProfile: profile };
  return { widthProfile: "CUSTOM", variableWidthPoints: points.map((p) => ({ position: p.position, width: p.ascent + p.descent })) };
}

const PRESETS = new Set<string>(WIDTH_PROFILES.map((p) => p.value));

/** `variableWidthStrokeProperties = …`: a preset's points or the custom ones (each split evenly about the path). */
export function setVariableWidthStrokeProperties(ctx: ApiContext, n: NodeChange, v: unknown): void {
  const path = "variableWidthStrokeProperties";
  if (complexStrokeProperties(ctx, n).type === "DYNAMIC") throw new ApiError(`in set_${path}: Variable width strokes are not supported in combination with dynamic strokes`);
  let points: { position: number; ascent: number; descent: number }[];
  if (v === null) points = [];
  else {
    const o = (v ?? {}) as Obj;
    const profile = String(o.widthProfile ?? "");
    if (profile === "CUSTOM") {
      if (!Array.isArray(o.variableWidthPoints)) throw new ApiError(`${path}.variableWidthPoints: expected an array`);
      points = (o.variableWidthPoints as Obj[]).map((p, i) => {
        const position = p?.position;
        const width = p?.width;
        if (typeof position !== "number" || position < 0 || position > 1) throw new ApiError(`${path}.variableWidthPoints[${i}].position: must be between 0 and 1`);
        if (typeof width !== "number" || width < 0) throw new ApiError(`${path}.variableWidthPoints[${i}].width: must be ≥ 0`);
        return { position, ascent: width / 2, descent: width / 2 };
      });
      points.sort((a, b) => a.position - b.position);
    } else if (PRESETS.has(profile)) points = presetPoints(profile as WidthProfile);
    else throw new ApiError(`${path}.widthProfile: invalid enum value '${profile}'`);
  }
  writeFields(ctx, n.guid, { variableWidthPoints: points } as unknown as NodeFields, path);
}
