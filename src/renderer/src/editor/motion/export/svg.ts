/**
 * Animated SVG (docs/motion.md §7.5; round 8e): our writer, from the sampled scene (vectorAnim.ts) — each layer a `<g>`
 * with a stable id (`n-<session>-<local>`) nested as the layers are, its fills and strokes as `<path>`s (gradients in
 * `<defs>`, a frame's clip as a `<clipPath>` around its children, a raster layer as an embedded PNG `<image>`), and
 * one `<style>` of CSS `@keyframes`: per layer its transform (as `matrix()`) and opacity, per path its solid colour,
 * stroke width and path trim (`pathLength="1"` with `stroke-dasharray` / `stroke-dashoffset`). Linear between the
 * kept frames; the iteration from the playback (Loop and Ping-pong infinite — Ping-pong's way back is in the frames —,
 * Once played once and held).
 *
 * [Deviation from §7.5, kept: the transforms are written as matrices of the sampled frames rather than CSS individual
 * transform properties with per-segment timing functions; the result plays the same at the exported frame rate.]
 */
import type { MotionSample, MotionShapePath, PlaybackName, RGBA } from "@shared/motion/types";
import { base64, constant, keepFrames, type AnimLayer, type AnimScene, type Matrix } from "./vectorAnim";

export interface SvgOptions {
  scale: number;
  playback: PlaybackName;
  /** The span the frames cover (ms) */
  durationMs: number;
  /** Each rasterised layer's PNG (at `scale`) by node */
  rasters: ReadonlyMap<string, { bytes: Uint8Array; width: number; height: number }>;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const idOf = (node: string) => `n-${node.replace(/[^A-Za-z0-9]+/g, "-")}`;
const matrix = (m: Matrix) => `matrix(${m.map(n).join(",")})`;
const colorCss = (c: RGBA) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

class Writer {
  defs: string[] = [];
  css: string[] = [];
  private uid = 0;
  constructor(
    readonly scene: AnimScene,
    readonly o: SvgOptions
  ) {}

  next(prefix: string): string {
    return `${prefix}${this.uid++}`;
  }

  /**
   * One animated CSS property over the frames: a static value when they agree (null), else a keyframes rule and the
   * animation's shorthand for the element.
   */
  animate(property: string, values: readonly (readonly number[])[], tol: number, css: (v: readonly number[]) => string): string | null {
    if (constant(values, tol)) return null;
    const name = this.next("k");
    const count = this.scene.count;
    const steps = keepFrames(values, tol).map((f) => `${n((f / count) * 100)}%{${property}:${css(values[f])}}`);
    this.css.push(`@keyframes ${name}{${steps.join("")}}`);
    const loop = this.o.playback === "ONCE" ? "1" : "infinite";
    return `${name} ${n(this.o.durationMs)}ms linear ${loop} both`;
  }

