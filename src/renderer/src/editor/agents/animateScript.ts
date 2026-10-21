/**
 * The `animate` tool's compiler (docs/research/motion-for-agents.md §3a, docs/motion.md §9.2): a GSAP-like timeline script
 * — tweens with targets, from / to / fromTo / keyframes, duration, ease, stagger, the position parameter ("<", ">",
 * "+=0.2", labels), repeat / yoyo, text split — turned into plain keyframe lists per layer and per logical channel (x, y,
 * rotate, opacity, fill …), which animateTool.ts writes as native manual keyframe tracks. Pure: the layers, their rest
 * values and their existing keys come from a host, so it is tested without the engine.
 *
 * Semantics, as GSAP's: a missing end is the channel's value at that time on the timeline being built (so a `from` tween
 * ends where the layer is, and a later tween continues where an earlier one ended); a tween's start key eases in with
 * Hold (its from-value appears at its start — GSAP's immediate render — and a first keyframe holds back to 0); its end key
 * carries the tween's ease; a later tween over the same channel replaces the earlier one's keys inside its span
 * (`overwrite: "auto"`). Eases a single curve can't hold are unrolled into exact keyframes (bounce, steps, elastic).
 */
import type { MotionEasing, RGBA } from "@shared/motion/types";

// ---- Values -------------------------------------------------------------------------------------------------------

export type Value = number | RGBA;

export interface Key {
  /** Seconds */
  t: number;
  v: Value;
  /** The easing into this key */
  ease: MotionEasing;
}

export class ScriptError extends Error {}
const fail = (message: string): never => {
  throw new ScriptError(message);
};

const isColor = (v: Value): v is RGBA => typeof v === "object";
const lerp = (a: Value, b: Value, e: number): Value => {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * e;
  if (isColor(a) && isColor(b)) return { r: a.r + (b.r - a.r) * e, g: a.g + (b.g - a.g) * e, b: a.b + (b.b - a.b) * e, a: a.a + (b.a - a.a) * e };
  return e < 1 ? a : b;
};
const same = (a: Value, b: Value) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : isColor(a) && isColor(b) ? Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a) < 1e-9 : false);

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** A colour: "#rgb", "#rrggbb", "#rrggbbaa", "rgb(…)", "rgba(…)" or {r, g, b, a?} in 0–1. */
export function parseColor(v: unknown, at: string): RGBA {
  if (v && typeof v === "object") {
    const c = v as Record<string, unknown>;
    if ([c.r, c.g, c.b].every((x) => typeof x === "number" && Number.isFinite(x))) return { r: c.r as number, g: c.g as number, b: c.b as number, a: typeof c.a === "number" ? c.a : 1 };
  }
  if (typeof v === "string") {
    const s = v.trim();
    const h = HEX.exec(s);
    if (h) {
      let x = h[1];
      if (x.length <= 4) x = [...x].map((ch) => ch + ch).join("");
      const n = (i: number) => parseInt(x.slice(i, i + 2), 16) / 255;
      return { r: n(0), g: n(2), b: n(4), a: x.length === 8 ? n(6) : 1 };
    }
    const m = /^rgba?\(([^)]*)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((q) => (q.endsWith("%") ? (parseFloat(q) / 100) * 255 : parseFloat(q)));
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 && Number.isFinite(p[3]) ? (p[3] > 1 ? p[3] / 255 : p[3]) : 1 };
    }
  }
  return fail(`${at}: a colour — "#ff5500", "rgb(255, 85, 0)" or {r, g, b, a} in 0–1`);
}

// ---- Channels -----------------------------------------------------------------------------------------------------

/** The script's properties, in CSS / GSAP units (rotate clockwise +, degrees; colours; px; 0–1). */
export const CHANNELS = [
  "x", "y", "rotate", "scale", "scaleX", "scaleY", "skewX", "opacity", "width", "height", "cornerRadius", "strokeWeight", "fill", "stroke", "blur",
  "trimStart", "trimEnd", "arcStart", "arcEnd", "arcInnerRadius", "starInnerRadius", "pointCount", "gap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
] as const;
export type Channel = (typeof CHANNELS)[number];
const COLOR_CHANNELS: ReadonlySet<Channel> = new Set(["fill", "stroke"]);

const ALIASES: Record<string, Channel> = {
  translateX: "x", translateY: "y", rotation: "rotate", autoAlpha: "opacity", alpha: "opacity", borderRadius: "cornerRadius", radius: "cornerRadius",
  strokeWidth: "strokeWeight", backgroundColor: "fill", color: "fill", fillColor: "fill", borderColor: "stroke", strokeColor: "stroke", skew: "skewX",
  innerRadius: "arcInnerRadius", points: "pointCount", count: "pointCount", itemSpacing: "gap", starRatio: "starInnerRadius",
};

