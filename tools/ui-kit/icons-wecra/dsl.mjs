// Wecra's icon drawing kit: a few primitives (lines, polylines with rounded corners, rounded rectangles, circles,
// ellipses, arcs, capsules, stars) on our own grid, so every Wecra icon is built from its meaning — never from
// another set's path data. One weight (1 px, centred on half pixels for crisp edges), round ends and joins, corners
// rounded by a small radius (R = 1.5 for boxes, 0.75 for polygon corners): the house style.
//
// A primitive is a stroke (a centre line, drawn 1 px wide) or a fill (a closed area). A fill knows how to draw
// itself inset by i px — the Outline style draws each fill as its boundary 0.5 px in, so the outline keeps the
// fill's outer edge.

export const R = 1.5; // box corner radius
export const J = 0.75; // polygon corner radius
const f = (v) => +v.toFixed(3);
const pt = (x, y) => `${f(x)} ${f(y)}`;

// ---- path builders (strings) -----------------------------------------------------------------------------------------
export const line = (x1, y1, x2, y2) => `M${pt(x1, y1)}L${pt(x2, y2)}`;

/** A polyline through `pts`, each inner corner (and every corner when closed) rounded by r. */
export function poly(pts, { closed = false, r = 0 } = {}) {
  const n = pts.length;
  if (!r) return `M${pts.map(([x, y]) => pt(x, y)).join("L")}${closed ? "Z" : ""}`;
  const cut = (a, b, d) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.min(d, len / 2) / len;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  let s = "";
  const corners = closed ? pts.map((_, i) => i) : pts.map((_, i) => i).slice(1, -1);
  if (!closed) s = `M${pt(...pts[0])}`;
  corners.forEach((i, k) => {
    const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const a = cut(p, prev, r), b = cut(p, next, r);
    s += `${!closed || k ? "L" : "M"}${pt(...a)}Q${pt(...p)} ${pt(...b)}`;
  });
  return closed ? `${s}Z` : `${s}L${pt(...pts[n - 1])}`;
}

/** A rounded rectangle (r per corner allowed: [tl, tr, br, bl]). */
export function rect(x, y, w, h, r = R) {
  const [a, b, c, d] = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  const arc = (rr, ex, ey) => (rr ? `A${f(rr)} ${f(rr)} 0 0 1 ${pt(ex, ey)}` : `L${pt(ex, ey)}`);
  return `M${pt(x + a, y)}H${f(x + w - b)}${arc(b, x + w, y + b)}V${f(y + h - c)}${arc(c, x + w - c, y + h)}H${f(x + d)}${arc(d, x, y + h - d)}V${f(y + a)}${arc(a, x + a, y)}Z`;
}
export const circle = (cx, cy, r) => `M${pt(cx - r, cy)}A${f(r)} ${f(r)} 0 1 1 ${pt(cx + r, cy)}A${f(r)} ${f(r)} 0 1 1 ${pt(cx - r, cy)}Z`;
export const ellipse = (cx, cy, rx, ry) => `M${pt(cx - rx, cy)}A${f(rx)} ${f(ry)} 0 1 1 ${pt(cx + rx, cy)}A${f(rx)} ${f(ry)} 0 1 1 ${pt(cx - rx, cy)}Z`;
/** An arc of the circle (cx, cy, r) from angle a0 to a1 (degrees, 0 = right, clockwise on screen). */
export function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${pt(...p(a0))}A${f(r)} ${f(r)} 0 ${large} ${a1 > a0 ? 1 : 0} ${pt(...p(a1))}`;
}
/** The points of a rectangle centred on (cx, cy), turned by `deg`. */
export function box(cx, cy, w, h, deg = 0) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}
/** A capsule (a bar with round ends) from (x1, y1) to (x2, y2), w wide. */
export function capsule(x1, y1, x2, y2, w) {
  const len = Math.hypot(x2 - x1, y2 - y1), nx = (-(y2 - y1) / len) * (w / 2), ny = ((x2 - x1) / len) * (w / 2), r = w / 2;
  return `M${pt(x1 + nx, y1 + ny)}L${pt(x2 + nx, y2 + ny)}A${f(r)} ${f(r)} 0 0 0 ${pt(x2 - nx, y2 - ny)}L${pt(x1 - nx, y1 - ny)}A${f(r)} ${f(r)} 0 0 0 ${pt(x1 + nx, y1 + ny)}Z`;
}
/** A star's points: n tips at radius ro, valleys at ri, the first tip straight up. */
export const starPts = (cx, cy, n, ro, ri) => Array.from({ length: n * 2 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / n, rr = k % 2 ? ri : ro;
  return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
});
/** A four-pointed sparkle: tips at r, sides drawn in towards the centre (k: how far, 0–1). */
export function sparkle(cx, cy, r, k = 0.16) {
  const c = r * k;
  return `M${pt(cx, cy - r)}Q${pt(cx + c, cy - c)} ${pt(cx + r, cy)}Q${pt(cx + c, cy + c)} ${pt(cx, cy + r)}Q${pt(cx - c, cy + c)} ${pt(cx - r, cy)}Q${pt(cx - c, cy - c)} ${pt(cx, cy - r)}Z`;
}
/** Dashed outline of a rounded box: corner pieces (arm `a`) and one dash centred on each side. */
export function dashedBox(x, y, w, h, { r = R, a = 2.25, dash = 2 } = {}) {
  const out = [
    `M${pt(x, y + a)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${pt(x + r, y)}H${f(x + a)}`,
    `M${pt(x + w - a, y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${pt(x + w, y + r)}V${f(y + a)}`,
    `M${pt(x + w, y + h - a)}V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${pt(x + w - r, y + h)}H${f(x + w - a)}`,
    `M${pt(x + a, y + h)}H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${pt(x, y + h - r)}V${f(y + h - a)}`,
  ];
  const mx = x + w / 2, my = y + h / 2;
  out.push(line(mx - dash / 2, y, mx + dash / 2, y), line(mx - dash / 2, y + h, mx + dash / 2, y + h), line(x, my - dash / 2, x, my + dash / 2), line(x + w, my - dash / 2, x + w, my + dash / 2));
  return out.join("");
}

// ---- primitives (what an icon is made of) -----------------------------------------------------------------------------
/** A stroke; `tone` < 1 draws it in the set's secondary tone. */
export const S = (d, tone = 1) => ({ kind: "stroke", d, tone });
/** A fill drawn by `make(inset)`. */
export const F = (make, tone = 1) => ({ kind: "fill", make, tone });
export const fillRect = (x, y, w, h, r = R, tone = 1) => F((i) => rect(x + i, y + i, w - 2 * i, h - 2 * i, Math.max(0, (Array.isArray(r) ? r[0] : r) - i)), tone);
/** A dot; one too small to have an inside (r ≤ 0.8) stays a dot in the Outline style. */
export const dot = (cx, cy, r, tone = 1) => ({ ...F((i) => circle(cx, cy, Math.max(0.35, r - i)), tone), solid: r <= 0.8 });
/** A filled polygon (rounded corners); its inset draws it shrunk towards its centre. */
export function fillPoly(pts, r = J, tone = 1) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const inr = Math.min(...pts.map((p, k) => {
    const q = pts[(k + 1) % pts.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return Math.abs((q[0] - p[0]) * (p[1] - cy) - (q[1] - p[1]) * (p[0] - cx)) / len;
  }));
  return F((i) => {
    const s = Math.max(0.2, 1 - i / Math.max(inr, 0.5));
    return poly(pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]), { closed: true, r: Math.max(0, r - i) });
  }, tone);
}
