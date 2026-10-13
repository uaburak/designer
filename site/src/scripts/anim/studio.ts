// Studio: the manager splits a request into tasks for several agents, the results land on the
// canvas, and it asks before fixing what its review found.
import { defineScene, EASE, tr } from "./timeline";

const L = 14000;
const FADE = 12900;
const RESET = 13350;

defineScene("studio", {
  L,
  build(tl) {
    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 400, { opacity: 0 }, EASE.in],
      [RESET + 50, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);
    const off = { opacity: 0 };
    const on = { opacity: 1 };
    const rise = (key: string, t: number, dur = 300) =>
      tl.turn(key, t, { opacity: 0, transform: tr(0, 6) }, { opacity: 1, transform: tr(0, 0) }, dur, RESET);

    rise("ask", 400);
    rise("plan", 1200);
    tl.draw("thread", 1500, 2100, EASE.out, FADE);
    rise("t1", 1650);
    rise("t2", 1800);
    rise("t3", 1950);

    // Each task fills at its own pace; its result lands on the canvas.
    const work = [
      ["b1", 2200, 4300],
      ["b2", 2350, 5700],
      ["b3", 2500, 6600],
    ] as const;
    for (const [bar, t0, t1] of work) {
      tl.track(bar, [
        [0, { transform: "scaleX(0)" }],
        [t0, { transform: "scaleX(0)" }],
        [t0 + (t1 - t0) * 0.55, { transform: "scaleX(.7)" }, "cubic-bezier(.3,.6,.4,1)"],
        [t1, { transform: "scaleX(1)" }, "cubic-bezier(.5,0,.5,1)"],
        [RESET, { transform: "scaleX(1)" }],
        [RESET + 1, { transform: "scaleX(0)" }, EASE.step],
      ]);
    }
    tl.turn("post", 5700, { opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }, 500, RESET);
    tl.turn("cap", 5900, off, on, 300, RESET);
    tl.turn("story", 6600, { opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }, 500, RESET);

    // Review, then a fix the owner asked for.
    rise("review", 7300, 350);
    tl.show("flag", 7400, 9100, 200);
    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("cur", [
      [0, { ...P(200, 400), opacity: 0 }],
      [6800, { ...P(200, 400), opacity: 0 }],
      [7000, { ...P(200, 400), opacity: 1 }],
      [8100, P(66, 377), EASE.move],
      [9600, P(66, 377)],
      [10400, P(200, 400), EASE.move],
      [FADE, { ...P(200, 400), opacity: 1 }],
      [FADE + 400, { opacity: 0 }, EASE.in],
    ]);
    tl.press("cur", 8150);
    tl.press("fixBtn", 8150, 0.94);
    tl.track("storyText", [
      [0, { opacity: 0.75 }],
      [8600, { opacity: 0.75 }],
      [8800, { opacity: 0.2 }],
      [9100, { opacity: 0.95 }, EASE.out],
      [RESET, { opacity: 0.95 }],
      [RESET + 1, { opacity: 0.75 }, EASE.step],
    ]);
    tl.turn("fixed", 9100, off, on, 220, RESET);
  },
});
