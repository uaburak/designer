/**
 * Motion's easing curves in TypeScript (docs/motion.md §4.7; round 8i) — the same maths as engine/src/motion/Easing.cpp,
 * for what the chrome draws and plays without the engine: the Easing editor's 200 × 200 graph and its hover preview,
 * the spring editor's handle, and the vector exports' bezier tangents. Also the public `MotionEasing` ↔ the schema's
 * `EasingData` (an EASING variable's value, a keyframe's easingData), as the engine converts them.
 */
import { BEZIER_PRESETS, DEFAULT_KEYFRAME_EASING, EASING_SCHEMA_TYPE, MOTION_EASING_TYPES, SPRING_PRESETS, normalizedToPhysicalSpring, physicalSpringToNormalized, type MotionEasing, type MotionEasingType } from "./types";

export type Bezier = [number, number, number, number];
export interface Spring {
  mass: number;
  stiffness: number;
  damping: number;
}

/** CSS's cubic-bezier(x1, y1, x2, y2) at x ∈ [0, 1] (x is time, solved for y; Newton, then bisection). */
export function cubicBezierAt(b: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = b;
  const sample = (a1: number, a2: number, t: number) => 3 * (1 - t) * (1 - t) * t * a1 + 3 * (1 - t) * t * t * a2 + t * t * t;
  const slope = (a1: number, a2: number, t: number) => 3 * (1 - t) * (1 - t) * a1 + 6 * (1 - t) * t * (a2 - a1) + 3 * t * t * (1 - a2);
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sample(x1, x2, t) - x;
    if (Math.abs(err) < 1e-7) break;
    const d = slope(x1, x2, t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  if (t < 0 || t > 1 || Math.abs(sample(x1, x2, t) - x) > 1e-4) {
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const s = sample(x1, x2, t);
      if (Math.abs(s - x) < 1e-7) break;
      if (s < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return sample(y1, y2, t);
}

const MIN_ZETA = 0.03;
const omega = (s: Spring) => Math.sqrt(s.stiffness / s.mass);
const zetaOf = (s: Spring) => Math.max(MIN_ZETA, s.damping / (2 * Math.sqrt(s.stiffness * s.mass)));

/** A spring's value at `t` seconds: 0 at t = 0, settling at 1 (under-, critically or over-damped closed form). */
export function springValue(s: Spring, t: number): number {
  if (t <= 0) return 0;
  const w0 = omega(s);
  const zeta = zetaOf(s);
  let x: number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = Math.exp(-w0 * t) * (1 + w0 * t);
  } else {
    const r = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + r;
    const r2 = -zeta * w0 - r;
    const c1 = -r2 / (r1 - r2);
    x = c1 * Math.exp(r1 * t) + (1 - c1) * Math.exp(r2 * t);
  }
  return 1 - x;
}

/** Figma's settle time T (seconds): (−ln 0.001 + ln(1 + ζω₀ / ω_d)) / (ζω₀), ζ ≤ 0.9999. */
export function springSettle(s: Spring): number {
  const w0 = omega(s);
  const zeta = Math.min(0.9999, zetaOf(s));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return (-Math.log(0.001) + Math.log(1 + (zeta * w0) / wd)) / (zeta * w0);
}

/** A spring over one keyframe segment, normalised (§4.7): e(p) = spring(p · T), e(1) = 1. */
export function springNormalized(s: Spring, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return springValue(s, p * springSettle(s));
}

const SPRING_TYPES: readonly MotionEasingType[] = ["GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING"];
export const isSpringEasing = (type: MotionEasingType): boolean => SPRING_TYPES.includes(type);

/** An easing's bezier (the named curves, a custom one; the keyframe default when it has none), or null (springs, Hold). */
export function bezierOf(e: MotionEasing): Bezier | null {
  if (e.type === "CUSTOM_CUBIC_BEZIER") {
    const b = e.easingFunctionCubicBezier ?? DEFAULT_KEYFRAME_EASING.easingFunctionCubicBezier!;
    return [b.x1, b.y1, b.x2, b.y2];
  }
  return BEZIER_PRESETS[e.type] ?? null;
}

/** An easing's physical spring (a preset's, or the custom bounce's), or null. */
export function springOf(e: MotionEasing): Spring | null {
  if (e.type === "CUSTOM_SPRING") return normalizedToPhysicalSpring(e.easingFunctionSpring?.bounce ?? 0.25);
  return SPRING_PRESETS[e.type] ?? null;
}

/** The eased progress at p ∈ [0, 1], as a keyframe segment plays it (Hold a step, springs normalised). */
export function easingAt(e: MotionEasing, p: number): number {
  if (e.type === "HOLD") return p >= 1 ? 1 : 0;
  const b = bezierOf(e);
  if (b) return cubicBezierAt(b, p);
  const s = springOf(e);
  return s ? springNormalized(s, p) : p;
}

/** CSS's timing function for an easing (the hover preview): cubic-bezier, `linear()` sampled for springs, steps for Hold. */
export function easingCss(e: MotionEasing, samples = 40): string {
  if (e.type === "HOLD") return "steps(1, jump-end)";
  const b = bezierOf(e);
  if (b) return `cubic-bezier(${b.map((v) => Math.round(v * 1000) / 1000).join(", ")})`;
  const pts = Array.from({ length: samples + 1 }, (_, i) => Math.round(easingAt(e, i / samples) * 1000) / 1000);
  return `linear(${pts.join(", ")})`;
}

// ---- The spring editor's handle (§4.7: x = π / ω₀, y = 2 − 2·clamp(ζ, 0, 1)^0.87) ------------------------------------

/** Where the handle sits for a bounce, in the graph's units: x the first peak's place in the normalised segment, y Figma's. */
export function springHandle(bounce: number): { x: number; y: number } {
  const s = normalizedToPhysicalSpring(bounce);
  const zeta = Math.min(1, Math.max(0, 1 - bounce));
  const w0 = omega(s);
  // π / ω₀ in seconds, then as a part of the played (normalised) segment [ours: the graph is normalised, §4.7].
  return { x: Math.min(1, Math.PI / w0 / springSettle(s)), y: 2 - 2 * Math.pow(zeta, 0.87) };
}

/** The bounce a dragged handle height gives (the inverse of y = 2 − 2ζ^0.87), 0–1. */
export function bounceAtHandle(y: number): number {
  const zeta = Math.pow(Math.min(1, Math.max(0, (2 - y) / 2)), 1 / 0.87);
  return Math.round(Math.min(1, Math.max(0, 1 - zeta)) * 100) / 100;
}

// ---- MotionEasing ↔ EasingData ----------------------------------------------------------------------------------

/** The schema's EasingData (JSON, as the engine reads and writes it). */
export interface EasingData {
  easingType?: string;
  easingValue?: {
    bezierEasing?: { p1x?: number; p1y?: number; p2x?: number; p2y?: number };
    springEasing?: { mass?: number; stiffness?: number; damping?: number; springType?: string };
  };
}

/** A public easing as an EasingData (a custom spring stored physical, played normalised; §4.7). */
export function easingToData(e: MotionEasing): EasingData {
  const out: EasingData = { easingType: EASING_SCHEMA_TYPE[e.type] };
  if (e.type === "CUSTOM_CUBIC_BEZIER") {
    const b = e.easingFunctionCubicBezier ?? DEFAULT_KEYFRAME_EASING.easingFunctionCubicBezier!;
    out.easingValue = { bezierEasing: { p1x: b.x1, p1y: b.y1, p2x: b.x2, p2y: b.y2 } };
  } else if (e.type === "CUSTOM_SPRING") {
    out.easingValue = { springEasing: { ...normalizedToPhysicalSpring(e.easingFunctionSpring?.bounce ?? 0.25), springType: "NORMALIZED" } };
  }
  return out;
}

/** An EasingData as the public easing (IN_CUBIC, absent or unknown: the keyframe default, §4.7). */
export function easingFromData(d: EasingData | null | undefined): MotionEasing {
  const schema = d?.easingType;
  if (!schema || schema === "IN_CUBIC") return DEFAULT_KEYFRAME_EASING;
  const type = schema === "SPRING" ? "GENTLE" : MOTION_EASING_TYPES.find((t) => EASING_SCHEMA_TYPE[t] === schema);
  if (!type) return DEFAULT_KEYFRAME_EASING;
  if (type === "CUSTOM_CUBIC_BEZIER") {
    const b = d?.easingValue?.bezierEasing ?? {};
    return { type, easingFunctionCubicBezier: { x1: b.p1x ?? 0.5, y1: b.p1y ?? 0, x2: b.p2x ?? 0.5, y2: b.p2y ?? 1 } };
  }
  if (type === "CUSTOM_SPRING") {
    const s = d?.easingValue?.springEasing ?? {};
    let bounce = 0.25;
    try {
      bounce = physicalSpringToNormalized({ mass: s.mass ?? 1, stiffness: s.stiffness ?? 100, damping: s.damping ?? 15 });
    } catch {
      bounce = physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 10 }); // Figma's fallback spring
    }
    return { type, easingFunctionSpring: { bounce: Math.round(bounce * 1000) / 1000 } };
  }
  return { type };
}

/** An easing's name with its numbers (a custom bezier's four, a custom spring's bounce). */
export function easingNumbers(e: MotionEasing): string | null {
  const b = e.easingFunctionCubicBezier;
  if (e.type === "CUSTOM_CUBIC_BEZIER" && b) return [b.x1, b.y1, b.x2, b.y2].map((v) => Math.round(v * 100) / 100).join(", ");
  if (e.type === "CUSTOM_SPRING" && e.easingFunctionSpring) return String(Math.round(e.easingFunctionSpring.bounce * 100) / 100);
  return null;
}
