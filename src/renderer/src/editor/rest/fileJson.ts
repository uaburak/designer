/**
 * Figma's REST file JSON from the engine's document (docs/multiplayer.md §16.6 "What the client computes"):
 * `GET /v1/files/:key` and `GET /v1/files/:key/nodes` as developers.figma.com/docs/rest-api/file-endpoints and its
 * node types describe them — DOCUMENT › CANVAS › the scene nodes, each with Figma's REST names (`fills`, `strokes`,
 * `absoluteBoundingBox`, `layoutMode`, `characters` + `style` + `characterStyleOverrides`, `componentProperties`,
 * `boundVariables` …), and the file's `components`, `componentSets` and `styles`.
 *
 * Read from the engine (`readNodes` of each page's subtree, instance sublayers included under Figma's own ids
 * `I1:2;3:4`), so a version loaded in a scratch engine answers the same way. Where our document can't say what
 * Figma would (glyph ink bounds, outlined strokes), the as-built list in docs/multiplayer.md §16.16 names it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from "@/engine/Engine";
import type { BoundVariable } from "@/engine/codec";
import type { FileParams } from "../../../../shared/rest/types";
import { guidStr, restCollectionId, restVariableId } from "./ids";

type Any = any;
type Matrix = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
type Rect = { x: number; y: number; width: number; height: number };

const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** What the answer says about the file besides its document (the job's context from the store) */
export interface FileJsonContext {
  name: string;
  /** Epoch ms */
  lastModified: number;
  /** Figma's `version`: the room seq this copy holds (`GET /v1/files/:key/meta`'s `version` too) */
  version: string;
}

// ---- small helpers ----------------------------------------------------------------------------------------------------

const mul = (a: Matrix, b: Matrix): Matrix => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

function boxOf(m: Matrix, w: number, h: number): Rect {
  const xs = [0, w, 0, w].map((x, i) => m.m00 * x + m.m01 * [0, 0, h, h][i] + m.m02);
  const ys = [0, w, 0, w].map((x, i) => m.m10 * x + m.m11 * [0, 0, h, h][i] + m.m12);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: round(x), y: round(y), width: round(Math.max(...xs) - x), height: round(Math.max(...ys) - y) };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const fmt = (v: number) => String(round(v));

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x: round(x), y: round(y), width: round(Math.max(a.x + a.width, b.x + b.width) - x), height: round(Math.max(a.y + a.height, b.y + b.height) - y) };
}

const grow = (r: Rect, d: number): Rect => ({ x: round(r.x - d), y: round(r.y - d), width: round(r.width + 2 * d), height: round(r.height + 2 * d) });

const color = (c: Any) => ({ r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 });

/** An image hash (20 bytes, or hex) as Figma's `imageRef` (hex) */
function hashHex(h: unknown): string | null {
  if (typeof h === "string") return h.toLowerCase();
  if (Array.isArray(h)) return h.map((x) => (Number(x) & 255).toString(16).padStart(2, "0")).join("");
  if (h instanceof Uint8Array) return [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
  return null;
}

/** Inverse of a 2×3 matrix (identity when singular) */
function invert(m: Matrix): Matrix {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det) return IDENTITY;
  const i00 = m.m11 / det;
  const i01 = -m.m01 / det;
  const i10 = -m.m10 / det;
  const i11 = m.m00 / det;
  return { m00: i00, m01: i01, m02: -(i00 * m.m02 + i01 * m.m12), m10: i10, m11: i11, m12: -(i10 * m.m02 + i11 * m.m12) };
}

const apply = (m: Matrix, x: number, y: number) => ({ x: round(m.m00 * x + m.m01 * y + m.m02), y: round(m.m10 * x + m.m11 * y + m.m12) });

// ---- node types --------------------------------------------------------------------------------------------------------

const SHAPES = new Set(["RECTANGLE", "ELLIPSE", "VECTOR", "STAR", "LINE", "REGULAR_POLYGON", "BOOLEAN_OPERATION"]);
const FRAMES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

/** Our document's type → Figma's REST type (a GROUP is a FRAME that hugs its children, a COMPONENT a SYMBOL, a COMPONENT_SET a FRAME with isStateGroup) */
export function restType(n: Any): string | null {
  switch (n.type) {
    case "DOCUMENT":
    case "CANVAS":
    case "SECTION":
    case "INSTANCE":
    case "TEXT":
    case "VECTOR":
    case "STAR":
    case "LINE":
    case "ELLIPSE":
    case "REGULAR_POLYGON":
    case "BOOLEAN_OPERATION":
    case "SLICE":
      return n.type;
    case "FRAME":
      // Figma's files: a component set is a FRAME with isStateGroup, a group a FRAME that hugs its children
      return n.isStateGroup === true ? "COMPONENT_SET" : n.resizeToFit === true ? "GROUP" : "FRAME";
    case "SYMBOL":
      return n.isStateGroup === true ? "COMPONENT_SET" : "COMPONENT";
    case "RECTANGLE":
    case "ROUNDED_RECTANGLE":
      return "RECTANGLE";
    case "BRUSH":
      return "VECTOR";
    default:
      return null;
  }
}

// ---- paints, effects, strokes --------------------------------------------------------------------------------------

const SCALE_MODE: Record<string, string> = { STRETCH: "STRETCH", FIT: "FIT", FILL: "FILL", TILE: "TILE" };

