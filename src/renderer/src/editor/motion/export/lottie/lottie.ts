/**
 * Our Lottie writer (docs/motion.md §7.6; round 8e): Lottie 5.7 JSON (`v` "5.7.0", `fr` the frame rate, `ip` 0, `op`
 * the frames, `w` / `h` the root's size at the export's scale) from a sampled scene (../vectorAnim.ts).
 *
 * Each layer is a shape layer (`ty` 4: its fills and gradients `fl` / `gf`, its centre strokes `st` / `gs` with their
 * width, caps, joins and dashes, a trim-paths `tm` on a path-trimmed stroke; text as its glyphs' outlines) or, with
 * nothing to draw, a null (`ty` 3) its children hang from; the parent's transform comes through Lottie's parenting.
 * A frame that clips its content is a precomposition (`ty` 0) masked by its box, its content inside. Opacity, which
 * Lottie doesn't pass to children, is each layer's own times its ancestors' within the composition. A layer shapes
 * can't draw (images, shaders, angular gradients, blurs, masks) is an image layer of its base state (`ty` 2): embedded
 * as base64 in Lottie, a file under `images/` in dotLottie. Shadows are left out (Figma's export: "partial").
 *
 * Transforms, opacity, solid colours, stroke widths and path trim are written from the samples, thinned to the frames
 * a straight line doesn't reproduce; everything else is static at base values (a WIDTH / HEIGHT animation doesn't
 * reshape the paths yet).
 */
import type { MotionSample, MotionShapePaint, MotionShapePath, RGBA } from "@shared/motion/types";
import { constant, contoursOf, decompose, keepFrames, unwrapDegrees, type AnimLayer, type AnimScene, type Matrix } from "../vectorAnim";

/** A Lottie value: static `{a: 0, k}` or keyframed `{a: 1, k: [...]}`. */
export type LottieValue = { a: 0; k: number | number[] } | { a: 1; k: LottieKeyframe[] };
export interface LottieKeyframe {
  t: number;
  s: number[];
  i?: { x: number[]; y: number[] };
  o?: { x: number[]; y: number[] };
}
type Json = Record<string, unknown>;

export interface LottieAsset {
  id: string;
  w: number;
  h: number;
  /** Embedded: a data URI; dotLottie: a file name under `u` */
  u: string;
  p: string;
  e: 0 | 1;
}

export interface LottieOptions {
  name: string;
  /** The export's scale (Size) */
  scale: number;
  /** The raster of each rasterised layer by node: its asset (made by the caller) */
  rasters: ReadonlyMap<string, LottieAsset>;
}

const TOL = { position: 0.01, rotation: 0.01, scale: 0.01, opacity: 0.05, color: 0.002, width: 0.01, trim: 0.02 };

/**
 * A sampled value as Lottie's: static when every frame agrees, else a keyframe per frame the line can't skip, linear
 * between them (out 0 / in 1 on every dimension), the last one closing the span.
 */
