/**
 * Path geometry for pasted vectors (docs/desktop.md §13): SVG path data parsed into subpaths of cubic segments
 * (lines, quadratics and arcs converted), affine matrices, and tight bounds. Pure.
 */

export interface Pt {
  x: number;
  y: number;
}
/** A segment to `p`; a straight line when it has no control points. */
export interface Seg {
  c1?: Pt;
  c2?: Pt;
  p: Pt;
}
export interface Subpath {
  start: Pt;
  segs: Seg[];
  closed: boolean;
}
/** [a, b, c, d, e, f] as SVG's matrix(): x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m × n: n applied first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export const apply = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (x: number, y = x): Mat => [x, 0, 0, y, 0, 0];
/** How much a matrix scales lengths (a stroke width's factor). */
export const meanScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function transformSubpaths(paths: Subpath[], m: Mat): Subpath[] {
  return paths.map((sp) => ({ start: apply(m, sp.start), closed: sp.closed, segs: sp.segs.map((s) => ({ p: apply(m, s.p), ...(s.c1 && s.c2 ? { c1: apply(m, s.c1), c2: apply(m, s.c2) } : {}) })) }));
}

/** An SVG `transform` attribute (or CSS transform list) as a matrix. */
export function parseTransform(text: string | undefined): Mat {
  let m = IDENTITY;
  if (!text) return m;
  for (const t of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = numbers(t[2]);
    let n: Mat = IDENTITY;
    switch (t[1]) {
      case "matrix":
        if (v.length >= 6) n = [v[0], v[1], v[2], v[3], v[4], v[5]];
        break;
      case "translate":
        n = translate(v[0] ?? 0, v[1] ?? 0);
        break;
      case "scale":
        n = scale(v[0] ?? 1, v[1] ?? v[0] ?? 1);
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Mat = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        n = v.length >= 3 ? mul(translate(v[1], v[2]), mul(r, translate(-v[1], -v[2]))) : r;
        break;
      }
      case "skewX":
        n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Every number in a list (commas or spaces; "1.5.5" is 1.5 and .5; "1e-3" one number). */
export function numbers(text: string): number[] {
  return [...text.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].map((m) => Number(m[0]));
}

/** SVG path data as subpaths of cubics (an arc's flags may be written without separators: "a1 1 0 01 2 2"). */
export function parsePathData(d: string): Subpath[] {
  const out: Subpath[] = [];
  const tokens = pathTokens(d);
  let i = 0;
  let cur: Subpath | null = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: Pt | null = null; // the previous cubic's second control point (S)
  let lastQ: Pt | null = null; // the previous quadratic's control point (T)
  let cmd = "";
  const num = () => (typeof tokens[i] === "number" ? (tokens[i++] as number) : NaN);
  // An arc flag: the next number's first digit when flags are written together ("01").
  const flag = (): number => {
    const t = tokens[i];
    if (typeof t !== "number") return NaN;
    i++;
    return t === 0 || t === 1 ? t : NaN;
  };
  const ensure = () => {
    if (!cur) {
      cur = { start: { x, y }, segs: [], closed: false };
      out.push(cur);
    }
    return cur;
  };
  const line = (nx: number, ny: number) => {
    ensure().segs.push({ p: { x: nx, y: ny } });
    x = nx;
    y = ny;
  };
  const cubic = (c1: Pt, c2: Pt, p: Pt) => {
    ensure().segs.push({ c1, c2, p });
    x = p.x;
    y = p.y;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === "string") {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        if (cur) {
          (cur as Subpath).closed = true;
          x = sx;
          y = sy;
        }
        cur = null;
        lastC = lastQ = null;
        continue;
      }
    } else if (!cmd || cmd === "Z" || cmd === "z") {
      i++; // a stray number
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    const before = i;
    switch (cmd.toUpperCase()) {
      case "M": {
        const nx = num() + ox, ny = num() + oy;
        if (Number.isNaN(nx) || Number.isNaN(ny)) break;
        cur = { start: { x: nx, y: ny }, segs: [], closed: false };
        out.push(cur);
        x = sx = nx;
        y = sy = ny;
        cmd = rel ? "l" : "L"; // further pairs are lines
        lastC = lastQ = null;
        break;
      }
      case "L": {
        const nx = num() + ox, ny = num() + oy;
        if (!Number.isNaN(nx) && !Number.isNaN(ny)) line(nx, ny);
        lastC = lastQ = null;
        break;
      }
      case "H": {
        const nx = num() + ox;
        if (!Number.isNaN(nx)) line(nx, y);
        lastC = lastQ = null;
        break;
      }
      case "V": {
        const ny = num() + oy;
        if (!Number.isNaN(ny)) line(x, ny);
        lastC = lastQ = null;
        break;
      }
      case "C": {
        const v = [num(), num(), num(), num(), num(), num()];
        if (v.some(Number.isNaN)) break;
        const c2 = { x: v[2] + ox, y: v[3] + oy };
        cubic({ x: v[0] + ox, y: v[1] + oy }, c2, { x: v[4] + ox, y: v[5] + oy });
        lastC = c2;
        lastQ = null;
        break;
      }
      case "S": {
        const v = [num(), num(), num(), num()];
        if (v.some(Number.isNaN)) break;
        const c1 = lastC ? { x: 2 * x - lastC.x, y: 2 * y - lastC.y } : { x, y };
        const c2 = { x: v[0] + ox, y: v[1] + oy };
        cubic(c1, c2, { x: v[2] + ox, y: v[3] + oy });
        lastC = c2;
        lastQ = null;
        break;
      }
      case "Q": {
        const v = [num(), num(), num(), num()];
        if (v.some(Number.isNaN)) break;
        const q = { x: v[0] + ox, y: v[1] + oy };
        quad(q, { x: v[2] + ox, y: v[3] + oy });
        lastQ = q;
        lastC = null;
        break;
      }
      case "T": {
        const v = [num(), num()];
        if (v.some(Number.isNaN)) break;
        const q: Pt = lastQ ? { x: 2 * x - lastQ.x, y: 2 * y - lastQ.y } : { x, y };
        quad(q, { x: v[0] + ox, y: v[1] + oy });
        lastQ = q;
        lastC = null;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), ex = num() + ox, ey = num() + oy;
        if ([rx, ry, rot, large, sweep, ex, ey].some(Number.isNaN)) break;
        for (const s of arcToCubics(x, y, rx, ry, rot, !!large, !!sweep, ex, ey)) cubic(s.c1!, s.c2!, s.p);
        if (!arcHasCurve(x, y, rx, ry, ex, ey)) line(ex, ey);
        lastC = lastQ = null;
        break;
      }
    }
    if (i === before) i++; // malformed: skip a token
  }
  return out.filter((sp) => sp.segs.length > 0 || sp.closed);

  function quad(q: Pt, p: Pt) {
    cubic({ x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
  }
}

/** Path data's commands and numbers; an arc's two flags are read one character each ("01" is 0 then 1). */
function pathTokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const num = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let arcArg = -1; // the index of the next argument of an arc, else -1
  let i = 0;
  while (i < d.length) {
    const c = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      out.push(c);
      arcArg = c === "A" || c === "a" ? 0 : -1;
      i++;
      continue;
    }
    if (c === "," || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (arcArg >= 0 && (arcArg % 7 === 3 || arcArg % 7 === 4) && (c === "0" || c === "1")) {
      out.push(c === "1" ? 1 : 0);
      arcArg++;
      i++;
      continue;
    }
    num.lastIndex = i;
    const m = num.exec(d);
    if (!m) {
      i++;
      continue;
    }
    out.push(Number(m[0]));
    if (arcArg >= 0) arcArg++;
    i += m[0].length;
  }
  return out;
}

const arcHasCurve =(x1: number, y1: number, rx: number, ry: number, x2: number, y2: number) => !(rx === 0 || ry === 0 || (x1 === x2 && y1 === y2));

/** An SVG elliptical arc as cubics (SVG 1.1 implementation notes F.6). Empty when the arc is a line or nothing. */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if (!arcHasCurve(x1, y1, rx, ry, x2, y2)) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const deriv = (t: number) => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  const segs: Seg[] = [];
  for (let s = 0; s < n; s++) {
    const a = t1 + s * step, b = a + step;
    const p0 = point(a), p3 = s === n - 1 ? { x: x2, y: y2 } : point(b);
    const d0 = deriv(a), d3 = deriv(b);
    segs.push({ c1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y }, c2: { x: p3.x - k * d3.x, y: p3.y - k * d3.y }, p: p3 });
  }
  return segs;
}