function restPaint(p: Any, bound?: Record<string, unknown>): Any {
  const out: Any = { blendMode: p.blendMode ?? "NORMAL", type: p.type };
  if (p.visible === false) out.visible = false;
  if (p.opacity !== undefined && p.opacity !== 1) out.opacity = p.opacity;
  const t: string = p.type;
  if (t === "SOLID") out.color = color(p.color);
  else if (t.startsWith("GRADIENT_")) {
    // Figma's handles: the gradient's (0, .5) start, (1, .5) end and (0, 1) width, in the node's unit square
    const inv = invert(p.transform ?? IDENTITY);
    out.gradientHandlePositions = [apply(inv, 0, 0.5), apply(inv, 1, 0.5), apply(inv, 0, 1)];
    out.gradientStops = (p.stops ?? []).map((s: Any) => ({ color: color(s.color), position: s.position ?? 0 }));
  } else if (t === "IMAGE" || t === "VIDEO") {
    out.scaleMode = SCALE_MODE[p.imageScaleMode] ?? "FILL";
    const ref = hashHex(p.image?.hash);
    if (ref) out.imageRef = ref;
    if (t === "VIDEO") {
      const v = hashHex(p.video?.hash);
      if (v) out.videoRef = v;
    }
    const m: Matrix = p.transform ?? IDENTITY;
    if (out.scaleMode === "STRETCH") out.imageTransform = [[m.m00, m.m01, m.m02], [m.m10, m.m11, m.m12]];
    if (out.scaleMode === "TILE") out.scalingFactor = p.scale ?? 1;
    if (p.rotation) out.rotation = p.rotation;
    const f = p.paintFilter;
    if (f && Object.values(f).some((v) => typeof v === "number" && v !== 0)) out.filters = { ...f };
  } else if (t === "PATTERN") {
    out.sourceNodeId = guidStr(p.sourceNodeId) ?? undefined;
    out.tileType = p.patternTileType ?? "RECTANGULAR";
    out.scalingFactor = p.scale ?? 1;
    out.spacing = p.patternSpacing ?? { x: 0, y: 0 };
    out.horizontalAlignment = p.horizontalAlignment ?? "START";
  } else if (t === "NOISE") {
    out.color = color(p.color);
    out.noiseType = p.noiseType ?? "MONOTONE";
    out.density = p.density ?? 1;
    out.noiseSize = p.noiseSize?.x ?? 0.5;
  }
  if (bound && Object.keys(bound).length) out.boundVariables = bound;
  return out;
}

const EFFECT_TYPE: Record<string, string> = { DROP_SHADOW: "DROP_SHADOW", INNER_SHADOW: "INNER_SHADOW", FOREGROUND_BLUR: "LAYER_BLUR", BACKGROUND_BLUR: "BACKGROUND_BLUR", GRAIN: "TEXTURE", NOISE: "NOISE", GLASS: "GLASS" };

function restEffect(e: Any, bound?: Record<string, unknown>): Any | null {
  const type = EFFECT_TYPE[e.type];
  if (!type) return null;
  const out: Any = { type, visible: e.visible !== false, radius: e.radius ?? 0 };
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
    out.color = color(e.color);
    out.blendMode = e.blendMode ?? "NORMAL";
    out.offset = { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0 };
    out.spread = e.spread ?? 0;
    if (type === "DROP_SHADOW") out.showShadowBehindNode = e.showShadowBehindNode === true;
  }
  if (bound && Object.keys(bound).length) out.boundVariables = bound;
  return out;
}

function restGrid(g: Any): Any {
  const pattern = g.pattern === "GRID" ? "GRID" : g.axis === "Y" ? "ROWS" : "COLUMNS";
  const out: Any = { pattern, sectionSize: g.sectionSize ?? 10, visible: g.visible !== false, color: color(g.color) };
  if (pattern !== "GRID") Object.assign(out, { alignment: g.type ?? "STRETCH", gutterSize: g.gutterSize ?? 0, offset: g.offset ?? 0, count: g.numSections ?? 0 });
  return out;
}

const CONSTRAINT_H: Record<string, string> = { MIN: "LEFT", MAX: "RIGHT", CENTER: "CENTER", STRETCH: "LEFT_RIGHT", SCALE: "SCALE", FIXED_MIN: "LEFT", FIXED_MAX: "RIGHT" };
const CONSTRAINT_V: Record<string, string> = { MIN: "TOP", MAX: "BOTTOM", CENTER: "CENTER", STRETCH: "TOP_BOTTOM", SCALE: "SCALE", FIXED_MIN: "TOP", FIXED_MAX: "BOTTOM" };

const FORMAT: Record<string, string> = { PNG: "PNG", JPEG: "JPG", SVG: "SVG", PDF: "PDF" };
const CONSTRAINT: Record<string, string> = { CONTENT_SCALE: "SCALE", CONTENT_WIDTH: "WIDTH", CONTENT_HEIGHT: "HEIGHT" };

const restExport = (s: Any) => ({ suffix: s.suffix ?? "", format: FORMAT[s.imageType] ?? "PNG", constraint: { type: CONSTRAINT[s.constraint?.type] ?? "SCALE", value: s.constraint?.value ?? 1 } });

// ---- text ----------------------------------------------------------------------------------------------------------------

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/light/i, 300],
  [/medium/i, 500],
  [/bold/i, 700],
];

/** A style name's weight (Figma's REST `fontWeight`) */
export function fontWeight(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  return 400;
}

/** Figma's TypeStyle from the run's fields (`n`: a TEXT node or a style override row); `base` fills what a row lacks */
function typeStyle(n: Any, base: Any | null, intrinsicLine: number | null): Any {
  const out: Any = {};
  const has = (k: string) => n[k] !== undefined && (base === null || JSON.stringify(n[k]) !== JSON.stringify(base[k]));
  if (has("fontName")) {
    const f = n.fontName ?? {};
    out.fontFamily = f.family ?? "Inter";
    if (f.postscript) out.fontPostScriptName = f.postscript;
    out.fontStyle = f.style ?? "Regular";
    out.italic = /italic|oblique/i.test(f.style ?? "");
    out.fontWeight = fontWeight(f.style ?? "Regular");
  }
  const size = n.fontSize ?? base?.fontSize ?? 12;
  if (has("fontSize")) out.fontSize = size;
  if (has("textAlignHorizontal") && base === null) out.textAlignHorizontal = n.textAlignHorizontal === "JUSTIFIED" ? "JUSTIFIED" : (n.textAlignHorizontal ?? "LEFT");
  if (has("textAlignVertical") && base === null) out.textAlignVertical = n.textAlignVertical ?? "TOP";
  if (has("letterSpacing")) {
    const ls = n.letterSpacing ?? { value: 0, units: "PERCENT" };
    out.letterSpacing = round(ls.units === "PERCENT" ? (ls.value / 100) * size : ls.value);
  }
  if (has("lineHeight")) {
    const lh = n.lineHeight ?? { value: 100, units: "PERCENT" };
    if (lh.units === "PIXELS") Object.assign(out, { lineHeightPx: lh.value, lineHeightPercent: round((lh.value / (intrinsicLine ?? size * 1.21)) * 100), lineHeightPercentFontSize: round((lh.value / size) * 100), lineHeightUnit: "PIXELS" });
    else if (lh.units === "RAW" || (lh.units === "PERCENT" && lh.value !== 100)) {
      const pct = lh.units === "RAW" ? lh.value * 100 : lh.value;
      Object.assign(out, { lineHeightPx: round((size * pct) / 100), lineHeightPercent: round(((size * pct) / 100 / (intrinsicLine ?? size * 1.21)) * 100), lineHeightPercentFontSize: round(pct), lineHeightUnit: "FONT_SIZE_%" });
    } else Object.assign(out, { lineHeightPx: round(intrinsicLine ?? size * 1.21), lineHeightPercent: 100, lineHeightUnit: "INTRINSIC_%" });
  }
  if (has("textCase") && n.textCase && n.textCase !== "ORIGINAL") out.textCase = n.textCase === "SMALL_CAPS_FORCED" ? "SMALL_CAPS_FORCED" : n.textCase;
  if (has("textDecoration") && n.textDecoration && n.textDecoration !== "NONE") out.textDecoration = n.textDecoration;
  if (base === null) {
    if (n.textAutoResize && n.textAutoResize !== "NONE") out.textAutoResize = n.textAutoResize;
    if (n.textTruncation === "ENDING") {
      out.textTruncation = "ENDING";
      if (n.maxLines) out.maxLines = n.maxLines;
    }
    if (n.paragraphSpacing) out.paragraphSpacing = n.paragraphSpacing;
    if (n.paragraphIndent) out.paragraphIndent = n.paragraphIndent;
  }
  if (base !== null && n.fillPaints !== undefined) out.fills = (n.fillPaints ?? []).map((p: Any) => restPaint(p));
  if (has("hyperlink") && n.hyperlink?.url) out.hyperlink = { type: "URL", url: n.hyperlink.url };
  if (has("hyperlink") && guidStr(n.hyperlink?.guid)) out.hyperlink = { type: "NODE", nodeID: guidStr(n.hyperlink.guid) };
  return out;
}

