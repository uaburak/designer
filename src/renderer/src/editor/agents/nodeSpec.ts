/**
 * The agents' layer properties (src/shared/agents/layerProps.ts: Plugin API names — layoutMode, itemSpacing,
 * layoutSizingHorizontal, characters … — and the panel's other fields under the document's names) to and from the
 * document's fields (schema/document.kiwi). One reader and one writer per property, so what get_design_context gives
 * is what update_nodes takes, and a write can be checked by reading it back (`notApplied`). Pure functions.
 */
import type { Color, Effect, Matrix, NodeChange, NodeFields, NodeType, Paint } from "@/engine/codec";
import { colorToHex, fromTool, parseColorValue, sameValue, toTool, nodeFieldType, type Errors } from "@shared/agents/docSchema";
import { NAMED_PROPS, RAW_FIELDS, RAW_GRID_FIELDS, RAW_TEXT_FIELDS, propForField } from "@shared/agents/layerProps";
import { DEFAULTS } from "@shared/schema/document.generated";
import { defaultEffect, defaultGuide, withBlurType } from "../panels/design/Effects";
import { DEFAULT_LINEAR_TRANSFORM } from "../model/paints";

export type Spec = Record<string, unknown>;
type Obj = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** "123-456" (a link's node-id) → "123:456"; anything else as it is. */
export const normId = (id: unknown): string => {
  const s = typeof id === "string" ? id.trim() : "";
  return /^\d+-\d+$/.test(s) ? s.replace("-", ":") : s;
};

/** A property that can't be written as given: the tool reports it with the reason. */
export class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

// ---- Colours and paints ---------------------------------------------------------------------------------------------

export function parseColor(v: unknown): Color | null {
  return parseColorValue(v);
}

export function colorHex(c: Color | undefined, opacity = 1): string {
  return colorToHex(c ? { ...c, a: (c.a ?? 1) * opacity } : undefined);
}

export const solid = (c: Color): Paint => ({ type: "SOLID", color: { ...c, a: 1 }, opacity: c.a ?? 1, visible: true, blendMode: "NORMAL" });

const IDENTITY_M: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const isGradient = (t: string) => t.startsWith("GRADIENT_");

/** A new paint of `type` as the Design panel makes it (missing fields of a spec take these). */
function paintDefaults(type: string): Obj {
  const base = { type, opacity: 1, visible: true, blendMode: "NORMAL" };
  if (isGradient(type)) return { ...base, transform: type === "GRADIENT_LINEAR" ? DEFAULT_LINEAR_TRANSFORM : IDENTITY_M };
  if (type === "IMAGE" || type === "VIDEO") return { ...base, imageScaleMode: "FILL", transform: IDENTITY_M };
  if (type === "PATTERN") return { ...base, scale: 1, patternSpacing: { x: 0, y: 0 }, patternTileType: "RECTANGULAR", horizontalAlignment: "START", verticalAlignment: "START", transform: IDENTITY_M };
  if (type === "NOISE") return { ...base, color: { r: 0, g: 0, b: 0, a: 0.25 }, noiseType: "MONOTONE", density: 1, noiseSize: { x: 0.5, y: 0.5 } };
  return { ...base, color: { r: 0, g: 0, b: 0, a: 1 } };
}

/** "#hex" | [paint spec] → paints; errors name the paint and field. */
export function parsePaints(v: unknown, path: string, errors: Errors): Paint[] | undefined {
  if (v === null || (Array.isArray(v) && v.length === 0)) return [];
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
  if (!list) return void errors.push(`${path}: "#RRGGBB" or a list of paints`);
  const out: Paint[] = [];
  list.forEach((p, i) => {
    const at = `${path}[${i}]`;
    if (typeof p === "string") {
      const c = parseColor(p);
      if (c) out.push(solid(c));
      else errors.push(`${at}: ${JSON.stringify(p)} is not a colour`);
      return;
    }
    if (!p || typeof p !== "object") return void errors.push(`${at}: a paint object`);
    const spec = p as Obj;
    const type = str(spec.type)?.toUpperCase() ?? (spec.imageRef || spec.imageHash ? "IMAGE" : "SOLID");
    const before = errors.length;
    const parsed = fromTool("Paint", false, { ...spec, type }, at, errors) as Obj | undefined;
    if (!parsed || errors.length > before) return;
    const paint = { ...paintDefaults(String(parsed.type)), ...parsed } as Obj;
    if (paint.type === "SOLID") {
      const c = (paint.color ?? { r: 0, g: 0, b: 0, a: 1 }) as Color;
      paint.opacity = ((parsed.opacity as number | undefined) ?? 1) * (c.a ?? 1);
      paint.color = { ...c, a: 1 };
    }
    if (isGradient(String(paint.type)) && !(Array.isArray(paint.stops) && paint.stops.length >= 2)) return void errors.push(`${at}.stops: a gradient needs at least two stops [{color, position}]`);
    if ((paint.type === "IMAGE" || paint.type === "VIDEO") && !paint.image && !paint.video) return void errors.push(`${at}.imageRef: an image's hash (read one with get_design_context, or place an image in the app)`);
    if (paint.type === "VIDEO" && !paint.video) return void errors.push(`${at}.videoRef: the video's hash`);
    if (paint.type === "PATTERN" && !paint.sourceNodeId) return void errors.push(`${at}.sourceNodeId: the layer to tile ("123:456")`);
    if (paint.type === "CUSTOM" && !paint.customEffectId) return void errors.push(`${at}.customEffectId: a shader paint needs its shader (copy one read from get_design_context)`);
    out.push(paint as unknown as Paint);
  });
  return out;
}

/** Paints as the tools read them (a solid's opacity is its colour's alpha). */
export function describePaints(paints: readonly Paint[] | undefined): unknown[] {
  return (paints ?? []).map((p) => {
    const t = toTool("Paint", false, p) as Obj;
    if (p.type === "SOLID") {
      t.color = colorHex(p.color, p.opacity ?? 1);
      delete t.opacity;
    }
    if (p.type !== "SOLID" && p.type !== "NOISE" && p.type !== "CUSTOM") delete t.color;
    return t;
  });
}

/** An image hash as hex (the engine gives 20 numbers or a hex string). */
export function imageHash(p: Paint): string | null {
  const h = p.image?.hash;
  if (typeof h === "string") return h.toLowerCase();
  if (Array.isArray(h)) return h.map((x) => (x & 255).toString(16).padStart(2, "0")).join("");
  return null;
}

// ---- Effects and guides -----------------------------------------------------------------------------------------------

export function parseEffects(v: unknown, path: string, errors: Errors): Effect[] | undefined {
  if (!Array.isArray(v)) return void errors.push(`${path}: a list of effects ([] for none)`);
  const out: Effect[] = [];
  v.forEach((e, i) => {
    const at = `${path}[${i}]`;
    if (!e || typeof e !== "object") return void errors.push(`${at}: an effect object`);
    const before = errors.length;
    const parsed = fromTool("Effect", false, { type: "DROP_SHADOW", ...(e as Obj) }, at, errors) as Obj | undefined;
    if (!parsed || errors.length > before) return;
    let effect = { ...defaultEffect(parsed.type as Effect["type"]), ...parsed } as Effect;
    if (effect.blurOpType === "PROGRESSIVE") effect = { ...withBlurType(effect, true), ...parsed } as Effect;
    if (effect.type === "CUSTOM" && !effect.customEffectId) return void errors.push(`${at}.customEffectId: a shader effect needs its shader`);
    out.push(effect);
  });
  return out;
}

/** The fields each effect type has in the panel (the engine keeps the others at their zero values). */
const EFFECT_FIELDS: Record<string, string[]> = {
  shadow: ["color", "offset", "radius", "spread", "showShadowBehindNode", "blendMode"],
  blur: ["radius", "blurOpType", "startRadius", "startOffset", "endOffset"],
  NOISE: ["noiseType", "color", "secondaryColor", "density", "opacity", "noiseSize", "seed", "blendMode"],
  TEXTURE: ["noiseSize", "radius", "clipToShape", "seed"],
  GLASS: ["radius", "specularAngle", "specularIntensity", "refractionIntensity", "bevelSize", "chromaticAberration", "refractionRadius", "reflectionDistance"],
  CUSTOM: ["customEffectId", "componentPropAssignments", "blendMode"],
};

export const describeEffects = (effects: readonly Effect[] | undefined): unknown[] =>
  (effects ?? []).map((e) => {
    const t = toTool("Effect", false, e) as Obj;
    const kind = t.type === "DROP_SHADOW" || t.type === "INNER_SHADOW" ? "shadow" : t.type === "LAYER_BLUR" || t.type === "BACKGROUND_BLUR" ? "blur" : String(t.type);
    const keep = EFFECT_FIELDS[kind];
    if (!keep) return t;
    return Object.fromEntries(Object.entries(t).filter(([k]) => k === "type" || k === "visible" || keep.includes(k)));
  });

function parseGrids(v: unknown, path: string, errors: Errors): unknown[] | undefined {
  if (!Array.isArray(v)) return void errors.push(`${path}: a list of layout guides ([] for none)`);
  const out: unknown[] = [];
  v.forEach((g, i) => {
    const before = errors.length;
    const parsed = fromTool("LayoutGrid", false, g, `${path}[${i}]`, errors) as Obj | undefined;
    if (!parsed || errors.length > before) return;
    const kind = parsed.pattern === "STRIPES" ? (parsed.axis === "Y" ? "ROWS" : "COLUMNS") : "GRID";
    out.push({ ...defaultGuide(kind), ...parsed });
  });
  return out;
}

// ---- Geometry -------------------------------------------------------------------------------------------------------

export const IDENTITY: Matrix = IDENTITY_M;

export const rotationOf = (t: Matrix | undefined) => (t ? Math.round(((Math.atan2(t.m10, t.m00) * 180) / Math.PI) * 100) / 100 : 0);

export function matrixAt(x: number, y: number, degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return { m00: c, m01: -s, m02: x, m10: s, m11: c, m12: y };
}

// ---- Auto layout ----------------------------------------------------------------------------------------------------

const HUG = "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE";
export const isHug = (v: unknown) => v === undefined || v === "RESIZE_TO_FIT" || v === HUG;

export type Axis = "H" | "V";
export type Sizing = "FIXED" | "HUG" | "FILL";

const flowMode = (n: NodeChange | null) => (n?.stackMode && n.stackMode !== "NONE" && n.stackMode !== "GRID" ? n.stackMode : null);
const hasAutoLayout = (n: NodeChange | null) => !!n?.stackMode && n.stackMode !== "NONE";

/** A layer's sizing on an axis, as the Plugin API's layoutSizingHorizontal / Vertical reads it. */
export function sizingOf(n: NodeChange, parent: NodeChange | null, axis: Axis): Sizing {
  const pMode = flowMode(parent);
  if (pMode && n.stackPositioning !== "ABSOLUTE") {
    const primary = (pMode === "HORIZONTAL") === (axis === "H");
    if (primary ? (n.stackChildPrimaryGrow ?? 0) > 0 : n.stackChildAlignSelf === "STRETCH") return "FILL";
  }
  const own = flowMode(n);
  if (own) {
    const primary = (own === "HORIZONTAL") === (axis === "H");
    return isHug(primary ? n.stackPrimarySizing : n.stackCounterSizing) ? "HUG" : "FIXED";
  }
  if (n.type === "TEXT") {
    const r = n.textAutoResize ?? "NONE";
    if (r === "WIDTH_AND_HEIGHT") return "HUG";
    if (r === "HEIGHT" && axis === "V") return "HUG";
  }
  return "FIXED";
}

/** Fields that make a layer FIXED / HUG / FILL on an axis (its own type and auto layout, and its parent's). */
export function sizingFields(n: NodeChange, parent: NodeChange | null, axis: Axis, sizing: Sizing): NodeFields {
  const out: NodeFields = {};
  const pMode = flowMode(parent);
  const ownMode = flowMode(n);
  if (pMode) {
    const primary = (pMode === "HORIZONTAL") === (axis === "H");
    if (primary) out.stackChildPrimaryGrow = sizing === "FILL" ? 1 : 0;
    else out.stackChildAlignSelf = sizing === "FILL" ? "STRETCH" : "AUTO";
  }
  if (ownMode) {
    const primary = (ownMode === "HORIZONTAL") === (axis === "H");
    const key = primary ? "stackPrimarySizing" : "stackCounterSizing";
    out[key] = sizing === "HUG" ? HUG : "FIXED";
  }
  if (n.type === "TEXT") {
    const r = (n.textAutoResize ?? "NONE") as string;
    if (axis === "H") out.textAutoResize = sizing === "HUG" ? "WIDTH_AND_HEIGHT" : r === "WIDTH_AND_HEIGHT" ? "HEIGHT" : (r as NodeFields["textAutoResize"]);
    else out.textAutoResize = sizing === "HUG" ? (r === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "HEIGHT") : r === "NONE" ? "NONE" : r === "WIDTH_AND_HEIGHT" ? "WIDTH_AND_HEIGHT" : "NONE";
  }
  return out;
}

/** The auto layout container fields of a spec (layoutMode, itemSpacing, padding …), for set_auto_layout. */
export function autoLayoutFields(spec: Spec, current: NodeChange | null, creating = false): NodeFields {
  const keys = ["layoutMode", "itemSpacing", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap", "counterAxisSpacing", "counterAxisAlignContent", "primaryAxisSizingMode", "counterAxisSizingMode", "itemReverseZIndex", "strokesIncludedInLayout"];
  const sub: Spec = {};
  for (const k of keys) if (spec[k] !== undefined) sub[k] = spec[k];
  if (spec.width !== undefined) sub.width = spec.width;
  if (spec.height !== undefined) sub.height = spec.height;
  const r = fieldsOf(sub, current ?? ({ type: "FRAME" } as NodeChange), null, creating);
  if (r.rejected.length) throw new Reject(r.rejected.map((x) => `${x.property}: ${x.reason}`).join("; "));
  delete r.fields.size;
  return r.fields;
}

// ---- Text -----------------------------------------------------------------------------------------------------------

function parseLineHeight(v: unknown): NodeFields["lineHeight"] {
  if (typeof v === "number") return { value: v, units: "PIXELS" };
  if (v && typeof v === "object" && "value" in v && "unit" in v) {
    const o = v as { value: number; unit: string };
    if (o.unit === "AUTO") return { value: 100, units: "PERCENT" };
    return o.unit === "PERCENT" ? { value: o.value / 100, units: "RAW" } : { value: o.value, units: "PIXELS" };
  }
  if (typeof v !== "string") return reject('a number (px), "150%" or "auto"');
  if (/^auto$/i.test(v.trim())) return { value: 100, units: "PERCENT" };
  const m = /^([\d.]+)\s*%$/.exec(v.trim());
  if (m) return { value: +m[1] / 100, units: "RAW" };
  const px = /^([\d.]+)\s*(px)?$/.exec(v.trim());
  return px ? { value: +px[1], units: "PIXELS" } : reject('a number (px), "150%" or "auto"');
}

function parseLetterSpacing(v: unknown): NodeFields["letterSpacing"] {
  if (typeof v === "number") return { value: v, units: "PIXELS" };
  if (typeof v !== "string") return reject('a number (px) or "2%"');
  const m = /^(-?[\d.]+)\s*(%|px)?$/.exec(v.trim());
  return m ? { value: +m[1], units: m[2] === "%" ? "PERCENT" : "PIXELS" } : reject('a number (px) or "2%"');
}

export function describeLineHeight(v: NodeChange["lineHeight"]): string | number {
  if (!v || (v.units === "PERCENT" && v.value === 100)) return "auto";
  if (v.units === "RAW") return `${Math.round(v.value * 1000) / 10}%`;
  if (v.units === "PERCENT") return `${v.value}%`;
  return Math.round(v.value * 100) / 100;
}

const describeLetterSpacing = (v: NodeChange["letterSpacing"]) => (!v ? 0 : v.units === "PERCENT" ? `${Math.round(v.value * 100) / 100}%` : Math.round(v.value * 100) / 100);

// ---- Node types -----------------------------------------------------------------------------------------------------

const TYPES: Record<string, NodeType> = { FRAME: "FRAME", RECTANGLE: "ROUNDED_RECTANGLE", ROUNDED_RECTANGLE: "ROUNDED_RECTANGLE", ELLIPSE: "ELLIPSE", TEXT: "TEXT", LINE: "LINE", GROUP: "GROUP", POLYGON: "REGULAR_POLYGON", REGULAR_POLYGON: "REGULAR_POLYGON", STAR: "STAR", SECTION: "SECTION" };
export const nodeTypeOf = (v: unknown): NodeType | null => TYPES[String(v ?? "").toUpperCase()] ?? null;
export const CREATABLE_TYPES = ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "GROUP", "POLYGON", "STAR", "SECTION"];

/** Defaults of a new layer (Figma's: a white frame that clips, #D9D9D9 shapes, black Inter text). */
export function defaults(type: NodeType): NodeFields {
  switch (type) {
    case "FRAME":
      return { fillPaints: [solid({ r: 1, g: 1, b: 1, a: 1 })], frameMaskDisabled: false, size: { x: 100, y: 100 } };
    case "SECTION":
      return { fillPaints: [solid({ r: 1, g: 1, b: 1, a: 1 })], size: { x: 400, y: 400 } };
    case "TEXT":
      return { fillPaints: [solid({ r: 0, g: 0, b: 0, a: 1 })], fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 16, textAutoResize: "WIDTH_AND_HEIGHT", size: { x: 100, y: 20 }, autoRename: true };
    case "LINE":
      return { strokePaints: [solid({ r: 0, g: 0, b: 0, a: 1 })], strokeWeight: 1, size: { x: 100, y: 0 } };
    case "GROUP":
      return { size: { x: 100, y: 100 } };
    case "REGULAR_POLYGON":
      return { fillPaints: [solid({ r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 })], size: { x: 100, y: 100 }, count: 3 } as NodeFields;
    case "STAR":
      return { fillPaints: [solid({ r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 })], size: { x: 100, y: 100 }, count: 5, starInnerScale: 0.382 } as NodeFields;
    default:
      return { fillPaints: [solid({ r: 0xd9 / 255, g: 0xd9 / 255, b: 0xd9 / 255, a: 1 })], size: { x: 100, y: 100 } };
  }
}

/** The type as the Plugin API names it. */
export const typeName = (t: string | undefined) => (t === "ROUNDED_RECTANGLE" ? "RECTANGLE" : t === "SYMBOL" ? "COMPONENT" : t === "CANVAS" ? "PAGE" : t === "REGULAR_POLYGON" ? "POLYGON" : (t ?? "NONE"));

const FRAMEISH = new Set(["FRAME", "SYMBOL", "INSTANCE"]);
const isText = (n: NodeChange) => n.type === "TEXT";
const isFrameish = (n: NodeChange) => FRAMEISH.has(n.type ?? "");
const hasCorners = (n: NodeChange) => !["TEXT", "LINE", "GROUP", "CANVAS", "BOOLEAN_OPERATION", "SECTION"].includes(n.type ?? "");
const hasStrokeSides = (n: NodeChange) => ["FRAME", "SYMBOL", "INSTANCE", "ROUNDED_RECTANGLE", "RECTANGLE"].includes(n.type ?? "");

// ---- The properties --------------------------------------------------------------------------------------------------

interface Ctx {
  /** The layer as the fields so far make it */
  node: NodeChange;
  parent: NodeChange | null;
  creating: boolean;
  spec: Spec;
}

interface PropImpl {
  /** Why it doesn't apply to this layer (null: it does). */
  on?: (n: NodeChange, parent: NodeChange | null) => string | null;
  read: (n: NodeChange, parent: NodeChange | null) => unknown;
  /** Left out of get_design_context when it reads as this (default: empty — 0, false, "", []). */
  hidden?: (v: unknown, n: NodeChange, parent: NodeChange | null) => boolean;
  write: (v: unknown, ctx: Ctx) => NodeFields;
}

const textOnly = (n: NodeChange) => (isText(n) ? null : "only for TEXT layers");
const framesOnly = (n: NodeChange) => (isFrameish(n) ? null : `only for frames, components and instances (this is a ${typeName(n.type)})`);
const notPage = (n: NodeChange) => (n.type === "CANVAS" ? "not for pages" : null);
const inAutoLayout = (_n: NodeChange, p: NodeChange | null) => (flowMode(p) ? null : "only for layers in an auto layout frame");

const needNum = (v: unknown, min?: number, max?: number): number => {
  const n = num(v);
  if (n === undefined) return reject("a number");
  if (min !== undefined && n < min) return reject(`${min} or more`);
  if (max !== undefined && n > max) return reject(`${max} or less`);
  return n;
};
const needBool = (v: unknown): boolean => (typeof v === "boolean" ? v : reject("true or false"));
const needEnum = <T extends string>(v: unknown, values: readonly T[]): T => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (values as readonly string[]).includes(s) ? (s as T) : reject(`one of ${values.join(", ")}`);
};
const enumOf = (name: string) => (NAMED_PROPS[name].schema as { enum: string[] }).enum;
/** A Plugin-named property for one document field: as it is. */
const plain = (field: keyof NodeFields & string, check: (v: unknown) => unknown, extra: Partial<PropImpl> = {}): PropImpl => ({
  read: (n) => (n as unknown as Obj)[field],
  write: (v) => ({ [field]: check(v) }) as NodeFields,
  ...extra,
});
const enumProp = (name: string, field: keyof NodeFields & string, extra: Partial<PropImpl> = {}) => plain(field, (v) => needEnum(v, enumOf(name)), extra);

