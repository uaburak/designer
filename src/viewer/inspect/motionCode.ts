/**
 * Dev Mode's Motion code (docs/motion.md §8.2; round 8f): the resolved model (engine.motionResolved — every animated
 * layer's properties as keyframes in the timeline's time, presets materialised, public units) written as
 *
 * - **CSS**: per layer a class with `animation: …` (one animation per property group, the timeline's duration, LOOP
 *   `infinite`, Ping-pong `infinite alternate`, Once `1`, all `both`) and its `transform-origin` (the anchor), and one
 *   `@keyframes` per property group — percentages from the times, each keyframe's `animation-timing-function` the
 *   easing into the next one (cubic-bezier; springs as `linear(…)` sampled at 30 points; Hold `steps(1, jump-end)`),
 *   CSS's individual transform properties (`translate`, `rotate` clockwise +, `scale`); a layer whose motion is the
 *   same as an earlier one's says so in a comment instead (Figma's MCP dedupes the same way);
 * - **React**: motion.dev (`motion/react`) — `<motion.div animate={{ x: […], opacity: […] }} transition={{ x:
 *   { duration, times, ease, repeat } }} style={{ transformOrigin }} />` per layer; a two-keyframe spring as `type:
 *   "spring", bounce`;
 * - **JSON**: the resolved model.
 *
 * Fields CSS has no property for here (path trim, effects, text stagger's per-element timing) are listed in a comment.
 * Lengths are px; the panel rewrites them into the chosen unit (units.ts cssInUnit). [ours] The layout of the code.
 */
import { BEZIER_PRESETS, SPRING_PRESETS, normalizedToPhysicalSpring, type KeyframeField, type KeyframeValue, type MotionEasing, type PlaybackName, type ResolvedKeyframe, type ResolvedLayer, type ResolvedMotion, type ResolvedProperty, type RGBA } from "@shared/motion/types";

export type MotionCodeFormat = "css" | "react" | "json";

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${r3(v * 100)}%`;

/** A layer's name as a CSS class / an identifier. */
export function slug(name: string, fallback = "layer"): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(s) ? s : `${fallback}${s ? `-${s}` : ""}`;
}

// ---- Easing ---------------------------------------------------------------------------------------------------------

/** A damped spring's response (0 → 1) at time t (s). */
function springAt(s: { mass: number; stiffness: number; damping: number }, t: number): number {
  const w0 = Math.sqrt(s.stiffness / s.mass);
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

/** The time a spring settles within 0.1 % for good (its played span is normalised to the segment, §4.7). */
function springSettle(s: { mass: number; stiffness: number; damping: number }): number {
  const dt = 1 / 240;
  let last = 0;
  for (let t = 0; t < 10; t += dt) if (Math.abs(springAt(s, t) - 1) > 0.001) last = t;
  return Math.max(dt, last + dt);
}

const physical = (e: MotionEasing) => SPRING_PRESETS[e.type] ?? (e.type === "CUSTOM_SPRING" ? normalizedToPhysicalSpring(e.easingFunctionSpring?.bounce ?? 0) : null);

/** The spring's response sampled at `n` points over its settle time (CSS `linear()`). */
export function springSamples(e: MotionEasing, n = 30): number[] {
  const s = physical(e);
  if (!s) return [];
  const T = springSettle(s);
  return Array.from({ length: n + 1 }, (_, i) => r3(springAt(s, (i / n) * T)));
}

/** A bezier's control points (absent: the keyframe default, CUSTOM_CUBIC (0.5, 0, 0.5, 1)). */
function bezierOf(e: MotionEasing): [number, number, number, number] | null {
  if (e.type === "CUSTOM_CUBIC_BEZIER") {
    const b = e.easingFunctionCubicBezier;
    return b ? [b.x1, b.y1, b.x2, b.y2] : [0.5, 0, 0.5, 1];
  }
  return BEZIER_PRESETS[e.type] ?? null;
}

/** CSS's timing function for an easing. */
export function cssEasing(e: MotionEasing): string {
  if (e.type === "HOLD") return "steps(1, jump-end)";
  if (e.type === "LINEAR") return "linear";
  const b = bezierOf(e);
  if (b) return `cubic-bezier(${b.map(r3).join(", ")})`;
  const samples = springSamples(e);
  return samples.length ? `linear(${samples.join(", ")})` : "ease";
}

// ---- Properties ---------------------------------------------------------------------------------------------------

const rgba = (c: RGBA) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${r3(c.a)})`;

