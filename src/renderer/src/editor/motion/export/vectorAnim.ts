/**
 * What the vector animation writers share (docs/motion.md §7.5, §7.6; round 8e): the engine's shapes of a root at base
 * values (`motionShapes`) as a tree, its layers' values sampled at each exported frame (`motionSamples`), and the
 * maths over them — the path data's contours as vertices and tangents, a 2×3 transform as position / rotation / skew /
 * scale, the samples thinned to the frames a straight line between neighbours doesn't reproduce.
 *
 * The animation is the samples: every animated value is read from the engine at the export's frame rate, so presets,
 * instance offsets, springs and stacked tracks come out as the canvas plays them, and the keyframes left are those the
 * simplification keeps. Round 8i: a layer animated by manual keyframes that reproduce its samples is written with
 * those keyframes, their bezier easings and the motion path's tangents instead (keyframed.ts, the scene's `keyed`).
 */
import type { Guid } from "@/engine/codec";
import type { Micros, MotionSample, MotionShapeLayer, PlaybackName } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { renderEngineExport } from "../../exportCore";
import { motionRead } from "../motionState";
import { frameTime, type FramePlan } from "./frames";
import { keyedLayers, type KeyedLayer } from "./keyframed";

export type Matrix = [number, number, number, number, number, number];

/** A layer of the tree: its shape, its samples (one per frame, the last at the span's end), its children back to front. */
export interface AnimLayer {
  shape: MotionShapeLayer;
  frames: MotionSample[];
  children: AnimLayer[];
}

export interface AnimScene {
  root: AnimLayer;
  /** Frames 0 … count (count + 1 samples: the last one closes the span) */
  count: number;
  fps: number;
  /** Each frame's timeline time (µs) */
  times?: Micros[];
  /** The span the frames cover (µs; Ping-pong's there and back) */
  rangeUs?: Micros;
  /** The layers written from their keyframes (round 8i), by node */
  keyed?: ReadonlyMap<string, KeyedLayer>;
}

/** The root's shapes and samples at every frame of the plan, as a tree (null: not a root, or a wasm without them). */
export function sampleScene(ed: EditorController, root: Guid, plan: FramePlan, durationUs: Micros, playback: PlaybackName): AnimScene | null {
  const shapes = motionRead(() => ed.engine.motionShapes(root), null);
  if (!shapes?.length) return null;
  const times = Array.from({ length: plan.frames + 1 }, (_, k) => Math.round(frameTime(Math.min(k, plan.frames), plan, durationUs, playback)));
  const samples = motionRead(() => ed.engine.motionSamples(root, times), null);
  if (!samples) return null;
  const scene = buildScene(shapes, samples.layers, plan.frames, plan.fps);
  if (!scene) return null;
  scene.times = times;
  scene.rangeUs = plan.rangeUs;
  // The manual keyframes (the timeline model's tracks) and the anchors (the resolved model's) of the keyable layers.
  const model = motionRead(() => ed.engine.motionTimeline(root), null);
  const resolved = motionRead(() => ed.engine.motionResolved(root), null);
  const anchors = new Map((resolved?.layers ?? []).map((l) => [l.node, l.anchor]));
  scene.keyed = keyedLayers(scene, model, playback, anchors);
  return scene;
}

/** The tree of shapes with their frames (layers the samples lack keep their base values). */
export function buildScene(shapes: readonly MotionShapeLayer[], layers: readonly { node: string; frames: MotionSample[] }[], count: number, fps: number): AnimScene | null {
  const frames = new Map(layers.map((l) => [l.node, l.frames]));
  const byId = new Map<string, AnimLayer>();
  let root: AnimLayer | null = null;
  for (const shape of shapes) {
    const still: MotionSample = { t: shape.transform, o: shape.opacity, w: shape.size.width, h: shape.size.height, fills: [], strokes: [], sw: 0 };
    const layer: AnimLayer = { shape, frames: frames.get(shape.node) ?? Array.from({ length: count + 1 }, () => still), children: [] };
    byId.set(shape.node, layer);
    const parent = shape.parent ? byId.get(shape.parent) : null;
    if (parent) parent.children.push(layer);
    else if (!root) root = layer;
  }
  return root ? { root, count, fps } : null;
}

// ---- Paths ---------------------------------------------------------------------------------------------------------

/** A contour as Lottie holds one: vertices, each one's in / out tangent relative to it, and whether it closes. */
export interface Contour {
  v: [number, number][];
  i: [number, number][];
  o: [number, number][];
  c: boolean;
}