const geometry = (n: NodeChange) => n.transform ?? IDENTITY_M;
const r2 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100) / 100);

function paddingOf(n: NodeChange): number[] {
  return [n.stackVerticalPadding ?? 0, n.stackPaddingRight ?? n.stackHorizontalPadding ?? 0, n.stackPaddingBottom ?? n.stackVerticalPadding ?? 0, n.stackHorizontalPadding ?? 0];
}

function cornersOf(n: NodeChange): number | number[] {
  if (n.rectangleCornerRadiiIndependent) return [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0];
  return n.cornerRadius ?? 0;
}

const sizing = (axis: Axis): PropImpl => ({
  on: (n, p) => (n.type === "CANVAS" ? "not for pages" : flowMode(p) || flowMode(n) || isText(n) ? null : "only in an auto layout frame, or for an auto layout frame or a text"),
  read: (n, p) => sizingOf(n, p, axis),
  hidden: (_v, n, p) => !(flowMode(p) || hasAutoLayout(n) || isText(n)),
  write: (v, ctx) => {
    const s = needEnum(v, ["FIXED", "HUG", "FILL"] as const);
    if (s === "FILL" && !flowMode(ctx.parent)) reject("FILL needs an auto layout parent");
    if (s === "HUG" && !flowMode(ctx.node) && !isText(ctx.node)) reject("HUG needs an auto layout frame or a text");
    if (s !== "FIXED" && ctx.node.stackPositioning === "ABSOLUTE" && s === "FILL") reject("an absolute layer can't fill");
    return sizingFields(ctx.node, ctx.parent, axis, s);
  },
});

