/**
 * The timeline as a cue sheet for sound (docs/motion.md §9.3; [ours]): what `score_motion` hands an agent so it can
 * place sounds on the motion — when layers appear and disappear, start moving, move fastest, arrive (a tween's end),
 * pop (scale overshoot), spin, a text's per-element times, group staggers, the accents where several things land at
 * once, the climax, when everything is at rest, the loop, and a motion-energy curve. Pure: it reads the resolved model
 * (every property's keyframes in timeline time, presets materialised — engine.motionResolved) and, when given, the
 * engine's samples (engine.motionSamples) for the true moment of peak speed.
 */
import type { KeyframeValue, MotionEasing, MotionSamples, PlaybackName, ResolvedLayer, ResolvedMotion } from "@shared/motion/types";

const US = 1e6;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

export type MotionEventType = "appear" | "disappear" | "move" | "arrive" | "pop" | "spin" | "cut" | "stagger" | "rest" | "loop" | "end";

export interface MotionEvent {
  /** Seconds on the timeline */
  t: number;
  type: MotionEventType;
  layer?: string;
  id?: string;
  /** 0–1: how big it reads (distance, scale, the layer's size) */
  strength: number;
  /** move: its span, the moment of peak speed, what moves, the ease of its main tween */
  end?: number;
  peak?: number;
  props?: string[];
  ease?: string;
  /** px, degrees or a scale factor, as the props say */
  amount?: string;
  /** stagger: the elements' start times */
  times?: number[];
  step?: number;
  count?: number;
  /** stagger: a text's per-element grouping, or the layers of a group stagger */
  grouping?: string;
  layers?: string[];
}

export interface Accent {
  t: number;
  strength: number;
  what: string;
  /** What lands there: arrive, appear, pop, cut */
  kinds: string[];
}

export interface Cue {
  t: number;
  /** A suggested sound (generate_sound's type) and how to align it */
  sound: "whoosh" | "swoosh" | "impact" | "thud" | "pop" | "click" | "tick" | "typing" | "riser" | "shimmer" | "downlifter";
  align: "sync";
  why: string;
  /** typing / tick cues: the element times */
  times?: number[];
}

export interface MotionScore {
  duration: number;
  playback: PlaybackName;
  layers: number;
  events: MotionEvent[];
  accents: Accent[];
  climax: Accent | null;
  /** When the last move ends (everything at rest) */
  rest: number | null;
  /** Motion energy, 0–1, per `step` s */
  energy: { step: number; values: number[] };
  cues: Cue[];
}

export interface ScoreInput {
  resolved: ResolvedMotion;
  /** The root's size (strengths are relative to it) */
  rootSize: { width: number; height: number };
  /** The engine's samples over the timeline (the true moment of peak speed); without them, the eases' shapes */
  samples?: MotionSamples | null;
}

type Group = "opacity" | "position" | "scale" | "rotation" | "size" | "other";

interface Segment {
  t0: number;
  t1: number;
  group: Group;
  field: string;
  from: number;
  to: number;
  /** The overshoot past `to` a back / spring ease adds, as a fraction of the change */
  overshoot: number;
  easing: MotionEasing;
  hold: boolean;
}

function groupOf(name: string): Group {
  if (name === "OPACITY") return "opacity";
  if (name.startsWith("TRANSLATION")) return "position";
  if (name.startsWith("SCALE")) return "scale";
  if (name === "ROTATION") return "rotation";
  if (name === "WIDTH" || name === "HEIGHT") return "size";
  return "other";
}

/** A value as one number (a vector's length, a colour's sum) for distances. */
function scalar(v: KeyframeValue): number {
  switch (v.type) {
    case "FLOAT":
      return v.value;
    case "VECTOR":
      return Math.hypot(v.value.x, v.value.y);
    case "COLOR":
      return (v.value.r + v.value.g + v.value.b) * 100;
    case "BOOL":
      return v.value ? 1 : 0;
    default:
      return 0;
  }
}

