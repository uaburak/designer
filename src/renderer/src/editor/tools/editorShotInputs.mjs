// editor-shot's inputs section (EDITOR_ONLY=inputs16, round 16): the Design panel's padding fields and number
// scrubbing as live Figma's (the owner's 53–57.png), driven with real mouse and key events:
//
// 1. Paddings 18 / 22 / 17 / 19: the pair fields read "19, 22" and "18, 17" (not Mixed, not four fields).
// 2. Hovering the horizontal field hatches the left and right paddings on the canvas; the vertical one the top
//    (and bottom); the gap field the gap; off the fields nothing.
// 3. ⌘-click on the vertical field: one field "18, 22, 17, 19", focused, its text selected; "12, 18" typed → top /
//    bottom 12, left / right 18; Enter takes it back to the pair.
// 4. A focused field with its "Apply variable" button: the button inside the field, the blue ring whole round it.
// 5. Scrubbing the horizontal field's icon: whole steps, one per 4 px (40 px → +10).
/* global window, document, getComputedStyle, atob, Blob, createImageBitmap, OffscreenCanvas */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
// Vertical, 82 wide, hugging its height; padding 18 / 22 / 17 / 19 (top, right, bottom, left) as on 53.png; gap 16;
// two grey layers 41 × 30 → 82 × 111.
function nodes() {
  return [
    {
      guid: "16:1", phase: "CREATED", type: "FRAME", name: "Frame", parentIndex: { guid: "0:1", position: "!" }, size: { x: 82, y: 111 }, transform: at(0, 0),
      fillPaints: fill(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 16, stackVerticalPadding: 18, stackPaddingRight: 22, stackPaddingBottom: 17, stackHorizontalPadding: 19,
      stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED",
    },
    { guid: "16:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "A", parentIndex: { guid: "16:1", position: "!" }, size: { x: 41, y: 30 }, transform: at(19, 18), fillPaints: fill(0.85, 0.85, 0.85) },
    { guid: "16:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "B", parentIndex: { guid: "16:1", position: '"' }, size: { x: 41, y: 30 }, transform: at(19, 64), fillPaints: fill(0.85, 0.85, 0.85) },
  ];
}

/** Pixels of a page region whose colour `pred` keeps (page coordinates). */
async function pixels(page, clip, pred) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ b64, x0, y0, pred }) => {
      const keep = new Function("r", "g", "b", `return ${pred};`);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
      const out = [];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (keep(data[i], data[i + 1], data[i + 2])) out.push([x0 + x, y0 + y]);
        }
      return out;
    },
    { b64: png.toString("base64"), x0: clip.x, y0: clip.y, pred }
  );
}

/** Separate runs of kept pixels along a 1-px row: stripes make several. */
async function runs(page, clip, pred) {
  const xs = new Set((await pixels(page, clip, pred)).map(([x]) => x));
  let count = 0, prev = false;
  for (let x = clip.x; x < clip.x + clip.width; x++) {
    const cur = xs.has(x);
    if (cur && !prev) count++;
    prev = cur;
  }
  return count;
}

const BLUE_STRIPE = "b > 240 && r < 225 && r > 150 && g > 200";
const PINK_STRIPE = "r > 240 && g < 225 && g > 150 && b > 200";
const RING = "b > 180 && r < 90 && g > 110 && g < 190"; // --figma-color-border-selected (#0d99ff / #0c8ce9)

