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
  EYEDROPPER: "crosshair",
};

const penCache = new Map<string, string>();

/** Figma's pen nib (the tip is the hot spot), with a mark: + adds a point, − removes one, ○ closes the path. */
export function penCursor(kind: "PEN" | "PEN_ADD" | "PEN_REMOVE" | "PEN_CLOSE"): string {
  let css = penCache.get(kind);
  if (!css) {
    const mark =
      kind === "PEN_ADD" ? `<path d="M17 18h6M20 15v6"/>` : kind === "PEN_REMOVE" ? `<path d="M17 18h6"/>` : kind === "PEN_CLOSE" ? `<circle cx="20" cy="18" r="2.5"/>` : "";
    const nib = `<path d="M2 2 L12 6 L15 14 L14 15 L6 12 Z M2 2 L8.5 8.5"/><circle cx="9" cy="9" r="1.4"/>`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linejoin="round" stroke-linecap="round">` +
      `<g stroke="#fff" stroke-width="3">${nib}${mark}</g><g stroke="#000" stroke-width="1.2">${nib}${mark}</g></svg>`;
    css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 2, crosshair`;
    penCache.set(kind, css);
  }
  return css;
}

/** The system resize cursor nearest to `angleDeg` (the fallback behind the drawn one). */
export function resizeCursorFallback(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

const resizeCache = new Map<number, string>();

/**
 * A resize cursor for a handle pointing at `angleDeg` on screen (0 = right, y down): Figma's double arrow turned to
 * the handle's exact angle (a rotated layer's handles too), drawn as an SVG cursor, whole degrees; the system cursor
 * nearest to it behind.
 */
export function resizeCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 180) + 180) % 180;
  let css = resizeCache.get(a);
  if (!css) {
    const arrow = `M4 12 H20 M4 12 L8 8 M4 12 L8 16 M20 12 L16 8 M20 12 L16 16`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
      `<g transform="rotate(${a} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${arrow}" stroke="#fff" stroke-width="4"/><path d="${arrow}" stroke="#000" stroke-width="1.5"/></g></svg>`;
    css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${resizeCursorFallback(a)}`;
    resizeCache.set(a, css);
  }
  return css;
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
  if (kind === "PEN" || kind === "PEN_ADD" || kind === "PEN_REMOVE" || kind === "PEN_CLOSE") return penCursor(kind);
  return PLAIN[kind] ?? "default";
}
