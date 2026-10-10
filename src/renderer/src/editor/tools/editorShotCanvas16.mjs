// editor-shot's round 16 section (EDITOR_ONLY=canvas16): the owner's canvas handle rules, driven with real mouse and
// keyboard events and measured from the canvas's pixels (docs/research/canvas-handles16/README.md):
//
// 1. Auto layout: a padding hovered hatches only itself; ⌥ held its opposite too; a gap hatches every gap; the
//    Design panel's highlight call hatches the bottom padding.
// 2. Corner radius handles: a ⌘-drag on a rectangle's handle rounds every corner inward (the corners show the
//    canvas, the middle of each edge the fill); ⌘⌥ one corner; one undo step; the Corner radius field reads negative.
// 3. A frame with inverted corners clips its child there.
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const grey = fill(0.85, 0.85, 0.85);
// A horizontal auto-layout frame (white, 160 × 60, padding 10 / 10, gap 10, three 40 × 40 layers); a rectangle (red,
// 150 × 100); a frame (white, 150 × 100) holding a blue rectangle that fills it.
function nodes() {
  const out = [
    {
      guid: "16:1", phase: "CREATED", type: "FRAME", name: "Auto", parentIndex: { guid: "0:1", position: "!" }, size: { x: 160, y: 60 }, transform: at(0, 0),
      fillPaints: fill(1, 1, 1), stackMode: "HORIZONTAL", stackSpacing: 10, stackHorizontalPadding: 10, stackVerticalPadding: 10, stackPaddingRight: 10, stackPaddingBottom: 10,
      stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
    },
  ];
  ["!", '"', "#"].forEach((pos, i) =>
    out.push({ guid: `16:${2 + i}`, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: `L${i}`, parentIndex: { guid: "16:1", position: pos }, size: { x: 40, y: 40 }, transform: at(10 + i * 50, 10), fillPaints: grey })
  );
  out.push({ guid: "16:10", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Rect", parentIndex: { guid: "0:1", position: '"' }, size: { x: 150, y: 100 }, transform: at(0, 120), fillPaints: fill(0.9, 0.2, 0.2) });
  out.push({ guid: "16:20", phase: "CREATED", type: "FRAME", name: "Clip", parentIndex: { guid: "0:1", position: "#" }, size: { x: 150, y: 100 }, transform: at(220, 120), fillPaints: fill(1, 1, 1), cornerRadius: 30, rectangleTopLeftCornerRadius: 30, rectangleTopRightCornerRadius: 30, rectangleBottomRightCornerRadius: 30, rectangleBottomLeftCornerRadius: 30, invertedCornerMask: 15 });
  out.push({ guid: "16:21", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Inside", parentIndex: { guid: "16:20", position: "!" }, size: { x: 150, y: 100 }, transform: at(0, 0), fillPaints: fill(0.1, 0.4, 0.9) });
  return out;
}

/** Pixels of a page region whose colour `pred` keeps (page coordinates). */
async function pixels(page, clip, pred) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ b64, pred }) => {
      const keep = new Function("r", "g", "b", `return ${pred};`);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (keep(data[i], data[i + 1], data[i + 2])) n++;
      return n;
    },
    { b64: png.toString("base64"), pred }
  );
}

// Over white: the hatch's stripes are a light tint (blue: b high, r drops; pink: g drops).
const BLUE_STRIPE = "b > 240 && r < 225 && r > 150 && g > 200";
const PINK_STRIPE = "r > 240 && g < 225 && g > 150 && b > 200";
const RED = "r > 200 && g < 80 && b < 80";
const BLUE = "r < 60 && g > 80 && g < 130 && b > 200";

