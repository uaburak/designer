/**
 * Document values (schema/document.kiwi) ↔ the Plugin API's shapes (@figma/plugin-typings): paints, effects, layout
 * guides, line height, letter spacing, font names, transforms, node types. Pure functions.
 */
import type { Color, Effect, Matrix, NodeChange, NodeType, Paint } from "@/engine/codec";
import { ApiError } from "./codec";

type Obj = Record<string, unknown>;
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// ---- Node types -------------------------------------------------------------------------------------------------

/** The Plugin API's type of a node (the engine's own type names in, `withRealType` applied). */
export function apiType(n: Pick<NodeChange, "type"> & { isStateGroup?: boolean; resizeToFit?: boolean }): string {
  switch (n.type) {
    case "DOCUMENT":
      return "DOCUMENT";
    case "CANVAS":
      return "PAGE";
    case "FRAME":
      return n.isStateGroup ? "COMPONENT_SET" : n.resizeToFit ? "GROUP" : "FRAME";
    case "SYMBOL":
      return "COMPONENT";
    case "ROUNDED_RECTANGLE":
    case "RECTANGLE":
      return "RECTANGLE";
    case "REGULAR_POLYGON":
      return "POLYGON";
    default:
      if ((n.type as string) === "BRUSH") return "VECTOR";
      // Draw (docs/draw.md §7): the engine's TRANSFORM (48) is the Plugin API's TRANSFORM_GROUP; TEXT_PATH keeps its name.
      if ((n.type as string) === "TRANSFORM") return "TRANSFORM_GROUP";
      return n.type ?? "NONE";
  }
}

/** The engine's type for a Plugin API create call. */
export const ENGINE_TYPE: Record<string, NodeType> = {
  RECTANGLE: "ROUNDED_RECTANGLE",
  LINE: "LINE",
  ELLIPSE: "ELLIPSE",
  POLYGON: "REGULAR_POLYGON",
  STAR: "STAR",
  VECTOR: "VECTOR",
  TEXT: "TEXT",
  FRAME: "FRAME",
  COMPONENT: "SYMBOL",
  SECTION: "SECTION",
  SLICE: "SLICE",
  BOOLEAN_OPERATION: "BOOLEAN_OPERATION",
  GROUP: "FRAME",
};

// ---- Colours ----------------------------------------------------------------------------------------------------

export const rgb = (c: Color | undefined): { r: number; g: number; b: number } => ({ r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0 });
export const rgba = (c: Color | undefined): { r: number; g: number; b: number; a: number } => ({ r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 });

function needColor(v: unknown, path: string, alpha: boolean): Color {
  if (!v || typeof v !== "object") throw new ApiError(`${path}: expected an object {r, g, b${alpha ? ", a" : ""}}`);
  const c = v as Obj;
  for (const k of ["r", "g", "b"]) {
    const x = c[k];
    if (typeof x !== "number" || x < 0 || x > 1) throw new ApiError(`${path}.${k}: expected a number between 0 and 1`);
  }
  if (!alpha && "a" in c) throw new ApiError(`${path}: Unrecognized key(s) in object: 'a'`);
  return { r: c.r as number, g: c.g as number, b: c.b as number, a: alpha ? num(c.a, 1) : 1 };
}

// ---- Transforms -------------------------------------------------------------------------------------------------

export type Transform2D = [[number, number, number], [number, number, number]];
export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
export const toTransform = (m: Matrix | undefined): Transform2D => {
  const t = m ?? IDENTITY;
  return [
    [t.m00, t.m01, t.m02],
    [t.m10, t.m11, t.m12],
  ];
};
export function fromTransform(v: unknown, path: string): Matrix {
  const ok = Array.isArray(v) && v.length === 2 && v.every((row) => Array.isArray(row) && row.length === 3 && row.every((x) => typeof x === "number" && Number.isFinite(x)));
  if (!ok) throw new ApiError(`${path}: expected a Transform [[a, b, c], [d, e, f]]`);
  const [[m00, m01, m02], [m10, m11, m12]] = v as Transform2D;
  return { m00, m01, m02, m10, m11, m12 };
}
export const multiply = (a: Matrix, b: Matrix): Matrix => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

