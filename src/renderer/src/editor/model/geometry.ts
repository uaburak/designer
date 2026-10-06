/**
 * Transform math for the panels (docs/schema.md §3.3: `transform` is the 2×3
 * matrix relative to the parent, `size` the unrotated box). Figma's panel
 * semantics: X/Y are the transform's translation relative to the nearest
 * non-group ancestor, rotation is atan2(−m10, m00) in degrees (counter-
 * clockwise on screen), and rotating or flipping from the panel turns the
 * layer about its centre.
 */
import type { Matrix, Vector } from "@/engine/codec";

export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** a ∘ b: b first, then a. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const i00 = m.m11 / det;
  const i01 = -m.m01 / det;
  const i10 = -m.m10 / det;
  const i11 = m.m00 / det;
  return { m00: i00, m01: i01, m02: -(i00 * m.m02 + i01 * m.m12), m10: i10, m11: i11, m12: -(i10 * m.m02 + i11 * m.m12) };
}

export function applyPoint(m: Matrix, p: Vector): Vector {
  return { x: m.m00 * p.x + m.m01 * p.y + m.m02, y: m.m10 * p.x + m.m11 * p.y + m.m12 };
}

/** Rounds for the panel (Figma shows at most two decimals) and turns −0 into 0. */
export function roundPanel(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Figma's rotation in degrees, (−180, 180]. */
export function rotationOf(m: Matrix): number {
  const deg = (Math.atan2(-m.m10, m.m00) * 180) / Math.PI;
  const r = roundPanel(deg, 6);
  return r <= -180 ? r + 360 : r;
}

/** The box's centre in the parent's space. */
export const centerOf = (m: Matrix, size: Vector): Vector => applyPoint(m, { x: size.x / 2, y: size.y / 2 });

/** Turned by `deltaDegrees` (Figma's sense: counter-clockwise on screen) about the box's centre; flips are kept. */
export function rotateBy(m: Matrix, size: Vector, deltaDegrees: number): Matrix {
  return rotateAbout(m, centerOf(m, size), deltaDegrees);
}

/** Turned about its centre so that its panel rotation is `degrees`. */
export function rotateTo(m: Matrix, size: Vector, degrees: number): Matrix {
  return rotateBy(m, size, degrees - rotationOf(m));
}

/** Mirrored in place (about its own centre): "x" = Flip horizontal, "y" = Flip vertical. */
export function flip(m: Matrix, size: Vector, axis: "x" | "y"): Matrix {
  const f: Matrix = axis === "x" ? { m00: -1, m01: 0, m02: size.x, m10: 0, m11: 1, m12: 0 } : { m00: 1, m01: 0, m02: 0, m10: 0, m11: -1, m12: size.y };
  return clean(multiply(m, f));
}

/** Mirrored across the vertical ("x") or horizontal ("y") line through `c` (parent space): Figma flips on the canvas's axes. */
export function mirrorAbout(m: Matrix, axis: "x" | "y", c: Vector): Matrix {
  const f: Matrix = axis === "x" ? { m00: -1, m01: 0, m02: 2 * c.x, m10: 0, m11: 1, m12: 0 } : { m00: 1, m01: 0, m02: 0, m10: 0, m11: -1, m12: 2 * c.y };
  return clean(multiply(f, m));
}

/** Turned by `deltaDegrees` (counter-clockwise on screen) about `c` (parent space). */
export function rotateAbout(m: Matrix, c: Vector, deltaDegrees: number): Matrix {
  const a = (-deltaDegrees * Math.PI) / 180; // screen space is y-down: a panel turn is the opposite screen angle
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const rotation: Matrix = { m00: cos, m01: -sin, m02: c.x - cos * c.x + sin * c.y, m10: sin, m11: cos, m12: c.y - sin * c.x - cos * c.y };
  return clean(multiply(rotation, m));
}

/** Rounding noise (1e-12) off the linear part, so 90° turns stay exact. */
function clean(m: Matrix): Matrix {
  const snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
  return { m00: snap(m.m00), m01: snap(m.m01), m02: m.m02, m10: snap(m.m10), m11: snap(m.m11), m12: m.m12 };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The axis-aligned bounds of a `size` box under `m`. */
export function boundsOf(m: Matrix, size: Vector): Box {
  const pts = [applyPoint(m, { x: 0, y: 0 }), applyPoint(m, { x: size.x, y: 0 }), applyPoint(m, { x: 0, y: size.y }), applyPoint(m, { x: size.x, y: size.y })];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The union of boxes (null for none). */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bt = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bt - y };
}

/**
 * The panel's X/Y: the translation of `groups ∘ m`, where `groups` is the
 * product of the transforms of the group ancestors between the layer and its
 * nearest non-group ancestor (identity when the parent isn't a group).
 */
export function panelPosition(m: Matrix, groups: Matrix = IDENTITY): Vector {
  const c = multiply(groups, m);
  return { x: c.m02, y: c.m12 };
}

/** `m` moved so that its panel X and/or Y are these (the other one kept). */
export function withPanelPosition(m: Matrix, groups: Matrix, x: number | null, y: number | null): Matrix {
  const now = panelPosition(m, groups);
  const target = { x: x ?? now.x, y: y ?? now.y };
  // groups ∘ m' has translation `target`: m'.t = groups⁻¹(target), the linear part unchanged.
  const t = applyPoint(invert(groups), target);
  return { ...m, m02: t.x, m12: t.y };
}
