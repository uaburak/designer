// AI image tools: Make an image (typed prompt, the picture resolving in place), Remove background,
// Vectorize.
import { defineScene, EASE, tr, type Props } from "./timeline";

const L = 12500;
const FADE = 11400;
const RESET = 11800;
const SVGNS = "http://www.w3.org/2000/svg";

defineScene("ai-image", {
  L,
  build(tl) {
    const on = (key: Element | string, t: number, dur = 300, off: Props = { opacity: 0 }, to: Props = { opacity: 1 }) => tl.turn(key, t, off, to, dur, RESET);
    const offAt = (key: string, t: number, dur = 300) => tl.turn(key, t, { opacity: 1 }, { opacity: 0 }, dur, RESET);

    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 300, { opacity: 0 }, EASE.in],
      [RESET + 100, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);

    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("cur", [
      [0, P(560, 380)],
      [1900, P(560, 380)],
      [2500, P(470, 368), EASE.move],
      [3300, P(470, 368)],
      [4000, P(520, 300), EASE.move],
      [5600, P(520, 300)],
      [6200, P(262, 26), EASE.move],
      [7400, P(262, 26)],
      [7900, P(392, 26), EASE.move],
      [9200, P(392, 26)],
      [10000, P(420, 300), EASE.move],
    ]);
    tl.press("cur", 2550);
    tl.press("cur", 6250);
    tl.press("cur", 7950);

    // Make an image: the panel, the prompt typed, Send.
    tl.track("prompt", [
      [0, { opacity: 1, transform: tr(0, 0) }],
      [5200, { opacity: 1, transform: tr(0, 0) }],
      [5600, { opacity: 0, transform: tr(0, 12) }, EASE.in],
      [RESET, { opacity: 0 }],
      [RESET + 1, { opacity: 1, transform: tr(0, 0) }, EASE.step],
    ]);
    offAt("ph", 300, 60);
    tl.track("cover", [
      [0, { transform: tr(0, 0) }],
      [400, { transform: tr(0, 0) }],
      [2200, { transform: tr(236, 0) }, "steps(35, end)"],
      [2400, { transform: tr(236, 0), opacity: 1 }],
      [2500, { opacity: 0 }],
      [RESET, { opacity: 0 }],
      [RESET + 1, { transform: tr(0, 0), opacity: 1 }, EASE.step],
    ]);
    tl.press("send", 2550, 0.8);

    // Generating: the placeholder shimmers, then the picture resolves tile by tile.
    offAt("placeholder", 2700, 300);
    tl.track("shimmer", [
      [0, { opacity: 0, transform: tr(0, 0) }],
      [2700, { opacity: 0, transform: tr(0, 0) }],
      [2800, { opacity: 1, transform: tr(0, 0) }],
      [3500, { transform: tr(380, 0) }, EASE.linear],
      [3501, { transform: tr(0, 0) }, EASE.step],
      [4200, { transform: tr(380, 0), opacity: 1 }, EASE.linear],
      [4400, { opacity: 0 }],
    ]);
    on("photo", 4100, 1);
    const tiles = tl.el("tiles");
    const cols = 7;
    const rows = 5;
    const order = Array.from({ length: cols * rows }, (_, i) => i).sort((a, b) => hash(a) - hash(b));
    order.forEach((cell, n) => {
      const r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("x", String(180 + (cell % cols) * 40));
      r.setAttribute("y", String(50 + Math.floor(cell / cols) * 42));
      r.setAttribute("width", "40.5");
      r.setAttribute("height", "42.5");
      r.setAttribute("class", "fd");
      tiles.append(r);
      const t = 4150 + n * 26;
      tl.track(r, [
        [0, { opacity: 1 }],
        [t, { opacity: 1 }],
        [t + 260, { opacity: 0 }, EASE.out],
        [RESET, { opacity: 0 }],
        [RESET + 1, { opacity: 1 }, EASE.step],
      ]);
    });

    // Remove background
    tl.track("imgBar", [
      [0, { opacity: 0, transform: tr(0, 6) }],
      [5500, { opacity: 0, transform: tr(0, 6) }],
      [5800, { opacity: 1, transform: tr(0, 0) }, EASE.out],
      [RESET, { opacity: 1 }],
      [RESET + 1, { opacity: 0, transform: tr(0, 6) }, EASE.step],
    ]);
    tl.show("rbHi", 6250, 6900, 120);
    offAt("bg", 6450, 650);

    // Vectorize
    tl.show("vzHi", 7950, 8600, 120);
    offAt("raster", 8150, 500);
    on("vector", 8150, 500);
    tl.all("v").forEach((v, i) => on(v, 8500 + i * 60, 220, { opacity: 0, transform: "scale(0)" }, { opacity: 1, transform: "scale(1)" }));
  },
});

/** A fixed shuffle, so the tiles dissolve in a scattered but stable order. */
function hash(i: number): number {
  let x = (i + 1) * 2654435761;
  x ^= x >>> 15;
  return x % 1000;
}
