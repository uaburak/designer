// The home page's hero: the editor. A frame is drawn, three cards are pasted and line up when auto
// layout is added (⇧A), Ada recolours one and adds a fourth. Loop of 15 s; the markup is its last frame.
import { defineScene, EASE, tr, type Timeline } from "./timeline";

const L = 15000;
const END = 13600; // the document fades out from here, then the loop starts empty
const OUT = END + 600;

/** Visible from `t` to the end of the loop. */
function from(tl: Timeline, key: string, t: number, fade = 240) {
  tl.track(key, [
    [0, { opacity: 0 }],
    [t, { opacity: 0 }],
    [t + fade, { opacity: 1 }],
  ]);
}

/** Visible from `on` to `off`. */
function during(tl: Timeline, key: string, on: number, off: number, fade = 200) {
  tl.show(key, on, off, fade);
}

defineScene("hero", {
  L,
  setup(root) {
    // On phones the panels are cut away and the canvas fills the scene.
    const svg = root.querySelector("svg")!;
    const mq = matchMedia("(max-width: 640px)");
    const fit = () => svg.setAttribute("viewBox", mq.matches ? "250 196 700 504" : "0 0 1200 700");
    fit();
    mq.addEventListener("change", fit);
  },
  build(tl) {
    // The whole document fades out at the end, so the loop restarts on an empty canvas.
    for (const k of ["content", "layers", "props"]) {
      tl.track(k, [
        [0, { opacity: 1 }],
        [END, { opacity: 1 }],
        [OUT, { opacity: 0 }, EASE.in],
        [L - 1, { opacity: 0 }],
        [L, { opacity: 1 }, EASE.step],
      ]);
    }

    // Tools: Frame (F) for the drag, then back to Move.
    tl.track("toolHi", [
      [0, { transform: tr(0, 0) }],
      [900, { transform: tr(0, 0) }],
      [1050, { transform: tr(36, 0) }, EASE.out],
      [2600, { transform: tr(36, 0) }],
      [2750, { transform: tr(0, 0) }, EASE.out],
    ]);
    tl.track("toolMoveW", [[0, { opacity: 1 }], [900, { opacity: 1 }], [1000, { opacity: 0 }], [2600, { opacity: 0 }], [2700, { opacity: 1 }]]);
    tl.track("toolFrameW", [[0, { opacity: 0 }], [950, { opacity: 0 }], [1050, { opacity: 1 }], [2600, { opacity: 1 }], [2650, { opacity: 0 }]]);

    // Your cursor
    const A = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("curA", [
      [0, { ...A(660, 600), opacity: 0 }],
      [300, { ...A(660, 600), opacity: 1 }],
      [850, A(544, 660), EASE.move],
      [1500, A(320, 260), EASE.move],
      [2600, A(760, 480), "cubic-bezier(.45,.05,.3,1)"],
      [2800, A(760, 480)],
      [3250, A(562, 382), EASE.move],
      [4100, A(562, 382)],
      [4350, A(590, 402), EASE.move],
      [5600, A(590, 402)],
      [6400, A(660, 580), EASE.move],
      [END, { ...A(660, 580), opacity: 1 }],
      [OUT, { ...A(660, 600), opacity: 0 }, EASE.in],
    ]);
    tl.press("curA", 900, 0.88);

    // The frame: dragged out, hugged to three cards by auto layout, then to four.
    const S = (sx: number, sy: number) => ({ transform: `scale(${sx}, ${sy})` });
    const draw = S(440 / 560, 220 / 198);
    const hug3 = S(428 / 560, 1);
    tl.track("frameG", [
      [0, { ...S(0.001, 0.001), opacity: 0 }],
      [1500, { ...S(0.001, 0.001), opacity: 0 }],
      [1520, { ...S(0.001, 0.001), opacity: 1 }],
      [2600, draw, "cubic-bezier(.45,.05,.3,1)"],
      [4700, draw],
      [5400, hug3, EASE.move],
      [9400, hug3],
      [9900, S(1, 1), EASE.move],
    ]);
    from(tl, "frameLabel", 1520, 120);
    from(tl, "rowFrame", 1520);

    // Handles and the size badge
    for (const [key, d, h] of [
      ["hTL", [0, 0], [0, 0]],
      ["hTR", [-120, 0], [-132, 0]],
      ["hBL", [0, 22], [0, 0]],
      ["hBR", [-120, 22], [-132, 0]],
      ["badge", [-60, 22], [-66, 0]],
    ] as const) {
      tl.track(key, [
        [0, { transform: tr(d[0], d[1]), opacity: 0 }],
        [2600, { transform: tr(d[0], d[1]), opacity: 0 }],
        [2760, { transform: tr(d[0], d[1]), opacity: 1 }],
        [4700, { transform: tr(d[0], d[1]) }],
        [5400, { transform: tr(h[0], h[1]) }, EASE.move],
        [9400, { transform: tr(h[0], h[1]) }],
        [9900, { transform: tr(0, 0) }, EASE.move],
      ]);
    }
    tl.track("b1", [[0, { opacity: 1 }], [4900, { opacity: 1 }], [5000, { opacity: 0 }]]);
    tl.track("b2", [[0, { opacity: 0 }], [4900, { opacity: 0 }], [5000, { opacity: 1 }], [9500, { opacity: 1 }], [9600, { opacity: 0 }]]);
    tl.track("b3", [[0, { opacity: 0 }], [9500, { opacity: 0 }], [9600, { opacity: 1 }]]);

    // ⌘V: three cards land where they were copied from
    during(tl, "chipV", 3300, 3950, 160);
    tl.track("chipV", [[0, { transform: "scale(.6)" }], [3300, { transform: "scale(.6)" }], [3460, { transform: "scale(1)" }, EASE.pop]]);
    const scatter: Record<string, [number, number]> = { card1: [-8, 22], card2: [14, -10], card3: [6, 30] };
    ["card1", "card2", "card3"].forEach((k, i) => {
      const t = 3450 + i * 140;
      const [dx, dy] = scatter[k];
      const at = (s: number) => ({ transform: `${tr(dx, dy)} scale(${s})` });
      tl.track(k, [
        [0, { ...at(0.85), opacity: 0 }],
        [t, { ...at(0.85), opacity: 0 }],
        [t + 320, { ...at(1), opacity: 1 }, EASE.pop],
        [4700 + i * 70, { ...at(1) }],
        [5350 + i * 70, { transform: `${tr(0, 0)} scale(1)` }, EASE.move],
      ]);
    });
    ["row1", "row2", "row3"].forEach((k, i) => from(tl, k, 3450 + i * 140));

    // ⇧A: auto layout
    during(tl, "chipA", 4250, 4950, 160);
    tl.track("chipA", [[0, { transform: "scale(.6)" }], [4250, { transform: "scale(.6)" }], [4410, { transform: "scale(1)" }, EASE.pop]]);
    during(tl, "gaps", 5450, 6700, 260);
    tl.track("alPlus", [[0, { opacity: 1 }], [4700, { opacity: 1 }], [4850, { opacity: 0 }]]);
    tl.track("alBody", [
      [0, { opacity: 0, transform: tr(0, -8) }],
      [4750, { opacity: 0, transform: tr(0, -8) }],
      [5150, { opacity: 1, transform: tr(0, 0) }, EASE.out],
    ]);
    tl.track("below", [
      [0, { transform: tr(0, -72) }],
      [4700, { transform: tr(0, -72) }],
      [5100, { transform: tr(0, 0) }, EASE.move],
    ]);
    tl.track("w1", [[0, { opacity: 1 }], [5000, { opacity: 1 }], [5060, { opacity: 0 }]]);
    tl.track("w2", [[0, { opacity: 0 }], [5000, { opacity: 0 }], [5060, { opacity: 1 }], [9500, { opacity: 1 }], [9560, { opacity: 0 }]]);
    tl.track("w3", [[0, { opacity: 0 }], [9500, { opacity: 0 }], [9560, { opacity: 1 }]]);
    tl.track("h1", [[0, { opacity: 1 }], [5000, { opacity: 1 }], [5060, { opacity: 0 }]]);
    tl.track("h2", [[0, { opacity: 0 }], [5000, { opacity: 0 }], [5060, { opacity: 1 }]]);

    // Ada joins, recolours card 2, then adds card 4
    const B = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("curB", [
      [0, { ...B(940, 560), opacity: 0 }],
      [6100, { ...B(940, 560), opacity: 0 }],
      [6300, { ...B(920, 548), opacity: 1 }, EASE.out],
      [7200, B(540, 352), EASE.move],
      [8500, B(540, 352)],
      [9250, B(806, 340), EASE.move],
      [10400, B(806, 340)],
      [11400, B(842, 560), EASE.move],
      [END, { ...B(842, 560), opacity: 1 }],
      [OUT, { opacity: 0 }, EASE.in],
    ]);
    tl.press("curB", 7250, 0.88);
    tl.press("curB", 9300, 0.88);
    tl.track("adaSel", [
      [0, { opacity: 0, transform: tr(-264, 0) }],
      [7300, { opacity: 0, transform: tr(-264, 0) }],
      [7400, { opacity: 1, transform: tr(-264, 0) }],
      [9350, { transform: tr(-264, 0) }],
      [9850, { transform: tr(0, 0) }, EASE.move],
    ]);
    tl.track("card2grad", [
      [0, { opacity: 0 }],
      [7700, { opacity: 0 }],
      [8300, { opacity: 1 }, EASE.out],
    ]);
    tl.track("card4", [
      [0, { opacity: 0, transform: `${tr(-40, 0)} scale(.9)` }],
      [9350, { opacity: 0, transform: `${tr(-40, 0)} scale(.9)` }],
      [9850, { opacity: 1, transform: `${tr(0, 0)} scale(1)` }, EASE.move],
    ]);
    from(tl, "row4", 9450);
    tl.track("rowsBelow", [
      [0, { transform: tr(0, -30) }],
      [9350, { transform: tr(0, -30) }],
      [9700, { transform: tr(0, 0) }, EASE.move],
    ]);
  },
});
