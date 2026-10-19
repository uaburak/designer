// The right panel's Easing page against the owner's Figma capture (2026-10-19,
// docs/research/figma/live/owner-2026-10-19/figma-motion-easing-panel.webp, 2000 × 1299 at 1.32×): opens
// `?editor&doc=motion` in Motion mode, gives a layer's second keyframe the capture's Custom bezier (0.45, 1.45, 0.8, 1),
// selects that segment (the page opens), puts the playhead at 81 % of it, opens the presets popover and hovers
// "Ease out back" — dark theme, the capture's scale. Then the Spring view (Bounce 0.33) without the popover.
//
//   node src/renderer/src/editor/tools/motion-easing-shot.mjs [outDir]   (default /tmp/designer-work/motion-easing)
//   SHOT_PORT=5318 (the vite server's port; never the owner's 3000)
/* global process, console, window, requestAnimationFrame, setTimeout, localStorage */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/designer-work/motion-easing");
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
  console.error("motion-easing-shot: stopped after 150 s");
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(2);
}, 150_000);
hardStop.unref();

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
try {
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
  await page.goto(`${base}/?editor&doc=motion`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
  await settle(page);

  // Motion mode, a layer with a track of three keyframes or more selected, its second segment the capture's curve.
  const picked = await page.evaluate(async () => {
    const ed = window.__designerEditor;
    const { setMode } = await import("/src/editor/devmode/devMode.ts");
    const { setMotionUi, setPlayhead } = await import("/src/editor/motion/motionState.ts");
    ed.engine.setSelection(["1:2"]);
    setMode(ed, "motion");
    const model = ed.engine.motionTimeline("1:2");
    const layer = model.layers.find((l) => l.tracks.some((t) => t.keyframes.length > 1));
    const track = layer.tracks.find((t) => t.keyframes.length > 1);
    const k = track.keyframes[1];
    ed.engine.setSelection([layer.node]);
    ed.engine.runMotionCommand("MOTION_SET_EASING", { ids: [k.id], easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.45, y1: 1.45, x2: 0.8, y2: 1 } } });
    const t0 = track.keyframes[0].timeUs;
    setPlayhead(ed, Math.round(t0 + (k.timeUs - t0) * 0.81));
    setMotionUi(ed, { selectedSegments: [k.id], selectedKeyframes: [] });
    return { node: layer.node, id: k.id };
  });
  console.log("segment", JSON.stringify(picked));
  await settle(page);
  await page.waitForTimeout(400);
  await page.click("[data-easing-select]");
  await settle(page);
  await page.hover('[data-easing-presets] [data-easing="EASE_OUT_BACK"]');
  await page.waitForTimeout(250);
  await settle(page);
  await page.screenshot({ path: path.join(outDir, "wecra-motion-easing-panel.png") });

  // The Spring view: Bounce 0.33, the popover closed.
  await page.keyboard.press("Escape");
  await page.evaluate((id) => {
    window.__designerEditor.engine.runMotionCommand("MOTION_SET_EASING", { ids: [id], easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.33 } } });
  }, picked.id);
  await page.mouse.move(1, 500);
  await settle(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, "wecra-motion-easing-spring.png") });
  console.log(`motion-easing-shot: ${outDir}`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