// ---- Paints -----------------------------------------------------------------------------------------------------

const SCALE_TO_API: Record<string, string> = { FILL: "FILL", FIT: "FIT", STRETCH: "CROP", TILE: "TILE" };
const SCALE_FROM_API: Record<string, string> = { FILL: "FILL", FIT: "FIT", CROP: "STRETCH", TILE: "TILE" };
const FILTERS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const;

function hashHex(h: unknown): string | null {
  if (typeof h === "string") return h.toLowerCase();
  if (Array.isArray(h) || h instanceof Uint8Array) return Array.from(h as ArrayLike<number>, (x) => (x & 255).toString(16).padStart(2, "0")).join("");
  return null;
}

/** A document paint as the Plugin API reads it. */
export function paintToApi(p: Paint): Obj {
  const base: Obj = { type: p.type ?? "SOLID", visible: p.visible !== false, opacity: p.opacity ?? 1, blendMode: p.blendMode ?? "NORMAL" };
  const type = String(base.type);
  if (type === "SOLID") return { ...base, color: rgb(p.color), boundVariables: {} };
  if (type.startsWith("GRADIENT_"))
    return { ...base, gradientTransform: toTransform(p.transform), gradientStops: (p.stops ?? []).map((s) => ({ position: s.position, color: rgba(s.color), boundVariables: {} })) };
  if (type === "IMAGE" || type === "VIDEO") {
    const scaleMode = SCALE_TO_API[p.imageScaleMode ?? "FILL"] ?? "FILL";
    const out: Obj = { ...base, scaleMode, imageHash: hashHex(p.image?.hash) };
    if (type === "VIDEO") out.videoHash = hashHex((p.video as { hash?: unknown } | undefined)?.hash);
    if (scaleMode === "CROP") out.imageTransform = toTransform(p.transform);
    if (scaleMode === "TILE") out.scalingFactor = p.scale ?? 1;
    if (p.rotation) out.rotation = p.rotation;
    const f = (p.paintFilter ?? {}) as Obj;
    const filters: Obj = {};
    for (const k of FILTERS) if (typeof f[k] === "number" && f[k] !== 0) filters[k] = f[k];
    out.filters = filters;
    return out;
  }
  if (type === "PATTERN") return { ...base, sourceNodeId: p.sourceNodeId, tileType: p.patternTileType ?? "RECTANGULAR", scalingFactor: p.scale ?? 1, spacing: p.patternSpacing ?? { x: 0, y: 0 }, horizontalAlignment: p.horizontalAlignment ?? "START" };
  if (type === "NOISE") return { ...base, color: rgba(p.color), noiseType: p.noiseType ?? "MONOTONE", density: p.density ?? 1, noiseSize: p.noiseSize ?? { x: 0.5, y: 0.5 } };
  return base;
}

const BLEND_MODES = ["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"];

