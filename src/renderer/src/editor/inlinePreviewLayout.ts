/**
 * The inline preview's window geometry, as Figma's (live 2026-10-20 and its web bundle; research
 * docs/research/figma/live/2026-10-20/prototype-preview.txt):
 *
 * - The frame shown decides a "breakpoint": the page's device (its screen size; a Presentation device: the frame's
 *   size), else a frame 1280 wide or more is a website shown at 16:9, else the frame's own size.
 * - The first size is that size, scaled down to fit half the visible canvas's width and its height less 73 (the 41
 *   high header and 32), but never under 104 × 20 (104 × 104 for a landscape device) — scaled up to that instead.
 * - The window is the viewer plus the 41 px header; it opens 16 in from the visible canvas's top-left corner.
 * - Dragged by its header it keeps the header on screen: its top in [0, window height − 57], 40 px of it across.
 * - Its edges and corners resize it (⇧ keeps the viewer's proportions), down to the 104 × 20 viewer.
 * - The header shows all six buttons from 217 px, Restart, Open in presentation view, Preview options and Close
 *   from 153 px, else Preview options and Close.
 */

export interface Size {
  x: number;
  y: number;
}

export interface Box {
  /** The window's left and top in the editor's window (CSS px) */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The header (40) and its line under it: the window's height over the viewer's (Figma's `uF`). */
export const HEADER = 41;
/** The viewer's least size (a landscape device's: 104 × 104). */
export const MIN_VIEWER: Size = { x: 104, y: 20 };
export const MIN_VIEWER_ROTATED: Size = { x: 104, y: 104 };
/** The first window's distance from the visible canvas's top-left corner. */
export const OPEN_INSET = 16;
/** A frame this wide or wider is previewed as a website: 16:9 at its width. */
export const WEBSITE_WIDTH = 1280;

export type Breakpoint = { type: "DEVICE"; x: number; y: number } | { type: "WEBSITE" } | { type: "SMALL" };

/** The frame's breakpoint: `device` is the page's device screen (rotated already), or null without one. */
export function breakpointOf(frame: Size, device: Size | null): Breakpoint {
  if (device) return { type: "DEVICE", x: device.x, y: device.y };
  return frame.x >= WEBSITE_WIDTH ? { type: "WEBSITE" } : { type: "SMALL" };
}

/** The viewer's natural (100 %) size for a breakpoint. */
export function naturalSize(bp: Breakpoint, frame: Size): Size {
  if (bp.type === "DEVICE") return { x: bp.x, y: bp.y };
  if (bp.type === "WEBSITE") return { x: frame.x, y: frame.x / (16 / 9) };
  return { x: frame.x, y: frame.y };
}

/** Scaled down (proportionally) into `max`; a side that would fall under `min` stops there and the other follows. */
export function shrinkInto(e: Size, max: Size, min: Size): Size {
  const a = max.y / e.y;
  const o = Math.min(a, max.x / e.x);
  if (!(o < 1)) return e;
  if (o === a) return e.x * o > min.x ? { x: e.x * o, y: e.y * o } : { x: min.x, y: e.y * (min.x / e.x) };
  return e.y * o > min.y ? { x: e.x * o, y: e.y * o } : { x: e.x * (min.y / e.y), y: min.y };
}

/** Scaled up (proportionally) to `min`; a side that would pass `max` stops there and the other follows. */
export function growTo(e: Size, max: Size, min: Size): Size {
  const a = min.y / e.y;
  const o = Math.max(a, min.x / e.x);
  if (!(o > 1)) return e;
  if (o === a) return e.x * o < max.x ? { x: e.x * o, y: e.y * o } : { x: max.x, y: e.y * (max.x / e.x) };
  return e.y * o < max.y ? { x: e.x * o, y: e.y * o } : { x: e.x * (max.y / e.y), y: max.y };
}

/** The most the first viewer may take of the visible canvas. */
export function maxViewer(view: { width: number; height: number }): Size {
  return { x: Math.max(0.5 * view.width, MIN_VIEWER.x), y: view.height - HEADER - 32 };
}

/** The viewer's size when the preview opens on a frame. */
export function initialViewerSize(bp: Breakpoint, frame: Size, view: { width: number; height: number }, rotated = false): Size {
  const max = maxViewer(view);
  const min = rotated ? MIN_VIEWER_ROTATED : MIN_VIEWER;
  return growTo(shrinkInto(naturalSize(bp, frame), max, min), max, min);
}

/** The first window: 16 in from the visible canvas's top-left, the viewer plus the header. */
export function initialBox(viewer: Size, view: { left: number; top: number }): Box {
  return { x: view.left + OPEN_INSET, y: view.top + OPEN_INSET, w: viewer.x, h: viewer.y + HEADER };
}

/** "Resize window to 100%": the viewer at the frame's (or device's) natural size, not under the least size. */
export function actualViewerSize(bp: Breakpoint, frame: Size, rotated = false): Size {
  return growTo(naturalSize(bp, frame), { x: Infinity, y: Infinity }, rotated ? MIN_VIEWER_ROTATED : MIN_VIEWER);
}

/**
 * "Reset aspect ratio" (no device): the natural size, or — when the window is narrower — its width at the frame's
 * proportions (a website's 16:9).
 */
export function aspectViewerSize(current: Size, bp: Breakpoint, frame: Size): Size {
  let a = naturalSize(bp, frame);
  if (current.x < a.x) a = { x: current.x, y: current.x / (a.x / a.y) };
  return growTo(a, { x: Infinity, y: Infinity }, MIN_VIEWER);
}

/** Two viewer sizes the same to the half pixel (the menu's ✓ on "Resize window to 100%" and "Reset aspect ratio"). */
export const sameSize = (a: Size, b: Size): boolean => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/** The window's place kept with its header on screen: top in [0, height − 57], at least 40 px of it across. */
export function keepHeaderOnScreen(box: Box, view: { width: number; height: number }): Box {
  const y = Math.max(0, Math.min(box.y, view.height - (HEADER + 16)));
  const x = Math.max(40 - box.w, Math.min(box.x, view.width - 40));
  return { ...box, x, y };
}

export type Edge = "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * The window resized from `start` by an edge or corner moved (dx, dy); `keepRatio` (⇧) keeps the viewer's proportions,
 * led by the edge's own axis (a corner: the axis moved more). The opposite edges stay where they were.
 */
export function resizeBox(start: Box, edge: Edge, dx: number, dy: number, keepRatio: boolean): Box {
  const left = edge.includes("left");
  const right = edge.includes("right");
  const top = edge.startsWith("top");
  const bottom = edge.startsWith("bottom");
  let w = start.w + (right ? dx : left ? -dx : 0);
  let vh = start.h - HEADER + (bottom ? dy : top ? -dy : 0);
  w = Math.max(MIN_VIEWER.x, w);
  vh = Math.max(MIN_VIEWER.y, vh);
  if (keepRatio && start.w > 0) {
    const ratio = (start.h - HEADER) / start.w;
    const horizontal = left || right;
    const vertical = top || bottom;
    // A corner follows the axis the pointer moved more along (live: +100, +100 → the height leads).
    const byWidth = horizontal && (!vertical || Math.abs(dx) > Math.abs(dy));
    if (byWidth) vh = w * ratio;
    else w = vh / ratio;
    if (w < MIN_VIEWER.x) [w, vh] = [MIN_VIEWER.x, MIN_VIEWER.x * ratio];
    if (vh < MIN_VIEWER.y) [w, vh] = [MIN_VIEWER.y / ratio, MIN_VIEWER.y];
  }
  const h = vh + HEADER;
  return { x: left ? start.x + start.w - w : start.x, y: top ? start.y + start.h - h : start.y, w, h };
}

/** How many header buttons fit: 6 (← → Restart … options, open, close), 4 (Restart … options, open, close) or 2. */
export function headerButtons(width: number): 2 | 4 | 6 {
  return width >= 217 ? 6 : width >= 153 ? 4 : 2;
}
