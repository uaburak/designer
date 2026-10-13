// Figma's prototype easings as the Web Animations API plays them: the cubic curves as cubic-bezier(), the springs
// (mass, stiffness, damping — Figma's presets) simulated once and played as CSS linear() at the time they settle.

export type Curve = { kind: "bezier"; p: [number, number, number, number] } | { kind: "spring"; m: number; k: number; c: number };

export const CURVES: Record<string, Curve> = {
  LINEAR: { kind: "bezier", p: [0, 0, 1, 1] },
  IN_CUBIC: { kind: "bezier", p: [0.42, 0, 1, 1] },
  OUT_CUBIC: { kind: "bezier", p: [0, 0, 0.58, 1] },
  INOUT_CUBIC: { kind: "bezier", p: [0.42, 0, 0.58, 1] },
  IN_BACK_CUBIC: { kind: "bezier", p: [0.3, -0.05, 0.7, -0.5] },
  OUT_BACK_CUBIC: { kind: "bezier", p: [0.45, 1.45, 0.8, 1] },
  INOUT_BACK_CUBIC: { kind: "bezier", p: [0.7, -0.4, 0.4, 1.4] },
  GENTLE_SPRING: { kind: "spring", m: 1, k: 100, c: 15 },
  SPRING_PRESET_ONE: { kind: "spring", m: 1, k: 300, c: 20 },
  SPRING_PRESET_TWO: { kind: "spring", m: 1, k: 600, c: 15 },
  SPRING_PRESET_THREE: { kind: "spring", m: 1, k: 80, c: 20 },
};

/** A spring from 0 to 1, sampled every 1/240 s until it rests. */
function springSamples(m: number, k: number, c: number): { values: number[]; ms: number } {
  const dt = 1 / 240;
  let x = 0;
  let v = 0;
  const values = [0];
  let t = 0;
  while (t < 4) {
    const a = (-k * (x - 1) - c * v) / m;
    v += a * dt;
    x += v * dt;
    t += dt;
    values.push(x);
    if (Math.abs(x - 1) < 0.0015 && Math.abs(v) < 0.01 && t > 0.1) break;
  }
  values[values.length - 1] = 1;
  return { values, ms: Math.round(t * 1000) };
}

const linearSupported = () => typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", "linear(0, 0.5, 1)");

export interface Timing {
  easing: string;
  duration: number;
  /** The curve's points (x 0–1 over time, y the progress) for the panel's graph */
  points: [number, number][];
}

export function timingOf(easing: string, durationMs: number): Timing {
  const curve = CURVES[easing] ?? CURVES.OUT_CUBIC;
  if (curve.kind === "bezier") {
    const [x1, y1, x2, y2] = curve.p;
    const points: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const u = 1 - t;
      points.push([3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t, 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t]);
    }
    return { easing: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`, duration: durationMs, points };
  }
  const { values, ms } = springSamples(curve.m, curve.k, curve.c);
  const step = Math.max(1, Math.floor(values.length / 48));
  const kept = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const points = kept.map((y, i) => [i / (kept.length - 1), y] as [number, number]);
  const easingCss = linearSupported() ? `linear(${kept.map((y) => y.toFixed(4)).join(", ")})` : "cubic-bezier(0.2, 0.9, 0.3, 1.1)";
  return { easing: easingCss, duration: ms, points };
}
