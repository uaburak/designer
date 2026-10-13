// Components and variables: the main component's fill changes and its instances follow; then the
// frames' variable mode goes from Light to Dark.
import { defineScene, EASE, tr, type Props } from "./timeline";

const L = 10000;
const FADE = 9200; // the document fades, resets while hidden, and comes back
const RESET = 9600;

defineScene("components", {
  L,
  build(tl) {
    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 300, { opacity: 0 }, EASE.in],
      [RESET + 100, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);
    /** Off until `t`, on until the reset. */
    const turnOn = (key: string, t: number, dur = 300, props: [Props, Props] = [{ opacity: 0 }, { opacity: 1 }]) =>
      tl.turn(key, t, props[0], props[1], dur, RESET);

    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("cur", [
      [0, { ...P(430, 400), opacity: 0 }],
      [300, { ...P(430, 400), opacity: 1 }],
      [1000, P(150, 206), EASE.move],
      [1500, P(150, 206)],
      [2000, P(118, 272), EASE.move],
      [3600, P(118, 272)],
      [4600, P(190, 346), EASE.move],
      [FADE, { ...P(200, 352), opacity: 1 }, EASE.move],
      [FADE + 300, { opacity: 0 }, EASE.in],
    ]);
    tl.press("cur", 1050);
    tl.press("cur", 2050);
    tl.press("cur", 4650);

    turnOn("mainSel", 1100, 120);
    tl.track("pop", [
      [0, { opacity: 0, transform: tr(0, 6) }],
      [1350, { opacity: 0, transform: tr(0, 6) }],
      [1600, { opacity: 1, transform: tr(0, 0) }, EASE.out],
      [3400, { opacity: 1, transform: tr(0, 0) }],
      [3600, { opacity: 0, transform: tr(0, 0) }, EASE.in],
    ]);
    turnOn("ring", 2100, 250, [{ transform: tr(-36, 0) }, { transform: tr(0, 0) }]);

    // The main changes, then each instance, with a purple ripple as it updates.
    turnOn("mainNew", 2150, 350);
    turnOn("instA", 2550, 350);
    turnOn("instB", 2700, 350);
    tl.show("rippleA", 2550, 2900, 200, { from: { transform: "scale(.96)" }, to: { transform: "scale(1.04)" } });
    tl.show("rippleB", 2700, 3050, 200, { from: { transform: "scale(.96)" }, to: { transform: "scale(1.04)" } });

    // Mode: Light → Dark
    turnOn("modeHi", 4700, 260, [{ transform: tr(-89, 0) }, { transform: tr(0, 0) }]);
    turnOn("darkA", 4800, 450);
    turnOn("darkB", 4920, 450);
  },
});
