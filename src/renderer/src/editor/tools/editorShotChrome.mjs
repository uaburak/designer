// editor-shot's chrome + cursors section (EDITOR_ONLY=chrome15, round 15): the owner's two reports, measured in the
// page (docs/research/chrome-cursors/: Figma's figma-rotated-labels.png and figma-eyedropper.png, ours before).
//
// 1. A turned frame's name lies along its top edge from its top-left corner, its baseline 10 above the edge, and its
//    W × H badge is centred 6 under its bottom edge, both turned with it (Figma's 42.png, measured: baseline 10.0 CSS
//    px above the edge, the name from the corner; the badge 17 thick, ~7 off the edge, centred). A press on the turned
//    name selects the frame, a drag moves it; nothing is where an upright name or `</>` would be.
// 2. The cursors: resize and rotate cursors turned to the turned frame's corners (whole degrees), every cursor an
//    image-set of a 1× and a 2× SVG (crisp on Retina), the Pencil's own; a sheet of them all is shot.
// 3. The eyedropper (I): Figma's card follows the pointer — the pixels magnified with the middle one framed, the
//    colour's swatch and hex, "Click to sample" — and shows the hex of a known colour under the pointer; a click fills
//    the selection with it; Esc cancels (Move again, no card).
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, getComputedStyle */
import path from "node:path";

const DEG = 37;
const W = 332, H = 423;
const KNOWN = { r: 0x12 / 255, g: 0xab / 255, b: 0x34 / 255 }; // #12AB34

function nodes() {
  const c = Math.cos((DEG * Math.PI) / 180), s = Math.sin((DEG * Math.PI) / 180);
  const fill = (color) => [{ type: "SOLID", color: { ...color, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  return [
    // "Frame 406", turned 37° clockwise on screen (Figma's rotation −37°), its top-left corner at (200, 60).
    { guid: "15:1", phase: "CREATED", type: "FRAME", name: "Frame 406", parentIndex: { guid: "0:1", position: "!" }, size: { x: W, y: H }, transform: { m00: c, m01: -s, m02: 200, m10: s, m11: c, m12: 60 }, fillPaints: fill({ r: 1, g: 1, b: 1 }) },
    // The eyedropper's colours: a known green, and a grey rectangle to fill with it.
    { guid: "15:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Green", parentIndex: { guid: "0:1", position: '"' }, size: { x: 120, y: 120 }, transform: { m00: 1, m01: 0, m02: 470, m10: 0, m11: 1, m12: 430 }, fillPaints: fill(KNOWN) },
    { guid: "15:3", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Grey", parentIndex: { guid: "0:1", position: "#" }, size: { x: 120, y: 120 }, transform: { m00: 1, m01: 0, m02: 700, m10: 0, m11: 1, m12: 260 }, fillPaints: fill({ r: 0.6, g: 0.6, b: 0.6 }) },
  ];
}

/** Pixels of a page region whose colour `pred` keeps, as page coordinates. */
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
          if (keep(data[i], data[i + 1], data[i + 2])) out.push([x0 + x + 0.5, y0 + y + 0.5]);
        }
      return out;
    },
    { b64: png.toString("base64"), x0: clip.x, y0: clip.y, pred }
  );
}

/** The centroid and principal axis angle (degrees, −90…90) of a point set. */
function shape(points) {
  const n = points.length;
  if (!n) return null;
  let mx = 0, my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  return { x: mx, y: my, angle, n };
}