/** "0% 100%", "40%", 0.4, [0, 1], true → {start, end} (GSAP DrawSVG's forms). */
export function parseDraw(v: unknown, at: string): { start: number; end: number } {
  const pct = (s: string) => {
    const t = s.trim();
    const n = parseFloat(t);
    if (!Number.isFinite(n)) fail(`${at}: "0% 100%", "40%", a number 0–1 or [start, end]`);
    return t.endsWith("%") ? n / 100 : n;
  };
  if (v === true) return { start: 0, end: 1 };
  if (typeof v === "number") return { start: 0, end: v };
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")) return { start: v[0], end: v[1] };
  if (typeof v === "string") {
    const parts = v.trim().split(/\s+/);
    if (parts.length === 1) return { start: 0, end: pct(parts[0]) };
    if (parts.length === 2) return { start: pct(parts[0]), end: pct(parts[1]) };
  }
  return fail(`${at}: "0% 100%", "40%", a number 0–1 or [start, end]`);
}

/** A tween's property object → channel values (aliases, compound properties expanded). */
export function parseProps(raw: unknown, at: string): Map<Channel, Value> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${at}: an object of properties ({opacity: 0, y: 40 …})`);
  const out = new Map<Channel, Value>();
  const num = (v: unknown, k: string): number => {
    const n = typeof v === "string" && /^-?[\d.]+(px|deg)?$/.test(v.trim()) ? parseFloat(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) fail(`${at}.${k}: a number`);
    return n as number;
  };
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (["duration", "ease", "delay", "easing"].includes(key)) continue; // a keyframes step's own timing (read by the caller)
    if (key === "drawSVG" || key === "draw") {
      const d = parseDraw(v, `${at}.${key}`);
      out.set("trimStart", d.start);
      out.set("trimEnd", d.end);
      continue;
    }
    if (key === "padding") {
      for (const c of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) out.set(c, num(v, key));
      continue;
    }
    if (key === "paddingX" || key === "paddingY") {
      for (const c of key === "paddingX" ? (["paddingLeft", "paddingRight"] as const) : (["paddingTop", "paddingBottom"] as const)) out.set(c, num(v, key));
      continue;
    }
    const c = (ALIASES[key] ?? key) as Channel;
    if (!(CHANNELS as readonly string[]).includes(c)) fail(`${at}.${key}: not a property animate knows — ${[...CHANNELS, "drawSVG", "padding", "paddingX", "paddingY"].join(", ")} (and GSAP's aliases: rotation, autoAlpha, borderRadius, backgroundColor …)`);
    out.set(c, COLOR_CHANNELS.has(c) ? parseColor(v, `${at}.${key}`) : num(v, key));
  }
  return out;
}

// ---- Easing -------------------------------------------------------------------------------------------------------

type Bezier = [number, number, number, number];
/** An ease as a curve (one key) or unrolled points (several keys: bounce, steps, elastic) over p ∈ [0, 1]. */
export type EaseSpec = { kind: "easing"; easing: MotionEasing } | { kind: "points"; points: { p: number; f: number; ease: MotionEasing }[] };

const bez = (b: Bezier): MotionEasing => ({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] } });
const reverseBezier = (b: Bezier): Bezier => [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
const LINEAR: MotionEasing = { type: "LINEAR" };
const HOLD: MotionEasing = { type: "HOLD" };

// in / out / inOut. power1 and power2 are exact (t², t³ as cubic Béziers); the rest are the standard CSS fits.
const FAMILIES: Record<string, [Bezier, Bezier, Bezier]> = {
  power1: [[1 / 3, 0, 2 / 3, 1 / 3], [1 / 3, 2 / 3, 2 / 3, 1], [0.45, 0, 0.55, 1]],
  power2: [[1 / 3, 0, 2 / 3, 0], [1 / 3, 1, 2 / 3, 1], [0.65, 0, 0.35, 1]],
  power3: [[0.5, 0, 0.75, 0], [0.25, 1, 0.5, 1], [0.76, 0, 0.24, 1]],
  power4: [[0.64, 0, 0.78, 0], [0.22, 1, 0.36, 1], [0.83, 0, 0.17, 1]],
  sine: [[0.12, 0, 0.39, 0], [0.61, 1, 0.88, 1], [0.37, 0, 0.63, 1]],
  expo: [[0.7, 0, 0.84, 0], [0.16, 1, 0.3, 1], [0.87, 0, 0.13, 1]],
  circ: [[0.55, 0, 1, 0.45], [0, 0.55, 0.45, 1], [0.85, 0, 0.15, 1]],
};
const FAMILY_ALIAS: Record<string, string> = { quad: "power1", cubic: "power2", quart: "power3", quint: "power4", strong: "power4" };
const WECRA_EASINGS = ["HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "GENTLE", "QUICK", "BOUNCY", "SLOW"];
/** The named curves' Béziers (docs/motion.md §4.7), for values read between keys. */
const NAMED_BEZIER: Record<string, Bezier> = {
  EASE_IN: [0.42, 0, 1, 1], EASE_OUT: [0, 0, 0.58, 1], EASE_IN_AND_OUT: [0.42, 0, 0.58, 1], EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1], EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4], LINEAR: [0, 0, 1, 1],
};

