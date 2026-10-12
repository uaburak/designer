/**
 * The built-in brushes' artwork (docs/draw.md §6, round 7e): OUR OWN, generated procedurally from a recipe and a fixed
 * seed per brush — nothing is traced from or modelled on Figma's artwork; only the 25 names are Figma's (the plugin
 * API's `brushName` enum), so plugin and `.fig` round trips agree.
 *
 * Deterministic and pure: no Math.random, no Date, no platform-dependent formatting (numbers are rounded to 2
 * decimals and printed with `String`). `scripts/brushes.mjs` writes the result to `builtin.generated.json` (committed);
 * `index.ts` serves it. Only `import type` here, so Node runs this file directly (type stripping) without a bundler.
 *
 * Stretch artwork: 256 × 16, x along the stroke, y across, filling the height at its thickest. Scatter stamps: 64 × 64,
 * centred. Every region is a closed subpath (… Z), NONZERO; a hole (the ring) winds the other way.
 */
import type { BrushArtwork, BrushType, ScatterBrushName, StretchBrushName } from "../types";

export const STRETCH_SIZE = { width: 256, height: 16 } as const;
export const SCATTER_SIZE = { width: 64, height: 64 } as const;
/** docs/draw.md §6's budget: at most this many path commands (M L Q C Z) per brush. */
export const MAX_COMMANDS = 400;

export interface GeneratedBrush {
  key: StretchBrushName | ScatterBrushName;
  type: BrushType;
  artwork: BrushArtwork;
}

// ---- Deterministic helpers -----------------------------------------------------------------------------------------

/** mulberry32: a 32-bit seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A brush's seed: FNV-1a of its key, so adding or reordering recipes never changes another brush. */
function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** 1-D value noise in [−1, 1]: `knots` random values, smoothstep-interpolated. */
function valueNoise(rand: () => number, knots: number): (t: number) => number {
  const v = Array.from({ length: knots + 1 }, () => rand() * 2 - 1);
  return (t) => {
    const x = Math.min(Math.max(t, 0), 1) * knots;
    const i = Math.min(Math.floor(x), knots - 1);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return v[i] * (1 - s) + v[i + 1] * s;
  };
}

const r2 = (v: number): string => {
  const n = Math.round(v * 100) / 100;
  return String(Object.is(n, -0) ? 0 : n);
};

/** Absolute SVG path data, clamped into the brush's box, counting its commands. */
class PathBuilder {
  private parts: string[] = [];
  commands = 0;
  private readonly w: number;
  private readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  private pt(x: number, y: number): string {
    return `${r2(Math.min(Math.max(x, 0), this.w))} ${r2(Math.min(Math.max(y, 0), this.h))}`;
  }
  /** A closed polygon. */
  poly(points: readonly (readonly [number, number])[]): this {
    if (points.length < 3) return this;
    this.parts.push(`M${this.pt(points[0][0], points[0][1])}`);
    for (let i = 1; i < points.length; i++) this.parts.push(`L${this.pt(points[i][0], points[i][1])}`);
    this.parts.push("Z");
    this.commands += points.length + 1;
    return this;
  }
  /** A closed ellipse of four cubics; `reverse` winds it counter-clockwise (a hole under NONZERO). */
  ellipse(cx: number, cy: number, rx: number, ry: number, reverse = false): this {
    const k = 0.5522847498;
    const s = reverse ? -1 : 1;
    this.parts.push(`M${this.pt(cx + rx, cy)}`);
    const quads: [number, number][] = [
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ];
    let px = rx;
    let py = 0;
    for (const [qx, qy] of quads) {
      const nx = qx * rx;
      const ny = qy * ry * s;
      // a quarter arc from P to N (both on the axes): c1 = P + k·N, c2 = N + k·P
      this.parts.push(`C${this.pt(cx + px + k * nx, cy + py + k * ny)} ${this.pt(cx + nx + k * px, cy + ny + k * py)} ${this.pt(cx + nx, cy + ny)}`);
      px = nx;
      py = ny;
    }
    this.parts.push("Z");
    this.commands += 6;
    return this;
  }
  /** A closed shape of cubics through `points` (Catmull-Rom → Bézier), for soft outlines. */
  smooth(points: readonly (readonly [number, number])[]): this {
    const n = points.length;
    if (n < 3) return this;
    this.parts.push(`M${this.pt(points[0][0], points[0][1])}`);
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];
      const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      this.parts.push(`C${this.pt(c1[0], c1[1])} ${this.pt(c2[0], c2[1])} ${this.pt(p2[0], p2[1])}`);
    }
    this.parts.push("Z");
    this.commands += n + 2;
    return this;
  }
  get d(): string {
    return this.parts.join(" ");
  }
}