export function lottieValue(frames: readonly (readonly number[])[], tol: number, scalar = false): LottieValue {
  const out = (v: readonly number[]) => (scalar ? v[0] : [...v]);
  if (constant(frames, tol)) return { a: 0, k: out(frames[0]) as number | number[] };
  const keep = keepFrames(frames, tol);
  const dims = frames[0].length;
  const ease = { o: { x: Array(dims).fill(0), y: Array(dims).fill(0) }, i: { x: Array(dims).fill(1), y: Array(dims).fill(1) } };
  return { a: 1, k: keep.map((f, n) => (n < keep.length - 1 ? { t: f, s: [...frames[f]], ...ease } : { t: f, s: [...frames[f]] })) };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** A layer's transform (`ks`) from its sampled local transforms and opacities (0–1), anchor at its origin. */
export function transformOf(transforms: readonly Matrix[], opacity: readonly number[]): Json {
  const parts = transforms.map(decompose);
  const r = unwrapDegrees(parts.map((p) => p.r));
  return {
    a: { a: 0, k: [0, 0] },
    p: lottieValue(parts.map((p) => p.p.map(round)), TOL.position),
    r: lottieValue(r.map((x) => [round(x)]), TOL.rotation, true),
    s: lottieValue(parts.map((p) => p.s.map(round)), TOL.scale),
    sk: lottieValue(parts.map((p) => [round(p.sk)]), TOL.rotation, true),
    sa: { a: 0, k: 0 },
    o: lottieValue(opacity.map((o) => [round(o * 100)]), TOL.opacity, true),
  };
}

const rgb = (c: RGBA) => [round(c.r), round(c.g), round(c.b), 1];

/** A paint's style item (`fl` / `st` / `gf` / `gs`) with its colour sampled from the frames when it is solid. */
function styleOf(path: MotionShapePath, frames: readonly MotionSample[], trimmed: boolean): Json[] {
  const p: MotionShapePaint = path.paint;
  const list = path.source.collection === "fills" ? "fills" : "strokes";
  const colours = frames.map((f) => (p.type === "SOLID" ? (f[list][path.source.index] ?? p.color) : null));
  const stroke = path.stroke;
  const items: Json[] = [];
  if (trimmed && stroke) {
    const trim = frames.map((f) => f.trim ?? [0, 1]);
    items.push({ ty: "tm", nm: "Trim Paths", s: lottieValue(trim.map((x) => [round(x[0] * 100)]), TOL.trim, true), e: lottieValue(trim.map((x) => [round(x[1] * 100)]), TOL.trim, true), o: { a: 0, k: 0 }, m: 1 });
  }
  const common: Json = {};
  if (stroke) {
    common.w = lottieValue(frames.map((f) => [round(f.sw || stroke.weight)]), TOL.width, true);
    common.lc = stroke.cap === "ROUND" ? 2 : stroke.cap === "SQUARE" ? 3 : 1;
    common.lj = stroke.join === "ROUND" ? 2 : stroke.join === "BEVEL" ? 3 : 1;
    common.ml = stroke.miterLimit;
    if (stroke.dashes.length) {
      const d = stroke.dashes.length % 2 ? [...stroke.dashes, ...stroke.dashes] : stroke.dashes;
      common.d = [...d.map((v, k) => ({ n: k % 2 ? "g" : "d", nm: k % 2 ? "gap" : "dash", v: { a: 0, k: v } })), { n: "o", nm: "offset", v: { a: 0, k: 0 } }];
    }
  }
  if (p.type === "SOLID") {
    const c = colours as RGBA[];
    items.push({
      ty: stroke ? "st" : "fl",
      c: lottieValue(c.map(rgb), TOL.color),
      o: lottieValue(c.map((x) => [round(x.a * 100)]), TOL.opacity, true),
      ...(stroke ? common : { r: path.windingRule === "EVENODD" ? 2 : 1 }),
    });
  } else {
    // A gradient: its stops' colours then their alphas (Lottie's `g.k`), between its two ends.
    const stops = p.stops;
    const k = [...stops.flatMap((s) => [round(s.position), round(s.color.r), round(s.color.g), round(s.color.b)]), ...stops.flatMap((s) => [round(s.position), round(s.color.a)])];
    items.push({
      ty: stroke ? "gs" : "gf",
      t: p.type === "GRADIENT_LINEAR" ? 1 : 2,
      s: { a: 0, k: [round(p.from.x), round(p.from.y)] },
      e: { a: 0, k: [round(p.to.x), round(p.to.y)] },
      g: { p: stops.length, k: { a: 0, k } },
      o: { a: 0, k: 100 },
      ...(stroke ? common : { r: path.windingRule === "EVENODD" ? 2 : 1 }),
    });
  }
  return items;
}

/** One path as a shape group: its contours, the trim, its style, the group's identity transform. */
function groupOf(path: MotionShapePath, frames: readonly MotionSample[], n: number): Json {
  const trimmed = !!path.stroke && frames.some((f) => f.trim && (f.trim[0] > 0 || f.trim[1] < 1));
  const shapes = contoursOf(path.d).map((c, k) => ({ ty: "sh", nm: `Path ${k + 1}`, ks: { a: 0, k: { c: c.c, v: c.v.map((p) => p.map(round)), i: c.i.map((p) => p.map(round)), o: c.o.map((p) => p.map(round)) } } }));
  return {
    ty: "gr",
    nm: `${path.stroke ? "Stroke" : "Fill"} ${n}`,
    it: [
      ...shapes,
      ...styleOf(path, frames, trimmed),
      { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } },
    ],
  };
}

