/**
 * A layer as an SVG of vectors — what Figma's Copy as SVG and SVG export
 * give, and what a design tool takes in (an SVG holding HTML, Figma and
 * Illustrator open empty): its boxes as rects and paths (their fills,
 * gradients, pictures, strokes, shadows, corners, clips, turns), its words
 * as text — a line each, where the canvas broke them. It is read from what
 * the canvas drew, so it is the same picture: the layer upright, at its own
 * size, with its shadows and what spills out of it around it.
 *
 * What SVG has no word for — a page in an iframe, a video another site
 * serves, a background blur — is a plain box of its size. Its fonts go in
 * it, for a browser opening the file; a design tool uses its own.
 */

import { dataUrl, fontsCss, type FontUse } from "./inline";

interface Box { x: number; y: number; w: number; h: number }
interface Corner { rx: number; ry: number }
/** Top-left, top-right, bottom-right, bottom-left. */
type Corners = [Corner, Corner, Corner, Corner];
interface Rgba { hex: string; a: number }
interface Shadow { inset: boolean; x: number; y: number; blur: number; spread: number; color: Rgba }
interface Extent { x0: number; y0: number; x1: number; y1: number }

/** What the boxes are read against: the layer's place on the screen, the canvas's zoom, and the turns taken off while they are read. */
interface Measure {
  origin: DOMRect;
  zoom: number;
  turns: Map<Element, { matrix: DOMMatrix; origin: [number, number] }>;
}

const NO_CORNERS: Corners = [{ rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }, { rx: 0, ry: 0 }];
const SKIPPED = new Set(["STYLE", "SCRIPT", "TEMPLATE", "NOSCRIPT", "BR", "WBR", "META", "LINK"]);
const LENGTH = /^-?[\d.]+(e-?\d+)?(px)?$/;

const n2 = (n: number) => String(Math.round(n * 100) / 100);
const n4 = (n: number) => String(Math.round(n * 10000) / 10000);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const outset = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
const at = (b: Box) => `x="${n2(b.x)}" y="${n2(b.y)}" width="${n2(b.w)}" height="${n2(b.h)}"`;

/** `value` split at its top-level commas (or spaces) — not those inside parentheses or quotes. */
function splitTop(value: string, by: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let part = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
      part += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && !quote && (by === "," ? ch === "," : /\s/.test(ch))) {
      if (part.trim()) out.push(part.trim());
      part = "";
      continue;
    }
    part += ch;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

// ── Colours ───────────────────────────────────────────────────────────────────

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const hexOf = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const alphaOf = (t: string | undefined) => (t === undefined || t === "" ? 1 : t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t));

let pixel: CanvasRenderingContext2D | null = null;
const pixelContext = () => (pixel ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true }));
const colours = new Map<string, Rgba>();

/** A computed colour as hex and alpha: rgb(), color(srgb …) (what color-mix computes to), or anything else the browser draws — read back from a pixel. */
function colourOf(css: string): Rgba {
  const key = css.trim();
  const known = colours.get(key);
  if (known) return known;
  let out: Rgba = { hex: "#000000", a: 0 };
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(key);
  const srgb = /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(key);
  if (!key || key === "transparent" || key === "none") out = { hex: "#000000", a: 0 };
  else if (rgb) out = { hex: hexOf(+rgb[1], +rgb[2], +rgb[3]), a: alphaOf(rgb[4]) };
  else if (srgb) out = { hex: hexOf(+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255), a: alphaOf(srgb[4]) };
  else {
    const g = pixelContext();
    if (g) {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#000000";
      g.fillStyle = key;
      g.fillRect(0, 0, 1, 1);
      const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
      out = { hex: hexOf(r, gg, b), a: a / 255 };
    }
  }
  colours.set(key, out);
  return out;
}

const fill = (c: Rgba) => `fill="${c.hex}"${c.a < 1 ? ` fill-opacity="${n4(c.a)}"` : ""}`;
const stroke = (c: Rgba, width: number) => `stroke="${c.hex}"${c.a < 1 ? ` stroke-opacity="${n4(c.a)}"` : ""} stroke-width="${n2(width)}"`;

// ── Shapes ────────────────────────────────────────────────────────────────────