/** A Plugin API paint as the document's (Figma's validation messages, shortened). */
export function paintFromApi(v: unknown, path: string): Paint {
  if (!v || typeof v !== "object") throw new ApiError(`${path}: expected a Paint object`);
  const o = v as Obj;
  const type = String(o.type ?? "");
  const blendMode = o.blendMode === undefined ? "NORMAL" : String(o.blendMode);
  if (!BLEND_MODES.includes(blendMode)) throw new ApiError(`${path}.blendMode: invalid enum value '${blendMode}'`);
  const base = { visible: o.visible !== false, opacity: num(o.opacity, 1), blendMode } as Paint;
  if (type === "SOLID") return { ...base, type: "SOLID", color: needColor(o.color, `${path}.color`, false) };
  if (type.startsWith("GRADIENT_")) {
    if (!Array.isArray(o.gradientStops)) throw new ApiError(`${path}.gradientStops: required`);
    return {
      ...base,
      type: type as Paint["type"],
      transform: o.gradientTransform === undefined ? IDENTITY : fromTransform(o.gradientTransform, `${path}.gradientTransform`),
      stops: (o.gradientStops as Obj[]).map((s, i) => ({ position: num(s?.position), color: needColor(s?.color, `${path}.gradientStops[${i}].color`, true) })),
    };
  }
  if (type === "IMAGE" || type === "VIDEO") {
    const scale = String(o.scaleMode ?? "FILL");
    if (!SCALE_FROM_API[scale]) throw new ApiError(`${path}.scaleMode: invalid enum value '${scale}'`);
    const hash = typeof o.imageHash === "string" ? o.imageHash : null;
    const out: Paint = { ...base, type: type as Paint["type"], imageScaleMode: SCALE_FROM_API[scale] as Paint["imageScaleMode"], transform: o.imageTransform ? fromTransform(o.imageTransform, `${path}.imageTransform`) : IDENTITY };
    if (hash) out.image = { hash } as Paint["image"];
    if (type === "VIDEO" && typeof o.videoHash === "string") (out as Obj).video = { hash: o.videoHash };
    if (typeof o.scalingFactor === "number") out.scale = o.scalingFactor;
    if (typeof o.rotation === "number") out.rotation = o.rotation;
    if (o.filters && typeof o.filters === "object") out.paintFilter = { ...(o.filters as Obj) } as Paint["paintFilter"];
    return out;
  }
  if (type === "NOISE") return { ...base, type: "NOISE", color: needColor(o.color ?? { r: 0, g: 0, b: 0, a: 0.25 }, `${path}.color`, true), noiseType: (o.noiseType as Paint["noiseType"]) ?? "MONOTONE", density: num(o.density, 1), noiseSize: (o.noiseSize as Paint["noiseSize"]) ?? { x: 0.5, y: 0.5 } };
  if (type === "PATTERN") return { ...base, type: "PATTERN", sourceNodeId: o.sourceNodeId as Paint["sourceNodeId"], patternTileType: (o.tileType as Paint["patternTileType"]) ?? "RECTANGULAR", scale: num(o.scalingFactor, 1), patternSpacing: (o.spacing as Paint["patternSpacing"]) ?? { x: 0, y: 0 } };
  throw new ApiError(`${path}.type: invalid enum value '${type}'`);
}

export function paintsFromApi(v: unknown, name: string): Paint[] {
  if (!Array.isArray(v)) throw new ApiError(`in set_${name}: Expected an array of Paint`);
  return v.map((p, i) => paintFromApi(p, `${name}[${i}]`));
}

// ---- Effects ----------------------------------------------------------------------------------------------------

const EFFECT_TO_API: Record<string, string> = { FOREGROUND_BLUR: "LAYER_BLUR", GRAIN: "TEXTURE" };
const EFFECT_FROM_API: Record<string, string> = { LAYER_BLUR: "FOREGROUND_BLUR", TEXTURE: "GRAIN" };

export function effectToApi(e: Effect): Obj {
  const type = EFFECT_TO_API[e.type ?? ""] ?? e.type ?? "DROP_SHADOW";
  const base: Obj = { type, visible: e.visible !== false };
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    const out: Obj = { ...base, color: rgba(e.color), offset: e.offset ?? { x: 0, y: 0 }, radius: e.radius ?? 0, spread: e.spread ?? 0, blendMode: e.blendMode ?? "NORMAL", boundVariables: {} };
    if (type === "DROP_SHADOW") out.showShadowBehindNode = !!e.showShadowBehindNode;
    return out;
  }
  if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
    if (e.blurOpType === "PROGRESSIVE") return { ...base, blurType: "PROGRESSIVE", radius: e.radius ?? 0, startRadius: e.startRadius ?? 0, startOffset: e.startOffset ?? { x: 0.5, y: 0 }, endOffset: e.endOffset ?? { x: 0.5, y: 1 }, boundVariables: {} };
    return { ...base, blurType: "NORMAL", radius: e.radius ?? 0, boundVariables: {} };
  }
  const size = (e.noiseSize as { x?: number } | undefined)?.x;
  if (type === "NOISE") return { ...base, noiseType: e.noiseType ?? "MONOTONE", color: rgba(e.color), secondaryColor: rgba(e.secondaryColor as Color | undefined), density: e.density ?? 1, noiseSize: num(size, 0.5), blendMode: e.blendMode ?? "NORMAL" };
  if (type === "TEXTURE") return { ...base, noiseSize: num(size, 0.5), radius: e.radius ?? 0, clipToShape: !!e.clipToShape };
  if (type === "GLASS") return { ...base, lightIntensity: e.specularIntensity ?? 0, lightAngle: e.specularAngle ?? 0, refraction: e.refractionIntensity ?? 0, depth: e.bevelSize ?? 0, dispersion: e.chromaticAberration ?? 0, radius: e.radius ?? 0 };
  return base;
}