/** A property group: what one @keyframes (and one motion.dev key) animates. */
interface Group {
  key: string;
  css: string;
  /** The value of each keyframe as CSS */
  cssValue(v: KeyframeValue[]): string;
  react: string[];
  reactValue(v: KeyframeValue[]): (number | string)[];
  fields: string[];
}

const num = (v: KeyframeValue | undefined, fallback = 0) => (v?.type === "FLOAT" ? v.value : v?.type === "VECTOR" ? v.value.x : fallback);
const vec = (v: KeyframeValue | undefined, fallback: number) => (v?.type === "VECTOR" ? v.value : { x: num(v, fallback), y: num(v, fallback) });

const SIMPLE: Record<string, { css: string; react: string; unit: "px" | "" }> = {
  OPACITY: { css: "opacity", react: "opacity", unit: "" },
  WIDTH: { css: "width", react: "width", unit: "px" },
  HEIGHT: { css: "height", react: "height", unit: "px" },
  CORNER_RADIUS: { css: "border-radius", react: "borderRadius", unit: "px" },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { css: "border-top-left-radius", react: "borderTopLeftRadius", unit: "px" },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { css: "border-top-right-radius", react: "borderTopRightRadius", unit: "px" },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { css: "border-bottom-left-radius", react: "borderBottomLeftRadius", unit: "px" },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { css: "border-bottom-right-radius", react: "borderBottomRightRadius", unit: "px" },
  STROKE_WEIGHT: { css: "border-width", react: "borderWidth", unit: "px" },
  BORDER_TOP_WEIGHT: { css: "border-top-width", react: "borderTopWidth", unit: "px" },
  BORDER_BOTTOM_WEIGHT: { css: "border-bottom-width", react: "borderBottomWidth", unit: "px" },
  BORDER_LEFT_WEIGHT: { css: "border-left-width", react: "borderLeftWidth", unit: "px" },
  BORDER_RIGHT_WEIGHT: { css: "border-right-width", react: "borderRightWidth", unit: "px" },
  STACK_SPACING: { css: "gap", react: "gap", unit: "px" },
  STACK_COUNTER_SPACING: { css: "row-gap", react: "rowGap", unit: "px" },
  GRID_ROW_GAP: { css: "row-gap", react: "rowGap", unit: "px" },
  GRID_COLUMN_GAP: { css: "column-gap", react: "columnGap", unit: "px" },
  STACK_PADDING_LEFT: { css: "padding-left", react: "paddingLeft", unit: "px" },
  STACK_PADDING_TOP: { css: "padding-top", react: "paddingTop", unit: "px" },
  STACK_PADDING_RIGHT: { css: "padding-right", react: "paddingRight", unit: "px" },
  STACK_PADDING_BOTTOM: { css: "padding-bottom", react: "paddingBottom", unit: "px" },
};

