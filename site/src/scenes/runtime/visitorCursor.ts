// The visitor's own cursor over an animated tile: the system pointer stays the system pointer (never replaced, so it never
// lags) and only takes the visitor's colour — the same UI3 arrow as the page's black one, as a CSS cursor — while a "You"
// pill, the multiplayer name, sits next to its tip. The pill is the only drawn thing: one overlay for the page, moved
// with the pointer's own events (transform only, no smoothing), and it never takes a click (pointer-events: none). It
// springs out on enter and fades on leave. Not on touch devices. The live "Try it" tile keeps the editor's own cursors
// (its scene is `data-interactive`).
import { arrowCursor, YOU } from "./cursorArt";

const CSS = `
.you-cursor { position: fixed; top: 0; left: 0; z-index: 60; width: 0; height: 0; pointer-events: none; }
.you-cursor b { position: absolute; top: 13px; left: 12px; padding: 1px 4px; border-radius: 2px; background: ${YOU}; color: #fff;
  box-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.1); font: 550 11px/16px var(--site-font, Inter, sans-serif); letter-spacing: 0.005em; white-space: nowrap;
  opacity: 0; transform: translate(-4px, -4px) scale(0.6); transform-origin: 0 0;
  transition: opacity 120ms var(--ease-out, ease-out), transform 160ms var(--ease-out, ease-out); }
.you-cursor[data-on] b { opacity: 1; transform: none;
  transition: opacity 160ms var(--ease-out, ease-out), transform 320ms var(--ease-spring-snap, cubic-bezier(0.34, 1.4, 0.64, 1)); }
[data-you-tile], [data-you-tile] * { cursor: ${arrowCursor(YOU)} !important; }
@media (prefers-reduced-motion: reduce) { .you-cursor b { transition: none !important; } }
`;

/** Gives the pointer the visitor's colour and a "You" pill over every tile in `tiles`. Returns a function that removes it. */
export function initVisitorCursor(tiles: Iterable<HTMLElement>): () => void {
  const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!fine) return () => {};
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.className = "you-cursor";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = "<b>You</b>";
  document.body.appendChild(el);

  let inside: HTMLElement | null = null;
  const place = (e: PointerEvent) => (el.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`);

  const offs: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    t.addEventListener(type, fn);
    offs.push(() => t.removeEventListener(type, fn));
  };
  for (const tile of tiles) {
    on(tile, "pointerenter", (e) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      inside = tile;
      tile.setAttribute("data-you-tile", "");
      place(e);
      el.setAttribute("data-on", "");
    });
    on(tile, "pointermove", (e) => inside === tile && place(e));
    on(tile, "pointerleave", (e) => {
      if (inside !== tile) return;
      inside = null;
      tile.removeAttribute("data-you-tile");
      place(e);
      el.removeAttribute("data-on");
    });
  }
  return () => {
    for (const off of offs) off();
    el.remove();
    style.remove();
  };
}
