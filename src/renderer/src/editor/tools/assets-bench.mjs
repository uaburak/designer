// The Assets / insert / drag measurements (docs/handoff.md, 2026-10-20): `?editor&doc=design-system` (340 assets,
// ~1,300 instances) in Chrome on the real GPU (WebGL2 over Metal), driven like a person — open Assets, a library,
// its pages, a search typed letter by letter, a tile dragged onto the canvas, a click to insert, the new instance
// dragged on the canvas (Assets open, then Layers open) — each timed as the main thread's blocking (the time to the
// next frame after the input, and the long tasks over the step) and drags as their frame intervals.
//
//   node src/renderer/src/editor/tools/assets-bench.mjs [runs]        (default 1; prints one JSON line per run)
//   EDITOR_URL=http://localhost:5347 node …                           (use a running server instead of starting one)
//   BENCH_PROFILE=iconsPage node …                                     (a CPU profile of one step: assetsOpen, iconsPage, search, clickInsert)
//   BENCH_EVAL=probe.js node …                                         (run an async function body in the loaded page instead)
//
// The browser and the server are closed at the end, or after BENCH_TIMEOUT seconds (default 240).
/* global process, console, window, document, requestAnimationFrame, setTimeout, performance, PerformanceObserver, localStorage */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const runs = Number(process.argv[2] ?? 1);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let server = null;
let base = process.env.EDITOR_URL;
if (!base) {
  server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.BENCH_PORT ?? 5347), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, "");
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? (existsSync(chrome) ? chrome : undefined),
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const stop = async (code) => {
  await browser.close().catch(() => {});
  await server?.close().catch(() => {});
  process.exit(code);
};
setTimeout(() => {
  console.error("assets-bench: stopped on its timeout");
  void stop(2);
}, Number(process.env.BENCH_TIMEOUT ?? 240) * 1000).unref();

const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0);
const round = (x) => Math.round(x * 10) / 10;

