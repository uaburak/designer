/**
 * The timeline's own keyframes for the vector exports (docs/motion.md §7.5, §7.6; round 8i): where a layer's motion is
 * manual keyframes — Position (XY, or X and Y at the same times), Rotation, Scale, Opacity, eased by bezier curves or
 * Hold — Lottie and the animated SVG write those keyframes with their curves (and Lottie the motion path's tangents)
 * instead of the frames sampled at the export's rate. Everything else stays sampled: springs, presets' clips, animated
 * instances, text stagger, Ping-pong, a layer whose base transform scales or skews, and anything the keyframes don't
 * reproduce — each candidate is played back here at every exported frame and kept only when it lands where the engine
 * drew the layer (the samples), so a file never plays differently from the canvas.
 *
 * The keyed values are the motion part of the layer's transform, M = L · T(o) · X · T(−o) with X = T(t) · R(−r) · S(s)
 * (§4.5; L the base transform, o the anchor, r Figma's counter-clockwise rotation): `translate` t, `rotate` −r in
 * degrees (clockwise, as Lottie and CSS turn), `scale` s; the writers place L and o around them.
 */
import { cubicBezierAt, bezierOf, type Bezier } from "@shared/motion/easing";
import type { Micros, MotionEasing, PlaybackName, TimelineKeyframe, TimelineLayer, TimelineModel } from "@shared/motion/types";
import { decompose, multiply, type AnimLayer, type AnimScene, type Matrix } from "./vectorAnim";

/** One keyed value: its keys in µs; a key's `ease` is the segment's from it to the next (Hold, a curve, or none: the last). */
export interface KeyChannel {
  keys: { timeUs: Micros; v: number[]; ease: Bezier | "HOLD" | null; out?: [number, number]; in?: [number, number] }[];
}

export interface KeyedLayer {
  /** The base transform L (an orthonormal one: a turn and a move) and the anchor o in the layer's space */
  base: Matrix;
  anchor: [number, number];
  /** The transform written from the keys (else it stays the samples'); absent channels then static at `still` */
  transform: boolean;
  translate?: KeyChannel;
  rotate?: KeyChannel;
  scale?: KeyChannel;
  /** The layer's own opacity keyed (0–1) */
  opacity?: KeyChannel;
  /** Its ancestors' opacity in the file when it holds still (Lottie multiplies it in), else null: Lottie samples it */
  inheritedOpacity: number | null;
  /** The motion part at rest (the first frame's): t, the clockwise turn in degrees, s */
  still: { translate: [number, number]; rotate: number; scale: [number, number] };
  /** The motion path's handles on Position keys (Lottie draws them; the SVG then samples the layer) */
  curved: boolean;
}

const TRANSFORM = new Set(["TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY", "ROTATION", "SCALE_X", "SCALE_Y", "SCALE_XY"]);

/** A curve's handles for the segment into `k` (Hold: "HOLD"; a spring: null — not keyable). */
function easeOf(e: MotionEasing | { variable: string }): Bezier | "HOLD" | null {
  if (!("type" in e)) return null;
  if (e.type === "HOLD") return "HOLD";
  return bezierOf(e);
}

/** A track's keys as a channel (`value` its numbers; the first key's easing unused, each later one eases into it). */
function channel(keys: readonly TimelineKeyframe[], value: (k: TimelineKeyframe) => number[] | null): KeyChannel | null {
  const out: KeyChannel["keys"] = [];
  for (let i = 0; i < keys.length; i++) {
    const v = value(keys[i]);
    if (!v) return null;
    const next = keys[i + 1];
    const ease = next ? easeOf(next.easing) : null;
    if (next && ease === null) return null;
    const h = keys[i].pathHandles;
    out.push({ timeUs: keys[i].timeUs, v, ease, ...(h ? { out: [h.out.x, h.out.y] as [number, number], in: [h.in.x, h.in.y] as [number, number] } : {}) });
  }
  return out.length ? { keys: out } : null;
}

/** Two one-number channels at the same times with the same curves as one two-number channel (else null). */
function pair(x: KeyChannel | null, y: KeyChannel | null): KeyChannel | null {
  if (!x || !y || x.keys.length !== y.keys.length) return null;
  const keys: KeyChannel["keys"] = [];
  for (let i = 0; i < x.keys.length; i++) {
    const a = x.keys[i];
    const b = y.keys[i];
    if (a.timeUs !== b.timeUs || JSON.stringify(a.ease) !== JSON.stringify(b.ease)) return null;
    keys.push({ timeUs: a.timeUs, v: [a.v[0], b.v[0]], ease: a.ease });
  }
  return { keys };
}

