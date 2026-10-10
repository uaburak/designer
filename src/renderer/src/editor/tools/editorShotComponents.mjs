// editor-shot's components section (EDITOR_ONLY=components15, round 15): the owner's screenshots of live Figma
// (docs/research/components15/figma-*.png) — components, sets, instances and every layer inside them drawn in the
// component purple, measured from the canvas's pixels:
//
// 1. A pill-shaped instance hovered in a corner its radius cuts off: outlined (its box is hit there, 46.png).
// 2. A click on a layer inside it selects the whole instance (purple outline and handles, no blue); its layer hovered
//    then is dotted purple (46.png); a second click selects that layer — a purple box, the instance dashed purple
//    around it (45.png). ⌘-click selects the deepest layer at once.
// 3. A component set's dashed purple border (Figma's own stroke), a main component's layer selected in purple.
// 4. Layers: the set has the component's four diamonds, its variants the filled diamond; names #d1a8ff, glyphs half
//    strength (44.png).
/* global window, document, atob, Blob, createImageBitmap, OffscreenCanvas, getComputedStyle */
import path from "node:path";

const fill = (hex) => [{ type: "SOLID", color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const PURPLE = "r > 110 && r < 175 && g < 100 && b > 215"; // #8a38f5 / #9747ff and their edges
const BLUE = "r < 60 && g > 120 && g < 180 && b > 200"; // #0d99ff / #0c8ce9

function nodes() {
  const auto = { stackMode: "HORIZONTAL", stackSpacing: 16, stackHorizontalPadding: 24, stackVerticalPadding: 12, stackPaddingRight: 24, stackPaddingBottom: 12, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" };
  const r = (guid, name, parent, pos, x, y, w, h, color = 0xffffff) => ({ guid, phase: "CREATED", type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: fill(color) });
  const pill = { cornerRadius: 44, rectangleTopLeftCornerRadius: 44, rectangleTopRightCornerRadius: 44, rectangleBottomLeftCornerRadius: 44, rectangleBottomRightCornerRadius: 44, rectangleCornerRadiiIndependent: false };
  const variant = (guid, name, pos, x, color) => ({ guid, phase: "CREATED", type: "SYMBOL", name, parentIndex: { guid: "0:1", position: pos }, size: { x: 100, y: 40 }, transform: at(x, 20), fillPaints: fill(color) });
  return [
    // "Button": a red pill (260 × 88, radius 44) laid out in a row, holding "Content" (no fill) with two white bars.
    { guid: "15:1", phase: "CREATED", type: "SYMBOL", name: "Button", parentIndex: { guid: "0:1", position: "!" }, size: { x: 260, y: 88 }, transform: at(0, 0), fillPaints: fill(0xe30613), ...pill, ...auto },
    { guid: "15:2", phase: "CREATED", type: "FRAME", name: "Content", parentIndex: { guid: "15:1", position: "!" }, size: { x: 212, y: 64 }, transform: at(24, 12), fillPaints: [] },
    r("15:3", "Plus", "15:2", "!", 8, 16, 32, 32),
    r("15:4", "Label", "15:2", '"', 64, 20, 120, 24),
    // Its instance, top-level.
    { guid: "15:10", phase: "CREATED", type: "INSTANCE", name: "Button", parentIndex: { guid: "0:1", position: '"' }, size: { x: 260, y: 88 }, transform: at(0, 160), fillPaints: fill(0xe30613), ...pill, ...auto, symbolData: { symbolID: "15:1" } },
    // Three components, combined as variants into a set (its dashed purple border is Combine as variants').
    variant("15:31", "Default", "#", 380, 0xe6e6e6),
    variant("15:32", "Hover", "$", 500, 0xa9e4e3),
    variant("15:33", "Active", "%", 620, 0xa9e4e3),
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
          if (keep(data[i], data[i + 1], data[i + 2])) out.push([x0 + x, y0 + y]);
        }
      return out;
    },
    { b64: png.toString("base64"), x0: clip.x, y0: clip.y, pred }
  );
}

/** The runs of kept pixels along a 1-px row (or column) strip: how many on / off runs — a dashed line has many. */
async function runs(page, clip, pred) {
  const px = await pixels(page, clip, pred);
  const horizontal = clip.width > clip.height;
  const on = new Set(px.map(([x, y]) => (horizontal ? x : y)));
  let count = 0, prev = false;
  const from = horizontal ? clip.x : clip.y, to = from + (horizontal ? clip.width : clip.height);
  for (let i = from; i < to; i++) {
    const cur = on.has(i);
    if (cur && !prev) count++;
    prev = cur;
  }
  return { count, covered: on.size, length: to - from };
}

export async function components15Section(page, theme, { open, settle, check, outDir, docsDir }) {
  await open(page, "&doc=empty");
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 120 + window.__viewLeft(), y: 140, zoom: 1 });
    ed.engine.setSelection(["15:31", "15:32", "15:33"]);
    ed.engine.command("COMBINE_AS_VARIANTS");
    ed.engine.setSelection([]);
  }, nodes());
  await settle(page);
  // The set Combine as variants made: the variants' parent.
  const SET = await page.evaluate(() => {
    const p = window.__designerEditor.engine.readNode("15:31")?.parentIndex?.guid;
    return typeof p === "string" ? p : p ? `${p.sessionID}:${p.localID}` : "";
  });
  const setNode = await page.evaluate((id) => window.__designerEditor.engine.readNode(id), SET);
  check(`Components15 ${theme}: Combine as variants made a set`, setNode?.isStateGroup === true, JSON.stringify({ SET, type: setNode?.type }));
  const canvasRect = await page.evaluate(() => {
    const b = window.__designerEditor.canvas.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  const S = (x, y) => [canvasRect.left + cam.x + x * cam.zoom, canvasRect.top + cam.y + y * cam.zoom];
  const selection = () => page.evaluate(() => window.__designerEditor.selection);
  const crop = async (name, clip) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), clip });
    if (docsDir) await page.screenshot({ path: path.join(docsDir, `${name}-${theme}.png`), clip });
  };
  const away = async () => {
    await page.mouse.move(canvasRect.right - 30, canvasRect.bottom - 30);
    await settle(page);
  };
  // The instance's box on screen (it sits at (0, 160), 260 × 88), with a margin.
  const [ix, iy] = S(0, 160);
  const instArea = { x: Math.floor(ix - 24), y: Math.floor(iy - 24), width: 260 + 48, height: 88 + 72 };
  // A 1-px strip along the instance's top edge (its outline), clear of the corners' handles.
  const instTop = { x: Math.floor(ix + 60), y: Math.floor(iy) - 1, width: 140, height: 3 };

  // ---- 1. The pill's corner, outside its rounded shape, hovers it. ----------------------------------------------------
  await page.mouse.move(ix + 3, iy + 3);
  await settle(page);
  const cornerHover = await pixels(page, instTop, PURPLE);
  check(`Components15 ${theme}: the pill instance's rounded-off corner hovers it (its outline along the top edge)`, cornerHover.length > 100, `${cornerHover.length} purple px`);
  await page.mouse.click(ix + 3, iy + 3);
  await settle(page);
  check(`Components15 ${theme}: …and a click there selects it`, JSON.stringify(await selection()) === '["15:10"]', JSON.stringify(await selection()));
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);

  // ---- 2. Instance picking and its chrome. ---------------------------------------------------------------------------
  const onLabel = S(24 + 64 + 60, 160 + 12 + 32); // the "Label" bar inside Content inside the instance
  await page.mouse.move(...onLabel);
  await settle(page);
  const hoverWhole = await pixels(page, instTop, PURPLE);
  check(`Components15 ${theme}: hovering a layer inside an unselected instance outlines the whole instance`, hoverWhole.length > 100, `${hoverWhole.length} purple px`);
  await page.mouse.click(...onLabel);
  await settle(page);
  check(`Components15 ${theme}: the first click inside an instance selects the whole instance`, JSON.stringify(await selection()) === '["15:10"]', JSON.stringify(await selection()));
  await away();
  const selPurple = await pixels(page, instArea, PURPLE);
  const selBlue = await pixels(page, instArea, BLUE);
  check(`Components15 ${theme}: the selected instance's outline, handles and badge are purple, nothing blue`, selPurple.length > 400 && selBlue.length === 0, `${selPurple.length} purple, ${selBlue.length} blue px`);
  await crop("components15-instance-selected", instArea);
  // Its layer hovered: Content (the instance's child) dotted purple.
  const [cx, cy] = S(24, 172);
  const contentTop = { x: Math.floor(cx + 20), y: Math.floor(cy) - 1, width: 160, height: 3 };
  await page.mouse.move(...onLabel);
  await settle(page);
  const dotted = await runs(page, contentTop, PURPLE);
  check(
    `Components15 ${theme}: inside the selected instance, its layer hovers dotted purple (46.png: dashes along its edge)`,
    dotted.count >= 30 && dotted.covered < dotted.length * 0.8,
    `${dotted.count} dashes over ${dotted.length} px, ${dotted.covered} px purple`
  );
  const hoverBlue = await pixels(page, instArea, BLUE);
  check(`Components15 ${theme}: …nothing blue`, hoverBlue.length === 0, `${hoverBlue.length} blue px`);
  await crop("components15-instance-child-hover", instArea);
  // A second click selects it: a purple box, the instance (its auto-layout parent) dashed purple around it (45.png).
  await page.mouse.click(...onLabel);
  await settle(page);
  const sel = await selection();
  check(`Components15 ${theme}: a second click selects the instance's layer`, sel.length === 1 && /^I15:10;/.test(sel[0]), JSON.stringify(sel));
  await away();
  const childSolid = await runs(page, contentTop, PURPLE);
  const parentDashed = await runs(page, instTop, PURPLE);
  const childBlue = await pixels(page, instArea, BLUE);
  check(
    `Components15 ${theme}: …its box solid purple, the instance dashed purple around it (45.png), nothing blue`,
    childSolid.count <= 2 && childSolid.covered > 150 && parentDashed.count >= 25 && childBlue.length === 0,
    `layer ${childSolid.count} runs ${childSolid.covered} px; instance ${parentDashed.count} dashes; ${childBlue.length} blue px`
  );
  await crop("components15-instance-child-selected", instArea);
  // ⌘-click: straight to the deepest layer.
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  await page.keyboard.down("Meta");
  await page.mouse.click(...onLabel);
  await page.keyboard.up("Meta");
  await settle(page);
  const deep = await selection();
  check(`Components15 ${theme}: ⌘-click selects the deepest layer inside the instance`, deep.length === 1 && /^I15:10;.*15:4$/.test(deep[0]), JSON.stringify(deep));

  // ---- 3. The set's dashed border; the main component's layer selected purple. ---------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await away();
  const [sx, sy] = S(setNode?.transform?.m02 ?? 0, setNode?.transform?.m12 ?? 0);
  const setTop = { x: Math.floor(sx + 40), y: Math.floor(sy), width: Math.floor((setNode?.size?.x ?? 300) - 80), height: 1 };
  const setDashes = await runs(page, setTop, PURPLE);
  check(`Components15 ${theme}: the component set has its dashed purple border`, setDashes.count >= 12, `${setDashes.count} dashes over ${setDashes.length} px`);
  await crop("components15-component-set", { x: Math.floor(sx - 30), y: Math.floor(sy - 30), width: Math.ceil((setNode?.size?.x ?? 380) + 60), height: Math.ceil((setNode?.size?.y ?? 80) + 60) });
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["15:4"]));
  await away();
  const [mx, my] = S(0, 0);
  const mainArea = { x: Math.floor(mx - 24), y: Math.floor(my - 24), width: 308, height: 160 };
  const mainPurple = await pixels(page, mainArea, PURPLE);
  const mainBlue = await pixels(page, mainArea, BLUE);
  check(`Components15 ${theme}: a layer inside a main component is selected in purple, nothing blue`, mainPurple.length > 200 && mainBlue.length === 0, `${mainPurple.length} purple, ${mainBlue.length} blue px`);

  // ---- 4. Layers: the set's and variants' glyphs and colours (44.png). -----------------------------------------------
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  // The set's row opened, its variants listed.
  await page.evaluate((SET) => document.querySelector(`[data-ds="LayerRow"][data-id="${SET}"] button[aria-expanded="false"]`)?.click(), SET);
  await settle(page);
  await page.mouse.move(canvasRect.right - 30, canvasRect.bottom - 30);
  await settle(page);
  const rows = await page.evaluate((SET) => {
    const out = {};
    for (const id of [SET, "15:31", "15:1", "15:10"]) {
      const row = document.querySelector(`[data-ds="LayerRow"][data-id="${id}"]`);
      if (!row) continue;
      const type = row.querySelector('[role="img"]');
      const name = row.querySelector("[data-layer-name]");
      out[id] = { label: type?.getAttribute("aria-label"), d: type?.querySelector("path")?.getAttribute("d")?.slice(0, 20), glyph: type ? getComputedStyle(type).color : "", name: name ? getComputedStyle(name).color : "" };
    }
    out.set = out[SET];
    return out;
  }, SET);
  const fourDiamonds = "M8 5.84L6.66 4.5L8 3";
  const filledDiamond = "M7.29 3.29C7.68 2.9 ";
  check(`Components15 ${theme}: Layers — the set has the component's four diamonds`, rows.set?.d === fourDiamonds && rows.set?.label === "Component", JSON.stringify(rows.set));
  check(`Components15 ${theme}: …its variants the filled diamond`, rows["15:31"]?.d === filledDiamond && rows["15:31"]?.label === "Variant", JSON.stringify(rows["15:31"]));
  check(`Components15 ${theme}: …a lone component the four diamonds`, rows["15:1"]?.d === fourDiamonds, JSON.stringify(rows["15:1"]));
  const purpleName = theme === "dark" ? "rgb(209, 168, 255)" : "rgb(134, 56, 229)";
  check(`Components15 ${theme}: …names in the component purple`, ["set", "15:31", "15:1", "15:10"].every((id) => rows[id]?.name === purpleName), Object.values(rows).map((r) => r.name).join(" "));
  const half = (c) => /color\(srgb [\d.]+ [\d.]+ [\d.]+ \/ 0\.5\)|rgba\(\d+, \d+, \d+, 0\.5\)/.test(c);
  check(`Components15 ${theme}: …glyphs the component purple at half strength (44.png: #80699b on #2c2c2c)`, ["set", "15:31", "15:10"].every((id) => half(rows[id]?.glyph ?? "")), Object.values(rows).map((r) => r.glyph).join(" | "));
  const panel = await page.evaluate((SET) => {
    const b = document.querySelector(`[data-ds="LayerRow"][data-id="${SET}"]`)?.getBoundingClientRect();
    return b ? { x: Math.max(0, Math.floor(b.left - 8)), y: Math.floor(b.top - 8), width: 240, height: 32 * 4 + 16 } : null;
  }, SET);
  if (panel) await crop("components15-layers", panel);
}