/** The group a property belongs to; null: no CSS property for it here. */
function groupOf(f: KeyframeField, text: boolean): Group | null {
  if (f.type === "INDEXED_ITEM") {
    if (f.collection === "effects" || f.propertyId || ("opacity" in f && f.opacity) || f.index !== 0) return null;
    const css = f.collection === "strokes" ? "border-color" : text ? "color" : "background-color";
    const react = f.collection === "strokes" ? "borderColor" : text ? "color" : "backgroundColor";
    const color = (v: KeyframeValue | undefined) => (v?.type === "COLOR" ? rgba(v.value) : "transparent");
    return { key: f.collection, css, cssValue: (v) => color(v[0]), react: [react], reactValue: (v) => [color(v[0])], fields: [`${f.collection}[0]`] };
  }
  const n = f.name;
  if (n === "TRANSLATION_X" || n === "TRANSLATION_Y" || n === "TRANSLATION_XY")
    return { key: "translate", css: "translate", cssValue: ([xy, x, y]) => `${r3(xy ? vec(xy, 0).x : num(x))}px ${r3(xy ? vec(xy, 0).y : num(y))}px`, react: ["x", "y"], reactValue: ([xy, x, y]) => [r3(xy ? vec(xy, 0).x : num(x)), r3(xy ? vec(xy, 0).y : num(y))], fields: ["TRANSLATION_XY", "TRANSLATION_X", "TRANSLATION_Y"] };
  if (n === "SCALE_X" || n === "SCALE_Y" || n === "SCALE_XY")
    return { key: "scale", css: "scale", cssValue: ([xy, x, y]) => `${r3(xy ? vec(xy, 1).x : num(x, 1))} ${r3(xy ? vec(xy, 1).y : num(y, 1))}`, react: ["scaleX", "scaleY"], reactValue: ([xy, x, y]) => [r3(xy ? vec(xy, 1).x : num(x, 1)), r3(xy ? vec(xy, 1).y : num(y, 1))], fields: ["SCALE_XY", "SCALE_X", "SCALE_Y"] };
  // Figma's rotation is counter-clockwise +; CSS's and motion.dev's clockwise.
  if (n === "ROTATION") return { key: "rotate", css: "rotate", cssValue: ([v]) => `${r3(-num(v))}deg`, react: ["rotate"], reactValue: ([v]) => [r3(-num(v))], fields: ["ROTATION"] };
  const s = SIMPLE[n];
  if (!s) return null;
  return { key: s.css, css: s.css, cssValue: ([v]) => `${r3(num(v))}${s.unit}`, react: [s.react], reactValue: ([v]) => [r3(num(v))], fields: [n] };
}

const fieldName = (f: KeyframeField) => (f.type === "PROPERTY" ? f.name : `${f.collection}[${f.index}]`);

/** A property's value at time t: held before its first and after its last keyframe, linear between (merging X and Y). */
function valueAt(keys: readonly ResolvedKeyframe[], t: number): KeyframeValue | undefined {
  if (!keys.length) return undefined;
  if (t <= keys[0].timeUs) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.timeUs) return last.value;
  const i = keys.findIndex((k) => k.timeUs >= t);
  const a = keys[i - 1];
  const b = keys[i];
  if (b.timeUs === t || a.value.type !== b.value.type) return b.value;
  const u = (t - a.timeUs) / (b.timeUs - a.timeUs);
  const mix = (x: number, y: number) => x + (y - x) * u;
  if (a.value.type === "FLOAT" && b.value.type === "FLOAT") return { type: "FLOAT", value: mix(a.value.value, b.value.value) };
  if (a.value.type === "VECTOR" && b.value.type === "VECTOR") return { type: "VECTOR", value: { x: mix(a.value.value.x, b.value.value.x), y: mix(a.value.value.y, b.value.value.y) } };
  return a.value;
}

/** One property group of a layer, its keyframes merged across its fields (X / Y), each with the easing into it. */
interface Animated {
  group: Group;
  times: number[];
  values: KeyframeValue[][];
  /** Into each keyframe */
  easings: MotionEasing[];
}

function animatedOf(layer: ResolvedLayer, text: boolean): { animated: Animated[]; skipped: string[] } {
  const groups = new Map<string, { group: Group; props: ResolvedProperty[] }>();
  const skipped: string[] = [];
  for (const p of layer.properties) {
    if (!p.keyframes.length) continue;
    const g = groupOf(p.field, text);
    if (!g || p.stagger) {
      skipped.push(p.stagger ? `${fieldName(p.field)} (per ${p.stagger.grouping.toLowerCase()})` : fieldName(p.field));
      continue;
    }
    const at = groups.get(g.key) ?? groups.set(g.key, { group: g, props: [] }).get(g.key)!;
    at.props.push(p);
  }
  const animated = [...groups.values()].map(({ group, props }) => {
    const byField = (name: string) => props.filter((p) => fieldName(p.field) === name).flatMap((p) => p.keyframes).sort((a, b) => a.timeUs - b.timeUs);
    const tracks = group.fields.map(byField);
    const times = [...new Set(tracks.flat().map((k) => k.timeUs))].sort((a, b) => a - b);
    const values = times.map((t) => tracks.map((ks) => valueAt(ks, t)!));
    const easings = times.map((t) => tracks.flat().find((k) => k.timeUs === t)?.easing ?? { type: "LINEAR" as const });
    return { group, times, values, easings };
  });
  return { animated, skipped };
}

