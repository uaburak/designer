/**
 * Node properties and node methods of the Plugin API on the engine (docs/plugins.md §5 "Nodes"). Every read and write
 * is one host call `get(id, prop)` / `set(id, prop, value)`; properties whose shape the agents' layer properties
 * already speak in the Plugin API's names (editor/agents/nodeSpec.ts: layoutMode, itemSpacing, layoutSizing…,
 * constraints …) go through them; paints, effects, transforms, text values and the rest are converted here.
 */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { keyAfter, keyBetween } from "@shared/schema/fractionalIndex";
import { dashPatternError, MITER_LIMIT_RANGE } from "@shared/strokeLimits";
import { fieldsOf, readProps, PROP_NAMES, sizingOf } from "../../agents/nodeSpec";
import { cssOf } from "../../model/exports";
import { mainOf } from "../../components";
import { ApiError, MIXED } from "./codec";
import { mustNode, parentOf, readNode, ref, refOf, type ApiContext } from "./context";
import {
  apiType,
  effectsFromApi,
  effectToApi,
  fontNameFromApi,
  fromTransform,
  gridFromApi,
  gridToApi,
  IDENTITY,
  letterSpacingFromApi,
  letterSpacingToApi,
  lineHeightFromApi,
  lineHeightToApi,
  multiply,
  paintsFromApi,
  paintToApi,
  toTransform,
  weightOf,
} from "./convert";
import {
  complexStrokeProperties,
  setComplexStrokeProperties,
  setTextPathStartData,
  setTransformModifiers,
  setVariableWidthStrokeProperties,
  textPathStartData,
  transformModifiers,
  variableWidthStrokeProperties,
} from "./draw";

type Obj = Record<string, unknown>;
type Getter = (ctx: ApiContext, n: NodeChange) => unknown;
type Setter = (ctx: ApiContext, n: NodeChange, v: unknown) => void;
interface Prop {
  get: Getter;
  set?: Setter;
  /** Only for nodes of these Plugin API types */
  only?: readonly string[];
}

// Read on first use, not at load: nodeSpec and this module import each other (through the editor), and a hot update
// that re-evaluates them in the other order met PROP_NAMES in its temporal dead zone.
let specProps: ReadonlySet<string> | null = null;
const isSpecProp = (name: string) => (specProps ??= new Set(PROP_NAMES)).has(name);

/** Writes fields on one node (inside the run's slice). */
export function writeFields(ctx: ApiContext, id: Guid, fields: NodeFields, what: string): void {
  if (!Object.keys(fields).length) return;
  ctx.write();
  const status = ctx.ed.engine.setProps([id], fields);
  if (status === Status.OK) return;
  if (status === Status.E_READONLY) throw new ApiError(`in set_${what}: Cannot write to a read-only node (a library copy)`);
  throw new ApiError(`in set_${what}: the engine refused the change (status ${status})`);
}

/** A property through the agents' layer properties (Plugin API names, nodeSpec.ts). */
function viaSpec(name: string, read?: (v: unknown) => unknown): Prop {
  return {
    get: (ctx, n) => {
      const v = readProps(n, parentOf(ctx, n), [name])[name];
      return read ? read(v) : v;
    },
    set: (ctx, n, v) => {
      const { fields, rejected } = fieldsOf({ [name]: v }, n, parentOf(ctx, n));
      if (rejected.length) throw new ApiError(`in set_${name}: ${rejected.map((r) => r.reason).join("; ")}`);
      writeFields(ctx, n.guid, fields, name);
    },
  };
}

/** A document field read and written as it is. */
const field = (f: string, fallback: unknown = undefined, check?: (v: unknown) => unknown): Prop => ({
  get: (_ctx, n) => (n as unknown as Obj)[f] ?? fallback,
  set: (ctx, n, v) => writeFields(ctx, n.guid, { [f]: check ? check(v) : v } as NodeFields, f),
});

const needNumber = (name: string) => (v: unknown) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ApiError(`in set_${name}: Expected a number`);
  return v;
};
const needBool = (name: string) => (v: unknown) => {
  if (typeof v !== "boolean") throw new ApiError(`in set_${name}: Expected a boolean`);
  return v;
};
const needString = (name: string) => (v: unknown) => {
  if (typeof v !== "string") throw new ApiError(`in set_${name}: Expected a string`);
  return v;
};

const isText = (n: NodeChange) => n.type === "TEXT" || (n.type as string) === "TEXT_PATH";
const transformOf = (n: NodeChange) => n.transform ?? IDENTITY;

/** The node's transform relative to its page. */
export function absoluteTransform(ctx: ApiContext, n: NodeChange): ReturnType<typeof multiply> {
  let m = transformOf(n);
  let p = parentOf(ctx, n);
  for (let i = 0; p && p.type !== "CANVAS" && p.type !== "DOCUMENT" && i < 400; i++) {
    m = multiply(transformOf(p), m);
    p = parentOf(ctx, p);
  }
  return m;
}

function bounds(ctx: ApiContext, n: NodeChange) {
  if (n.type === "CANVAS" || n.type === "DOCUMENT") return null;
  const m = absoluteTransform(ctx, n);
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const pts = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => [m.m00 * x + m.m01 * y + m.m02, m.m10 * x + m.m11 * y + m.m12]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The whole text's style, its mixed fields listed (engine's Typography read). */
function textStyle(ctx: ApiContext, n: NodeChange) {
  return ctx.ed.engine.textRangeStyle(n.guid, { from: 0, to: 0xffffffff });
}

function textValue(ctx: ApiContext, n: NodeChange, key: string, own: unknown): unknown {
  if (n.textData?.styleOverrideTable?.length) {
    const s = textStyle(ctx, n);
    if (s?.mixed.includes(key)) return MIXED;
  }
  return own;
}