/** A box's corners as CSS draws them: % of its sides, elliptical ones, overlapping ones scaled down together. */
function cornersOf(cs: CSSStyleDeclaration, w: number, h: number): Corners {
  const len = (t: string, along: number) => (t.endsWith("%") ? (parseFloat(t) / 100) * along : parseFloat(t) || 0);
  const one = (value: string): Corner => {
    const [a = "0", b = a] = value.trim().split(/\s+/);
    return { rx: len(a, w), ry: len(b, h) };
  };
  const c: Corners = [one(cs.borderTopLeftRadius), one(cs.borderTopRightRadius), one(cs.borderBottomRightRadius), one(cs.borderBottomLeftRadius)];
  const room = (side: number, sum: number) => (sum > side ? side / sum : 1);
  const f = Math.min(room(w, c[0].rx + c[1].rx), room(w, c[3].rx + c[2].rx), room(h, c[0].ry + c[3].ry), room(h, c[1].ry + c[2].ry));
  return f < 1 ? (c.map((k) => ({ rx: k.rx * f, ry: k.ry * f })) as Corners) : c;
}

/** Corners grown (or shrunk) with their box — a square one stays square. */
const grown = (c: Corners, by: number): Corners => c.map((k) => ({ rx: k.rx > 0 ? Math.max(0, k.rx + by) : 0, ry: k.ry > 0 ? Math.max(0, k.ry + by) : 0 })) as Corners;
const rounded = (c: Corners) => c.some((k) => k.rx > 0 && k.ry > 0);

function roundedPath(b: Box, c: Corners): string {
  const { x, y, w, h } = b;
  const [tl, tr, br, bl] = c;
  const turn = (k: Corner, ex: number, ey: number) => (k.rx > 0 && k.ry > 0 ? `A${n2(k.rx)} ${n2(k.ry)} 0 0 1 ${n2(ex)} ${n2(ey)}` : `L${n2(ex)} ${n2(ey)}`);
  return `M${n2(x + tl.rx)} ${n2(y)}H${n2(x + w - tr.rx)}${turn(tr, x + w, y + tr.ry)}V${n2(y + h - br.ry)}${turn(br, x + w - br.rx, y + h)}H${n2(x + bl.rx)}${turn(bl, x, y + h - bl.ry)}V${n2(y + tl.ry)}${turn(tl, x + tl.rx, y)}Z`;
}

/** The box's shape: a rect (rounded alike), an ellipse, or a path with each corner its own. */
function shape(b: Box, c: Corners, attrs: string): string {
  if (b.w <= 0 || b.h <= 0) return "";
  const [k] = c;
  const same = c.every((o) => Math.abs(o.rx - k.rx) < 0.01 && Math.abs(o.ry - k.ry) < 0.01);
  if (same && (k.rx <= 0 || k.ry <= 0)) return `<rect ${at(b)} ${attrs}/>`;
  if (same && Math.abs(k.rx - b.w / 2) < 0.01 && Math.abs(k.ry - b.h / 2) < 0.01) return `<ellipse cx="${n2(b.x + b.w / 2)}" cy="${n2(b.y + b.h / 2)}" rx="${n2(b.w / 2)}" ry="${n2(b.h / 2)}" ${attrs}/>`;
  if (same) return `<rect ${at(b)} rx="${n2(k.rx)}" ry="${n2(k.ry)}" ${attrs}/>`;
  return `<path d="${roundedPath(b, c)}" ${attrs}/>`;
}

// ── The file being written ────────────────────────────────────────────────────

class Writer {
  defs: string[] = [];
  /** Pictures put in by token (read once all is measured): a tile's place and size come with it */
  pictures: { url: string; tile?: Box }[] = [];
  /** The texts' fonts: the faces the file carries */
  fonts: FontUse[] = [];
  /** What is painted, in the file's space — its view box */
  extent: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  /** The turns around what is written (each a group's), and the clips it is in, in the file's space */
  turns: DOMMatrix[] = [new DOMMatrix()];
  clips: (Extent | null)[] = [null];
  private count = 0;
  private prefix = `v${Math.random().toString(36).slice(2, 7)}`;

  id() {
    return `${this.prefix}-${++this.count}`;
  }

  /** `b`, under the turns it is in, as the file's: its bounding box. */
  private inFile(b: Box): Extent {
    const m = this.turns[this.turns.length - 1];
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
    return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
  }

  /** Something drawn over `b`: the view box takes it in — as far as the clips it is in let it be seen. */
  painted(b: Box) {
    if (b.w <= 0 && b.h <= 0) return;
    const e = this.inFile(b);
    const clip = this.clips[this.clips.length - 1];
    if (clip) {
      e.x0 = Math.max(e.x0, clip.x0); e.y0 = Math.max(e.y0, clip.y0);
      e.x1 = Math.min(e.x1, clip.x1); e.y1 = Math.min(e.y1, clip.y1);
      if (e.x0 >= e.x1 || e.y0 >= e.y1) return;
    }
    this.extent = { x0: Math.min(this.extent.x0, e.x0), y0: Math.min(this.extent.y0, e.y0), x1: Math.max(this.extent.x1, e.x1), y1: Math.max(this.extent.y1, e.y1) };
  }