const ITERATION: Record<PlaybackName, string> = { LOOP: "infinite", PING_PONG: "infinite alternate", ONCE: "1" };

/** Each layer's code key (equal motion shares the first layer's code). */
const signature = (a: Animated[]) => JSON.stringify(a.map((x) => [x.group.key, x.times, x.values, x.easings]));

// ---- CSS ----------------------------------------------------------------------------------------------------------

export interface MotionCodeInput {
  resolved: ResolvedMotion;
  /** Text layers (their fill animates `color`) */
  textLayers?: ReadonlySet<string>;
}

export function motionCss({ resolved, textLayers }: MotionCodeInput): string {
  const d = Math.max(1, resolved.durationUs);
  const out: string[] = [];
  const seen = new Map<string, string>();
  const used = new Set<string>();
  for (const layer of resolved.layers) {
    let cls = slug(layer.name);
    for (let i = 2; used.has(cls); i++) cls = `${slug(layer.name)}-${i}`;
    used.add(cls);
    const { animated, skipped } = animatedOf(layer, !!textLayers?.has(layer.node));
    if (!animated.length && !skipped.length) continue;
    const sig = `${layer.anchor.x},${layer.anchor.y}:${signature(animated)}`;
    const same = animated.length ? seen.get(sig) : undefined;
    if (same) {
      out.push(`/* .${cls}: the same motion as .${same} */`);
      continue;
    }
    if (animated.length) seen.set(sig, cls);
    const lines = [`.${cls} {`];
    if (animated.length) {
      const anims = animated.map((a) => `${cls}-${a.group.key} ${r3(d / 1000)}ms linear ${ITERATION[resolved.playback]} both`);
      lines.push(`  animation: ${anims.join(",\n    ")};`);
      lines.push(`  transform-origin: ${r3(layer.anchor.x)}% ${r3(layer.anchor.y)}%;`);
    }
    if (skipped.length) lines.push(`  /* Not in CSS: ${skipped.join(", ")} */`);
    lines.push("}");
    out.push(lines.join("\n"));
    for (const a of animated) {
      const kf = [`@keyframes ${cls}-${a.group.key} {`];
      // Held from 0 to the first keyframe and from the last to the end.
      const stops: { at: number; value: string; next?: MotionEasing }[] = a.times.map((t, i) => ({ at: t / d, value: a.group.cssValue(a.values[i]), next: a.easings[i + 1] }));
      if (stops[0].at > 0) stops.unshift({ at: 0, value: stops[0].value, next: { type: "HOLD" } });
      if (stops[stops.length - 1].at < 1) stops.push({ at: 1, value: stops[stops.length - 1].value, next: undefined });
      for (const s of stops) kf.push(`  ${pct(Math.min(1, s.at))} { ${a.group.css}: ${s.value};${s.next ? ` animation-timing-function: ${cssEasing(s.next)};` : ""} }`);
      kf.push("}");
      out.push(kf.join("\n"));
    }
  }
  return out.join("\n\n");
}

// ---- React (motion.dev) -------------------------------------------------------------------------------------------

/** motion.dev's `ease` for one segment. */
function reactEase(e: MotionEasing): string {
  if (e.type === "LINEAR") return '"linear"';
  if (e.type === "HOLD") return "(t) => (t < 1 ? 0 : 1)";
  const b = bezierOf(e);
  if (b) return `[${b.map(r3).join(", ")}]`;
  // A spring between more than two keyframes: motion.dev takes springs only per value — the nearest curve.
  return '"easeOut"';
}

