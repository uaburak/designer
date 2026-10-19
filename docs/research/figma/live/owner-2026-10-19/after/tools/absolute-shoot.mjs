// 2026-10-20: before / after shots of layers that ignore auto layout (the owner's capture
// ../../layers-absolute-position-icons.png): their Layers rows (Figma's corner marks over the glyph — normal,
// component purple, selected) and a canvas drag of an absolute frame inside its auto-layout parent (before: the
// reorder drag's ghost and insertion line; after: it moves freely, chrome kept). Two web servers
// (`vite --config vite.web.config.ts`): BEFORE_URL (main) and AFTER_URL (this branch).
// Usage: BEFORE_URL=http://localhost:5371 AFTER_URL=http://localhost:5372 node …/absolute-shoot.mjs
/* global window, document */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const settle = (page, ms = 400) => page.waitForTimeout(ms);

const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = (r, g, b) => [{ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const al = (mode, extra = {}) => ({ stackMode: mode, stackSpacing: 8, stackHorizontalPadding: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12, stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED", ...extra });
const P = (guid, position) => ({ guid, position });

function nodes() {
  const n = [];
  n.push({ guid: "9:50", phase: "CREATED", type: "SYMBOL", name: "Badge+tooltip", parentIndex: P("0:1", "~"), size: { x: 56, y: 24 }, transform: at(420, 0), fillPaints: fill(1, 0.8, 0.2) });
  n.push({ guid: "9:1", phase: "CREATED", type: "FRAME", name: "resorts-card", parentIndex: P("0:1", "!"), size: { x: 320, y: 360 }, transform: at(0, 0), fillPaints: fill(0.96, 0.96, 0.96), ...al("VERTICAL") });
  n.push({ guid: "9:2", phase: "CREATED", type: "FRAME", name: "badges", parentIndex: P("9:1", "~"), size: { x: 200, y: 40 }, transform: at(100, 24), fillPaints: fill(0.75, 0.85, 1), stackPositioning: "ABSOLUTE", ...al("HORIZONTAL", { stackHorizontalPadding: 8, stackVerticalPadding: 8, stackPaddingRight: 8, stackPaddingBottom: 8 }) });
  for (let i = 0; i < 3; i++)
    n.push({ guid: `9:2${i}`, phase: "CREATED", type: "INSTANCE", name: "Badge+tooltip", parentIndex: P("9:2", String.fromCharCode(33 + i)), size: { x: 56, y: 24 }, transform: at(8 + 64 * i, 8), symbolData: { symbolID: "9:50" } });
  n.push({ guid: "9:3", phase: "CREATED", type: "FRAME", name: "deals", parentIndex: P("9:1", '"'), size: { x: 296, y: 60 }, transform: at(12, 12), fillPaints: fill(1, 1, 1), ...al("VERTICAL") });
  n.push({ guid: "9:31", phase: "CREATED", type: "INSTANCE", name: "Badge+tooltip", parentIndex: P("9:3", "!"), size: { x: 56, y: 24 }, transform: at(220, 18), symbolData: { symbolID: "9:50" }, stackPositioning: "ABSOLUTE" });
  n.push({ guid: "9:4", phase: "CREATED", type: "FRAME", name: "image", parentIndex: P("9:1", "#"), size: { x: 296, y: 200 }, transform: at(12, 80), fillPaints: fill(0.85, 0.9, 0.85), ...al("VERTICAL") });
  n.push({ guid: "9:41", phase: "CREATED", type: "FRAME", name: "Text", parentIndex: P("9:4", "!"), size: { x: 120, y: 20 }, transform: at(12, 12), fillPaints: fill(1, 1, 1), ...al("VERTICAL") });
  n.push({ guid: "9:42", phase: "CREATED", type: "FRAME", name: "Text", parentIndex: P("9:4", '"'), size: { x: 120, y: 20 }, transform: at(12, 40), fillPaints: fill(1, 1, 1), ...al("VERTICAL") });
  n.push({ guid: "9:43", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "image", parentIndex: P("9:4", "#"), size: { x: 160, y: 100 }, transform: at(120, 90), fillPaints: fill(0.4, 0.6, 0.8), stackPositioning: "ABSOLUTE" });
  return n;
}

async function open(base, theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: theme });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`${base}/?editor&doc=empty`);
  await page.waitForFunction(() => window.__designerEditor, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await settle(page, 1200);
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setCamera({ x: 420, y: 160, zoom: 1 });
    ed.ui.set({ expanded: new Set(["9:1", "9:2", "9:3", "9:4"]) });
    ed.engine.setSelection(["9:2"]);
  }, nodes());
  await settle(page, 800);
  return page;
}

const toScreen = (page, x, y) =>
  page.evaluate(([x, y]) => {
    const ed = window.__designerEditor;
    const c = ed.engine.getCamera();
    const r = ed.canvas.getBoundingClientRect();
    return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y];
  }, [x, y]);

for (const [label, base] of [["before", process.env.BEFORE_URL], ["after", process.env.AFTER_URL]]) {
  if (!base) continue;
  for (const theme of ["dark", "light"]) {
    const page = await open(base, theme);
    // 1. Layers rows: "badges" selected (white marks), deals' instance (purple), the "image" rectangle.
    const list = await page.locator("[data-layer-list]").boundingBox();
    if (list) await page.screenshot({ path: path.join(out, `absolute-layers-${theme}-${label}.png`), clip: { x: list.x, y: list.y, width: Math.min(list.width, 260), height: 420 } });
    const marks = await page.evaluate(() => [...document.querySelectorAll("[data-layer-absolute]")].map((e) => e.closest('[data-ds="LayerRow"]')?.dataset.id));
    console.log(label, theme, "rows with corner marks:", marks.join(" "));
    // 2. Drag "badges" (absolute in resorts-card) 60 right, 120 down — mid-drag shot, then the drop.
    const canvas = await page.evaluate(() => {
      const r = window.__designerEditor.canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const [px, py] = await toScreen(page, 200, 44);
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.move(px + 60, py + 120, { steps: 10 });
    await settle(page, 500);
    const [cx, cy] = await toScreen(page, -40, -40);
    await page.screenshot({ path: path.join(out, `absolute-drag-${theme}-${label}.png`), clip: { x: Math.max(canvas.x, cx), y: Math.max(canvas.y, cy), width: 440, height: 460 } });
    const mid = await page.evaluate(() => {
      const r = window.__designerEditor.engine.readNode("9:2", { fields: ["transform", "parentIndex"] });
      return { x: r.transform.m02, y: r.transform.m12, parent: r.parentIndex.guid, order: (window.__designerEditor.engine.readNode("9:1", { childIds: true }).childIds ?? []).join(",") };
    });
    await page.mouse.up();
    await settle(page, 500);
    const end = await page.evaluate(() => {
      const r = window.__designerEditor.engine.readNode("9:2", { fields: ["transform", "parentIndex", "stackPositioning"] });
      return { x: r.transform.m02, y: r.transform.m12, parent: r.parentIndex.guid, positioning: r.stackPositioning, order: (window.__designerEditor.engine.readNode("9:1", { childIds: true }).childIds ?? []).join(",") };
    });
    console.log(label, theme, "mid-drag", JSON.stringify(mid), "dropped", JSON.stringify(end));
    await page.close();
  }
}
await browser.close();