/** The rectangle of a box as a mask path (Lottie's `pt`). */
const boxMask = (w: number, h: number): Json => ({
  mode: "a",
  inv: false,
  o: { a: 0, k: 100 },
  x: { a: 0, k: 0 },
  pt: { a: 0, k: { c: true, v: [[0, 0], [w, 0], [w, h], [0, h]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] } },
});

interface Builder {
  ind: number;
  op: number;
  assets: Json[];
  rasters: ReadonlyMap<string, LottieAsset>;
  comps: number;
}

/**
 * A layer and its subtree into a composition's layers (bottom first): `parent` the index of the layer it hangs from,
 * `inherited` the opacity its ancestors in this composition give it per frame.
 */
function emit(b: Builder, l: AnimLayer, parent: number | null, inherited: number[], out: Json[], top: boolean): void {
  const s = l.shape;
  const frames = l.frames;
  const transforms = frames.map((f) => f.t as Matrix);
  const own = frames.map((f, k) => f.o * inherited[k]);
  const base = { ip: 0, op: b.op, st: 0, sr: 1, ddd: 0, ao: 0, bm: 0, nm: s.name, ...(parent !== null ? { parent } : {}) };
  if (!top && s.clips && l.children.length) {
    // Its content clipped: a precomposition of its own fills and children, masked by its box.
    const id = `comp_${b.comps++}`;
    const inner: Json[] = [];
    const still = frames.map(() => [1, 0, 0, 1, 0, 0] as Matrix);
    const self: AnimLayer = { shape: { ...s, clips: false }, frames: frames.map((f, k) => ({ ...f, t: still[k], o: 1 })), children: l.children };
    emit(b, self, null, frames.map(() => 1), inner, true);
    b.assets.push({ id, nm: s.name, layers: inner.reverse() });
    out.push({ ...base, ty: 0, ind: b.ind++, refId: id, w: Math.ceil(s.size.width), h: Math.ceil(s.size.height), hasMask: true, masksProperties: [boxMask(s.size.width, s.size.height)], ks: transformOf(transforms, own) });
    return;
  }
  const ind = b.ind++;
  if (s.paths.length) {
    out.push({ ...base, ty: 4, ind, ks: transformOf(transforms, own), shapes: s.paths.map((p, k) => groupOf(p, frames, k + 1)).reverse() });
  } else {
    out.push({ ...base, ty: 3, ind, ks: transformOf(transforms, frames.map(() => 1)) });
  }
  const asset = s.raster ? b.rasters.get(s.node) : undefined;
  if (asset && s.raster) {
    // Its base state's pixels, placed in its space (the asset is drawn at the export's scale: scaled back here).
    const k = s.raster.width > 0 ? s.raster.width / asset.w : 1;
    const place = s.raster.transform;
    const m: Matrix = [place[0] * k, place[1] * k, place[2] * k, place[3] * k, place[4], place[5]];
    out.push({ ...base, nm: `${s.name} (image)`, ty: 2, ind: b.ind++, parent: ind, refId: asset.id, ks: transformOf(frames.map(() => m), own) });
  }
  for (const c of l.children) emit(b, c, ind, own, out, false);
}

/** The scene as a Lottie animation (JSON object): one root composition, the root scaled by the export's Size. */
export function writeLottie(scene: AnimScene, o: LottieOptions): Json {
  const root = scene.root;
  const b: Builder = { ind: 1, op: scene.count, assets: [], rasters: o.rasters, comps: 0 };
  const layers: Json[] = [];
  // The Size: a null scaling everything (the root's own layer hangs from it).
  const scaleInd = b.ind++;
  layers.push({ ty: 3, ind: scaleInd, nm: "Scale", ip: 0, op: b.op, st: 0, sr: 1, ddd: 0, ao: 0, bm: 0, ks: transformOf([[o.scale, 0, 0, o.scale, 0, 0]], [1]) });
  emit(b, root, scaleInd, root.frames.map(() => 1), layers, true);
  const images = [...o.rasters.values()];
  return {
    v: "5.7.0",
    fr: scene.fps,
    ip: 0,
    op: scene.count,
    w: Math.max(1, Math.round(root.shape.size.width * o.scale)),
    h: Math.max(1, Math.round(root.shape.size.height * o.scale)),
    nm: o.name,
    ddd: 0,
    assets: [...images, ...b.assets],
    layers: layers.reverse(),
    markers: [],
  };
}