const springBounce = (e: MotionEasing) => {
  const s = physical(e);
  return s ? r3(Math.min(1, Math.max(0, 1 - s.damping / (2 * Math.sqrt(s.stiffness * s.mass))))) : 0;
};

const literal = (v: number | string) => (typeof v === "number" ? String(v) : JSON.stringify(v));

export function motionReact({ resolved, textLayers }: MotionCodeInput): string {
  const d = Math.max(1, resolved.durationUs) / 1e6;
  const repeat = resolved.playback === "ONCE" ? "" : `, repeat: Infinity, repeatType: "${resolved.playback === "PING_PONG" ? "reverse" : "loop"}"`;
  const blocks: string[] = ['import { motion } from "motion/react";'];
  for (const layer of resolved.layers) {
    const { animated, skipped } = animatedOf(layer, !!textLayers?.has(layer.node));
    if (!animated.length) continue;
    const animate: string[] = [];
    const transition: string[] = [];
    for (const a of animated) {
      const t0 = a.times[0] / 1e6;
      const tn = a.times[a.times.length - 1] / 1e6;
      const twoSpring = a.times.length === 2 && physical(a.easings[1]);
      a.group.react.forEach((key, c) => {
        const values = a.values.map((v) => a.group.reactValue(v)[c]);
        // The times over the whole timeline, held before the first and after the last keyframe.
        const times = [...(t0 > 0 ? [0] : []), ...a.times.map((t) => r3(t / 1e6 / d)), ...(tn < d ? [1] : [])];
        const vals = [...(t0 > 0 ? [values[0]] : []), ...values, ...(tn < d ? [values[values.length - 1]] : [])];
        animate.push(`${key}: [${vals.map(literal).join(", ")}]`);
        if (twoSpring) transition.push(`${key}: { type: "spring", bounce: ${springBounce(a.easings[1])}, duration: ${r3(tn - t0)}, delay: ${r3(t0)}${repeat} }`);
        else {
          const ease = [...(t0 > 0 ? ['"linear"'] : []), ...a.easings.slice(1).map(reactEase), ...(tn < d ? ['"linear"'] : [])];
          transition.push(`${key}: { duration: ${r3(d)}, times: [${times.join(", ")}], ease: [${ease.join(", ")}]${repeat} }`);
        }
      });
    }
    const name = slug(layer.name);
    blocks.push(
      [
        `// ${layer.name}${skipped.length ? ` — not animated here: ${skipped.join(", ")}` : ""}`,
        `<motion.div`,
        `  className="${name}"`,
        `  style={{ transformOrigin: "${r3(layer.anchor.x)}% ${r3(layer.anchor.y)}%" }}`,
        `  animate={{ ${animate.join(", ")} }}`,
        `  transition={{\n    ${transition.join(",\n    ")}\n  }}`,
        `/>`,
      ].join("\n")
    );
  }
  return blocks.join("\n\n");
}

/** The code for a format. */
export function motionCode(format: MotionCodeFormat, input: MotionCodeInput): string {
  if (format === "json") return JSON.stringify(input.resolved, null, 2);
  return format === "react" ? motionReact(input) : motionCss(input);
}

// ---- Timing (the tab's rows) ----------------------------------------------------------------------------------

export interface TimingRow {
  layer: string;
  property: string;
  startMs: number;
  endMs: number;
  /** The easing into the last keyframe (the first segment's when there are more) */
  easing: MotionEasing;
  from: KeyframeValue;
  to: KeyframeValue;
  keyframes: number;
}

/** Per layer and property: start, end, easing and the values it runs between. */
export function timingRows(resolved: ResolvedMotion): TimingRow[] {
  const rows: TimingRow[] = [];
  for (const l of resolved.layers)
    for (const p of l.properties) {
      if (!p.keyframes.length) continue;
      const first = p.keyframes[0];
      const last = p.keyframes[p.keyframes.length - 1];
      rows.push({ layer: l.name, property: fieldName(p.field), startMs: r3(first.timeUs / 1000), endMs: r3(last.timeUs / 1000), easing: (p.keyframes[1] ?? last).easing, from: first.value, to: last.value, keyframes: p.keyframes.length });
    }
  return rows;
}