// ---- bound variables ------------------------------------------------------------------------------------------------

const FIELD: Record<string, string> = {
  STROKE_WEIGHT: "strokeWeight",
  STACK_SPACING: "itemSpacing",
  STACK_COUNTER_SPACING: "counterAxisSpacing",
  STACK_PADDING_LEFT: "paddingLeft",
  STACK_PADDING_TOP: "paddingTop",
  STACK_PADDING_RIGHT: "paddingRight",
  STACK_PADDING_BOTTOM: "paddingBottom",
  VISIBLE: "visible",
  TEXT_DATA: "characters",
  OPACITY: "opacity",
  MIN_WIDTH: "minWidth",
  MAX_WIDTH: "maxWidth",
  MIN_HEIGHT: "minHeight",
  MAX_HEIGHT: "maxHeight",
  GRID_ROW_GAP: "gridRowGap",
  GRID_COLUMN_GAP: "gridColumnGap",
};
const LIST_FIELD: Record<string, string> = { FONT_FAMILY: "fontFamily", FONT_STYLE: "fontStyle", FONT_SIZE: "fontSize", LETTER_SPACING: "letterSpacing", LINE_HEIGHT: "lineHeight", PARAGRAPH_SPACING: "paragraphSpacing", PARAGRAPH_INDENT: "paragraphIndent" };
const CORNERS: Record<string, string> = { RECTANGLE_TOP_LEFT_CORNER_RADIUS: "topLeftRadius", RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "topRightRadius", RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "bottomLeftRadius", RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "bottomRightRadius" };
const BORDERS: Record<string, string> = { BORDER_TOP_WEIGHT: "top", BORDER_RIGHT_WEIGHT: "right", BORDER_BOTTOM_WEIGHT: "bottom", BORDER_LEFT_WEIGHT: "left" };
const EFFECT_FIELD: Record<string, string> = { color: "color", radius: "radius", spread: "spread", x: "offsetX", y: "offsetY" };
const GRID_FIELD: Record<string, string> = { numSections: "count", offset: "offset", sectionSize: "sectionSize", gutterSize: "gutterSize" };

/** A node's bindings in Figma's REST shape: the node's `boundVariables`, and per paint / effect / grid their own */
function restBindings(bound: BoundVariable[], alias: (id: string) => Any): { node: Any; paints: Map<string, Any>; effects: Map<number, Any>; grids: Map<number, Any> } {
  const node: Any = {};
  const paints = new Map<string, Any>();
  const effects = new Map<number, Any>();
  const grids = new Map<number, Any>();
  const sub = <K>(map: Map<K, Any>, k: K) => {
    let v = map.get(k);
    if (!v) map.set(k, (v = {}));
    return v;
  };
  for (const b of bound) {
    if (!b.variable) continue;
    const a = alias(b.variable);
    const t = b.target;
    let m: RegExpExecArray | null;
    if (FIELD[t]) node[FIELD[t]] = a;
    else if (LIST_FIELD[t]) node[LIST_FIELD[t]] = [a];
    else if (t === "WIDTH" || t === "HEIGHT") (node.size ??= {})[t === "WIDTH" ? "x" : "y"] = a;
    else if (CORNERS[t]) {
      node[CORNERS[t]] = a;
      (node.rectangleCornerRadii ??= {})[t] = a;
    } else if (t === "CORNER_RADIUS") {
      for (const [k, v] of Object.entries(CORNERS)) {
        (node.rectangleCornerRadii ??= {})[k] = a;
        node[v] = a;
      }
    }
    else if (BORDERS[t]) (node.individualStrokeWeights ??= {})[BORDERS[t]] = a;
    else if ((m = /^(fillPaints|strokePaints)\[(\d+)\]\.color$/.exec(t))) {
      const key = m[1] === "fillPaints" ? "fills" : "strokes";
      (node[key] ??= []).push(a);
      sub(paints, `${m[1]}:${m[2]}`).color = a;
    } else if ((m = /^effects\[(\d+)\]\.(\w+)$/.exec(t)) && EFFECT_FIELD[m[2]]) {
      if (!(node.effects ??= []).some((x: Any) => x.id === a.id)) node.effects.push(a);
      sub(effects, Number(m[1]))[EFFECT_FIELD[m[2]]] = a;
    } else if ((m = /^layoutGrids\[(\d+)\]\.(\w+)$/.exec(t)) && GRID_FIELD[m[2]]) {
      if (!(node.layoutGrids ??= []).some((x: Any) => x.id === a.id)) node.layoutGrids.push(a);
      sub(grids, Number(m[1]))[GRID_FIELD[m[2]]] = a;
    } else if ((m = /^componentProperties\.(.+)$/.exec(t))) (node.componentProperties ??= {})[m[1]] = a;
  }
  return { node, paints, effects, grids };
}

