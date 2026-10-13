// The scenes' timeline: every scene is a loop of `L` ms, and each moving part is one Web Animation over
// the whole loop, its keyframes placed at milliseconds. All of a scene's animations start together and
// pause together, so they never drift. The markup itself is the final frame: under
// prefers-reduced-motion (or without JS) nothing is animated and the scene shows it, still.

export type Props = Record<string, string | number>;
/** [time in ms, values, easing of the move that arrives at this key]. */
export type Key = [number, Props, string?];

export const EASE = {
  move: "cubic-bezier(.55,0,.25,1)",
  out: "cubic-bezier(.2,.8,.2,1)",
  pop: "cubic-bezier(.3,1.4,.5,1)",
  in: "cubic-bezier(.5,0,.75,.5)",
  linear: "linear",
  step: "steps(1, end)",
};

export class Timeline {
  readonly anims: Animation[] = [];
  constructor(
    readonly root: Element,
    readonly L: number,
  ) {}

  /** The element under `root` marked `data-k="key"`. */
  el(key: string): Element {
    const e = this.root.querySelector(`[data-k="${key}"]`);
    if (!e) throw new Error(`scene part missing: ${key}`);
    return e;
  }

  all(key: string): Element[] {
    return [...this.root.querySelectorAll(`[data-k="${key}"]`)];
  }

  /** Animates `target` through `keys`. Values missing from a key hold the previous key's. */
  track(target: Element | string, keys: Key[], defaultEase: string = EASE.out, composite: CompositeOperation = "replace"): Animation {
    const el = typeof target === "string" ? this.el(target) : target;
    const sorted = [...keys].sort((a, b) => a[0] - b[0]);
    const names = new Set<string>();
    for (const [, p] of sorted) for (const n of Object.keys(p)) names.add(n);
    // Forward-fill, then back-fill the first keys from the first value given.
    const filled: Props[] = [];
    let last: Props = {};
    for (const [, p] of sorted) filled.push((last = { ...last, ...p }));
    for (const n of names) {
      const first = filled.find((f) => n in f)![n];
      for (const f of filled) if (!(n in f)) f[n] = first;
    }
    const frames: Keyframe[] = filled.map((p, i) => ({ ...p, offset: clamp01(sorted[i][0] / this.L) }));
    // The easing of a key describes the move into it, so it belongs to the key before.
    for (let i = 1; i < frames.length; i++) frames[i - 1].easing = sorted[i][2] ?? defaultEase;
    if (frames[0].offset !== 0) frames.unshift({ ...frames[0], offset: 0, easing: "linear" });
    if (frames[frames.length - 1].offset !== 1) frames.push({ ...frames[frames.length - 1], offset: 1, easing: "linear" });
    const a = el.animate(frames, { duration: this.L, iterations: Infinity, fill: "both", composite });
    a.pause();
    this.anims.push(a);
    return a;
  }

  /** Shown from `on` (fading in over `fade` ms) until `off` (fading out), else hidden. */
  show(target: Element | string, on: number, off: number, fade = 240, extra?: { from?: Props; to?: Props }): Animation {
    const from = extra?.from ?? {};
    const to = extra?.to ?? {};
    return this.track(target, [
      [0, { opacity: 0, ...from }],
      [on, { opacity: 0, ...from }],
      [on + fade, { opacity: 1, ...to }, EASE.out],
      [off, { opacity: 1, ...to }],
      [off + fade, { opacity: 0, ...to }, EASE.in],
    ]);
  }

  /** Draws a path's stroke from its start to its end between `t0` and `t1`; it fades at `out`. */
  draw(target: Element | string, t0: number, t1: number, ease: string, out: number): Animation {
    const path = (typeof target === "string" ? this.el(target) : target) as SVGGeometryElement;
    const len = Math.ceil(path.getTotalLength()) + 1;
    (path as SVGElement).style.strokeDasharray = `${len} ${len}`;
    return this.track(path, [
      [0, { strokeDashoffset: len, opacity: 1 }],
      [t0, { strokeDashoffset: len }],
      [t1, { strokeDashoffset: 0 }, ease],
      [out, { strokeDashoffset: 0, opacity: 1 }],
      [out + 400, { strokeDashoffset: 0, opacity: 0 }, EASE.in],
    ]);
  }

  /** `off` until `t`, then `on` (over `dur` ms) — until `reset`, when it snaps back to `off` (unseen). */
  turn(target: Element | string, t: number, off: Props, on: Props, dur = 300, reset?: number, ease: string = EASE.out): Animation {
    const keys: Key[] = [
      [0, off],
      [t, off],
      [t + dur, on, ease],
    ];
    if (reset !== undefined) keys.push([reset, on], [reset + 1, off, EASE.step]);
    return this.track(target, keys);
  }

  /** A quick press at `t`: scale down and back, added on top of the element's other moves. */
  press(target: Element | string, t: number, scale = 0.86): Animation {
    return this.track(
      target,
      [
        [0, { transform: "scale(1)" }],
        [t, { transform: "scale(1)" }],
        [t + 90, { transform: `scale(${scale})` }, EASE.out],
        [t + 260, { transform: "scale(1)" }, EASE.out],
      ],
      EASE.out,
      "add",
    );
  }

  play(): void {
    for (const a of this.anims) a.play();
  }

  pause(): void {
    for (const a of this.anims) a.pause();
  }

  cancel(): void {
    for (const a of this.anims) a.cancel();
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export const tr = (x: number, y: number) => `translate(${x}px, ${y}px)`;

export interface SceneDef {
  /** The loop's length in ms. */
  L: number;
  build(tl: Timeline): void;
  /** Called on mount (also when still): e.g. to fit the viewBox to the width. */
  setup?(root: Element): void;
}

const registry = new Map<string, SceneDef>();

export function defineScene(name: string, def: SceneDef): void {
  registry.set(name, def);
}

/** Mounts every `[data-scene]` on the page: built and played while on screen, paused off it. */
export function mountScenes(): void {
  document.documentElement.classList.add("scenes-ready");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const live = new Map<Element, Timeline>();
  const roots = [...document.querySelectorAll("[data-scene]")];
  for (const root of roots) registry.get(root.getAttribute("data-scene") ?? "")?.setup?.(root);

  const still = () => {
    for (const tl of live.values()) tl.cancel();
    live.clear();
    for (const root of roots) root.classList.add("is-on");
  };
  if (reduce.matches || typeof Element.prototype.animate !== "function") {
    still();
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const root = e.target;
        let tl = live.get(root);
        if (e.isIntersecting) {
          if (!tl) {
            const def = registry.get(root.getAttribute("data-scene") ?? "");
            if (!def) {
              root.classList.add("is-on");
              continue;
            }
            tl = new Timeline(root, def.L);
            try {
              def.build(tl);
            } catch (err) {
              tl.cancel();
              root.classList.add("is-on");
              console.error(err);
              continue;
            }
            live.set(root, tl);
            root.classList.add("is-on");
          }
          tl.play();
        } else {
          tl?.pause();
        }
      }
    },
    { threshold: 0 },
  );
  for (const root of roots) io.observe(root);

  reduce.addEventListener("change", () => {
    if (reduce.matches) {
      io.disconnect();
      still();
    }
  });
}