export function effectFromApi(v: unknown, path: string): Effect {
  if (!v || typeof v !== "object") throw new ApiError(`${path}: expected an Effect object`);
  const o = v as Obj;
  const apiType = String(o.type ?? "");
  const type = (EFFECT_FROM_API[apiType] ?? apiType) as Effect["type"];
  const visible = o.visible !== false;
  if (apiType === "DROP_SHADOW" || apiType === "INNER_SHADOW")
    return { type, visible, color: needColor(o.color, `${path}.color`, true), offset: (o.offset as Effect["offset"]) ?? { x: 0, y: 0 }, radius: num(o.radius), spread: num(o.spread), blendMode: (o.blendMode as Effect["blendMode"]) ?? "NORMAL", showShadowBehindNode: !!o.showShadowBehindNode };
  if (apiType === "LAYER_BLUR" || apiType === "BACKGROUND_BLUR") {
    if (o.blurType === "PROGRESSIVE") return { type, visible, radius: num(o.radius), blurOpType: "PROGRESSIVE", startRadius: num(o.startRadius), startOffset: (o.startOffset as Effect["startOffset"]) ?? { x: 0.5, y: 0 }, endOffset: (o.endOffset as Effect["endOffset"]) ?? { x: 0.5, y: 1 } };
    return { type, visible, radius: num(o.radius) };
  }
  if (apiType === "NOISE") return { type, visible, noiseType: (o.noiseType as Effect["noiseType"]) ?? "MONOTONE", color: needColor(o.color ?? { r: 0, g: 0, b: 0, a: 0.25 }, `${path}.color`, true), secondaryColor: o.secondaryColor ? needColor(o.secondaryColor, `${path}.secondaryColor`, true) : undefined, density: num(o.density, 1), noiseSize: { x: num(o.noiseSize, 0.5), y: num(o.noiseSize, 0.5) }, blendMode: (o.blendMode as Effect["blendMode"]) ?? "NORMAL" };
  if (apiType === "TEXTURE") return { type, visible, noiseSize: { x: num(o.noiseSize, 0.5), y: num(o.noiseSize, 0.5) }, radius: num(o.radius), clipToShape: !!o.clipToShape };
  if (apiType === "GLASS") return { type, visible, specularIntensity: num(o.lightIntensity), specularAngle: num(o.lightAngle), refractionIntensity: num(o.refraction), bevelSize: num(o.depth), chromaticAberration: num(o.dispersion), radius: num(o.radius) };
  throw new ApiError(`${path}.type: invalid enum value '${apiType}'`);
}

// ---- Layout guides (layoutGrids) ------------------------------------------------------------------------------------

export function gridToApi(g: Obj): Obj {
  const pattern = g.pattern === "GRID" ? "GRID" : g.axis === "Y" ? "ROWS" : "COLUMNS";
  const color = rgba(g.color as Color | undefined);
  if (pattern === "GRID") return { pattern, sectionSize: num(g.sectionSize, 10), visible: g.visible !== false, color, boundVariables: {} };
  const align = String(g.type ?? "STRETCH");
  const alignment = align === "MIN" ? "MIN" : align === "MAX" ? "MAX" : align === "CENTER" ? "CENTER" : "STRETCH";
  const out: Obj = { pattern, alignment, gutterSize: num(g.gutterSize, 20), count: num(g.numSections, 5), visible: g.visible !== false, color, boundVariables: {} };
  if (alignment !== "STRETCH") out.sectionSize = num(g.sectionSize, 10);
  if (alignment !== "CENTER") out.offset = num(g.offset);
  return out;
}

