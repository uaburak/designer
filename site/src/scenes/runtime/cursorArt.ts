// Every cursor on the site is Figma UI3's arrow: the canvas's own (src/renderer/src/engine/cursors.ts, `ARROW`, its tip
// at (5, 3) on a 24 grid), with a white edge. The page's default pointer is that arrow in black (common.ts); the scene
// cursors and the visitor's "You" cursor fill it with their colour and carry a name pill, as multiplayer does.

/** The UI3 arrow (the same path as the engine's DEFAULT cursor). */
export const ARROW = "M5 3 L5 18.6 L8.9 14.9 L11.5 20.8 L14.3 19.6 L11.7 13.9 L17.1 13.9 Z";
/** Where the arrow's tip is on its 24 × 24 grid. */
export const TIP = [5, 3] as const;

/** The arrow as inline SVG markup, filled with `color`, white edged, 24 × 24 CSS px. */
export function arrowSvg(color: string): string {
  return `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

/** The multiplayer palette (the app's cursor colours). */
export const CURSOR = {
  blue: "#0D99FF",
  purple: "#9747FF",
  green: "#14AE5C",
  orange: "#FFA629",
  pink: "#FF24BD",
  red: "#F24822",
  /** The scenes' own pointer (the person working in the file) */
  ink: "#1E1E1E",
} as const;

/** The visitor's own cursor over a tile: a colour no scene cursor uses. */
export const YOU = CURSOR.pink;
