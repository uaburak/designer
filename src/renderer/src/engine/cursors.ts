/**
 * The engine's CURSOR events as CSS cursors (docs/engine.md §10.4).
 *
 * Figma's canvas cursors are its own pictures, black with a white edge, drawn here as SVG on a 24 × 24 grid and handed
 * to the browser as `image-set()` with a 1× and a 2× picture (crisp on Retina: Chromium rasterizes an SVG cursor at the
 * picture's own size, so the 2× one is drawn 48 × 48 and shown at 24 × 24); the hot spot is in CSS px, the system
 * cursor behind. Resize and rotate cursors are turned to the handle's exact angle on screen (whole degrees), so they
 * follow a rotated layer; the hand, the grabbing hand, the I-beam and "not allowed" are the system's (Figma's own match
 * macOS's).
 */
import type { CursorKind } from "./codec";

const PLAIN: Partial<Record<CursorKind, string>> = {
  HAND: "grab",
  GRABBING: "grabbing",
  IBEAM: "text",
  NOT_ALLOWED: "not-allowed",
};

const svgUrl = (body: string, px: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">${body}</svg>`)}")`;

/** An SVG cursor: `body` on the 24 × 24 grid, at 1× and 2×, the hot spot (CSS px), the system one behind. */
export function svgCursor(body: string, hotX: number, hotY: number, fallback: string): string {
  return `image-set(${svgUrl(body, 24)} 1x, ${svgUrl(body, 48)} 2x) ${hotX} ${hotY}, ${fallback}`;
}

/** A shape drawn as Figma's cursors are: its white edge (a wider white stroke) under it. */
const haloed = (d: string, fill: string, width = 1.2, halo = 3.2) =>
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="${halo}" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="${fill}" stroke="#000" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;

// The arrow (the default cursor): black with a white edge, the tip at (5, 3).
const ARROW = `M5 3 L5 18.6 L8.9 14.9 L11.5 20.8 L14.3 19.6 L11.7 13.9 L17.1 13.9 Z`;
const ARROW_BODY = `<path d="${ARROW}" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>`;
/** A small + (white edged) centred at (x, y): the duplicate mark, the comment's. */
const plus = (x: number, y: number, r = 3) =>
  `<path d="M${x - r} ${y} H${x + r} M${x} ${y - r} V${y + r}" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>` +
  `<path d="M${x - r} ${y} H${x + r} M${x} ${y - r} V${y + r}" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
const magnifier = (sign: "+" | "-") =>
  `<g fill="none" stroke-linecap="round"><circle cx="10" cy="10" r="6" stroke="#fff" stroke-width="4"/><path d="M14.5 14.5 L20 20" stroke="#fff" stroke-width="5"/>` +
  `<circle cx="10" cy="10" r="6" fill="#fff" stroke="#000" stroke-width="1.6"/><path d="M14.5 14.5 L20 20" stroke="#000" stroke-width="2.4"/>` +
  `<path d="M7.5 10 H12.5${sign === "+" ? " M10 7.5 V12.5" : ""}" stroke="#000" stroke-width="1.4"/></g>`;

// The eyedropper: the pipette leaning right, its tip (the hot spot) at the bottom left, the bulb black.
const EYEDROPPER_BODY =
  `<g stroke-linejoin="round" stroke-linecap="round">` +
  `<path d="M3 21 L4.4 16.6 L13.6 7.4 L16.6 10.4 L7.4 19.6 Z" fill="none" stroke="#fff" stroke-width="3.2"/>` +
  `<path d="M15.6 3.9 a2.6 2.6 0 0 1 3.7 3.7 L17.6 9.3 L18.4 10.1 L16.5 12 L12 7.5 L13.9 5.6 L14.7 6.4 Z" fill="#000" stroke="#fff" stroke-width="1.4"/>` +
  `<path d="M3 21 L4.4 16.6 L13.6 7.4 L16.6 10.4 L7.4 19.6 Z" fill="#fff" stroke="#000" stroke-width="1.2"/>` +
  `<path d="M3 21 L4.4 16.6 L6.6 18.8 Z" fill="#000"/></g>`;

// The pencil: Figma's kit glyph (24.pencil) — pointing up left, its lead (the hot spot) at the top left.
const PENCIL_BODY =
  haloed(`M3 3 L8.3 4.8 L19.6 16.1 L16.1 19.6 L4.8 8.3 Z`, "#fff") +
  `<path d="M4.8 8.3 L8.3 4.8 M13.3 16.8 L16.8 13.3" stroke="#000" stroke-width="1.2" fill="none"/>` +
  `<path d="M3 3 L5.1 3.7 L3.7 5.1 Z" fill="#000"/>`;