const QUAD_IN: Bezier = [1 / 3, 0, 2 / 3, 1 / 3];
const QUAD_OUT: Bezier = [1 / 3, 2 / 3, 2 / 3, 1];
const SINE_IN_OUT: Bezier = [0.37, 0, 0.63, 1];
const SINE_OUT: Bezier = [0.61, 1, 0.88, 1];

/** Penner's bounce-out as exact parabolic arcs: falls are t², rises its mirror. */
function bounceOut(): { p: number; f: number; b: Bezier }[] {
  const k = 2.75;
  return [
    { p: 1 / k, f: 1, b: QUAD_IN }, { p: 1.5 / k, f: 0.75, b: QUAD_OUT }, { p: 2 / k, f: 1, b: QUAD_IN }, { p: 2.25 / k, f: 0.9375, b: QUAD_OUT },
    { p: 2.5 / k, f: 1, b: QUAD_IN }, { p: 2.625 / k, f: 0.984375, b: QUAD_OUT }, { p: 1, f: 1, b: QUAD_IN },
  ];
}

/** GSAP's elastic-out unrolled at its extrema (a half sine between them), down to 0.1 % of the change. */
function elasticOut(amplitude: number, period: number): { p: number; f: number; b: Bezier }[] {
  const a = Math.max(1, amplitude);
  const per = period > 0 ? period : 0.3;
  const shift = (per / (2 * Math.PI)) * Math.asin(1 / a);
  const f = (t: number) => a * Math.pow(2, -10 * t) * Math.sin(((t - shift) * 2 * Math.PI) / per) + 1;
  const out: { p: number; f: number; b: Bezier }[] = [];
  const N = 4000;
  let prev = f(0), cur = f(1 / N);
  for (let i = 1; i < N; i++) {
    const next = f((i + 1) / N);
    if ((cur - prev) * (next - cur) < 0) {
      if (Math.abs(cur - 1) < 0.001) break;
      out.push({ p: i / N, f: cur, b: out.length ? SINE_IN_OUT : SINE_OUT });
    }
    prev = cur;
    cur = next;
  }
  out.push({ p: 1, f: 1, b: out.length ? SINE_IN_OUT : SINE_OUT });
  return out;
}

/** Out-points mirrored to "in" (time reversed) or joined as "inOut" (in over the first half, out over the second). */
function shaped(outPts: { p: number; f: number; b: Bezier }[], dir: "in" | "out" | "inOut"): { p: number; f: number; ease: MotionEasing }[] {
  const all = [{ p: 0, f: 0, b: [0, 0, 1, 1] as Bezier }, ...outPts];
  const asIn = (): { p: number; f: number; b: Bezier }[] => {
    const res: { p: number; f: number; b: Bezier }[] = [];
    for (let j = 1; j < all.length; j++) {
      const src = all[all.length - 1 - j];
      res.push({ p: 1 - src.p, f: 1 - src.f, b: reverseBezier(all[all.length - j].b) });
    }
    return res;
  };
  let pts: { p: number; f: number; b: Bezier }[];
  if (dir === "out") pts = outPts;
  else if (dir === "in") pts = asIn();
  else pts = [...asIn().map((q) => ({ p: q.p / 2, f: q.f / 2, b: q.b })), ...outPts.map((q) => ({ p: 0.5 + q.p / 2, f: 0.5 + q.f / 2, b: q.b }))];
  return pts.map((q) => ({ p: q.p, f: q.f, ease: bez(q.b) }));
}

const springFromPhysics = (o: Record<string, unknown>): MotionEasing => {
  let bounce = typeof o.bounce === "number" ? o.bounce : undefined;
  if (bounce === undefined) {
    const k = typeof o.stiffness === "number" ? o.stiffness : 100;
    const c = typeof o.damping === "number" ? o.damping : 10;
    const m = typeof o.mass === "number" ? o.mass : 1;
    bounce = 1 - c / (2 * Math.sqrt(k * m));
  }
  return { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: Math.min(1, Math.max(0, bounce)) } };
};

const EASE_HELP =
  'ease: GSAP\'s ("power1…4", "sine", "expo", "circ", "back", "elastic", "bounce" with ".in" / ".out" / ".inOut", "back.out(1.7)", "steps(5)", "none"), CSS\'s ("ease-out", "cubic-bezier(0.2, 0.8, 0.2, 1)"), [x1, y1, x2, y2], a spring {type: "spring", stiffness, damping, mass} or {type: "spring", bounce}, or Wecra\'s (EASE_OUT, GENTLE, BOUNCY …)';

