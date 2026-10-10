// editor-shot's auto-layout drag section (EDITOR_ONLY=aldrag, round 15): a layer dragged inside its own auto-layout
// frame as live Figma does it (the owner's recording, docs/research/figma/live/behaviour/autolayout-drag.md), driven
// with real mouse events on the canvas.
//
// 1. Pressed and moved short of the next layer's centre: it follows the pointer, the others stay.
// 2. Its bottom edge past the next one's centre: that one slides up into its place — sampled every frame, seen part-way
//    and then at rest (≈ 120 ms) — the frame keeps its size, the order changes in the document as it goes.
// 3. Dropped: in its slot at once, the others at their places; ⌘Z once puts everything back.
/* global window, requestAnimationFrame, performance */

const GREEN = { r: 0.15, g: 0.98, b: 0, a: 1 }, BLUE = { r: 0, g: 0.29, b: 1, a: 1 }, RED = { r: 1, g: 0, b: 0, a: 1 }, GREY = { r: 0.85, g: 0.85, b: 0.85, a: 1 };
const KIDS = ["7:2", "7:3", "7:4", "7:5"];

function frame() {
  const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const fill = (color) => [{ type: "SOLID", color, opacity: 1, visible: true, blendMode: "NORMAL" }];
  // Figma's Frame 406 of the recording: vertical, padding 40, gap 20, four 181 × 44 layers; laid out already.
  const out = [
    { guid: "7:1", phase: "CREATED", type: "FRAME", name: "Frame 406", parentIndex: { guid: "0:1", position: "!" }, size: { x: 261, y: 316 }, transform: at(0, 0), fillPaints: fill({ r: 1, g: 1, b: 1, a: 1 }), stackMode: "VERTICAL", stackSpacing: 20, stackHorizontalPadding: 40, stackVerticalPadding: 40, stackPaddingRight: 40, stackPaddingBottom: 40, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
  ];
  [GREEN, BLUE, RED, GREY].forEach((color, i) =>
    out.push({ guid: KIDS[i], phase: "CREATED", type: "RECTANGLE", name: `Rect ${i + 1}`, parentIndex: { guid: "7:1", position: String.fromCharCode(33 + i) }, size: { x: 181, y: 44 }, transform: at(40, 40 + 64 * i), fillPaints: fill(color) }),
  );
  return out;
}

const ys = (page) => page.evaluate((ids) => ids.map((id) => window.__designerEditor.engine.readNode(id).transform.m12), KIDS);
const order = (page) => page.evaluate(() => (window.__designerEditor.engine.readNode("7:1", { childIds: true }).childIds ?? []).join(","));

export async function autoLayoutDragSection(page, theme, { open, settle, shot, check }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 400, y: 200, zoom: 1 });
    ed.engine.setSelection(["7:2"]);
  }, frame());
  await settle(page);
  const toScreen = (x, y) =>
    page.evaluate(([x, y]) => {
      const ed = window.__designerEditor;
      const c = ed.engine.getCamera();
      const r = ed.canvas.getBoundingClientRect();
      return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y];
    }, [x, y]);
  const start = await ys(page);
  const startOrder = await order(page);
  check(`Auto-layout drag (${theme}): the frame laid out as Figma's (40, 104, 168, 232)`, start.join(",") === "40,104,168,232", start.join(","));

  // 1. Press on the green layer, move 40 down: its bottom (84 + 40) short of blue's centre (126).
  const [px, py] = await toScreen(130, 62);
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 4, py + 40, { steps: 6 });
  await settle(page);
  let now = await ys(page);
  check(`Auto-layout drag (${theme}): short of the next layer's centre it follows the pointer alone`, now[0] === 80 && now[1] === 104 && (await order(page)) === startOrder, now.join(","));
  await shot(page, `420-aldrag-moving-${theme}`);

  // 2. On, past blue's centre: blue slides up into its place, seen part-way, at rest within 300 ms.
  await page.mouse.move(px + 4, py + 46);
  const samples = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          out.push([Math.round(performance.now() - t0), window.__designerEditor.engine.readNode("7:3").transform.m12]);
          if (performance.now() - t0 < 400) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  const values = samples.map((s) => s[1]);
  const partWay = values.some((v) => v > 40 && v < 104);
  const rest = samples.find((s) => s[1] === 40);
  check(`Auto-layout drag (${theme}): past its centre the next layer slides up (part-way, then at 40 within 300 ms)`, partWay && rest && rest[0] <= 300 && values[values.length - 1] === 40, JSON.stringify(samples.filter((_, i) => i % 3 === 0)));
  check(`Auto-layout drag (${theme}): the order changes in the document as it goes`, (await order(page)) === "7:3,7:2,7:4,7:5", await order(page));
  const size = await page.evaluate(() => window.__designerEditor.engine.readNode("7:1").size);
  check(`Auto-layout drag (${theme}): the frame keeps its size while it is dragged`, size.x === 261 && size.y === 316, JSON.stringify(size));
  await shot(page, `421-aldrag-swapped-${theme}`);

  // 3. Dropped: in its slot at once; one ⌘Z puts it all back.
  await page.mouse.up();
  await settle(page);
  now = await ys(page);
  check(`Auto-layout drag (${theme}): dropped in its slot at once, the others in their places`, now.join(",") === "104,40,168,232", now.join(","));
  await shot(page, `422-aldrag-dropped-${theme}`);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  now = await ys(page);
  check(`Auto-layout drag (${theme}): one undo step puts the order and the places back`, (await order(page)) === startOrder && now.join(",") === start.join(","), `${await order(page)} ${now.join(",")}`);
}