const limit = (which: "minSize" | "maxSize", c: "x" | "y"): PropImpl => ({
  on: (n, p) => (flowMode(p) || hasAutoLayout(n) ? null : "only for auto layout frames and layers in them"),
  read: (n) => (n[which] as { value?: { x: number; y: number } } | undefined)?.value?.[c] ?? null,
  hidden: (v) => v === null || v === 0,
  write: (v, ctx) => {
    const cur = (ctx.node[which] as { value?: { x: number; y: number } } | undefined)?.value ?? { x: 0, y: 0 };
    if (v === null) return { [which]: { value: { ...cur, [c]: 0 } } } as NodeFields;
    return { [which]: { value: { ...cur, [c]: needNum(v, 0) } } } as NodeFields;
  },
});

const strokeSide = (field: "borderTopWeight" | "borderRightWeight" | "borderBottomWeight" | "borderLeftWeight"): PropImpl => ({
  on: (n) => (hasStrokeSides(n) ? null : "only for frames and rectangles"),
  read: (n) => (n.borderStrokeWeightsIndependent ? (n[field] ?? 0) : (n.strokeWeight ?? 1)),
  hidden: (_v, n) => !n.borderStrokeWeightsIndependent,
  write: (v, ctx) => {
    const w = needNum(v, 0);
    const n = ctx.node;
    const base = n.borderStrokeWeightsIndependent ? {} : { borderTopWeight: n.strokeWeight ?? 1, borderRightWeight: n.strokeWeight ?? 1, borderBottomWeight: n.strokeWeight ?? 1, borderLeftWeight: n.strokeWeight ?? 1 };
    return { ...base, [field]: w, borderStrokeWeightsIndependent: true } as NodeFields;
  },
});

