// editor-shot's round 17 section (EDITOR_ONLY=feedback17): canvas feedback, driven with real mouse events and measured
// from the canvas's pixels (the owner's live Figma 68–71.png):
//
// 1. A frame's name is grey; the pointer on its name (or the frame) turns it the selection's blue, with the frame's
//    hover outline; a component's name stays the component purple, hovered or not.
// 2. Haptics: a corner radius drag on the canvas plays the trackpad's tick (engine HAPTIC → window.designer.haptics)
//    once per whole step, none for a press without movement.
/* global window, atob, Blob, createImageBitmap, OffscreenCanvas */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
// A frame "SmallFrame" (white, 150 × 150) and a component "Button" (white, 150 × 150) beside it; a rectangle (grey,
// 150 × 100) under them for the radius drag.
function nodes() {
  return [
    { guid: "17:1", phase: "CREATED", type: "FRAME", name: "SmallFrame", parentIndex: { guid: "0:1", position: "!" }, size: { x: 150, y: 150 }, transform: at(0, 0), fillPaints: fill(1, 1, 1) },
    { guid: "17:2", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: '"' }, size: { x: 150, y: 150 }, transform: at(250, 0), fillPaints: fill(1, 1, 1) },
    { guid: "17:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Rect", parentIndex: { guid: "0:1", position: "#" }, size: { x: 150, y: 100 }, transform: at(0, 250), fillPaints: fill(0.85, 0.85, 0.85) },
  ];
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

// The title's ink: the selection's blue (#7cc4f8 on dark, #007be5 on light), the component purple (#d1a8ff / #8638e5),
// else grey (r ≈ g ≈ b).
const BLUE = "b > r + 60 && g > r + 25 && b > g + 20";
const PURPLE = "r > g + 25 && b > g + 50";

export async function feedback17Section(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 200 + window.__viewLeft(), y: 150, zoom: 1 });
    ed.engine.setSelection([]);
  }, nodes());
  await settle(page);
  const rect = await page.evaluate(() => {
    const b = window.__designerEditor.canvas.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const z = cam.zoom;
  const S = (x, y) => [rect.left + cam.x + x * z, rect.top + cam.y + y * z];
  // A title's band: 18 px above its frame's top-left corner, 70 px along.
  const titleBox = (x) => {
    const [px, py] = S(x, 0);
    return { x: Math.round(px), y: Math.round(py) - 20, width: 70, height: 18 };
  };
  const shoot = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const away = async () => {
    await page.mouse.move(rect.right - 30, rect.bottom - 30);
    await settle(page);
  };
  const area = (() => {
    const [px, py] = S(-20, -30);
    return { x: Math.round(px), y: Math.round(py), width: 460, height: 200 };
  })();

  // ---- 1. Titles. -------------------------------------------------------------------------------------------------
  await away();
  const frameTitle = titleBox(0), compTitle = titleBox(250);
  let blue = await pixels(page, frameTitle, BLUE);
  let purple = await pixels(page, compTitle, PURPLE);
  check(`Feedback17 ${theme}: a frame's name is grey unhovered, a component's purple`, blue === 0 && purple > 10, `frame blue ${blue}, component purple ${purple}`);
  await shoot("feedback17-titles", area);
  // The pointer on the frame's name: blue, the frame outlined.
  await page.mouse.move(frameTitle.x + 12, frameTitle.y + 10);
  await settle(page);
  blue = await pixels(page, frameTitle, BLUE);
  check(`Feedback17 ${theme}: the pointer on a frame's name turns it blue`, blue > 10, `blue ${blue}`);
  await shoot("feedback17-title-hover", area);
  // The pointer inside the frame: blue too (live 69.png).
  await page.mouse.move(...S(20, 20));
  await settle(page);
  blue = await pixels(page, frameTitle, BLUE);
  check(`Feedback17 ${theme}: the pointer on the frame turns its name blue`, blue > 10, `blue ${blue}`);
  // The component's name hovered: purple still, never blue.
  await page.mouse.move(compTitle.x + 12, compTitle.y + 10);
  await settle(page);
  purple = await pixels(page, compTitle, PURPLE);
  const compBlue = await pixels(page, compTitle, BLUE);
  check(`Feedback17 ${theme}: a component's name hovered stays purple`, purple > 10 && compBlue === 0, `purple ${purple}, blue ${compBlue}`);
  await shoot("feedback17-component-hover", area);
  await away();
  blue = await pixels(page, frameTitle, BLUE);
  check(`Feedback17 ${theme}: the pointer gone, the frame's name is grey again`, blue === 0, `blue ${blue}`);

  // ---- 2. Haptics from a canvas drag. ------------------------------------------------------------------------------
  await page.evaluate(() => {
    window.__ticks = 0;
    window.designer = { ...(window.designer ?? {}), haptics: { tick: () => window.__ticks++ } };
    window.__designerEditor.engine.setSelection(["17:3"]);
  });
  await page.mouse.move(...S(75, 300));
  await settle(page);
  // The top-left radius handle sits 12 px in from the corner (a rectangle at zoom 1).
  const [hx, hy] = S(12, 262);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await settle(page);
  const still = await page.evaluate(() => window.__ticks);
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(hx + i, hy + i);
    await page.evaluate(() => new Promise((r) => window.requestAnimationFrame(() => r())));
  }
  await page.mouse.up();
  await settle(page);
  const radius = await page.evaluate(() => window.__designerEditor.engine.readNode("17:3")?.rectangleTopLeftCornerRadius ?? null);
  const ticks = await page.evaluate(() => window.__ticks);
  check(
    `Feedback17 ${theme}: a radius drag ticks once per whole step (10 moves of a pixel each), none for the press`,
    still === 0 && radius === 10 && ticks === 10,
    `press ${still}, radius ${radius}, ticks ${ticks}`
  );
}
