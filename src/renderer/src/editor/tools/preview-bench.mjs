// The inline preview / Present here measurements (docs/handoff.md, 2026-10-20 "the preview opens without a freeze"):
// `?editor&doc=design-system` in Chrome on the real GPU, its Screens page (instances of components on the Components
// page) enlarged in place by duplicating its frames, optionally copied to more pages; then ⇧Space opened, closed and
// opened again, and Present here — each timed as the main thread's long tasks from the request to the preview's
// first frame, and the time to that frame; the engines' memory; the cost of the editor's commits on the preview.
//
//   node src/renderer/src/editor/tools/preview-bench.mjs                   one heavy page (~100k nodes in the engine)
//   BENCH_NODES=25000 BENCH_PAGES=4 node …                                 four pages of ~25k each (page copies)
//   BENCH_PROFILE=1 node …                                                 a CPU profile of the first opening (stderr)
//   EDITOR_URL=http://localhost:5361 node …                                a running server instead of starting one
//
// The browser and the server are closed at the end, or after BENCH_TIMEOUT seconds (default 300).
/* global process, console, window, requestAnimationFrame, setTimeout, performance, PerformanceObserver, localStorage, OffscreenCanvas, crypto, createImageBitmap */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const target = Number(process.env.BENCH_NODES ?? 100000);
const pages = Number(process.env.BENCH_PAGES ?? 1);

let server = null;
let base = process.env.EDITOR_URL;
if (!base) {
  server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.BENCH_PORT ?? 5361), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, "");
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? (existsSync(chrome) ? chrome : undefined),
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--enable-precise-memory-info"],
});
const stop = async (code) => {
  await browser.close().catch(() => {});
  await server?.close().catch(() => {});
  process.exit(code);
};
setTimeout(() => {
  console.error("preview-bench: stopped on its timeout");
  void stop(2);
}, Number(process.env.BENCH_TIMEOUT ?? 300) * 1000).unref();

const round = (x) => Math.round(x * 10) / 10;
const MB = (x) => Math.round(x / 1048576);