/** An ellipse as four cubics, starting at its rightmost point, clockwise on screen (y down). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const k = 0.5522847498307936;
  const kx = rx * k, ky = ry * k;
  return {
    start: { x: cx + rx, y: cy },
    closed: true,
    segs: [
      { c1: { x: cx + rx, y: cy + ky }, c2: { x: cx + kx, y: cy + ry }, p: { x: cx, y: cy + ry } },
      { c1: { x: cx - kx, y: cy + ry }, c2: { x: cx - rx, y: cy + ky }, p: { x: cx - rx, y: cy } },
      { c1: { x: cx - rx, y: cy - ky }, c2: { x: cx - kx, y: cy - ry }, p: { x: cx, y: cy - ry } },
      { c1: { x: cx + kx, y: cy - ry }, c2: { x: cx + rx, y: cy - ky }, p: { x: cx + rx, y: cy } },
    ],
  };
}

/** A rectangle, rounded by rx / ry (already clamped to half its sides), clockwise from its top-left. */
export function rectPath(x: number, y: number, w: number, h: number, rx = 0, ry = 0): Subpath {
  if (rx <= 0 || ry <= 0) return { start: { x, y }, closed: true, segs: [{ p: { x: x + w, y } }, { p: { x: x + w, y: y + h } }, { p: { x, y: y + h } }, { p: { x, y } }] };
  const k = 1 - 0.5522847498307936;
  const r = x + w, b = y + h;
  return {
    start: { x: x + rx, y },
    closed: true,
    segs: [
      { p: { x: r - rx, y } },
      { c1: { x: r - rx * k, y }, c2: { x: r, y: y + ry * k }, p: { x: r, y: y + ry } },
      { p: { x: r, y: b - ry } },
      { c1: { x: r, y: b - ry * k }, c2: { x: r - rx * k, y: b }, p: { x: r - rx, y: b } },
      { p: { x: x + rx, y: b } },
      { c1: { x: x + rx * k, y: b }, c2: { x, y: b - ry * k }, p: { x, y: b - ry } },
      { p: { x, y: y + ry } },
      { c1: { x, y: y + ry * k }, c2: { x: x + rx * k, y }, p: { x: x + rx, y } },
    ],
  };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tight bounds of the curves (not their control points), or null for no points. */
export function bounds(paths: Subpath[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const sp of paths) {
    let from = sp.start;
    add(from);
    for (const s of sp.segs) {
      add(s.p);
      if (s.c1 && s.c2) for (const t of cubicExtrema(from, s.c1, s.c2, s.p)) add(cubicAt(from, s.c1, s.c2, s.p, t));
      from = s.p;
    }
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function cubicExtrema(p0: Pt, p1: Pt, p2: Pt, p3: Pt): number[] {
  const ts: number[] = [];
  for (const k of ["x", "y"] as const) {
    // B'(t) / 3 = a t² + b t + c
    const a = -p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k];
    const b = 2 * (p0[k] - 2 * p1[k] + p2[k]);
    const c = p1[k] - p0[k];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-c / b);
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const r = Math.sqrt(disc);
    ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
  }
  return ts.filter((t) => t > 0 && t < 1);
}

/** Subpaths back to SVG path data (absolute). */
export function toPathData(paths: Subpath[], fmt: (n: number) => string = (n) => String(Math.round(n * 1000) / 1000)): string {
  let d = "";
  for (const sp of paths) {
    d += `M${fmt(sp.start.x)} ${fmt(sp.start.y)}`;
    for (const s of sp.segs) d += s.c1 && s.c2 ? `C${fmt(s.c1.x)} ${fmt(s.c1.y)} ${fmt(s.c2.x)} ${fmt(s.c2.y)} ${fmt(s.p.x)} ${fmt(s.p.y)}` : `L${fmt(s.p.x)} ${fmt(s.p.y)}`;
    if (sp.closed) d += "Z";
  }
  return d;
}
