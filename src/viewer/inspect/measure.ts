/**
 * Dev Mode's measurements (help.figma.com "Guide to inspecting": hovering a layer around the selection shows the
 * distances between the two, no modifier needed): the red lines from the selection's edges to the hovered layer's,
 * in page coordinates. Pure; the viewer draws them over the canvas.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A red line and its label: from (x1, y1) to (x2, y2), `value` page px long. */
export interface Redline {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
  /** A dashed guide continuing an edge to where the line is measured (no label) */
  guide?: boolean;
}

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const contains = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);

/** The lines between the selection `s` and the hovered layer `h` (none when they are the same box). */
export function redlines(s: Box, h: Box): Redline[] {
  if (s.x === h.x && s.y === h.y && s.width === h.width && s.height === h.height) return [];
  const out: Redline[] = [];
  const inner = contains(h, s) ? s : contains(s, h) ? h : null;
  if (inner) {
    // One inside the other: the four distances from the inner box's edges to the outer's, through its centre.
    const outer = inner === s ? h : s;
    const cx = inner.x + inner.width / 2;
    const cy = inner.y + inner.height / 2;
    if (inner.y > outer.y) out.push({ x1: cx, y1: outer.y, x2: cx, y2: inner.y, value: inner.y - outer.y });
    if (bottom(outer) > bottom(inner)) out.push({ x1: cx, y1: bottom(inner), x2: cx, y2: bottom(outer), value: bottom(outer) - bottom(inner) });
    if (inner.x > outer.x) out.push({ x1: outer.x, y1: cy, x2: inner.x, y2: cy, value: inner.x - outer.x });
    if (right(outer) > right(inner)) out.push({ x1: right(inner), y1: cy, x2: right(outer), y2: cy, value: right(outer) - right(inner) });
    return out;
  }
  // Apart: the horizontal and the vertical gap, each drawn where the two overlap on the other axis (else from the
  // selection's centre, with a dashed guide along the hovered layer's edge).
  const gapX = h.x >= right(s) ? { from: right(s), to: h.x } : right(h) <= s.x ? { from: right(h), to: s.x } : null;
  const gapY = h.y >= bottom(s) ? { from: bottom(s), to: h.y } : bottom(h) <= s.y ? { from: bottom(h), to: s.y } : null;
  if (gapX) {
    const lo = Math.max(s.y, h.y);
    const hi = Math.min(bottom(s), bottom(h));
    const y = lo <= hi ? (lo + hi) / 2 : s.y + s.height / 2;
    out.push({ x1: gapX.from, y1: y, x2: gapX.to, y2: y, value: gapX.to - gapX.from });
    if (lo > hi) {
      const edgeX = h.x >= right(s) ? h.x : right(h);
      out.push({ x1: edgeX, y1: y, x2: edgeX, y2: y < h.y ? h.y : bottom(h), value: 0, guide: true });
    }
  }
  if (gapY) {
    const lo = Math.max(s.x, h.x);
    const hi = Math.min(right(s), right(h));
    const x = lo <= hi ? (lo + hi) / 2 : s.x + s.width / 2;
    out.push({ x1: x, y1: gapY.from, x2: x, y2: gapY.to, value: gapY.to - gapY.from });
    if (lo > hi) {
      const edgeY = h.y >= bottom(s) ? h.y : bottom(h);
      out.push({ x1: x, y1: edgeY, x2: x < h.x ? h.x : right(h), y2: edgeY, value: 0, guide: true });
    }
  }
  if (!gapX && !gapY) {
    // Overlapping: the distances between the matching edges that differ.
    const cx = (Math.max(s.x, h.x) + Math.min(right(s), right(h))) / 2;
    const cy = (Math.max(s.y, h.y) + Math.min(bottom(s), bottom(h))) / 2;
    if (s.y !== h.y) out.push({ x1: cx, y1: Math.min(s.y, h.y), x2: cx, y2: Math.max(s.y, h.y), value: Math.abs(s.y - h.y) });
    if (bottom(s) !== bottom(h)) out.push({ x1: cx, y1: Math.min(bottom(s), bottom(h)), x2: cx, y2: Math.max(bottom(s), bottom(h)), value: Math.abs(bottom(s) - bottom(h)) });
    if (s.x !== h.x) out.push({ x1: Math.min(s.x, h.x), y1: cy, x2: Math.max(s.x, h.x), y2: cy, value: Math.abs(s.x - h.x) });
    if (right(s) !== right(h)) out.push({ x1: Math.min(right(s), right(h)), y1: cy, x2: Math.max(right(s), right(h)), y2: cy, value: Math.abs(right(s) - right(h)) });
  }
  return out;
}

/** A 2×3 affine matrix (the schema's Matrix). */
export interface Affine {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export const IDENTITY: Affine = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

export function multiply(a: Affine, b: Affine): Affine {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

/** The page-space bounding box of a `size` box under `m`. */
export function boundsOf(m: Affine, size: { x: number; y: number }): Box {
  const pts = [
    [0, 0],
    [size.x, 0],
    [0, size.y],
    [size.x, size.y],
  ].map(([x, y]) => [m.m00 * x + m.m01 * y + m.m02, m.m10 * x + m.m11 * y + m.m12]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