// ---- Stretch brushes -----------------------------------------------------------------------------------------------

const SW = STRETCH_SIZE.width;
const SH = STRETCH_SIZE.height;
const CY = SH / 2;

/**
 * A stroke body between x0 and x1: `half(t)` the half-width above / below the centre line `centre(t)`, t in [0, 1]
 * along the body; `n` samples a side. Returned as one closed polygon (top edge forward, bottom edge back).
 */
function body(
  x0: number,
  x1: number,
  n: number,
  half: (t: number) => number | readonly [number, number],
  centre: (t: number) => number = () => CY,
): [number, number][] {
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const h = half(t);
    const [up, down] = typeof h === "number" ? [h, h] : h;
    const c = centre(t);
    top.push([x, c - Math.max(up, 0)]);
    bottom.push([x, c + Math.max(down, 0)]);
  }
  // pointed ends collapse into one point; keep both otherwise (square ends)
  return [...top, ...bottom.reverse()];
}

/** Rises from 0 to 1 over `a` at both ends (a pointed taper), 1 between. */
const taper = (t: number, a: number, b = a): number => Math.min(1, t / a, (1 - t) / b);
/** A smooth bump centred at c with half-width w, 0 outside. */
const bump = (t: number, c: number, w: number): number => {
  const u = (t - c) / w;
  return Math.abs(u) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * u);
};

type Recipe = (p: PathBuilder, rand: () => number) => void;

