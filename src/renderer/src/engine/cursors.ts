/**
 * The engine's CURSOR events as CSS cursors (docs/engine.md §10.4), in Figma's own art.
 *
 * The pictures are Figma's UI3 canvas cursors, decoded from the resources of Figma's fullscreen wasm with the hot spot
 * its code gives each (cursorArt/, `npm run cursors`; docs/research/chrome-cursors/README.md): white-edged black
 * glyphs on a 32 × 32 box. They go to the browser as `image-set()` with a 1× and a 2× picture (crisp on Retina:
 * Chromium rasterizes an SVG cursor at the picture's own size, so the 2× one is drawn at twice the size and shown at
 * 1×); the hot spot is in CSS px, the system cursor behind. Resize, rotate and spacing cursors are turned to the
 * handle's exact angle on screen (whole degrees) about the box's middle, so they follow a rotated layer, as Figma's do.
 * The text I-beam is the system's (Figma has no I-beam of its own).
 */
import type { CursorKind } from "./codec";
import { FIGMA_CURSORS, type FigmaCursorName } from "./cursorArt/figmaCursors.generated";

const PLAIN: Partial<Record<CursorKind, string>> = {
  IBEAM: "text",
};

const svgUrl = (body: string, w: number, h: number, scale: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}")`;

/** An SVG cursor: `body` on a `w` × `h` box (CSS px), at 1× and 2×, the hot spot (CSS px), the system one behind. */
export function svgCursor(body: string, hotX: number, hotY: number, fallback: string, w = 32, h = w): string {
  return `image-set(${svgUrl(body, w, h, 1)} 1x, ${svgUrl(body, w, h, 2)} 2x) ${hotX} ${hotY}, ${fallback}`;
}

const figmaCache = new Map<string, string>();

/**
 * One of Figma's cursors by its resource name ("black-ui3" = cursor-black-ui3.svg), at its hot spot; `turn` (whole
 * degrees, clockwise) turns it about the box's middle.
 */
export function figmaCursor(name: FigmaCursorName, fallback: string, turn = 0): string {
  const key = `${name}|${turn}|${fallback}`;
  let css = figmaCache.get(key);
  if (!css) {
    const c = FIGMA_CURSORS[name];
    const body = turn ? `<g transform="rotate(${turn} ${c.w / 2} ${c.h / 2})">${c.body}</g>` : c.body;
    css = svgCursor(body, c.hot[0], c.hot[1], fallback, c.w, c.h);
    figmaCache.set(key, css);
  }
  return css;
}

/** Each engine cursor's picture in Figma's set, and the system cursor behind it. */
const FIGMA: Partial<Record<CursorKind, [FigmaCursorName, string]>> = {
  DEFAULT: ["black-ui3", "default"],
  HAND: ["hand-new-ui3", "grab"],
  GRABBING: ["hand-press-ui3", "grabbing"],
  // Every drawing tool (frame, section, slice, shapes, line, arrow, text box) — Figma's crosshair.
  CROSSHAIR: ["crosshair-ui3", "crosshair"],
  PEN: ["pen-ui3", "crosshair"],
  PEN_ADD: ["pen-insert-ui3", "crosshair"],
  PEN_REMOVE: ["pen-remove-ui3", "crosshair"],
  // Over the path's first point (closes it) — Figma's pen with the snap dot.
  PEN_CLOSE: ["pen-snap-ui3", "crosshair"],
  // ⌥-drag: Figma's two arrows.
  MOVE_DUPLICATE: ["duplicate-ui3", "copy"],
  ZOOM_IN: ["zoom-in-ui3", "zoom-in"],
  ZOOM_OUT: ["zoom-out-ui3", "zoom-out"],
  EYEDROPPER: ["dropper-ui3", "crosshair"],
  NOT_ALLOWED: ["not-allowed-ui3", "not-allowed"],
  COMMENT: ["comments-next-pin-ui3", "crosshair"],
  // The Scale tool (K) away from a handle: Figma has no picture of its own for it, the arrow.
  SCALE: ["black-ui3", "default"],
  PENCIL: ["pencil-ui3", "crosshair"],
  BEND: ["bend-ui3", "default"],
  PAINT_BUCKET: ["paint-bucket-ui3", "crosshair"],
  CUT: ["cut-open", "crosshair"],
  LASSO: ["vector-lasso", "crosshair"],
  BRUSH: ["brush", "crosshair"],
  TEXT_PATH: ["text-curve", "text"],
};

/** Every picture of Figma's set by name — those the engine has no event for yet (snap, convert, break, deep select…) too. */
export const FIGMA_CURSOR_NAMES = Object.keys(FIGMA_CURSORS) as FigmaCursorName[];

export function penCursor(kind: "PEN" | "PEN_ADD" | "PEN_REMOVE" | "PEN_CLOSE"): string {
  const [name, fallback] = FIGMA[kind]!;
  return figmaCursor(name, fallback);
}

/** The system resize cursor nearest to `angleDeg` (the fallback behind the drawn one). */
export function resizeCursorFallback(angleDeg: number): string {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

/**
 * A resize cursor for a handle pointing at `angleDeg` on screen (0 = right, y down): Figma's double arrow (drawn
 * across) turned to the handle's exact angle (a rotated layer's handles too), whole degrees; the system cursor nearest
 * to it behind.
 */
export function resizeCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 180) + 180) % 180;
  return figmaCursor("resize-ui3", resizeCursorFallback(a), a);
}

/**
 * Figma's spacing cursor over an auto-layout padding or gap handle (round 15, docs/research/figma/live/behaviour/
 * spacing-handles.md): its double arrow across a bar (cursor-resize-padding), turned to the drag's angle on screen
 * (0 = across, 90 = up and down).
 */
export function spacingCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 180) + 180) % 180;
  return figmaCursor("resize-padding-ui3", a < 45 || a >= 135 ? "col-resize" : "row-resize", a);
}

/**
 * Figma's rotate cursor for a corner pointing at `angleDeg` on screen (0 = right, y down; a bottom-right corner is
 * 45°): its curved double arrow bulging away from the layer round the corner, turned to the exact angle (whole
 * degrees). Figma's picture is the top-right corner's (−45°).
 */
export function rotateCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 360) + 360) % 360;
  return figmaCursor("rotate-ui3", "alias", (a + 45) % 360);
}

export function cssCursor(kind: CursorKind, angleDeg: number): string {
  if (kind === "RESIZE") return resizeCursor(angleDeg);
  if (kind === "ROTATE") return rotateCursor(angleDeg);
  if (kind === "SPACING") return spacingCursor(angleDeg);
  const figma = FIGMA[kind];
  if (figma) return figmaCursor(figma[0], figma[1]);
  return PLAIN[kind] ?? "default";
}

/** Every cursor as the editor shows it and every picture of Figma's set, for the cursor sheet (editor-shot). */
export function cursorSheet(): { name: string; css: string }[] {
  const out: { name: string; css: string }[] = [];
  for (const k of Object.keys(FIGMA) as CursorKind[]) out.push({ name: k, css: cssCursor(k, 0) });
  for (const d of [0, 45, 90, 135, 30]) out.push({ name: `RESIZE ${d}°`, css: resizeCursor(d) });
  for (const d of [45, 135, 225, 315, 75]) out.push({ name: `ROTATE ${d}°`, css: rotateCursor(d) });
  for (const d of [0, 90, 30]) out.push({ name: `SPACING ${d}°`, css: spacingCursor(d) });
  for (const n of FIGMA_CURSOR_NAMES) out.push({ name: n, css: figmaCursor(n, "default") });
  return out;
}