  pushClip(b: Box) {
    const e = this.inFile(b);
    const outer = this.clips[this.clips.length - 1];
    this.clips.push(outer ? { x0: Math.max(e.x0, outer.x0), y0: Math.max(e.y0, outer.y0), x1: Math.min(e.x1, outer.x1), y1: Math.min(e.y1, outer.y1) } : e);
  }

  clipPath(b: Box, c: Corners) {
    const id = this.id();
    this.defs.push(`<clipPath id="${id}">${shape(b, c, "")}</clipPath>`);
    return id;
  }

  /** A Gaussian blur over `region` (its standard deviation — CSS's blur radius; half a shadow's blur). */
  blur(deviation: number, region: Box) {
    const id = this.id();
    this.defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" ${at(outset(region, deviation * 3))} color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n2(deviation)}"/></filter>`);
    return id;
  }

  /** A picture's place in an href, filled in once it is read. */
  picture(url: string, tile?: Box) {
    this.pictures.push({ url, tile });
    return `__PIC${this.pictures.length - 1}__`;
  }
}

// ── Paint ─────────────────────────────────────────────────────────────────────

function shadowsOf(value: string): Shadow[] {
  if (!value || value === "none") return [];
  return splitTop(value, ",")
    .map((one) => {
      const parts = splitTop(one, " ");
      const lengths = parts.filter((p) => LENGTH.test(p)).map(parseFloat);
      const colour = parts.filter((p) => p !== "inset" && !LENGTH.test(p)).join(" ");
      return { inset: parts.includes("inset"), x: lengths[0] ?? 0, y: lengths[1] ?? 0, blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, color: colourOf(colour || "rgb(0, 0, 0)") };
    })
    .filter((s) => s.color.a > 0);
}

/** A shadow outside the box (CSS draws none under the box itself) — or, unblurred and in place, a stroke outside it: a ring as wide as the spread. */
function outerShadow(s: Shadow, b: Box, c: Corners, w: Writer): string {
  if (!s.blur && !s.x && !s.y) {
    if (s.spread <= 0) return "";
    w.painted(outset(b, s.spread));
    return shape(outset(b, s.spread / 2), grown(c, s.spread / 2), `fill="none" ${stroke(s.color, s.spread)}`);
  }
  const cast = outset({ ...b, x: b.x + s.x, y: b.y + s.y }, s.spread);
  if (cast.w <= 0 || cast.h <= 0) return "";
  const reach = outset(cast, s.blur * 1.5 + 1);
  w.painted(reach);
  const around = outset({ x: Math.min(reach.x, b.x), y: Math.min(reach.y, b.y), w: Math.max(reach.x + reach.w, b.x + b.w) - Math.min(reach.x, b.x), h: Math.max(reach.y + reach.h, b.y + b.h) - Math.min(reach.y, b.y) }, 1);
  const mask = w.id();
  w.defs.push(`<mask id="${mask}" maskUnits="userSpaceOnUse" ${at(around)}><rect ${at(around)} fill="#ffffff"/>${shape(b, c, 'fill="#000000"')}</mask>`);
  const blur = s.blur > 0 ? ` filter="url(#${w.blur(s.blur / 2, cast)})"` : "";
  return `<g mask="url(#${mask})">${shape(cast, grown(c, s.spread), `${fill(s.color)}${blur}`)}</g>`;
}

/** A shadow inside the box: all around a hole (the box moved and shrunk by the spread) blurred, within the box — or, unblurred and in place, a stroke inside it. */
function innerShadow(s: Shadow, b: Box, c: Corners, w: Writer): string {
  if (!s.blur && !s.x && !s.y) {
    const width = Math.min(s.spread, b.w / 2, b.h / 2);
    if (width <= 0) return "";
    return shape(outset(b, -width / 2), grown(c, -width / 2), `fill="none" ${stroke(s.color, width)}`);
  }
  const hole = outset({ ...b, x: b.x + s.x, y: b.y + s.y }, -s.spread);
  const around = outset(b, s.blur * 1.5 + Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.spread) + 2);
  const d = `M${n2(around.x)} ${n2(around.y)}h${n2(around.w)}v${n2(around.h)}h${n2(-around.w)}Z${hole.w > 0 && hole.h > 0 ? roundedPath(hole, grown(c, -s.spread)) : ""}`;
  const blur = s.blur > 0 ? ` filter="url(#${w.blur(s.blur / 2, around)})"` : "";
  return `<g clip-path="url(#${w.clipPath(b, c)})"><path d="${d}" fill-rule="evenodd" ${fill(s.color)}${blur}/></g>`;
}

const ANGLE = /^-?[\d.]+(deg|grad|rad|turn)$/i;
function degrees(t: string) {
  const v = parseFloat(t);
  if (/turn$/i.test(t)) return v * 360;
  if (/grad$/i.test(t)) return v * 0.9;
  if (/rad$/i.test(t) && !/grad$/i.test(t)) return (v * 180) / Math.PI;
  return v;
}
/** "to right", "to top left"… as CSS's angle for the box. */
function towards(t: string, b: Box) {
  const words = t.toLowerCase().split(/\s+/).slice(1);
  const top = words.includes("top"), bottom = words.includes("bottom"), left = words.includes("left"), right = words.includes("right");
  const corner = (Math.atan2(b.h, b.w) * 180) / Math.PI;
  if (top && right) return corner;
  if (bottom && right) return 180 - corner;
  if (bottom && left) return 180 + corner;
  if (top && left) return 360 - corner;
  return top ? 0 : right ? 90 : left ? 270 : 180;
}

/** A linear-gradient layer as a fill: an SVG gradient along CSS's line (through the centre, at its angle, as long as the corners on it make it) — a plain colour when its stops are one. */
function gradient(layer: string, b: Box, w: Writer): string | null {
  const parts = splitTop(layer.slice(layer.indexOf("(") + 1, layer.lastIndexOf(")")), ",");
  let angle = 180;
  if (parts[0] && ANGLE.test(parts[0])) angle = degrees(parts.shift()!);
  else if (parts[0] && /^to\s/i.test(parts[0])) angle = towards(parts.shift()!, b);
  const rad = (angle * Math.PI) / 180;
  const length = Math.abs(b.w * Math.sin(rad)) + Math.abs(b.h * Math.cos(rad)) || 1;
  const stops: { at: number | null; color: Rgba }[] = [];
  for (const part of parts) {
    const tokens = splitTop(part, " ");
    const places: string[] = [];
    while (tokens.length > 1 && /^-?[\d.]+(%|px)?$/.test(tokens[tokens.length - 1])) places.unshift(tokens.pop()!);
    const color = colourOf(tokens.join(" "));
    if (!places.length) stops.push({ at: null, color });
    for (const p of places) stops.push({ at: p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p) / length, color });
  }
  if (!stops.length) return null;
  // The places CSS gives the stops without one: the first at the start, the last at the end, the rest evenly between; none before the one ahead of it.
  if (stops[0].at === null) stops[0].at = 0;
  if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = 1;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].at !== null) {
      stops[i].at = Math.max(stops[i].at!, stops[i - 1].at!);
      continue;
    }
    let j = i;
    while (stops[j].at === null) j++;
    const from = stops[i - 1].at!;
    const to = Math.max(stops[j].at!, from);
    for (let k = i; k < j; k++) stops[k].at = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j - 1;
  }
  const [first] = stops;
  if (stops.every((s) => s.color.hex === first.color.hex && s.color.a === first.color.a)) return first.color.a > 0 ? fill(first.color) : null;
  if (stops.every((s) => s.color.a <= 0)) return null;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = (Math.sin(rad) * length) / 2;
  const dy = (-Math.cos(rad) * length) / 2;
  const id = w.id();
  const stopsSvg = stops.map((s) => `<stop offset="${n4(s.at!)}" stop-color="${s.color.hex}"${s.color.a < 1 ? ` stop-opacity="${n4(s.color.a)}"` : ""}/>`).join("");
  w.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(cx - dx)}" y1="${n2(cy - dy)}" x2="${n2(cx + dx)}" y2="${n2(cy + dy)}">${stopsSvg}</linearGradient>`);
  return `fill="url(#${id})"`;
}