const STRETCH_RECIPES: Record<StretchBrushName, Recipe> = {
  /** A calligraphic ink stroke, pointed at both ends, a slight asymmetric swell. */
  HEIST: (p, rand) => {
    const wob = valueNoise(rand, 6);
    p.poly(body(0, SW, 80, (t) => {
      const s = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.7) * (1 + 0.06 * wob(t));
      return [8 * s, 7 * s];
    }));
  },
  /** A broad flat marker, square ends, faint streaks (3 inner gaps). */
  BLOCKBUSTER: (p, rand) => {
    const bands = [
      [0, 3.6],
      [4.2, 7.7],
      [8.3, 11.8],
      [12.4, 16],
    ];
    for (const [y0, y1] of bands) {
      const s = 2 + rand() * 2;
      const e = SW - 2 - rand() * 2;
      p.poly([
        [s, y0],
        [e, y0],
        [e + 1.5, y1],
        [s + 1.5, y1],
      ]);
    }
  },
  /** A dry brush: ragged edges (noise 25 %), 4–6 random gaps through the body. */
  GRINDHOUSE: (p, rand) => {
    const gaps = 4 + Math.floor(rand() * 3);
    const cuts = Array.from({ length: gaps }, (_, i) => ((i + 0.5 + (rand() - 0.5) * 0.6) / gaps) * SW).sort((a, b) => a - b);
    const edgeT = valueNoise(rand, 40);
    const edgeB = valueNoise(rand, 40);
    let x = 0;
    for (const c of [...cuts, SW + 3]) {
      const gw = 2 + rand() * 4;
      const x1 = Math.min(c - gw / 2, SW);
      if (x1 - x > 3) {
        const a = x;
        p.poly(body(a, x1, Math.max(4, Math.round((x1 - a) / 4)), (t) => {
          const g = (a + (x1 - a) * t) / SW;
          const f = Math.min(1, g / 0.04, (1 - g) / 0.04);
          return [8 * f * (1 - 0.25 * Math.abs(edgeT(g))), 8 * f * (1 - 0.25 * Math.abs(edgeB(g)))];
        }));
      }
      x = c + gw / 2;
    }
  },
  /** A fine pen: thin (40 % height), a gentle pressure swell in the first third. */
  BIOPIC: (p) => {
    p.poly(body(0, SW, 60, (t) => 3.2 * taper(t, 0.03, 0.06) * (0.65 + 0.35 * bump(t, 0.2, 0.18))));
  },
  /** Bristles: 5 parallel streaks of varying width that start and end at random. */
  SPAGHETTI_WESTERN: (p, rand) => {
    for (let i = 0; i < 5; i++) {
      const cy = 1.6 + i * 3.2;
      const w = 0.6 + rand() * 0.9;
      const x0 = rand() * 30;
      const x1 = SW - rand() * 30;
      const wob = valueNoise(rand, 8);
      p.poly(body(x0, x1, 32, (t) => w * taper(t, 0.08) * (1 + 0.2 * wob(t)), () => cy));
    }
  },
  /** A fast slash: thick start, long taper to a point. */
  SLASHER: (p) => {
    p.poly(body(0, SW, 60, (t) => 8 * Math.min(1, t / 0.025) * Math.pow(1 - t, 1.4)));
  },
  /** Charcoal: a full body with a fine noisy edge (high-frequency noise 10 %). */
  HARDBOILED: (p, rand) => {
    const nt = valueNoise(rand, 90);
    const nb = valueNoise(rand, 90);
    p.poly(body(0, SW, 120, (t) => {
      const f = taper(t, 0.05);
      return [8 * f * (0.9 + 0.1 * nt(t)), 8 * f * (0.9 + 0.1 * nb(t))];
    }));
  },
  /** Pencil grain: a thin body broken into short speckles. */
  VERITE: (p, rand) => {
    let x = 1;
    while (x < SW - 3) {
      const len = 2 + rand() * 4;
      const x1 = Math.min(x + len, SW - 1);
      const g = (x + x1) / 2 / SW;
      const h = 2.6 * taper(g, 0.08) + 0.4;
      const yc = CY + (rand() - 0.5) * 2 * (2.6 - h * 0.5);
      const a = h * (0.5 + rand() * 0.5);
      const b = h * (0.5 + rand() * 0.5);
      p.poly([
        [x, yc - a],
        [x1, yc - b],
        [x1 - 0.4, yc + a],
        [x + 0.3, yc + b],
      ]);
      x = x1 + 1 + rand() * 2;
    }
  },
  /** A thick–thin wave: the width varies as a sine over the length. */
  EPIC: (p) => {
    p.poly(body(0, SW, 96, (t) => taper(t, 0.04) * (1.2 + 6.8 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t - Math.PI / 2)))));
  },
  /** A wobbly line whose centre wanders ± 20 %. */
  SCREWBALL: (p, rand) => {
    const c = valueNoise(rand, 10);
    p.poly(body(0, SW, 96, (t) => 3.5 * taper(t, 0.03), (t) => CY + 3.2 * c(t) * Math.min(1, t / 0.1, (1 - t) / 0.1)));
  },
  /** A soft round marker: round ends, even width. */
  ROM_COM: (p) => {
    const r = 6;
    const pts: [number, number][] = [];
    const cap = 10;
    // right cap (top → bottom), then left cap (bottom → top)
    for (let i = 0; i <= cap; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / cap;
      pts.push([SW - r - 2 + r * Math.cos(a), CY + r * Math.sin(a)]);
    }
    for (let i = 0; i <= cap; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / cap;
      pts.push([r + 2 + r * Math.cos(a), CY + r * Math.sin(a)]);
    }
    p.poly(pts);
  },
  /** Ink with splatter: a tapered body plus 6–10 small blobs beside it. */
  NOIR: (p, rand) => {
    p.poly(body(0, SW, 72, (t) => 5.5 * Math.pow(Math.sin(Math.PI * t), 0.6)));
    const blobs = 6 + Math.floor(rand() * 5);
    for (let i = 0; i < blobs; i++) {
      const x = 12 + rand() * (SW - 24);
      const side = rand() < 0.5 ? -1 : 1;
      const r = 0.6 + rand() * 0.9;
      const y = CY + side * (5.5 + r + rand() * (2.4 - r));
      p.ellipse(x, Math.min(Math.max(y, r), SH - r), r, r);
    }
  },
  /** Woodcut: a chunky body with notched straight-cut edges. */
  PROPAGANDA: (p, rand) => {
    const steps = (): [number, number][] => {
      const out: [number, number][] = [];
      let x = 4;
      while (x < SW - 4) {
        const nx = Math.min(x + 8 + rand() * 14, SW - 4);
        out.push([x, nx]);
        x = nx;
      }
      return out;
    };
    const top: [number, number][] = [];
    for (const [a, b] of steps()) {
      const h = 5.6 + rand() * 2.4;
      top.push([a, CY - h], [b, CY - h]);
    }
    const bottom: [number, number][] = [];
    for (const [a, b] of steps()) {
      const h = 5.6 + rand() * 2.4;
      bottom.push([a, CY + h], [b, CY + h]);
    }
    // straight slanted cuts at both ends
    p.poly([[0, CY - 4], ...top, [SW, CY + 4], ...bottom.reverse()]);
  },
  /** A dramatic swell: thin ends, a wide belly at 60 %. */
  MELODRAMA: (p) => {
    p.poly(body(0, SW, 80, (t) => taper(t, 0.02) * (0.6 + 7.4 * Math.pow(bump(t, 0.6, 0.55), 1.2))));
  },
  /** A double line: two thin parallel strokes. */
  NEW_WAVE: (p) => {
    for (const cy of [3.5, 12.5]) p.poly(body(0, SW, 40, (t) => 1.6 * taper(t, 0.04), () => cy));
  },
};