/** The distance between two values (vectors: the Euclidean one). */
function distance(a: KeyframeValue, b: KeyframeValue): number {
  if (a.type === "VECTOR" && b.type === "VECTOR") return Math.hypot(a.value.x - b.value.x, a.value.y - b.value.y);
  return Math.abs(scalar(a) - scalar(b));
}

const fieldName = (f: ResolvedLayer["properties"][number]["field"]) => (f.type === "PROPERTY" ? f.name : `${f.collection}[${f.index}]${"field" in f && f.field ? `.${f.field}` : ""}`);

const SPRINGS = new Set(["GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING"]);

/** A named ease's control points (CSS's, close to Figma's), for where its speed peaks. */
const BEZIER: Record<string, [number, number, number, number]> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.36, 0, 0.66, -0.56],
  EASE_OUT_BACK: [0.34, 1.56, 0.64, 1],
  EASE_IN_AND_OUT_BACK: [0.68, -0.6, 0.32, 1.6],
};

/** Where (0–1 of the tween's time) a cubic Bézier ease moves fastest. */
function bezierPeak([x1, y1, x2, y2]: [number, number, number, number]): number {
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  let best = 0, at = 0;
  const N = 64;
  for (let k = 0; k < N; k++) {
    const s0 = k / N, s1 = (k + 1) / N;
    const dx = bx(s1) - bx(s0);
    const v = dx > 1e-9 ? Math.abs(by(s1) - by(s0)) / dx : 0;
    if (v > best + 1e-9) {
      best = v;
      at = (bx(s0) + bx(s1)) / 2;
    }
  }
  return at;
}

/** Where (0–1 of the tween's time) a cubic Bézier ease is furthest past its end, and by how much. */
function bezierOvershoot([x1, y1, x2, y2]: [number, number, number, number]): { at: number; by: number } {
  let by = 0, at = 1;
  for (let k = 0; k <= 64; k++) {
    const s = k / 64;
    const y = 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
    if (y - 1 > by) {
      by = y - 1;
      at = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
    }
  }
  return { at, by };
}

/** Where an ease moves fastest (0–1), how far past its end it overshoots (fraction of the change) and when (0–1). */
function easeShape(e: MotionEasing): { peak: number; overshoot: number; overshootAt: number } {
  if (SPRINGS.has(e.type)) {
    const bounce = e.easingFunctionSpring?.bounce ?? (e.type === "BOUNCY" ? 0.69 : e.type === "QUICK" ? 0.42 : e.type === "GENTLE" ? 0.25 : 0);
    return { peak: 0.08, overshoot: Math.max(0, bounce) * 0.35, overshootAt: 0.3 };
  }
  const b = e.type === "CUSTOM_CUBIC_BEZIER" && e.easingFunctionCubicBezier ? [e.easingFunctionCubicBezier.x1, e.easingFunctionCubicBezier.y1, e.easingFunctionCubicBezier.x2, e.easingFunctionCubicBezier.y2] as [number, number, number, number] : BEZIER[e.type] ?? BEZIER.EASE_OUT;
  const o = bezierOvershoot(b);
  return { peak: bezierPeak(b), overshoot: o.by, overshootAt: o.at };
}

const easeName = (e: MotionEasing) => e.type;

function segmentsOf(layer: ResolvedLayer): { segs: Segment[]; staggers: { t0: number; t1: number; step: number; count: number; grouping: string }[] } {
  const segs: Segment[] = [];
  const staggers: { t0: number; t1: number; step: number; count: number; grouping: string }[] = [];
  for (const p of layer.properties) {
    const name = fieldName(p.field);
    const group = groupOf(name);
    const keys = [...p.keyframes].sort((a, b) => a.timeUs - b.timeUs);
    for (let k = 0; k + 1 < keys.length; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      if (distance(a.value, b.value) < 1e-4) continue;
      const hold = b.easing?.type === "HOLD" || b.timeUs - a.timeUs < 2_000;
      segs.push({ t0: a.timeUs / US, t1: b.timeUs / US, group, field: name, from: scalar(a.value), to: scalar(b.value), overshoot: easeShape(b.easing ?? { type: "EASE_OUT" }).overshoot, easing: b.easing ?? { type: "EASE_OUT" }, hold });
    }
    if (p.stagger && p.stagger.elements > 1 && keys.length > 1) {
      const t0 = keys[0].timeUs / US;
      const t1 = keys[keys.length - 1].timeUs / US;
      if (!staggers.some((s) => Math.abs(s.t0 - t0) < 1e-3)) staggers.push({ t0, t1, step: p.stagger.delayMs / 1000, count: p.stagger.elements, grouping: p.stagger.grouping });
    }
  }
  return { segs: segs.sort((a, b) => a.t0 - b.t0), staggers };
}