const paints = (field: "fillPaints" | "strokePaints", key: string): PropImpl => ({
  on: notPage,
  read: (n) => describePaints(n[field]),
  write: (v) => {
    const errors: Errors = [];
    const p = parsePaints(v, key, errors);
    if (errors.length || !p) reject(errors.join("; "));
    return { [field]: p } as NodeFields;
  },
});

const pad = (field: "stackVerticalPadding" | "stackPaddingRight" | "stackPaddingBottom" | "stackHorizontalPadding"): PropImpl => ({ on: framesOnly, read: (n) => (n as unknown as Obj)[field] ?? 0, write: (v) => ({ [field]: needNum(v) }) as NodeFields });

const PROPS: Record<string, PropImpl> = {
  name: { read: (n) => n.name ?? "", hidden: () => false, write: (v) => ({ name: typeof v === "string" ? v : reject("a string") }) },
  visible: plain("visible", needBool, { read: (n) => n.visible !== false, hidden: (v) => v === true }),
  locked: plain("locked", needBool),
  opacity: plain("opacity", (v) => needNum(v, 0, 1), { read: (n) => n.opacity ?? 1, hidden: (v) => v === 1, on: notPage }),
  blendMode: enumProp("blendMode", "blendMode", { read: (n) => n.blendMode ?? "PASS_THROUGH", hidden: (v) => v === "PASS_THROUGH" || v === "NORMAL", on: notPage }),
  isMask: plain("mask", needBool, { on: notPage }),
  maskType: enumProp("maskType", "maskType", { read: (n) => (n.mask ? (n.maskType ?? "ALPHA") : undefined), on: notPage }),
  // Auto layout, as a container.
  layoutMode: {
    on: framesOnly,
    read: (n) => n.stackMode ?? "NONE",
    hidden: (v) => v === "NONE",
    write: (v, ctx) => {
      const mode = needEnum(v, ["NONE", "HORIZONTAL", "VERTICAL", "GRID"] as const);
      const out: NodeFields = { stackMode: mode };
      const was = ctx.node.stackMode && ctx.node.stackMode !== "NONE";
      // A new auto layout frame hugs along an axis unless its size there was given (the Plugin API's defaults); an
      // existing frame turned into auto layout keeps its size (Figma's ⇧A).
      if ((mode === "HORIZONTAL" || mode === "VERTICAL") && !was) {
        const given = (axis: "width" | "height") => typeof ctx.spec[axis] === "number";
        const [primary, counter] = mode === "HORIZONTAL" ? (["width", "height"] as const) : (["height", "width"] as const);
        const keep = !ctx.creating;
        if (ctx.spec.primaryAxisSizingMode === undefined) out.stackPrimarySizing = keep || given(primary) ? "FIXED" : HUG;
        if (ctx.spec.counterAxisSizingMode === undefined) out.stackCounterSizing = keep || given(counter) ? "FIXED" : HUG;
      }
      if (mode === "NONE") out.stackWrap = "NO_WRAP";
      return out;
    },
  },
  itemSpacing: { on: framesOnly, read: (n) => (hasAutoLayout(n) ? (n.stackSpacing ?? 0) : undefined), write: (v) => ({ stackSpacing: needNum(v) }) },
  padding: {
    on: framesOnly,
    read: (n) => (hasAutoLayout(n) ? paddingOf(n) : undefined),
    hidden: (v) => !Array.isArray(v) || v.every((x) => !x),
    write: (v) => {
      if (typeof v !== "number" && !(Array.isArray(v) && (v.length === 2 || v.length === 4) && v.every((x) => typeof x === "number"))) reject("a number, [vertical, horizontal] or [top, right, bottom, left]");
      const p = v as number | number[];
      const [t, r, b, l] = typeof p === "number" ? [p, p, p, p] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
      return { stackVerticalPadding: t, stackPaddingRight: r, stackPaddingBottom: b, stackHorizontalPadding: l };
    },
  },
  paddingTop: { ...pad("stackVerticalPadding"), hidden: () => true },
  paddingRight: { ...pad("stackPaddingRight"), hidden: () => true },
  paddingBottom: { ...pad("stackPaddingBottom"), hidden: () => true },
  paddingLeft: { ...pad("stackHorizontalPadding"), hidden: () => true },
  primaryAxisAlignItems: enumProp("primaryAxisAlignItems", "stackPrimaryAlignItems", { on: framesOnly, read: (n) => (hasAutoLayout(n) ? (n.stackPrimaryAlignItems ?? "MIN") : undefined), hidden: (v) => !v || v === "MIN" }),
  counterAxisAlignItems: enumProp("counterAxisAlignItems", "stackCounterAlignItems", { on: framesOnly, read: (n) => (hasAutoLayout(n) ? (n.stackCounterAlignItems ?? "MIN") : undefined), hidden: (v) => !v || v === "MIN" }),
  layoutWrap: enumProp("layoutWrap", "stackWrap", { on: framesOnly, read: (n) => (hasAutoLayout(n) ? (n.stackWrap ?? "NO_WRAP") : undefined), hidden: (v) => !v || v === "NO_WRAP" }),
  counterAxisSpacing: { on: framesOnly, read: (n) => (n.stackWrap === "WRAP" ? (n.stackCounterSpacing ?? n.stackSpacing ?? 0) : undefined), write: (v) => ({ stackCounterSpacing: needNum(v) }) },
  counterAxisAlignContent: enumProp("counterAxisAlignContent", "stackCounterAlignContent", { on: framesOnly, read: (n) => (n.stackWrap === "WRAP" ? ((n as unknown as Obj).stackCounterAlignContent ?? "AUTO") : undefined), hidden: (v) => !v || v === "AUTO" }),
  primaryAxisSizingMode: {
    on: framesOnly,
    read: (n) => (hasAutoLayout(n) ? (isHug(n.stackPrimarySizing) ? "AUTO" : "FIXED") : undefined),
    hidden: () => true,
    write: (v) => ({ stackPrimarySizing: needEnum(v, ["FIXED", "AUTO"] as const) === "AUTO" ? HUG : "FIXED" }),
  },
  counterAxisSizingMode: {
    on: framesOnly,
    read: (n) => (hasAutoLayout(n) ? (isHug(n.stackCounterSizing) ? "AUTO" : "FIXED") : undefined),
    hidden: () => true,
    write: (v) => ({ stackCounterSizing: needEnum(v, ["FIXED", "AUTO"] as const) === "AUTO" ? HUG : "FIXED" }),
  },
  itemReverseZIndex: plain("stackReverseZIndex" as keyof NodeFields & string, needBool, { on: framesOnly }),
  strokesIncludedInLayout: plain("bordersTakeSpace" as keyof NodeFields & string, needBool, { on: framesOnly }),
  clipsContent: { on: framesOnly, read: (n) => n.frameMaskDisabled !== true, hidden: () => false, write: (v) => ({ frameMaskDisabled: !needBool(v) }) },
  // Text.
  characters: { on: textOnly, read: (n) => n.textData?.characters ?? "", hidden: () => false, write: (v) => ({ textData: { characters: typeof v === "string" ? v : reject("a string") } }) },
  fontFamily: { on: textOnly, read: (n) => n.fontName?.family ?? "Inter", hidden: () => false, write: (v, ctx) => ({ fontName: { family: typeof v === "string" && v.trim() ? v.trim() : reject("a font family name"), style: str(ctx.spec.fontStyle) ?? ctx.node.fontName?.style ?? "Regular", postscript: "" } }) },
  fontStyle: { on: textOnly, read: (n) => n.fontName?.style ?? "Regular", hidden: () => false, write: (v, ctx) => ({ fontName: { family: ctx.node.fontName?.family ?? "Inter", style: typeof v === "string" && v.trim() ? v.trim() : reject('a style name ("Bold")'), postscript: "" } }) },
  fontSize: { on: textOnly, read: (n) => n.fontSize ?? 12, hidden: () => false, write: (v) => ({ fontSize: needNum(v, 1) }) },
  lineHeight: { on: textOnly, read: (n) => describeLineHeight(n.lineHeight), hidden: (v) => v === "auto", write: (v) => ({ lineHeight: parseLineHeight(v) }) },
  letterSpacing: { on: textOnly, read: (n) => describeLetterSpacing(n.letterSpacing), write: (v) => ({ letterSpacing: parseLetterSpacing(v) }) },
  textAlignHorizontal: enumProp("textAlignHorizontal", "textAlignHorizontal", { on: textOnly, read: (n) => n.textAlignHorizontal ?? "LEFT", hidden: (v) => v === "LEFT" }),
  textAutoResize: enumProp("textAutoResize", "textAutoResize", { on: textOnly, read: (n) => n.textAutoResize ?? "NONE", hidden: () => false }),
  // Paints, strokes, effects, guides.
  fills: paints("fillPaints", "fills"),
  strokes: paints("strokePaints", "strokes"),
  strokeWeight: { on: notPage, read: (n) => (n.strokePaints?.length ? (n.strokeWeight ?? 1) : undefined), write: (v) => ({ strokeWeight: needNum(v, 0) }) },
  strokeAlign: enumProp("strokeAlign", "strokeAlign", { on: notPage, read: (n) => (n.strokePaints?.length ? (n.strokeAlign ?? "CENTER") : undefined) }),
  strokeCap: enumProp("strokeCap", "strokeCap", { on: notPage, read: (n) => n.strokeCap ?? "NONE", hidden: (v) => v === "NONE" }),
  strokeJoin: enumProp("strokeJoin", "strokeJoin", { on: notPage, read: (n) => n.strokeJoin ?? "MITER", hidden: (v) => v === "MITER" }),
  strokeMiterLimit: { on: notPage, read: (n) => (n as unknown as Obj).miterLimit ?? 4, hidden: (v) => v === 4, write: (v) => ({ miterLimit: needNum(v, 0) }) as NodeFields },
  strokeTopWeight: strokeSide("borderTopWeight"),
  strokeRightWeight: strokeSide("borderRightWeight"),
  strokeBottomWeight: strokeSide("borderBottomWeight"),
  strokeLeftWeight: strokeSide("borderLeftWeight"),
  effects: {
    on: notPage,
    read: (n) => describeEffects(n.effects),
    write: (v) => {
      const errors: Errors = [];
      const e = parseEffects(v, "effects", errors);
      if (errors.length || !e) reject(errors.join("; "));
      return { effects: e };
    },
  },
  layoutGrids: {
    on: framesOnly,
    read: (n) => ((n as unknown as Obj).layoutGrids as unknown[] | undefined)?.map((g) => toTool("LayoutGrid", false, g)) ?? [],
    write: (v) => {
      const errors: Errors = [];
      const g = parseGrids(v, "layoutGrids", errors);
      if (errors.length || !g) reject(errors.join("; "));
      return { layoutGrids: g } as NodeFields;
    },
  },
  // Corners.
  cornerRadius: {
    on: (n) => (hasCorners(n) ? null : `not for a ${typeName(n.type)}`),
    read: cornersOf,
    write: (v) => {
      if (typeof v !== "number" && !(Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && x >= 0))) reject("a number, or [top-left, top-right, bottom-right, bottom-left]");
      if (typeof v === "number" && v < 0) reject("0 or more");
      const [tl, tr, br, bl] = typeof v === "number" ? [v, v, v, v] : (v as number[]);
      return { cornerRadius: tl, rectangleCornerRadiiIndependent: !(tl === tr && tr === br && br === bl), rectangleTopLeftCornerRadius: tl, rectangleTopRightCornerRadius: tr, rectangleBottomRightCornerRadius: br, rectangleBottomLeftCornerRadius: bl };
    },
  },
  cornerSmoothing: { on: (n) => (hasCorners(n) ? null : `not for a ${typeName(n.type)}`), read: (n) => (n as unknown as Obj).cornerSmoothing ?? 0, write: (v) => ({ cornerSmoothing: needNum(v, 0, 1) }) as NodeFields },
  // Shapes.
  pointCount: { on: (n) => (n.type === "REGULAR_POLYGON" || n.type === "STAR" ? null : "only for polygons and stars"), read: (n) => (n.type === "REGULAR_POLYGON" || n.type === "STAR" ? ((n as unknown as Obj).count ?? (n.type === "STAR" ? 5 : 3)) : undefined), write: (v) => ({ count: Math.round(needNum(v, 3, 60)) }) as NodeFields },
  innerRadius: { on: (n) => (n.type === "STAR" ? null : "only for stars"), read: (n) => (n.type === "STAR" ? ((n as unknown as Obj).starInnerScale ?? 0.382) : undefined), write: (v) => ({ starInnerScale: needNum(v, 0, 1) }) as NodeFields },
  // Position and size.
  x: { on: notPage, read: (n) => r2(geometry(n).m02), hidden: () => false, write: (v, ctx) => ({ transform: { ...geometry(ctx.node), m02: needNum(v) } }) },
  y: { on: notPage, read: (n) => r2(geometry(n).m12), hidden: () => false, write: (v, ctx) => ({ transform: { ...geometry(ctx.node), m12: needNum(v) } }) },
  rotation: {
    on: notPage,
    read: (n) => -rotationOf(n.transform) || 0,
    write: (v, ctx) => {
      const t = geometry(ctx.node);
      return { transform: matrixAt(t.m02, t.m12, -needNum(v)) };
    },
  },
  width: {
    on: notPage,
    read: (n) => r2(n.size?.x ?? 0),
    hidden: () => false,
    write: (v, ctx) => {
      const w = needNum(v, ctx.node.type === "LINE" ? 0 : 0.01);
      const out: NodeFields = { size: { x: w, y: ctx.node.size?.y ?? 0 } };
      // A width given to an auto-width text makes it wrap there (Figma).
      if (isText(ctx.node) && ctx.spec.textAutoResize === undefined && ctx.spec.layoutSizingHorizontal === undefined && (ctx.node.textAutoResize ?? "NONE") === "WIDTH_AND_HEIGHT") out.textAutoResize = "HEIGHT";
      return out;
    },
  },
  height: {
    on: notPage,
    read: (n) => r2(n.size?.y ?? 0),
    hidden: () => false,
    write: (v, ctx) => {
      const h = needNum(v, 0);
      const out: NodeFields = { size: { x: ctx.node.size?.x ?? 0, y: h } };
      if (isText(ctx.node) && ctx.spec.textAutoResize === undefined && ctx.spec.layoutSizingVertical === undefined && (ctx.node.textAutoResize ?? "NONE") !== "NONE") out.textAutoResize = "NONE";
      return out;
    },
  },
  constrainProportions: plain("proportionsConstrained", needBool, { on: notPage }),
  constraints: {
    on: notPage,
    read: (n, p) => (flowMode(p) && n.stackPositioning !== "ABSOLUTE" ? undefined : { horizontal: n.horizontalConstraint ?? "MIN", vertical: n.verticalConstraint ?? "MIN" }),
    hidden: (v) => !v || ((v as Obj).horizontal === "MIN" && (v as Obj).vertical === "MIN"),
    write: (v) => {
      if (!v || typeof v !== "object") reject("{horizontal, vertical}");
      const o = v as Obj;
      const extra = Object.keys(o).filter((k) => k !== "horizontal" && k !== "vertical");
      if (extra.length) reject(`unknown ${extra.join(", ")} (takes horizontal, vertical)`);
      const values = ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"] as const;
      const out: NodeFields = {};
      if (o.horizontal !== undefined) out.horizontalConstraint = needEnum(o.horizontal, values);
      if (o.vertical !== undefined) out.verticalConstraint = needEnum(o.vertical, values);
      return out;
    },
  },
  // In an auto layout parent.
  layoutPositioning: {
    on: inAutoLayout,
    read: (n, p) => (flowMode(p) ? (n.stackPositioning ?? "AUTO") : undefined),
    hidden: (v) => !v || v === "AUTO",
    write: (v) => ({ stackPositioning: needEnum(v, ["AUTO", "ABSOLUTE"] as const) }),
  },
  layoutSizingHorizontal: sizing("H"),
  layoutSizingVertical: sizing("V"),
  layoutGrow: { on: inAutoLayout, read: (n, p) => (flowMode(p) ? (n.stackChildPrimaryGrow ?? 0) : undefined), hidden: () => true, write: (v) => ({ stackChildPrimaryGrow: needNum(v, 0) }) },
  layoutAlign: {
    on: inAutoLayout,
    read: (n, p) => (flowMode(p) ? (n.stackChildAlignSelf === "STRETCH" ? "STRETCH" : "INHERIT") : undefined),
    hidden: () => true,
    write: (v) => ({ stackChildAlignSelf: needEnum(v, ["INHERIT", "STRETCH"] as const) === "STRETCH" ? "STRETCH" : "AUTO" }),
  },
  minWidth: limit("minSize", "x"),
  maxWidth: limit("maxSize", "x"),
  minHeight: limit("minSize", "y"),
  maxHeight: limit("maxSize", "y"),
  // Components: read from the engine's component info and written with its command (mcpTools).
  componentProperties: { on: (n) => (n.type === "INSTANCE" ? null : "only for instances (set a main's defaults in the app)"), read: () => undefined, write: () => ({}) },
};

