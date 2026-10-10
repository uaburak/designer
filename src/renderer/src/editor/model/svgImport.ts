/**
 * SVG into editable layers (docs/desktop.md §13 "Vector paste"): what Illustrator puts on the clipboard (its SVG, or
 * its PDF turned into SVG by main) — and any other SVG pasted — becomes a clipboard Message of Figma's layers:
 * `<path>`, `<polygon>`, `<polyline>`, `<line>` → Vector (a vector network), `<rect>` → Rectangle and `<circle>` /
 * `<ellipse>` → Ellipse while they stay axis-aligned (else Vectors), `<g>` → Group, `clip-path` → a group whose
 * bottom layer is an outline mask ("Use as mask"). Fills and strokes as SVG computes them (presentation attributes,
 * `<style>` rules by class / id / type, `style`, inheritance), solid colours and linear / radial gradients; stroke
 * width, caps, joins, miter limit and dashes; opacity. Transforms are baked into the geometry (scaled strokes), so
 * every layer comes unrotated, as Figma's own SVG import does with skews. Text (`<text>`) and bitmaps (`<image>`)
 * are counted and skipped — Illustrator's own SVG flavour has its text as outlines already.
 *
 * The Message's layers are in page px with the whole artwork's top-left at `origin`; pasting it is the engine's
 * paste (fresh ids, one undo step).
 */
import type { Color, Matrix, Message, NodeChange, Paint, StrokeCap, StrokeJoin, Vector } from "@/engine/codec";
import { parseXml, type XmlElement } from "../../../../shared/vectorImport/xml";
import {
  apply,
  bounds,
  ellipsePath,
  IDENTITY,
  invert,
  meanScale,
  mul,
  numbers,
  parsePathData,
  parseTransform,
  rectPath,
  scale,
  transformSubpaths,
  translate,
  unionBox,
  type Box,
  type Mat,
  type Pt,
  type Subpath,
} from "../../../../shared/vectorImport/geometry";

export interface SvgImport {
  /** The layers, or null when the SVG drew nothing. */
  message: Message | null;
  /** What was left out: `<text>` elements and `<image>`s. */
  skipped: { text: number; images: number };
  /** How many layers the Message makes. */
  layers: number;
}

type PaintSpec =
  | { kind: "solid"; color: Color; opacity: number }
  | { kind: "linear" | "radial"; stops: { color: Color; position: number }[]; A: Mat; opacity: number };

interface ShapeItem {
  kind: "shape";
  name: string;
  type: "VECTOR" | "ROUNDED_RECTANGLE" | "ELLIPSE";
  /** Page px. */
  paths: Subpath[];
  cornerRadius?: number;
  fills: PaintSpec[];
  strokes: PaintSpec[];
  strokeWidth: number;
  cap: StrokeCap;
  join: StrokeJoin;
  miter: number;
  dash: number[];
  evenOdd: boolean;
  opacity: number;
  mask?: boolean;
}
interface GroupItem {
  kind: "group";
  name: string;
  opacity: number;
  children: Item[];
}
type Item = ShapeItem | GroupItem;

interface Style {
  fill: string;
  fillOpacity: number;
  fillRule: string;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  cap: string;
  join: string;
  miter: number;
  dash: string;
  color: string;
  visibility: string;
}

const INITIAL: Style = { fill: "#000", fillOpacity: 1, fillRule: "nonzero", stroke: "none", strokeOpacity: 1, strokeWidth: 1, cap: "butt", join: "miter", miter: 4, dash: "none", color: "#000", visibility: "visible" };

const INHERITED_PROPS = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "color", "visibility", "clip-rule"];
const OWN_PROPS = ["opacity", "clip-path", "display", "stop-color", "stop-opacity", "transform"];

// ---- CSS ------------------------------------------------------------------------------------------------------------

interface Rule {
  selector: { tag?: string; id?: string; classes: string[] };
  specificity: number;
  order: number;
  decls: Record<string, string>;
}