export async function inputs16Section(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 300 + window.__viewLeft(), y: 200, zoom: 3 });
    ed.engine.setSelection(["16:1"]);
  }, nodes());
  await settle(page);
  const rect = await page.evaluate(() => {
    const b = window.__designerEditor.canvas.getBoundingClientRect();
    return { left: b.left, top: b.top };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const S = (x, y) => [rect.left + cam.x + x * cam.zoom, rect.top + cam.y + y * cam.zoom];
  const node = () => page.evaluate(() => window.__designerEditor.engine.readNode("16:1"));
  const pads = async () => {
    const n = await node();
    return [n.stackVerticalPadding, n.stackPaddingRight, n.stackPaddingBottom, n.stackHorizontalPadding].join(",");
  };
  const field = (label) => page.$(`input[aria-label="${label}"]`);
  const value = async (label) => (await field(label))?.evaluate((el) => el.value) ?? null;
  const center = async (label) => {
    const b = await (await field(label)).evaluate((el) => {
      const r = el.closest('[data-ds="NumericInput"]').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return [b.x + b.w / 2, b.y + b.h / 2, b];
  };
  const panelClip = async () => {
    const b = await page.evaluate(() => {
      const el = document.querySelector('input[aria-label="Padding"], input[aria-label="Horizontal padding"]').closest('[data-ds="PropertyRow"]');
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    return { x: Math.floor(b.x - 8), y: Math.floor(b.y - 120), width: Math.ceil(b.width + 16), height: Math.ceil(b.height + 160) };
  };
  const crop = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const [fx, fy] = S(0, 0);
  const canvasArea = { x: Math.floor(fx - 30), y: Math.floor(fy - 40), width: 82 * 3 + 60, height: 111 * 3 + 80 };
  // A row across the frame 30 units down (the first layer's band): left padding 0–19, right 60–82.
  const [, rowY] = S(0, 33);
  const leftStrip = { x: Math.ceil(S(0, 0)[0]) + 2, y: Math.round(rowY), width: 19 * 3 - 4, height: 1 };
  const rightStrip = { x: Math.ceil(S(60, 0)[0]) + 2, y: Math.round(rowY), width: 22 * 3 - 4, height: 1 };
  const topStrip = { x: Math.ceil(S(30, 0)[0]), y: Math.round(S(0, 9)[1]), width: 1, height: 1 };

  // ---- 1. The pair fields. ------------------------------------------------------------------------------------------
  const h = await value("Horizontal padding"), v = await value("Vertical padding");
  check(`Inputs16 ${theme}: paddings 18 / 22 / 17 / 19 read "19, 22" and "18, 17" (live 53.png)`, h === "19, 22" && v === "18, 17", `${h} | ${v}`);
  check(`Inputs16 ${theme}: …in two fields, not four`, !(await field("Left padding")), "");
  await crop("inputs16-padding-pair", await panelClip());

  // ---- 2. Hover → the canvas hatches what the field edits. ----------------------------------------------------------
  const [hx, hy] = await center("Horizontal padding");
  await page.mouse.move(hx + 10, hy);
  await settle(page);
  const left = await runs(page, leftStrip, BLUE_STRIPE), right = await runs(page, rightStrip, BLUE_STRIPE);
  check(`Inputs16 ${theme}: the horizontal padding field hovered hatches the left and right paddings`, left >= 3 && right >= 3, `${left} / ${right} stripes`);
  await crop("inputs16-hover-horizontal-canvas", canvasArea);
  const [vx, vy] = await center("Vertical padding");
  await page.mouse.move(vx + 10, vy);
  await settle(page);
  const leftOff = await runs(page, leftStrip, BLUE_STRIPE);
  const topRow = { x: Math.ceil(S(2, 0)[0]), y: Math.round(S(0, 9)[1]), width: 78 * 3, height: 1 };
  const top = await runs(page, topRow, BLUE_STRIPE);
  check(`Inputs16 ${theme}: the vertical one hatches the top (and bottom), not the sides`, top >= 6 && leftOff === 0, `top ${top}, left ${leftOff} stripes`);
  void topStrip;
  const [gx, gy] = await center("Vertical gap between objects");
  await page.mouse.move(gx, gy);
  await settle(page);
  const gapRow = { x: Math.ceil(S(19, 0)[0]) + 2, y: Math.round(S(0, 56)[1]), width: 41 * 3 - 4, height: 1 };
  const pink = await runs(page, gapRow, PINK_STRIPE);
  check(`Inputs16 ${theme}: the gap field hovered hatches the gap`, pink >= 6, `${pink} stripes`);
  await page.mouse.move(gx, gy + 300);
  await settle(page);
  const none = (await runs(page, leftStrip, BLUE_STRIPE)) + (await runs(page, gapRow, PINK_STRIPE));
  check(`Inputs16 ${theme}: off the fields, nothing hatched`, none === 0, `${none}`);

  // ---- 3. ⌘-click: one field over all four. -------------------------------------------------------------------------
  await page.keyboard.down("Meta");
  await page.mouse.click(vx + 10, vy);
  await page.keyboard.up("Meta");
  await settle(page);
  const one = await value("Padding");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") === "Padding" && el.selectionStart === 0 && el.selectionEnd === el.value.length;
  });
  check(`Inputs16 ${theme}: ⌘-click on a padding field: one field "18, 22, 17, 19" (top, right, bottom, left), focused and selected`, one === "18, 22, 17, 19" && focused, `${one} focused ${focused}`);
  await crop("inputs16-padding-merged", await panelClip());
  await page.keyboard.type("12, 18");
  await page.keyboard.press("Enter");
  await settle(page);
  check(`Inputs16 ${theme}: "12, 18" typed → top / bottom 12, left / right 18`, (await pads()) === "12,18,12,18", await pads());
  check(`Inputs16 ${theme}: Enter takes it back to the pair`, !(await field("Padding")) && (await value("Horizontal padding")) === "18", String(await value("Horizontal padding")));
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);

  // ---- 4. The Apply variable button inside a focused field, its ring whole. -----------------------------------------
  await page.click('[aria-label="Individual padding"]');
  await settle(page);
  const [lx, ly, lb] = await center("Left padding");
  await page.mouse.click(lx - 10, ly);
  await page.mouse.move(lx + 5, ly);
  await settle(page);
  const button = await page.evaluate(() => {
    const b = document.activeElement.closest('[data-bind-field]')?.querySelector('[aria-label="Apply variable"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, opacity: getComputedStyle(b).opacity };
  });
  const inside = !!button && button.x + button.w <= lb.x + lb.w - 1 && button.y >= lb.y + 1 && button.y + button.h <= lb.y + lb.h - 1 && button.opacity === "1";
  check(`Inputs16 ${theme}: the Apply variable button sits inside the focused field (live 56.png)`, inside, JSON.stringify(button));
  const ring = await pixels(page, { x: Math.floor(lb.x + lb.w) - 1, y: Math.round(lb.y + 4), width: 1, height: Math.round(lb.h - 8) }, RING);
  check(`Inputs16 ${theme}: …the blue ring runs whole past it`, ring.length >= Math.round(lb.h - 8) - 1, `${ring.length} of ${Math.round(lb.h - 8)} px`);
  await crop("inputs16-apply-variable-inside", { x: Math.floor(lb.x - 8), y: Math.floor(lb.y - 8), width: Math.ceil(lb.w * 2 + 40), height: Math.ceil(lb.h * 2 + 24) });
  await page.keyboard.press("Escape");
  await page.click('[aria-label="Individual padding"]');
  await settle(page);

  // ---- 5. Scrub the horizontal field's icon: whole steps, 4 px each. ------------------------------------------------
  const [, , hb] = await center("Horizontal padding");
  const ix = hb.x + 12, iy = hb.y + hb.h / 2;
  await page.mouse.move(ix, iy);
  await page.mouse.down();
  await page.mouse.move(ix + 20, iy, { steps: 5 });
  await page.mouse.move(ix + 40, iy, { steps: 5 });
  await page.mouse.up();
  await settle(page);
  const after = await node();
  check(`Inputs16 ${theme}: 40 px of scrub on the icon: +10 in whole steps (19, 22 → 29, 32)`, after.stackHorizontalPadding === 29 && after.stackPaddingRight === 32, `${after.stackHorizontalPadding} ${after.stackPaddingRight}`);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
}