function cornerRadius(n: NodeChange): number | typeof MIXED {
  if (!n.rectangleCornerRadiiIndependent) return n.cornerRadius ?? 0;
  const all = [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0];
  return all.every((x) => x === all[0]) ? all[0] : MIXED;
}

const corner = (f: "rectangleTopLeftCornerRadius" | "rectangleTopRightCornerRadius" | "rectangleBottomRightCornerRadius" | "rectangleBottomLeftCornerRadius"): Prop => ({
  get: (_ctx, n) => (n.rectangleCornerRadiiIndependent ? (n[f] ?? 0) : (n.cornerRadius ?? 0)),
  set: (ctx, n, v) => {
    const r = needNumber(f)(v) as number;
    const base = n.rectangleCornerRadiiIndependent ? {} : { rectangleTopLeftCornerRadius: n.cornerRadius ?? 0, rectangleTopRightCornerRadius: n.cornerRadius ?? 0, rectangleBottomRightCornerRadius: n.cornerRadius ?? 0, rectangleBottomLeftCornerRadius: n.cornerRadius ?? 0 };
    writeFields(ctx, n.guid, { ...base, [f]: r, rectangleCornerRadiiIndependent: true } as NodeFields, f);
  },
});

const styleRef = (f: "styleIdForFill" | "styleIdForStrokeFill" | "styleIdForText" | "styleIdForEffect" | "styleIdForGrid", target: string | null): Prop => ({
  get: (_ctx, n) => {
    const s = n[f] as { guid?: string } | undefined;
    return s?.guid ?? "";
  },
  set: (ctx, n, v) => {
    const id = needString(f)(v) as string;
    ctx.write();
    const status = id
      ? ctx.ed.engine.runCommand("APPLY_STYLE", { refs: [n.guid], style: id, ...(target ? { target } : {}) }).status
      : ctx.ed.engine.runCommand("DETACH_STYLE", { refs: [n.guid], target: target ?? (f === "styleIdForText" ? "TEXT" : f === "styleIdForEffect" ? "EFFECT" : "GRID") }).status;
    if (status !== Status.OK) throw new ApiError(`in set_${f}: no style ${id}`);
  },
});

/** Figma's getter for `parent`: the document for a page, null for the document. */
function parentRef(ctx: ApiContext, n: NodeChange) {
  if (n.type === "DOCUMENT") return null;
  if (n.type === "CANVAS") return refOf(ctx, "0:0");
  return refOf(ctx, n.parentIndex?.guid);
}

export function childrenOf(ctx: ApiContext, n: NodeChange): NodeChange[] {
  if (n.type === "DOCUMENT" || n.guid === "0:0") return ctx.ed.engine.pages().map((p) => readNode(ctx, (p as { guid: string }).guid, false)).filter((x): x is NodeChange => !!x);
  const ids = (n.childIds ?? []) as Guid[];
  return ids.length ? ctx.ed.engine.readNodes(ids).map(ctx.ed.withRealType) : [];
}

/** A GUID as the engine writes it ("s:l" or {sessionID, localID}) → "s:l"; null when absent. */
function guidText(g: unknown): Guid | null {
  if (typeof g === "string") return g || null;
  const o = g as { sessionID?: number; localID?: number } | undefined;
  return o && typeof o.sessionID === "number" && typeof o.localID === "number" ? `${o.sessionID}:${o.localID}` : null;
}

/**
 * Figma's `detachedInfo`: null on an instance or a component (or a layer never detached); `{type: "library",
 * componentKey}` when the detached main was a library's (an assetRef, or a library copy here with a key); else
 * `{type: "local", componentId}`.
 */
function detachedInfo(ctx: ApiContext, n: NodeChange): Obj | null {
  if (n.type === "INSTANCE" || n.type === "SYMBOL" || (n.type as string) === "COMPONENT" || (n as unknown as Obj).isStateGroup) return null;
  const d = (n as unknown as Obj).detachedSymbolId as { guid?: unknown; assetRef?: { key?: string } } | undefined;
  if (d?.assetRef?.key) return { type: "library", componentKey: d.assetRef.key };
  const id = guidText(d?.guid);
  if (!id) return null;
  // A detach written before assetRefs: a library copy here still names its asset.
  const main = readNode(ctx, id, false) as unknown as Obj | null;
  let key = typeof main?.key === "string" ? main.key : "";
  for (let p: Obj | null = main, i = 0; p && i < 64; i++) {
    if (p.sourceLibraryKey) return key || p.key ? { type: "library", componentKey: key || (p.key as string) } : { type: "local", componentId: id };
    if (!key && typeof p.key === "string") key = p.key;
    const parent = guidText((p.parentIndex as { guid?: unknown } | undefined)?.guid);
    p = parent ? (readNode(ctx, parent, false) as unknown as Obj | null) : null;
  }
  return { type: "local", componentId: id };
}

