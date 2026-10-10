// editor-shot's canvas navigation section (EDITOR_ONLY=canvasnav16, round 16; the owner's live Figma 58–67.png), driven
// with real mouse events and measured from the canvas's pixels:
//
// 1. The scrollbars: a wheel pan shows them (thin bars along the visible canvas's right and bottom, the page's content
//    passing the view); they fade out after; hovered they show again; the vertical thumb dragged pans the view.
// 2. Layers: a click on a row's glyph selects the layer and glides the camera to it (part-way after 100 ms, then where
//    ⇧2 would put it).
// 3. Prototype: a selected frame's nub on its side nearest the pointer (bottom, then left), "+" when hovered; a drag
//    from the bottom nub to another frame connects them.
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, setTimeout, requestAnimationFrame */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const frame = (guid, name, pos, x, y) => ({
  guid, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: "0:1", position: pos }, size: { x: 400, y: 300 }, transform: at(x, y), fillPaints: fill(1, 1, 1),
});
function nodes() {
  return [
    frame("26:1", "Home", "!", 0, 0),
    frame("26:2", "Details", '"', 600, 0),
    frame("26:3", "Settings", "#", 0, 500),
    // Far off to the right and below: the content passes the view there.
    { guid: "26:4", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Far", parentIndex: { guid: "0:1", position: "$" }, size: { x: 200, y: 200 }, transform: at(3000, 2400), fillPaints: fill(0.85, 0.85, 0.85) },
  ];
}

/** Pixels of a page region, as RGBA rows (page coordinates). */
async function grab(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height);
      return { w: d.width, h: d.height, data: Array.from(d.data) };
    },
    { b64: png.toString("base64") }
  );
}

/** Where two grabs of one region differ (page coordinates). */
function diff(a, b, clip) {
  const out = [];
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 12) out.push([clip.x + x, clip.y + y]);
    }
  return out;
}

/** Pixels in a region whose colour `keep` accepts. */
async function count(page, clip, keep) {
  const g = await grab(page, clip);
  let n = 0;
  for (let i = 0; i < g.data.length; i += 4) if (keep(g.data[i], g.data[i + 1], g.data[i + 2])) n++;
  return n;
}
const BLUE = (r, g, b) => r < 60 && g > 120 && g < 180 && b > 200; // #0d99ff / #0c8ce9

const wait = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