export async function chromeSection(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 120 + window.__viewLeft(), y: 120, zoom: 1 });
    ed.engine.setSelection([]);
  }, nodes());
  await settle(page);
  const canvasRect = await page.evaluate(() => {
    const b = window.__designerEditor.canvas.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const toScreen = ([x, y]) => [canvasRect.left + cam.x + x * cam.zoom, canvasRect.top + cam.y + y * cam.zoom];
  const c = Math.cos((DEG * Math.PI) / 180), s = Math.sin((DEG * Math.PI) / 180);
  const world = (x, y) => [200 + c * x - s * y, 60 + s * x + c * y];
  const at = (x, y) => toScreen(world(x, y));
  const u = [c, s], up = [s, -c]; // along the top edge; away from the frame, across it
  const corner = at(0, 0);
  const bottomMid = at(W / 2, H);
  const crop = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const area = { x: Math.floor(at(0, H)[0] - 60), y: Math.floor(corner[1] - 60), width: 0, height: 0 };
  area.width = Math.ceil(at(W, 0)[0] + 60 - area.x);
  area.height = Math.ceil(at(W, H)[1] + 60 - area.y);

  // ---- 1. The turned frame's name and badge. ------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["15:1"]));
  await page.mouse.move(canvasRect.right - 40, canvasRect.bottom - 40);
  await settle(page);
  await crop("chrome15-rotated-labels", area);
  // The badge: the selection blue's solid pixels (the outline is 1 thin; the handles are white inside).
  const blue = theme === "dark" ? "b > 200 && r < 60 && g > 120 && g < 180" : "b > 200 && r < 60 && g > 120 && g < 180";
  const badgePx = (await pixels(page, area, blue)).filter(([x, y]) => (x - bottomMid[0]) * -s + (y - bottomMid[1]) * c > 4);
  const badge = shape(badgePx);
  const want = [bottomMid[0] - s * (6 + 17 / 2), bottomMid[1] + c * (6 + 17 / 2)];
  check(
    `Chrome15 ${theme}: the turned frame's W × H badge is centred 6 under its bottom edge (centre within 1.5 px)`,
    !!badge && Math.hypot(badge.x - want[0], badge.y - want[1]) < 1.5,
    badge ? `centroid ${badge.x.toFixed(1)},${badge.y.toFixed(1)} want ${want[0].toFixed(1)},${want[1].toFixed(1)} (${badge.n} px)` : "none"
  );
  check(`Chrome15 ${theme}: …turned with it (${DEG}°, within 2°)`, !!badge && Math.abs(badge.angle - DEG) < 2, badge ? badge.angle.toFixed(2) : "");
  // The name: ink above the top edge, off the handles (past 6 along the edge, more than 3 above it).
  const titleInk = theme === "dark" ? "Math.max(r, g, b) > 90" : "Math.min(r, g, b) < 170";
  const titlePx = (await pixels(page, area, titleInk)).filter(([x, y]) => {
    const along = (x - corner[0]) * u[0] + (y - corner[1]) * u[1], across = (x - corner[0]) * up[0] + (y - corner[1]) * up[1];
    return across > 3 && across < 30 && along > 6 && along < W - 20;
  });
  const title = shape(titlePx);
  const across = (p) => (p[0] - corner[0]) * up[0] + (p[1] - corner[1]) * up[1];
  const along = (p) => (p[0] - corner[0]) * u[0] + (p[1] - corner[1]) * u[1];
  const titleBase = titlePx.length ? Math.min(...titlePx.map(across)) : 0;
  const titleTop = titlePx.length ? Math.max(...titlePx.map(across)) : 0;
  const titleStart = titlePx.length ? Math.min(...titlePx.map(along)) : 0;
  check(
    `Chrome15 ${theme}: the turned frame's name lies along its top edge, turned ${DEG}° (within 3°)`,
    !!title && Math.abs(title.angle - DEG) < 3 && title.n > 60,
    title ? `${title.angle.toFixed(2)}°, ${title.n} px` : "none"
  );
  check(
    `Chrome15 ${theme}: …its baseline 10 above the edge (Figma 42.png: 10.0), from the corner`,
    Math.abs(titleBase - 10) < 1.5 && titleTop > 16 && titleTop < 21 && titleStart > 6 && titleStart < 9,
    `baseline ${titleBase.toFixed(1)}, top ${titleTop.toFixed(1)}, starts ${titleStart.toFixed(1)} along (the handle hides the first 6)`
  );
  const aabbLeft = at(0, H)[0];
  const uprightSpot = await pixels(page, { x: Math.floor(aabbLeft), y: Math.floor(corner[1] - 20), width: 60, height: 14 }, titleInk);
  check(`Chrome15 ${theme}: nothing where an upright name would be (over the AABB's top left)`, uprightSpot.length === 0, `${uprightSpot.length} px`);
  const aabbRight = at(W, 0)[0];
  const devSpot = await pixels(page, { x: Math.floor(aabbRight - 16), y: Math.floor(corner[1] - 22), width: 18, height: 16 }, titleInk);
  check(`Chrome15 ${theme}: no </> where an upright frame's would be (a turned one's lies along its top edge: r15-spacing-handles)`, devSpot.length === 0, `${devSpot.length} px`);

  // A press on the name selects the frame; a drag moves it.
  const onName = [corner[0] + u[0] * 24 + up[0] * 14, corner[1] + u[1] * 24 + up[1] * 14];
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  await page.mouse.click(...onName);
  await settle(page);
  check(`Chrome15 ${theme}: a click on the turned name selects the frame`, JSON.stringify(await page.evaluate(() => window.__designerEditor.selection)) === '["15:1"]');
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await page.mouse.click(aabbLeft + 20, corner[1] - 14);
  await settle(page);
  check(`Chrome15 ${theme}: a click where an upright name would be selects nothing`, (await page.evaluate(() => window.__designerEditor.selection)).length === 0);
  const before = await page.evaluate(() => window.__designerEditor.engine.readNode("15:1").transform);
  await page.mouse.move(...onName);
  await page.mouse.down();
  await page.mouse.move(onName[0] + 40, onName[1] + 30, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const after = await page.evaluate(() => window.__designerEditor.engine.readNode("15:1").transform);
  check(
    `Chrome15 ${theme}: a drag from the turned name moves the frame`,
    Math.abs(after.m02 - before.m02 - 40) < 1.5 && Math.abs(after.m12 - before.m12 - 30) < 1.5,
    `${(after.m02 - before.m02).toFixed(1)}, ${(after.m12 - before.m12).toFixed(1)}`
  );
  await page.keyboard.press("Meta+z");
  await settle(page);

  // ---- 2. Cursors on the turned frame. -------------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["15:1"]));
  await settle(page);
  const cursor = () => page.evaluate(() => decodeURIComponent(window.__designerEditor.canvas.style.cursor));
  const turn = (css) => Number(/rotate\((-?[\d.]+) 12 12\)/.exec(css)?.[1] ?? NaN);
  const centre = at(W / 2, H / 2);
  const br = at(W, H);
  const cornerAngle = (Math.atan2(br[1] - centre[1], br[0] - centre[0]) * 180) / Math.PI;
  await page.mouse.move(br[0], br[1]);
  await settle(page);
  const resize = await cursor();
  check(
    `Chrome15 ${theme}: the turned frame's corner resize cursor is turned to the corner (${Math.round(cornerAngle) % 180}°)`,
    /image-set\(/.test(resize) && Math.abs(turn(resize) - (((Math.round(cornerAngle) % 180) + 180) % 180)) <= 1,
    `${turn(resize)}`
  );
  check(`Chrome15 ${theme}: …a 1× and a 2× picture (crisp on Retina)`, /width="24".* 1x, .*width="48".* 2x\) 12 12, /.test(resize));
  const outside = [br[0] + 12 * Math.cos((cornerAngle * Math.PI) / 180), br[1] + 12 * Math.sin((cornerAngle * Math.PI) / 180)];
  await page.mouse.move(...outside);
  await settle(page);
  const rotate = await cursor();
  check(
    `Chrome15 ${theme}: past the corner, the rotate cursor bulges away from the frame, turned to the corner (${Math.round(cornerAngle)}°)`,
    Math.abs(turn(rotate) - Math.round(cornerAngle)) <= 3 && /alias$/.test(rotate),
    `${turn(rotate)}`
  );
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+p");
  await page.mouse.move(canvasRect.right - 100, canvasRect.bottom - 100);
  await settle(page);
  const pencil = await cursor();
  check(`Chrome15 ${theme}: ⇧P shows the pencil, its lead the hot spot`, /image-set\(.* 3 3, crosshair$/.test(pencil) && (await page.evaluate(() => window.__designerEditor.store.tool)) === "PENCIL");
  await page.keyboard.press("Escape");
  await settle(page);

  // The sheet: every drawn cursor at 2×, on the canvas's grey and on white.
  await page.evaluate(async () => {
    const { cursorSheet } = await import("/src/engine/cursors.ts");
    const sheet = document.createElement("div");
    sheet.id = "cursor-sheet";
    sheet.style.cssText = "position:fixed;left:0;top:0;z-index:99999;display:grid;grid-template-columns:repeat(8,120px);gap:0;background:#e5e5e5;font:11px Inter,sans-serif;color:#000";
    for (const { name, css } of cursorSheet()) {
      const url = /url\("([^"]+)"\) 2x/.exec(css)?.[1];
      const hot = /2x\) (\d+) (\d+)/.exec(css);
      const cell = document.createElement("div");
      cell.style.cssText = "position:relative;height:96px;border:0.5px solid #ccc";
      const img = document.createElement("img");
      img.src = url;
      img.style.cssText = "position:absolute;left:36px;top:12px;width:48px;height:48px";
      const dot = document.createElement("span");
      dot.style.cssText = `position:absolute;left:${36 + 2 * Number(hot?.[1] ?? 0) - 2}px;top:${12 + 2 * Number(hot?.[2] ?? 0) - 2}px;width:4px;height:4px;border-radius:2px;background:#f24822`;
      const label = document.createElement("span");
      label.textContent = name;
      label.style.cssText = "position:absolute;left:0;right:0;bottom:6px;text-align:center";
      cell.append(img, dot, label);
      sheet.append(cell);
    }
    document.body.append(sheet);
    await Promise.all([...sheet.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
  });
  const sheetBox = await page.locator("#cursor-sheet").boundingBox();
  if (theme === "dark") await crop("chrome15-cursors", { x: 0, y: 0, width: Math.ceil(sheetBox.width), height: Math.ceil(sheetBox.height) });
  await page.evaluate(() => document.getElementById("cursor-sheet")?.remove());

  // ---- 3. The eyedropper. ----------------------------------------------------------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["15:3"]));
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("i");
  const green = toScreen([485, 450]);
  await page.mouse.move(green[0] - 30, green[1] - 10);
  await page.mouse.move(...green, { steps: 4 });
  await settle(page);
  await page.waitForTimeout(150);
  const eyedropperCursor = await cursor();
  check(`Chrome15 ${theme}: I shows the eyedropper cursor, its tip the hot spot`, /image-set\(.* 3 21, crosshair$/.test(eyedropperCursor));
  const card = await page.evaluate(() => {
    const el = document.querySelector("[data-loupe]");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const t = el.innerText;
    const prev = el.querySelector("canvas")?.parentElement?.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height, text: t, hex: el.dataset.hex, visible: getComputedStyle(el).display !== "none", preview: prev && { w: prev.width, h: prev.height, x: prev.left - b.left, y: prev.top - b.top } };
  });
  check(`Chrome15 ${theme}: the eyedropper's card follows the pointer (16 below right of it), 260 × 64`, !!card && card.visible && Math.abs(card.left - green[0] - 16) < 1 && Math.abs(card.top - green[1] - 16) < 1 && card.width === 260 && card.height === 64, JSON.stringify(card && { l: card.left - green[0], t: card.top - green[1], w: card.width, h: card.height }));
  check(`Chrome15 ${theme}: …its 48 × 48 preview 8 in`, !!card?.preview && card.preview.w === 48 && card.preview.h === 48 && card.preview.x === 8 && card.preview.y === 8, JSON.stringify(card?.preview));
  check(`Chrome15 ${theme}: …the hex of the colour under the pointer (#12AB34) and "Click to sample"`, card?.hex === "#12AB34" && /#12AB34/.test(card.text) && /Click to sample/.test(card.text), `${card?.hex} ${JSON.stringify(card?.text)}`);
  if (card) await crop("chrome15-eyedropper", { x: Math.floor(green[0] - 40), y: Math.floor(green[1] - 30), width: 340, height: 130 });
  // Near the right panel the card slides left along it, 4 off it (live Figma's sat 2–3 px off it).
  const view = await page.evaluate(() => {
    const b = document.querySelector("[data-canvas-view]").getBoundingClientRect();
    return { right: b.right, bottom: b.bottom };
  });
  await page.mouse.move(view.right - 30, green[1], { steps: 3 });
  await settle(page);
  await page.waitForTimeout(100);
  const slid = await page.evaluate(() => document.querySelector("[data-loupe]")?.getBoundingClientRect().right ?? 0);
  check(`Chrome15 ${theme}: …kept on the canvas near the right panel (its right edge 4 off it)`, Math.abs(slid - (view.right - 4)) < 1, `${slid} vs ${view.right}`);
  await page.mouse.move(...green, { steps: 3 });
  await settle(page);
  await page.mouse.click(...green);
  await settle(page);
  const grey = await page.evaluate(() => window.__designerEditor.engine.readNode("15:3").fillPaints?.[0]?.color);
  const near = (a, b) => Math.abs(a - b) < 1.5 / 255;
  check(`Chrome15 ${theme}: the click fills the selection with it`, !!grey && near(grey.r, KNOWN.r) && near(grey.g, KNOWN.g) && near(grey.b, KNOWN.b), JSON.stringify(grey));
  check(`Chrome15 ${theme}: …back to Move, the card gone`, (await page.evaluate(() => window.__designerEditor.store.tool)) === "MOVE" && !(await page.locator("[data-loupe]").count()));
  await page.keyboard.press("Meta+z");
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("i");
  await page.mouse.move(green[0] + 5, green[1] + 5, { steps: 2 });
  await settle(page);
  await page.keyboard.press("Escape");
  await settle(page);
  const unchanged = await page.evaluate(() => window.__designerEditor.engine.readNode("15:3").fillPaints?.[0]?.color);
  check(`Chrome15 ${theme}: Esc cancels the eyedropper (Move, no card, nothing filled)`, (await page.evaluate(() => window.__designerEditor.store.tool)) === "MOVE" && !(await page.locator("[data-loupe]").count()) && !!unchanged && near(unchanged.r, 0.6));
}