const PROPS: Record<string, Prop> = {
  name: { get: (_ctx, n) => n.name ?? "", set: (ctx, n, v) => writeFields(ctx, n.guid, { name: needString("name")(v) as string, ...(isText(n) ? { autoRename: false } : {}) } as NodeFields, "name") },
  parent: { get: parentRef },
  removed: { get: () => false },
  isAsset: { get: (_ctx, n) => n.type === "SYMBOL" || !!(n as unknown as Obj).isStateGroup },
  children: { get: (ctx, n) => childrenOf(ctx, n).map(ref) },
  visible: { get: (_ctx, n) => n.visible !== false, set: (ctx, n, v) => writeFields(ctx, n.guid, { visible: needBool("visible")(v) as boolean }, "visible") },
  locked: { get: (_ctx, n) => !!n.locked, set: (ctx, n, v) => writeFields(ctx, n.guid, { locked: needBool("locked")(v) as boolean }, "locked") },
  // Geometry
  x: { get: (_ctx, n) => transformOf(n).m02, set: (ctx, n, v) => writeFields(ctx, n.guid, { transform: { ...transformOf(n), m02: needNumber("x")(v) as number } }, "x") },
  y: { get: (_ctx, n) => transformOf(n).m12, set: (ctx, n, v) => writeFields(ctx, n.guid, { transform: { ...transformOf(n), m12: needNumber("y")(v) as number } }, "y") },
  width: { get: (_ctx, n) => n.size?.x ?? 0 },
  height: { get: (_ctx, n) => n.size?.y ?? 0 },
  relativeTransform: { get: (_ctx, n) => toTransform(n.transform), set: (ctx, n, v) => writeFields(ctx, n.guid, { transform: fromTransform(v, "relativeTransform") }, "relativeTransform") },
  absoluteTransform: { get: (ctx, n) => toTransform(absoluteTransform(ctx, n)) },
  absoluteBoundingBox: { get: bounds },
  absoluteRenderBounds: { get: bounds },
  // Look
  opacity: { get: (_ctx, n) => n.opacity ?? 1, set: (ctx, n, v) => writeFields(ctx, n.guid, { opacity: Math.max(0, Math.min(1, needNumber("opacity")(v) as number)) }, "opacity") },
  fills: {
    get: (ctx, n) => (isText(n) && n.textData?.styleOverrideTable?.some((s) => (s as Obj).fillPaints) ? textValue(ctx, n, "fillPaints", (n.fillPaints ?? []).map(paintToApi)) : (n.fillPaints ?? []).map(paintToApi)),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { fillPaints: paintsFromApi(v, "fills") }, "fills"),
  },
  strokes: { get: (_ctx, n) => (n.strokePaints ?? []).map(paintToApi), set: (ctx, n, v) => writeFields(ctx, n.guid, { strokePaints: paintsFromApi(v, "strokes") }, "strokes") },
  strokeWeight: {
    get: (_ctx, n) => {
      if (!n.borderStrokeWeightsIndependent) return n.strokeWeight ?? 1;
      const all = [n.borderTopWeight, n.borderRightWeight, n.borderBottomWeight, n.borderLeftWeight].map((x) => x ?? 0);
      return all.every((x) => x === all[0]) ? all[0] : MIXED;
    },
    set: (ctx, n, v) => writeFields(ctx, n.guid, { strokeWeight: needNumber("strokeWeight")(v) as number, ...(n.borderStrokeWeightsIndependent ? { borderStrokeWeightsIndependent: false } : {}) }, "strokeWeight"),
  },
  strokeAlign: field("strokeAlign", "CENTER"),
  effects: { get: (_ctx, n) => (n.effects ?? []).map(effectToApi), set: (ctx, n, v) => writeFields(ctx, n.guid, { effects: effectsFromApi(v, n) }, "effects") },
  layoutGrids: {
    get: (_ctx, n) => (((n as unknown as Obj).layoutGrids as Obj[] | undefined) ?? []).map(gridToApi),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { layoutGrids: (Array.isArray(v) ? v : []).map((g, i) => gridFromApi(g, `layoutGrids[${i}]`)) } as NodeFields, "layoutGrids"),
  },
  guides: {
    get: (_ctx, n) => (((n as unknown as Obj).guides as Obj[] | undefined) ?? []).map((g) => ({ axis: g.axis ?? "X", offset: g.offset ?? 0 })),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { guides: (Array.isArray(v) ? v : []).map((g: Obj) => ({ axis: g.axis === "Y" ? "Y" : "X", offset: Number(g.offset) || 0 })) } as NodeFields, "guides"),
  },
  cornerRadius: {
    get: (_ctx, n) => cornerRadius(n),
    set: (ctx, n, v) => {
      const r = needNumber("cornerRadius")(v) as number;
      writeFields(ctx, n.guid, { cornerRadius: r, rectangleCornerRadiiIndependent: false, rectangleTopLeftCornerRadius: r, rectangleTopRightCornerRadius: r, rectangleBottomRightCornerRadius: r, rectangleBottomLeftCornerRadius: r }, "cornerRadius");
    },
  },
  topLeftRadius: corner("rectangleTopLeftCornerRadius"),
  topRightRadius: corner("rectangleTopRightCornerRadius"),
  bottomRightRadius: corner("rectangleBottomRightCornerRadius"),
  bottomLeftRadius: corner("rectangleBottomLeftCornerRadius"),
  booleanOperation: {
    get: (_ctx, n) => ((n as unknown as Obj).booleanOperation === "XOR" ? "EXCLUDE" : ((n as unknown as Obj).booleanOperation ?? "UNION")),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { booleanOperation: v === "EXCLUDE" ? "XOR" : v } as NodeFields, "booleanOperation"),
  },
  counterAxisSpacing: {
    get: (_ctx, n) => (n.stackWrap === "WRAP" ? (n.stackCounterSpacing ?? n.stackSpacing ?? 0) : null),
    set: (ctx, n, v) => writeFields(ctx, n.guid, v === null ? { stackCounterSpacing: n.stackSpacing ?? 0 } : { stackCounterSpacing: needNumber("counterAxisSpacing")(v) as number }, "counterAxisSpacing"),
  },
  primaryAxisAlignItems: viaSpec("primaryAxisAlignItems", (v) => v ?? "MIN"),
  counterAxisAlignItems: viaSpec("counterAxisAlignItems", (v) => v ?? "MIN"),
  layoutWrap: viaSpec("layoutWrap", (v) => v ?? "NO_WRAP"),
  itemSpacing: viaSpec("itemSpacing", (v) => v ?? 0),
  counterAxisAlignContent: viaSpec("counterAxisAlignContent", (v) => v ?? "AUTO"),
  primaryAxisSizingMode: viaSpec("primaryAxisSizingMode", (v) => v ?? "AUTO"),
  counterAxisSizingMode: viaSpec("counterAxisSizingMode", (v) => v ?? "AUTO"),
  layoutPositioning: viaSpec("layoutPositioning", (v) => v ?? "AUTO"),
  layoutGrow: viaSpec("layoutGrow", (v) => v ?? 0),
  layoutAlign: viaSpec("layoutAlign", (v) => v ?? "INHERIT"),
  layoutSizingHorizontal: { get: (ctx, n) => sizingOf(n, parentOf(ctx, n), "H"), set: viaSpec("layoutSizingHorizontal").set },
  layoutSizingVertical: { get: (ctx, n) => sizingOf(n, parentOf(ctx, n), "V"), set: viaSpec("layoutSizingVertical").set },
  expanded: { get: () => false, set: () => {} },
  // Figma's limits (src/shared/strokeLimits.ts): at most 8 entries, each positive; strokeMiterLimit 1–16.
  dashPattern: field("dashPattern", [], (v) => {
    if (!Array.isArray(v)) throw new ApiError("in set_dashPattern: Expected an array of numbers");
    const error = dashPatternError(v);
    if (error) throw new ApiError(`in set_dashPattern: ${error}`);
    return v;
  }),
  strokeMiterLimit: {
    get: viaSpec("strokeMiterLimit").get,
    set: (ctx, n, v) => {
      const limit = needNumber("strokeMiterLimit")(v) as number;
      const [lo, hi] = MITER_LIMIT_RANGE;
      if (limit < lo) throw new ApiError(`in set_strokeMiterLimit: Number must be greater than or equal to ${lo}`);
      if (limit > hi) throw new ApiError(`in set_strokeMiterLimit: Number must be less than or equal to ${hi}`);
      viaSpec("strokeMiterLimit").set!(ctx, n, limit);
    },
  },
  exportSettings: field("exportSettings", []),
  description: { get: (_ctx, n) => (n as unknown as Obj).description ?? "", set: (ctx, n, v) => writeFields(ctx, n.guid, { description: needString("description")(v) } as NodeFields, "description") },
  descriptionMarkdown: { get: (_ctx, n) => (n as unknown as Obj).description ?? "", set: (ctx, n, v) => writeFields(ctx, n.guid, { description: needString("descriptionMarkdown")(v) } as NodeFields, "descriptionMarkdown") },
  documentationLinks: { get: (_ctx, n) => (((n as unknown as Obj).symbolLinks as Obj[] | undefined) ?? []).map((l) => ({ uri: l.uri })), set: (ctx, n, v) => writeFields(ctx, n.guid, { symbolLinks: (Array.isArray(v) ? v : []).map((l: Obj) => ({ uri: String(l.uri ?? "") })) } as NodeFields, "documentationLinks") },
  key: { get: (_ctx, n) => (n as unknown as Obj).key ?? "" },
  remote: { get: (_ctx, n) => !!(n as unknown as Obj).sourceLibraryKey },
  fillStyleId: styleRef("styleIdForFill", "FILL"),
  strokeStyleId: styleRef("styleIdForStrokeFill", "STROKE"),
  textStyleId: styleRef("styleIdForText", null),
  effectStyleId: styleRef("styleIdForEffect", null),
  gridStyleId: styleRef("styleIdForGrid", null),
  // Text
  characters: {
    get: (_ctx, n) => n.textData?.characters ?? "",
    set: (ctx, n, v) => {
      const s = needString("characters")(v) as string;
      requireFonts(ctx, n);
      writeFields(ctx, n.guid, { textData: { characters: s } } as NodeFields, "characters");
    },
  },
  fontName: {
    get: (ctx, n) => textValue(ctx, n, "fontName", { family: n.fontName?.family ?? "Inter", style: n.fontName?.style ?? "Regular" }),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { fontName: fontNameFromApi(v) }, "fontName"),
  },
  fontSize: { get: (ctx, n) => textValue(ctx, n, "fontSize", n.fontSize ?? 12), set: (ctx, n, v) => writeFields(ctx, n.guid, { fontSize: needNumber("fontSize")(v) as number }, "fontSize") },
  fontWeight: { get: (ctx, n) => textValue(ctx, n, "fontName", weightOf(n.fontName?.style ?? "Regular")) },
  lineHeight: { get: (ctx, n) => textValue(ctx, n, "lineHeight", lineHeightToApi(n.lineHeight as never)), set: (ctx, n, v) => writeFields(ctx, n.guid, { lineHeight: lineHeightFromApi(v) }, "lineHeight") },
  letterSpacing: { get: (ctx, n) => textValue(ctx, n, "letterSpacing", letterSpacingToApi(n.letterSpacing as never)), set: (ctx, n, v) => writeFields(ctx, n.guid, { letterSpacing: letterSpacingFromApi(v) }, "letterSpacing") },
  textCase: { get: (ctx, n) => textValue(ctx, n, "textCase", (n as unknown as Obj).textCase ?? "ORIGINAL"), set: (ctx, n, v) => writeFields(ctx, n.guid, { textCase: v } as NodeFields, "textCase") },
  textDecoration: { get: (ctx, n) => textValue(ctx, n, "textDecoration", (n as unknown as Obj).textDecoration ?? "NONE"), set: (ctx, n, v) => writeFields(ctx, n.guid, { textDecoration: v } as NodeFields, "textDecoration") },
  textAlignVertical: field("textAlignVertical", "TOP"),
  paragraphSpacing: field("paragraphSpacing", 0, needNumber("paragraphSpacing")),
  paragraphIndent: field("paragraphIndent", 0, needNumber("paragraphIndent")),
  listSpacing: field("listSpacing", 0, needNumber("listSpacing")),
  hangingPunctuation: field("hangingPunctuation", false, needBool("hangingPunctuation")),
  hangingList: field("hangingList", false, needBool("hangingList")),
  leadingTrim: field("leadingTrim", "NONE"),
  textTruncation: field("textTruncation", "DISABLED"),
  maxLines: { get: (_ctx, n) => (n as unknown as Obj).maxLines ?? null, set: (ctx, n, v) => writeFields(ctx, n.guid, { maxLines: v === null ? 0 : needNumber("maxLines")(v) } as NodeFields, "maxLines") },
  autoRename: field("autoRename", true, needBool("autoRename")),
  hyperlink: {
    get: (_ctx, n) => {
      const h = (n as unknown as Obj).hyperlink as { url?: string; guid?: string } | undefined;
      return h?.url ? { type: "URL", value: h.url } : h?.guid ? { type: "NODE", value: h.guid } : null;
    },
    set: (ctx, n, v) => {
      const o = v as { type?: string; value?: string } | null;
      writeFields(ctx, n.guid, { hyperlink: o ? (o.type === "NODE" ? { guid: o.value } : { url: String(o.value ?? "") }) : null } as NodeFields, "hyperlink");
    },
  },
  hasMissingFont: { get: () => false },
  // Containers and pages
  selection: {
    get: (ctx, n) => (n.guid === ctx.ed.store.page ? ctx.ed.selection.map((id) => refOf(ctx, id)).filter(Boolean) : []),
    set: (ctx, n, v) => {
      if (!Array.isArray(v)) throw new ApiError("in set_selection: Expected an array of nodes");
      const ids = v.filter((x): x is string => typeof x === "string");
      for (const id of ids) if (pageOf(ctx, id) !== n.guid) throw new ApiError(`in set_selection: Node ${id} is not on page ${n.name}`);
      if (n.guid !== ctx.ed.store.page) return;
      ctx.ed.engine.setSelection(ids);
    },
  },
  backgrounds: {
    get: (_ctx, n) => {
      const c = (n as unknown as Obj).backgroundColor as { r: number; g: number; b: number; a?: number } | undefined;
      return [{ type: "SOLID", visible: true, opacity: c?.a ?? 1, blendMode: "NORMAL", color: { r: c?.r ?? 0.96, g: c?.g ?? 0.96, b: c?.b ?? 0.96 }, boundVariables: {} }];
    },
    set: (ctx, n, v) => {
      const p = paintsFromApi(v, "backgrounds")[0];
      if (p?.type === "SOLID") writeFields(ctx, n.guid, { backgroundColor: { ...p.color!, a: p.opacity ?? 1 } } as NodeFields, "backgrounds");
    },
  },
  flowStartingPoints: {
    get: (ctx, n) =>
      childrenOf(ctx, n)
        .filter((c) => (c as unknown as Obj).prototypeStartingPoint)
        .map((c) => ({ nodeId: c.guid, name: ((c as unknown as Obj).prototypeStartingPoint as { name?: string }).name ?? "" })),
  },
  documentColorProfile: { get: (ctx) => ((readNode(ctx, "0:0", false) as unknown as Obj | null)?.documentColorProfile as string | undefined) ?? "LEGACY" },
  // Components
  componentPropertyDefinitions: {
    get: (ctx, n) => {
      const info = ctx.ed.engine.componentInfo(n.guid);
      const out: Obj = {};
      for (const p of info?.properties ?? []) {
        const key = p.type === "VARIANT" ? p.name : `${p.name}#${p.id}`;
        out[key] = { type: p.type, defaultValue: p.type === "VARIANT" ? p.variantOptions[0] : p.value, ...(p.type === "VARIANT" ? { variantOptions: p.variantOptions } : {}) };
      }
      return out;
    },
  },
  componentProperties: {
    get: (ctx, n) => {
      const info = ctx.ed.engine.componentInfo(n.guid);
      const out: Obj = {};
      for (const p of info?.properties ?? []) out[p.type === "VARIANT" ? p.name : `${p.name}#${p.id}`] = { type: p.type, value: p.value };
      return out;
    },
  },
  variantProperties: {
    get: (ctx, n) => {
      const info = ctx.ed.engine.componentInfo(n.guid);
      const vs = (info?.properties ?? []).filter((p) => p.type === "VARIANT");
      return vs.length ? Object.fromEntries(vs.map((p) => [p.name, p.value])) : null;
    },
  },
  mainComponent: { get: (ctx, n) => (n.type === "INSTANCE" ? ref(mainOf(ctx.ed, n as never) as NodeChange | null) : null) },
  detachedInfo: { get: (ctx, n) => detachedInfo(ctx, n) },
  overrides: { get: () => [] },
  exposedInstances: { get: () => [] },
  isExposedInstance: field("isExposedInstance", false),
  defaultVariant: { get: (ctx, n) => ref(childrenOf(ctx, n)[0] ?? null) },
  // Dev Mode
  devStatus: {
    get: (_ctx, n) => {
      const s = (n as unknown as Obj).sectionStatusInfo as { status?: string; description?: string } | undefined;
      if (!s?.status || s.status === "NONE") return null;
      return { type: s.status === "COMPLETED" ? "COMPLETED" : "READY_FOR_DEV", ...(s.description ? { description: s.description } : {}) };
    },
    set: (ctx, n, v) => {
      const o = v as { type?: string; description?: string } | null;
      writeFields(ctx, n.guid, { sectionStatusInfo: o ? { status: o.type === "COMPLETED" ? "COMPLETED" : "BUILD", description: o.description ?? "" } : { status: "NONE" } } as NodeFields, "devStatus");
    },
  },
  annotations: {
    get: (_ctx, n) => (((n as unknown as Obj).annotations as Obj[] | undefined) ?? []).map((a) => ({ label: a.label ?? "", ...(a.labelMarkdown ? { labelMarkdown: a.labelMarkdown } : {}), properties: a.properties ?? [], ...(a.categoryId ? { categoryId: a.categoryId } : {}) })),
    set: (ctx, n, v) => writeFields(ctx, n.guid, { annotations: (Array.isArray(v) ? v : []).map((a: Obj) => ({ label: String(a.label ?? a.labelMarkdown ?? ""), ...(a.categoryId ? { categoryId: a.categoryId } : {}), properties: a.properties ?? [] })) } as NodeFields, "annotations"),
  },
  reactions: {
    get: (_ctx, n) => ((n as unknown as Obj).prototypeInteractions as Obj[] | undefined)?.filter((i) => !i.isDeleted) ?? [],
    set: (ctx, n, v) => writeFields(ctx, n.guid, { prototypeInteractions: v } as NodeFields, "reactions"),
  },
  // Not modelled: Figma's values for what we don't keep.
  stuckNodes: { get: () => [] },
  attachedConnectors: { get: () => [] },
  boundVariables: { get: (ctx, n) => boundVariables(ctx, n) },
  resolvedVariableModes: { get: () => ({}) },
  explicitVariableModes: { get: () => ({}) },
  inferredVariables: { get: () => ({}) },
  componentPropertyReferences: { get: () => null },
  fillGeometry: { get: () => [] },
  strokeGeometry: { get: () => [] },
  vectorPaths: { get: () => [] },
  vectorNetwork: { get: () => ({ vertices: [], segments: [], regions: [] }) },
  handleMirroring: { get: () => "NONE" },
  arcData: field("arcData", { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 }),
  pointCount: viaSpec("pointCount", (v) => v ?? 3),
  innerRadius: viaSpec("innerRadius", (v) => v ?? 0.382),
  targetAspectRatio: { get: () => null },
  sectionContentsHidden: field("sectionContentsHidden", false, needBool("sectionContentsHidden")),
  openTypeFeatures: { get: () => ({}) },
  scaleFactor: { get: () => 1 },
  numberOfFixedChildren: { get: () => 0 },
  overflowDirection: { get: (_ctx, n) => (n as unknown as Obj).scrollDirection ?? "NONE", set: (ctx, n, v) => writeFields(ctx, n.guid, { scrollDirection: v } as NodeFields, "overflowDirection") },
  isPageDivider: { get: () => false },
  selectedTextRange: { get: () => null, set: () => {} },
  prototypeBackgrounds: { get: () => [] },
  prototypeStartNode: { get: () => null },
  gridRowCount: field("gridRows", 0),
  gridColumnCount: field("gridColumns", 0),
  gridRowGap: field("gridRowGap", 0),
  gridColumnGap: field("gridColumnGap", 0),
  // Draw (docs/draw.md §7, api/draw.ts)
  textPathStartData: { get: (_ctx, n) => textPathStartData(n), set: setTextPathStartData, only: ["TEXT_PATH"] },
  transformModifiers: { get: (_ctx, n) => transformModifiers(n), set: setTransformModifiers, only: ["TRANSFORM_GROUP"] },
  complexStrokeProperties: { get: complexStrokeProperties, set: setComplexStrokeProperties },
  variableWidthStrokeProperties: { get: variableWidthStrokeProperties, set: setVariableWidthStrokeProperties },
};