/** Any ease the script may name → a curve or unrolled points. */
export function parseEase(raw: unknown, at = "ease"): EaseSpec {
  if (Array.isArray(raw) && raw.length === 4 && raw.every((x) => typeof x === "number")) return { kind: "easing", easing: bez(raw as Bezier) };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.type === "spring") return { kind: "easing", easing: springFromPhysics(o) };
    if (typeof o.type === "string") return { kind: "easing", easing: o as unknown as MotionEasing }; // Wecra's public shape, checked when written
    return fail(`${at}: ${EASE_HELP}`);
  }
  if (typeof raw !== "string" || !raw.trim()) return fail(`${at}: ${EASE_HELP}`);
  const s = raw.trim();
  if (WECRA_EASINGS.includes(s.toUpperCase().replace(/-/g, "_")) && /^[A-Z_]+$/.test(s)) return { kind: "easing", easing: { type: s as MotionEasing["type"] } };
  const lower = s.toLowerCase().replace(/\s+/g, "");
  const css: Record<string, Bezier> = { ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1] };
  if (css[lower]) return { kind: "easing", easing: bez(css[lower]) };
  if (["none", "linear", "power0", "power0.in", "power0.out", "power0.inout"].includes(lower)) return { kind: "easing", easing: LINEAR };
  if (lower === "step-end" || lower === "hold") return { kind: "easing", easing: HOLD };
  const cb = /^cubic-bezier\(([^)]*)\)$/.exec(lower);
  if (cb) {
    const n = cb[1].split(",").map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) return { kind: "easing", easing: bez(n as Bezier) };
    return fail(`${at}: cubic-bezier(x1, y1, x2, y2)`);
  }
  const st = /^steps\((\d+)\)$/.exec(lower);
  if (st) {
    const n = Math.max(1, Math.min(240, parseInt(st[1], 10)));
    return { kind: "points", points: Array.from({ length: n }, (_, i) => ({ p: (i + 1) / n, f: (i + 1) / n, ease: HOLD })) };
  }
  const sp = /^spring(?:\(([\d.]+)\))?$/.exec(lower);
  if (sp) return { kind: "easing", easing: springFromPhysics({ bounce: sp[1] ? Number(sp[1]) : 0.3 }) };
  // GSAP: family[.in|.out|.inOut][(params)]; the legacy Power2.easeOut / easeInOut too.
  const g = /^([a-z]+[0-4]?)(?:\.(in|out|inout|easein|easeout|easeinout))?(?:\(([^)]*)\))?$/.exec(lower);
  if (!g) return fail(`${at}: "${s}" — ${EASE_HELP}`);
  const fam = FAMILY_ALIAS[g[1]] ?? g[1];
  const dirRaw = (g[2] ?? "out").replace("ease", "");
  const dir = dirRaw === "in" ? "in" : dirRaw === "inout" ? "inOut" : "out";
  const params = (g[3] ?? "").split(",").filter(Boolean).map(Number);
  const idx = dir === "in" ? 0 : dir === "out" ? 1 : 2;
  if (FAMILIES[fam]) return { kind: "easing", easing: bez(FAMILIES[fam][idx]) };
  if (fam === "back") {
    const k = (Number.isFinite(params[0]) ? params[0] : 1.70158) / 1.70158;
    const b: Bezier = dir === "in" ? [0.36, 0, 0.66, -0.56 * k] : dir === "out" ? [0.34, 1 + 0.56 * k, 0.64, 1] : [0.68, -0.6 * k, 0.32, 1 + 0.6 * k];
    return { kind: "easing", easing: bez(b) };
  }
  if (fam === "bounce") return { kind: "points", points: shaped(bounceOut(), dir) };
  if (fam === "elastic") return { kind: "points", points: shaped(elasticOut(Number.isFinite(params[0]) ? params[0] : 1, Number.isFinite(params[1]) ? params[1] : 0.3), dir) };
  return fail(`${at}: "${s}" — ${EASE_HELP}`);
}

/** The reverse of an ease, for a yoyo's way back (GSAP plays the tween backwards). */
export function mirrorEase(e: EaseSpec): EaseSpec {
  if (e.kind === "points") {
    const all = [{ p: 0, f: 0, ease: LINEAR }, ...e.points];
    const pts: { p: number; f: number; ease: MotionEasing }[] = [];
    for (let j = 1; j < all.length; j++) {
      const src = all[all.length - 1 - j];
      const into = all[all.length - j].ease;
      pts.push({ p: 1 - src.p, f: 1 - src.f, ease: mirrorEasing(into) });
    }
    return { kind: "points", points: pts };
  }
  return { kind: "easing", easing: mirrorEasing(e.easing) };
}

function mirrorEasing(m: MotionEasing): MotionEasing {
  if (m.type === "CUSTOM_CUBIC_BEZIER" && m.easingFunctionCubicBezier) {
    const b = m.easingFunctionCubicBezier;
    return bez(reverseBezier([b.x1, b.y1, b.x2, b.y2]));
  }
  const swap: Record<string, MotionEasing["type"]> = { EASE_IN: "EASE_OUT", EASE_OUT: "EASE_IN", EASE_IN_BACK: "EASE_OUT_BACK", EASE_OUT_BACK: "EASE_IN_BACK" };
  return swap[m.type] ? { type: swap[m.type] } : m;
}

