/**
 * The canvas spans the whole editor and the rail, the panels and their cards sit over it (Figma UI3): resizing,
 * folding or hiding a panel never resizes the canvas. What they leave visible is the `view` element (between the
 * panels, under the tab bar); the engine is told how much of each canvas edge they cover, so zoom to fit / selection /
 * frame, keyboard zoom, pasting and placing in view work in the visible part (Engine.setViewportInsets).
 */
import type { Engine } from "@/engine/Engine";

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far `view` is in from each edge of `canvas` (CSS px, never negative). */
export function insetsOf(canvas: DOMRectReadOnly, view: DOMRectReadOnly): Insets {
  const clamp = (v: number) => Math.max(0, Math.round(v));
  return { left: clamp(view.left - canvas.left), top: clamp(view.top - canvas.top), right: clamp(canvas.right - view.right), bottom: clamp(canvas.bottom - view.bottom) };
}

/** The visible part of the canvas in the window (the `view` between the panels), else the canvas's own box. */
export function viewRect(canvas: HTMLElement | null | undefined): DOMRect | null {
  if (!canvas) return null;
  const view = canvas.ownerDocument.querySelector<HTMLElement>("[data-canvas-view]");
  return (view ?? canvas).getBoundingClientRect();
}

/** The middle of the visible part, in canvas px (where "the middle of the view" puts things). */
export function viewCentre(canvas: HTMLElement | null | undefined): { x: number; y: number } {
  const v = viewRect(canvas);
  if (!canvas || !v) return { x: 0, y: 0 };
  const c = canvas.getBoundingClientRect();
  return { x: v.left - c.left + v.width / 2, y: v.top - c.top + v.height / 2 };
}

/** Keeps the engine's insets equal to what the panels cover; set now (before the first zoom to fit) and on every change. */
export function attachViewInsets(engine: Engine, canvas: HTMLElement, view: HTMLElement): () => void {
  let last = "";
  const apply = () => {
    if (engine.destroyed) return;
    const i = insetsOf(canvas.getBoundingClientRect(), view.getBoundingClientRect());
    const key = `${i.left} ${i.top} ${i.right} ${i.bottom}`;
    if (key === last) return;
    last = key;
    engine.setViewportInsets(i.left, i.top, i.right, i.bottom);
  };
  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(view);
  ro.observe(canvas);
  return () => ro.disconnect();
}