function boundVariables(ctx: ApiContext, n: NodeChange): Obj {
  const out: Obj = {};
  for (const b of ctx.ed.engine.boundVariables(n.guid)) {
    const key = String((b as unknown as Obj).field ?? (b as unknown as Obj).target ?? "");
    if (!key) continue;
    out[key] = { type: "VARIABLE_ALIAS", id: (b as unknown as Obj).variable };
  }
  return out;
}

/** Figma's rule: changing a text's characters needs its fonts loaded (`figma.loadFontAsync`). */
function requireFonts(ctx: ApiContext, n: NodeChange): void {
  void ctx;
  void n;
}

export function pageOf(ctx: ApiContext, id: Guid): Guid | null {
  let n = readNode(ctx, id, false);
  for (let i = 0; n && i < 400; i++) {
    if (n.type === "CANVAS") return n.guid;
    n = n.parentIndex?.guid ? readNode(ctx, n.parentIndex.guid, false) : null;
  }
  return null;
}

/** `node.prop` for the VM. */
export function getProp(ctx: ApiContext, id: Guid, name: string): unknown {
  // A removed node answers `removed` (true) instead of throwing (Figma: "Returns true if this node has been removed").
  if (name === "removed" && id !== "0:0") return !readNode(ctx, id, false);
  const n = id === "0:0" ? ({ ...(readNode(ctx, "0:0") ?? {}), guid: "0:0", type: "DOCUMENT" } as NodeChange) : mustNode(ctx, id);
  const p = PROPS[name];
  if (p) return p.get(ctx, n);
  if (isSpecProp(name)) return viaSpec(name).get(ctx, n);
  return undefined;
}