/** One of Figma's 1 px kit glyphs (ds icons, "s24": strokes on the 24 grid) as a cursor: black, white edged. */
const glyph = (paths: string[], filled: string[] = []) =>
  paths.map((d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`).join("") +
  filled.map((d) => `<path d="${d}" fill="#000" stroke="#fff" stroke-width="1.6"/>`).join("") +
  paths.map((d) => `<path d="${d}" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`).join("") +
  filled.map((d) => `<path d="${d}" fill="#000"/>`).join("");

// Vector edit's tools, drawn as their toolbar glyphs (24.bend, 24.paint-bucket, 24.cut, 24.lasso): Bend's anchor (the
// hot spot) with the curve it bends and its handle; Paint's bucket and drop (its tip); Cut's scissors (the blades'
// crossing); Lasso's loop and rope (its end).
const BEND_BODY = glyph(["M6.5 17.5C8 10.5 13 7 17.5 6.5", "M6.5 17.5L5 19", "M15.5 4.5L19.5 8.5"], ["M5.5 16.5h2v2h-2z"]);
const PAINT_BUCKET_BODY = glyph(["M11 5.5l6.5 6.5-6 6-6.5-6.5 6-6z", "M5 12h12.5", "M9 3.5l2 2"], ["M19.5 15.5c.8 1.2 1 1.8 1 2.3a1 1 0 0 1-2 0c0-.5.2-1.1 1-2.3z"]);
const CUT_BODY = glyph(["M9.5 16.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0z", "M18.5 16.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0z", "M8.7 14.8L16.5 4.5", "M15.3 14.8L7.5 4.5"]);
const LASSO_BODY = glyph([
  "M8.5 15.5C5.5 14.8 4.5 13 4.5 11.5c0-3.3 3.4-6 7.5-6s7.5 2.7 7.5 6-3.4 6-7.5 6c-.9 0-1.8-.1-2.6-.4",
  "M9.5 14.5c-1.4 0-2.5.9-2.5 2s1 2 2.2 2c.9 0 1.3.8.8 2",
]);

// The comment pin: a speech bubble with its tail (the hot spot) at the bottom left, a + inside.
const COMMENT_BODY = haloed(`M3.5 20.5 V11.5 A8 8 0 1 1 11.5 19.5 H3.5 Z`, "#fff", 1.3) + plus(11.5, 11.5, 2.6);

const SVG_CURSORS: Partial<Record<CursorKind, string>> = {
  DEFAULT: svgCursor(ARROW_BODY, 5, 3, "default"),
  // ⌥-drag: the arrow with a + (duplicate).
  MOVE_DUPLICATE: svgCursor(ARROW_BODY + plus(18.5, 18.5), 5, 3, "copy"),
  // Shape and frame tools: a thin crosshair.
  CROSSHAIR: svgCursor(
    `<path d="M12 4 V20 M4 12 H20" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M12 4 V20 M4 12 H20" stroke="#000" stroke-width="1"/>`,
    12,
    12,
    "crosshair"
  ),
  ZOOM_IN: svgCursor(magnifier("+"), 10, 10, "zoom-in"),
  ZOOM_OUT: svgCursor(magnifier("-"), 10, 10, "zoom-out"),
  EYEDROPPER: svgCursor(EYEDROPPER_BODY, 3, 21, "crosshair"),
  // The Scale tool (K): the arrow with the scale mark (a corner and its diagonal).
  SCALE: svgCursor(
    ARROW_BODY +
      `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 22 H22 V14" stroke="#fff" stroke-width="3.5"/><path d="M16 16 L21 21" stroke="#fff" stroke-width="3.5"/>` +
      `<path d="M14 22 H22 V14 M16 16 L21 21" stroke="#000" stroke-width="1.3"/></g>`,
    5,
    3,
    "default"
  ),
  COMMENT: svgCursor(COMMENT_BODY, 3, 21, "crosshair"),
  PENCIL: svgCursor(PENCIL_BODY, 3, 3, "crosshair"),
  BEND: svgCursor(BEND_BODY, 6, 17, "default"),
  PAINT_BUCKET: svgCursor(PAINT_BUCKET_BODY, 19, 19, "crosshair"),
  CUT: svgCursor(CUT_BODY, 12, 10, "crosshair"),
  LASSO: svgCursor(LASSO_BODY, 10, 21, "crosshair"),
};

const penCache = new Map<string, string>();

