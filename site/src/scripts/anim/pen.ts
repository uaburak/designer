// The pen: four anchors clicked and dragged into a closed curve, then the shape fills.
import { defineScene, EASE, tr } from "./timeline";

const L = 10000;
const OUT = 9300;

defineScene("pen", {
  L,
  build(tl) {
    const P = (x: number, y: number) => ({ transform: tr(x, y) });
    // Cursor: anchor, drag its handle out, on to the next.
    tl.track("cur", [
      [0, { ...P(110, 380), opacity: 0 }],
      [300, { ...P(110, 380), opacity: 1 }],
      [950, P(170, 280), EASE.move],
      [1050, P(170, 280)],
      [1400, P(170, 210), EASE.out],
      [2300, P(320, 120), EASE.move],
      [2400, P(320, 120)],
      [2750, P(400, 120), EASE.out],
      [3650, P(470, 250), EASE.move],
      [3750, P(470, 250)],
      [4100, P(470, 320), EASE.out],
      [5000, P(330, 330), EASE.move],
      [5100, P(330, 330)],
      [5450, P(260, 320), EASE.out],
      [6350, P(170, 280), EASE.move],
      [6900, P(170, 280)],
      [7700, P(520, 300), EASE.move],
      [OUT, { ...P(520, 300), opacity: 1 }],
      [OUT + 500, { opacity: 0 }, EASE.in],
    ]);
    for (const t of [1000, 2350, 3700, 5050, 6400]) tl.press("cur", t, 0.85);
    tl.track("penIcon", [[0, { opacity: 1 }], [7000, { opacity: 1 }], [7100, { opacity: 0 }]]);
    tl.track("arrowIcon", [[0, { opacity: 0 }], [7000, { opacity: 0 }], [7100, { opacity: 1 }]]);

    // Segments draw as the cursor moves to the next anchor.
    tl.draw("s0", 1500, 2300, EASE.move, OUT);
    tl.draw("s1", 2850, 3650, EASE.move, OUT);
    tl.draw("s2", 4200, 5000, EASE.move, OUT);
    tl.draw("s3", 5550, 6350, EASE.move, OUT);

    // Anchors appear on click; handles grow from the anchor while dragged.
    const anchorAt = [1000, 2350, 3700, 5050];
    anchorAt.forEach((t, i) => {
      tl.track(`a${i}`, [
        [0, { opacity: 0, transform: "scale(.2)" }],
        [t, { opacity: 0, transform: "scale(.2)" }],
        [t + 200, { opacity: 1, transform: "scale(1)" }, EASE.pop],
        [7300, { opacity: 1, transform: "scale(1)" }],
        [7500, { opacity: 0, transform: "scale(.6)" }, EASE.in],
      ]);
      const next = i < 3 ? anchorAt[i + 1] + 100 : 6600;
      tl.track(`h${i}`, [
        [0, { opacity: 0, transform: "scale(0)" }],
        [t + 50, { opacity: 1, transform: "scale(0)" }],
        [t + 400, { opacity: 1, transform: "scale(1)" }, EASE.out],
        [next, { opacity: 1, transform: "scale(1)" }],
        [next + 250, { opacity: 0, transform: "scale(1)" }],
      ]);
    });
    tl.show("close", 6100, 6500, 160, { from: { transform: "scale(.5)" }, to: { transform: "scale(1)" } });

    tl.track("fill", [
      [0, { opacity: 0 }],
      [6550, { opacity: 0 }],
      [7300, { opacity: 1 }, EASE.out],
      [OUT, { opacity: 1 }],
      [OUT + 500, { opacity: 0 }, EASE.in],
    ]);
    tl.show("box", 7450, OUT, 260);
  },
});
