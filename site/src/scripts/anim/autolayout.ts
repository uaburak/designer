// Auto layout: vertical → horizontal, the gap dragged from 12 to 32, and a duplicate joining the row.
import { defineScene, EASE, tr } from "./timeline";

const L = 11000;
const FADE = 10000;
const RESET = 10450;

defineScene("autolayout", {
  L,
  build(tl) {
    tl.track("doc", [
      [0, { opacity: 1 }],
      [FADE, { opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
      [RESET + 50, { opacity: 0 }],
      [L, { opacity: 1 }, EASE.out],
    ]);
    const W = 528;
    const H = 96;
    // Phases: vertical (gap 12), horizontal gap 12, horizontal gap 32, four items.
    const T_DIR = 1650;
    const T_GAP = [3300, 4100] as const;
    const T_DUP = 6500;
    const frameAt = (w: number, h: number) => ({ transform: `scale(${w / W}, ${h / H})` });
    tl.track("frame", [
      [0, frameAt(132, 248)],
      [T_DIR, frameAt(132, 248)],
      [T_DIR + 650, frameAt(356, 96), EASE.move],
      [T_GAP[0], frameAt(356, 96)],
      [T_GAP[1], frameAt(396, 96), EASE.move],
      [T_DUP, frameAt(396, 96)],
      [T_DUP + 450, frameAt(528, 96), EASE.move],
      [RESET, frameAt(528, 96)],
      [RESET + 1, frameAt(132, 248), EASE.step],
    ]);
    for (let i = 0; i < 3; i++) {
      tl.track(`i${i}`, [
        [0, { transform: tr(-i * 132, i * 76) }],
        [T_DIR + i * 50, { transform: tr(-i * 132, i * 76) }],
        [T_DIR + 650 + i * 50, { transform: tr(-i * 20, 0) }, EASE.move],
        [T_GAP[0], { transform: tr(-i * 20, 0) }],
        [T_GAP[1], { transform: tr(0, 0) }, EASE.move],
        [RESET, { transform: tr(0, 0) }],
        [RESET + 1, { transform: tr(-i * 132, i * 76) }, EASE.step],
      ]);
    }
    tl.turn("i3", T_DUP, { opacity: 0, transform: tr(-132, 0) }, { opacity: 1, transform: tr(0, 0) }, 450, RESET, EASE.move);
    tl.track("badge", [
      [0, { transform: tr(-198, 152) }],
      [T_DIR, { transform: tr(-198, 152) }],
      [T_DIR + 650, { transform: tr(-86, 0) }, EASE.move],
      [T_GAP[0], { transform: tr(-86, 0) }],
      [T_GAP[1], { transform: tr(-66, 0) }, EASE.move],
      [T_DUP, { transform: tr(-66, 0) }],
      [T_DUP + 450, { transform: tr(0, 0) }, EASE.move],
      [RESET, { transform: tr(0, 0) }],
      [RESET + 1, { transform: tr(-198, 152) }, EASE.step],
    ]);

    // The panel: direction, then the gap scrubbed.
    tl.turn("dirHi", T_DIR - 50, { transform: tr(-32, 0) }, { transform: tr(0, 0) }, 220, RESET);
    tl.turn("g12", 3700, { opacity: 1 }, { opacity: 0 }, 60, RESET);
    tl.turn("g32", 3700, { opacity: 0 }, { opacity: 1 }, 60, RESET);
    tl.show("gaps", 4250, 5400, 260);

    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    tl.track("cur", [
      [0, { ...P(560, 230), opacity: 0 }],
      [300, { ...P(560, 230), opacity: 1 }],
      [1500, P(467, 318), EASE.move],
      [2600, P(467, 318)],
      [3200, P(538, 318), EASE.move],
      [3300, P(538, 318)],
      [4100, P(578, 318), EASE.linear],
      [5600, P(578, 318)],
      [6200, P(370, 118), EASE.move],
      [8200, P(370, 118)],
      [9000, P(420, 220), EASE.move],
      [FADE, { ...P(420, 220), opacity: 1 }],
      [FADE + 350, { opacity: 0 }, EASE.in],
    ]);
    tl.press("cur", 1550);
    tl.track("cur", [
      [0, { transform: "scale(1)" }],
      [3250, { transform: "scale(1)" }],
      [3330, { transform: "scale(.86)" }],
      [4100, { transform: "scale(.86)" }],
      [4250, { transform: "scale(1)" }],
    ], EASE.out, "add");
    tl.press("cur", 6250);
    tl.show("chipD", 6300, 7000, 160);
  },
});
