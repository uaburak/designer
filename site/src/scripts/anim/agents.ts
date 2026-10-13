// Agents: a request in the Agents panel, the agent's tool calls, and the frame they build.
import { defineScene, EASE, tr } from "./timeline";

const L = 13000;
const FADE = 11800;
const RESET = 12300;

defineScene("agents", {
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
    const rise = (key: Element | string, t: number, dur = 300) =>
      tl.turn(key, t, { opacity: 0, transform: tr(0, 6) }, { opacity: 1, transform: tr(0, 0) }, dur, RESET);
    const pop = (key: Element | string, t: number) =>
      tl.turn(key, t, { opacity: 0, transform: "scale(.85)" }, { opacity: 1, transform: "scale(1)" }, 320, RESET, EASE.pop);

    rise("msg", 500);
    rise("reply", 1200);

    // Three tool calls: a spinner while each runs, then a check.
    const runs = [
      [1600, 2700],
      [2800, 3700],
      [3800, 4900],
    ] as const;
    runs.forEach(([t0, t1], i) => {
      rise(`row${i + 1}`, t0, 250);
      tl.track(`spin${i + 1}`, [
        [0, { opacity: 0, transform: "rotate(0deg)" }],
        [t0, { opacity: 0, transform: "rotate(0deg)" }],
        [t0 + 150, { opacity: 1 }],
        [t1, { opacity: 1, transform: `rotate(${Math.round((t1 - t0) / 2.2)}deg)` }, EASE.linear],
        [t1 + 100, { opacity: 0 }],
      ]);
      pop(`ok${i + 1}`, t1);
    });
    rise("done", 5100);

    // The canvas follows the calls.
    tl.turn("label", 1750, off, on, 200, RESET);
    tl.turn("frame", 1750, { opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "scale(1)" }, 350, RESET);
    ["p0", "p1", "p2"].forEach((k, i) => pop(k, 2100 + i * 150));
    rise("head", 2950);
    tl.show("gaps", 3050, 3700, 220);
    tl.turn("hot", 4000, off, on, 450, RESET);
    tl.all("price").forEach((p, i) => rise(p, 4200 + i * 120, 260));
  },
});
