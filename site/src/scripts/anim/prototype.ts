// Prototyping: two interactions are dragged out, then Present plays the flow on a phone.
import { defineScene, EASE, tr } from "./timeline";

const L = 11000;
const FADE = 9900;
const RESET = 10300;

defineScene("prototype", {
  L,
  build(tl) {
    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
      [RESET + 50, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);
    const seen = { opacity: 1 };
    const unseen = { opacity: 0 };

    // The noodles, dragged out from each hotspot.
    const curve = "cubic-bezier(.4,0,.2,1)";
    tl.draw("n1", 700, 1500, curve, FADE + 200);
    tl.draw("n2", 2100, 2700, curve, FADE + 200);
    tl.turn("d1", 600, { opacity: 0, transform: "scale(0)" }, { opacity: 1, transform: "scale(1)" }, 200, RESET, EASE.pop);
    tl.turn("a1", 1450, unseen, seen, 120, RESET);
    tl.turn("d2", 2000, { opacity: 0, transform: "scale(0)" }, { opacity: 1, transform: "scale(1)" }, 200, RESET, EASE.pop);
    tl.turn("a2", 2650, unseen, seen, 120, RESET);

    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("cur", [
      [0, { ...P(380, 396), opacity: 0 }],
      [200, { ...P(380, 396), opacity: 1 }],
      [600, P(116, 297), EASE.move],
      [700, P(116, 297)],
      [1500, P(156, 221), curve],
      [1600, P(156, 221)],
      [2000, P(238, 223), EASE.move],
      [2100, P(238, 223)],
      [2700, P(274, 221), curve],
      [2900, P(274, 221)],
      [3400, P(86, 38), EASE.move],
      [3700, P(86, 38)],
      [4300, P(380, 396), EASE.move],
      [FADE, { ...P(380, 396), opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
    ]);
    // Held down while dragging each noodle.
    tl.track("cur", [
      [0, { transform: "scale(1)" }],
      [620, { transform: "scale(1)" }],
      [700, { transform: "scale(.86)" }],
      [1500, { transform: "scale(.86)" }],
      [1600, { transform: "scale(1)" }],
      [2020, { transform: "scale(1)" }],
      [2100, { transform: "scale(.86)" }],
      [2700, { transform: "scale(.86)" }],
      [2800, { transform: "scale(1)" }],
    ], EASE.out, "add");
    tl.press("cur", 3450);
    tl.press("present", 3450, 0.94);

    // Present: the phone opens on the first screen, then two taps.
    tl.turn("phone", 3600, { opacity: 0, transform: "scale(.94)" }, { opacity: 1, transform: "scale(1)" }, 450, RESET);
    const slide = (key: string, t: number) =>
      tl.turn(key, t, { transform: tr(92, 0) }, { transform: tr(0, 0) }, 520, RESET, "cubic-bezier(.3,.7,.1,1)");
    const away = (key: string, t: number) =>
      tl.turn(key, t, { transform: tr(0, 0), opacity: 1 }, { transform: tr(-30, 0), opacity: 0.6 }, 520, RESET, "cubic-bezier(.3,.7,.1,1)");
    slide("ps2", 5000);
    away("ps1", 5000);
    slide("ps3", 6700);
    tl.track("ps2", [
      [0, { opacity: 1 }],
      [6700, { opacity: 1 }],
      [7220, { opacity: 0.6 }, "cubic-bezier(.3,.7,.1,1)"],
      [RESET, { opacity: 0.6 }],
      [RESET + 1, { opacity: 1 }, EASE.step],
    ]);
    tl.track("ps2", [
      [0, { transform: tr(0, 0) }],
      [6700, { transform: tr(0, 0) }],
      [7220, { transform: tr(-30, 0) }, "cubic-bezier(.3,.7,.1,1)"],
      [RESET, { transform: tr(-30, 0) }],
      [RESET + 1, { transform: tr(0, 0) }, EASE.step],
    ], EASE.out, "add");
    for (const [key, t] of [["tap1", 4750], ["tap2", 6450]] as const) {
      tl.track(key, [
        [0, { opacity: 0, transform: "scale(.6)" }],
        [t, { opacity: 0, transform: "scale(.6)" }],
        [t + 120, { opacity: 1, transform: "scale(1)" }, EASE.out],
        [t + 420, { opacity: 0, transform: "scale(1.3)" }, EASE.out],
      ]);
    }
  },
});