// Raw document fields (layerProps.ts): their schema shape through docSchema.
for (const field of RAW_FIELDS) {
  const def = nodeFieldType(field);
  if (!def) continue;
  const textField = (RAW_TEXT_FIELDS as readonly string[]).includes(field);
  const gridField = (RAW_GRID_FIELDS as readonly string[]).includes(field);
  const deflt = (DEFAULTS.NodeChange as Obj)[field];
  PROPS[field] = {
    on: textField ? textOnly : gridField ? (n, p) => (n.stackMode === "GRID" || p?.stackMode === "GRID" || isFrameish(n) ? null : "only for grid layout frames and their children") : undefined,
    read: (n) => toTool(def.type!, def.isArray, (n as unknown as Obj)[field]) ?? (deflt !== undefined ? toTool(def.type!, def.isArray, deflt) : undefined),
    hidden: (v) => sameValue(v, undefined) || (deflt !== undefined && sameValue(v, toTool(def.type!, def.isArray, deflt))),
    write: (v) => {
      const errors: Errors = [];
      const out = fromTool(def.type!, def.isArray, v, field, errors);
      if (errors.length) reject(errors.join("; "));
      return { [field]: out } as NodeFields;
    },
  };
}

/** Every property's name, in the order writes apply (sizing after layout, after the parent's and own fields). */
export const PROP_NAMES: readonly string[] = Object.keys(PROPS);

