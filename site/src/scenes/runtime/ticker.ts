// One requestAnimationFrame loop for every per-frame update on the page (number tweens, the visitor's cursor): the
// callbacks of a frame run together, and the loop stops when nobody is listening. Everything else animates in CSS or
// the Web Animations API, off the main thread.
import { createElement, useEffect, useRef, useState, type CSSProperties } from "react";
import { DURATION, ease as EASE } from "./easing";
import { prefersReduced } from "./reduced";

type Frame = (now: number) => void;
const subs = new Set<Frame>();
let raf = 0;

function loop(now: number) {
  raf = 0;
  for (const f of [...subs]) f(now);
  if (subs.size && !raf) raf = requestAnimationFrame(loop);
}

/** Calls `fn` on every frame until the returned function is called. */
export function onFrame(fn: Frame): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    subs.delete(fn);
  };
}

/**
 * A number that glides to each new `value` (from wherever it is now) over `ms` on `ease`, rounded to `precision`
 * places. Only the component using it re-renders, once per frame while it moves. Reduced motion: it jumps.
 */
export function useTween(value: number, ms: number = DURATION.m, ease: (t: number) => number = EASE.standard, precision = 0): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    const round = (v: number) => {
      const k = 10 ** precision;
      return Math.round(v * k) / k;
    };
    if (prefersReduced() || ms <= 0) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    let start = -1;
    const stop = onFrame((now) => {
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / ms);
      const v = t >= 1 ? value : round(from + (value - from) * ease(t));
      shownRef.current = t >= 1 ? value : from + (value - from) * ease(t);
      setShown(v);
      if (t >= 1) stop();
    });
    return stop;
  }, [value, ms, ease, precision]);
  return shown;
}

/** A number in text that tweens to its value (tabular figures, so the digits don't jostle). */
export function Tween({ value, ms, ease, format = (v: number) => v.toLocaleString("en-US"), className, style }: { value: number; ms?: number; ease?: (t: number) => number; format?: (v: number) => string; className?: string; style?: CSSProperties }) {
  const v = useTween(value, ms, ease);
  return createElement("span", { className, style: { fontVariantNumeric: "tabular-nums", ...style } }, format(v));
}