/** A cubic Bézier's y at x (Newton, then bisection). */
export function bezierAt(b: Bezier, x: number): number {
  const [x1, y1, x2, y2] = b;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = (3 * ax * t + 2 * bx) * t + cx;
    const e = sx(t) - x;
    if (Math.abs(e) < 1e-7) break;
    if (Math.abs(d) < 1e-6) break;
    t -= e / d;
  }
  if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-5) {
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

/** An easing's progress at p (springs read as their normalised curve's line — only used between keys of overlapping tweens). */
function progress(e: MotionEasing, p: number): number {
  if (e.type === "HOLD") return p < 1 ? 0 : 1;
  if (e.type === "CUSTOM_CUBIC_BEZIER" && e.easingFunctionCubicBezier) {
    const b = e.easingFunctionCubicBezier;
    return bezierAt([b.x1, b.y1, b.x2, b.y2], p);
  }
  const b = NAMED_BEZIER[e.type];
  return b ? bezierAt(b, p) : p;
}

// ---- Keys on a channel ----------------------------------------------------------------------------------------------

/** The value of a channel's keys at time t (none: the rest value; before the first: the first's — Figma holds it back to 0). */
export function valueAt(keys: readonly Key[], t: number, rest: Value): Value {
  if (!keys.length) return rest;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      return lerp(a.v, b.v, progress(b.ease, (t - a.t) / (b.t - a.t || 1)));
    }
  }
  return keys[keys.length - 1].v;
}

/** Two keys closer than this are one position (the engine's µs rounding with room). */
const SAME_TIME = 5e-4;
/** A jump at a time that already has a key goes this much later (a key per µs position per track). */
export const JUMP = 1e-3;

function upsert(keys: Key[], k: Key): void {
  const i = keys.findIndex((x) => Math.abs(x.t - k.t) < SAME_TIME);
  if (i >= 0) keys[i] = k;
  else {
    keys.push(k);
    keys.sort((a, b) => a.t - b.t);
  }
}

/**
 * One segment a → b over [t0, t1] on a channel's keys: what lies inside the span goes (GSAP's overwrite "auto": with the
 * rest of a tween cut through), the start key holds into a, the end key (or the unrolled ones) carry the ease.
 */
export function writeSegment(keys: Key[], t0: number, t1: number, a: Value, b: Value, ease: EaseSpec): void {
  // A segment that ran through t0 and past t1 belonged to a tween this one cuts: its end goes too.
  const before = keys.filter((k) => k.t <= t0 + SAME_TIME);
  const after = keys.filter((k) => k.t > t1 + SAME_TIME);
  const inside = keys.some((k) => k.t > t0 + SAME_TIME && k.t <= t1 + SAME_TIME);
  if (!inside && before.length && after.length) after.shift();
  keys.splice(0, keys.length, ...before, ...after);
  let start = t0;
  const at = keys.find((k) => Math.abs(k.t - t0) < SAME_TIME);
  if (!at) upsert(keys, { t: t0, v: a, ease: HOLD });
  else if (!same(at.v, a)) {
    start = Math.min(t0 + JUMP, t1 - JUMP / 2);
    upsert(keys, { t: start, v: a, ease: HOLD });
  }
  if (ease.kind === "easing") upsert(keys, { t: t1, v: b, ease: ease.easing });
  else for (const q of ease.points) upsert(keys, { t: start + (t1 - start) * q.p, v: lerp(a, b, q.f), ease: q.ease });
}

// ---- The script -----------------------------------------------------------------------------------------------------

export type Split = "chars" | "words" | "lines";
export type StaggerFrom = "start" | "end" | "center" | "edges" | "random" | number;

export interface Host {
  /** Targets → layer ids in order (a missing match is a warning, not an error) */
  resolve(targets: unknown, at: string): { ids: string[]; warnings: string[] };
  /** A layer's value of a channel at rest (null: the layer can't take it — the caller warns) */
  rest(id: string, channel: Channel): Value | null;
  /** The keys the layer already has on a channel (mode "merge"), in channel units */
  existing?(id: string, channel: Channel): Key[];
  /** The number of elements a text splits into (null: not a text) */
  elements(id: string, split: Split): number | null;
}

export interface CompiledLayer {
  channels: Map<Channel, Key[]>;
  /** The transform origin set by the script, % of the size */
  origin?: { x: number; y: number };
  /** The text's own stagger (MOTION_SET_TEXT_STAGGER) */
  textStagger?: { grouping: "CHARACTER_NO_WHITESPACE" | "WORD" | "LINE"; delayMs: number; order: "LEFT_RIGHT" | "RIGHT_LEFT" | "CENTER_OUT" | "RANDOM" };
}

export interface CompiledTween {
  index: number;
  targets: string[];
  start: number;
  end: number;
  label?: string;
}

export interface Compiled {
  layers: Map<string, CompiledLayer>;
  tweens: CompiledTween[];
  labels: Record<string, number>;
  /** The end of the last tween (text elements' stagger included) */
  end: number;
  warnings: string[];
}

