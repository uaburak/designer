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

/** The pointer as a CSS `cursor` value: the arrow (black, or `color`) with its shadow and, with a `label`, the
 *  multiplayer name pill at its tip (the UI3 kit's: 12 right and 13 below the tip, 1 × 4 padding, radius 2, 11 / 600)
 *  drawn into the same image — so the name moves with the pointer itself, never a frame behind. Hotspot at the tip. */
export function arrowCursor(color = "#000", label?: string): string {
  const pad = 2;
  const pill = label ? { x: TIP[0] + 12, y: TIP[1] + 13, w: 8 + Math.ceil(label.length * 6.6), h: 18 } : null;
  const w = Math.max(SIZE, pill ? pill.x + pill.w + 1 : 0) + pad * 2;
  const h = Math.max(SIZE, pill ? pill.y + pill.h + 2 : 0) + pad * 2;
  const name = pill
    ? `<g filter="url(#p)"><rect x="${pill.x}" y="${pill.y}" width="${pill.w}" height="${pill.h}" rx="2" fill="${color}"/></g><text x="${pill.x + pill.w / 2}" y="${pill.y + 12.5}" text-anchor="middle" fill="#fff" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="11" font-weight="600">${label}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-pad} ${-pad} ${w} ${h}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.35"/></filter><filter id="p" x="-20%" y="-30%" width="140%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="0.75" flood-opacity="0.1"/></filter></defs><g filter="url(#s)"><path d="${ARROW_EDGE}" fill="#fff"/></g><path d="${ARROW}" fill="${color}"/>${name}</svg>`;
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

/**
 * The tool cursors a scene's pointer takes while it uses a tool, as the editor draws them (src/renderer/src/engine/
 * cursors.ts: Figma's canvas cursors, black with a white edge, on a 24 × 24 grid): the crosshair for the frame and
 * shape tools, the I-beam for text, the pen's nib, the comment bubble. `hot` is the hot spot on that grid (where the
 * pointer's point is). The arrow is the default and is drawn in the person's colour; these stay black, as in the app.
 */
export type CursorTool = "arrow" | "crosshair" | "text" | "pen" | "comment";

const haloed = (d: string, fill: string, width = 1.2, halo = 3.2) =>
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="${halo}" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="${fill}" stroke="#000" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
const plus = (x: number, y: number, r = 3) =>
  `<path d="M${x - r} ${y} H${x + r} M${x} ${y - r} V${y + r}" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>` +
  `<path d="M${x - r} ${y} H${x + r} M${x} ${y - r} V${y + r}" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
const NIB = `<path d="M2 2 L12 6 L15 14 L14 15 L6 12 Z M2 2 L8.5 8.5"/><circle cx="9" cy="9" r="1.4"/>`;
const IBEAM = "M9 4.5 H15 M9 19.5 H15 M12 4.5 V19.5";

export const TOOL_ART: Record<Exclude<CursorTool, "arrow">, { body: string; hot: readonly [number, number] }> = {
  crosshair: {
    body: `<path d="M12 4 V20 M4 12 H20" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M12 4 V20 M4 12 H20" stroke="#000" stroke-width="1"/>`,
    hot: [12, 12],
  },
  text: {
    body: `<path d="${IBEAM}" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="${IBEAM}" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>`,
    hot: [12, 12],
  },
  pen: {
    body:
      `<g fill="none" stroke-linejoin="round" stroke-linecap="round"><g stroke="#fff" stroke-width="3">${NIB}</g>` +
      `<path d="M2 2 L12 6 L15 14 L14 15 L6 12 Z" fill="#fff"/><g stroke="#000" stroke-width="1.2">${NIB}</g></g>`,
    hot: [2, 2],
  },
  comment: { body: haloed(`M3.5 20.5 V11.5 A8 8 0 1 1 11.5 19.5 H3.5 Z`, "#fff", 1.3) + plus(11.5, 11.5, 2.6), hot: [3, 21] },
};
