// Libraries: the primary colour changes, Publish, the update travels to two files, each accepts it.
import { defineScene, EASE, tr } from "./timeline";

const L = 11000;
const FADE = 9900;
const RESET = 10300;

defineScene("libraries", {
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
      [0, { ...P(330, 390), opacity: 0 }],
      [200, { ...P(330, 390), opacity: 1 }],
      [1100, P(70, 172), EASE.move],
      [1700, P(70, 172)],
      [2300, P(150, 312), EASE.move],
      [3700, P(150, 312)],
      [4300, P(556, 169), EASE.move],
      [4900, P(556, 169)],
      [5400, P(556, 349), EASE.move],
      [6600, P(556, 349)],
      [7400, P(330, 390), EASE.move],
      [FADE, { ...P(330, 390), opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
    ]);
    tl.press("cur", 1150);
    tl.press("cur", 2350);
    tl.press("cur", 4350);
    tl.press("cur", 5450);

    // Edit the library, publish.
    tl.show("swRing", 1150, 1900, 150);
    tl.turn("libNew", 1250, off, on, 350, RESET);
    tl.press("publish", 2350, 0.96);
    tl.show("published", 2450, 4200, 200);

    // The update travels along both paths.
    for (const [key, t] of [["pk1", 2500], ["pk2", 2620]] as const) {
      const path = tl.el(key) as SVGPathElement;
      const len = Math.ceil(path.getTotalLength());
      path.style.strokeDasharray = `18 ${len + 40}`;
      tl.track(path, [
        [0, { strokeDashoffset: 18, opacity: 0 }],
        [t, { strokeDashoffset: 18, opacity: 1 }],
        [t + 850, { strokeDashoffset: -len, opacity: 1 }, "cubic-bezier(.4,0,.3,1)"],
        [t + 900, { strokeDashoffset: -len, opacity: 0 }],
      ]);
    }

    // Each file accepts it.
    for (const [badge, btn, fresh, arrive, accept] of [
      ["webBadge", "webBtn", "webNew", 3350, 4350],
      ["mobBadge", "mobBtn", "mobNew", 3470, 5450],
    ] as const) {
      tl.track(badge, [
        [0, { opacity: 0, transform: tr(0, 6) }],
        [arrive, { opacity: 0, transform: tr(0, 6) }],
        [arrive + 260, { opacity: 1, transform: tr(0, 0) }, EASE.out],
        [accept + 200, { opacity: 1, transform: tr(0, 0) }],
        [accept + 400, { opacity: 0, transform: tr(0, 0) }, EASE.in],
      ]);
      tl.press(btn, accept, 0.9);
      tl.turn(fresh, accept + 120, off, on, 400, RESET);
    }
  },
});