// ---- geometry ----------------------------------------------------------------------------------------------------------

/** A rectangle's outline as Figma writes it (corners as cubic Béziers) */
function rectPath(w: number, h: number, radii: [number, number, number, number]): string {
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, max)));
  if (!tl && !tr && !br && !bl) return `M0 0L${fmt(w)} 0L${fmt(w)} ${fmt(h)}L0 ${fmt(h)}L0 0Z`;
  const k = 1 - 0.5522847498;
  const p: string[] = [`M0 ${fmt(tl)}`];
  if (tl) p.push(`C0 ${fmt(tl * k)} ${fmt(tl * k)} 0 ${fmt(tl)} 0`);
  p.push(`L${fmt(w - tr)} 0`);
  if (tr) p.push(`C${fmt(w - tr * k)} 0 ${fmt(w)} ${fmt(tr * k)} ${fmt(w)} ${fmt(tr)}`);
  p.push(`L${fmt(w)} ${fmt(h - br)}`);
  if (br) p.push(`C${fmt(w)} ${fmt(h - br * k)} ${fmt(w - br * k)} ${fmt(h)} ${fmt(w - br)} ${fmt(h)}`);
  p.push(`L${fmt(bl)} ${fmt(h)}`);
  if (bl) p.push(`C${fmt(bl * k)} ${fmt(h)} 0 ${fmt(h - bl * k)} 0 ${fmt(h - bl)}`);
  p.push(`L0 ${fmt(tl)}Z`);
  return p.join("");
}

/** A full ellipse's outline as Figma writes it (four cubic Béziers from the right) */
function ellipsePath(w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * 0.5522847498;
  const ky = ry * 0.5522847498;
  return (
    `M${fmt(w)} ${fmt(ry)}` +
    `C${fmt(w)} ${fmt(ry + ky)} ${fmt(rx + kx)} ${fmt(h)} ${fmt(rx)} ${fmt(h)}` +
    `C${fmt(rx - kx)} ${fmt(h)} 0 ${fmt(ry + ky)} 0 ${fmt(ry)}` +
    `C0 ${fmt(ry - ky)} ${fmt(rx - kx)} 0 ${fmt(rx)} 0` +
    `C${fmt(rx + kx)} 0 ${fmt(w)} ${fmt(ry - ky)} ${fmt(w)} ${fmt(ry)}Z`
  );
}

/** The filled paths of the engine's own SVG export of one node, in its local space (an unrotated node's box) */
function svgPaths(svg: string): { path: string; windingRule: "NONZERO" | "EVENODD" }[] {
  const out: { path: string; windingRule: "NONZERO" | "EVENODD" }[] = [];
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attrs = m[1];
    const d = /\sd="([^"]*)"/.exec(attrs)?.[1];
    if (!d) continue;
    const fill = /\sfill="([^"]*)"/.exec(attrs)?.[1];
    if (fill === "none") continue;
    out.push({ path: d, windingRule: /fill-rule="evenodd"/.test(attrs) ? "EVENODD" : "NONZERO" });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exportSvg(engine: Engine, id: string): Promise<string | null> {
  const settings = { imageType: "SVG", constraint: { type: "CONTENT_SCALE", value: 1 }, contentsOnly: true, svgOutlineText: true, svgIDMode: "IF_NEEDED", useAbsoluteBounds: true } as never;
  const deadline = Date.now() + 3000;
  let out = engine.exportNodes([id], settings);
  while (out.status === "busy" && Date.now() < deadline && !engine.destroyed) {
    await sleep(40);
    out = engine.exportNodes([id], settings);
  }
  if (out.status === "busy") out = engine.exportNodes([id], settings, { allowPending: true });
  return out.status === "ok" && "bytes" in out ? new TextDecoder().decode(out.bytes) : null;
}

// ---- the builder -------------------------------------------------------------------------------------------------------

interface Built {
  json: Any;
  render: Rect | null;
}

/**
 * One answer's conversion: nodes in, Figma's JSON out, with the components, component sets and styles the nodes
 * name collected for the answer's maps.
 */
export class RestDocument {
  readonly components: Record<string, Any> = {};
  readonly componentSets: Record<string, Any> = {};
  readonly styles: Record<string, Any> = {};
  private geometryTasks: { json: Any; node: Any }[] = [];
  private styleInfo: Map<string, Any> | null = null;
  private variableInfo = new Map<string, Any>();

  constructor(
    private readonly engine: Engine,
    private readonly params: FileParams,
  ) {}

  /** The DOCUMENT node with its pages (`ids`: only the paths to them and their subtrees, Figma's rule) */
  document(): Any {
    const doc: Any = { id: "0:0", name: "Document", type: "DOCUMENT", scrollBehavior: "SCROLLS" };
    const depth = this.params.depth;
    const pages = this.engine.pages();
    if (depth !== undefined && depth < 1) return doc;
    const wanted = this.params.ids?.length ? new Set(this.params.ids) : null;
    doc.children = [];
    for (const p of pages) {
      const nodes = depth === 1 && !wanted ? this.engine.readNodes([p.guid], { childIds: true }) : this.engine.readNodes([p.guid], { subtree: true, childIds: true });
      const byId = new Map<string, Any>(nodes.map((n) => [n.guid, n]));
      let keep: Set<string> | null = null;
      if (wanted) {
        keep = new Set();
        const parent = new Map<string, string>();
        for (const n of nodes) for (const c of (n as Any).childIds ?? []) parent.set(c, n.guid);
        for (const id of wanted) {
          if (!byId.has(id)) continue;
          for (let at: string | undefined = id; at; at = parent.get(at)) keep.add(at);
        }
        if (!keep.has(p.guid)) continue;
      }
      const page = byId.get(p.guid);
      if (page) doc.children.push(this.convert(page, byId, IDENTITY, null, depth === undefined ? Infinity : depth - 1, keep, wanted).json);
    }
    return doc;
  }

