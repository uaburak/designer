// The site's motion tokens (docs/site.md §2): one place for every curve and duration the pages and the collages use.
// `installMotionTokens` writes them onto :root as CSS custom properties, so the stylesheets and the scripts share
// exactly the same curves:
//   --ease-out       expressive ease-out, for things entering (pieces, text, panels);
//   --ease-standard  a softer curve for state changes (colours swapping, a highlight moving, a box resizing);
//   --ease-glide     an ease-in-out with a long, soft landing, for cursors and drags;
//   --ease-spring    a gentle spring (a `linear()` curve with many stops), for things that settle: pins dropping,
//                    toggles, cards landing; --ease-spring-snap is a quicker, firmer one (presses, handles);
//   --dur-1 … --dur-5  240, 360, 520, 720, 900 ms; `durationFor` picks one by the distance travelled.
// Everything here is pure (no DOM), so it is unit tested (easing.test.ts).

export type Bezier = readonly [number, number, number, number];

export const BEZIER = {
  out: [0.16, 1, 0.3, 1],
  standard: [0.4, 0, 0.2, 1],
  glide: [0.55, 0, 0.2, 1],
  /** Leaving: a quick start, for things fading away. */
  in: [0.4, 0, 1, 1],
} as const satisfies Record<string, Bezier>;

export const DURATION = { xs: 240, s: 360, m: 520, l: 720, xl: 900 } as const;

export const css = (b: Bezier): string => `cubic-bezier(${b.join(", ")})`;

/** A CSS cubic-bezier as a function of time (0…1 → 0…1): Newton's method on x, bisection when it stalls. */
export function cubicBezier([x1, y1, x2, y2]: Bezier): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (x: number): number => {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(u) - x;
      if (Math.abs(e) < 1e-6) return u;
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : sy(solve(t)));
}

export const ease = {
  out: cubicBezier(BEZIER.out),
  standard: cubicBezier(BEZIER.standard),
  glide: cubicBezier(BEZIER.glide),
  linear: (t: number) => t,
};

export interface SpringOptions {
  stiffness: number;
  damping: number;
  mass?: number;
}

export const SPRING = {
  /** Settles with one soft overshoot (~3%): cards landing, pins, toggles. */
  gentle: { stiffness: 180, damping: 22 },
  /** Quicker and firmer: a press springing back, handles popping in. */
  snap: { stiffness: 420, damping: 30 },
} as const satisfies Record<string, SpringOptions>;

/**
 * A damped spring from 0 to 1, sampled every `step` ms until it rests (within 0.1% and nearly still).
 * Returns the samples (first 0, last exactly 1) and how long it takes, ms.
 */
export function springSamples({ stiffness, damping, mass = 1 }: SpringOptions, step = 1000 / 60): { values: number[]; duration: number } {
  let x = 0; // position, 0 → 1
  let v = 0;
  const values = [0];
  const dt = step / 1000;
  const sub = 8;
  for (let frame = 1; frame < 600; frame++) {
    for (let i = 0; i < sub; i++) {
      const a = (-stiffness * (x - 1) - damping * v) / mass;
      v += a * (dt / sub);
      x += v * (dt / sub);
    }
    values.push(x);
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break;
  }
  values[values.length - 1] = 1;
  return { values, duration: Math.round((values.length - 1) * step) };
}

/** Samples as a CSS `linear()` easing (evenly spaced stops), rounded to 4 places. */
export function linearEasing(values: readonly number[]): string {
  return `linear(${values.map((v) => +v.toFixed(4)).join(", ")})`;
}

/** A spring as a CSS easing and its natural duration (fewer stops: every other frame is plenty for `linear()`). */
export function springEasing(options: SpringOptions): { easing: string; duration: number } {
  const { values, duration } = springSamples(options, 1000 / 30);
  return { easing: linearEasing(values), duration };
}

/** How long a move of `distance` px takes: short hops are quick, long glides slower, within 240…900 ms. */
export function durationFor(distance: number, min: number = DURATION.xs, max: number = DURATION.xl): number {
  return Math.round(Math.min(max, Math.max(min, 220 + 26 * Math.sqrt(Math.max(0, distance)))));
}

/** The CSS custom properties, by name (installMotionTokens and the tests read these). */
export function motionTokens(): Record<string, string> {
  const gentle = springEasing(SPRING.gentle);
  const snap = springEasing(SPRING.snap);
  return {
    "--ease-out": css(BEZIER.out),
    "--ease-standard": css(BEZIER.standard),
    "--ease-glide": css(BEZIER.glide),
    "--ease-in": css(BEZIER.in),
    "--ease-spring": gentle.easing,
    "--ease-spring-snap": snap.easing,
    "--dur-spring": `${gentle.duration}ms`,
    "--dur-spring-snap": `${snap.duration}ms`,
    "--dur-1": `${DURATION.xs}ms`,
    "--dur-2": `${DURATION.s}ms`,
    "--dur-3": `${DURATION.m}ms`,
    "--dur-4": `${DURATION.l}ms`,
    "--dur-5": `${DURATION.xl}ms`,
  };
}

/** Writes the tokens onto :root (once per page, before anything animates). */
export function installMotionTokens(root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(motionTokens())) root.style.setProperty(k, v);
}