/** How big a change reads, 0–1 (`diag`: the root's diagonal). */
function changeStrength(s: Segment, diag: number, layerWeight: number): number {
  const d = Math.abs(s.to - s.from);
  let v: number;
  switch (s.group) {
    case "position":
      v = (d / diag) * 5;
      break;
    case "scale":
      v = d * 1.2;
      break;
    case "rotation":
      v = d / 270;
      break;
    case "size":
      v = (d / diag) * 2;
      break;
    case "opacity":
      v = d * 0.5;
      break;
    default:
      v = 0.15;
  }
  return Math.min(1, v * layerWeight);
}

/** Per layer, its local position and scale over the samples, for the time of peak speed. */
function speedOf(samples: MotionSamples | null | undefined, node: string): ((t0: number, t1: number) => number | null) | null {
  const layer = samples?.layers.find((l) => l.node === node);
  if (!samples || !layer) return null;
  const times = samples.times.map((t) => t / US);
  return (t0, t1) => {
    let best = 0;
    let at: number | null = null;
    for (let k = 1; k < times.length; k++) {
      if (times[k] < t0 || times[k - 1] > t1) continue;
      const a = layer.frames[k - 1];
      const b = layer.frames[k];
      const dt = times[k] - times[k - 1];
      if (!a || !b || dt <= 0) continue;
      const sa = Math.hypot(a.t[0], a.t[1]);
      const sb = Math.hypot(b.t[0], b.t[1]);
      const ra = Math.atan2(a.t[1], a.t[0]);
      const rb = Math.atan2(b.t[1], b.t[0]);
      const size = Math.max(a.w, a.h, 1);
      const v = (Math.hypot(b.t[4] - a.t[4], b.t[5] - a.t[5]) + Math.abs(sb - sa) * size + Math.abs(rb - ra) * size * 0.5) / dt;
      if (v > best) {
        best = v;
        at = (times[k] + times[k - 1]) / 2;
      }
    }
    return at;
  };
}

