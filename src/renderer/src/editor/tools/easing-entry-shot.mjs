// The three easing editors moved onto the right panel's Easing page's controls (2026-10-19, docs/motion.md §6.14):
// `?editor&doc=motion`, dark theme, the owner's capture scale (1.32×) —
//   easing-clip.png      a preset clip's Easing clicked in the Animations section: the panel's Easing page (presets open);
//   easing-social.png    Social: a timeline segment clicked, the Easing page in Social's right panel (Properties);
//   easing-variable.png  the Variables view: an Easing variable's value clicked, the page's controls in its editor.
//
//   node src/renderer/src/editor/tools/easing-entry-shot.mjs [outDir]   (default /tmp/designer-work/easing-entry)
//   SHOT_PORT=5318 (the vite server's port; never the owner's 3000)
/* global process, console, window, requestAnimationFrame, setTimeout, localStorage */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/designer-work/easing-entry");
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

const server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.SHOT_PORT ?? 5318), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const hardStop = setTimeout(async () => {
  console.error("easing-entry-shot: stopped after 180 s");
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(2);
}, 180_000);
hardStop.unref();

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function open(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`${base}/?editor&doc=motion`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
  await settle(page);
  return page;
}

try {
  const context = await browser.newContext({ viewport: { width: 1515, height: 984 }, deviceScaleFactor: 1.32, colorScheme: "dark" });

  // 1. A preset clip's Easing: Motion, the layer's Opacity clip open, its Easing clicked → the page; the presets open.
  let page = await open(context);
  await page.evaluate(async () => {
    const ed = window.__designerEditor;
    const { setMode } = await import("/src/editor/devmode/devMode.ts");
    const { setMotionUi } = await import("/src/editor/motion/motionState.ts");
    const { addPreset } = await import("/src/editor/motion/presets.ts");
    ed.engine.setSelection(["1:2"]);
    setMode(ed, "motion");
    const [clip] = addPreset(ed, "opacity", ["1:2"]);
    setMotionUi(ed, { selectedClip: clip });
  });
  await settle(page);
  await page.waitForTimeout(300);
  await page.click("[data-clip-easing]");
  await settle(page);
  await page.click("[data-easing-select]");
  await settle(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, "easing-clip.png") });
  console.log("clip page:", await page.locator('[data-easing-page="clip"]').count(), "popover:", await page.locator("[data-easing-editor]").count());
  await page.close();

  // 2. Social: the same file in Social mode, a timeline segment clicked → the Easing page in the right panel.
  page = await open(context);
  await page.evaluate(async () => {
    const ed = window.__designerEditor;
    const { setMode } = await import("/src/editor/devmode/devMode.ts");
    ed.engine.setSelection(["1:2"]);
    setMode(ed, "social");
  });
  await settle(page);
  await page.waitForTimeout(500);
  const segment = page.locator("[data-segment]").nth(1);
  if ((await segment.count()) === 0) console.error("social: no timeline segment shown");
  else {
    await segment.click();
    await settle(page);
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: path.join(outDir, "easing-social.png") });
  console.log("social page:", await page.locator('[data-easing-page="segments"]').count(), "popover:", await page.locator("[data-easing-editor]").count());
  await page.close();

  // 3. An Easing variable's value: one made in the file, the Variables view open, its value clicked.
  page = await open(context);
  await page.evaluate(async () => {
    const ed = window.__designerEditor;
    const { createCollection, createVariable } = await import("/src/editor/variables.ts");
    const collection = ed.variables.get().collections[0]?.id ?? createCollection(ed);
    createVariable(ed, collection, "EASING", "motion/enter", { kind: "literal", value: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.45, y1: 1.45, x2: 0.8, y2: 1 } } });
    ed.ui.set({ variablesOpen: true });
  });
  await settle(page);
  await page.waitForTimeout(500);
  await page.locator("[data-easing-value]").first().click();
  await settle(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, "easing-variable.png") });
  console.log("variable editor:", await page.locator("[data-easing-value-editor]").count(), "popover:", await page.locator("[data-easing-editor]").count());
  console.log(`easing-entry-shot: ${outDir}`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
