// The collages' timing (docs/site.md §2): a scene plays its script once, when it first comes into view, then idles
// with small, calm motions while it stays on screen. Under `prefers-reduced-motion` every wait and tween ends at once,
// so the script runs straight to its end state. Off screen, waits hold until the scene is visible again (idle loops
// cost nothing there) and the stage's CSS animations pause (`visible`, kit.module.css).
//
// Scripts change state in steps; the motion between the steps is CSS transitions and the Web Animations API (on the
// compositor). Per-frame work is only for numbers counting (ticker.ts) and the odd tween a script still needs.
import { useEffect, useRef, useState, type RefObject } from "react";
import { ease as EASE } from "./easing";
import { typingDelays } from "./path";
import { prefersReduced } from "./reduced";
import { onFrame } from "./ticker";

export { prefersReduced };

const GONE = Symbol("scene gone");

export interface Run {
  /** After `ms` (at once under reduced motion); holds while the scene is off screen. */
  wait(ms: number): Promise<void>;
  /** Calls `step` with 0…1 (eased) on each frame for `ms`, ending on 1. */
  tween(ms: number, step: (t: number) => void, ease?: (t: number) => number): Promise<void>;
  /** Types `text` at a person's cadence (25–70 ms a key, pauses after punctuation), calling `set` with each prefix. */
  type(text: string, set: (typed: string) => void, seed?: number): Promise<void>;
  /** Reduced motion: no idle loops. */
  readonly reduced: boolean;
}

export interface SceneOptions {
  /** How much of the scene must show before it plays (default 0.3). */
  threshold?: number;
}

export interface SceneState {
  /** The script has started (the stage's `data-play`: the pieces settle in). */
  play: boolean;
  /** The scene is on screen (off screen its CSS animations pause). */
  visible: boolean;
}

/**
 * Plays `script` once the element is in view. The script should start with a wait: React's StrictMode runs effects
 * twice in development.
 */
export function useScene(ref: RefObject<HTMLElement | null>, script: (run: Run) => Promise<void>, options: SceneOptions = {}): SceneState {
  const [play, setPlay] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const threshold = options.threshold ?? 0.3;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = prefersReduced();
    let alive = true;
    let visible = false;
    let started = false;
    let wakers: (() => void)[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const frames = new Set<() => void>();

    const whenVisible = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (!alive) return reject(GONE);
        if (visible) return resolve();
        wakers.push(() => (alive ? resolve() : reject(GONE)));
      });

    const run: Run = {
      reduced,
      wait(ms) {
        if (!alive) return Promise.reject(GONE);
        if (reduced) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            timers.delete(t);
            resolve();
          }, ms);
          timers.add(t);
        }).then(whenVisible);
      },
      async tween(ms, step, ease = EASE.out) {
        if (!alive) throw GONE;
        if (reduced) return step(1);
        await whenVisible();
        await new Promise<void>((resolve, reject) => {
          let start = -1;
          const stop = onFrame((now) => {
            if (!alive) {
              stop();
              return reject(GONE);
            }
            if (start < 0) start = now;
            const t = Math.min(1, (now - start) / ms);
            step(ease(t));
            if (t >= 1) {
              stop();
              frames.delete(stop);
              resolve();
            }
          });
          frames.add(stop);
        });
      },
      async type(text, set, seed) {
        if (reduced) return set(text);
        const delays = typingDelays(text, seed);
        for (let i = 0; i < text.length; i++) {
          await run.wait(delays[i]);
          set(text.slice(0, i + 1));
        }
      },
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        setOnScreen(visible);
        if (visible) {
          const w = wakers;
          wakers = [];
          for (const wake of w) wake();
        }
        if (visible && !started) {
          started = true;
          setPlay(true);
          scriptRef.current(run).catch((error: unknown) => {
            if (error !== GONE) console.warn("[scene]", error);
          });
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
      for (const t of timers) clearTimeout(t);
      for (const stop of frames) stop();
      const w = wakers;
      wakers = [];
      for (const wake of w) wake();
    };
  }, [ref, threshold]);

  return { play, visible: onScreen };
}

/** Linear interpolation, rounded (a value counting in a panel field). */
export const mix = (a: number, b: number, t: number, round = true): number => (round ? Math.round(a + (b - a) * t) : a + (b - a) * t);