export async function canvas16Section(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 200 + window.__viewLeft(), y: 150, zoom: 2 });
    ed.engine.setSelection(["16:1"]);
  }, nodes());
  await settle(page);
  const rect = await page.evaluate(() => {
    const b = window.__designerEditor.canvas.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const z = cam.zoom;
  const S = (x, y) => [rect.left + cam.x + x * z, rect.top + cam.y + y * z];
  const box = (x, y, w, h) => {
    const [px, py] = S(x, y);
    return { x: Math.round(px), y: Math.round(py), width: Math.round(w * z), height: Math.round(h * z) };
  };
  const node = (id) => page.evaluate((r) => window.__designerEditor.engine.readNode(r), id);
  const shoot = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const away = async () => {
    await page.mouse.move(rect.right - 30, rect.bottom - 30);
    await settle(page);
  };
  const alArea = box(-20, -20, 200, 100);
  // The paddings' insides (clear of the bars and of the frame's outline).
  const left = box(2, 14, 6, 14), right = box(152, 14, 6, 14), bottom = box(60, 52, 40, 6);
  const gap1 = box(51, 14, 8, 14), gap2 = box(101, 14, 8, 14);

  // ---- 1. The hatch. -------------------------------------------------------------------------------------------------
  await page.mouse.move(...S(5, 15));
  await settle(page);
  let l = await pixels(page, left, BLUE_STRIPE), r = await pixels(page, right, BLUE_STRIPE);
  check(`Canvas16 ${theme}: a padding hovered hatches only itself`, l > 8 && r === 0, `left ${l}, right ${r}`);
  await shoot("canvas16-padding", alArea);
  await page.keyboard.down("Alt");
  await settle(page);
  l = await pixels(page, left, BLUE_STRIPE);
  r = await pixels(page, right, BLUE_STRIPE);
  check(`Canvas16 ${theme}: ⌥ held hatches the opposite padding too`, l > 8 && r > 8, `left ${l}, right ${r}`);
  await shoot("canvas16-padding-alt", alArea);
  await page.keyboard.up("Alt");
  await settle(page);
  r = await pixels(page, right, BLUE_STRIPE);
  check(`Canvas16 ${theme}: ⌥ let go: only the hovered one again`, r === 0, `right ${r}`);
  await page.mouse.move(...S(55, 15));
  await settle(page);
  const g1 = await pixels(page, gap1, PINK_STRIPE), g2 = await pixels(page, gap2, PINK_STRIPE);
  check(`Canvas16 ${theme}: a gap hovered hatches every gap`, g1 > 8 && g2 > 8, `gap 1 ${g1}, gap 2 ${g2}`);
  await shoot("canvas16-gaps", alArea);
  await away();
  await page.evaluate(() => window.__designerEditor.engine.setSpacingHighlight(8));
  await settle(page);
  const b = await pixels(page, bottom, BLUE_STRIPE), l2 = await pixels(page, left, BLUE_STRIPE);
  check(`Canvas16 ${theme}: the Design panel's highlight hatches the bottom padding (pointer away)`, b > 8 && l2 === 0, `bottom ${b}, left ${l2}`);
  await shoot("canvas16-panel-highlight", alArea);
  await page.evaluate(() => window.__designerEditor.engine.setSpacingHighlight(0));
  await settle(page);

  // ---- 2. Radius handles: ⌘ inward. ------------------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["16:10"]));
  const rArea = box(-20, 100, 190, 140);
  const [cx, cy] = S(75, 170);
  await page.mouse.move(cx, cy);
  await settle(page);
  const [hx, hy] = [S(0, 120)[0] + 12, S(0, 120)[1] + 12]; // the top-left handle, 12 px in
  await page.mouse.move(hx, hy);
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.down();
  await page.mouse.move(hx + 40, hy + 40, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("ControlOrMeta");
  await settle(page);
  let n = await node("16:10");
  check(`Canvas16 ${theme}: a ⌘-drag on a radius handle rounds every corner inward`, n.rectangleTopLeftCornerRadius > 10 && n.invertedCornerMask === 15, `${n.rectangleTopLeftCornerRadius} mask ${n.invertedCornerMask}`);
  await away();
  const rad = n.rectangleTopLeftCornerRadius;
  // Each corner's cut (the canvas shows) and an edge's middle (the fill).
  const cut = (x, y) => box(x, y, 4, 4);
  const cuts = await Promise.all([cut(1, 121), cut(145, 121), cut(145, 215), cut(1, 215)].map((c) => pixels(page, c, RED)));
  const edge = await pixels(page, box(70, 121, 8, 4), RED);
  check(`Canvas16 ${theme}: …the four corners cut away (no fill), the edges filled`, cuts.every((c) => c === 0) && edge > 20, `cuts ${cuts}, edge ${edge}, r ${rad}`);
  // Just past the circle on the diagonal: filled.
  const past = await pixels(page, box(rad * 0.75 + 2, 120 + rad * 0.75 + 2, 3, 3), RED);
  check(`Canvas16 ${theme}: …filled just past the quarter circle`, past > 10, String(past));
  await shoot("canvas16-radius-inverted", rArea);
  const field = await page.evaluate(() => document.querySelector('input[aria-label="Corner radius"]')?.value ?? null);
  check(`Canvas16 ${theme}: the Corner radius field reads the inverted radius as negative`, field !== null && Number(field) === -rad, String(field));
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  n = await node("16:10");
  check(`Canvas16 ${theme}: one undo step puts it back`, (n.invertedCornerMask ?? 0) === 0 && (n.rectangleTopLeftCornerRadius ?? 0) === 0, `${n.invertedCornerMask} ${n.rectangleTopLeftCornerRadius}`);
  // ⌘⌥ on the bottom-right: that corner only.
  await page.mouse.move(cx, cy);
  await settle(page);
  const [bx, by] = [S(150, 220)[0] - 12, S(150, 220)[1] - 12];
  await page.mouse.move(bx, by);
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(bx - 30, by - 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("ControlOrMeta");
  await settle(page);
  n = await node("16:10");
  check(`Canvas16 ${theme}: ⌘⌥ rounds only the dragged corner inward`, n.invertedCornerMask === 4 && n.rectangleBottomRightCornerRadius > 10 && (n.rectangleTopLeftCornerRadius ?? 0) === 0, JSON.stringify([n.invertedCornerMask, n.rectangleTopLeftCornerRadius, n.rectangleBottomRightCornerRadius]));
  await away();
  await shoot("canvas16-radius-one-inverted", rArea);
  await page.evaluate(() => window.__designerEditor.engine.undo());

  // ---- 3. A frame with inverted corners clips its child. --------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  const fCuts = await Promise.all([box(221, 121, 4, 4), box(365, 215, 4, 4)].map((c) => pixels(page, c, BLUE)));
  const fMid = await pixels(page, box(290, 165, 6, 6), BLUE);
  check(`Canvas16 ${theme}: a frame with inverted corners clips its child there`, fCuts.every((c) => c === 0) && fMid > 20, `cuts ${fCuts}, middle ${fMid}`);
  await shoot("canvas16-frame-clip", box(200, 100, 190, 140));
}