// ---- Scatter stamps ------------------------------------------------------------------------------------------------

const C = SCATTER_SIZE.width / 2;

function radial(n: number, r: (i: number, a: number) => number, start = -Math.PI / 2): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = start + (2 * Math.PI * i) / n;
    const rr = r(i, a);
    return [C + rr * Math.cos(a), C + rr * Math.sin(a)];
  });
}

const SCATTER_RECIPES: Record<ScatterBrushName, Recipe> = {
  /** A circle. */
  BUBBLEGUM: (p) => void p.ellipse(C, C, 28, 28),
  /** A five-point star. */
  WITCH_HOUSE: (p) => void p.poly(radial(10, (i) => (i % 2 ? 12 : 30))),
  /** A cluster of 3–5 soft dots. */
  SHOEGAZE: (p, rand) => {
    const n = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + rand() * 0.6;
      const d = 8 + rand() * 10;
      const r = 6 + rand() * 6;
      const x = Math.min(Math.max(C + d * Math.cos(a), r), 64 - r);
      const y = Math.min(Math.max(C + d * Math.sin(a), r), 64 - r);
      p.ellipse(x, y, r, r);
    }
  },
  /** A leaf (two arcs). */
  HONKY_TONK: (p) => {
    p.smooth([
      [6, 58],
      [14, 24],
      [58, 6],
      [50, 40],
    ]);
  },
  /** A jagged shard. */
  SCREAMO: (p, rand) => {
    p.poly(radial(9, (i) => (i % 2 ? 6 + rand() * 6 : 18 + rand() * 12)).map(([x, y]): [number, number] => [C + (x - C) * 0.7, y]));
  },
  /** A square. */
  DRONE: (p) => void p.poly([
    [8, 8],
    [56, 8],
    [56, 56],
    [8, 56],
  ]),
  /** A ring. */
  DOO_WOP: (p) => void p.ellipse(C, C, 28, 28).ellipse(C, C, 18, 18, true),
  /** A short rounded dash. */
  SPOKEN_WORD: (p) => {
    const r = 8;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 8;
      pts.push([56 - r + r * Math.cos(a), C + r * Math.sin(a)]);
    }
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / 8;
      pts.push([8 + r + r * Math.cos(a), C + r * Math.sin(a)]);
    }
    p.poly(pts);
  },
  /** A triangle. */
  VAPORWAVE: (p) => void p.poly(radial(3, () => 30, -Math.PI / 2).map(([x, y]): [number, number] => [x, y + 7])),
  /** An irregular splat blob. */
  OI: (p, rand) => {
    const n = valueNoise(rand, 8);
    p.smooth(radial(24, (i) => 20 + 6 * n(i / 24) + (rand() < 0.25 ? 6 + rand() * 4 : 0)));
  },
};

// ---- The set -------------------------------------------------------------------------------------------------------

function build(key: StretchBrushName | ScatterBrushName, type: BrushType, recipe: Recipe): GeneratedBrush {
  const size = type === "STRETCH" ? STRETCH_SIZE : SCATTER_SIZE;
  const p = new PathBuilder(size.width, size.height);
  recipe(p, rng(seedOf(key)));
  if (p.commands > MAX_COMMANDS) throw new Error(`brush ${key}: ${p.commands} commands (max ${MAX_COMMANDS})`);
  return { key, type, artwork: { width: size.width, height: size.height, d: p.d, windingRule: "NONZERO" } };
}

/**
 * All 25 built-ins, stretch then scatter, each list in the order of `names` (pass `STRETCH_BRUSH_NAMES` /
 * `SCATTER_BRUSH_NAMES` — taken as arguments so this file needs no value import).
 */
export function generateBrushes(stretch: readonly StretchBrushName[], scatter: readonly ScatterBrushName[]): GeneratedBrush[] {
  return [...stretch.map((k) => build(k, "STRETCH", STRETCH_RECIPES[k])), ...scatter.map((k) => build(k, "SCATTER", SCATTER_RECIPES[k]))];
}

/** The recipes' own keys (tests check them against the enum). */
export const RECIPE_KEYS = { stretch: Object.keys(STRETCH_RECIPES), scatter: Object.keys(SCATTER_RECIPES) };

/** The committed JSON's text for a set (stable: one-space indent, trailing newline). */
export function brushesJson(list: readonly GeneratedBrush[]): string {
  return JSON.stringify(list, null, 1) + "\n";
}
