// editor-shot's round 17 hover-outline section (EDITOR_ONLY=hover17): a hovered layer's outline — the owner's 79.png
// (live Figma: a frame with a big radius hovered outlines its whole box, square, the rounded fill inside) against
// 80.png (ours before: along the frame's rounded corner). Frames keep their box; shapes follow their own outline.
// Driven with real mouse events, measured from the canvas's pixels.
//
// 1. A frame with radius 40 hovered: blue at its box's corner, none along its arc; the pointer in the cut-away corner
//    still hovers it (d880ea2's hit rule). Selected and hovered: square too.
// 2. A rectangle with radius 40 hovered: blue along its arc, none at its box's corner (the same for its cut-away
//    corner); a smoothed rectangle and an ellipse along their curves.
/* global window, atob, Blob, createImageBitmap, OffscreenCanvas */
import path from "node:path";

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const radius = (r) => ({ cornerRadius: r, rectangleTopLeftCornerRadius: r, rectangleTopRightCornerRadius: r, rectangleBottomLeftCornerRadius: r, rectangleBottomRightCornerRadius: r, rectangleCornerRadiiIndependent: false });

function nodes() {
  return [
    { guid: "18:1", phase: "CREATED", type: "FRAME", name: "Rounded", parentIndex: { guid: "0:1", position: "!" }, size: { x: 200, y: 200 }, transform: at(0, 0), fillPaints: fill(1, 1, 1), ...radius(40) },
    { guid: "18:4", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Rect", parentIndex: { guid: "0:1", position: "$" }, size: { x: 200, y: 200 }, transform: at(300, 0), fillPaints: fill(0.85, 0.85, 0.85), ...radius(40) },
    { guid: "18:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Smooth", parentIndex: { guid: "0:1", position: '"' }, size: { x: 200, y: 200 }, transform: at(0, 300), fillPaints: fill(0.85, 0.85, 0.85), ...radius(60), cornerSmoothing: 1 },
    { guid: "18:3", phase: "CREATED", type: "ELLIPSE", name: "Ellipse", parentIndex: { guid: "0:1", position: "#" }, size: { x: 200, y: 120 }, transform: at(300, 300), fillPaints: fill(0.85, 0.85, 0.85) },
  ];
}

/** The page pixels of `clip` whose colour `pred` keeps, as [x, y] page coordinates. */
async function pixels(page, clip, pred) {
  const png = await page.screenshot({ clip });
  const pts = await page.evaluate(
    async ({ b64, pred }) => {
      const keep = new Function("r", "g", "b", `return ${pred};`);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
      const out = [];
      for (let i = 0; i < data.length; i += 4) if (keep(data[i], data[i + 1], data[i + 2])) out.push([(i / 4) % bmp.width, Math.floor(i / 4 / bmp.width)]);
      return out;
    },
    { b64: png.toString("base64"), pred }
  );
  return pts.map(([x, y]) => [x + clip.x, y + clip.y]);
}

// The selection's blue (#0d99ff), strong enough to be the line's core.
const BLUE = "b > 200 && r < 120 && g > 100 && g < 200";

export async function hover17Section(page, theme, { open, settle, check, outDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 200 + window.__viewLeft(), y: 200, zoom: 1 });
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
  const box = (x, y, w, h) => {
    const [px, py] = S(x, y);
    return { x: Math.round(px), y: Math.round(py), width: Math.round(w * z), height: Math.round(h * z) };
  };
  const shoot = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
  };
  const away = async () => {
    await page.mouse.move(rect.right - 30, rect.bottom - 30);
    await settle(page);
  };
  const area = box(-20, -30, 560, 560);
  // A corner's box edge (the top edge just right of the corner, clear of the arc there) and its arc's middle (the
  // arc's point at 45°: 40 − 40·cos 45° ≈ 11.7 in from each edge), for a layer at (x, y).
  const edge = (x, y) => box(x + 3, y - 1, 6, 3);
  const arc = (x, y) => box(x + 8, y + 8, 8, 8);
  const count = async (clip) => (await pixels(page, clip, BLUE)).length;

  // ---- 1. The frame hovered (the pointer inside, then in the cut-away corner): its box, square. -------------------
  await away();
  for (const [what, at] of [["inside", [100, 100]], ["in the cut-away corner", [3, 3]]]) {
    await page.mouse.move(...S(...at));
    await settle(page);
    const e = await count(edge(0, 0)), a = await count(arc(0, 0));
    check(`Hover17 ${theme}: a frame with radius 40 hovered (${what}) is outlined along its box, not its arc`, e > 3 && a === 0, `edge ${e}, arc ${a}`);
  }
  await shoot("hover17-frame", area);
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["18:1"]));
  await page.mouse.move(...S(100, 100));
  await settle(page);
  let e = await count(edge(0, 0)), a = await count(arc(0, 0));
  check(`Hover17 ${theme}: selected and hovered, the frame's box square, nothing along its arc`, e > 3 && a === 0, `edge ${e}, arc ${a}`);
  await shoot("hover17-frame-selected", area);
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));

  // ---- 2. Shapes: their own outline. ----------------------------------------------------------------------------
  for (const [what, at] of [["inside", [400, 100]], ["in the cut-away corner", [303, 3]]]) {
    await page.mouse.move(...S(...at));
    await settle(page);
    e = await count(box(297, -3, 10, 10));
    a = await count(arc(300, 0));
    check(`Hover17 ${theme}: a rectangle with radius 40 hovered (${what}) is outlined along its arc, not its box`, e === 0 && a > 3, `corner ${e}, arc ${a}`);
  }
  await page.mouse.move(...S(100, 400));
  await settle(page);
  e = await count(box(-3, 297, 12, 12));
  a = await count(box(10, 310, 20, 20));
  check(`Hover17 ${theme}: a smoothed rectangle hovered is outlined along its curve`, e === 0 && a > 3, `corner ${e}, curve ${a}`);
  await page.mouse.move(...S(400, 360));
  await settle(page);
  e = await count(box(297, 297, 14, 14));
  a = await count(box(297, 350, 6, 20));
  check(`Hover17 ${theme}: an ellipse hovered is outlined along its curve`, e === 0 && a > 3, `corner ${e}, side ${a}`);
  await shoot("hover17-shapes", area);
  await away();
}