async function run() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
    // Long tasks and frame intervals, read per step.
    window.__bench = { tasks: [], frames: [], last: 0 };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__bench.tasks.push({ at: e.startTime, ms: e.duration }))).observe({ type: "longtask", buffered: true });
    const tick = (t) => {
      if (window.__bench.last) window.__bench.frames.push({ at: t, ms: t - window.__bench.last });
      window.__bench.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${base}/?editor&doc=design-system`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?";
  });
  // BENCH_EVAL=<file>: an async function body run in the page instead of the scenario (probes); its result printed.
  if (process.env.BENCH_EVAL) {
    const body = (await import("node:fs")).readFileSync(process.env.BENCH_EVAL, "utf8");
    const result = await page.evaluate((body) => new Function(`return (async () => { ${body} })()`)(), body);
    await context.close();
    return { gpu, result };
  }
  // Calls into the component index and the engine's thumbnail render, counted per step.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const counts = (window.__counts = { assets: 0, assetsWalk: 0, thumbs: 0, thumbMs: 0 });
    const assets = ed.components.assets.bind(ed.components);
    ed.components.assets = () => {
      counts.assets++;
      const t = performance.now();
      const r = assets();
      if (performance.now() - t > 0.5) counts.assetsWalk++;
      return r;
    };
    const render = ed.engine.renderNodeThumbnailPixels;
    ed.engine.renderNodeThumbnailPixels = function (o) {
      counts.thumbs++;
      const t = performance.now();
      const r = render.call(this, o);
      counts.thumbMs += performance.now() - t;
      return r;
    };
  });

  /** Runs `act`, then measures: the time to the second frame after it, the long tasks until things settle, the counts. */
  // BENCH_PROFILE=<step>: a CPU profile of that step, its top functions by self time printed to stderr.
  const cdp = process.env.BENCH_PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send("Profiler.enable");
  const profiled = async (name, run) => {
    if (!cdp || process.env.BENCH_PROFILE !== name) return run();
    await cdp.send("Profiler.start");
    const out = await run();
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
    const byFn = new Map();
    for (const n of profile.nodes) {
      const f = n.callFrame;
      const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
      byFn.set(k, (byFn.get(k) ?? 0) + (self.get(n.id) ?? 0) / 1000);
    }
    console.error([...byFn].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${k}`).join("\n"));
    return out;
  };
  const step = async (act, settle = 600, name = "") => profiled(name, () => stepRun(act, settle));
  const stepRun = async (act, settle = 600) => {
    const start = await page.evaluate(() => {
      Object.assign(window.__counts, { assets: 0, assetsWalk: 0, thumbs: 0, thumbMs: 0 });
      return performance.now();
    });
    await act();
    const toFrame = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
    await page.waitForTimeout(settle);
    return page.evaluate(
      ({ start, toFrame }) => {
        const tasks = window.__bench.tasks.filter((x) => x.at >= start - 1);
        const frames = window.__bench.frames.filter((x) => x.at >= start).map((x) => x.ms);
        return { toFrameMs: toFrame - start, longTasks: tasks.length, longTaskMs: tasks.reduce((s, x) => s + x.ms, 0), maxTaskMs: Math.max(0, ...tasks.map((x) => x.ms)), maxFrameMs: Math.max(0, ...frames), counts: { ...window.__counts } };
      },
      { start, toFrame }
    );
  };
  /** Moves the mouse from a to b in n steps, 16 ms apart; the frame intervals and long tasks over the moves. */
  const dragFrames = async (a, b, n, { down = true } = {}) => {
    await page.mouse.move(a[0], a[1]);
    if (down) await page.mouse.down();
    const start = await page.evaluate(() => {
      Object.assign(window.__counts, { assets: 0, assetsWalk: 0, thumbs: 0, thumbMs: 0 });
      return performance.now();
    });
    for (let i = 1; i <= n; i++) {
      await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
      await page.waitForTimeout(16);
    }
    const end = await page.evaluate(() => performance.now());
    const t = await page.evaluate(() => performance.now());
    if (down) await page.mouse.up();
    const drop = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
    await page.waitForTimeout(400);
    return page.evaluate(
      ({ start, end, t, drop }) => {
        const frames = window.__bench.frames.filter((x) => x.at >= start && x.at <= end).map((x) => x.ms);
        const tasks = window.__bench.tasks.filter((x) => x.at >= start && x.at <= end);
        return { frames, longTaskMs: tasks.reduce((s, x) => s + x.ms, 0), dropMs: drop - t, counts: { ...window.__counts } };
      },
      { start, end, t, drop }
    );
  };
  const summary = (d) => ({ frames: d.frames.length, p50: round([...d.frames].sort((a, b) => a - b)[Math.floor(d.frames.length / 2)] ?? 0), p95: round(p95(d.frames)), max: round(Math.max(0, ...d.frames)), longTaskMs: round(d.longTaskMs), dropMs: round(d.dropMs), counts: d.counts });
  const r = (x) => ({ ...x, toFrameMs: round(x.toFrameMs), longTaskMs: round(x.longTaskMs), maxTaskMs: round(x.maxTaskMs), maxFrameMs: round(x.maxFrameMs), counts: { ...x.counts, thumbMs: round(x.counts.thumbMs) } });

  const out = { gpu };
  const canvas = await page.locator("[data-canvas-view]").boundingBox();
  const mid = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];
  // A baseline: an instance on the Screens page dragged with Layers open.
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  out.assetsOpen = r(await step(() => page.keyboard.press("Alt+Digit2"), 600, "assetsOpen"));
  out.libraryOpen = r(await step(() => page.locator('[data-library-card="Created in this file"]').click()));
  out.iconsPage = r(await step(() => page.locator('[data-asset-page="Icons"]').click(), 1200, "iconsPage"));
  out.back = r(await step(() => page.getByRole("button", { name: "Back" }).click()));
  out.componentsPage = r(await step(() => page.locator('[data-asset-page="Components"]').click(), 1200));
  // Search, letter by letter
  const search = page.locator("[data-assets-search] input, input[data-assets-search]").first();
  await search.click();
  const typed = [];
  for (const ch of "card 1") typed.push(r(await step(() => page.keyboard.type(ch), 150, ch === "c" ? "search" : "")));
  out.search = { perKeyToFrameMs: typed.map((x) => x.toFrameMs), longTaskMs: round(typed.reduce((s, x) => s + x.longTaskMs, 0)), thumbs: typed.reduce((s, x) => s + x.counts.thumbs, 0) };
  out.searchClear = r(await step(() => page.keyboard.press("Meta+a").then(() => page.keyboard.press("Backspace")), 1200));
  // A tile dragged onto the canvas
  const tile = await page.locator("[data-asset]").nth(5).boundingBox();
  const from = [tile.x + tile.width / 2, tile.y + tile.height / 2];
  out.tileDrag = summary(await dragFrames(from, [mid[0] + 150, mid[1]], 40));
  // A click on a tile inserts one
  out.clickInsert = r(await step(() => page.locator("[data-asset]").nth(9).click(), 800, "clickInsert"));
  // The new instance (in the middle of the view) dragged on the canvas, Assets open
  out.instanceDragAssets = summary(await dragFrames(mid, [mid[0] - 200, mid[1] + 100], 60));
  // The swap menu of an icon instance: its level (40 icons), then a search over every component
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["41:0"]));
  await page.waitForTimeout(400);
  out.swapOpen = r(await step(() => page.locator('[data-panel="right"] [data-instance-menu]').click(), 800, "swapOpen"));
  out.swapSearch = r(await step(() => page.keyboard.type("i"), 800));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await page.waitForTimeout(300);
  // The same with Layers open
  await page.keyboard.press("Alt+Digit1");
  await page.waitForTimeout(500);
  out.instanceDragLayers = summary(await dragFrames([mid[0] - 200, mid[1] + 100], mid, 60));
  await context.close();
  return out;
}

try {
  for (let i = 0; i < runs; i++) console.log(JSON.stringify(await run()));
  await stop(0);
} catch (e) {
  console.error(e);
  await stop(1);
}
