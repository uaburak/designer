// editor-shot's prototype connections section (EDITOR_ONLY=proto17, round 17; the owner's report, live Figma 61–65.png
// and the live session of 2026-10-10), driven with real mouse events:
//
// 1. Variants: a drag from a variant's nub onto another variant of its set connects them — Change to, the variant
//    (not the set) outlined while hovered.
// 2. A click on a connection's line (not its label) selects it: its hotspot selected, Interaction details open, the
//    line and its "While hovering" label in the selection colour; a click on the label does the same.
// 3. A drag on the line to empty canvas removes the connection; ⌘Z brings it back.
/* global window, document */
import path from "node:path";
import process from "node:process";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const node = (guid, type, parent, pos, name, x, y, w, h, extra = {}) => ({
  guid, phase: "CREATED", type, name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), ...extra,
});
const hover = { event: { interactionType: "ON_HOVER" }, actions: [{ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", transitionNodeID: { sessionID: 27, localID: 20 }, transitionType: "INSTANT_TRANSITION" }] };
function nodes() {
  return [
    node("27:1", "FRAME", "0:1", "!", "Button", 0, 0, 400, 180, { isStateGroup: true, fillPaints: [] }),
    node("27:2", "SYMBOL", "27:1", "!", "State=Default", 20, 20, 160, 120, { fillPaints: fill(0.85, 0.85, 0.85) }),
    node("27:3", "SYMBOL", "27:1", '"', "State=Hover", 220, 20, 160, 120, { fillPaints: fill(0.7, 0.8, 1) }),
    node("27:10", "FRAME", "0:1", '"', "Screen", 0, 300, 300, 200, { fillPaints: fill(1, 1, 1) }),
    node("27:11", "ROUNDED_RECTANGLE", "27:10", "!", "Card", 20, 80, 100, 40, { fillPaints: fill(0.9, 0.6, 0.6), prototypeInteractions: [hover] }),
    node("27:20", "FRAME", "0:1", "#", "Details", 700, 300, 300, 200, { fillPaints: fill(1, 1, 1) }),
  ];
}

const BLUE = (r, g, b) => r < 60 && g > 120 && g < 180 && b > 200; // #0d99ff / #0c8ce9

export async function proto17Section(page, theme, { open, settle, check, outDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.ui.set({ rightTab: "prototype" });
    ed.engine.setCamera({ x: 120 + window.__viewLeft(), y: 100, zoom: 1 });
    ed.engine.setSelection([]);
  }, nodes());
  await settle(page);
  const view = await page.evaluate(() => {
    const c = document.getElementById("engine-canvas").getBoundingClientRect();
    return { cl: c.left, ct: c.top };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const S = (x, y) => [view.cl + cam.x + x * cam.zoom, view.ct + cam.y + y * cam.zoom];
  const area = (() => {
    const [x0, y0] = S(-40, -40);
    return { x: Math.round(x0), y: Math.round(y0), width: 1100, height: 600 };
  })();
  const shot = async (name) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip: area });
  };
  const read = (guid) => page.evaluate((g) => window.__designerEditor.engine.readNode(g)?.prototypeInteractions ?? [], guid);
  const pixels = async (clip, keep) => {
    const png = await page.screenshot({ clip });
    const d = await page.evaluate(
      async ({ b64 }) => {
        const bytes = Uint8Array.from(window.atob(b64), (c) => c.charCodeAt(0));
        const bmp = await window.createImageBitmap(new window.Blob([bytes], { type: "image/png" }));
        const c = new window.OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data);
      },
      { b64: png.toString("base64") }
    );
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (keep(d[i], d[i + 1], d[i + 2])) n++;
    return n;
  };

  // ---- 1. Variant → variant: Change to. ----------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["27:2"]));
  await settle(page);
  const [nx, ny] = S(180, 80); // State=Default's right middle
  const [vx, vy] = S(300, 80); // over State=Hover
  await page.mouse.move(nx - 6, ny);
  await page.mouse.move(nx, ny);
  await settle(page);
  await page.mouse.down();
  await page.mouse.move(nx + 40, ny + 10, { steps: 4 });
  await page.mouse.move(vx, vy, { steps: 6 });
  await settle(page);
  // The variant is outlined, not the set: blue along State=Hover's left edge (x 220), none on the set's left (x 0).
  const [ex, ey] = S(220, 80);
  const [sx0, sy0] = S(0, 160);
  const onVariant = await pixels({ x: Math.round(ex - 1), y: Math.round(ey - 20), width: 3, height: 40 }, BLUE);
  const onSet = await pixels({ x: Math.round(sx0 - 1), y: Math.round(sy0 - 10), width: 3, height: 20 }, BLUE);
  check(`Proto17 ${theme}: dragging a variant's nub over another variant outlines that variant, not the set`, onVariant >= 20 && onSet === 0, `variant edge ${onVariant} px, set edge ${onSet} px`);
  await shot("proto17-variant-drag");
  await page.mouse.up();
  await settle(page);
  let list = await read("27:2");
  const a = list[0]?.actions?.[0];
  check(
    `Proto17 ${theme}: …dropped: Change to State=Hover`,
    list.length === 1 && a?.navigationType === "SWAP_STATE" && a?.transitionNodeID?.localID === 3,
    JSON.stringify(list).slice(0, 200)
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);

  // ---- 2. A click on the line selects the connection. --------------------------------------------------------------
  // Card (20, 380)–(120, 420) → Details (700, 300)–(1000, 500): level, a straight line from (120, 400) to (700, 400).
  const [px, py] = S(220, 401);
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page);
  const sel = await page.evaluate(() => window.__designerEditor.engine.getSelection?.() ?? null);
  const dialog = page.getByRole("dialog", { name: "Interaction", exact: true });
  check(`Proto17 ${theme}: a click on a connection's line opens its Interaction details`, (await dialog.count()) === 1 && (await dialog.getByText("While hovering").count()) >= 1);
  check(`Proto17 ${theme}: …and selects its hotspot`, !sel || JSON.stringify(sel).includes("27:11"), JSON.stringify(sel));
  // The line in the selection colour now (it was quiet light blue).
  const [lx, ly] = S(560, 400);
  const lineBlue = await pixels({ x: Math.round(lx - 2), y: Math.round(ly - 3), width: 4, height: 6 }, BLUE);
  check(`Proto17 ${theme}: …the selected connection in the selection colour`, lineBlue >= 2, `${lineBlue} px`);
  await shot("proto17-line-click");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  const quiet = await pixels({ x: Math.round(lx - 2), y: Math.round(ly - 3), width: 4, height: 6 }, BLUE);
  check(`Proto17 ${theme}: …closed and deselected: quiet again`, quiet === 0, `${quiet} px`);
  // Its label (the curve's middle, x 410): a click there opens it too.
  const [cx, cy] = S(410, 410);
  await page.mouse.click(cx, cy);
  await settle(page);
  check(`Proto17 ${theme}: a click on its "While hovering" label opens it too`, (await dialog.count()) === 1);
  await shot("proto17-label-click");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);

  // ---- 3. A drag on the line to empty canvas removes the connection; ⌘Z restores it. ----------------------------------
  const [ox, oy] = S(400, 650);
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 10, py + 30, { steps: 3 });
  await page.mouse.move(ox, oy, { steps: 6 });
  await settle(page);
  await shot("proto17-line-drag");
  await page.mouse.up();
  await settle(page);
  list = await read("27:11");
  check(`Proto17 ${theme}: a drag on the line off to empty canvas removes the connection`, list.length === 0, JSON.stringify(list).slice(0, 120));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await settle(page);
  list = await read("27:11");
  check(`Proto17 ${theme}: …⌘Z brings it back`, list.length === 1, JSON.stringify(list).slice(0, 120));
}
