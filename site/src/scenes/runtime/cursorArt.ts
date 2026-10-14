// Every cursor on the site is Figma UI3's arrow, as the UI3 kit draws it (Figma community file "UI3: Figma's UI Kit",
// Cursors › cursor-black / cursor-multiplayer-*): a rounded arrow on a 20 grid, its tip at (4, 3), a white edge around
// the fill and a soft drop shadow (0 1px 3px, 35% black). The page's pointer is it in black (common.ts); the scene
// cursors and the visitor's "You" cursor fill it with their colour and carry a name pill, as multiplayer does.

/** The white edge (the kit's "Union (Stroke)"). */
export const ARROW_EDGE =
  "M3.43938 2.43938C3.85531 2.02345 4.47597 1.88901 5.02673 2.09555L16.0267 6.22055C16.6416 6.45111 17.035 7.05477 16.9976 7.71034C16.9603 8.36592 16.5009 8.921 15.8638 9.08026L11.237 10.237L10.0803 14.8638C9.921 15.5009 9.36592 15.9603 8.71034 15.9976C8.05477 16.035 7.45111 15.6416 7.22055 15.0267L3.09555 4.02673C2.88901 3.47597 3.02345 2.85531 3.43938 2.43938Z";
/** The coloured fill (the kit's "Union"). */
export const ARROW =
  "M4.6756 3.03188C4.49202 2.96303 4.28513 3.00785 4.14649 3.14649C4.00785 3.28513 3.96303 3.49202 4.03188 3.6756L8.15688 14.6756C8.23373 14.8805 8.43495 15.0117 8.65348 14.9992C8.872 14.9868 9.05703 14.8337 9.11011 14.6213L10.4124 9.41235L15.6213 8.11011C15.8337 8.05703 15.9868 7.872 15.9992 7.65348C16.0117 7.43495 15.8805 7.23373 15.6756 7.15688L4.6756 3.03188Z";
/** The art's square, CSS px. */
export const SIZE = 20;
/** Where the arrow's tip is on its 20 × 20 grid. */
export const TIP = [4, 3] as const;
/** The kit's shadow, for CSS `filter` (an SVG filter would be cut at the art's box). */
export const SHADOW = "drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35))";

/** The arrow as inline SVG markup, filled with `color`, white edged, 20 × 20 CSS px (the shadow is the caller's CSS). */
export function arrowSvg(color: string): string {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true"><path d="${ARROW_EDGE}" fill="#fff"/><path d="${ARROW}" fill="${color}"/></svg>`;
}

/** The page's pointer: the arrow (black, or `color` over a tile) with its shadow as a CSS `cursor` value (hotspot at the
 *  tip; the system arrow after). */
export function arrowCursor(color = "#000"): string {
  const pad = 2;
  const box = SIZE + pad * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-pad} ${-pad} ${box} ${box}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.35"/></filter></defs><g filter="url(#s)"><path d="${ARROW_EDGE}" fill="#fff"/></g><path d="${ARROW}" fill="${color}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${TIP[0] + pad} ${TIP[1] + pad}, auto`;
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