/** The resolved timeline as events, accents, the climax, energy and suggested cues. */
export function scoreMotion({ resolved, rootSize, samples }: ScoreInput): MotionScore {
  const duration = resolved.durationUs / US;
  const diag = Math.max(1, Math.hypot(rootSize.width, rootSize.height));
  const rootArea = Math.max(1, rootSize.width * rootSize.height);
  const events: MotionEvent[] = [];
  const allMoves: { t0: number; t1: number; strength: number }[] = [];
  const groupCandidates: { layer: string; t: number; dur: number; kind: string }[] = [];

  for (const layer of resolved.layers) {
    const { segs, staggers } = segmentsOf(layer);
    if (!segs.length) continue;
    const name = layer.name;
    const id = layer.path || layer.node;
    // A layer's size scales how big its changes read (a quarter of the frame's area ≈ 0.8, a dot ≈ 0.35).
    const weight = 0.3 + 0.7 * Math.pow(Math.min(1, (layer.size.width * layer.size.height) / rootArea), 0.25);
    const peakOf = speedOf(samples, layer.node);

    // Opacity: appear / disappear.
    for (const s of segs.filter((x) => x.group === "opacity")) {
      if (s.from <= 0.05 && s.to >= 0.4) {
        events.push({ t: r3(s.t0), type: "appear", layer: name, id, strength: r2(Math.min(1, 0.1 + 0.6 * weight * (s.to - s.from))), end: r3(s.t1), ease: easeName(s.easing) });
        groupCandidates.push({ layer: name, t: s.t0, dur: s.t1 - s.t0, kind: "appear" });
      } else if (s.from >= 0.4 && s.to <= 0.05) events.push({ t: r3(s.t0), type: "disappear", layer: name, id, strength: r2(0.1 + 0.5 * weight * (s.from - s.to)), end: r3(s.t1), ease: easeName(s.easing) });
    }

    // Instant changes (Hold keys): cuts.
    for (const s of segs.filter((x) => x.hold && x.group !== "opacity")) events.push({ t: r3(s.t1), type: "cut", layer: name, id, strength: r2(Math.max(0.2, changeStrength(s, diag, weight))), props: [s.group] });

    // Moves: transform / size tweens merged where they overlap.
    const moving = segs.filter((x) => !x.hold && x.group !== "opacity" && x.group !== "other");
    const moves: Segment[][] = [];
    for (const s of moving) {
      const last = moves[moves.length - 1];
      if (last && s.t0 < Math.max(...last.map((x) => x.t1)) + 0.03) last.push(s);
      else moves.push([s]);
    }
    for (const m of moves) {
      const t0 = Math.min(...m.map((x) => x.t0));
      const t1 = Math.max(...m.map((x) => x.t1));
      const main = m.reduce((a, b) => (changeStrength(b, diag, weight) > changeStrength(a, diag, weight) ? b : a));
      const strength = Math.min(1, m.reduce((acc, s) => acc + changeStrength(s, diag, weight), 0));
      const sampled = peakOf?.(t0, t1);
      const peak = sampled ?? main.t0 + easeShape(main.easing).peak * (main.t1 - main.t0);
      const props = [...new Set(m.map((x) => x.group))];
      const amount = m
        .map((s) => (s.group === "position" ? `${Math.round(Math.abs(s.to - s.from))}px ${s.field.replace("TRANSLATION_", "").toLowerCase()}` : s.group === "scale" ? `scale ${r2(s.from)}→${r2(s.to)}` : s.group === "rotation" ? `${Math.round(Math.abs(s.to - s.from))}°` : `${s.field.toLowerCase()} ${Math.round(s.from)}→${Math.round(s.to)}`))
        .filter((v, k, a) => a.indexOf(v) === k)
        .slice(0, 4)
        .join(", ");
      events.push({ t: r3(t0), type: "move", layer: name, id, strength: r2(strength), end: r3(t1), peak: r3(Math.min(t1, Math.max(t0, peak))), props, ease: easeName(main.easing), amount });
      events.push({ t: r3(t1), type: "arrive", layer: name, id, strength: r2(Math.min(1, strength * (main.overshoot > 0 ? 1.1 : 1))), ease: easeName(main.easing) });
      allMoves.push({ t0, t1, strength });
      groupCandidates.push({ layer: name, t: t0, dur: t1 - t0, kind: props.join("+") });
      // Pops: a scale that overshoots (back / spring ease, or a key past the end value).
      for (const s of m.filter((x) => x.group === "scale")) {
        // A rise straight followed by a settle back on the same field: a keyed overshoot.
        const settles = s.to > s.from && segs.some((x) => x.group === "scale" && x.field === s.field && Math.abs(x.t0 - s.t1) < 1e-3 && x.to < x.from);
        if (s.overshoot > 0.02 && s.to > s.from) events.push({ t: r3(s.t0 + easeShape(s.easing).overshootAt * (s.t1 - s.t0)), type: "pop", layer: name, id, strength: r2(Math.min(1, 0.35 + changeStrength(s, diag, weight))), ease: easeName(s.easing) });
        else if (settles) events.push({ t: r3(s.t1), type: "pop", layer: name, id, strength: r2(Math.min(1, 0.35 + changeStrength(s, diag, weight))) });
        else if (s.from <= 0.6 && s.to >= 0.9 && s.t1 - s.t0 <= 0.5) events.push({ t: r3(s.t1), type: "pop", layer: name, id, strength: r2(Math.min(1, 0.3 + changeStrength(s, diag, weight))) });
      }
      for (const s of m.filter((x) => x.group === "rotation" && Math.abs(x.to - x.from) >= 180)) events.push({ t: r3(s.t0), type: "spin", layer: name, id, strength: r2(changeStrength(s, diag, weight)), end: r3(s.t1), amount: `${Math.round(Math.abs(s.to - s.from))}°` });
    }

    // A text's own stagger: element i starts i × step after the tween.
    for (const st of staggers) {
      const count = Math.min(st.count, 400);
      const times = Array.from({ length: count }, (_, k) => r3(st.t0 + k * st.step));
      events.push({ t: r3(st.t0), type: "stagger", layer: name, id, strength: 0.3, end: r3(Math.max(st.t1, times[times.length - 1])), step: r3(st.step), count: st.count, grouping: st.grouping, times });
    }
  }

  // Group staggers: three or more layers doing the same thing at an even step.
  const byKind = new Map<string, typeof groupCandidates>();
  for (const c of groupCandidates) {
    const key = `${c.kind}|${Math.round(c.dur * 20)}`;
    (byKind.get(key) ?? byKind.set(key, []).get(key)!).push(c);
  }
  for (const list of byKind.values()) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    let run: typeof sorted = [];
    const flush = () => {
      if (run.length >= 3) {
        const step = (run[run.length - 1].t - run[0].t) / (run.length - 1);
        if (step >= 0.015 && step <= 0.5) events.push({ t: r3(run[0].t), type: "stagger", strength: 0.35, step: r3(step), count: run.length, layers: run.map((r) => r.layer), times: run.map((r) => r3(r.t)), grouping: "LAYERS", end: r3(run[run.length - 1].t + run[run.length - 1].dur) });
      }
      run = [];
    };
    for (const c of sorted) {
      if (run.length >= 2) {
        const step = run[1].t - run[0].t;
        const gap = c.t - run[run.length - 1].t;
        if (Math.abs(gap - step) > Math.max(0.02, step * 0.25)) flush();
      } else if (run.length === 1 && (c.t - run[0].t < 0.015 || c.t - run[0].t > 0.5)) flush();
      run.push(c);
    }
    flush();
  }

  // Accents: arrivals, appearances, pops and cuts landing together (60 ms).
  const hits = events.filter((e) => e.type === "arrive" || e.type === "appear" || e.type === "pop" || e.type === "cut").sort((a, b) => a.t - b.t);
  const accents: Accent[] = [];
  for (let k = 0; k < hits.length; ) {
    const group = [hits[k]];
    while (k + group.length < hits.length && hits[k + group.length].t - hits[k].t <= 0.06) group.push(hits[k + group.length]);
    k += group.length;
    const strength = Math.min(1, group.reduce((a, e) => a + e.strength, 0) / Math.sqrt(group.length));
    const names = [...new Set(group.map((e) => `${e.layer ?? "?"} ${e.type === "arrive" ? "lands" : e.type === "appear" ? "appears" : e.type === "pop" ? "pops" : "cuts"}`))];
    accents.push({ t: r3(group.reduce((a, e) => Math.max(a, e.t), 0)), strength: r2(strength), what: names.slice(0, 4).join(", ") + (names.length > 4 ? ` (+${names.length - 4})` : ""), kinds: [...new Set(group.map((e) => e.type))] });
  }
  const climax = accents.length ? accents.reduce((a, b) => (b.strength > a.strength + 0.05 || (Math.abs(b.strength - a.strength) <= 0.05 && b.t > a.t) ? b : a)) : null;
  const rest = allMoves.length ? r3(Math.min(duration, ...[Math.max(...allMoves.map((m) => m.t1), ...events.filter((e) => e.type === "appear" || e.type === "stagger").map((e) => e.end ?? e.t))])) : null;

  // Energy: the moves' strength spread over their spans, per 0.25 s, scaled to the loudest bin.
  const step = 0.25;
  const bins = Math.max(1, Math.ceil(duration / step));
  const energy = new Array<number>(bins).fill(0);
  for (const m of allMoves) {
    const span = Math.max(0.05, m.t1 - m.t0);
    for (let b = Math.floor(m.t0 / step); b <= Math.min(bins - 1, Math.floor(m.t1 / step)); b++) {
      const overlap = Math.min(m.t1, (b + 1) * step) - Math.max(m.t0, b * step);
      if (overlap > 0) energy[b] += (m.strength * overlap) / span;
    }
  }
  const maxE = Math.max(1e-9, ...energy);

  if (resolved.playback === "LOOP") events.push({ t: r3(duration), type: "loop", strength: 0 });
  events.push({ t: r3(duration), type: "end", strength: 0 });
  if (rest !== null) events.push({ t: rest, type: "rest", strength: 0 });
  events.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type));
  // Keys past the timeline's end aren't seen or heard.
  const seen = events.filter((e) => e.t <= duration + 1e-3);

  return { duration: r3(duration), playback: resolved.playback, layers: resolved.layers.length, events: seen.slice(0, 400), accents, climax, rest, energy: { step, values: energy.map((e) => r2(e / maxE)) }, cues: cuesOf(seen, accents.filter((a) => a.t <= duration + 1e-3), climax && climax.t <= duration + 1e-3 ? climax : null) };
}