  paint(path: MotionShapePath): string {
    const p = path.paint;
    if (p.type === "SOLID") return colorCss(p.color);
    const id = this.next("g");
    const stops = p.stops.map((s) => `<stop offset="${n(s.position)}" stop-color="${colorCss(s.color)}"${s.color.a < 1 ? ` stop-opacity="${n(s.color.a)}"` : ""}/>`).join("");
    if (p.type === "GRADIENT_LINEAR") this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(p.from.x)}" y1="${n(p.from.y)}" x2="${n(p.to.x)}" y2="${n(p.to.y)}">${stops}</linearGradient>`);
    else this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(p.from.x)}" cy="${n(p.from.y)}" r="${n(Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y))}">${stops}</radialGradient>`);
    return `url(#${id})`;
  }

  pathEl(path: MotionShapePath, frames: readonly MotionSample[]): string {
    const stroke = path.stroke;
    const list = path.source.collection;
    const anims: string[] = [];
    const attrs: string[] = [`d="${path.d}"`];
    const paint = this.paint(path);
    const solid = path.paint.type === "SOLID" ? path.paint.color : null;
    if (solid) {
      const colours = frames.map((f) => f[list][path.source.index] ?? solid);
      const prop = stroke ? "stroke" : "fill";
      const c = this.animate(prop, colours.map((x) => [x.r, x.g, x.b]), 0.002, (v) => colorCss({ r: v[0], g: v[1], b: v[2], a: 1 }));
      const a = this.animate(`${prop}-opacity`, colours.map((x) => [x.a]), 0.0005, (v) => n(v[0]));
      if (c) anims.push(c);
      if (a) anims.push(a);
      if (solid.a < 1) attrs.push(`${prop}-opacity="${n(solid.a)}"`);
    }
    if (stroke) {
      attrs.push(`fill="none"`, `stroke="${paint}"`, `stroke-width="${n(frames[0].sw || stroke.weight)}"`);
      if (stroke.cap !== "NONE") attrs.push(`stroke-linecap="${stroke.cap === "ROUND" ? "round" : "square"}"`);
      if (stroke.join !== "MITER") attrs.push(`stroke-linejoin="${stroke.join === "ROUND" ? "round" : "bevel"}"`);
      else if (stroke.miterLimit !== 4) attrs.push(`stroke-miterlimit="${n(stroke.miterLimit)}"`);
      const w = this.animate("stroke-width", frames.map((f) => [f.sw || stroke.weight]), 0.01, (v) => `${n(v[0])}px`);
      if (w) anims.push(w);
      const trims = frames.map((f) => f.trim ?? [0, 1]);
      if (trims.some((t) => t[0] > 0 || t[1] < 1)) {
        // Path trim: the visible part [start, end] of a path one unit long.
        attrs.push(`pathLength="1"`, `stroke-dasharray="${n(trims[0][1] - trims[0][0])} 1"`, `stroke-dashoffset="${n(-trims[0][0])}"`);
        const da = this.animate("stroke-dasharray", trims.map((t) => [t[1] - t[0]]), 0.001, (v) => `${n(v[0])} 1`);
        const doff = this.animate("stroke-dashoffset", trims.map((t) => [-t[0]]), 0.001, (v) => n(v[0]));
        if (da) anims.push(da);
        if (doff) anims.push(doff);
      } else if (stroke.dashes.length) attrs.push(`stroke-dasharray="${stroke.dashes.map(n).join(" ")}"`);
    } else {
      attrs.push(`fill="${paint}"`);
      if (path.windingRule === "EVENODD") attrs.push(`fill-rule="evenodd"`);
    }
    if (anims.length) attrs.push(`style="animation:${anims.join(",")}"`);
    return `<path ${attrs.join(" ")}/>`;
  }

  layer(l: AnimLayer, top: boolean): string {
    const s = l.shape;
    const frames = l.frames;
    const attrs: string[] = [`id="${idOf(s.node)}"`, `data-name="${escape(s.name)}"`];
    const anims: string[] = [];
    if (!top) {
      const t = this.animate("transform", frames.map((f) => f.t), 0.001, (v) => matrix(v as Matrix));
      const first = frames[0].t as Matrix;
      if (t) anims.push(t);
      else if (first.some((v, k) => Math.abs(v - [1, 0, 0, 1, 0, 0][k]) > 1e-9)) attrs.push(`transform="${matrix(first)}"`);
      const o = this.animate("opacity", frames.map((f) => [f.o]), 0.0005, (v) => n(v[0]));
      if (o) anims.push(o);
      else if (frames[0].o < 1) attrs.push(`opacity="${n(frames[0].o)}"`);
    }
    if (anims.length) attrs.push(`style="transform-origin:0 0;transform-box:view-box;animation:${anims.join(",")}"`);
    let body = [...s.paths].map((p) => this.pathEl(p, frames)).join("");
    const raster = s.raster ? this.o.rasters.get(s.node) : undefined;
    if (raster && s.raster) {
      const k = raster.width > 0 ? s.raster.width / raster.width : 1;
      const m = s.raster.transform;
      body += `<image width="${raster.width}" height="${raster.height}" transform="${matrix([m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4], m[5]])}" href="data:image/png;base64,${base64(raster.bytes)}"/>`;
    }
    if (l.children.length) {
      const kids = l.children.map((c) => this.layer(c, false)).join("");
      if (s.clips && !top) {
        const id = this.next("c");
        this.defs.push(`<clipPath id="${id}"><rect width="${n(s.size.width)}" height="${n(s.size.height)}"/></clipPath>`);
        body += `<g clip-path="url(#${id})">${kids}</g>`;
      } else body += kids;
    }
    return `<g ${attrs.join(" ")}>${body}</g>`;
  }
}

/** The scene as an animated SVG file's text. */
export function writeAnimatedSvg(scene: AnimScene, o: SvgOptions): string {
  const w = new Writer(scene, o);
  const { width, height } = scene.root.shape.size;
  const body = w.layer(scene.root, true);
  const defs = w.defs.length ? `<defs>${w.defs.join("")}</defs>` : "";
  const style = w.css.length ? `<style>${w.css.join("\n")}</style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width * o.scale)}" height="${n(height * o.scale)}" viewBox="0 0 ${n(width)} ${n(height)}" fill="none">${style}${defs}${body}</svg>\n`;
}