export interface ScriptOptions {
  /** The timeline's length when the script sets it (repeat: -1 runs to it) */
  timelineDuration?: number;
  /** Seconds every position is shifted by */
  offset?: number;
  merge?: boolean;
}

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** GSAP's position parameter → seconds. */
export function resolvePosition(pos: unknown, ctx: { prevStart: number; prevEnd: number; end: number; labels: Record<string, number> }, at: string): number {
  if (pos === undefined || pos === null || pos === "") return ctx.end;
  if (finiteNum(pos)) return pos;
  if (typeof pos !== "string") return fail(`${at}: a time (s), "<", ">", "<0.2", "+=0.3", "-=0.1", a label or "label+=0.2"`);
  const s = pos.trim();
  const rel = (rest: string, base: number) => {
    const r = rest.trim();
    if (!r) return base;
    const m = /^([+-]=)?\s*(-?[\d.]+)$/.exec(r);
    if (!m) return fail(`${at}: "${s}" — "<", ">", "<0.2", ">-0.1", "<+=0.2"`);
    const n = Number(m[2]);
    return m[1] === "-=" ? base - n : base + n;
  };
  if (s.startsWith("<")) return rel(s.slice(1), ctx.prevStart);
  if (s.startsWith(">")) return rel(s.slice(1), ctx.prevEnd);
  const r = /^([+-])=\s*([\d.]+)$/.exec(s);
  if (r) return ctx.end + (r[1] === "-" ? -1 : 1) * Number(r[2]);
  if (/^-?[\d.]+$/.test(s)) return Number(s);
  const l = /^([A-Za-z_][\w\- ]*?)\s*(?:([+-])=\s*([\d.]+))?$/.exec(s);
  if (!l) return fail(`${at}: "${s}" — a time, "<", ">", "+=0.3", a label or "label+=0.2"`);
  if (!(l[1] in ctx.labels)) ctx.labels[l[1]] = ctx.end; // GSAP: an unknown label is added at the end
  return ctx.labels[l[1]] + (l[2] ? (l[2] === "-" ? -1 : 1) * Number(l[3]) : 0);
}