/** A starting cue sheet: whooshes peaking on big moves, hits on strong accents, pops on pops, ticks on staggers, a riser into the climax. */
function cuesOf(events: MotionEvent[], accents: Accent[], climax: Accent | null): Cue[] {
  const cues: Cue[] = [];
  // A riser ends where a hit lands: it doesn't take the moment.
  const near = (t: number, w = 0.12) => cues.some((c) => c.sound !== "riser" && Math.abs(c.t - t) < w);
  if (climax && climax.t >= 1) cues.push({ t: climax.t, sound: "riser", align: "sync", why: `builds into the climax (${climax.what})` });
  // Hits where something lands (an appearance alone fades in: no hit).
  for (const a of [...accents].sort((x, y) => y.strength - x.strength)) {
    if (a.strength < 0.45 || near(a.t, 0.25) || !a.kinds.some((k) => k !== "appear")) continue;
    cues.push({ t: a.t, sound: a.strength >= 0.75 ? "impact" : "thud", align: "sync", why: a.what });
  }
  for (const e of events) {
    // A whoosh peaks a little into the move even when its ease is fastest at the start (30–70 % of it).
    const whooshAt = e.peak !== undefined && e.end !== undefined ? r3(e.t + Math.min(0.7, Math.max(0.3, (e.peak - e.t) / Math.max(1e-3, e.end - e.t))) * (e.end - e.t)) : e.t;
    if (e.type === "move" && e.strength >= 0.35 && (e.props ?? []).some((p) => p === "position" || p === "rotation") && !near(whooshAt, 0.2))
      cues.push({ t: whooshAt, sound: (e.end ?? e.t) - e.t < 0.4 ? "swoosh" : "whoosh", align: "sync", why: `${e.layer} moves (${e.amount ?? ""}, ${e.ease ?? ""})` });
    else if (e.type === "pop" && !near(e.t, 0.08)) cues.push({ t: e.t, sound: "pop", align: "sync", why: `${e.layer} pops` });
    else if (e.type === "stagger" && e.times && e.times.length >= 3)
      cues.push({ t: e.t, sound: e.grouping === "LAYERS" ? "tick" : "typing", align: "sync", why: e.layers ? `${e.count} layers in turn` : `${e.layer} by ${String(e.grouping).toLowerCase()}`, times: e.times });
    else if (e.type === "appear" && e.strength < 0.45 && e.strength >= 0.25 && !near(e.t, 0.15)) cues.push({ t: e.t, sound: "click", align: "sync", why: `${e.layer} appears` });
  }
  return cues.sort((a, b) => a.t - b.t).slice(0, 60);
}
