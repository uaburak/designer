// Dev Mode: the toggle, then a selected button's spacing on the canvas and its CSS in Inspect.
import { defineScene, EASE, tr } from "./timeline";

const L = 10000;
const FADE = 9000;
const RESET = 9400;

defineScene("devmode", {
  L,
  build(tl) {
    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
      [RESET + 50, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);
    const on = { opacity: 1 };
    const off = { opacity: 0 };
    const P = (x: number, y: number) => ({ transform: tr(x, y) });

    tl.track("cur", [
      [0, { ...P(340, 330), opacity: 0 }],
      [200, { ...P(340, 330), opacity: 1 }],
      [900, P(258, 380), EASE.move],
      [1700, P(258, 380)],
      [2500, P(282, 254), EASE.move],
      [4800, P(282, 254)],
      [5600, P(540, 352), EASE.move],
      [7400, P(540, 352)],
      [8200, P(340, 330), EASE.move],
      [FADE, { ...P(340, 330), opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
    ]);
    tl.press("cur", 950);
    tl.press("cur", 2950);
    tl.press("cur", 5650);

    // The toggle
    tl.turn("toggleOn", 1000, off, on, 200, RESET);
    tl.turn("knob", 1000, { transform: tr(-24, 0) }, { transform: tr(0, 0) }, 240, RESET);
    tl.turn("codeOff", 1000, on, off, 120, RESET);
    tl.turn("codeOn", 1000, off, on, 200, RESET);
    tl.turn("panel", 1150, { transform: tr(240, 0) }, { transform: tr(0, 0) }, 550, RESET, "cubic-bezier(.2,.8,.2,1)");

    // Hover, select, measure
    tl.show("hover", 2450, 2950, 120);
    tl.turn("selected", 2950, off, on, 160, RESET);
    ["r1", "r2", "r3"].forEach((k, i) =>
      tl.turn(k, 3150 + i * 120, { opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }, 260, RESET, EASE.pop),
    );
    tl.all("c").forEach((line, i) =>
      tl.turn(line, 3300 + i * 110, { opacity: 0, transform: tr(-6, 0) }, { opacity: 1, transform: tr(0, 0) }, 260, RESET),
    );

    // Copy
    tl.press("copy", 5650, 0.96);
    tl.show("copied", 5750, 7300, 180);
  },
});
