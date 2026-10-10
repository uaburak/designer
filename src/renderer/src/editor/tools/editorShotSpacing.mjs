// editor-shot's spacing section (EDITOR_ONLY=spacing15, round 15): auto layout's padding and gap handles and the
// `</>` button as live Figma's (the owner's recording and 47–49.png; docs/research/figma/live/behaviour/spacing-handles.md),
// driven with real mouse events and measured from the canvas's pixels:
//
// 1. A padding hovered off its bar: hatched in light blue stripes, no value, the arrow.
// 2. Its bar hovered: the blue value badge right of and above the pointer, the spacing cursor.
// 3. A gap's bar hovered: pink hatch and a pink badge.
// 4. A padding and a gap dragged: the values follow (one undo step each).
// 5. A click on the gap's bar: its field; 24 typed → the gap is 24.
// 6. The `</>` hovered: a filled blue square, the tooltip after the delay; clicked: ready for dev, the button green.
/* global window, atob, Blob, createImageBitmap, OffscreenCanvas */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
// The recording's Frame 4883: vertical, 82 wide, hugging its height, padding 18 / 16 / 18 / 17, gap 10, two grey
// layers 46 × 30.
function nodes() {
  return [
    {
      guid: "16:1", phase: "CREATED", type: "FRAME", name: "Frame 4883", parentIndex: { guid: "0:1", position: "!" }, size: { x: 82, y: 103 }, transform: at(0, 0),
      fillPaints: fill(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 10, stackHorizontalPadding: 18, stackVerticalPadding: 16, stackPaddingRight: 18, stackPaddingBottom: 17,
      stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED",
    },
    { guid: "16:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "A", parentIndex: { guid: "16:1", position: "!" }, size: { x: 46, y: 30 }, transform: at(18, 16), fillPaints: fill(0.85, 0.85, 0.85) },
    { guid: "16:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "B", parentIndex: { guid: "16:1", position: '"' }, size: { x: 46, y: 30 }, transform: at(18, 56), fillPaints: fill(0.85, 0.85, 0.85) },
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

/** How many separate runs of kept pixels along a 1-px row: stripes make several. */
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

// Over white: the hatch's stripes are a light tint of the colour (blue: b stays high, r drops; pink: g drops).
const BLUE_STRIPE = "b > 240 && r < 225 && r > 150 && g > 200";
const PINK_STRIPE = "r > 240 && g < 225 && g > 150 && b > 200";
const BLUE_SOLID = "r < 60 && g > 120 && g < 180 && b > 200"; // #0d99ff / #0c8ce9
const PINK_SOLID = "r > 220 && g < 80 && b > 150"; // #ff24bd / #f316b0
const GREEN_SOLID = "r < 60 && g > 150 && b > 70 && b < 120"; // #14ae5c
const TOOLTIP = "r > 20 && r < 40 && g > 20 && g < 40 && b > 20 && b < 40"; // #1e1e1e

export async function spacing15Section(page, theme, { open, settle, check, outDir, docsDir }) {
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
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const S = (x, y) => [rect.left + cam.x + x * cam.zoom, rect.top + cam.y + y * cam.zoom];
  const node = () => page.evaluate(() => window.__designerEditor.engine.readNode("16:1"));
  const cursor = () => page.evaluate(() => window.__designerEditor.canvas.style.cursor);
  const crop = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const [fx, fy] = S(0, 0);
  const area = { x: Math.floor(fx - 40), y: Math.floor(fy - 50), width: 82 * 3 + 120, height: 103 * 3 + 100 };
  const h = (await node()).size.y;
  check(`Spacing15 ${theme}: the frame hugs its layers (82 × 103)`, h === 103, String(h));

  // ---- 1. The right padding off its bar: hatched, no value, the arrow. ------------------------------------------------
  await page.mouse.move(...S(73, 20));
  await settle(page);
  const [, ry] = S(0, 30);
  const [rx0] = S(64, 0);
  const strip = { x: Math.ceil(rx0) + 2, y: Math.round(ry), width: 18 * 3 - 4, height: 1 };
  const stripes = await runs(page, strip, BLUE_STRIPE);
  check(`Spacing15 ${theme}: a padding hovered off its bar is hatched (light blue stripes across it)`, stripes >= 4, `${stripes} stripes`);
  const [bx, by] = S(73, 20);
  const badgeBox = { x: Math.round(bx + 6), y: Math.round(by - 34), width: 40, height: 30 };
  const noBadge = (await pixels(page, badgeBox, BLUE_SOLID)).length;
  // (the frame's 1 px outline runs through the box: ~30 px; a badge would be ~250)
  check(`Spacing15 ${theme}: …with no value and the arrow`, noBadge < 80 && !(await cursor()).includes("col-resize"), `${noBadge} px, ${(await cursor()).slice(-30)}`);
  await crop("spacing15-padding-hatch", area);

  // ---- 2. On its bar: the value right of and above the pointer, the spacing cursor. ---------------------------------
  const barR = S(73, 51.5);
  await page.mouse.move(barR[0], barR[1] + 1);
  await settle(page);
  const badge = await pixels(page, { x: Math.round(barR[0] + 6), y: Math.round(barR[1] - 34), width: 40, height: 30 }, BLUE_SOLID);
  check(`Spacing15 ${theme}: on the bar, the padding's value in a blue badge right of and above the pointer`, badge.length > 150, `${badge.length} px`);
  check(`Spacing15 ${theme}: …and the spacing cursor (across)`, (await cursor()).includes("col-resize"), (await cursor()).slice(-30));
  await crop("spacing15-padding-bar", area);

  // ---- 3. The gap's bar: pink hatch, pink badge, the up-and-down cursor. -------------------------------------------
  const gap = S(41, 51);
  await page.mouse.move(gap[0] + 1, gap[1]);
  await settle(page);
  const [gx0] = S(18, 0);
  const pinkStripes = await runs(page, { x: Math.ceil(gx0) + 2, y: Math.round(gap[1] + 8), width: 46 * 3 - 4, height: 1 }, PINK_STRIPE);
  const pinkBadge = await pixels(page, { x: Math.round(gap[0] + 6), y: Math.round(gap[1] - 34), width: 40, height: 30 }, PINK_SOLID);
  check(`Spacing15 ${theme}: a gap's bar hovered: pink stripes and a pink badge`, pinkStripes >= 6 && pinkBadge.length > 150, `${pinkStripes} stripes, ${pinkBadge.length} px`);
  check(`Spacing15 ${theme}: …the spacing cursor up and down`, (await cursor()).includes("row-resize"), (await cursor()).slice(-30));
  await crop("spacing15-gap-bar", area);

  // ---- 4. Drags. -----------------------------------------------------------------------------------------------------
  await page.mouse.move(barR[0], barR[1] + 1);
  await page.mouse.down();
  await page.mouse.move(barR[0] - 12, barR[1] + 1, { steps: 4 });
  await settle(page);
  let n = await node();
  check(`Spacing15 ${theme}: dragging the right padding's bar 12 px left at 300 % makes it 22`, n.stackPaddingRight === 22, String(n.stackPaddingRight));
  await crop("spacing15-padding-drag", area);
  await page.mouse.up();
  await page.mouse.move(gap[0] + 1, gap[1]);
  await page.mouse.down();
  await page.mouse.move(gap[0] + 1, gap[1] + 9, { steps: 4 });
  await settle(page);
  n = await node();
  check(`Spacing15 ${theme}: dragging the gap's bar 9 px down (3 units, ×2 for the first gap) makes it 16, the frame hugging (109)`, n.stackSpacing === 16 && n.size.y === 109, `${n.stackSpacing} ${n.size.y}`);
  await crop("spacing15-gap-drag", area);
  await page.mouse.up();
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  n = await node();
  check(`Spacing15 ${theme}: each drag one undo step`, n.stackSpacing === 10 && n.stackPaddingRight === 18, `${n.stackSpacing} ${n.stackPaddingRight}`);

  // ---- 5. A click on the gap's bar: its field, 24 typed. ------------------------------------------------------------
  await page.mouse.move(gap[0] + 1, gap[1]);
  await settle(page);
  await page.mouse.click(gap[0] + 1, gap[1]);
  const field = await page.waitForSelector('[data-inline-value="GAP"] input', { timeout: 3000 }).catch(() => null);
  check(`Spacing15 ${theme}: a click on the gap's bar opens its field`, !!field, "");
  if (field) {
    await field.fill("24");
    await page.keyboard.press("Enter");
    await settle(page);
    n = await node();
    check(`Spacing15 ${theme}: 24 typed → the gap is 24`, n.stackSpacing === 24, String(n.stackSpacing));
    await page.evaluate(() => window.__designerEditor.engine.undo());
  }
  await page.mouse.move(rect.right - 30, rect.bottom - 30);
  await settle(page);

  // ---- 6. The `</>` button. ----------------------------------------------------------------------------------------
  const hits = await page.evaluate(() => window.__designerEditor.engine.devInfo().hits.statuses);
  const mark = hits.find((s) => s.ref === "16:1" && s.kind === 0);
  check(`Spacing15 ${theme}: the selected frame's </> button is there`, !!mark, JSON.stringify(hits));
  if (mark) {
    const ix = rect.left + mark.x + mark.width / 2, iy = rect.top + mark.y + mark.height / 2;
    const iconBox = { x: Math.round(rect.left + mark.x), y: Math.round(rect.top + mark.y), width: 16, height: 16 };
    const tipBox = { x: Math.round(ix - 80), y: Math.round(iconBox.y + 16), width: 160, height: 34 };
    // The tooltip's dark box over the frame's white top (the dark canvas is the same colour): what it adds.
    const before = (await pixels(page, tipBox, TOOLTIP)).length;
    await page.mouse.move(ix, iy);
    await settle(page);
    const early = (await pixels(page, tipBox, TOOLTIP)).length - before;
    const filled = (await pixels(page, iconBox, BLUE_SOLID)).length;
    // (Whether the tooltip is up yet depends on how long the screenshot took — the delay itself is the native tests'.)
    check(`Spacing15 ${theme}: hovered, the </> is a filled blue square`, filled > 120, `${filled} px, tooltip already ${early} px`);
    await page.waitForTimeout(700);
    await settle(page);
    const tip = (await pixels(page, tipBox, TOOLTIP)).length - before;
    check(`Spacing15 ${theme}: …and after the delay its tooltip "Mark as ready for dev" under it`, tip > 1000, `${tip} px more`);
    await crop("spacing15-dev-tooltip", { x: Math.round(ix - 140), y: Math.round(iy - 40), width: 280, height: 110 });
    await page.mouse.click(ix, iy);
    await settle(page);
    const status = (await page.evaluate(() => window.__designerEditor.engine.readNode("16:1", { fields: ["sectionStatusInfo"] })))?.sectionStatusInfo?.status;
    check(`Spacing15 ${theme}: a click marks the frame ready for dev`, status === "BUILD", String(status));
    await page.mouse.move(rect.right - 30, rect.bottom - 30);
    await settle(page);
    await settle(page);
    const green = (await pixels(page, iconBox, GREEN_SOLID)).length;
    check(`Spacing15 ${theme}: …and the button is green`, green > 120, `${green} px`);
    await crop("spacing15-ready", { x: Math.round(ix - 140), y: Math.round(iy - 40), width: 280, height: 110 });
    await page.evaluate(() => window.__designerEditor.engine.undo());
    await settle(page);
  }
}