export function gridFromApi(v: unknown, path: string): Obj {
  if (!v || typeof v !== "object") throw new ApiError(`${path}: expected a LayoutGrid`);
  const o = v as Obj;
  const color = o.color ? needColor(o.color, `${path}.color`, true) : { r: 1, g: 0, b: 0, a: 0.1 };
  if (o.pattern === "GRID") return { pattern: "GRID", sectionSize: num(o.sectionSize, 10), visible: o.visible !== false, color, axis: "X", type: "STRETCH" };
  if (o.pattern !== "ROWS" && o.pattern !== "COLUMNS") throw new ApiError(`${path}.pattern: invalid enum value '${String(o.pattern)}'`);
  return { pattern: "STRIPES", axis: o.pattern === "ROWS" ? "Y" : "X", type: String(o.alignment ?? "STRETCH"), gutterSize: num(o.gutterSize, 20), numSections: num(o.count, 5), sectionSize: num(o.sectionSize, 10), offset: num(o.offset), visible: o.visible !== false, color };
}

// ---- Text values ------------------------------------------------------------------------------------------------

export function lineHeightToApi(v: { value: number; units: string } | undefined): Obj {
  if (!v || (v.units === "PERCENT" && v.value === 100)) return { unit: "AUTO" };
  if (v.units === "RAW") return { value: Math.round(v.value * 100 * 1e6) / 1e6, unit: "PERCENT" };
  return { value: v.value, unit: v.units === "PERCENT" ? "PERCENT" : "PIXELS" };
}

export function lineHeightFromApi(v: unknown): { value: number; units: "RAW" | "PIXELS" | "PERCENT" } {
  const o = v as Obj | null;
  if (!o || typeof o !== "object") throw new ApiError("lineHeight: expected {value, unit} or {unit: 'AUTO'}");
  if (o.unit === "AUTO") return { value: 100, units: "PERCENT" };
  if (o.unit === "PERCENT") return { value: num(o.value) / 100, units: "RAW" };
  if (o.unit === "PIXELS") return { value: num(o.value), units: "PIXELS" };
  throw new ApiError(`lineHeight.unit: invalid enum value '${String(o.unit)}'`);
}

export function letterSpacingToApi(v: { value: number; units: string } | undefined): Obj {
  if (!v) return { value: 0, unit: "PERCENT" };
  if (v.units === "RAW") return { value: v.value * 100, unit: "PERCENT" };
  return { value: v.value, unit: v.units === "PIXELS" ? "PIXELS" : "PERCENT" };
}

export function letterSpacingFromApi(v: unknown): { value: number; units: "PIXELS" | "PERCENT" } {
  const o = v as Obj | null;
  if (!o || typeof o !== "object" || (o.unit !== "PIXELS" && o.unit !== "PERCENT")) throw new ApiError("letterSpacing: expected {value, unit: 'PIXELS' | 'PERCENT'}");
  return { value: num(o.value), units: o.unit as "PIXELS" | "PERCENT" };
}

export function fontNameFromApi(v: unknown): { family: string; style: string; postscript: string } {
  const o = v as Obj | null;
  if (!o || typeof o.family !== "string" || typeof o.style !== "string") throw new ApiError("fontName: expected {family, style}");
  return { family: o.family, style: o.style, postscript: "" };
}

/** A style name's weight (Figma's fontWeight): Thin 100 … Black 900. */
export function weightOf(style: string): number {
  const s = style.toLowerCase().replace(/[\s-]/g, "");
  const table: [string, number][] = [["hairline", 100], ["thin", 100], ["extralight", 200], ["ultralight", 200], ["light", 300], ["medium", 500], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800], ["bold", 700], ["black", 900], ["heavy", 900]];
  for (const [k, w] of table) if (s.includes(k)) return w;
  return 400;
}
