/** The engine's CURSOR events as CSS cursors (docs/engine.md §10.4). */
import type { CursorKind } from "./codec";

const PLAIN: Partial<Record<CursorKind, string>> = {
  HAND: "grab",
  GRABBING: "grabbing",
  IBEAM: "text",
  NOT_ALLOWED: "not-allowed",
};

/** An SVG cursor (24 × 24): the shape drawn white under black, as Figma's cursors are, the hot spot, the system one behind. */
function svgCursor(body: string, hotX: number, hotY: number, fallback: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

// Figma's own canvas cursors (round 8, audit selection #22), drawn after its look: the arrow with a white edge, a thin
// crosshair, the magnifier with + / −, the eyedropper, the Scale tool's arrow with its corner mark, the comment pin.
const ARROW = `M5.5 3.5 L5.5 18.5 L9.4 14.8 L12 20.6 L14.6 19.5 L12.1 13.8 L17.5 13.8 Z`;
const ARROW_BODY = `<path d="${ARROW}" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>`;
const plus = (x: number, y: number) =>
  `<path d="M${x - 3} ${y} H${x + 3} M${x} ${y - 3} V${y + 3}" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M${x - 3} ${y} H${x + 3} M${x} ${y - 3} V${y + 3}" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
const magnifier = (sign: "+" | "-") =>
  `<g fill="none" stroke-linecap="round"><circle cx="10" cy="10" r="6" stroke="#fff" stroke-width="4"/><path d="M14.5 14.5 L20 20" stroke="#fff" stroke-width="5"/>` +
  `<circle cx="10" cy="10" r="6" stroke="#000" stroke-width="1.6"/><path d="M14.5 14.5 L20 20" stroke="#000" stroke-width="2.4"/>` +
  `<path d="M7.5 10 H12.5${sign === "+" ? " M10 7.5 V12.5" : ""}" stroke="#000" stroke-width="1.4"/></g>`;
const SVG_CURSORS: Partial<Record<CursorKind, string>> = {
  DEFAULT: svgCursor(ARROW_BODY, 5, 3, "default"),
  MOVE_DUPLICATE: svgCursor(ARROW_BODY + plus(18, 18), 5, 3, "copy"),
  CROSSHAIR: svgCursor(
    `<path d="M12 3 V21 M3 12 H21" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M12 3 V21 M3 12 H21" stroke="#000" stroke-width="1"/>`,
    12,
    12,
    "crosshair"
  ),
  ZOOM_IN: svgCursor(magnifier("+"), 10, 10, "zoom-in"),
  ZOOM_OUT: svgCursor(magnifier("-"), 10, 10, "zoom-out"),
  EYEDROPPER: svgCursor(
    `<g stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 20.5 L5 16 L14 7 L17 10 L8 19 Z" fill="#fff" stroke="#fff" stroke-width="3"/>` +
      `<path d="M16 3.8 a2.6 2.6 0 0 1 3.7 3.7 L17.5 9.7 L14.3 6.5 Z" fill="#000" stroke="#fff" stroke-width="1.6"/>` +
      `<path d="M3.5 20.5 L5 16 L14 7 L17 10 L8 19 Z" fill="#fff" stroke="#000" stroke-width="1.3"/></g>`,
    3,
    21,
    "crosshair"
  ),
  SCALE: svgCursor(
    ARROW_BODY +
      `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 22 H22 V14" stroke="#fff" stroke-width="3.5"/><path d="M16 16 L21 21" stroke="#fff" stroke-width="3.5"/>` +
      `<path d="M14 22 H22 V14 M16 16 L21 21" stroke="#000" stroke-width="1.3"/></g>`,
    5,
    3,
    "default"
  ),
  COMMENT: svgCursor(
    `<path d="M3.5 20.5 V11 A7.5 7.5 0 1 1 11 18.5 H3.5 Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>`,
    3,
    21,
    "crosshair"
  ),
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
  return SVG_CURSORS[kind] ?? PLAIN[kind] ?? "default";
}