export async function canvasNavSection(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 120 + window.__viewLeft(), y: 120, zoom: 1 });
    ed.engine.setSelection([]);
  }, nodes());
  await settle(page);
  const view = await page.evaluate(() => {
    const b = document.querySelector("[data-canvas-view]").getBoundingClientRect();
    const c = document.getElementById("engine-canvas").getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, cl: c.left, ct: c.top };
  });
  const camera = () => page.evaluate(() => window.__designerEditor.engine.getCamera());
  const S = async (x, y) => {
    const c = await camera();
    return [view.cl + c.x + x * c.zoom, view.ct + c.y + y * c.zoom];
  };
  const shot = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const whole = { x: Math.ceil(view.left), y: Math.ceil(view.top), width: Math.floor(view.right - view.left), height: Math.floor(view.bottom - view.top) };

  // ---- 1. Scrollbars. --------------------------------------------------------------------------------------------
  // A pan (the engine's wheel, then the next frame — this canvas draws slowly here, so read the engine's own state):
  // shown; two seconds on: faded out.
  await page.mouse.move(view.left + 300, view.top + 200);
  const panned = await page.evaluate(async (x) => {
    const e = window.__designerEditor.engine;
    e.wheel(x, 200, 0, 30, 0, 0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return e.stats().scrollbarAlpha;
  }, view.left - view.cl + 300);
  check(`Canvasnav16 ${theme}: a pan shows the scrollbars`, panned === 1, String(panned));
  await page.mouse.move(view.left + 40, view.top + 460); // off every layer: no hover outline to change
  await wait(page, 1800);
  await settle(page);
  const after = await page.evaluate(() => window.__designerEditor.engine.stats().scrollbarAlpha);
  check(`Canvasnav16 ${theme}: …faded out once the view rests (1 s, then 300 ms)`, after === 0, String(after));
  const faded = await grab(page, whole);
  // The pointer on the right bar's place: both shown, as thin bars inside the visible canvas's right and bottom.
  const zoneX = view.right - 6 - 2 - 3;
  await page.mouse.move(zoneX, view.top + 300);
  await settle(page);
  await settle(page);
  const shown = await grab(page, whole);
  await shot("canvasnav16-scrollbars", whole);
  const bars = diff(shown, faded, whole);
  const bottom = bars.filter(([, y]) => y > view.bottom - 14);
  const right = bars.filter(([x, y]) => x > view.right - 20 && y <= view.bottom - 14);
  check(`Canvasnav16 ${theme}: the pointer on a bar's place shows a bar along the visible canvas's bottom…`, bottom.length > 200, `${bottom.length} px`);
  check(`Canvasnav16 ${theme}: …and its right, clear of the panel's resize handle (content past the view right and down)`, right.length > 200 && Math.max(...right.map(([x]) => x)) < view.right - 6, `${right.length} px`);
  const others = bars.length - bottom.length - right.length;
  check(`Canvasnav16 ${theme}: …nothing else changes`, others < 40, `${others} px elsewhere`);
  // The vertical thumb dragged 40 px down → the view goes down.
  const ys = right.map(([, y]) => y);
  const xs = right.map(([x]) => x);
  const thumbX = (Math.min(...xs) + Math.max(...xs)) / 2, thumbY = (Math.min(...ys) + Math.max(...ys)) / 2;
  await page.mouse.move(thumbX, thumbY);
  const c0 = await camera();
  await page.mouse.down();
  await page.mouse.move(thumbX, thumbY + 40, { steps: 5 });
  await page.mouse.up();
  await settle(page);
  const c1 = await camera();
  check(`Canvasnav16 ${theme}: the vertical thumb dragged down scrolls the view down`, c1.y < c0.y - 40 && c1.x === c0.x, `y ${c0.y} → ${c1.y}`);
  const sel = await page.evaluate(() => window.__designerEditor.engine.getSelection().refs.length);
  check(`Canvasnav16 ${theme}: …selecting nothing under the bar`, sel === 0, String(sel));

  // ---- 2. Layers: the glyph glides the camera to the layer. -------------------------------------------------------
  const icon = page.locator('[data-ds="LayerRow"][data-id="26:3"] [data-layer-icon]');
  await page.evaluate(() => window.__designerEditor.engine.setCamera({ x: 120 + window.__viewLeft(), y: 120, zoom: 1 }));
  await settle(page);
  const start = await camera();
  await icon.click();
  await wait(page, 120);
  const mid = await camera();
  await wait(page, 400);
  await settle(page);
  const end = await camera();
  const selected = await page.evaluate(() => window.__designerEditor.engine.getSelection().refs);
  check(`Canvasnav16 ${theme}: a click on a Layers glyph selects the layer`, selected.length === 1 && selected[0] === "26:3", JSON.stringify(selected));
  const target = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const now = ed.engine.getCamera();
    ed.engine.command("ZOOM_TO_SELECTION");
    const t = ed.engine.getCamera();
    ed.engine.setCamera(now);
    return t;
  });
  const between = (v, a, b) => v > Math.min(a, b) + 1e-6 && v < Math.max(a, b) - 1e-6;
  check(`Canvasnav16 ${theme}: …the camera part-way there after ~120 ms`, between(mid.zoom, start.zoom, target.zoom) || between(mid.y, start.y, target.y), `zoom ${start.zoom.toFixed(3)} → ${mid.zoom.toFixed(3)} → ${end.zoom.toFixed(3)}`);
  check(`Canvasnav16 ${theme}: …and where ⇧2 puts it after 300 ms`, Math.abs(end.x - target.x) < 0.5 && Math.abs(end.y - target.y) < 0.5 && Math.abs(end.zoom - target.zoom) < 1e-6, `${JSON.stringify(end)} vs ${JSON.stringify(target)}`);

  // ---- 3. Prototype: nubs on the side nearest the pointer. --------------------------------------------------------
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.ui.set({ rightTab: "prototype" });
    ed.engine.setCamera({ x: 200 + window.__viewLeft(), y: 150, zoom: 1 });
    ed.engine.setSelection(["26:1"]);
  });
  await settle(page);
  const [bx, by] = await S(200, 300); // Home's bottom middle
  const [lx, ly] = await S(0, 150); // its left middle
  const [tx, ty] = await S(200, 0);
  // A nub's half outside its edge (over the canvas, short of the size badge 6 px below): blue ring where it is, nothing
  // where it isn't; its middle: white, or the blue "+" when hovered.
  const outside = {
    bottom: { x: Math.round(bx - 5), y: Math.round(by + 1), width: 10, height: 4 },
    top: { x: Math.round(tx - 5), y: Math.round(ty - 5), width: 10, height: 4 },
    left: { x: Math.round(lx - 5), y: Math.round(ly - 5), width: 4, height: 10 },
  };
  const middle = { x: Math.round(bx - 1), y: Math.round(by - 1), width: 3, height: 3 };
  const area = { x: Math.round(lx - 40), y: Math.round(ty - 40), width: 480, height: 380 };
  await page.mouse.move(bx + 30, by - 20);
  await settle(page);
  const nubBottom = await count(page, outside.bottom, BLUE);
  const nubTop = await count(page, outside.top, BLUE);
  check(`Canvasnav16 ${theme}: the pointer near the bottom edge: the nub at its middle (none on top)`, nubBottom >= 8 && nubTop === 0, `bottom ${nubBottom} px, top ${nubTop} px blue`);
  const plain = await count(page, middle, BLUE);
  await shot("canvasnav16-nub-bottom", area);
  await page.mouse.move(bx, by);
  await settle(page);
  const hot = await count(page, middle, BLUE);
  check(`Canvasnav16 ${theme}: …hovered: a "+" in it`, plain === 0 && hot >= 5, `middle ${plain} → ${hot} px blue`);
  await shot("canvasnav16-nub-hover", area);
  await page.mouse.move(lx + 15, ly + 30);
  await settle(page);
  const nubLeft = await count(page, outside.left, BLUE);
  const gone = await count(page, outside.bottom, BLUE);
  check(`Canvasnav16 ${theme}: the pointer near the left edge: the nub moves there`, nubLeft >= 8 && gone === 0, `left ${nubLeft} px, bottom ${gone} px`);
  await shot("canvasnav16-nub-left", area);
  // A drag from the bottom nub to Settings (below): connected.
  await page.mouse.move(bx, by);
  await settle(page);
  const [sx, sy] = await S(200, 650);
  await page.mouse.down();
  await page.mouse.move(bx + 20, by + 60, { steps: 4 });
  await page.mouse.move(sx, sy, { steps: 6 });
  await settle(page);
  await shot("canvasnav16-nub-drag", { x: area.x, y: area.y, width: 480, height: 760 });
  await page.mouse.up();
  await settle(page);
  const list = await page.evaluate(() => window.__designerEditor.engine.readNode("26:1")?.prototypeInteractions ?? []);
  check(`Canvasnav16 ${theme}: dragging the bottom nub onto a frame connects it`, Array.isArray(list) && list.length === 1, JSON.stringify(list).slice(0, 120));
  await page.mouse.move(view.left + 30, view.bottom - 60);
  await shot("canvasnav16-connection", { x: area.x, y: area.y, width: 480, height: 760 });
}
