// The visitor's own cursor over an animated tile: the system pointer stays the system pointer (never replaced, so it
// never lags) and only turns into the visitor's multiplayer cursor — the same UI3 arrow in a colour no scene cursor uses,
// with the "You" pill drawn into the same cursor image, so the name moves with the pointer itself. Pure CSS: a rule on
// the tiles under the pointer. Not on touch devices. The live "Try it" tile keeps the editor's own cursors (its scene is
// `data-interactive`).
import { arrowCursor, YOU } from "./cursorArt";

/** Gives the pointer the visitor's colour and the "You" name over every tile in `tiles`. Returns a function that removes it. */
export function initVisitorCursor(tiles: Iterable<HTMLElement>): () => void {
  const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!fine) return () => {};
  const style = document.createElement("style");
  style.textContent = `[data-you-tile], [data-you-tile] * { cursor: ${arrowCursor(YOU, "You")} !important; }`;
  document.head.appendChild(style);
  const marked: HTMLElement[] = [];
  for (const tile of tiles) {
    tile.setAttribute("data-you-tile", "");
    marked.push(tile);
  }
  return () => {
    for (const tile of marked) tile.removeAttribute("data-you-tile");
    style.remove();
  };
}