/** The box's background: its colour, then its layers (CSS lists the top one first) — gradients, pictures (cover, contain, tiled). */
function backgrounds(cs: CSSStyleDeclaration, b: Box, c: Corners, w: Writer): string {
  const out: string[] = [];
  const colour = colourOf(cs.backgroundColor);
  if (colour.a > 0) out.push(shape(b, c, fill(colour)));
  const layers = cs.backgroundImage && cs.backgroundImage !== "none" ? splitTop(cs.backgroundImage, ",") : [];
  const sizes = splitTop(cs.backgroundSize, ",");
  const repeats = splitTop(cs.backgroundRepeat, ",");
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (/^linear-gradient\(/i.test(layer)) {
      const paint = gradient(layer, b, w);
      if (paint) out.push(shape(b, c, paint));
      continue;
    }
    const url = /^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i.exec(layer)?.[2];
    if (!url) continue;
    const size = sizes[i % Math.max(1, sizes.length)] ?? "auto";
    const repeat = repeats[i % Math.max(1, repeats.length)] ?? "repeat";
    if (size === "auto" && repeat !== "no-repeat") {
      // Tiled at its own size, a tile at the centre (background-position: center).
      const token = w.picture(url, b);
      const id = w.id();
      w.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${token}X" y="${token}Y" width="${token}W" height="${token}H"><image width="${token}W" height="${token}H" xlink:href="${token}"/></pattern>`);
      out.push(shape(b, c, `fill="url(#${id})"`));
      continue;
    }
    const fit = size === "contain" ? "xMidYMid meet" : size === "cover" ? "xMidYMid slice" : "none";
    const img = `<image ${at(b)} preserveAspectRatio="${fit}" xlink:href="${w.picture(url)}"/>`;
    out.push(rounded(c) ? `<g clip-path="url(#${w.clipPath(b, c)})">${img}</g>` : img);
  }
  if (out.length) w.painted(b);
  return out.join("");
}