async function run() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
    window.__bench = { tasks: [], frames: [], last: 0 };
    const tick = (t) => {
      if (window.__bench.last) window.__bench.frames.push({ at: window.__bench.last, ms: t - window.__bench.last });
      window.__bench.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__bench.tasks.push({ at: e.startTime, ms: e.duration }))).observe({ type: "longtask", buffered: true });
  });
  await page.goto(`${base}/?editor&doc=design-system`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // The fixture: the Screens page's frames duplicated until the engine holds `target` nodes on it, then page copies.
  const built = await page.evaluate(
    async ({ target, pages }) => {
      const ed = window.__designerEditor;
      const e = ed.engine;
      const nodes = () => e.stats().nodes;
      const before = nodes();
      const top = () => e.readNode("0:1", { childIds: true }).childIds ?? [];
      let guard = 0;
      while (nodes() - before < target - before && guard++ < 40) {
        const kids = top();
        const total = nodes();
        // Duplicate only as much as is still missing (a share of the page's frames).
        const share = Math.min(1, (target - total) / Math.max(1, total - before + 5000));
        e.setSelection(kids.slice(0, Math.max(1, Math.ceil(kids.length * share))));
        e.command("DUPLICATE");
        await new Promise((r) => requestAnimationFrame(r));
      }
      e.setSelection([]);
      for (let i = 1; i < pages; i++) {
        e.setCurrentPage("0:1");
        e.command("DUPLICATE_PAGE");
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (ed.store.page !== "0:1") e.setCurrentPage("0:1");
      await new Promise((r) => setTimeout(r, 500));
      return { nodes: nodes(), pages: e.pages().length };
    },
    { target, pages }
  );
  await page.waitForTimeout(1000);

  // The engine calls an opening makes, timed (window.__calls: name → [ms…]).
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const Engine = ed.engine.constructor;
    const calls = (window.__calls = {});
    const note = (name, ms) => {
      (calls[name] ??= []).push(Math.round(ms * 10) / 10);
      (window.__timeline ??= []).push({ name, at: performance.now() - ms, ms });
    };
    const wrap = (obj, name) => {
      const fn = obj[name];
      obj[name] = function (...a) {
        const t = performance.now();
        const r = fn.apply(this, a);
        if (r && typeof r.then === "function") return r.then((v) => (note(name, performance.now() - t), v));
        note(name, performance.now() - t);
        return r;
      };
    };
    for (const m of ["loadKiwi", "loadPageOf", "encodePageKiwi", "encodeDocumentKiwi", "presentStart", "presentStop", "renderNow", "frameNow", "deriveNext", "applyChangesKiwi", "setViewport", "presentState"]) wrap(Engine.prototype, m);
    wrap(Engine, "create");
    const frame = Object.getOwnPropertyDescriptor(Engine.prototype, "schedule");
    void frame;
  });

  const cdp = process.env.BENCH_PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send("Profiler.enable");

  /** Opens (the preview or Present here), waits for its first frame; the long tasks and time to it. */
  const open = async (what, profile = false) => {
    if (profile && cdp) await cdp.send("Profiler.start");
    const r = await page.evaluate(async ({ what, settle }) => {
      const ed = window.__designerEditor;
      const before = { heap: ed.engine.memoryBytes(), used: ed.engine.heapUsed() };
      for (const k of Object.keys(window.__calls)) delete window.__calls[k];
      const start = performance.now();
      if (what === "preview") ed.ui.set({ preview: { page: ed.store.page, node: window.__benchNode ?? null } });
      else ed.ui.set({ presenting: { page: ed.store.page, node: null } });
      const engineOf = () => (what === "preview" ? window.__designerPreview : window.__designerPresent);
      // The first frame with the prototype on screen: the engine is presenting and a frame went by after it.
      await new Promise((done) => {
        const poll = () => {
          const pe = engineOf();
          let shown = false;
          try {
            shown = !!pe && !pe.destroyed && !!pe.presentState().screen;
          } catch {
            shown = false;
          }
          if (shown) requestAnimationFrame(() => done());
          else if (performance.now() - start > 30000) done();
          else requestAnimationFrame(poll);
        };
        poll();
      });
      const firstFrame = performance.now() - start;
      await new Promise((r) => setTimeout(r, settle));
      const tasks = window.__bench.tasks.filter((x) => x.at >= start - 1 && x.at < start + firstFrame + 800);
      // The editor's frames from the request on: the longest gap is how long the window froze.
      const gaps = window.__bench.frames.filter((x) => x.at >= start - 17 && x.at < start + firstFrame + 800).map((x) => x.ms);
      const pe = engineOf();
      const st = pe && !pe.destroyed ? pe.stats() : {};
      return {
        firstFrameMs: firstFrame,
        longTasks: tasks.map((x) => Math.round(x.ms)),
        longTaskMs: tasks.reduce((s, x) => s + x.ms, 0),
        maxTaskMs: Math.max(0, ...tasks.map((x) => x.ms)),
        maxFrameGapMs: Math.max(0, ...gaps),
        // From the request: each gap between frames over 30 ms, and the engine calls (over 1 ms) in the first second.
        timeline: [
          ...window.__bench.frames.filter((x) => x.at >= start - 17 && x.at < start + firstFrame + 100 && x.ms > 30).map((x) => `gap ${Math.round(x.at - start)}+${Math.round(x.ms)}`),
          ...(window.__timeline ?? []).filter((x) => x.at >= start - 1 && x.at < start + firstFrame + 100 && x.ms > 1).map((x) => `${x.name} ${Math.round(x.at - start)}+${Math.round(x.ms)}`),
        ],
        framesOver50: gaps.filter((g) => g > 50).length,
        previewNodes: st.nodes,
        heapGrowthMB: (ed.engine.memoryBytes() - before.heap) / 1048576,
        usedGrowthMB: (ed.engine.heapUsed() - before.used) / 1048576,
        calls: Object.fromEntries(Object.entries(window.__calls).map(([k, v]) => [k, { n: v.length, ms: Math.round(v.reduce((s, x) => s + x, 0)), max: Math.max(...v) }])),
      };
    }, { what, settle: profile && cdp && ["first", "again"].includes(process.env.BENCH_PROFILE) ? 0 : 800 });
    if (profile && cdp) {
      const { profile: p } = await cdp.send("Profiler.stop");
      const self = new Map();
      p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
      const byFn = new Map();
      for (const n of p.nodes) {
        const f = n.callFrame;
        const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
        byFn.set(k, (byFn.get(k) ?? 0) + (self.get(n.id) ?? 0) / 1000);
      }
      console.error("self:\n" + [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${k}`).join("\n"));
      // Inclusive: each function's subtree (counted once per stack).
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      const total = new Map();
      const walk = (id, onStack) => {
        const n = byId.get(id);
        const k = n.callFrame.functionName || "(anon)";
        let sum = (self.get(id) ?? 0) / 1000;
        const first = !onStack.has(k);
        if (first) onStack.add(k);
        for (const c of n.children ?? []) sum += walk(c, onStack);
        if (first) {
          onStack.delete(k);
          total.set(k, (total.get(k) ?? 0) + sum);
        }
        return sum;
      };
      walk(p.nodes[0].id, new Set());
      console.error("total:\n" + [...total].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${k}`).join("\n"));
    }
    return { ...r, firstFrameMs: round(r.firstFrameMs), longTaskMs: round(r.longTaskMs), maxTaskMs: round(r.maxTaskMs), maxFrameGapMs: round(r.maxFrameGapMs), heapGrowthMB: round(r.heapGrowthMB), usedGrowthMB: round(r.usedGrowthMB) };
  };
  const close = async (what) => {
    await page.evaluate((what) => window.__designerEditor.ui.set(what === "preview" ? { preview: null } : { presenting: null }), what);
    await page.waitForTimeout(800);
  };
  /** The editor's commits while the preview is open or closed: the time the preview engine spends on them. */
  const edits = async (n) =>
    page.evaluate(async (n) => {
      const ed = window.__designerEditor;
      const e = ed.engine;
      const pe = window.__designerPreview;
      let applyMs = 0;
      let applied = 0;
      let restore = null;
      let frames = 0;
      if (pe && !pe.destroyed) {
        const apply = pe.applyChangesKiwi;
        pe.applyChangesKiwi = function (...a) {
          const t = performance.now();
          const r = apply.apply(this, a);
          applyMs += performance.now() - t;
          applied++;
          return r;
        };
        // Its frames (a hidden preview draws none).
        const frame = pe.frame;
        pe.frame = (t) => {
          frames++;
          frame(t);
        };
        restore = () => {
          pe.applyChangesKiwi = apply;
          pe.frame = frame;
        };
      }
      const frame = (e.readNode("0:1", { childIds: true }).childIds ?? [])[0];
      const start = performance.now();
      for (let i = 0; i < n; i++) {
        e.setSelection([frame]);
        e.command("NUDGE", { dx: 1, dy: 0 });
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 500));
      const tasks = window.__bench.tasks.filter((x) => x.at >= start);
      restore?.();
      e.setSelection([]);
      return { commits: n, previewFrames: frames, applied, applyMs: Math.round(applyMs), perApplyMs: applied ? Math.round((applyMs / applied) * 10) / 10 : 0, longTaskMs: Math.round(tasks.reduce((s, x) => s + x.ms, 0)) };
    }, n);

  const out = { gfx: await page.evaluate(() => window.__designerEditor.engine.gfx), fixture: built };
  // BENCH_PROBE=1: the document's encodings (whole / the page's subset, with and without derived data) loaded into a
  // headless engine, each step timed.
  if (process.env.BENCH_PROBE) {
    out.probe = await page.evaluate(async () => {
      const ed = window.__designerEditor;
      const Engine = ed.engine.constructor;
      const page = ed.store.page;
      const rows = [];
      for (const [name, encode] of [
        ["whole", () => ed.engine.encodeDocumentKiwi()],
        ["whole+derived", () => ed.engine.encodeDocumentKiwi({ derived: true })],
        ["page", () => ed.engine.encodePageKiwi(page)],
        ["page+derived", () => ed.engine.encodePageKiwi(page, { derived: true })],
      ]) {
        const t0 = performance.now();
        const bytes = encode();
        const t1 = performance.now();
        const e = await Engine.create(null, { wire: "kiwi", sessionID: 1 });
        const t2 = performance.now();
        e.loadKiwi(bytes, { page });
        const t3 = performance.now();
        rows.push({ name, encodeMs: Math.round(t1 - t0), MB: Math.round(bytes.length / 1048576 * 10) / 10, loadMs: Math.round(t3 - t2), nodes: e.stats().nodes });
        e.destroy();
        await new Promise((r) => setTimeout(r, 200));
      }
      return rows;
    });
    if (process.env.BENCH_PROBE === "only") {
      await context.close();
      return out;
    }
  }
  out.previewFirst = await open("preview", process.env.BENCH_PROFILE !== "again");
  out.editsOpen = await edits(20);
  await close("preview");
  out.editsClosed = await edits(20);
  // The kept engine's frames, timed (its frame function is its own).
  await page.evaluate(() => {
    const pe = window.__designerPreview;
    if (!pe || pe.destroyed) return;
    const frame = pe.frame;
    pe.frame = (t) => {
      const s = performance.now();
      frame(t);
      const ms = performance.now() - s;
      (window.__timeline ??= []).push({ name: "frame", at: s, ms });
    };
  });
  out.previewAgain = await open("preview", process.env.BENCH_PROFILE === "again");
  await close("preview");
  out.presentHere = await open("present");
  await close("present");
  // BENCH_IMAGES=N: N different 1600 × 1200 images (decoded, as the editor has them) filling layers of the first
  // screen, then a fresh preview (the kept one dropped) — its first frame uploads them to its own GPU context.
  if (Number(process.env.BENCH_IMAGES ?? 0) > 0) {
    await page.evaluate(async (n) => {
      const ed = window.__designerEditor;
      const screen = (ed.engine.readNode(ed.store.page, { childIds: true }).childIds ?? [])[0];
      const layers = ed.engine.readNodes([screen], { subtree: true, fields: ["type"] }).filter((x) => x.type === "FRAME" || x.type === "INSTANCE" || x.type === "RECTANGLE" || x.type === "ROUNDED_RECTANGLE");
      const changes = [];
      for (let i = 0; i < n && i < layers.length; i++) {
        const c = new OffscreenCanvas(1600, 1200);
        const g = c.getContext("2d");
        const grad = g.createLinearGradient(0, 0, 1600, 1200);
        grad.addColorStop(0, `hsl(${(i * 37) % 360} 80% 50%)`);
        grad.addColorStop(1, `hsl(${(i * 37 + 120) % 360} 80% 40%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 1600, 1200);
        const hash = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
        ed.engine.addImage(hash, await createImageBitmap(c));
        changes.push({ guid: layers[i].guid, phase: "CHANGED", fillPaints: [{ type: "IMAGE", image: { hash }, imageScaleMode: "FILL", visible: true, opacity: 1 }] });
      }
      ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
      ed.ui.set({ previewKept: null });
      await new Promise((r) => setTimeout(r, 1000));
      window.__benchNode = screen;
    }, Number(process.env.BENCH_IMAGES));
    out.previewImages = await open("preview");
    await close("preview");
  }
  out.heapMB = await page.evaluate(() => Math.round(window.__designerEditor.engine.memoryBytes() / 1048576));
  out.usedMB = await page.evaluate(() => Math.round(window.__designerEditor.engine.heapUsed() / 1048576));
  void MB;
  await context.close();
  return out;
}

try {
  console.log(JSON.stringify(await run(), null, 1));
  await stop(0);
} catch (e) {
  console.error(e);
  await stop(1);
}