/** `node.prop = value` for the VM. */
export function setProp(ctx: ApiContext, id: Guid, name: string, value: unknown): void {
  if (ctx.editorType === "dev" && !["devStatus", "annotations"].includes(name)) throw new ApiError(`Cannot write to node ${id} in Dev Mode`);
  const n = mustNode(ctx, id);
  const p = PROPS[name];
  if (p) {
    if (!p.set) throw new ApiError(`Cannot assign to read only property '${name}' of object '${apiType(n as never)}'`);
    return p.set(ctx, n, value);
  }
  if (isSpecProp(name)) return viaSpec(name).set!(ctx, n, value);
  throw new ApiError(`object is not extensible: cannot set '${name}'`);
}

// ---- Node methods ---------------------------------------------------------------------------------------------------

/** A child's position key at `index` among `parent`'s children (paint order, 0 = bottom). */
export function positionAt(ctx: ApiContext, parent: Guid, index: number, without?: Guid): string {
  const p = readNode(ctx, parent);
  const kids = ((p?.childIds ?? []) as Guid[]).filter((c) => c !== without);
  const at = index < 0 || index > kids.length ? kids.length : index;
  const key = (id: Guid | undefined) => (id ? readNode(ctx, id, false)?.parentIndex?.position : undefined);
  const before = at > 0 ? key(kids[at - 1]) : undefined;
  const after = at < kids.length ? key(kids[at]) : undefined;
  if (before && after) return keyBetween(before, after);
  if (before) return keyAfter(before);
  return keyBetween("", after ?? null);
}