/** Its borders (a stroke on some sides, a dashed one): the same all round, a stroke inside its shape; else a line along each side's middle. */
function borders(cs: CSSStyleDeclaration, b: Box, c: Corners, w: Writer): string {
  const sides = (["top", "right", "bottom", "left"] as const).map((side) => ({
    width: parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0,
    style: cs.getPropertyValue(`border-${side}-style`),
    color: colourOf(cs.getPropertyValue(`border-${side}-color`)),
  }));
  type Side = (typeof sides)[number];
  const drawn = (s: Side) => s.width > 0 && s.style !== "none" && s.style !== "hidden" && s.color.a > 0;
  if (!sides.some(drawn)) return "";
  w.painted(b);
  const dash = (s: Side) => (s.style === "dashed" ? ` stroke-dasharray="${n2(s.width * 3)} ${n2(s.width * 3)}"` : s.style === "dotted" ? ` stroke-dasharray="0 ${n2(s.width * 2)}" stroke-linecap="round"` : "");
  const [top] = sides;
  if (sides.every((s) => drawn(s) && s.width === top.width && s.style === top.style && s.color.hex === top.color.hex && s.color.a === top.color.a)) {
    return shape(outset(b, -top.width / 2), grown(c, -top.width / 2), `fill="none" ${stroke(top.color, top.width)}${dash(top)}`);
  }
  const [t, r, bt, l] = sides;
  const lines = [
    [b.x, b.y + t.width / 2, b.x + b.w, b.y + t.width / 2],
    [b.x + b.w - r.width / 2, b.y, b.x + b.w - r.width / 2, b.y + b.h],
    [b.x, b.y + b.h - bt.width / 2, b.x + b.w, b.y + b.h - bt.width / 2],
    [b.x + l.width / 2, b.y, b.x + l.width / 2, b.y + b.h],
  ];
  return sides.map((s, i) => (drawn(s) ? `<line x1="${n2(lines[i][0])}" y1="${n2(lines[i][1])}" x2="${n2(lines[i][2])}" y2="${n2(lines[i][3])}" ${stroke(s.color, s.width)}${dash(s)}/>` : "")).join("");
}

/** What a replaced element shows: a picture (as it fits), a canvas's or a video's frame — a page in an iframe, a video it can't read, a plain box. */
function replaced(el: HTMLElement, cs: CSSStyleDeclaration, b: Box, c: Corners, w: Writer): string {
  const clipped = (inner: string) => (rounded(c) ? `<g clip-path="url(#${w.clipPath(b, c)})">${inner}</g>` : inner);
  const image = (href: string, fit: string) => clipped(`<image ${at(b)} preserveAspectRatio="${fit}" xlink:href="${href}"/>`);
  const fitOf = () => (cs.objectFit === "contain" || cs.objectFit === "scale-down" ? "xMidYMid meet" : cs.objectFit === "cover" || cs.objectFit === "none" ? "xMidYMid slice" : "none");
  const frame = (source: CanvasImageSource, width: number, height: number): string | null => {
    try {
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      canvas.getContext("2d")!.drawImage(source, 0, 0, width, height);
      return canvas.toDataURL("image/png");
    } catch {
      return null; // another site's, not readable
    }
  };
  if (el instanceof HTMLImageElement) {
    const src = el.currentSrc || el.src;
    if (!src) return "";
    w.painted(b);
    return image(w.picture(src), fitOf());
  }
  if (el instanceof HTMLCanvasElement) {
    w.painted(b);
    const data = frame(el, el.width, el.height);
    return data ? image(data, "none") : shape(b, c, 'fill="#e6e6e6"');
  }
  if (el instanceof HTMLVideoElement) {
    w.painted(b);
    const data = el.videoWidth ? frame(el, el.videoWidth, el.videoHeight) : null;
    if (data) return image(data, fitOf());
    if (el.poster) return image(w.picture(el.poster), fitOf());
    return shape(b, c, 'fill="#e6e6e6"');
  }
  if (el instanceof HTMLIFrameElement || el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement) {
    w.painted(b);
    return shape(b, c, 'fill="#e6e6e6"');
  }
  return "";
}