/** Each of n targets' delay (GSAP's stagger: a number, or {each | amount, from}). */
export function staggerDelays(n: number, stagger: unknown, at: string): number[] {
  if (stagger === undefined || stagger === null || n <= 1) return Array(n).fill(0);
  let each = 0, amount: number | null = null, from: StaggerFrom = "start";
  if (finiteNum(stagger)) each = stagger;
  else if (typeof stagger === "object") {
    const o = stagger as Record<string, unknown>;
    if (finiteNum(o.each)) each = o.each;
    if (finiteNum(o.amount)) amount = o.amount;
    if (o.from !== undefined) from = o.from as StaggerFrom;
  } else fail(`${at}: seconds between targets, or {each | amount, from: "start" | "end" | "center" | "edges" | "random" | index}`);
  const mid = (n - 1) / 2;
  const dist = Array.from({ length: n }, (_, i) => {
    if (from === "end") return n - 1 - i;
    if (from === "center") return Math.abs(i - mid);
    if (from === "edges") return mid - Math.abs(i - mid);
    if (finiteNum(from)) return Math.abs(i - from);
    return i;
  });
  if (from === "random") {
    // A fixed shuffle (the same script gives the same timeline).
    const order = Array.from({ length: n }, (_, i) => i);
    let seed = 0x9e3779b9 ^ n;
    for (let i = n - 1; i > 0; i--) {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((idx, rank) => (dist[idx] = rank));
  } else if (!["start", "end", "center", "edges"].includes(from as string) && !finiteNum(from)) fail(`${at}.from: "start", "end", "center", "edges", "random" or an index`);
  const lo = Math.min(...dist);
  const d = dist.map((x) => x - lo);
  const max = Math.max(...d);
  if (amount !== null) each = max > 0 ? amount / max : 0;
  return d.map((x) => x * each);
}

const ORDER: Record<string, "LEFT_RIGHT" | "RIGHT_LEFT" | "CENTER_OUT" | "RANDOM"> = { start: "LEFT_RIGHT", end: "RIGHT_LEFT", center: "CENTER_OUT", edges: "CENTER_OUT", random: "RANDOM" };
const GROUPING = { chars: "CHARACTER_NO_WHITESPACE", words: "WORD", lines: "LINE" } as const;

/** The script's whole timeline, compiled. */
export function compileScript(script: { tweens?: unknown; defaults?: unknown }, host: Host, opts: ScriptOptions = {}): Compiled {
  const tweens = script.tweens;
  if (!Array.isArray(tweens) || !tweens.length) fail('tweens: a list — [{targets, from | to | fromTo | keyframes, duration, ease, stagger, position}, {label: "name"} …]');
  const defaults = (script.defaults && typeof script.defaults === "object" ? script.defaults : {}) as Record<string, unknown>;
  const offset = finiteNum(opts.offset) ? Math.max(0, opts.offset) : 0;
  const layers = new Map<string, CompiledLayer>();
  const out: CompiledTween[] = [];
  const warnings: string[] = [];
  const ctx = { prevStart: offset, prevEnd: offset, end: offset, labels: {} as Record<string, number> };
  const warned = new Set<string>();

  const layer = (id: string) => layers.get(id) ?? layers.set(id, { channels: new Map() }).get(id)!;
  const keysOf = (id: string, c: Channel): Key[] | null => {
    const L = layer(id);
    let k = L.channels.get(c);
    if (k) return k;
    if (host.rest(id, c) === null) {
      const w = `${id} can't animate ${c}`;
      if (!warned.has(w)) warnings.push(w);
      warned.add(w);
      return null;
    }
    k = opts.merge && host.existing ? host.existing(id, c).map((x) => ({ ...x })) : [];
    L.channels.set(c, k);
    return k;
  };

  (tweens as unknown[]).forEach((raw, index) => {
    const at = `tweens[${index}]`;
    if (!raw || typeof raw !== "object") fail(`${at}: a tween {targets, to | from | fromTo | keyframes …} or a label {label: "name"}`);
    const tw = raw as Record<string, unknown>;
    // A label entry: {label, position?}.
    if (typeof tw.label === "string" && tw.targets === undefined) {
      ctx.labels[tw.label] = Math.max(0, resolvePosition(tw.position, ctx, `${at}.position`) + (finiteNum(tw.position) ? offset : 0));
      return;
    }
    const { ids, warnings: w } = host.resolve(tw.targets, `${at}.targets`);
    warnings.push(...w);
    if (!ids.length) {
      warnings.push(`${at}: no layer matched its targets — skipped`);
      return;
    }
    const duration = finiteNum(tw.duration) ? tw.duration : finiteNum(defaults.duration) ? defaults.duration : 0.5;
    if (!(duration >= 0)) fail(`${at}.duration: seconds, 0 or more`);
    const ease = parseEase(tw.ease ?? defaults.ease ?? "power1.out", `${at}.ease`);
    const delay = finiteNum(tw.delay) ? tw.delay : finiteNum(defaults.delay) ? defaults.delay : 0;
    let pos = resolvePosition(tw.position, ctx, `${at}.position`);
    if (finiteNum(tw.position)) pos += offset;
    const start0 = pos + delay;
    if (start0 < 0) warnings.push(`${at}: starts before 0 s — moved to 0`);
    const start = Math.max(0, start0);
    if (typeof tw.label === "string") ctx.labels[tw.label] = start;
    const split = tw.split === undefined ? null : (String(tw.split) as Split);
    if (split && !(split in GROUPING)) fail(`${at}.split: "chars", "words" or "lines"`);
    const stagger = tw.stagger ?? defaults.stagger;
    const delays = split ? Array(ids.length).fill(0) : staggerDelays(ids.length, stagger, `${at}.stagger`);

    // The steps: one for from / to / fromTo, several for keyframes.
    type Step = { from: Map<Channel, Value> | null; to: Map<Channel, Value>; duration: number; ease: EaseSpec };
    const steps: Step[] = [];
    if (Array.isArray(tw.keyframes)) {
      if (tw.from || tw.to || tw.fromTo) fail(`${at}: keyframes, or from / to / fromTo — not both`);
      for (const [j, k] of (tw.keyframes as unknown[]).entries()) {
        const o = (k ?? {}) as Record<string, unknown>;
        steps.push({ from: null, to: parseProps(o, `${at}.keyframes[${j}]`), duration: finiteNum(o.duration) ? o.duration : duration / (tw.keyframes as unknown[]).length, ease: o.ease !== undefined ? parseEase(o.ease, `${at}.keyframes[${j}].ease`) : ease });
      }
    } else {
      let from: unknown = tw.from, to: unknown = tw.to;
      if (Array.isArray(tw.fromTo)) [from, to] = tw.fromTo;
      if (from === undefined && to === undefined) fail(`${at}: from, to, fromTo [from, to] or keyframes`);
      const f = from === undefined ? null : parseProps(from, `${at}.from`);
      const t = to === undefined ? new Map<Channel, Value>() : parseProps(to, `${at}.to`);
      steps.push({ from: f, to: t, duration, ease });
    }
    const channels = new Set<Channel>(steps.flatMap((s) => [...(s.from?.keys() ?? []), ...s.to.keys()]));
    if (!channels.size) fail(`${at}: no properties to animate`);
    if (tw.transformOrigin !== undefined) for (const id of ids) layer(id).origin = parseOrigin(tw.transformOrigin, `${at}.transformOrigin`);

    const repeatRaw = finiteNum(tw.repeat) ? Math.trunc(tw.repeat) : 0;
    const yoyo = tw.yoyo === true;
    const repeatDelay = finiteNum(tw.repeatDelay) ? Math.max(0, tw.repeatDelay) : 0;
    const cycle = steps.reduce((s, x) => s + x.duration, 0);
    let repeat = repeatRaw;
    if (repeatRaw < 0) {
      const total = opts.timelineDuration;
      if (total === undefined || !finiteNum(total)) return fail(`${at}.repeat: -1 (forever) needs timeline.duration — the timeline's length to repeat to`);
      repeat = cycle + repeatDelay > 0 ? Math.max(0, Math.ceil((total - start) / (cycle + repeatDelay)) - 1) : 0;
    }
    repeat = Math.min(repeat, 500);

    let spanEnd = start;
    ids.forEach((id, i) => {
      const t0 = start + delays[i];
      let elementTail = 0;
      if (split) {
        const n = host.elements(id, split);
        if (n === null) {
          warnings.push(`${at}: ${id} isn't a text — split is for text layers`);
        } else {
          const each = finiteNum(stagger) ? stagger : stagger && typeof stagger === "object" ? (finiteNum((stagger as Record<string, unknown>).each) ? ((stagger as Record<string, unknown>).each as number) : finiteNum((stagger as Record<string, unknown>).amount) ? ((stagger as Record<string, unknown>).amount as number) / Math.max(1, n - 1) : 0.03) : 0.03;
          const from = stagger && typeof stagger === "object" ? String((stagger as Record<string, unknown>).from ?? "start") : "start";
          layer(id).textStagger = { grouping: GROUPING[split], delayMs: Math.round(each * 1000), order: ORDER[from] ?? "LEFT_RIGHT" };
          elementTail = Math.max(0, n - 1) * each;
        }
      }
      for (const c of channels) {
        const keys = keysOf(id, c);
        if (!keys) continue;
        const rest = host.rest(id, c)!;
        let t = t0;
        const cycleSegs: { t0: number; t1: number; a: Value; b: Value; ease: EaseSpec }[] = [];
        for (const s of steps) {
          const has = s.from?.has(c) || s.to.has(c);
          const t1 = t + s.duration;
          if (has) {
            const cur = valueAt(keys, t, rest);
            const a = s.from?.get(c) ?? cur;
            const b = s.to.get(c) ?? cur;
            writeSegment(keys, t, t1, a, b, s.ease);
            cycleSegs.push({ t0: t - t0, t1: t1 - t0, a, b, ease: s.ease });
          }
          t = t1;
        }
        // repeat / yoyo: the cycle again, every other one backwards with the mirrored ease.
        for (let r = 1; r <= repeat; r++) {
          const base = t0 + r * (cycle + repeatDelay);
          const back = yoyo && r % 2 === 1;
          const segs = back ? [...cycleSegs].reverse().map((g) => ({ t0: cycle - g.t1, t1: cycle - g.t0, a: g.b, b: g.a, ease: mirrorEase(g.ease) })) : cycleSegs;
          for (const g of segs) writeSegment(keys, base + g.t0, base + g.t1, g.a, g.b, g.ease);
        }
      }
      spanEnd = Math.max(spanEnd, t0 + (repeat + 1) * cycle + repeat * repeatDelay + elementTail);
    });
    out.push({ index, targets: ids, start, end: spanEnd, ...(typeof tw.label === "string" ? { label: tw.label } : {}) });
    ctx.prevStart = start;
    ctx.prevEnd = spanEnd;
    ctx.end = Math.max(ctx.end, spanEnd);
  });

  // Keys past an explicit timeline length are kept (the timeline shows them dimmed); say so.
  if (opts.timelineDuration !== undefined && finiteNum(opts.timelineDuration) && ctx.end > opts.timelineDuration + 1e-6) warnings.push(`the script runs to ${round(ctx.end)} s, past timeline.duration ${opts.timelineDuration} s — the rest is cut when it plays`);
  return { layers, tweens: out, labels: ctx.labels, end: ctx.end, warnings };
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/** "50% 50%", "center", "left top", "right bottom", [x, y] (%) → the anchor in % of the size. */
export function parseOrigin(v: unknown, at: string): { x: number; y: number } {
  if (Array.isArray(v) && v.length === 2 && v.every(finiteNum)) return { x: v[0], y: v[1] };
  if (typeof v === "string") {
    const words: Record<string, [number | null, number | null]> = { left: [0, null], right: [100, null], top: [null, 0], bottom: [null, 100], center: [null, null] };
    const parts = v.trim().toLowerCase().split(/\s+/);
    let x: number | null = null, y: number | null = null;
    const nums: number[] = [];
    for (const p of parts) {
      if (p in words) {
        const [wx, wy] = words[p];
        if (wx !== null) x = wx;
        if (wy !== null) y = wy;
      } else if (/^-?[\d.]+%?$/.test(p)) nums.push(parseFloat(p));
      else return fail(`${at}: "50% 50%", "center", "left top" … or [x%, y%]`);
    }
    if (nums.length) [x, y] = [nums[0], nums[1] ?? nums[0]];
    return { x: x ?? 50, y: y ?? 50 };
  }
  return fail(`${at}: "50% 50%", "center", "left top" … or [x%, y%]`);
}