export function insertChild(ctx: ApiContext, parentId: Guid, childId: unknown, index: number): void {
  const parent = mustNode(ctx, parentId);
  const child = mustNode(ctx, childId);
  if (child.type === "CANVAS") throw new ApiError("Cannot move a page into a node");
  for (let a: NodeChange | null = parent; a; a = parentOf(ctx, a)) if (a.guid === child.guid) throw new ApiError("Cannot move a node into itself or its descendants");
  ctx.write();
  const count = (parent.childIds ?? []).filter((c) => c !== child.guid).length;
  const at = index < 0 || index > count ? count : index;
  const moved = ctx.ed.engine.moveNodes([child.guid], parent.guid === "0:0" ? "0:0" : parent.guid, at);
  if (!moved) throw new ApiError(`Cannot move node ${child.guid} into ${apiType(parent as never)} ${parent.guid}`);
}

export function removeNode(ctx: ApiContext, id: Guid): void {
  const n = mustNode(ctx, id);
  if (n.type === "CANVAS" && ctx.ed.engine.pages().length <= 1) throw new ApiError("Cannot remove the last page of a document");
  ctx.write();
  if (n.type === "CANVAS") {
    ctx.ed.engine.command("DELETE_PAGE", { page: id });
    return;
  }
  ctx.ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: ctx.ed.source.sessionID ?? 1, nodeChanges: [{ guid: id, phase: "REMOVED" } as NodeChange] }, "user");
}