function parseDecls(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const k = part.slice(0, colon).trim().toLowerCase();
    const v = part.slice(colon + 1).replace(/!important/i, "").trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function parseCss(text: string, order: { n: number }): Rule[] {
  const rules: Rule[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = parseDecls(m[2]);
    for (const raw of m[1].split(",")) {
      const sel = raw.trim();
      // Simple selectors only (Illustrator writes `.cls-1`): a type, an id, classes.
      const sm = /^([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(sel);
      if (!sm) continue;
      const parts = [...(sm[2] ?? "").matchAll(/([.#])([\w-]+)/g)];
      const id = parts.find((p) => p[1] === "#")?.[2];
      const classes = parts.filter((p) => p[1] === ".").map((p) => p[2]);
      const tag = sm[1] && sm[1] !== "*" ? sm[1] : undefined;
      rules.push({ selector: { tag, id, classes }, specificity: (id ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0), order: order.n++, decls });
    }
  }
  return rules;
}

// ---- Colours --------------------------------------------------------------------------------------------------------

const NAMED: Record<string, number> = {
  black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x008000, blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, aqua: 0x00ffff,
  magenta: 0xff00ff, fuchsia: 0xff00ff, gray: 0x808080, grey: 0x808080, silver: 0xc0c0c0, maroon: 0x800000, olive: 0x808000,
  lime: 0x00ff00, navy: 0x000080, purple: 0x800080, teal: 0x008080, orange: 0xffa500, pink: 0xffc0cb, brown: 0xa52a2a,
  gold: 0xffd700, indigo: 0x4b0082, violet: 0xee82ee, darkgray: 0xa9a9a9, darkgrey: 0xa9a9a9, lightgray: 0xd3d3d3, lightgrey: 0xd3d3d3,
};

export function parseColor(text: string): Color | null {
  const s = text.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (p: string | undefined) => (p === undefined ? 0 : p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p) / 255);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const c = { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: alpha };
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? clampColor(c) : null;
  }
  if (s in NAMED) {
    const n = NAMED[s];
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  return null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampColor = (c: Color): Color => ({ r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) });

// ---- The walk -------------------------------------------------------------------------------------------------------

const SKIPPED_CONTAINERS = new Set(["defs", "clipPath", "mask", "symbol", "linearGradient", "radialGradient", "style", "title", "desc", "metadata", "pattern", "filter", "marker", "script", "foreignObject"]);

function num(v: string | undefined, fallback = 0, ref = 0): number {
  if (v === undefined) return fallback;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return fallback;
  if (t.endsWith("%")) return (n / 100) * ref;
  return n;
}

class Importer {
  private ids = new Map<string, XmlElement>();
  private rules: Rule[] = [];
  readonly skipped = { text: 0, images: 0 };
  private viewport = { w: 0, h: 0 };
  private useDepth = 0;

  constructor(private root: XmlElement) {
    const order = { n: 0 };
    const visit = (el: XmlElement) => {
      if (el.attrs.id && !this.ids.has(el.attrs.id)) this.ids.set(el.attrs.id, el);
      if (el.name === "style") this.rules.push(...parseCss(el.text, order));
      el.children.forEach(visit);
    };
    visit(root);
    this.rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  }

  /** The element's declared properties: attributes, then matching rules, then `style` (later wins). */
  private declared(el: XmlElement): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...INHERITED_PROPS, ...OWN_PROPS]) if (el.attrs[k] !== undefined) out[k] = el.attrs[k];
    const classes = (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
    for (const r of this.rules) {
      const s = r.selector;
      if (s.tag && s.tag !== el.name) continue;
      if (s.id && s.id !== el.attrs.id) continue;
      if (!s.classes.every((c) => classes.includes(c))) continue;
      Object.assign(out, r.decls);
    }
    if (el.attrs.style) Object.assign(out, parseDecls(el.attrs.style));
    return out;
  }

  private styleOf(d: Record<string, string>, parent: Style): Style {
    const s = { ...parent };
    const inherit = (v: string | undefined) => v === undefined || v === "inherit";
    if (!inherit(d.fill)) s.fill = d.fill;
    if (!inherit(d["fill-opacity"])) s.fillOpacity = clamp01(num(d["fill-opacity"], 1, 1));
    if (!inherit(d["fill-rule"])) s.fillRule = d["fill-rule"];
    if (!inherit(d.stroke)) s.stroke = d.stroke;
    if (!inherit(d["stroke-opacity"])) s.strokeOpacity = clamp01(num(d["stroke-opacity"], 1, 1));
    if (!inherit(d["stroke-width"])) s.strokeWidth = Math.max(0, num(d["stroke-width"], 1, Math.hypot(this.viewport.w, this.viewport.h) / Math.SQRT2));
    if (!inherit(d["stroke-linecap"])) s.cap = d["stroke-linecap"];
    if (!inherit(d["stroke-linejoin"])) s.join = d["stroke-linejoin"];
    if (!inherit(d["stroke-miterlimit"])) s.miter = num(d["stroke-miterlimit"], 4);
    if (!inherit(d["stroke-dasharray"])) s.dash = d["stroke-dasharray"];
    if (!inherit(d.color)) s.color = d.color;
    if (!inherit(d.visibility)) s.visibility = d.visibility;
    return s;
  }

  run(): Item[] {
    const vb = numbers(this.root.attrs.viewBox ?? "");
    const w = num(this.root.attrs.width, vb[2] ?? 0), h = num(this.root.attrs.height, vb[3] ?? 0);
    this.viewport = { w: vb.length === 4 ? vb[2] : w, h: vb.length === 4 ? vb[3] : h };
    const ctm = vb.length === 4 && vb[2] > 0 && vb[3] > 0 && this.root.attrs.width && this.root.attrs.height ? viewBoxMatrix(vb, w, h, this.root.attrs.preserveAspectRatio) : IDENTITY;
    return this.children(this.root, ctm, INITIAL);
  }

  private children(el: XmlElement, ctm: Mat, style: Style): Item[] {
    // <switch>: its first child it can draw.
    const kids = el.name === "switch" ? el.children.slice(0, 1) : el.children;
    return kids.flatMap((c) => this.element(c, ctm, style));
  }

  private element(el: XmlElement, parentCtm: Mat, parentStyle: Style): Item[] {
    if (SKIPPED_CONTAINERS.has(el.name)) return [];
    const d = this.declared(el);
    if (d.display === "none") return [];
    if (el.name === "text") {
      this.skipped.text++;
      return [];
    }
    if (el.name === "image") {
      this.skipped.images++;
      return [];
    }
    const style = this.styleOf(d, parentStyle);
    let ctm = mul(parentCtm, parseTransform(el.attrs.transform ?? d.transform));
    const opacity = clamp01(num(d.opacity, 1, 1));
    const name = el.attrs["data-name"] ?? el.attrs.id;
    let items: Item[];
    switch (el.name) {
      case "g":
      case "a":
      case "switch": {
        items = this.group(this.children(el, ctm, style), name, opacity);
        break;
      }
      case "svg": {
        const vb = numbers(el.attrs.viewBox ?? "");
        ctm = mul(ctm, translate(num(el.attrs.x), num(el.attrs.y)));
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) ctm = mul(ctm, viewBoxMatrix(vb, num(el.attrs.width, vb[2], this.viewport.w), num(el.attrs.height, vb[3], this.viewport.h), el.attrs.preserveAspectRatio));
        items = this.group(this.children(el, ctm, style), name, opacity);
        break;
      }
      case "use": {
        const ref = this.ids.get((el.attrs.href ?? el.attrs["xlink:href"] ?? "").replace(/^#/, ""));
        if (!ref || this.useDepth > 16) return [];
        ctm = mul(ctm, translate(num(el.attrs.x), num(el.attrs.y)));
        this.useDepth++;
        try {
          if (ref.name === "symbol") {
            const vb = numbers(ref.attrs.viewBox ?? "");
            const sm = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? mul(ctm, viewBoxMatrix(vb, num(el.attrs.width, vb[2]), num(el.attrs.height, vb[3]), ref.attrs.preserveAspectRatio)) : ctm;
            items = this.group(this.children(ref, sm, style), name ?? ref.attrs["data-name"] ?? ref.attrs.id, opacity);
          } else {
            items = this.element(ref, ctm, style);
            if (opacity < 1) items = this.group(items, name, opacity, true);
          }
        } finally {
          this.useDepth--;
        }
        break;
      }
      default: {
        const shape = this.shape(el, ctm, style, opacity, name);
        items = shape ? [shape] : [];
      }
    }
    // clip-path: the layers in a group over its clip as an outline mask.
    const clipRef = /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(d["clip-path"] ?? "");
    if (clipRef && items.length) {
      const mask = this.clipMask(clipRef[1], ctm, el);
      if (mask) {
        // A group's own opacity stays on it; the clip group wraps it.
        return [{ kind: "group", name: "Clip path group", opacity: 1, children: [mask, ...items] }];
      }
    }
    return items;
  }

  private group(children: Item[], name: string | undefined, opacity: number, force = false): Item[] {
    if (!children.length) return [];
    // An anonymous group of one layer adds nothing: the layer, carrying the group's opacity.
    if (!force && children.length === 1 && !name) {
      const only = children[0];
      return [{ ...only, opacity: only.opacity * opacity }];
    }
    return [{ kind: "group", name: name ?? "Group", opacity, children }];
  }

  private clipMask(id: string, ctm: Mat, target: XmlElement): ShapeItem | null {
    const clip = this.ids.get(id);
    if (!clip || clip.name !== "clipPath") return null;
    let m = mul(ctm, parseTransform(clip.attrs.transform));
    if (clip.attrs.clipPathUnits === "objectBoundingBox") {
      const b = bounds(this.rawGeometry(target)?.paths ?? []);
      if (!b) return null;
      m = mul(m, [b.w, 0, 0, b.h, b.x, b.y]);
    }
    const paths: Subpath[] = [];
    let evenOdd = false;
    const collect = (el: XmlElement, mm: Mat) => {
      const d = this.declared(el);
      if (d.display === "none") return;
      const m2 = mul(mm, parseTransform(el.attrs.transform ?? d.transform));
      if (el.name === "use") {
        const ref = this.ids.get((el.attrs.href ?? el.attrs["xlink:href"] ?? "").replace(/^#/, ""));
        if (ref) collect(ref, mul(m2, translate(num(el.attrs.x), num(el.attrs.y))));
        return;
      }
      if (el.name === "g") {
        el.children.forEach((c) => collect(c, m2));
        return;
      }
      const g = this.rawGeometry(el);
      if (!g) return;
      if ((d["clip-rule"] ?? el.attrs["clip-rule"]) === "evenodd") evenOdd = true;
      paths.push(...transformSubpaths(g.paths, m2));
    };
    clip.children.forEach((c) => collect(c, m));
    if (!paths.length) return null;
    return {
      kind: "shape",
      name: clip.attrs["data-name"] ?? clip.attrs.id ?? "Clip path",
      type: "VECTOR",
      paths,
      fills: [{ kind: "solid", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
      strokes: [],
      strokeWidth: 1,
      cap: "NONE",
      join: "MITER",
      miter: 4,
      dash: [],
      evenOdd,
      opacity: 1,
      mask: true,
    };
  }

  /** An element's own geometry in its user space (before its transform), and whether it is a rect / an ellipse. */
  private rawGeometry(el: XmlElement): { paths: Subpath[]; rect?: { x: number; y: number; w: number; h: number; rx: number; ry: number }; ellipse?: { cx: number; cy: number; rx: number; ry: number } } | null {
    const a = el.attrs;
    const vw = this.viewport.w, vh = this.viewport.h;
    switch (el.name) {
      case "path":
        return { paths: parsePathData(a.d ?? "") };
      case "rect": {
        const x = num(a.x, 0, vw), y = num(a.y, 0, vh), w = num(a.width, 0, vw), h = num(a.height, 0, vh);
        if (w <= 0 || h <= 0) return null;
        let rx = a.rx !== undefined && a.rx !== "auto" ? num(a.rx, 0, vw) : undefined;
        let ry = a.ry !== undefined && a.ry !== "auto" ? num(a.ry, 0, vh) : undefined;
        rx = Math.max(0, rx ?? ry ?? 0);
        ry = Math.max(0, ry ?? rx);
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        return { paths: [rectPath(x, y, w, h, rx, ry)], rect: { x, y, w, h, rx, ry } };
      }
      case "circle": {
        const cx = num(a.cx, 0, vw), cy = num(a.cy, 0, vh), r = num(a.r, 0, Math.hypot(vw, vh) / Math.SQRT2);
        if (r <= 0) return null;
        return { paths: [ellipsePath(cx, cy, r, r)], ellipse: { cx, cy, rx: r, ry: r } };
      }
      case "ellipse": {
        const cx = num(a.cx, 0, vw), cy = num(a.cy, 0, vh), rx = num(a.rx, 0, vw), ry = num(a.ry, 0, vh);
        if (rx <= 0 || ry <= 0) return null;
        return { paths: [ellipsePath(cx, cy, rx, ry)], ellipse: { cx, cy, rx, ry } };
      }
      case "line":
        return { paths: [{ start: { x: num(a.x1, 0, vw), y: num(a.y1, 0, vh) }, segs: [{ p: { x: num(a.x2, 0, vw), y: num(a.y2, 0, vh) } }], closed: false }] };
      case "polyline":
      case "polygon": {
        const v = numbers(a.points ?? "");
        if (v.length < 4) return null;
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] });
        const closed = el.name === "polygon";
        // A polygon that repeats its first point at the end (Illustrator does) closes on it.
        if (closed && pts.length > 2 && near(pts[0], pts[pts.length - 1])) pts.pop();
        return { paths: [{ start: pts[0], segs: pts.slice(1).map((p) => ({ p })), closed }] };
      }
      default:
        return null;
    }
  }

  private shape(el: XmlElement, ctm: Mat, style: Style, opacity: number, name: string | undefined): ShapeItem | null {
    const g = this.rawGeometry(el);
    if (!g || !g.paths.length || style.visibility === "hidden" || style.visibility === "collapse") return null;
    const own = bounds(g.paths);
    const fills = this.paint(style.fill, style.fillOpacity, style, ctm, own);
    const strokeScale = meanScale(ctm);
    const strokes = style.strokeWidth > 0 ? this.paint(style.stroke, style.strokeOpacity, style, ctm, own) : [];
    const paths = transformSubpaths(g.paths, ctm);
    const axisAligned = Math.abs(ctm[1]) < 1e-9 && Math.abs(ctm[2]) < 1e-9 && ctm[0] > 0 && ctm[3] > 0;
    let type: ShapeItem["type"] = "VECTOR";
    let cornerRadius: number | undefined;
    if (axisAligned && g.rect) {
      const rx = g.rect.rx * ctm[0], ry = g.rect.ry * ctm[3];
      if (Math.abs(rx - ry) < 1e-6) {
        type = "ROUNDED_RECTANGLE";
        cornerRadius = rx > 0 ? rx : undefined;
      }
    } else if (axisAligned && g.ellipse) type = "ELLIPSE";
    const dashValues = style.dash === "none" ? [] : numbers(style.dash).map((v) => Math.max(0, v));
    const dash = dashValues.some((v) => v > 0) ? (dashValues.length % 2 ? [...dashValues, ...dashValues] : dashValues).map((v) => v * strokeScale) : [];
    return {
      kind: "shape",
      name: name ?? (type === "ROUNDED_RECTANGLE" ? "Rectangle" : type === "ELLIPSE" ? "Ellipse" : "Vector"),
      type,
      paths,
      cornerRadius,
      fills,
      strokes,
      strokeWidth: style.strokeWidth * strokeScale,
      cap: style.cap === "round" ? "ROUND" : style.cap === "square" ? "SQUARE" : "NONE",
      join: style.join === "round" ? "ROUND" : style.join === "bevel" ? "BEVEL" : "MITER",
      miter: style.miter,
      dash,
      evenOdd: style.fillRule === "evenodd",
      opacity,
    };
  }

  /** A fill / stroke value as paints (none: empty). `own`: the element's bounds in its user space (bounding-box units). */
  private paint(value: string, opacity: number, style: Style, ctm: Mat, own: Box | null): PaintSpec[] {
    const v = value.trim();
    if (!v || v === "none") return [];
    const url = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)\s*(.*)$/.exec(v);
    if (url) {
      const grad = this.gradient(url[1], ctm, own, opacity);
      if (grad) return [grad];
      return url[2] ? this.paint(url[2], opacity, style, ctm, own) : [];
    }
    const color = parseColor(v === "currentColor" || v === "currentcolor" ? style.color : v);
    if (!color || color.a === 0) return [];
    return [{ kind: "solid", color: { ...color, a: 1 }, opacity: opacity * color.a }];
  }

  /** A gradient's attribute, following `href` to the gradients it inherits from. */
  private gradAttr(el: XmlElement, key: string): string | undefined {
    for (let g: XmlElement | undefined = el, i = 0; g && i < 8; i++) {
      if (g.attrs[key] !== undefined) return g.attrs[key];
      g = this.ids.get((g.attrs.href ?? g.attrs["xlink:href"] ?? "").replace(/^#/, ""));
    }
    return undefined;
  }

  private gradient(id: string, ctm: Mat, own: Box | null, opacity: number): PaintSpec | null {
    const el = this.ids.get(id);
    if (!el || (el.name !== "linearGradient" && el.name !== "radialGradient")) return null;
    let stopsEl: XmlElement | undefined = el;
    for (let i = 0; stopsEl && !stopsEl.children.some((c) => c.name === "stop") && i < 8; i++) stopsEl = this.ids.get((stopsEl.attrs.href ?? stopsEl.attrs["xlink:href"] ?? "").replace(/^#/, ""));
    const stops: { color: Color; position: number }[] = [];
    let last = 0;
    for (const s of stopsEl?.children.filter((c) => c.name === "stop") ?? []) {
      const d = this.declared(s);
      const off = s.attrs.offset ?? "0";
      const position = Math.max(last, clamp01(off.trim().endsWith("%") ? parseFloat(off) / 100 : parseFloat(off) || 0));
      last = position;
      const c = parseColor(d["stop-color"] ?? "#000") ?? { r: 0, g: 0, b: 0, a: 1 };
      stops.push({ color: { ...c, a: c.a * clamp01(num(d["stop-opacity"], 1, 1)) }, position });
    }
    if (!stops.length) return null;
    if (stops.length === 1) return { kind: "solid", color: { ...stops[0].color, a: 1 }, opacity: opacity * stops[0].color.a };
    const userSpace = this.gradAttr(el, "gradientUnits") === "userSpaceOnUse";
    if (!userSpace && (!own || own.w <= 0 || own.h <= 0)) return null;
    const unitW = userSpace ? this.viewport.w : 1, unitH = userSpace ? this.viewport.h : 1;
    const box: Mat = userSpace ? IDENTITY : [own!.w, 0, 0, own!.h, own!.x, own!.y];
    const U = mul(mul(ctm, box), parseTransform(this.gradAttr(el, "gradientTransform")));
    const at = (k: string, def: string, ref: number) => num(this.gradAttr(el, k) ?? def, 0, ref);
    if (el.name === "linearGradient") {
      const g1 = { x: at("x1", "0%", unitW), y: at("y1", "0%", unitH) }, g2 = { x: at("x2", "100%", unitW), y: at("y2", "0%", unitH) };
      const p1 = apply(U, g1), p2 = apply(U, g2);
      const n0 = apply(U, { x: g1.x - (g2.y - g1.y), y: g1.y + (g2.x - g1.x) });
      const n = { x: n0.x - p1.x, y: n0.y - p1.y };
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      if (Math.hypot(dx, dy) < 1e-9) return { kind: "solid", color: { ...stops[stops.length - 1].color, a: 1 }, opacity: opacity * stops[stops.length - 1].color.a };
      return { kind: "linear", stops, opacity, A: [dx, dy, n.x, n.y, p1.x - 0.5 * n.x, p1.y - 0.5 * n.y] };
    }
    const cx = at("cx", "50%", unitW), cy = at("cy", "50%", unitH), r = at("r", "50%", Math.hypot(unitW, unitH) / Math.SQRT2);
    if (r <= 0) return null;
    const R = mul(U, [r, 0, 0, r, cx, cy]);
    return { kind: "radial", stops, opacity, A: mul(R, [2, 0, 0, 2, -1, -1]) };
  }
}

const near = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

function viewBoxMatrix(vb: number[], w: number, h: number, par = "xMidYMid meet"): Mat {
  const [vx, vy, vw, vh] = vb;
  let sx = w / vw, sy = h / vh;
  const [align, mode] = par.trim().split(/\s+/);
  if (align !== "none") {
    const s = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
  }
  let tx = -vx * sx, ty = -vy * sy;
  if (align !== "none") {
    const fx = /xMid/.test(align ?? "xMid") ? 0.5 : /xMax/.test(align ?? "") ? 1 : 0;
    const fy = /YMid/.test(align ?? "YMid") ? 0.5 : /YMax/.test(align ?? "") ? 1 : 0;
    tx += (w - vw * sx) * fx;
    ty += (h - vh * sy) * fy;
  }
  return [sx, 0, 0, sy, tx, ty];
}

// ---- The Message ----------------------------------------------------------------------------------------------------

const ROOT = "4294967294:0";

/** Fractional positions for n siblings, back to front, all one width so they sort as strings. */
export function positions(n: number): string[] {
  const width = n <= 94 ? 1 : n <= 94 * 94 ? 2 : 3;
  return Array.from({ length: n }, (_, i) => {
    let s = "";
    for (let k = width - 1, v = i; k >= 0; k--, v = Math.floor(v / 94)) s = String.fromCharCode(33 + (v % 94)) + s;
    return s;
  });
}

/** A vector network blob (docs/schema.md §11.3) of subpaths in the node's own px, base64. */
export function networkBlob(paths: Subpath[], origin: Pt, closeOpen: boolean, evenOdd = false): string {
  const verts: Pt[] = [];
  const segs: { a: number; ts: Pt; b: number; te: Pt }[] = [];
  const loops: number[][] = [];
  const local = (p: Pt) => ({ x: p.x - origin.x, y: p.y - origin.y });
  for (const sp of paths) {
    const first = verts.length;
    verts.push(local(sp.start));
    const segList = sp.segs.slice();
    const closes = sp.closed || (closeOpen && segList.length > 0);
    // A closed subpath ending on its start point closes there (no duplicate vertex).
    const endsOnStart = segList.length > 0 && near(segList[segList.length - 1].p, sp.start);
    const loop: number[] = [];
    let prev = first;
    let prevPt = sp.start;
    segList.forEach((s, k) => {
      const last = k === segList.length - 1;
      const b = closes && last && endsOnStart ? first : (verts.push(local(s.p)), verts.length - 1);
      const ts = s.c1 && s.c2 ? { x: s.c1.x - prevPt.x, y: s.c1.y - prevPt.y } : { x: 0, y: 0 };
      const te = s.c1 && s.c2 ? { x: s.c2.x - s.p.x, y: s.c2.y - s.p.y } : { x: 0, y: 0 };
      loop.push(segs.length);
      segs.push({ a: prev, ts, b, te });
      prev = b;
      prevPt = s.p;
    });
    if (closes && !(segList.length > 0 && endsOnStart) && prev !== first) {
      loop.push(segs.length);
      segs.push({ a: prev, ts: { x: 0, y: 0 }, b: first, te: { x: 0, y: 0 } });
    }
    if (closes && loop.length) loops.push(loop);
  }
  return encodeNetwork(verts, segs, loops, evenOdd ? 0 : 1);
}

function encodeNetwork(verts: Pt[], segs: { a: number; ts: Pt; b: number; te: Pt }[], loops: number[][], windingBit: number): string {
  const regionBytes = loops.length ? 8 + loops.reduce((n, l) => n + 4 + 4 * l.length, 0) : 0;
  const view = new DataView(new ArrayBuffer(12 + verts.length * 12 + segs.length * 28 + regionBytes));
  let at = 0;
  const u32 = (v: number) => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const f32 = (v: number) => {
    view.setFloat32(at, v, true);
    at += 4;
  };
  u32(verts.length);
  u32(segs.length);
  u32(loops.length ? 1 : 0);
  for (const v of verts) {
    u32(0);
    f32(v.x);
    f32(v.y);
  }
  for (const s of segs) {
    u32(0);
    u32(s.a);
    f32(s.ts.x);
    f32(s.ts.y);
    u32(s.b);
    f32(s.te.x);
    f32(s.te.y);
  }
  if (loops.length) {
    u32((0 << 1) | windingBit);
    u32(loops.length);
    for (const l of loops) {
      u32(l.length);
      l.forEach(u32);
    }
  }
  const bytes = new Uint8Array(view.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const toMatrix = (m: Mat): Matrix => ({ m00: m[0], m01: m[2], m02: m[4], m10: m[1], m11: m[3], m12: m[5] });

function toPaint(p: PaintSpec, box: Box): Paint {
  if (p.kind === "solid") return { type: "SOLID", color: p.color, opacity: p.opacity, visible: true, blendMode: "NORMAL" };
  const local = mul(translate(-box.x, -box.y), p.A);
  const G = invert(local) ?? IDENTITY;
  const transform = mul(G, scale(box.w || 1, box.h || 1));
  return { type: p.kind === "linear" ? "GRADIENT_LINEAR" : "GRADIENT_RADIAL", stops: p.stops, transform: toMatrix(transform), opacity: p.opacity, visible: true, blendMode: "NORMAL" };
}

function itemBox(item: Item): Box | null {
  if (item.kind === "shape") return bounds(item.paths);
  let b: Box | null = null;
  for (const c of item.children) b = unionBox(b, itemBox(c));
  return b;
}

/** SVG markup → a clipboard Message of editable layers, the artwork's top-left at `origin` (page px). */
export function svgToMessage(svg: string, origin: Vector = { x: 0, y: 0 }): SvgImport {
  const root = parseXml(svg);
  if (!root || root.name !== "svg") return { message: null, skipped: { text: 0, images: 0 }, layers: 0 };
  const importer = new Importer(root);
  let items = importer.run();
  if (items.length > 1) items = [{ kind: "group", name: "Group", opacity: 1, children: items }];
  const top = items.length ? itemBox(items[0]) : null;
  if (!top) return { message: null, skipped: importer.skipped, layers: 0 };
  const nodeChanges: NodeChange[] = [];
  const blobs: string[] = [];
  let next = 1;
  const emit = (item: Item, parent: string, position: string, parentOrigin: Pt): string | null => {
    const box = itemBox(item);
    if (!box) return null;
    const guid = `4294967294:${next++}`;
    const base: NodeChange = {
      guid,
      phase: "CREATED",
      name: item.name,
      parentIndex: { guid: parent, position },
      size: { x: box.w, y: box.h },
      transform: { m00: 1, m01: 0, m02: box.x - parentOrigin.x, m10: 0, m11: 1, m12: box.y - parentOrigin.y },
      ...(item.opacity < 1 ? { opacity: item.opacity } : {}),
    };
    if (item.kind === "group") {
      nodeChanges.push({ ...base, type: "FRAME", resizeToFit: true, frameMaskDisabled: true, fillPaints: [], strokeWeight: 1, strokeAlign: "INSIDE" });
      const pos = positions(item.children.length);
      item.children.forEach((c, i) => emit(c, guid, pos[i], box));
      return guid;
    }
    const node: NodeChange = {
      ...base,
      type: item.type,
      fillPaints: item.fills.map((p) => toPaint(p, box)),
      strokePaints: item.strokes.map((p) => toPaint(p, box)),
      strokeWeight: item.strokes.length ? item.strokeWidth : 1,
      strokeAlign: "CENTER",
      strokeCap: item.cap,
      strokeJoin: item.join,
      miterLimit: item.miter,
      ...(item.dash.length ? { dashPattern: item.dash } : {}),
      ...(item.mask ? { mask: true, maskType: "OUTLINE" as const } : {}),
    };
    if (item.type === "ROUNDED_RECTANGLE") {
      if (item.cornerRadius) node.cornerRadius = item.cornerRadius;
    } else if (item.type === "VECTOR") {
      // A filled open subpath fills as if closed (SVG); with no stroke the closing segment can't be seen.
      blobs.push(networkBlob(item.paths, { x: box.x, y: box.y }, item.fills.length > 0 && item.strokes.length === 0, item.evenOdd));
      node.vectorData = { vectorNetworkBlob: blobs.length - 1, normalizedSize: { x: box.w, y: box.h } };
    }
    nodeChanges.push(node);
    return guid;
  };
  const topGuid = emit(items[0], ROOT, "!", { x: top.x - origin.x, y: top.y - origin.y });
  if (!topGuid) return { message: null, skipped: importer.skipped, layers: 0 };
  return {
    message: { type: "NODE_CHANGES", sessionID: 0, nodeChanges, blobs, clipboardSelectionRegions: [{ parent: ROOT, nodes: [topGuid], enclosingFrameOffset: { x: 0, y: 0 } }] },
    skipped: importer.skipped,
    layers: nodeChanges.length,
  };
}

/** Does this text look like SVG markup (a pasted file's contents, "Copy as SVG" from another app)? */
export function looksLikeSvg(text: string | null | undefined): boolean {
  if (!text) return false;
  const head = text.trimStart().slice(0, 2048);
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*(\[[\s\S]*?\])?\s*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head);
}
