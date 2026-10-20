// The prototype bench's helpers (bench.mjs, tab.mjs): the built Electron app (out/, `npm run build`) launched on a
// COPY of a workspace — never the everyday one —, offline (DESIGNER_SERVER points nowhere: nothing syncs to the
// server), a file opened, its frames and long tasks recorded in the page.
//
//   UD=<copy of ~/Library/Application Support/DesignerV2 (Workspace, account, settings.json, fonts)>
//   APP_DIR=<another checkout's root, built> runs that build instead (a before / after comparison).
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
export const APP_DIR = process.env.APP_DIR || path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(APP_DIR, "package.json"));
const { _electron: electron } = require("playwright-core");
export const SCR = process.env.SCREENSHOT_DIR || os.tmpdir();
if (!process.env.UD) throw new Error("UD=<a copy of the app's user data> is needed (never the everyday one)");
export const USER_DATA = process.env.UD;
/** A file by its key; the owner's heavy files by name (2026-10-20). */
const OWNER_FILES = { kahve: "N58dQS7P47PrD2JPT9t70t", b2c: "RktQdAS12XKvwCnRRdJoDv", ui: "Lvpon4riW74lSya39Pzf1M", ds: "f8H6mYj3fOOTuXSdN8FvPk" };
export const FILES = new Proxy(OWNER_FILES, { get: (t, k) => t[k] ?? k });

