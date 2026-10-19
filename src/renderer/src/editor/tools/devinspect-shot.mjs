// Dev Mode's canvas inspection of padding and gaps against the owner's Figma captures (2026-10-19,
// docs/research/figma/live/owner-2026-10-19/figma-devmode-{gap,padding}-hatch.webp, 2000 × 1299 at 1.32×): builds the
// captures' layers on `?editor&doc=reference` (a 2-column grid of cards with 24 gaps in a vertical auto layout, each
// card a component holding an image and a "Text" auto layout padded 12 / 12 / 12 / 16), switches to Dev Mode and
// shoots the same two states at the same scale, dark theme:
//   1. Frame 4507 selected, Container (the grid) hovered in Layers — its gaps hatched;
//   2. a card's "Text" selected — its paddings hatched, the purple name tag and badge.
//
//   node src/renderer/src/editor/tools/devinspect-shot.mjs [outDir]   (default /tmp/designer-work/devinspect)
//   SHOT_PORT=5317 (the vite server's port; never the owner's 3000)
/* global process, console, window, requestAnimationFrame, setTimeout, localStorage */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/designer-work/devinspect");
mkdirSync(outDir, { recursive: true });

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : [])
    for (const sub of ["chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = path.join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  return undefined;
}

const server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.SHOT_PORT ?? 5317), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const hardStop = setTimeout(async () => {
  console.error("devinspect-shot: stopped after 150 s");
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(2);
}, 150_000);
hardStop.unref();

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
try {
  // The captures' scale: 2000 × 1299 device pixels at 1.32×.
  const context = await browser.newContext({ viewport: { width: 1515, height: 984 }, deviceScaleFactor: 1.32, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`${base}/?editor&doc=reference`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
  await settle(page);

  await page.evaluate(async () => {
    const g = await import("/src/editor/model/grid.ts");
    const e = window.__designerEditor.engine;
    const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
    const solid = (r, gg, b) => [{ type: "SOLID", color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true }];
    const font = { family: "Inter", style: "Bold", postscript: "" };
    const changes = [
      { guid: "40:1", phase: "CREATED", type: "FRAME", name: "Frame 4507", parentIndex: { guid: "0:1", position: "~" }, size: { x: 849.33, y: 1000 }, transform: at(2000, 0), fillPaints: solid(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 32, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED" },
      { guid: "40:2", phase: "CREATED", type: "FRAME", name: "Container", parentIndex: { guid: "40:1", position: "!" }, size: { x: 849.33, y: 864 }, transform: at(0, 0), fillPaints: [], stackChildAlignSelf: "STRETCH" },
    ];
    const names = ["Egypt", "Dominican Republic", "UAE", "Thailand"];
    for (let i = 0; i < 4; i++) {
      const card = `41:${i * 10 + 1}`;
      changes.push(
        { guid: card, phase: "CREATED", type: "SYMBOL", name: "info card", parentIndex: { guid: "40:2", position: String.fromCharCode(33 + i) }, size: { x: 412.67, y: 444 }, transform: at(0, 0), fillPaints: solid(1, 1, 1), cornerRadius: 16, rectangleTopLeftCornerRadius: 16, rectangleTopRightCornerRadius: 16, rectangleBottomLeftCornerRadius: 16, rectangleBottomRightCornerRadius: 16, strokePaints: solid(0.9, 0.9, 0.9), strokeWeight: 1, strokeAlign: "INSIDE", stackMode: "VERTICAL", stackHorizontalPadding: 1, stackVerticalPadding: 1, stackPaddingRight: 1, stackPaddingBottom: 1, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED", frameMaskDisabled: false, gridChildHorizontalAlign: "AUTO", stackChildAlignSelf: "STRETCH" },
        { guid: `41:${i * 10 + 2}`, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "image", parentIndex: { guid: card, position: "!" }, size: { x: 410.67, y: 348 }, transform: at(1, 1), fillPaints: solid(0.45 + 0.1 * i, 0.6, 0.72), stackChildAlignSelf: "STRETCH" },
        { guid: `41:${i * 10 + 3}`, phase: "CREATED", type: "FRAME", name: "Text", parentIndex: { guid: card, position: '"' }, size: { x: 410.67, y: 70 }, transform: at(1, 349), fillPaints: solid(1, 1, 1), stackMode: "VERTICAL", stackSpacing: 12, stackVerticalPadding: 12, stackHorizontalPadding: 16, stackPaddingRight: 12, stackPaddingBottom: 12, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED", stackPrimaryAlignItems: "CENTER", stackChildAlignSelf: "STRETCH" },
        { guid: `41:${i * 10 + 4}`, phase: "CREATED", type: "FRAME", name: "content", parentIndex: { guid: `41:${i * 10 + 3}`, position: "!" }, size: { x: 382.67, y: 46 }, transform: at(16, 12), fillPaints: [], stackChildAlignSelf: "STRETCH" },
        { guid: `41:${i * 10 + 5}`, phase: "CREATED", type: "TEXT", name: names[i], parentIndex: { guid: `41:${i * 10 + 4}`, position: "!" }, size: { x: 382.67, y: 24 }, transform: at(0, -2), fillPaints: solid(0.05, 0.47, 0.95), textData: { characters: names[i] }, fontName: font, fontSize: 20, textAutoResize: "HEIGHT" },
        { guid: `41:${i * 10 + 6}`, phase: "CREATED", type: "TEXT", name: "Lorem", parentIndex: { guid: `41:${i * 10 + 4}`, position: '"' }, size: { x: 382.67, y: 18 }, transform: at(0, 28), fillPaints: solid(0, 0, 0), textData: { characters: "Lorem ipsum dolor sit amet" }, fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 14, textAutoResize: "HEIGHT" },
      );
    }
    e.applyChanges({ type: "NODE_CHANGES", nodeChanges: changes });
    const c = e.readNode("40:2");
    let grid = g.gridDefaults(c, 40, 2, 2);
    grid = { ...grid, gridColumnGap: 24, gridRowGap: 24, stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" };
    e.setProps(["40:2"], grid);
    const c2 = e.readNode("40:2");
    e.setProps(["40:2"], g.setTrackSizing(c2, "columns", [0, 1], { type: "FLEX", value: 1 }));
  });
  await settle(page);
  const info = await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    const pick = (id) => {
      const n = e.readNode(id);
      return { id, size: n.size, m: [n.transform.m02, n.transform.m12], mode: n.stackMode };
    };
    return ["40:1", "40:2", "41:1", "41:11", "41:21", "41:23"].map(pick);
  });
  console.log(JSON.stringify(info));

  // Dev Mode.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+KeyD");
  await settle(page);
  // The camera: a document point at a canvas (CSS) point, at a zoom.
  const place = (docX, docY, cssX, cssY, zoom) =>
    page.evaluate(
      ([docX, docY, cssX, cssY, zoom]) => {
        const ed = window.__designerEditor;
        const r = ed.canvas.getBoundingClientRect();
        ed.engine.setCamera({ x: cssX - r.left - docX * zoom, y: cssY - r.top - docY * zoom, zoom });
      },
      [docX, docY, cssX, cssY, zoom],
    );
  const world = (id) => page.evaluate((id) => window.__designerEditor.engine.worldBounds?.(id) ?? null, id);
  console.log("world", JSON.stringify(await world("41:11")));

  // 1. The gap capture: zoom 129 %, the column gap's left edge (the first column's right) at 1056 / 1.32 CSS, the
  //    first row gap's top at 290 / 1.32.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["40:1"]));
  await settle(page);
  const card0 = await page.evaluate(() => window.__designerEditor.engine.readNode("41:1"));
  const colRight = 2000 + card0.transform.m02 + card0.size.x;
  const rowBottom = card0.transform.m12 + card0.size.y;
  await place(colRight, rowBottom, 1056 / 1.32, 290 / 1.32, 1.29);
  await page.evaluate(() => window.__designerEditor.engine.setHover(["40:2"]));
  await page.mouse.move(1, 500);
  await settle(page);
  await page.waitForTimeout(300);
  await settle(page);
  await page.screenshot({ path: path.join(outDir, "wecra-devmode-gap-hatch.png") });

  // 2. The padding capture: zoom 178 %, the third card's "Text" selected, its left edge at 445 / 1.32, its top at 864 / 1.32.
  await page.evaluate(() => window.__designerEditor.engine.setHover([]));
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["41:23"]));
  await settle(page);
  const t = await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    const card = e.readNode("41:21"), text = e.readNode("41:23");
    return { x: 2000 + card.transform.m02 + text.transform.m02, y: card.transform.m12 + text.transform.m12 };
  });
  await place(t.x, t.y, 445 / 1.32, 864 / 1.32, 1.78);
  await settle(page);
  await page.waitForTimeout(300);
  await settle(page);
  await page.screenshot({ path: path.join(outDir, "wecra-devmode-padding-hatch.png") });
  console.log(`devinspect-shot: ${outDir}`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