/** Figma's pen nib (the tip is the hot spot), with a mark: + adds a point, − removes one, ○ closes the path. */
export function penCursor(kind: "PEN" | "PEN_ADD" | "PEN_REMOVE" | "PEN_CLOSE"): string {
  let css = penCache.get(kind);
  if (!css) {
    const mark =
      kind === "PEN_ADD" ? `<path d="M17 18h6M20 15v6"/>` : kind === "PEN_REMOVE" ? `<path d="M17 18h6"/>` : kind === "PEN_CLOSE" ? `<circle cx="20" cy="18" r="2.5"/>` : "";
    const nib = `<path d="M2 2 L12 6 L15 14 L14 15 L6 12 Z M2 2 L8.5 8.5"/><circle cx="9" cy="9" r="1.4"/>`;
    const body =
      `<g fill="none" stroke-linejoin="round" stroke-linecap="round"><g stroke="#fff" stroke-width="3">${nib}${mark}</g>` +
      `<path d="M2 2 L12 6 L15 14 L14 15 L6 12 Z" fill="#fff"/><g stroke="#000" stroke-width="1.2">${nib}${mark}</g></g>`;
    css = svgCursor(body, 2, 2, "crosshair");
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
 * A resize cursor for a handle pointing at `angleDeg` on screen (0 = right, y down): Figma's double arrow — a black
 * shaft with filled heads, white edged — turned to the handle's exact angle (a rotated layer's handles too), whole
 * degrees; the system cursor nearest to it behind.
 */
export function resizeCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 180) + 180) % 180;
  let css = resizeCache.get(a);
  if (!css) {
    const arrow = `M3.5 12 L8 7.8 L8 11 L16 11 L16 7.8 L20.5 12 L16 16.2 L16 13 L8 13 L8 16.2 Z`;
    const body =
      `<g transform="rotate(${a} 12 12)" stroke-linejoin="round">` +
      `<path d="${arrow}" fill="#fff" stroke="#fff" stroke-width="2.6"/><path d="${arrow}" fill="#000"/></g>`;
    css = svgCursor(body, 12, 12, resizeCursorFallback(a));
    resizeCache.set(a, css);
  }
  return css;
}

const rotateCache = new Map<number, string>();

/**
 * Figma's rotate cursor for a corner pointing at `angleDeg` on screen (0 = right, y down; a bottom-right corner is
 * 45°): a curved double arrow bulging away from the layer, round the corner, turned to the exact angle (whole degrees).
 */
export function rotateCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg) % 360) + 360) % 360;
  let css = rotateCache.get(a);
  if (!css) {
    // Drawn pointing right: an arc about (4, 12), radius 8, ±50°, its heads tangent to it.
    const arc = `M9.14 5.87 A8 8 0 0 1 9.14 18.13`;
    const heads = `M12.6 5.4 L9.14 5.87 L9.6 9.3 M12.6 18.6 L9.14 18.13 L9.6 14.7`;
    const body =
      `<g transform="rotate(${a} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${arc} ${heads}" stroke="#fff" stroke-width="4"/><path d="${arc} ${heads}" stroke="#000" stroke-width="1.5"/></g>`;
    css = svgCursor(body, 12, 12, "alias");
    rotateCache.set(a, css);
  }
  return css;
}

export function cssCursor(kind: CursorKind, angleDeg: number): string {
  if (kind === "RESIZE") return resizeCursor(angleDeg);
  if (kind === "ROTATE") return rotateCursor(angleDeg);
  if (kind === "PEN" || kind === "PEN_ADD" || kind === "PEN_REMOVE" || kind === "PEN_CLOSE") return penCursor(kind);
  return SVG_CURSORS[kind] ?? PLAIN[kind] ?? "default";
}

/** Every drawn cursor's SVG body and hot spot, for the cursor sheet (editor-shot: docs/research/chrome-cursors/). */
export function cursorSheet(): { name: string; css: string }[] {
  const out: { name: string; css: string }[] = [];
  for (const [k, css] of Object.entries(SVG_CURSORS)) out.push({ name: k, css: css as string });
  for (const k of ["PEN", "PEN_ADD", "PEN_REMOVE", "PEN_CLOSE"] as const) out.push({ name: k, css: penCursor(k) });
  for (const d of [0, 45, 90, 135, 30]) out.push({ name: `RESIZE ${d}°`, css: resizeCursor(d) });
  for (const d of [45, 135, 225, 315, 75]) out.push({ name: `ROTATE ${d}°`, css: rotateCursor(d) });
  return out;
}