/** `findAll` / `findAllWithCriteria`: the subtree below `id` (not itself), in Figma's order (depth first). */
export function descendants(ctx: ApiContext, id: Guid, criteria: Obj | null): unknown[] {
  const roots = id === "0:0" ? ctx.ed.engine.pages().map((p) => (p as { guid: string }).guid) : [id];
  const all = ctx.ed.engine.readNodes(roots, { subtree: true, childIds: true }).map(ctx.ed.withRealType);
  const byId = new Map(all.map((n) => [n.guid, n]));
  const out: NodeChange[] = [];
  const skipHidden = ctx.flags.skipInvisibleInstanceChildren;
  const walk = (n: NodeChange, insideInstance: boolean) => {
    for (const c of (n.childIds ?? []) as Guid[]) {
      const k = byId.get(c);
      if (!k) continue;
      if (skipHidden && insideInstance && k.visible === false) continue;
      out.push(k);
      walk(k, insideInstance || k.type === "INSTANCE");
    }
  };
  if (id === "0:0") for (const r of roots) {
    const p = byId.get(r);
    if (p) {
      out.push(p);
      walk(p, false);
    }
  }
  else {
    const root = byId.get(id);
    if (root) walk(root, root.type === "INSTANCE");
  }
  let list = out;
  if (criteria) {
    const types = Array.isArray(criteria.types) ? (criteria.types as string[]) : null;
    if (types) list = list.filter((n) => types.includes(apiType(n as never)));
    const pd = Array.isArray(criteria.pluginData?.valueOf()) ? null : (criteria.pluginData as { keys?: string[] } | undefined);
    if (pd) list = list.filter((n) => (n.pluginData ?? []).some((e) => e.pluginID === ctx.pluginId && ctx.pluginId !== RESERVED_PLUGIN_ID && e.value && (!pd.keys || pd.keys.includes(e.key ?? ""))));
    const spd = criteria.sharedPluginData as { namespace?: string; keys?: string[] } | undefined;
    if (spd?.namespace) list = list.filter((n) => (n.pluginData ?? []).some((e) => e.pluginID === `shared:${spd.namespace}` && e.value && (!spd.keys || spd.keys.includes(e.key ?? ""))));
  }
  return list.map(ref);
}

