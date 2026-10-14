// The geometry of motion: the curved path a cursor takes, the cadence of typing, and the smoothing that keeps the
// visitor's own cursor attached to the pointer. Pure, unit tested (path.test.ts).

export type Point = readonly [number, number];

/**
 * A point on a gentle arc from `a` to `b` (a quadratic Bézier whose control point sits off the straight line by
 * `bend` × the distance, to the left of travel when positive), at `u` in 0…1. A hand moves this way: never on rails.
 */
export function arcPoint(a: Point, b: Point, bend: number, u: number): [number, number] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // The normal of travel (dy, −dx) has the travel's length, so `bend` scales with the distance
  const cx = mx + dy * bend;
  const cy = my - dx * bend;
  const v = 1 - u;
  return [v * v * a[0] + 2 * v * u * cx + u * u * b[0], v * v * a[1] + 2 * v * u * cy + u * u * b[1]];
}

/** Any curve `f` (u in 0…1 → a point) as `n + 1` points spaced evenly along its length. */
export function evenPoints(f: (u: number) => Point, n = 24): [number, number][] {
  const fine = n * 8;
  const pts: [number, number][] = [];
  const lens = [0];
  for (let i = 0; i <= fine; i++) {
    const p = f(i / fine);
    pts.push([p[0], p[1]]);
    if (i) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = lens[fine];
  const a = pts[0];
  const b = pts[fine];
  if (total === 0) return Array.from({ length: n + 1 }, () => [a[0], a[1]]);
  const out: [number, number][] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const want = (total * i) / n;
    while (j < fine - 1 && lens[j + 1] < want) j++;
    const seg = lens[j + 1] - lens[j] || 1;
    const k = Math.min(1, Math.max(0, (want - lens[j]) / seg));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * k, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * k]);
  }
  out[0] = [a[0], a[1]];
  out[n] = [b[0], b[1]];
  return out;
}

/**
 * The arc as `n + 1` points, spaced evenly along its length (so a time curve applied over them is the motion's own
 * acceleration, not the curve's parameterisation).
 */
export function arcPoints(a: Point, b: Point, bend: number, n = 24): [number, number][] {
  return evenPoints((u) => arcPoint(a, b, bend, u), n);
}

/** A cubic Bézier (an SVG `C`) at `u`. */
export function cubicPoint(p0: Point, c1: Point, c2: Point, p3: Point, u: number): [number, number] {
  const v = 1 - u;
  const k0 = v * v * v;
  const k1 = 3 * v * v * u;
  const k2 = 3 * v * u * u;
  const k3 = u * u * u;
  return [k0 * p0[0] + k1 * c1[0] + k2 * c2[0] + k3 * p3[0], k0 * p0[1] + k1 * c1[1] + k2 * c2[1] + k3 * p3[1]];
}

/** Which way a move should bow: alternate by direction so consecutive moves don't all curve the same way. */
export function bendFor(a: Point, b: Point, amount = 0.12): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // Mostly horizontal moves bow up, mostly vertical ones bow outward (right): like a wrist pivoting
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? amount : -amount) : dy >= 0 ? -amount : amount;
}

/** A small seeded random (mulberry32): the same text always types with the same rhythm. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pause before each character of `text`, ms: 25…70 with a person's unevenness, a little longer after a space and
 * longer still after punctuation (the hand catching up with the thought).
 */
export function typingDelays(text: string, seed = 7): number[] {
  const r = seeded(seed + text.length * 31);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const prev = text[i - 1];
    let ms = 25 + r() * 33; // 25…58
    if (prev === " ") ms += 8 + r() * 4; // …70
    if (prev && ",.!?;:—".includes(prev)) ms += 70 + r() * 60; // a real pause, outside the per-key range
    if (i === 0) ms = 45;
    out.push(Math.round(ms));
  }
  return out;
}

/**
 * One frame of a pointer follower: moves `from` toward `to` by `alpha` per 60 Hz frame, made independent of the
 * frame rate (`dt` ms since the last frame), and snaps when within half a pixel.
 */
export function follow(from: Point, to: Point, alpha: number, dt: number): [number, number] {
  const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, alpha)), Math.max(0, dt) / (1000 / 60));
  const x = from[0] + (to[0] - from[0]) * k;
  const y = from[1] + (to[1] - from[1]) * k;
  return Math.abs(to[0] - x) < 0.5 && Math.abs(to[1] - y) < 0.5 ? [to[0], to[1]] : [x, y];
}
