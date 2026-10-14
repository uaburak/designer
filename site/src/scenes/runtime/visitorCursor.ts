// The visitor's own cursor over an animated tile: the system pointer hides and a multiplayer cursor named "You" (the UI3
// arrow in a colour no scene cursor uses) follows it, very lightly smoothed so it feels attached. One overlay for the
// page, transform only, a rAF loop (the shared ticker) only while the pointer is inside a tile, and it never takes a
// click (pointer-events: none). It fades and scales in on enter and out on leave, and presses like the scene cursors.
// Not on touch devices; under reduced motion it follows with no smoothing. The live "Try it" tile keeps the editor's
// own cursors (its scene is `data-interactive`).
import { arrowSvg, SHADOW, TIP, YOU } from "./cursorArt";
import { follow, type Point } from "./path";
import { prefersReduced } from "./reduced";
import { onFrame } from "./ticker";

/** How far the drawn cursor closes on the pointer per 60 Hz frame. */
export const FOLLOW = 0.5;

const CSS = `
.you-cursor { position: fixed; top: 0; left: 0; z-index: 60; width: 0; height: 0; pointer-events: none; }
/* The hand-off is seamless: the drawn arrow shows at once, on the pointer, as the page's own black arrow (the same art,
   tip and shadow), then turns the visitor's colour while the "You" pill slides out; leaving, it hides at once and the
   identical system arrow is there — no blink, no second cursor */
.you-cursor > span { position: absolute; top: 0; left: 0; display: block; visibility: hidden; }
.you-cursor[data-on] > span { visibility: visible; }
.you-cursor svg { position: absolute; top: -${TIP[1]}px; left: -${TIP[0]}px; display: block; filter: ${SHADOW}; transform-origin: ${TIP[0]}px ${TIP[1]}px;
  transition: scale var(--dur-spring-snap, 300ms) var(--ease-spring-snap, ease-out); }
.you-cursor svg .fill { fill: #000; transition: fill 0s; }
.you-cursor[data-on] svg .fill { fill: ${YOU}; transition: fill 260ms var(--ease-out, ease-out) 40ms; }
.you-cursor[data-press] svg { scale: 0.92; transition: scale 90ms var(--ease-out, ease-out); }
.you-cursor b { position: absolute; top: 13px; left: 12px; padding: 1px 4px; border-radius: 2px; background: ${YOU}; color: #fff;
  box-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.1); font: 550 11px/16px var(--site-font, Inter, sans-serif); letter-spacing: 0.005em; white-space: nowrap;
  opacity: 0; transform: translate(-4px, -4px) scale(0.6); transform-origin: 0 0; transition: none; }
.you-cursor[data-on] b { opacity: 1; transform: none;
  transition: opacity 180ms var(--ease-out, ease-out) 60ms, transform 360ms var(--ease-spring-snap, cubic-bezier(0.34, 1.4, 0.64, 1)) 60ms; }
[data-you-tile], [data-you-tile] * { cursor: none !important; }
@media (prefers-reduced-motion: reduce) { .you-cursor svg, .you-cursor svg .fill, .you-cursor b { transition: none !important; } }
`;

/** Shows the "You" cursor over every tile in `tiles`. Returns a function that removes it. */
export function initVisitorCursor(tiles: Iterable<HTMLElement>): () => void {
  const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!fine) return () => {};
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.className = "you-cursor";
  el.setAttribute("aria-hidden", "true");
  // The fill is CSS's (black, then the visitor's colour): the same art as the page's pointer
  el.innerHTML = `<span>${arrowSvg(YOU).replace(`fill="${YOU}"`, 'class="fill"')}<b>You</b></span>`;
  document.body.appendChild(el);

  let pos: Point = [0, 0];
  let target: Point = [0, 0];
  let inside: HTMLElement | null = null;
  let stop: (() => void) | null = null;
  let last = 0;
  const place = () => (el.style.transform = `translate3d(${pos[0]}px, ${pos[1]}px, 0)`);

  const run = () => {
    if (stop) return;
    last = performance.now();
    el.style.willChange = "transform";
    stop = onFrame((now) => {
      const dt = now - last;
      last = now;
      pos = follow(pos, target, prefersReduced() ? 1 : FOLLOW, dt);
      place();
      // Rest once it has caught up and the pointer has left
      if (!inside && pos[0] === target[0] && pos[1] === target[1]) halt();
    });
  };
  const halt = () => {
    stop?.();
    stop = null;
    el.style.willChange = "";
  };

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
      target = [e.clientX, e.clientY];
      pos = target; // appears right at the pointer: no sweep in from the last tile
      place();
      el.setAttribute("data-on", "");
      run();
    });
    on(tile, "pointermove", (e) => {
      if (inside !== tile) return;
      target = [e.clientX, e.clientY];
    });
    on(tile, "pointerleave", () => {
      if (inside !== tile) return;
      inside = null;
      tile.removeAttribute("data-you-tile");
      el.removeAttribute("data-on");
      el.removeAttribute("data-press");
    });
    on(tile, "pointerdown", () => inside === tile && el.setAttribute("data-press", ""));
    on(tile, "pointerup", () => el.removeAttribute("data-press"));
  }
  // The page scrolling under a still pointer: the cursor stays with the pointer (fixed overlay), nothing to do
  return () => {
    halt();
    for (const off of offs) off();
    el.remove();
    style.remove();
  };
}
