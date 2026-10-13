// Small helpers the home page's scenes share (sizes, timing). No React components: each scene draws its own parts.
import { useLayoutEffect, useState, type RefObject } from "react";

export interface Size {
  w: number;
  h: number;
}

/** An element's content size, kept up to date (the scenes fit their canvases into it, as the engine's camera would). */
export function useSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Waits a frame (after a state change, before measuring what it laid out). */
export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
