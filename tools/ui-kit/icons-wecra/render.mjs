// The icon sets as SVG, in the light shape the file's icon components use: one vector per kind and tone —
// "Stroke" (the 1-px lines), "Stroke 2" (lines in the secondary tone), "Fill", "Fill 2" — each painted black here
// and bound to icon/icon in the file.
//   wecraSvg(name, style)  — our drawing (icons.mjs); style "default" or "outline" (every fill drawn as its edge)
//   figmaOutlineSvg(name)  — the chrome's own glyph with its solid areas drawn as their edge (the Figma set's
//                            Outline variant; its line work is already outlines and stays as it is)
import { WECRA } from "./icons.mjs";

const { ICONS } = await import("../../../src/renderer/src/ds/icons/registry.ts");

/** The vectors of an icon: [{name, d, stroke: bool, opacity}] in the file's order. */
export function wecraVectors(name, style = "default") {
  const [, ...prims] = WECRA[name];
  const groups = new Map();
  const add = (kind, tone, d) => {
    const k = `${kind}|${tone}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  };
  for (const p of prims) {
    if (p.kind === "stroke") add("stroke", p.tone, p.d);
    else if (style === "outline" && !p.solid) add("stroke", p.tone, p.make(0.5));
    else add("fill", p.tone, p.make(0));
  }
  const out = [];
  for (const kind of ["stroke", "fill"]) {
    const tones = [...groups.keys()].filter((k) => k.startsWith(kind)).map((k) => Number(k.split("|")[1])).sort((a, b) => b - a);
    tones.forEach((tone) => out.push({ name: `${kind === "stroke" ? "Stroke" : "Fill"}${tone < 1 ? " 2" : ""}`, d: groups.get(`${kind}|${tone}`).join(""), stroke: kind === "stroke", opacity: tone }));
  }
  return out;
}

const svgOf = (box, vectors, { bounds = false, view = `0 0 ${box} ${box}` } = {}) => {
  const [vx, vy, vw] = view.split(" ").map(Number);
  const rect = bounds ? `<rect x="${vx}" y="${vy}" width="${vw}" height="${vw}" fill="#000" fill-opacity="0"/>` : "";
  const els = vectors.map((v) =>
    v.stroke
      ? `<path d="${v.d}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"${v.opacity < 1 ? ` stroke-opacity="${v.opacity}"` : ""}/>`
      : `<path d="${v.d}" fill="#000"${v.evenodd ? ' fill-rule="evenodd"' : ""}${v.opacity < 1 ? ` fill-opacity="${v.opacity}"` : ""}/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${view}">${rect}${els.join("")}</svg>\n`;
};
export const wecraSvg = (name, style = "default", opts = {}) => svgOf(WECRA[name][0], wecraVectors(name, style), opts);

// ---- the Figma set's Outline ------------------------------------------------------------------------------------------
/** A path's subpaths flattened to polygons (absolute M L H V C S Q A Z and their relative forms). */
export function flatten(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0, lc = null;
  const num = () => Number(toks[i++]);
  const push = (px, py) => cur.push([px, py]);
  const cubic = (x1, y1, x2, y2, ex, ey) => {
    for (let t = 1; t <= 8; t++) {
      const u = t / 8, m = 1 - u;
      push(m * m * m * x + 3 * m * m * u * x1 + 3 * m * u * u * x2 + u * u * u * ex, m * m * m * y + 3 * m * m * u * y1 + 3 * m * u * u * y2 + u * u * u * ey);
    }
  };
  const arcTo = (rx, ry, rot, large, sweep, ex, ey) => {
    // endpoint → centre (SVG implementation notes F.6.5)
    const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2, x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) {
      rx *= Math.sqrt(lam);
      ry *= Math.sqrt(lam);
    }
    const sgn = large === sweep ? -1 : 1;
    const co = sgn * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
    const cx = cp * cxp - sp * cyp + (x + ex) / 2, cy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    for (let k = 1; k <= 12; k++) {
      const t = t0 + (dt * k) / 12;
      push(cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp);
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "M") {
      x = ox + num();
      y = oy + num();
      cur = [[x, y]];
      subs.push(cur);
      sx = x;
      sy = y;
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      x = ox + num();
      y = oy + num();
      push(x, y);
    } else if (C === "H") {
      x = ox + num();
      push(x, y);
    } else if (C === "V") {
      y = oy + num();
      push(x, y);
    } else if (C === "C") {
      const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
      cubic(...a);
      lc = [a[2], a[3]];
      x = a[4];
      y = a[5];
      continue;
    } else if (C === "S") {
      const r1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
      const a = [ox + num(), oy + num(), ox + num(), oy + num()];
      cubic(r1[0], r1[1], ...a);
      lc = [a[0], a[1]];
      x = a[2];
      y = a[3];
      continue;
    } else if (C === "Q") {
      const a = [ox + num(), oy + num(), ox + num(), oy + num()];
      cubic(x + (2 / 3) * (a[0] - x), y + (2 / 3) * (a[1] - y), a[2] + (2 / 3) * (a[0] - a[2]), a[3] + (2 / 3) * (a[1] - a[3]), a[2], a[3]);
      x = a[2];
      y = a[3];
    } else if (C === "A") {
      const a = [num(), num(), num(), num(), num(), ox + num(), oy + num()];
      arcTo(...a);
      x = a[5];
      y = a[6];
    } else if (C === "Z") {
      x = sx;
      y = sy;
      cur.closed = true;
    }
    lc = null;
  }
  return subs;
}
const area = (p) => p.reduce((s, a, k) => s + (a[0] * p[(k + 1) % p.length][1] - p[(k + 1) % p.length][0] * a[1]), 0) / 2;
const perim = (p) => p.reduce((s, a, k) => s + Math.hypot(p[(k + 1) % p.length][0] - a[0], p[(k + 1) % p.length][1] - a[1]), 0);
const inside = ([px, py], poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Splits a filled path into regions (an outer contour with its holes) and says which are solid (wider than a line). */
export function regions(d) {
  const raw = d.match(/[Mm][^Mm]*/g) ?? [];
  const subs = raw.map((s) => ({ d: s, pts: flatten(s)[0] ?? [] })).filter((s) => s.pts.length > 2);
  for (const s of subs) s.depth = subs.filter((o) => o !== s && inside(s.pts[0], o.pts)).length;
  const outers = subs.filter((s) => s.depth % 2 === 0);
  return outers.map((o) => {
    const holes = subs.filter((h) => h.depth === o.depth + 1 && inside(h.pts[0], o.pts));
    const a = Math.abs(area(o.pts)) - holes.reduce((s, h) => s + Math.abs(area(h.pts)), 0);
    const p = perim(o.pts) + holes.reduce((s, h) => s + perim(h.pts), 0);
    return { d: [o.d, ...holes.map((h) => h.d)].join(""), thickness: (2 * a) / p };
  });
}
/** The Figma glyph's light vectors with its solid areas as 1-px edges (line work stays filled as drawn). */
export function figmaOutlineVectors(name) {
  const [, mode, ...paths] = ICONS[name];
  const out = { strokes: [], strokes2: [], fills: new Map() };
  if (typeof mode === "string") {
    for (const p of paths) (p.startsWith("f|") ? out.strokes : out.strokes).push(p.startsWith("f|") ? p.slice(2) : p);
  } else {
    for (const p of paths) {
      const at = p.indexOf("|");
      const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
      const d = at > 0 ? p.slice(at + 1) : p;
      for (const r of regions(d)) {
        if (r.thickness > 1.35) (tone >= 0.9 ? out.strokes : out.strokes2).push(r.d);
        else out.fills.set(tone, [...(out.fills.get(tone) ?? []), r.d]);
      }
    }
  }
  const vs = [];
  if (out.strokes.length) vs.push({ name: "Stroke", d: out.strokes.join(""), stroke: true, opacity: 1 });
  if (out.strokes2.length) vs.push({ name: "Stroke 2", d: out.strokes2.join(""), stroke: true, opacity: 0.33 });
  [...out.fills].sort((a, b) => b[0] - a[0]).forEach(([tone, ds], i) => vs.push({ name: i ? "Fill 2" : "Fill", d: ds.join(""), stroke: false, opacity: Number((tone / 0.9).toFixed(3)), evenodd: mode === 1 }));
  return vs;
}
export function figmaOutlineSvg(name, opts = {}) {
  const [box, mode] = ICONS[name];
  let view = `0 0 ${box} ${box}`;
  if (typeof mode === "string") {
    const inset = (box - Number(mode.slice(1))) / 2;
    view = `${-inset} ${-inset} ${box} ${box}`;
  }
  return svgOf(box, figmaOutlineVectors(name), { ...opts, view });
}