/** Absolute M / L / Q / C / Z path data (the engine's) as contours; a closing vertex on the start is merged into it. */
export function contoursOf(d: string): Contour[] {
  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const out: Contour[] = [];
  let cur: Contour | null = null;
  let k = 0;
  const n = () => Number(tokens[k++]);
  const last = (): [number, number] => cur!.v[cur!.v.length - 1];
  const close = () => {
    if (!cur) return;
    if (cur.c && cur.v.length > 1) {
      const a = cur.v[0], b = last();
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
        cur.i[0] = cur.i[cur.i.length - 1];
        cur.v.pop();
        cur.i.pop();
        cur.o.pop();
      }
    }
    if (cur.v.length) out.push(cur);
    cur = null;
  };
  const push = (p: [number, number], inT: [number, number]) => {
    cur!.v.push(p);
    cur!.i.push(inT);
    cur!.o.push([0, 0]);
  };
  while (k < tokens.length) {
    const cmd = tokens[k++].toUpperCase();
    if (cmd === "M") {
      close();
      cur = { v: [], i: [], o: [], c: false };
      push([n(), n()], [0, 0]);
    } else if (cmd === "L" && cur) push([n(), n()], [0, 0]);
    else if ((cmd === "C" || cmd === "Q") && cur) {
      const p0 = last();
      let c1: [number, number], c2: [number, number], p: [number, number];
      if (cmd === "C") {
        c1 = [n(), n()];
        c2 = [n(), n()];
        p = [n(), n()];
      } else {
        // A quadratic raised to a cubic.
        const q: [number, number] = [n(), n()];
        p = [n(), n()];
        c1 = [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])];
        c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
      }
      cur.o[cur.o.length - 1] = [c1[0] - p0[0], c1[1] - p0[1]];
      push(p, [c2[0] - p[0], c2[1] - p[1]]);
    } else if (cmd === "Z" && cur) {
      cur.c = true;
      close();
    }
  }
  close();
  return out;
}

// ---- Transforms ----------------------------------------------------------------------------------------------------

/** A 2×3 as Lottie's transform with the anchor at 0: T(p) · R(r) · Skew(sk) · S(s), rotation clockwise in degrees. */
export interface Decomposed {
  p: [number, number];
  r: number;
  /** Lottie's skew (degrees, axis 0) */
  sk: number;
  s: [number, number];
}

export function decompose(m: Matrix): Decomposed {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b) || 1e-9;
  const r = (Math.atan2(b, a) * 180) / Math.PI;
  const det = a * d - b * c;
  const sy = det / sx;
  const kxy = (a * c + b * d) / sx;
  const h = Math.abs(sy) > 1e-12 ? kxy / sy : 0;
  return { p: [e, f], r, sk: (-Math.atan(h) * 180) / Math.PI, s: [sx * 100, sy * 100] };
}

/** Rotations made continuous (no jump of 360° between neighbours). */
export function unwrapDegrees(values: number[]): number[] {
  const out = values.slice();
  for (let k = 1; k < out.length; k++) {
    while (out[k] - out[k - 1] > 180) out[k] -= 360;
    while (out[k] - out[k - 1] < -180) out[k] += 360;
  }
  return out;
}

export const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

// ---- Keyframes -----------------------------------------------------------------------------------------------------

/**
 * The frames to keep of a sampled value (one vector per frame): the first and the last, and every frame a straight
 * line from the last kept one to a later one doesn't reproduce within `tol` per component (a greedy pass).
 */
export function keepFrames(values: readonly (readonly number[])[], tol: number): number[] {
  const n = values.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const kept = [0];
  let start = 0;
  for (let j = start + 2; j < n; j++) {
    let ok = true;
    for (let m = start + 1; m < j && ok; m++) {
      const u = (m - start) / (j - start);
      for (let c = 0; c < values[m].length; c++) {
        const want = values[start][c] + (values[j][c] - values[start][c]) * u;
        if (Math.abs(want - values[m][c]) > tol) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      start = j - 1;
      kept.push(start);
    }
  }
  kept.push(n - 1);
  return kept;
}

/** Whether every frame holds the same value (within `tol`). */
export const constant = (values: readonly (readonly number[])[], tol: number): boolean => values.every((v) => v.every((x, c) => Math.abs(x - values[0][c]) <= tol));

// ---- Rasters -------------------------------------------------------------------------------------------------------

/** The PNG of a layer's base state at `scale` (the layers shapes can't draw), or null. */
export async function rasterPng(ed: EditorController, node: Guid, scale: number): Promise<Uint8Array | null> {
  const r = await renderEngineExport(ed.engine, (h) => ed.images.bytes(h), [node], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: scale } });
  return "bytes" in r ? r.bytes : null;
}

/** Every rasterised layer of the tree. */
export function rasterLayers(l: AnimLayer, out: AnimLayer[] = []): AnimLayer[] {
  if (l.shape.rasterize && l.shape.raster) out.push(l);
  l.children.forEach((c) => rasterLayers(c, out));
  return out;
}

/** Bytes as base64 (data URIs). */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