export let app = null;
export async function launch() {
  const env = { ...process.env, DESIGNER_USER_DATA: USER_DATA, DESIGNER_TEST: "1", DESIGNER_SERVER: "http://127.0.0.1:9" };
  delete env.ELECTRON_RUN_AS_NODE;
  // No tabs restored from the last run.
  fs.rmSync(path.join(USER_DATA, "session.json"), { force: true });
  const bin = path.join(APP_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  for (let i = 1; ; i++) {
    try {
      app = await electron.launch({ executablePath: bin, args: [APP_DIR, ...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(" ") : [])], env, chromiumSandbox: true, colorScheme: null, timeout: 20000 });
      break;
    } catch (e) {
      if (i >= 4) throw e;
    }
  }
  app.on("console", (m) => (m.type() === "error") && console.error(`[main] ${m.text()}`));
  app.on("window", (p) => p.on("pageerror", (e) => console.error(`[pageerror]`, e.message)));
  await app.firstWindow();
  console.error("launched");
  const proc = app.process();
  process.on("exit", () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  });
  return app;
}
export const debug = () => app.evaluate(() => globalThis.__designer.debug());
export async function pageOfTab(id, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const d = await debug();
    const url = d.views.find((v) => v.id === id)?.url;
    const ps = app.windows().filter((p) => url && p.url() === url);
    if (ps.length) return ps[ps.length - 1];
    if (Date.now() > end) throw new Error("no page for " + id);
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Opens a file in its tab; returns its page once the editor drew its first frame. */
export async function openFile(key) {
  // GFX=webgl2: the engines fall back to WebGL2 (the WebGPU fallback count, shared by the app's views).
  const home = app.windows().find((p) => p.url().includes("?files"));
  await home?.evaluate((on) => (on ? localStorage.setItem("designer.gfx.webgpuFallbacks", "99") : localStorage.removeItem("designer.gfx.webgpuFallbacks")), process.env.GFX === "webgl2");
  const before = (await debug()).opens.at(-1);
  const t0 = Date.now();
  await app.evaluate((_e, k) => globalThis.__designer.current().tabs.openFile({ fileKey: k }), key);
  let open;
  const existing = (await debug()).views.find((v) => v.url?.includes("?editor") && v.url?.includes(`file=${key}`));
  if (existing) open = { tabId: existing.id };
  for (; !open; ) {
    open = (await debug()).opens.at(-1);
    if (open && open !== before && (!before || open.at !== before.at)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  let page;
  for (let i = 0; ; i++) {
    page = await pageOfTab(open.tabId);
    try {
      await page.waitForFunction(() => window.__designerOpen?.firstFrame !== undefined && window.__designerEditor, null, { timeout: 120000 });
      break;
    } catch (e) {
      if (i > 5) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  page.on("console", (m) => (m.type() === "error" || m.text().startsWith("[bench]")) && console.error(`[page ${m.type()}] ${m.text().slice(0, 300)}`));
  console.error(`opened ${key} in ${Date.now() - t0} ms`);
  return { page, tabId: open.tabId };
}
/** In-page: long tasks and rAF frame gaps, kept in window.__rec. */
export async function record(page) {
  await page.evaluate(() => {
    if (window.__rec) return;
    const rec = (window.__rec = { tasks: [], frames: [], last: performance.now() });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) rec.tasks.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: "longtask", buffered: false });
    const loop = (t) => {
      rec.frames.push({ at: rec.last, ms: t - rec.last });
      rec.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__mark = () => performance.now();
    window.__report = (from, to = performance.now()) => {
      const tasks = rec.tasks.filter((x) => x.at >= from - 1 && x.at < to);
      const gaps = rec.frames.filter((x) => x.at >= from - 20 && x.at < to).map((x) => x.ms);
      const sorted = [...gaps].sort((a, b) => a - b);
      const q = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10 : 0);
      return { longTasks: tasks.map((x) => Math.round(x.ms)), longTaskMs: Math.round(tasks.reduce((s, x) => s + x.ms, 0)), maxGap: Math.round(Math.max(0, ...gaps)), p95: q(0.95), p50: q(0.5), frames: gaps.length, over33: gaps.filter((g) => g > 33.4).length };
    };
  });
}
export const mark = (page) => page.evaluate(() => window.__mark());
export const report = (page, from, to) => page.evaluate(([f, t]) => window.__report(f, t), [from, to]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function profile(page, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await fn();
  const { profile: p } = await cdp.send("Profiler.stop");
  await cdp.detach();
  return summarize(p);
}
export function summarize(p, n = 40) {
  const self = new Map();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byFn = new Map();
  for (const nd of p.nodes) {
    const f = nd.callFrame;
    const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    byFn.set(k, (byFn.get(k) ?? 0) + (self.get(nd.id) ?? 0) / 1000);
  }
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const total = new Map();
  const walk = (id, on) => {
    const nd = byId.get(id);
    const k = `${nd.callFrame.functionName || "(anon)"} ${nd.callFrame.url.split("/").pop()}:${nd.callFrame.lineNumber + 1}`;
    let sum = (self.get(id) ?? 0) / 1000;
    const first = !on.has(k);
    if (first) on.add(k);
    for (const c of nd.children ?? []) sum += walk(c, on);
    if (first) {
      on.delete(k);
      total.set(k, (total.get(k) ?? 0) + sum);
    }
    return sum;
  };
  walk(p.nodes[0].id, new Set());
  const fmt = (m) => [...m].filter(([k]) => !/^\((idle|program|root)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${ms.toFixed(1).padStart(8)}  ${k}`).join("\n");
  return `SELF\n${fmt(byFn)}\nTOTAL\n${fmt(total)}`;
}
/** Inclusive time of each function under the frames whose name matches `root` (the subtree breakdown). */
export function under(p, root, n = 30) {
  const self = new Map();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const name = (nd) => `${nd.callFrame.functionName || "(anon)"}`.slice(0, 150);
  const total = new Map();
  const sub = (id) => {
    const nd = byId.get(id);
    let s = (self.get(id) ?? 0) / 1000;
    for (const c of nd.children ?? []) s += sub(c);
    return s;
  };
  const visit = (id, inside, on) => {
    const nd = byId.get(id);
    const k = name(nd);
    const within = inside || k.includes(root);
    let first = false;
    if (within && !on.has(k)) {
      on.add(k);
      first = true;
      total.set(k, (total.get(k) ?? 0) + sub(id));
    }
    for (const c of nd.children ?? []) visit(c, within, on);
    if (first) on.delete(k);
  };
  visit(p.nodes[0].id, false, new Set());
  return [...total].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${ms.toFixed(1).padStart(8)}  ${k}`).join("\n");
}
/** The direct callees of the frames named `root` (inclusive ms each) and root's self time. */
export function kids(p, root, n = 25) {
  const self = new Map();
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const name = (nd) => `${nd.callFrame.functionName || "(anon)"}`.slice(0, 140);
  const sub = (id) => {
    const nd = byId.get(id);
    let s = (self.get(id) ?? 0) / 1000;
    for (const c of nd.children ?? []) s += sub(c);
    return s;
  };
  const out = new Map();
  let own = 0;
  for (const nd of p.nodes) {
    if (!name(nd).includes(root)) continue;
    own += (self.get(nd.id) ?? 0) / 1000;
    for (const c of nd.children ?? []) {
      const k = name(byId.get(c));
      out.set(k, (out.get(k) ?? 0) + sub(c));
    }
  }
  return `self ${own.toFixed(1)}\n` + [...out].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${ms.toFixed(1).padStart(8)}  ${k}`).join("\n");
}
export async function rawProfile(page, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  const r = await fn();
  const { profile: p } = await cdp.send("Profiler.stop");
  await cdp.detach();
  return { p, r };
}
export async function close() {
  if (!app) return;
  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  try {
    proc.kill("SIGKILL");
  } catch {
    // already gone
  }
  app = null;
}
export function out(name, obj) {
  fs.mkdirSync(path.join(SCR, "proto-bench"), { recursive: true });
  fs.writeFileSync(path.join(SCR, "proto-bench", name + ".json"), JSON.stringify(obj, null, 1));
  console.log(name, JSON.stringify(obj));
}