// ── Words ─────────────────────────────────────────────────────────────────────

const metrics = new Map<string, { a: number; d: number }>();

/** The font's ascent and descent at its size (the line box's), as the canvas measures them. */
function fontMetrics(cs: CSSStyleDeclaration): { a: number; d: number } {
  const size = parseFloat(cs.fontSize) || 16;
  const font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  const known = metrics.get(font);
  if (known) return known;
  let out = { a: size * 0.8, d: size * 0.2 };
  const g = pixelContext();
  if (g) {
    g.font = font;
    const m = g.measureText("Hg");
    if (m.fontBoundingBoxAscent !== undefined) out = { a: m.fontBoundingBoxAscent, d: m.fontBoundingBoxDescent };
  }
  metrics.set(font, out);
  return out;
}

/** Words as text-transform shows them (in the page's language: Turkish's dotted İ). */
function cased(text: string, transform: string, lang: string | undefined) {
  if (transform === "uppercase") return text.toLocaleUpperCase(lang);
  if (transform === "lowercase") return text.toLocaleLowerCase(lang);
  if (transform === "capitalize") return text.replace(/(^|[\s\p{P}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase(lang));
  return text;
}

/** A text node's words: a `<text>` for each line the canvas broke them into, on its baseline. */
function textRuns(node: Text, cs: CSSStyleDeclaration, w: Writer, m: Measure): string {
  const raw = node.data;
  if (!raw.trim()) return "";
  const colour = colourOf(cs.color);
  if (colour.a <= 0) return "";
  const range = document.createRange();
  range.selectNodeContents(node);
  const whole = range.getClientRects();
  if (!whole.length) return "";
  const lines: { text: string; left: number; right: number; top: number; height: number }[] = [];
  if (whole.length === 1) lines.push({ text: raw, left: whole[0].left, right: whole[0].right, top: whole[0].top, height: whole[0].height });
  else {
    // Its characters, a line each time one sits lower than the line before.
    let line: (typeof lines)[number] | null = null;
    let offset = 0;
    for (const ch of raw) {
      range.setStart(node, offset);
      range.setEnd(node, offset + ch.length);
      offset += ch.length;
      const r = ch === "\n" ? undefined : range.getClientRects()[0];
      if (r && (!line || Math.abs(r.top - line.top) > r.height / 2)) {
        line = { text: ch, left: r.left, right: r.right, top: r.top, height: r.height };
        lines.push(line);
      } else if (line) {
        line.text += ch;
        if (r) line.right = Math.max(line.right, r.right);
      }
    }
  }
  const { a, d } = fontMetrics(cs);
  const letterSpacing = parseFloat(cs.letterSpacing);
  const decoration = cs.textDecorationLine;
  const lang = node.parentElement?.closest("[lang]")?.getAttribute("lang") ?? undefined;
  const attrs = [
    `font-family="${esc(cs.fontFamily)}"`,
    `font-size="${n2(parseFloat(cs.fontSize) || 16)}"`,
    cs.fontWeight !== "400" ? `font-weight="${cs.fontWeight}"` : "",
    cs.fontStyle !== "normal" ? `font-style="${cs.fontStyle}"` : "",
    letterSpacing ? `letter-spacing="${n2(letterSpacing)}"` : "",
    /underline/.test(decoration) ? 'text-decoration="underline"' : /line-through/.test(decoration) ? 'text-decoration="line-through"' : "",
    fill(colour),
  ].filter(Boolean).join(" ");
  return lines
    .map((l) => {
      const text = cased(l.text.replace(/\n/g, "").replace(/\s+$/, ""), cs.textTransform, lang);
      if (!text) return "";
      const top = (l.top - m.origin.top) / m.zoom;
      const height = l.height / m.zoom;
      const x = (l.left - m.origin.left) / m.zoom;
      w.painted({ x, y: top, w: (l.right - l.left) / m.zoom, h: height });
      w.fonts.push({ family: cs.fontFamily, weight: parseFloat(cs.fontWeight) || 400, style: cs.fontStyle, text });
      // The baseline: the ascent down from the top of the line's glyph box (the font's box, centred in it).
      const baseline = top + (height - (a + d)) / 2 + a;
      return `<text x="${n2(x)}" y="${n2(baseline)}" ${attrs}>${esc(text)}</text>`;
    })
    .join("");
}

// ── Elements ──────────────────────────────────────────────────────────────────

const boxOf = (el: Element, m: Measure): Box => {
  const r = el.getBoundingClientRect();
  return { x: (r.left - m.origin.left) / m.zoom, y: (r.top - m.origin.top) / m.zoom, w: r.width / m.zoom, h: r.height / m.zoom };
};

/** An inline SVG (an icon): itself, at its place — its parts' colours and strokes written on them (they came from classes). */
function inlineSvg(el: SVGSVGElement, w: Writer, m: Measure): string {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return "";
  const b = boxOf(el, m);
  if (b.w <= 0 || b.h <= 0) return "";
  const copy = el.cloneNode(true) as SVGSVGElement;
  const originals = [el, ...el.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  originals.forEach((o, i) => {
    const c = copies[i];
    if (!c) return;
    const s = getComputedStyle(o);
    const paint = (v: string) => (v === "none" || v.startsWith("url(") ? v : colourOf(v).a > 0 ? colourOf(v).hex : "none");
    if (i > 0 && !(o instanceof SVGGeometryElement)) return;
    if (i > 0) {
      c.setAttribute("fill", paint(s.fill));
      c.setAttribute("stroke", paint(s.stroke));
      if (s.stroke !== "none") c.setAttribute("stroke-width", String(parseFloat(s.strokeWidth) || 1));
      if (s.strokeLinecap !== "butt") c.setAttribute("stroke-linecap", s.strokeLinecap);
      if (s.strokeLinejoin !== "miter") c.setAttribute("stroke-linejoin", s.strokeLinejoin);
    }
    c.removeAttribute("class");
    c.removeAttribute("style");
  });
  for (const [k, v] of Object.entries({ x: n2(b.x), y: n2(b.y), width: n2(b.w), height: n2(b.h) })) copy.setAttribute(k, v);
  w.painted(b);
  return new XMLSerializer().serializeToString(copy);
}

const zOf = (el: Element) => {
  if (!(el instanceof HTMLElement)) return 0;
  const cs = getComputedStyle(el);
  const z = parseInt(cs.zIndex, 10);
  return cs.position !== "static" && Number.isFinite(z) ? z : 0;
};

/** An element: its group (turn, opacity, blend, blur), its shadows, background, inner shadows, borders, what it shows; its texts and children in their stacking order, clipped to it when it clips. */
function element(el: Element, w: Writer, m: Measure, isRoot = false): string {
  if (SKIPPED.has(el.tagName)) return "";
  if (el instanceof SVGSVGElement) return inlineSvg(el, w, m);
  if (!(el instanceof HTMLElement)) return "";
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return "";
  const opacity = parseFloat(cs.opacity);
  if (opacity <= 0) return "";
  const b = boxOf(el, m);
  const inline = cs.display === "inline" || cs.display === "contents";
  const c = inline ? NO_CORNERS : cornersOf(cs, b.w, b.h);

  const attrs: string[] = [];
  const turn = isRoot ? undefined : m.turns.get(el);
  if (turn) {
    const ox = b.x + turn.origin[0];
    const oy = b.y + turn.origin[1];
    const local = new DOMMatrix().translate(ox, oy).multiply(turn.matrix).translate(-ox, -oy);
    attrs.push(`transform="matrix(${[local.a, local.b, local.c, local.d].map(n4).join(" ")} ${n2(local.e)} ${n2(local.f)})"`);
    w.turns.push(w.turns[w.turns.length - 1].multiply(local));
  }
  if (opacity < 1) attrs.push(`opacity="${n4(opacity)}"`);
  if (cs.mixBlendMode && cs.mixBlendMode !== "normal") attrs.push(`style="mix-blend-mode:${cs.mixBlendMode}"`);
  const blur = /blur\(([\d.]+)px\)/.exec(cs.filter);
  if (blur && parseFloat(blur[1]) > 0) attrs.push(`filter="url(#${w.blur(parseFloat(blur[1]), b)})"`);

  const body: string[] = [];
  if (!inline) {
    const shadows = shadowsOf(cs.boxShadow).reverse(); // the first on top
    for (const s of shadows) if (!s.inset) body.push(outerShadow(s, b, c, w));
    body.push(backgrounds(cs, b, c, w));
    for (const s of shadows) if (s.inset) body.push(innerShadow(s, b, c, w));
    body.push(borders(cs, b, c, w));
    body.push(replaced(el, cs, b, c, w));
  }
  const clips = !inline && (cs.overflowX !== "visible" || cs.overflowY !== "visible");
  if (clips) w.pushClip(b);
  const kids = [...el.childNodes].map((node, i) => ({ node, i, z: node instanceof Element ? zOf(node) : 0 })).sort((p, q) => p.z - q.z || p.i - q.i);
  const content = kids.map(({ node }) => (node instanceof Text ? textRuns(node, cs, w, m) : node instanceof Element ? element(node, w, m) : "")).join("");
  if (clips) w.clips.pop();
  if (content) body.push(clips ? `<g clip-path="url(#${w.clipPath(b, c)})">${content}</g>` : content);
  if (turn) w.turns.pop();
  const inner = body.join("");
  if (!inner) return "";
  return attrs.length ? `<g ${attrs.join(" ")}>${inner}</g>` : inner;
}

/** A picture's natural size (a tile's). */
function naturalSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** The element as an SVG of vectors; the pictures it couldn't read (another site's, a bucket without CORS) linked by their address, and listed. */
export async function vectorSvg(root: HTMLElement): Promise<{ svg: string; missing: string[] }> {
  if (root.getClientRects().length === 0 || !root.offsetWidth) throw new Error("This layer is hidden — show it to export it");
  // Read upright: every turn in it taken off while its boxes are read (all in this task — nothing is painted meanwhile), then put back as SVG's own.
  const turns = new Map<Element, { matrix: DOMMatrix; origin: [number, number] }>();
  const undo: { el: HTMLElement; transform: [string, string]; transition: [string, string] }[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (!cs.transform || cs.transform === "none") continue;
    const [ox = 0, oy = 0] = cs.transformOrigin.split(" ").map(parseFloat);
    turns.set(el, { matrix: new DOMMatrix(cs.transform), origin: [ox, oy] });
    undo.push({ el, transform: [el.style.getPropertyValue("transform"), el.style.getPropertyPriority("transform")], transition: [el.style.getPropertyValue("transition"), el.style.getPropertyPriority("transition")] });
  }
  for (const u of undo) {
    u.el.style.setProperty("transition", "none", "important");
    u.el.style.setProperty("transform", "none", "important");
  }
  const w = new Writer();
  let body = "";
  let size = { w: 0, h: 0 };
  try {
    const origin = root.getBoundingClientRect();
    // The canvas's zoom, from its probe (a box of known width in the zoomed world).
    const probe = root.closest("[data-design-scope]")?.querySelector<HTMLElement>(":scope > [data-zoom-probe]");
    const zoom = probe && probe.offsetWidth ? probe.getBoundingClientRect().width / probe.offsetWidth : origin.width / root.offsetWidth || 1;
    const m: Measure = { origin, zoom, turns };
    size = { w: origin.width / zoom, h: origin.height / zoom };
    body = element(root, w, m, true);
  } finally {
    for (const u of undo) u.el.style.setProperty("transform", ...u.transform);
    void root.offsetWidth; // the turns back before their transitions are
    for (const u of undo) u.el.style.setProperty("transition", ...u.transition);
  }
  w.painted({ x: 0, y: 0, w: size.w, h: size.h });
  const { x0, y0, x1, y1 } = w.extent;
  const box = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) };

  // The pictures, read (their bytes inside the file); a tile's place and size from its own.
  const missing: string[] = [];
  const read = await Promise.all(w.pictures.map((p) => dataUrl(p.url)));
  const sizes = await Promise.all(w.pictures.map((p, i) => (p.tile ? naturalSize(read[i] ?? p.url) : Promise.resolve(null))));
  const fonts = await fontsCss(w.fonts);
  const withPictures = (text: string) =>
    text.replace(/__PIC(\d+)__([XYWH]?)/g, (_, k: string, part: string) => {
      const i = Number(k);
      const p = w.pictures[i];
      if (!part) return esc(read[i] ?? p.url);
      const s = sizes[i] ?? { w: p.tile?.w ?? 1, h: p.tile?.h ?? 1 };
      const t = p.tile ?? { x: 0, y: 0, w: s.w, h: s.h };
      return n2(part === "X" ? t.x + (t.w - s.w) / 2 : part === "Y" ? t.y + (t.h - s.h) / 2 : part === "W" ? s.w : s.h);
    });
  w.pictures.forEach((p, i) => { if (!read[i] && !missing.includes(p.url)) missing.push(p.url); });
  const style = fonts ? `<style>${fonts.replace(/</g, "\\3c ")}</style>` : "";
  const defs = w.defs.length ? `<defs>${withPictures(w.defs.join(""))}</defs>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" fill="none" xml:space="preserve">${style}${defs}${withPictures(body)}</svg>`;
  return { svg, missing };
}