// ---- Playing a channel back --------------------------------------------------------------------------------------

/** A cubic's point at arc-length fraction `e` (a 64-sample table, as the engine's motion path, Evaluate.h). */
function pathPoint(a: number[], outA: [number, number], inB: [number, number], b: number[], e: number): number[] {
  const p0 = a, p1 = [a[0] + outA[0], a[1] + outA[1]], p2 = [b[0] + inB[0], b[1] + inB[1]], p3 = b;
  const at = (u: number) => {
    const w = 1 - u;
    return [0, 1].map((c) => w * w * w * p0[c] + 3 * w * w * u * p1[c] + 3 * w * u * u * p2[c] + u * u * u * p3[c]);
  };
  const n = 64;
  const lens = [0];
  let prev = at(0);
  for (let i = 1; i <= n; i++) {
    const q = at(i / n);
    lens.push(lens[i - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
    prev = q;
  }
  const total = lens[n];
  if (total <= 0) return at(e);
  const want = Math.min(1, Math.max(0, e)) * total;
  let i = 1;
  while (i < n && lens[i] < want) i++;
  const span = lens[i] - lens[i - 1];
  const u = (i - 1 + (span > 0 ? (want - lens[i - 1]) / span : 0)) / n;
  return at(u);
}

/** A channel's value at `timeUs` (the first value before its first key, the last after its last). */
export function channelAt(c: KeyChannel, timeUs: Micros): number[] {
  const ks = c.keys;
  if (timeUs <= ks[0].timeUs) return ks[0].v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (timeUs > b.timeUs) continue;
    const p = (timeUs - a.timeUs) / Math.max(1, b.timeUs - a.timeUs);
    const e = a.ease === "HOLD" ? (p >= 1 ? 1 : 0) : a.ease ? cubicBezierAt(a.ease, p) : p;
    if (a.out || b.in) return pathPoint(a.v, a.out ?? [0, 0], b.in ?? [0, 0], b.v, e);
    return a.v.map((x, d) => x + (b.v[d] - x) * e);
  }
  return ks[ks.length - 1].v;
}

// ---- Finding the keyable layers ------------------------------------------------------------------------------------

const rad = (d: number) => (d * Math.PI) / 180;
const inverse = (m: Matrix): Matrix => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
/** X = T(t) · R(turn, clockwise degrees) · S(s). */
export const motionPart = (t: number[], turn: number, s: number[]): Matrix => {
  const c = Math.cos(rad(turn)), si = Math.sin(rad(turn));
  return [c * s[0], si * s[0], -si * s[1], c * s[1], t[0], t[1]];
};
/** An orthonormal base: a turn and a move, no scale or skew (what keeps Lottie's rotation and position additive). */
const orthonormal = (m: Matrix) => Math.abs(m[0] * m[0] + m[1] * m[1] - 1) < 1e-6 && Math.abs(m[2] * m[2] + m[3] * m[3] - 1) < 1e-6 && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-6 && m[0] * m[3] - m[1] * m[2] > 0;

/** Within the export's tolerance: transforms to 0.05 px over the layer's box, opacity to 0.002. */
function sameMatrix(a: Matrix, b: Matrix, size: { width: number; height: number }): boolean {
  const reach = Math.max(1, size.width, size.height);
  for (let k = 0; k < 4; k++) if (Math.abs(a[k] - b[k]) * reach > 0.05) return false;
  return Math.abs(a[4] - b[4]) < 0.05 && Math.abs(a[5] - b[5]) < 0.05;
}

/**
 * The layer's keys when they reproduce its samples: `times` the scene's frame times, `inherited` the opacity its
 * ancestors in the Lottie file give it per frame (Lottie doesn't pass opacity down; the SVG's groups do).
 */
export function keyedLayer(layer: TimelineLayer, l: AnimLayer, times: readonly Micros[], anchorPct: { x: number; y: number }, inherited: readonly number[]): KeyedLayer | null {
  if (layer.instance || layer.clips.length) return null;
  const tracks = new Map(layer.tracks.map((tr) => [tr.field.type === "PROPERTY" ? tr.field.name : "", tr]));
  const base = l.shape.transform as Matrix;
  if (!orthonormal(base)) return null;
  const size = l.shape.size;
  const o: [number, number] = [(size.width * anchorPct.x) / 100, (size.height * anchorPct.y) / 100];
  const toMotion = (m: Matrix) => multiply(inverse(multiply(base, [1, 0, 0, 1, o[0], o[1]])), multiply(m, [1, 0, 0, 1, o[0], o[1]]));
  const num = (k: TimelineKeyframe) => (k.value.type === "FLOAT" ? [k.value.value] : null);
  const vec = (k: TimelineKeyframe) => (k.value.type === "VECTOR" ? [k.value.value.x, k.value.value.y] : k.value.type === "FLOAT" ? [k.value.value, k.value.value] : null);
  const get = (name: string) => tracks.get(name)?.keyframes ?? null;
  const ch = (name: string, f: (k: TimelineKeyframe) => number[] | null) => {
    const ks = get(name);
    return ks?.length ? channel(ks, f) : null;
  };
  const anyTransform = layer.tracks.some((tr) => tr.field.type === "PROPERTY" && TRANSFORM.has(tr.field.name));
  if (!anyTransform && !get("OPACITY")) return null;
  // The motion part at rest: the first frame's.
  const first = decompose(toMotion(l.frames[0].t as Matrix));
  const out: KeyedLayer = { base, anchor: o, transform: false, still: { translate: first.p, rotate: first.r, scale: [first.s[0] / 100, first.s[1] / 100] }, curved: false, inheritedOpacity: null };
  if (anyTransform) {
    const has = (...names: string[]) => names.some((n) => get(n));
    const translate = ch("TRANSLATION_XY", vec) ?? (has("TRANSLATION_X", "TRANSLATION_Y") ? pair(ch("TRANSLATION_X", num), ch("TRANSLATION_Y", num)) : null);
    const rotate = ch("ROTATION", (k) => (k.value.type === "FLOAT" ? [-k.value.value] : null));
    const scale = ch("SCALE_XY", vec) ?? (has("SCALE_X", "SCALE_Y") ? pair(ch("SCALE_X", num), ch("SCALE_Y", num)) : null);
    let ok = (!has("TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY") || !!translate) && (!has("ROTATION") || !!rotate) && (!has("SCALE_X", "SCALE_Y", "SCALE_XY") || !!scale);
    // Played back at every frame, it must land where the engine drew the layer.
    for (let f = 0; f < times.length && ok; f++) {
      const t = translate ? channelAt(translate, times[f]) : out.still.translate;
      const r = rotate ? channelAt(rotate, times[f])[0] : out.still.rotate;
      const s = scale ? channelAt(scale, times[f]) : out.still.scale;
      ok = sameMatrix(motionPart(t, r, s), toMotion(l.frames[f].t as Matrix), size);
    }
    if (ok) {
      out.transform = true;
      if (translate) out.translate = translate;
      if (rotate) out.rotate = rotate;
      if (scale) out.scale = scale;
      out.curved = !!translate?.keys.some((k) => k.out || k.in);
    }
  }
  const opacity = ch("OPACITY", num);
  if (opacity && times.every((tf, f) => Math.abs(channelAt(opacity, tf)[0] - l.frames[f].o) < 0.002)) {
    out.opacity = opacity;
    const k0 = inherited[0] ?? 1;
    out.inheritedOpacity = inherited.every((v) => Math.abs(v - k0) < 1e-6) ? k0 : null;
  }
  return out.transform || out.opacity ? out : null;
}

/**
 * The scene's keyable layers (round 8i), by node: none for Ping-pong (its way back would need mirrored keys) or without
 * a timeline model; `anchors` each layer's anchor (% of its size) from the resolved model. A layer's inherited
 * opacity is what the Lottie writer gives it (its ancestors' within its composition; a clipping frame's content starts
 * a composition of its own).
 */
export function keyedLayers(scene: AnimScene, model: TimelineModel | null, playback: PlaybackName, anchors: ReadonlyMap<string, { x: number; y: number }>): Map<string, KeyedLayer> {
  const out = new Map<string, KeyedLayer>();
  if (!model || playback === "PING_PONG" || !scene.times?.length) return out;
  const byNode = new Map(model.layers.map((l) => [l.node, l]));
  const ones = scene.root.frames.map(() => 1);
  const visit = (l: AnimLayer, inherited: number[], top: boolean) => {
    const layer = byNode.get(l.shape.node);
    if (!top && layer) {
      const k = keyedLayer(layer, l, scene.times!, anchors.get(l.shape.node) ?? { x: 50, y: 50 }, inherited);
      if (k) out.set(l.shape.node, k);
    }
    const own = l.frames.map((f, k) => f.o * inherited[k]);
    const precomp = !top && l.shape.clips && l.children.length > 0;
    for (const c of l.children) visit(c, precomp ? ones : own, false);
  };
  visit(scene.root, ones, true);
  return out;
}
