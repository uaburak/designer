// The collages' timing (docs/site.md §2): a scene plays its script once, when it first comes into view, then may idle
// with small motions while it stays on screen. Under `prefers-reduced-motion` every wait and tween ends at once, so the
// script runs straight to its end state. Off screen, waits hold until the scene is visible again (idle loops cost
// nothing there).
import { useEffect, useRef, useState, type RefObject } from "react";

const GONE = Symbol("scene gone");

export const prefersReduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A slow, settling ease-out (the pieces' and the tweens' curve). */
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface Run {
  /** After `ms` (at once under reduced motion); holds while the scene is off screen. */
  wait(ms: number): Promise<void>;
  /** Calls `step` with 0…1 (eased) on each frame for `ms`, ending on 1. */
  tween(ms: number, step: (t: number) => void, ease?: (t: number) => number): Promise<void>;
  /** Reduced motion: no idle loops. */
  readonly reduced: boolean;
}

export interface SceneOptions {
  /** How much of the scene must show before it plays (default 0.3). */
  threshold?: number;
}

/**
 * Plays `script` once the element is in view; returns whether it has started (the stage's `data-play`, which lets the
 * pieces settle in). The script should start with a wait: React's StrictMode runs effects twice in development.
 */
export function useScene(ref: RefObject<HTMLElement | null>, script: (run: Run) => Promise<void>, options: SceneOptions = {}): boolean {
  const [play, setPlay] = useState(false);
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
    const frames = new Set<number>();

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
      async tween(ms, step, ease = easeOut) {
        if (!alive) throw GONE;
        if (reduced) return step(1);
        await whenVisible();
        await new Promise<void>((resolve, reject) => {
          const start = performance.now();
          const frame = (now: number) => {
            if (!alive) return reject(GONE);
            const t = Math.min(1, (now - start) / ms);
            step(ease(t));
            if (t < 1) {
              const id = requestAnimationFrame(frame);
              frames.add(id);
            } else resolve();
          };
          frames.add(requestAnimationFrame(frame));
        });
      },
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
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
      for (const f of frames) cancelAnimationFrame(f);
      const w = wakers;
      wakers = [];
      for (const wake of w) wake();
    };
  }, [ref, threshold]);

  return play;
}

/** Linear interpolation, rounded (a value counting in a panel field). */
export const mix = (a: number, b: number, t: number, round = true): number => (round ? Math.round(a + (b - a) * t) : a + (b - a) * t);
