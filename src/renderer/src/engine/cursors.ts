/** The engine's CURSOR events as CSS cursors (docs/engine.md §10.4). */
import type { CursorKind } from "./codec";

const PLAIN: Partial<Record<CursorKind, string>> = {
  DEFAULT: "default",
  HAND: "grab",
  GRABBING: "grabbing",
  CROSSHAIR: "crosshair",
  IBEAM: "text",
  MOVE_DUPLICATE: "copy",
  ZOOM_IN: "zoom-in",
  ZOOM_OUT: "zoom-out",
  NOT_ALLOWED: "not-allowed",
  PEN: "crosshair",
  PEN_ADD: "crosshair",
  PEN_REMOVE: "crosshair",
  PEN_CLOSE: "crosshair",
  EYEDROPPER: "crosshair",
};

/** A resize cursor for a handle pointing at `angleDeg` on screen (0 = right, y down). */
export function resizeCursor(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

const rotateCache = new Map<number, string>();

/** A curved double arrow turned to `angleDeg` (Figma's rotate cursor, drawn as an SVG cursor, 15° steps). */
export function rotateCursor(angleDeg: number): string {
  const step = Math.round(angleDeg / 15) * 15;
  let css = rotateCache.get(step);
  if (!css) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<g transform="rotate(${step - 45} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M7 16 A8 8 0 0 1 16 7" stroke="#fff" stroke-width="4"/><path d="M7 16 A8 8 0 0 1 16 7" stroke="#000" stroke-width="1.5"/>` +
      `<path d="M4 13 L7 16.5 L10.5 13.5 M13 4 L16.5 7 L13.5 10.5" stroke="#fff" stroke-width="4"/>` +
      `<path d="M4 13 L7 16.5 L10.5 13.5 M13 4 L16.5 7 L13.5 10.5" stroke="#000" stroke-width="1.5"/></g></svg>`;
    css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, alias`;
    rotateCache.set(step, css);
  }
  return css;
}

export function cssCursor(kind: CursorKind, angleDeg: number): string {
  if (kind === "RESIZE") return resizeCursor(angleDeg);
  if (kind === "ROTATE") return rotateCursor(angleDeg);
  return PLAIN[kind] ?? "default";
}
