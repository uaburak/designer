import type { PointerEvent as ReactPointerEvent } from "react";
import { capture } from "../util/pointer";

/**
 * Figma's floating panels and draggable modals (the colour picker, effect settings, Interaction details, Edit variable,
 * the component pickers, Manage libraries, Review updates…) move by their header: a press on the header's empty part
 * (not on its buttons, fields, tabs or selects) drags the panel with the pointer, kept inside the window. A panel
 * reopens at its own place (the drag isn't remembered).
 */

/** Controls in a header that keep their own press (a Select's list portalled from it bubbles here too). */
const OWN_PRESS = "button,input,textarea,select,a[href],[role=tab],[role=combobox],[role=slider],[role=menu],[role=listbox],[contenteditable=true]";

/** The panel's top-left kept in the window: the whole panel when it fits, else its top-left corner at the window's. */
export function clampToWindow(x: number, y: number, size: { width: number; height: number }, view: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight }): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(x, view.width - size.width))),
    y: Math.round(Math.max(0, Math.min(y, view.height - size.height))),
  };
}

/**
 * Starts a header drag of `panel` from a pointerdown on its header (call it from the header's `onPointerDown`).
 * `place(x, y)` puts the panel's top-left at that window point (clamped) — each panel applies it its own way (left / top,
 * a translate). Returns false (and does nothing) when the press isn't a drag: another button, a control in the header,
 * a press from a portalled overlay.
 */
export function startHeaderDrag(e: ReactPointerEvent<HTMLElement>, panel: HTMLElement | null, place: (x: number, y: number) => void, onFirstMove?: () => void): boolean {
  if (!panel || e.button !== 0 || !e.currentTarget.contains(e.target as Node) || (e.target as Element).closest(OWN_PRESS)) return false;
  capture(e.currentTarget, e.pointerId);
  const r = panel.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved) {
      moved = true;
      onFirstMove?.();
    }
    const p = clampToWindow(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y, start);
    place(p.x, p.y);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  e.preventDefault(); // no text selection while dragging
  return true;
}