// ---- Specs → fields --------------------------------------------------------------------------------------------------

export interface Rejection {
  property: string;
  reason: string;
}

/** Keys a spec may have that are not layer properties (the tools' own). */
const STRUCTURAL = new Set(["type", "children", "nodeId"]);

/**
 * A spec's fields on `node` (its current fields; for a new layer, its defaults and type) under `parent`. Every key is
 * applied or rejected with its reason — unknown properties, values that can't be read, properties that don't apply to
 * this layer — never dropped silently. `deferred`: properties that can only be written once the layer exists in its
 * parent (sizing on create) or with a command (componentProperties).
 */
export function fieldsOf(spec: Spec, node: NodeChange, parent: NodeChange | null, creating = false, skip: readonly string[] = []): { fields: NodeFields; applied: string[]; rejected: Rejection[] } {
  const fields: NodeFields = {};
  const applied: string[] = [];
  const rejected: Rejection[] = [];
  for (const key of Object.keys(spec)) {
    if (STRUCTURAL.has(key) || PROPS[key] || skip.includes(key)) continue;
    const hint = propForField(key);
    const near = PROP_NAMES.find((p) => p.toLowerCase() === key.toLowerCase());
    rejected.push({ property: key, reason: `unknown property${hint && hint !== key ? ` (the document's ${key} is "${hint}")` : near ? ` (did you mean "${near}"?)` : ""}` });
  }
  for (const key of PROP_NAMES) {
    if (spec[key] === undefined || skip.includes(key)) continue;
    const p = PROPS[key];
    const ctx: Ctx = { node: { ...node, ...fields } as NodeChange, parent, creating, spec };
    // A style's node holds its kind's fields whatever its node type (a layout guide style is a rectangle).
    const styleType = (node as unknown as Obj).styleType;
    const why = styleType && styleType !== "NONE" ? null : (p.on?.(ctx.node, parent) ?? null);
    if (why) {
      rejected.push({ property: key, reason: why });
      continue;
    }
    try {
      Object.assign(fields, p.write(spec[key], ctx));
      applied.push(key);
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      rejected.push({ property: key, reason: e.message });
    }
  }
  return { fields, applied, rejected };
}

/** The values of `props` on a layer, as the tools read them. */
export function readProps(n: NodeChange, parent: NodeChange | null, props: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of props) {
    const p = PROPS[k];
    if (!p || p.on?.(n, parent)) continue;
    const v = p.read(n, parent);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The properties that didn't take: what `applied` would read on `expected` (the layer with the fields written) against
 * what it reads on `actual` (the engine's, after layout). Each with what was asked and what the layer has.
 */
export function notTaken(applied: readonly string[], expected: NodeChange, expectedParent: NodeChange | null, actual: NodeChange, actualParent: NodeChange | null): { property: string; requested: unknown; actual: unknown; reason: string }[] {
  const out: { property: string; requested: unknown; actual: unknown; reason: string }[] = [];
  for (const k of applied) {
    const p = PROPS[k];
    if (!p || k === "componentProperties") continue;
    const want = p.read(expected, expectedParent);
    const got = p.read(actual, actualParent);
    if (sameValue(want, got, true)) continue;
    out.push({ property: k, requested: want, actual: got, reason: whyNot(k, actual, actualParent) });
  }
  return out;
}

function whyNot(k: string, n: NodeChange, parent: NodeChange | null): string {
  const inFlow = flowMode(parent) && n.stackPositioning !== "ABSOLUTE";
  if ((k === "x" || k === "y") && inFlow) return "its auto layout parent places it (set layoutPositioning ABSOLUTE to place it yourself)";
  if (k === "width" || k === "height") {
    const s = sizingOf(n, parent, k === "width" ? "H" : "V");
    if (s !== "FIXED") return `it is ${s === "HUG" ? "hugging its content" : "filling its parent"} on that axis (set layoutSizing${k === "width" ? "Horizontal" : "Vertical"} FIXED first)`;
    if (n.minSize || n.maxSize) return "clamped by its min / max size";
    return "the engine laid it out differently";
  }
  if (n.type === "INSTANCE" || n.guid.includes(";")) return "an instance takes only what its main allows";
  return "the engine kept another value";
}

// ---- Fields → what the agent reads ----------------------------------------------------------------------------------

/** One layer's design, in the tools' vocabulary (get_design_context): every property it has that isn't a default. */
export function describeNode(n: NodeChange, parent: NodeChange | null): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.guid, name: n.name, type: typeName(n.type) };
  for (const k of PROP_NAMES) {
    if (k === "name") continue;
    const p = PROPS[k];
    if (p.on?.(n, parent)) continue;
    const v = p.read(n, parent);
    if (v === undefined) continue;
    if (p.hidden ? p.hidden(v, n, parent) : sameValue(v, undefined)) continue;
    out[k] = v;
  }
  if (n.type === "CANVAS") for (const k of ["x", "y", "width", "height"]) delete out[k];
  if (n.type === "TEXT" && n.textData?.styleOverrideTable?.length) out.mixedStyles = true;
  return out;
}