export function resize(ctx: ApiContext, id: Guid, w: unknown, h: unknown, withConstraints: boolean): void {
  const n = mustNode(ctx, id);
  if (typeof w !== "number" || typeof h !== "number" || !(w >= 0.01 || (n.type === "LINE" && w >= 0)) || !(h >= 0.01 || (n.type === "LINE" && h === 0))) throw new ApiError("in resize: Expected width and height to be numbers ≥ 0.01");
  const fields: NodeFields = { size: { x: w, y: h } };
  // Figma: resizing a hugging auto-layout frame makes it fixed on that axis; a text's auto width stops.
  const parent = parentOf(ctx, n);
  for (const [axis, value, cur] of [["H", w, n.size?.x ?? 0], ["V", h, n.size?.y ?? 0]] as const) {
    if (value === cur) continue;
    const s = sizingOf(n, parent, axis);
    if (s !== "FIXED" && !isText(n)) Object.assign(fields, fieldsOf({ [axis === "H" ? "layoutSizingHorizontal" : "layoutSizingVertical"]: "FIXED" }, n, parent).fields);
  }
  if (isText(n)) {
    const r = n.textAutoResize ?? "NONE";
    if (r === "WIDTH_AND_HEIGHT" && w !== (n.size?.x ?? 0)) fields.textAutoResize = h !== (n.size?.y ?? 0) ? "NONE" : "HEIGHT";
    else if (r === "HEIGHT" && h !== (n.size?.y ?? 0)) fields.textAutoResize = "NONE";
  }
  void withConstraints;
  writeFields(ctx, id, fields, "resize");
}

export function rescale(ctx: ApiContext, id: Guid, scale: unknown): void {
  const n = mustNode(ctx, id);
  if (typeof scale !== "number" || scale < 0.01) throw new ApiError("in rescale: Expected scale ≥ 0.01");
  writeFields(ctx, id, { size: { x: (n.size?.x ?? 0) * scale, y: (n.size?.y ?? 0) * scale }, ...(isText(n) ? { fontSize: (n.fontSize ?? 12) * scale } : {}), ...(n.strokeWeight ? { strokeWeight: n.strokeWeight * scale } : {}) }, "rescale");
}

// ---- Plugin data (docs/plugins.md §8) ---------------------------------------------------------------------------------

const KEY_LIMIT = 100 * 1024;
/** Ours (editor/frameStatus.ts: frame statuses): never a plugin's to read or write, whatever its manifest id. */
const RESERVED_PLUGIN_ID = "designer.workflow";
const ownerOf = (ctx: ApiContext, namespace: string | null): string => {
  const owner = namespace === null ? ctx.pluginId : `shared:${namespace}`;
  if (owner === RESERVED_PLUGIN_ID) throw new ApiError("This plugin ID is reserved");
  return owner;
};

export function getPluginData(ctx: ApiContext, id: Guid, namespace: string | null, key: string): string {
  const n = mustNode(ctx, id);
  const owner = ownerOf(ctx, namespace);
  return (n.pluginData ?? []).find((e) => e.pluginID === owner && e.key === key)?.value ?? "";
}

export function setPluginData(ctx: ApiContext, id: Guid, namespace: string | null, key: string, value: string): void {
  if (namespace !== null && !/^[\w.]{3,}$/.test(namespace)) throw new ApiError("Namespace must be at least 3 alphanumeric characters (letters, numbers, underscores or periods)");
  if (key.length + value.length > KEY_LIMIT) throw new ApiError("Plugin data is limited to 100 kB per entry");
  const n = mustNode(ctx, id);
  const owner = ownerOf(ctx, namespace);
  const rest = (n.pluginData ?? []).filter((e) => !(e.pluginID === owner && e.key === key));
  const next = value === "" ? rest : [...rest, { pluginID: owner, key, value }];
  if (next.length === (n.pluginData ?? []).length && value === "" ) return;
  writeFields(ctx, id, { pluginData: next } as NodeFields, "pluginData");
}

export function pluginDataKeys(ctx: ApiContext, id: Guid, namespace: string | null): string[] {
  const n = mustNode(ctx, id);
  const owner = ownerOf(ctx, namespace);
  return (n.pluginData ?? []).filter((e) => e.pluginID === owner && e.value).map((e) => e.key ?? "");
}

/** setRelaunchData({command: message}): this plugin's buttons on the node (an empty object clears them). */
export function setRelaunchData(ctx: ApiContext, id: Guid, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("in setRelaunchData: Expected an object {command: description}");
  const commands = (ctx.manifest.relaunchButtons ?? []).map((b) => b.command);
  for (const k of Object.keys(data as Obj)) if (!commands.includes(k)) throw new ApiError(`in setRelaunchData: The command "${k}" isn't in the manifest's relaunchButtons`);
  const n = mustNode(ctx, id);
  const rest = (n.pluginRelaunchData ?? []).filter((e) => e.pluginID !== ctx.pluginId);
  const mine = Object.entries(data as Obj).map(([command, message]) => ({ pluginID: ctx.pluginId, command, message: String(message ?? ""), isDeleted: false }));
  writeFields(ctx, id, { pluginRelaunchData: [...rest, ...mine] } as NodeFields, "relaunchData");
}

export function getRelaunchData(ctx: ApiContext, id: Guid): Obj {
  const n = mustNode(ctx, id);
  return Object.fromEntries((n.pluginRelaunchData ?? []).filter((e) => e.pluginID === ctx.pluginId && !e.isDeleted).map((e) => [e.command ?? "", e.message ?? ""]));
}

export function nodeCss(ctx: ApiContext, id: Guid): Record<string, string> {
  const n = mustNode(ctx, id);
  const css = cssOf(n as never) as unknown;
  if (typeof css === "string") {
    const out: Record<string, string> = {};
    for (const line of css.split(/;\s*\n?/)) {
      const i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }
  return (css as Record<string, string>) ?? {};
}

export function topLevelFrame(ctx: ApiContext, id: Guid) {
  let n = mustNode(ctx, id);
  let top: NodeChange | null = null;
  for (let i = 0; i < 400; i++) {
    const p = parentOf(ctx, n);
    if (!p || p.type === "CANVAS") {
      top = n.type === "CANVAS" ? null : n;
      break;
    }
    n = p;
  }
  return top && ["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(top.type ?? "") ? ref(top) : null;
}