  /** One node and its subtree (`depth` from it), for `GET …/nodes`; null when the id isn't in the document */
  subtree(id: string): Any | null {
    const nodes = this.engine.readNodes([id], { subtree: true, childIds: true });
    const root = nodes[0];
    if (!root || root.guid !== id || (root as Any).isSoftDeleted) return null;
    if (root.type === "DOCUMENT") return this.document();
    const byId = new Map<string, Any>(nodes.map((n) => [n.guid, n]));
    // The world transform of its parent, from the parents' own transforms (a page's is the identity)
    const chain: Any[] = [];
    for (let at = guidStr(root.parentIndex?.guid); at; ) {
      const p = this.engine.readNode(at, { fields: ["transform", "parentIndex", "type", "stackMode", "isStateGroup"] }) as Any;
      if (!p || p.type === "CANVAS" || p.type === "DOCUMENT") break;
      chain.unshift(p);
      at = guidStr(p.parentIndex?.guid);
    }
    let world = IDENTITY;
    for (const p of chain) world = mul(world, p.transform ?? IDENTITY);
    const parent = chain[chain.length - 1] ?? null;
    return this.convert(root, byId, world, parent, this.params.depth ?? Infinity, null, null).json;
  }

  /** `geometry=paths`: each shape's outline, from its own fields or the engine's SVG export */
  async finishGeometry(): Promise<void> {
    for (const { json, node } of this.geometryTasks.splice(0)) {
      const w = node.size?.x ?? 0;
      const h = node.size?.y ?? 0;
      const type = json.type;
      const arc = node.arcData;
      const fullEllipse = !arc || ((arc.startingAngle ?? 0) === 0 && (!arc.endingAngle || Math.abs(arc.endingAngle - 2 * Math.PI) < 1e-6) && !arc.innerRadius);
      if (type === "RECTANGLE" || type === "FRAME" || type === "COMPONENT" || type === "INSTANCE" || type === "COMPONENT_SET") {
        const r = node.rectangleCornerRadiiIndependent ? [node.rectangleTopLeftCornerRadius, node.rectangleTopRightCornerRadius, node.rectangleBottomRightCornerRadius, node.rectangleBottomLeftCornerRadius] : [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
        json.fillGeometry = [{ path: rectPath(w, h, r.map((x: unknown) => Number(x) || 0) as [number, number, number, number]), windingRule: "NONZERO" }];
      } else if (type === "ELLIPSE" && fullEllipse) json.fillGeometry = [{ path: ellipsePath(w, h), windingRule: "NONZERO" }];
      else {
        const svg = json.visible === false ? null : await exportSvg(this.engine, node.guid);
        json.fillGeometry = svg ? svgPaths(svg) : [];
      }
      // Outlined strokes aren't something the engine hands out (docs/multiplayer.md §16.16)
      json.strokeGeometry = [];
    }
  }

  private style(id: string): Any | null {
    if (!this.styleInfo) {
      this.styleInfo = new Map();
      try {
        for (const s of this.engine.styles(undefined, { includeRemote: true })) this.styleInfo.set(s.id, s);
      } catch {
        // an engine without styles
      }
    }
    return this.styleInfo.get(id) ?? null;
  }

  private alias = (id: string): Any => {
    let v = this.variableInfo.get(id);
    if (v === undefined) {
      try {
        v = this.engine.variable(id);
      } catch {
        v = null;
      }
      this.variableInfo.set(id, v);
    }
    return { type: "VARIABLE_ALIAS", id: restVariableId(id, v?.remote ? v.key || v.libraryKey : null) };
  };

  private component(id: string, node: Any | null, info: Any | null): void {
    if (this.components[id]) return;
    const n = node ?? (this.engine.readNode(id, { fields: ["name", "key", "description", "parentIndex", "type", "isStateGroup"] }) as Any);
    if (!n) return;
    const parent = guidStr(n.parentIndex?.guid);
    const parentNode = parent ? (this.engine.readNode(parent, { fields: ["type", "isStateGroup", "name", "key", "description"] }) as Any) : null;
    const remote = info?.main?.remote ?? null;
    const entry: Any = { key: remote?.key ?? n.key ?? "", name: n.name ?? "", description: n.description ?? "", remote: !!remote, documentationLinks: [] };
    if (parentNode?.isStateGroup) {
      entry.componentSetId = parent;
      this.componentSet(parent!, parentNode, !!remote);
    }
    this.components[id] = entry;
  }

  private componentSet(id: string, n: Any, remote: boolean): void {
    if (this.componentSets[id]) return;
    this.componentSets[id] = { key: n.key ?? "", name: n.name ?? "", description: n.description ?? "", remote, documentationLinks: [] };
  }

  private convert(n: Any, byId: Map<string, Any>, parentWorld: Matrix, parent: Any | null, depth: number, keep: Set<string> | null, wanted: Set<string> | null): Built {
    const type = restType(n) ?? "FRAME";
    const out: Any = { id: n.guid, name: n.name ?? "", type };
    if (n.visible === false) out.visible = false;
    if (n.locked === true) out.locked = true;
    const sb = n.scrollBehavior === "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" ? "FIXED" : n.scrollBehavior === "STICKY_SCROLLS" ? "STICKY_SCROLLS" : "SCROLLS";
    out.scrollBehavior = sb;

    let bound: ReturnType<typeof restBindings> | null = null;
    if (type !== "DOCUMENT" && type !== "CANVAS") {
      try {
        const b = this.engine.boundVariables(n.guid);
        if (b.length) bound = restBindings(b, this.alias);
      } catch {
        // an engine without variables
      }
    }

    // Children first in Figma's order (the JSON lists them right after the header)
    const world = type === "CANVAS" ? IDENTITY : mul(parentWorld, n.transform ?? IDENTITY);
    const kids: Built[] = [];
    const childIds: string[] = n.childIds ?? [];
    const inSubtree = wanted && wanted.has(n.guid);
    if (depth > 0) {
      for (const c of childIds) {
        const child = byId.get(c);
        if (!child || child.isSoftDeleted || !restType(child)) continue;
        if (keep && !inSubtree && !keep.has(c)) continue;
        kids.push(this.convert(child, byId, world, n, depth - 1, inSubtree ? null : keep, inSubtree ? null : wanted));
      }
    }
    if (type === "CANVAS" || FRAMES.has(type) || type === "BOOLEAN_OPERATION" || childIds.length) {
      if (depth > 0) out.children = kids.map((k) => k.json);
    }

    if (type === "CANVAS") {
      out.backgroundColor = color(n.backgroundColor ?? { r: 0.96, g: 0.96, b: 0.96, a: 1 });
      out.prototypeStartNodeID = null;
      out.flowStartingPoints = childIds
        .map((c) => byId.get(c))
        .filter((c) => c?.prototypeStartingPoint?.name !== undefined)
        .map((c) => ({ nodeId: c.guid, name: c.prototypeStartingPoint.name }));
      out.prototypeDevice = { type: "NONE", rotation: "NONE" };
      if (n.exportSettings?.length) out.exportSettings = n.exportSettings.map(restExport);
      return { json: out, render: null };
    }

    const w = n.size?.x ?? 0;
    const h = n.size?.y ?? 0;
    const box = boxOf(world, w, h);

    // Instances, components and sets
    if (type === "INSTANCE") {
      let info: Any = null;
      try {
        info = this.engine.componentInfo(n.guid);
      } catch {
        info = null;
      }
      const main = info?.main?.ref ?? guidStr(n.symbolData?.symbolID);
      if (main) {
        out.componentId = main;
        this.component(main, null, info);
      }
      out.isExposedInstance = info?.isExposed === true;
      const props = (info?.properties ?? []) as Any[];
      if (props.length) {
        out.componentProperties = {};
        for (const p of props) {
          const entry: Any = { type: p.type === "BOOL" ? "BOOLEAN" : p.type, value: p.value ?? p.defaultValue ?? (p.type === "BOOL" ? false : "") };
          if (p.boundVariable) entry.boundVariables = { value: this.alias(p.boundVariable) };
          if (p.preferredValues?.length) entry.preferredValues = [];
          out.componentProperties[p.type === "VARIANT" ? p.name : p.apiName] = entry;
        }
      }
      const overrides = ((info?.overrides ?? []) as Any[]).filter((o) => o.fields?.length);
      out.overrides = overrides.map((o) => ({ id: o.ref, overriddenFields: [...new Set<string>(o.fields.map(overrideField))] }));
      if (info?.exposedInstances?.length) out.exposedInstances = info.exposedInstances.map((e: Any) => e.ref);
    }
    if (type === "COMPONENT" || type === "COMPONENT_SET") {
      if (type === "COMPONENT") this.component(n.guid, n, null);
      else this.componentSet(n.guid, n, false);
      let info: Any = null;
      try {
        info = this.engine.componentInfo(n.guid);
      } catch {
        info = null;
      }
      const isVariant = type === "COMPONENT" && parent?.isStateGroup === true;
      const defs = isVariant ? [] : ((info?.properties ?? []) as Any[]);
      if (defs.length || type === "COMPONENT_SET") {
        out.componentPropertyDefinitions = {};
        for (const p of defs) {
          const def: Any = { type: p.type === "BOOL" ? "BOOLEAN" : p.type, defaultValue: p.defaultValue ?? (p.type === "BOOL" ? false : "") };
          if (p.type === "VARIANT") def.variantOptions = p.variantOptions ?? [];
          if (p.preferredValues?.length) def.preferredValues = [];
          if (p.boundVariable) def.boundVariables = { defaultValue: this.alias(p.boundVariable) };
          out.componentPropertyDefinitions[p.type === "VARIANT" ? p.name : p.apiName] = def;
        }
      }
    }

    // Layer properties
    if (type !== "SLICE") out.blendMode = n.blendMode ?? "PASS_THROUGH";
    const isFrameLike = FRAMES.has(type) && type !== "GROUP" && type !== "SECTION";
    if (isFrameLike) out.clipsContent = n.frameMaskDisabled === false;
    if (type !== "SLICE") {
      out.fills = (n.fillPaints ?? []).map((p: Any, i: number) => restPaint(p, bound?.paints.get(`fillPaints:${i}`)));
      if (type !== "GROUP") {
        out.strokes = (n.strokePaints ?? []).map((p: Any, i: number) => restPaint(p, bound?.paints.get(`strokePaints:${i}`)));
        out.strokeWeight = n.strokeWeight ?? 1;
        out.strokeAlign = n.strokeAlign ?? (type === "TEXT" || SHAPES.has(type) ? "CENTER" : "INSIDE");
        if (n.borderStrokeWeightsIndependent) out.individualStrokeWeights = { top: n.borderTopWeight ?? 0, right: n.borderRightWeight ?? 0, bottom: n.borderBottomWeight ?? 0, left: n.borderLeftWeight ?? 0 };
        if (n.dashPattern?.length) out.strokeDashes = [...n.dashPattern];
        if ((n.strokePaints ?? []).length) {
          if (n.strokeCap && n.strokeCap !== "NONE") out.strokeCap = n.strokeCap;
          if (n.strokeJoin && n.strokeJoin !== "MITER") out.strokeJoin = n.strokeJoin;
          if (n.strokeJoin === "MITER" && n.miterLimit !== undefined && n.miterLimit !== 4) out.strokeMiterAngle = round(((2 * Math.asin(1 / n.miterLimit)) * 180) / Math.PI);
        }
      }
    }
    if (type === "RECTANGLE" || isFrameLike) {
      if (n.rectangleCornerRadiiIndependent) {
        const r = [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0];
        if (r.some((x) => x)) out.rectangleCornerRadii = r;
      } else if (n.cornerRadius) out.cornerRadius = n.cornerRadius;
      if (n.cornerSmoothing) out.cornerSmoothing = n.cornerSmoothing;
    }
    if (n.opacity !== undefined && n.opacity !== 1) out.opacity = n.opacity;
    out.absoluteBoundingBox = box;
    if (n.exportSettings?.length) out.exportSettings = n.exportSettings.map(restExport);
    out.constraints = { vertical: CONSTRAINT_V[n.verticalConstraint] ?? "TOP", horizontal: CONSTRAINT_H[n.horizontalConstraint] ?? "LEFT" };
    if (n.mask === true) {
      out.isMask = true;
      out.maskType = n.maskType === "LUMINANCE" ? "LUMINANCE" : n.maskType === "OUTLINE" ? "GEOMETRY" : "ALPHA";
    }
    const effects = ((n.effects ?? []) as Any[]).map((e, i) => restEffect(e, bound?.effects.get(i))).filter((e) => e !== null);
    if (type !== "SLICE") out.effects = effects;

    // Auto layout, as a frame and as a child
    const parentStack = parent?.stackMode === "HORIZONTAL" || parent?.stackMode === "VERTICAL" ? parent.stackMode : null;
    if (type !== "SLICE") {
      out.layoutAlign = n.stackChildAlignSelf === "STRETCH" ? "STRETCH" : "INHERIT";
      out.layoutGrow = n.stackChildPrimaryGrow ? 1 : 0;
      if (n.stackPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
    }
    const ownStack = isFrameLike && (n.stackMode === "HORIZONTAL" || n.stackMode === "VERTICAL" || n.stackMode === "GRID") ? n.stackMode : null;
    if (ownStack) {
      out.layoutMode = ownStack;
      if (ownStack !== "GRID") {
        out.primaryAxisSizingMode = n.stackPrimarySizing === "FIXED" ? "FIXED" : "AUTO";
        out.counterAxisSizingMode = n.stackCounterSizing === "FIXED" || n.stackCounterSizing === undefined ? "FIXED" : "AUTO";
        const just = n.stackPrimaryAlignItems ?? "MIN";
        out.primaryAxisAlignItems = just === "SPACE_EVENLY" || just === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : just === "CENTER" || just === "MAX" ? just : "MIN";
        const ca = n.stackCounterAlignItems ?? "MIN";
        out.counterAxisAlignItems = ca === "CENTER" || ca === "MAX" || ca === "BASELINE" ? ca : "MIN";
        out.itemSpacing = n.stackSpacing ?? 0;
        if (n.stackWrap === "WRAP") {
          out.layoutWrap = "WRAP";
          out.counterAxisSpacing = n.stackCounterSpacing ?? 0;
          out.counterAxisAlignContent = n.stackCounterAlignContent === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : "AUTO";
        }
        if (n.stackReverseZIndex) out.itemReverseZIndex = true;
        if (n.bordersTakeSpace) out.strokesIncludedInLayout = true;
      }
      out.paddingLeft = n.stackHorizontalPadding ?? 0;
      out.paddingRight = n.stackPaddingRight ?? n.stackHorizontalPadding ?? 0;
      out.paddingTop = n.stackVerticalPadding ?? 0;
      out.paddingBottom = n.stackPaddingBottom ?? n.stackVerticalPadding ?? 0;
    }
    if (ownStack || parentStack) {
      const hug = (axis: "x" | "y") => {
        if (type === "TEXT") return n.textAutoResize === "WIDTH_AND_HEIGHT" || (axis === "y" && n.textAutoResize === "HEIGHT");
        if (!ownStack || ownStack === "GRID") return false;
        const primary = (ownStack === "HORIZONTAL") === (axis === "x");
        return primary ? n.stackPrimarySizing !== "FIXED" : n.stackCounterSizing !== undefined && n.stackCounterSizing !== "FIXED";
      };
      const sizing = (axis: "x" | "y") => {
        if (parentStack && n.stackPositioning !== "ABSOLUTE") {
          const primary = (parentStack === "HORIZONTAL") === (axis === "x");
          if (primary ? !!n.stackChildPrimaryGrow : n.stackChildAlignSelf === "STRETCH") return "FILL";
        }
        return hug(axis) ? "HUG" : "FIXED";
      };
      out.layoutSizingHorizontal = sizing("x");
      out.layoutSizingVertical = sizing("y");
    }
    const minW = n.minSize?.value?.x;
    const minH = n.minSize?.value?.y;
    const maxW = n.maxSize?.value?.x;
    const maxH = n.maxSize?.value?.y;
    if (minW) out.minWidth = minW;
    if (maxW) out.maxWidth = maxW;
    if (minH) out.minHeight = minH;
    if (maxH) out.maxHeight = maxH;
    if (isFrameLike && n.layoutGrids?.length) out.layoutGrids = n.layoutGrids.map(restGrid);
    if (isFrameLike && n.scrollDirection && n.scrollDirection !== "NONE") out.overflowDirection = n.scrollDirection === "BOTH" ? "HORIZONTAL_AND_VERTICAL_SCROLLING" : `${n.scrollDirection}_SCROLLING`;

    // Shapes
    if (type === "STAR" || type === "REGULAR_POLYGON") out.pointCount = n.count ?? (type === "STAR" ? 5 : 3);
    if (type === "STAR") out.innerRadius = n.starInnerScale ?? 0.382;
    if (type === "ELLIPSE" && n.arcData) out.arcData = { startingAngle: n.arcData.startingAngle ?? 0, endingAngle: n.arcData.endingAngle ?? 2 * Math.PI, innerRadius: n.arcData.innerRadius ?? 0 };
    if (type === "BOOLEAN_OPERATION") out.booleanOperation = n.booleanOperation ?? "UNION";
    if (type === "SECTION") out.sectionContentsHidden = n.sectionContentsHidden === true;

    // Text
    if (type === "TEXT") {
      const td = n.textData ?? {};
      out.characters = td.characters ?? "";
      let intrinsic: number | null = null;
      try {
        intrinsic = this.engine.textLayout(n.guid)?.baselines?.[0]?.lineHeight ?? null;
      } catch {
        intrinsic = null;
      }
      out.style = typeStyle(n, null, (n.lineHeight?.units === "PERCENT" && n.lineHeight?.value === 100) || !n.lineHeight ? intrinsic : null);
      const ids: number[] = [...(td.characterStyleIDs ?? [])];
      while (ids.length && ids[ids.length - 1] === 0) ids.pop();
      out.characterStyleOverrides = ids;
      out.styleOverrideTable = {};
      for (const row of td.styleOverrideTable ?? []) if (row.styleID) out.styleOverrideTable[String(row.styleID)] = typeStyle(row, n, null);
      const lines = (td.lines ?? []) as Any[];
      out.lineTypes = lines.length ? lines.map((l) => (l.lineType === "ORDERED_LIST" ? "ORDERED" : l.lineType === "UNORDERED_LIST" ? "UNORDERED" : "NONE")) : ["NONE"];
      out.lineIndentations = lines.length ? lines.map((l) => l.indentationLevel ?? 0) : [0];
      if (bound) for (const k of Object.values(LIST_FIELD)) if (bound.node[k]) (out.style.boundVariables ??= {})[k] = bound.node[k][0];
    }

    // Styles and modes
    const styles: Any = {};
    for (const [slot, field] of [["fill", "styleIdForFill"], ["stroke", "styleIdForStrokeFill"], ["text", "styleIdForText"], ["effect", "styleIdForEffect"], ["grid", "styleIdForGrid"]] as const) {
      const sid = guidStr(n[field]?.guid);
      const s = sid ? this.style(sid) : null;
      if (!sid || !s) continue;
      styles[slot === "stroke" ? "stroke" : slot] = sid;
      this.styles[sid] ??= { key: s.key ?? "", name: s.name, styleType: s.styleType === "FILL" ? "FILL" : s.styleType, remote: !!s.remote, description: s.description ?? "" };
    }
    if (Object.keys(styles).length) out.styles = styles;
    const modes = (n.variableModeBySetMap?.entries ?? []) as Any[];
    if (modes.length) {
      out.explicitVariableModes = {};
      for (const m of modes) {
        const set = guidStr(m.variableSetExtensionID?.guid) ?? guidStr(m.variableSetID?.guid);
        const mode = guidStr(m.variableModeID);
        if (set && mode) out.explicitVariableModes[restCollectionId(set)] = mode;
      }
    }
    if (bound && Object.keys(bound.node).length) out.boundVariables = bound.node;

    // Geometry: `geometry=paths` adds the outlines, `size` and `relativeTransform`
    if (this.params.geometry === "paths") {
      out.size = { x: w, y: h };
      const t: Matrix = n.transform ?? IDENTITY;
      out.relativeTransform = [[t.m00, t.m01, t.m02], [t.m10, t.m11, t.m12]];
      if (SHAPES.has(type) || type === "TEXT" || isFrameLike) this.geometryTasks.push({ json: out, node: n });
    }

    // Render bounds: the box grown by what draws outside it (strokes, shadows, blurs) and, unclipped, the children's
    let render: Rect | null = null;
    if (n.visible !== false) {
      if (type !== "GROUP" && type !== "BOOLEAN_OPERATION") render = box;
      const strokes = (n.strokePaints ?? []).some((p: Any) => p.visible !== false);
      if (render && strokes && (n.strokeWeight ?? 0) > 0 && type !== "GROUP") {
        const align = out.strokeAlign;
        render = grow(render, align === "OUTSIDE" ? n.strokeWeight : align === "CENTER" ? n.strokeWeight / 2 : 0);
      }
      const base = render;
      for (const e of n.effects ?? []) {
        if (e.visible === false || !base) continue;
        if (e.type === "DROP_SHADOW") render = union(render, grow({ ...base, x: base.x + (e.offset?.x ?? 0), y: base.y + (e.offset?.y ?? 0) }, (e.radius ?? 0) + (e.spread ?? 0)));
        if (e.type === "FOREGROUND_BLUR") render = union(render, grow(base, e.radius ?? 0));
      }
      if (!(isFrameLike && out.clipsContent)) for (const k of kids) render = union(render, k.render);
      else if (!render) for (const k of kids) render = union(render, k.render);
    }
    out.absoluteRenderBounds = render;
    if (out.children) {
      // Figma lists `children` right after the header fields
      const { children, ...rest } = out;
      const head = { id: rest.id, name: rest.name, type: rest.type, ...(rest.visible === false ? { visible: false } : {}), ...(rest.locked ? { locked: true } : {}), scrollBehavior: rest.scrollBehavior };
      const json = { ...head, children, ...rest };
      // Its geometry task, pushed after its children's, follows it to the reordered object
      const task = this.geometryTasks[this.geometryTasks.length - 1];
      if (task?.json === out) task.json = json;
      return { json, render };
    }
    return { json: out, render };
  }
}

/** Schema field names of an override → Figma's REST names (`overriddenFields`) */
function overrideField(f: string): string {
  const map: Record<string, string> = {
    fillPaints: "fills",
    strokePaints: "strokes",
    textData: "characters",
    fontName: "fontName",
    styleIdForFill: "fillStyleId",
    styleIdForStrokeFill: "strokeStyleId",
    styleIdForText: "textStyleId",
    styleIdForEffect: "effectStyleId",
    styleIdForGrid: "gridStyleId",
    overriddenSymbolID: "componentId",
    componentPropAssignments: "componentProperties",
    stackSpacing: "itemSpacing",
    stackHorizontalPadding: "paddingLeft",
    stackVerticalPadding: "paddingTop",
    stackPaddingRight: "paddingRight",
    stackPaddingBottom: "paddingBottom",
    size: "size",
    frameMaskDisabled: "clipsContent",
  };
  return map[f] ?? f;
}

// ---- the answers ---------------------------------------------------------------------------------------------------------

/** `GET /v1/files/:key` without `role`, `thumbnailUrl`, `mainFileKey`, `branches` (the Worker writes those) */
export async function fileJson(engine: Engine, params: FileParams, ctx: FileJsonContext): Promise<Record<string, unknown>> {
  const doc = new RestDocument(engine, params);
  const document = doc.document();
  await doc.finishGeometry();
  return {
    name: ctx.name,
    lastModified: new Date(ctx.lastModified).toISOString(),
    editorType: "figma",
    version: ctx.version,
    document,
    components: doc.components,
    componentSets: doc.componentSets,
    schemaVersion: 0,
    styles: doc.styles,
  };
}

/** `GET /v1/files/:key/nodes` without the Worker's fields: each id's `{document, components, componentSets, schemaVersion, styles}`, null when missing */
export async function nodesJson(engine: Engine, params: FileParams & { ids: string[] }, ctx: FileJsonContext): Promise<Record<string, unknown>> {
  const nodes: Record<string, unknown> = {};
  const docs: { id: string; doc: RestDocument; json: Any }[] = [];
  for (const id of params.ids) {
    const doc = new RestDocument(engine, { ...params, ids: undefined });
    let json: Any = null;
    try {
      json = doc.subtree(id);
    } catch {
      json = null;
    }
    docs.push({ id, doc, json });
  }
  for (const d of docs) {
    if (d.json) await d.doc.finishGeometry();
    nodes[d.id] = d.json ? { document: d.json, components: d.doc.components, componentSets: d.doc.componentSets, schemaVersion: 0, styles: d.doc.styles } : null;
  }
  return { name: ctx.name, lastModified: new Date(ctx.lastModified).toISOString(), editorType: "figma", version: ctx.version, err: null, nodes };
}

/** A gzip of bytes (CompressionStream: browsers and Node 18+) */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The `file` / `nodes` part (§16.16): the answer's JSON text without its opening `{`, gzipped */
export async function filePart(answer: Record<string, unknown>): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(answer).slice(1)));
}
