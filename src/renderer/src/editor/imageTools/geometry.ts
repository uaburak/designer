/**
 * Canvas geometry for the image tools' overlays: a layer's transform to the page, page ↔ the canvas's CSS px through
 * the camera, and a canvas point into the layer's own units (the lasso is kept there, so it follows pan and zoom).
 */
import type { Camera, Guid } from "@/engine/codec";
import type { EditorController } from "../controller";
import type { Point } from "./pixels";

export type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
const mul = (a: Affine, b: Affine): Affine => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];

/** The layer's transform to the page (its parents' composed). */
export function pageMatrix(ed: EditorController, id: Guid): Affine {
  let m = IDENTITY;
  let cur: Guid | undefined = id;
  for (let depth = 0; cur && depth < 256; depth++) {
    const n = ed.engine.readNode(cur);
    if (!n || n.type === "CANVAS" || n.type === "DOCUMENT") break;
    const t = n.transform;
    if (t) m = mul([t.m00, t.m01, t.m02, t.m10, t.m11, t.m12], m);
    cur = n.parentIndex?.guid;
  }
  return m;
}

/** Layer units → the canvas's CSS px. */
export const toScreen = (m: Affine, cam: Camera, p: Point): Point => ({ x: (m[0] * p.x + m[1] * p.y + m[2]) * cam.zoom + cam.x, y: (m[3] * p.x + m[4] * p.y + m[5]) * cam.zoom + cam.y });

/** The canvas's CSS px → layer units. */
export function toLayer(m: Affine, cam: Camera, p: Point): Point {
  const x = (p.x - cam.x) / cam.zoom - m[2], y = (p.y - cam.y) / cam.zoom - m[5];
  const det = m[0] * m[4] - m[1] * m[3] || 1;
  return { x: (m[4] * x - m[1] * y) / det, y: (-m[3] * x + m[0] * y) / det };
}

/** A CSS transform that puts a box of the layer's units (× zoom) on the canvas, rotation included. */
export const cssMatrix = (m: Affine, cam: Camera) => {
  const sx = Math.hypot(m[0], m[3]) || 1, sy = Math.hypot(m[1], m[4]) || 1;
  return `matrix(${m[0] / sx}, ${m[3] / sx}, ${m[1] / sy}, ${m[4] / sy}, ${m[2] * cam.zoom + cam.x}, ${m[5] * cam.zoom + cam.y})`;
};
