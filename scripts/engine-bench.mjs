// The engine's performance benchmark (docs/engine.md §11.4): loads a document
// through the same path the app uses, then measures load stages and frame times
// for the interactions that matter on a large file, on the real GPU.
//
//   node scripts/engine-bench.mjs [file.fig]          default: $DESIGNER_BENCH_FIG
//   node scripts/engine-bench.mjs --synthetic [N]     a generated document of ~N stored nodes (default 25000):
//                                                     screens of auto-layout cards, text, images, instances,
//                                                     shadows — no private file needed
// Options:
//   --wasm <dir>        engine.mjs + engine.wasm to use (default src/renderer/src/engine/wasm): a scratch build
//   --profile <file>    record a CPU profile (Chrome's sampling profiler) over the scenarios; prints the top
//                       functions (build the wasm with --profiling-funcs for C++ names) and saves the .cpuprofile
//   --json <file>       write every number as JSON
//   --page <n|name>     the page to measure (default: the page with the most layers)
//   --size WxH --dpr D  the canvas in CSS px and its device pixel ratio (default 1440x900 @2, a Retina editor)
//   --only a,b          run only these scenarios (rest, slowPan, fastPan, zoom, dense, hover, select, drag)
//   --headed            a visible window instead of headless (the GPU is used either way on macOS)
//   --timeout <s>       stop the run after this long (default 180)
//   --gpu-limit <MB>    stop when Chrome's GPU process uses more than this (default 3072), or the engine's own GPU
//                       memory (engine_stats gpuBytes) more than half of it
//
// Guards (the machine is someone's): the run refuses to start when less than 25 % of memory is free, has a hard
// timeout, watches the GPU process's footprint, and always closes the browser.
//
// The .fig is read locally and never written anywhere; nothing derived from it is saved unless --json asks.
// How it loads: the store's import (src/store/import/fig.ts, in Node as the store's utility process does) →
// snapshot bytes → in the page, the editor's path: mergedDocument (kiwi decode, NodeTable, engine JSON) →
// engine.load; fonts from the system (src/main/fonts.ts's index, as the desktop app does); images answered
// from the import's blobs (createImageBitmap, as the editor does).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- Arguments --------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const wasmDir = opt("--wasm");
const profileOut = opt("--profile");
const jsonOut = opt("--json");
const pageArg = opt("--page");
const dumpDir = opt("--dump");
const inspect = opt("--inspect");  // JS run in the page after the first frames (\`engine\` in scope); its JSON is printed
const [cssW, cssH] = (opt("--size", "1440x900") ?? "").split("x").map(Number);
const dpr = Number(opt("--dpr", "2"));
const only = (opt("--only", "") ?? "").split(",").filter(Boolean);
const headed = flag("--headed");
const timeoutSec = Number(opt("--timeout", "180"));
const gpuLimitMB = Number(opt("--gpu-limit", "3072"));
const editor = flag("--editor");  // the real editor (?editor: panels, Layers, rulers) around the engine
const synthetic = flag("--synthetic");
const syntheticCount = synthetic && argv[0] && /^\d+$/.test(argv[0]) ? Number(argv.shift()) : 25000;
const figPath = synthetic ? null : (argv[0] ?? process.env.DESIGNER_BENCH_FIG);
if (!synthetic && !figPath) {
  console.error("engine-bench: pass a .fig (or set DESIGNER_BENCH_FIG), or --synthetic");
  process.exit(1);
}
if (figPath && !existsSync(figPath)) {
  console.error(`engine-bench: no file ${figPath} (pass a .fig, or --synthetic)`);
  process.exit(1);
}

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : []) {
    for (const sub of ["chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = path.join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---- The synthetic document --------------------------------------------------------------------

// A PNG (RGBA8, no filter) — enough for test images.
function png(w, h, pixel) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Screens of auto-layout cards (an image, two texts, a button instance), a header with icons, components on the
// side; every other card has a drop shadow, some screens fade (a layer). ~186 stored nodes + 120 derived per screen.
function syntheticMessage(target) {
  const S = 1;
  let local = 1;
  const guid = () => ({ sessionID: S, localID: local++ });
  const nodes = [];
  const pos = (i) => String.fromCharCode(0x21 + (Math.floor(i / 8836) % 94), 0x21 + (Math.floor(i / 94) % 94), 0x21 + (i % 94));
  const T = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const solid = (r, g, b, a = 1) => [{ type: "SOLID", color: { r, g, b, a }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  const F5 = Math.fround(245 / 255);
  const DOC = { sessionID: 0, localID: 0 }, PAGE = { sessionID: 0, localID: 1 }, INTERNAL = { sessionID: 0, localID: 2 };
  nodes.push({ guid: DOC, phase: "CREATED", type: "DOCUMENT", name: "Document", documentColorProfile: "SRGB" });
  nodes.push({ guid: PAGE, phase: "CREATED", type: "CANVAS", name: "Screens", parentIndex: { guid: DOC, position: "!" }, backgroundColor: { r: F5, g: F5, b: F5, a: 1 }, backgroundOpacity: 1, backgroundEnabled: true });
  nodes.push({ guid: INTERNAL, phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: DOC, position: "~" }, internalOnly: true, visible: false });
  const add = (n, parent, index) => {
    const g = n.guid ?? guid();
    nodes.push({ phase: "CREATED", visible: true, opacity: 1, ...n, guid: g, parentIndex: { guid: parent, position: pos(index) } });
    return g;
  };
  const text = (parent, index, x, y, chars, size, style, color) =>
    add(
      {
        type: "TEXT", name: chars, transform: T(x, y), size: { x: chars.length * size * 0.55, y: Math.round(size * 1.21) },
        textData: { characters: chars }, fontSize: size, fontName: { family: "Inter", style, postscript: "" }, textAutoResize: "WIDTH_AND_HEIGHT",
        fillPaints: solid(...color),
      },
      parent,
      index
    );
  // Images.
  const images = new Map();
  const hashes = [];
  const sizes = [256, 512, 512, 1024, 1024, 2048];
  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i];
    const bytes = png(n, n, (x, y) => [(x * 255) / n, (y * 255) / n, ((x ^ y) * (i + 3)) & 255]);
    const h = createHash("sha1").update(bytes).digest("hex");
    images.set(h, new Uint8Array(bytes));
    hashes.push(h);
  }
  const imagePaint = (k) => [
    { type: "IMAGE", opacity: 1, visible: true, blendMode: "NORMAL", image: { hash: Uint8Array.from(Buffer.from(hashes[k % hashes.length], "hex")) }, imageScaleMode: "FILL", scale: 1 },
  ];
  // Components: a button (frame, label, icon) and an avatar.
  let top = 0;
  const components = [];
  for (let c = 0; c < 12; c++) {
    const sym = add(
      {
        type: "SYMBOL", name: `Button ${c}`, transform: T(c * 200, -300), size: { x: 96, y: 32 }, fillPaints: solid(0.05 * c, 0.4, 0.9), cornerRadius: 8,
        rectangleTopLeftCornerRadius: 8, rectangleTopRightCornerRadius: 8, rectangleBottomLeftCornerRadius: 8, rectangleBottomRightCornerRadius: 8,
        stackMode: "HORIZONTAL", stackSpacing: 6, stackHorizontalPadding: 10, stackVerticalPadding: 8, stackPaddingRight: 10, stackPaddingBottom: 8,
        stackCounterAlignItems: "CENTER", stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", frameMaskDisabled: false,
      },
      PAGE,
      top++
    );
    add({ type: "ELLIPSE", name: "Icon", transform: T(10, 9), size: { x: 14, y: 14 }, fillPaints: solid(1, 1, 1) }, sym, 0);
    text(sym, 1, 30, 8, `Action ${c}`, 13, "Medium", [1, 1, 1]);
    add({ type: "STAR", name: "Badge", transform: T(80, 10), size: { x: 10, y: 10 }, fillPaints: solid(1, 0.8, 0.2), count: 5, starInnerScale: 0.4 }, sym, 2);
    components.push(sym);
  }
  // Screens.
  const perScreen = 186;
  const screens = Math.max(1, Math.round(target / perScreen));
  const cols = Math.max(1, Math.round(Math.sqrt(screens * 2)));
  for (let s = 0; s < screens; s++) {
    const sx = (s % cols) * 490, sy = Math.floor(s / cols) * 944;
    const fade = s % 7 === 3;
    const screen = add(
      { type: "FRAME", name: `Screen ${s}`, transform: T(sx, sy), size: { x: 390, y: 844 }, fillPaints: solid(1, 1, 1), frameMaskDisabled: false, opacity: fade ? 0.85 : 1 },
      PAGE,
      top++
    );
    const header = add({ type: "FRAME", name: "Header", transform: T(0, 0), size: { x: 390, y: 64 }, fillPaints: solid(0.1, 0.1, 0.12), frameMaskDisabled: false }, screen, 0);
    text(header, 0, 16, 20, `Screen ${s} title`, 20, "Bold", [1, 1, 1]);
    for (let k = 0; k < 3; k++)
      add({ type: k === 1 ? "REGULAR_POLYGON" : "STAR", name: `Icon ${k}`, transform: T(290 + k * 30, 22), size: { x: 20, y: 20 }, fillPaints: solid(0.9, 0.9, 0.9), count: k === 1 ? 6 : 5, starInnerScale: 0.45 }, header, 1 + k);
    for (let r = 0; r < 30; r++) {
      const y = 72 + r * 76;
      const shadow = r % 2 === 0;
      const card = add(
        {
          type: "FRAME", name: `Card ${r}`, transform: T(12, y), size: { x: 366, y: 72 }, fillPaints: solid(1, 1, 1), cornerRadius: 12,
          rectangleTopLeftCornerRadius: 12, rectangleTopRightCornerRadius: 12, rectangleBottomLeftCornerRadius: 12, rectangleBottomRightCornerRadius: 12,
          strokePaints: solid(0.88, 0.88, 0.9), strokeWeight: 1, strokeAlign: "INSIDE", frameMaskDisabled: false,
          stackMode: "HORIZONTAL", stackSpacing: 12, stackHorizontalPadding: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12,
          stackCounterAlignItems: "CENTER", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED",
          effects: shadow ? [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: false }] : [],
        },
        screen,
        1 + r
      );
      const img = (s + r) % 3 === 0;
      add({ type: "ROUNDED_RECTANGLE", name: "Thumb", transform: T(12, 12), size: { x: 48, y: 48 }, fillPaints: img ? imagePaint(Math.floor((s + r) / 3)) : solid(0.85, 0.9, 1), cornerRadius: 8, rectangleTopLeftCornerRadius: 8, rectangleTopRightCornerRadius: 8, rectangleBottomLeftCornerRadius: 8, rectangleBottomRightCornerRadius: 8 }, card, 0);
      const col = add(
        { type: "FRAME", name: "Text", transform: T(72, 16), size: { x: 180, y: 40 }, fillPaints: [], frameMaskDisabled: true, stackMode: "VERTICAL", stackSpacing: 4, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED", stackChildPrimaryGrow: 1 },
        card,
        1
      );
      text(col, 0, 0, 0, `Item ${s}.${r} with a longer title`, 14, "Semi Bold", [0.1, 0.1, 0.1]);
      text(col, 1, 0, 21, `Subtitle line for card ${r}`, 12, "Regular", [0.45, 0.45, 0.5]);
      add({ type: "INSTANCE", name: "Button", transform: T(264, 20), size: { x: 96, y: 32 }, symbolData: { symbolID: components[(s + r) % components.length] } }, card, 2);
    }
  }
  return { message: { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: nodes, blobs: [] }, images };
}

// ---- The page (served by Vite; drives the engine) -------------------------------------------------

function pageMain() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame((t) => r(t)));
  const stats = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
    return { n: v.length, median: q(0.5), p95: q(0.95), max: v[v.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length };
  };
  window.__bench = { ready: false };
  (async () => {
    const [{ Engine }, { fonts, BUNDLED_FACES }, { mergedDocument }, codec] = await Promise.all([
      import("@/engine/Engine.ts"),
      import("@/engine/fonts.ts"),
      import("@/store/documentSource.ts"),
      import("@/engine/codec.ts"),
    ]);
    const params = new URLSearchParams(location.search);
    // Editor mode: the real editor (?editor) around the engine — panels, Layers, rulers, the canvas controller —
    // driven by DOM events on its canvas.
    const editorMode = params.get("bench") === "editor";
    let W = Number(params.get("w")), H = Number(params.get("h"));
    const DPR = devicePixelRatio;
    // The system's fonts, as the desktop app indexes them (src/main/fonts.ts, through the bench server).
    const system = await (await fetch("/__bench/fonts.json")).json();
    const bundled = new Map(BUNDLED_FACES.map((f) => [f.id, f]));
    fonts.setSource({
      async list() {
        return [...BUNDLED_FACES, ...system.filter((f) => f.family.toLowerCase() !== "inter")];
      },
      async read(face) {
        if (bundled.has(face.id)) {
          const url = face.id === "bundled:inter" ? (await import("@/engine/fonts/InterVariable.ttf?url")).default : (await import("@/engine/fonts/InterVariable-Italic.ttf?url")).default;
          return new Uint8Array(await (await fetch(url)).arrayBuffer());
        }
        return new Uint8Array(await (await fetch(`/__bench/font?id=${encodeURIComponent(face.id)}`)).arrayBuffer());
      },
    });
    let canvas, engine;
    if (editorMode) {
      while (!window.__designerEditor || !window.__designerEditor.canvas) await sleep(50);
      engine = window.__designerEditor.engine;
      canvas = window.__designerEditor.canvas;
      canvas.setPointerCapture = () => {};  // synthetic pointers can't be captured
      const r = canvas.getBoundingClientRect();
      W = r.width;
      H = r.height;
    } else {
      canvas = document.getElementById("engine-canvas");
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      engine = await Engine.create(canvas, { sessionID: 1, theme: "DARK" });
      engine.setViewport(W, H, DPR, Math.round(W * DPR), Math.round(H * DPR));
    }
    const x = engine["x"], h = engine["h"];
    // Input: the engine's calls, or (editor mode) DOM events on the canvas, as a person's would arrive.
    const box = () => canvas.getBoundingClientRect();
    const input = {
      wheel(px, py, dx, dy, pinch) {
        if (!editorMode) return engine.wheel(px, py, dx, dy, 0, 0, pinch ? 1 : 0);
        const b = box();
        canvas.dispatchEvent(new WheelEvent("wheel", { clientX: b.left + px, clientY: b.top + py, deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey: !!pinch, bubbles: true, cancelable: true }));
      },
      pointer(type, px, py, buttons) {
        if (!editorMode) return engine.pointer(type, px, py, 0, buttons, 0, 0, 1, 0, performance.now());
        const b = box();
        const name = ["pointerdown", "pointermove", "pointerup"][type];
        canvas.dispatchEvent(new PointerEvent(name, { clientX: b.left + px, clientY: b.top + py, pointerId: 1, pointerType: "mouse", isPrimary: true, button: type === 1 ? -1 : 0, buttons, bubbles: true, cancelable: true }));
      },
    };
    const gl = canvas.getContext("webgl2");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const gpuInfo = { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "", timerQuery: !!timer };

    // Every render, timed: CPU (the call), GPU (a timer query around it), and when it ran.
    const renders = [];
    let recording = false;
    let syncEach = false;
    const pendingQueries = [];
    const origRender = x.render;
    const origTick = x.tick;
    const pixel = new Uint8Array(4);
    const sync = () => {
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    };
    let tickMs = 0;
    x.tick = (hh, t) => {
      const t0 = performance.now();
      const r = origTick(hh, t);
      tickMs = performance.now() - t0;
      return r;
    };
    x.render = (hh) => {
      let q = null;
      if (recording && timer) {
        q = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      }
      const t0 = performance.now();
      origRender(hh);
      const t1 = performance.now();
      if (q) gl.endQuery(timer.TIME_ELAPSED_EXT);
      let synced = NaN;
      if (recording && syncEach) {
        sync();
        synced = performance.now() - t0;
      }
      if (recording) {
        const rec = { at: t0, cpu: t1 - t0 + tickMs, render: t1 - t0, synced, gpu: NaN };
        renders.push(rec);
        if (q) pendingQueries.push([q, rec]);
      }
      tickMs = 0;
    };
    const collectQueries = async () => {
      for (let tries = 0; tries < 200 && pendingQueries.length; tries++) {
        while (pendingQueries.length) {
          const [q, rec] = pendingQueries[0];
          if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) rec.gpu = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(q);
          pendingQueries.shift();
        }
        if (pendingQueries.length) await sleep(5);
      }
      for (const [q] of pendingQueries.splice(0)) gl.deleteQuery(q);
    };
    const heap = () => x.module.HEAPU8.length;
    const settleFrames = async (n = 3) => {
      for (let i = 0; i < n; i++) await nextFrame();
    };

    // A scenario: `input(i)` once per animation frame for `steps` frames; the engine's own frame loop renders.
    let longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration);
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // no long-task timing here
    }
    async function scenario(name, steps, input, opts = {}) {
      await settleFrames(2);
      renders.length = 0;
      longTasks = [];
      const inputs = [];
      const frames = [];
      syncEach = !!opts.sync;
      recording = true;
      const t0 = performance.now();
      let last = await nextFrame();
      for (let i = 0; i < steps; i++) {
        const now = await nextFrame();
        frames.push(now - last);
        last = now;
        const a = performance.now();
        input(i);
        inputs.push(performance.now() - a);
      }
      await settleFrames(3);
      const elapsed = performance.now() - t0;
      recording = false;
      syncEach = false;
      await collectQueries();
      const intervals = [];
      for (let i = 1; i < renders.length; i++) intervals.push(renders[i].at - renders[i - 1].at);
      const s = engine.stats();
      return {
        name, steps, renders: renders.length, fps: (renders.length / elapsed) * 1000,
        cpu: stats(renders.map((r) => r.cpu)), gpu: stats(renders.map((r) => r.gpu)), synced: stats(renders.map((r) => r.synced)),
        input: stats(inputs), interval: stats(intervals), frame: stats(frames), longTasks: { n: longTasks.length, total: longTasks.reduce((a, b) => a + b, 0), max: Math.max(0, ...longTasks) },
        last: { shapes: s.shapes, drawCalls: s.drawCalls, glyphs: s.glyphs, paths: s.paths, layers: s.layers },
      };
    }

    const W2 = W / 2, H2 = H / 2;
    // Wheel deltas that move the view along x = A sin(ωi), y = A/2 sin(0.7ωi): it stays over the content.
    const pan = (i, A, w) => [A * (Math.sin(w * (i + 1)) - Math.sin(w * i)), (A / 2) * (Math.sin(0.7 * w * (i + 1)) - Math.sin(0.7 * w * i))];
    window.__bench = {
      ready: true,
      gpuInfo,
      async load(url, imagesUrl) {
        const out = {};
        let t = performance.now();
        const snapshot = new Uint8Array(await (await fetch(url)).arrayBuffer());
        out.fetchMs = performance.now() - t;
        engine.setImageSource(async (hash) => {
          const r = await fetch(`${imagesUrl}?hash=${hash}`);
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        });
        t = performance.now();
        const message = mergedDocument({ snapshot, journal: [], sessionID: 1 });
        out.decodeMs = performance.now() - t;
        t = performance.now();
        const bytes = codec.encodeMessage(message);
        out.encodeMs = performance.now() - t;
        out.jsonBytes = bytes.length;
        const heap0 = heap();
        t = performance.now();
        x.load(h, bytes);
        out.engineLoadMs = performance.now() - t;
        t = performance.now();
        engine.pump();
        out.eventsMs = performance.now() - t;
        out.heapAfterLoad = heap();
        out.heapBefore = heap0;
        // Node counts by type (stored), and per page.
        const types = {};
        const parent = new Map();
        const byId = new Map();
        for (const n of message.nodeChanges) {
          types[n.type] = (types[n.type] ?? 0) + 1;
          byId.set(n.guid, n);
          if (n.parentIndex) parent.set(n.guid, n.parentIndex.guid);
        }
        out.types = types;
        out.storedNodes = message.nodeChanges.length;
        out.engineNodes = engine.stats().nodes;
        let imageRefs = new Set();
        for (const n of message.nodeChanges)
          for (const p of [...(n.fillPaints ?? []), ...(n.strokePaints ?? [])]) if (p.type === "IMAGE" && p.image?.hash) imageRefs.add(p.image.hash.map((b) => b.toString(16).padStart(2, "0")).join(""));
        out.imageRefs = imageRefs.size;
        const pages = engine.pages();
        const pageOf = (id) => {
          let cur = id;
          for (let i = 0; i < 1000 && cur; i++) {
            const n = byId.get(cur);
            if (!n) return null;
            if (n.type === "CANVAS") return cur;
            cur = parent.get(cur);
          }
          return null;
        };
        const counts = new Map();
        for (const n of message.nodeChanges) {
          const p = pageOf(n.guid);
          if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
        }
        out.pages = pages.map((p) => ({ guid: p.guid, name: p.name, layers: (counts.get(p.guid) ?? 1) - 1 }));
        // Dense areas: the page's top-level layers by how many layers they hold.
        const desc = new Map();
        for (const n of message.nodeChanges) {
          let cur = parent.get(n.guid);
          let child = n.guid;
          for (let i = 0; i < 1000 && cur; i++) {
            const pn = byId.get(cur);
            if (!pn) break;
            if (pn.type === "CANVAS") {
              desc.set(child, (desc.get(child) ?? 0) + 1);
              break;
            }
            child = cur;
            cur = parent.get(cur);
          }
        }
        this._desc = desc;
        this._byId = byId;
        return out;
      },
      // Fonts and the first frames: until the fonts asked for have arrived and the images on screen are drawn.
      async firstFrame(page) {
        const out = {};
        if (page) engine.setCurrentPage(page);
        engine.command("ZOOM_TO_FIT");
        renders.length = 0;
        recording = true;
        syncEach = true;
        let t = performance.now();
        x.tick(h, t);
        x.render(h);
        out.firstFrameMs = renders[0]?.render;
        out.firstFrameSyncedMs = renders[0]?.synced;
        engine.pump();
        t = performance.now();
        await fonts.settled();
        out.fontsMs = performance.now() - t;
        t = performance.now();
        engine.pump();
        x.render(h);
        out.afterFontsFrameMs = renders[renders.length - 1]?.synced;
        await engine.imagesSettled();
        out.imagesMs = performance.now() - t;
        engine.pump();
        t = performance.now();
        x.render(h);
        out.afterImagesFrameMs = renders[renders.length - 1]?.synced;
        recording = false;
        syncEach = false;
        await collectQueries();
        out.heap = heap();
        const s = engine.stats();
        out.engineNodes = s.nodes;
        out.stats = s;
        return out;
      },
      // The densest top-level layer's centre (world).
      denseTarget(page) {
        let best = null;
        for (const [id, n] of this._desc) {
          const node = this._byId.get(id);
          if (!node || node.parentIndex?.guid !== page) continue;
          if (!best || n > best.n) best = { id, n };
        }
        if (!best) return null;
        const node = engine.readNode(best.id);
        const m = node.transform ?? { m02: 0, m12: 0 };
        return { id: best.id, layers: best.n, x: m.m02 + (node.size?.x ?? 0) / 2, y: m.m12 + Math.min((node.size?.y ?? 0) / 2, 600), w: node.size?.x, h: node.size?.y };
      },
      async run(names0, page) {
        let names = names0;
        const results = [];
        const want = (n) => !names.length || names.includes(n);
        if (names.length === 1 && names[0] === "pages") names = ["pages", "none"];
        const fit = () => {
          engine.command("ZOOM_TO_FIT");
          engine.pump();
        };
        fit();
        await settleFrames(4);
        if (names.includes("pages")) {
          // Every page at fit: a redraw each (what any change costs there).
          for (const pg of engine.pages()) {
            engine.setCurrentPage(pg.guid);
            fit();
            await settleFrames(3);
            const r = await scenario(`page "${pg.name}" (fit, redraw)`, 10, () => engine.renderNow(), { sync: true });
            r.page = pg.guid;
            results.push(r);
          }
          engine.setCurrentPage(page);
          fit();
        }
        if (want("rest")) {
          // A redraw with nothing changed (what a hover change or a blink costs today), synced each frame.
          results.push(await scenario("rest (fit, redraw)", 30, () => engine.renderNow(), { sync: true }));
        }
        if (want("slowPan")) {
          fit();
          results.push(await scenario("slow pan (fit, ~8 px/frame)", 90, (i) => input.wheel(W2, H2, ...pan(i, 200, 0.04))));
        }
        if (want("fastPan")) {
          fit();
          results.push(await scenario("fast pan (fit, ~120 px/frame)", 90, (i) => input.wheel(W2, H2, ...pan(i, W / 3, 0.25))));
        }
        if (want("zoom")) {
          fit();
          results.push(
            await scenario("wheel zoom in/out (pinch, fit → 8× → fit)", 120, (i) => input.wheel(W2 + 200 * Math.sin(i / 20), H2, 0, i < 60 ? -3.5 : 3.5, true))
          );
        }
        const target = this.denseTarget(page);
        const at100 = () => {
          engine.setCamera({ x: W2 - target.x, y: H2 - target.y, zoom: 1 });
          engine.pump();
        };
        if (want("dense") && target) {
          at100();
          results.push(await scenario("100% on the densest frame, pan", 60, (i) => input.wheel(W2, H2, ...pan(i, 300, 0.1))));
          at100();
          results.push(await scenario("100% on the densest frame, redraw", 20, () => engine.renderNow(), { sync: true }));
        }
        if (want("hover")) {
          fit();
          results.push(
            await scenario("hover across the page (fit)", 90, (i) => input.pointer(1, (W * (i + 0.5)) / 90, H2 + (H / 3) * Math.sin(i / 7), 0))
          );
          if (target) {
            at100();
            results.push(
              await scenario("hover at 100% (dense)", 90, (i) => input.pointer(1, (W * (i + 0.5)) / 90, H2 + (H / 3) * Math.sin(i / 7), 0))
            );
          }
        }
        if (want("select") || want("drag")) {
          if (target) at100();
          else fit();
          await settleFrames(2);
          // A layer near the centre: click it (selection), then drag it.
          let px = W2, py = H2;
          const hits = engine.hitTest(px, py);
          const selTimes = [];
          let selected = null;
          const off = engine.on("SELECTION_CHANGED", (e) => (selected = e.refs[0] ?? null));
          if (want("select")) {
            results.push(
              await scenario("click to select (alternating)", 20, (i) => {
                const a = performance.now();
                const xx = i % 2 ? px + 40 : px;
                input.pointer(0, xx, py, 1);
                input.pointer(2, xx, py, 0);
                selTimes.push(performance.now() - a);
              })
            );
            results[results.length - 1].hitsAtCentre = hits.length;
          }
          if (want("drag")) {
            input.pointer(0, px, py, 1);
            const r = await scenario("drag the layer under the centre", 60, (i) => input.pointer(1, px + 3 * i, py + 2 * Math.sin(i / 5) * 10, 1));
            input.pointer(2, px + 180, py, 0);
            r.dragged = selected;
            results.push(r);
            engine.pump();
            engine.undo();
          }
          off();
        }
        return results;
      },
      heap,
      engine,
      stats: () => engine.stats(),
      // Every node's geometry (real nodes; derived ones through their instances' children), for comparing builds.
      geometry() {
        const out = {};
        const msg = engine.encodeDocument();
        for (const n of msg.nodeChanges) out[n.guid] = [n.transform ? [n.transform.m00, n.transform.m01, n.transform.m02, n.transform.m10, n.transform.m11, n.transform.m12] : null, n.size ? [n.size.x, n.size.y] : null];
        let level = msg.nodeChanges.filter((n) => n.type === "INSTANCE").map((n) => n.guid);
        for (let depth = 0; depth < 32 && level.length; depth++) {
          const next = [];
          for (const n of engine.readNodes(level, { childIds: true })) {
            if (n.guid.startsWith("I")) out[n.guid] = [n.transform ? [n.transform.m00, n.transform.m01, n.transform.m02, n.transform.m10, n.transform.m11, n.transform.m12] : null, n.size ? [n.size.x, n.size.y] : null];
            for (const c of n.childIds ?? []) if (c.startsWith("I")) next.push(c);
          }
          level = next;
        }
        return out;
      },
      showPage(guid) {
        engine.setCurrentPage(guid);
        engine.command("ZOOM_TO_FIT");
        engine.pump();
        engine.renderNow();
        return engine.pages().map((p) => p.guid);
      },
    };
  })().catch((e) => {
    window.__bench = { ready: false, error: String(e?.stack ?? e) };
  });
}

// ---- Server, browser, report -------------------------------------------------------------------------

const t0 = performance.now();
const server = await createServer({
  configFile: editor ? path.join(repo, "vite.web.config.ts") : false,
  mode: "demo",
  root: editor ? path.join(repo, "src/renderer") : repo,
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.join(repo, "src/renderer/src") + "/" },
      ...(wasmDir ? [{ find: /^\.\/wasm\/engine\.mjs$/, replacement: path.join(path.resolve(wasmDir), "engine.mjs") }] : []),
    ],
  },
  server: { port: 5207, strictPort: false, fs: { allow: [repo, ...(wasmDir ? [path.resolve(wasmDir)] : [])] }, hmr: false, watch: null, headers: {} },
  appType: editor ? "spa" : "custom",
  logLevel: "error",
  ssr: { noExternal: ["electron"] },
  ...(editor ? {} : { optimizeDeps: { noDiscovery: true, include: [] } }),
  plugins: [
    {
      name: "engine-bench",
      enforce: "pre",
      // src/main/fonts.ts (the desktop's font index) runs here without Electron: app.getPath → a temp dir.
      resolveId: (id) => (id === "/__bench/page.js" ? "\0engine-bench-page" : id === "electron" ? "\0engine-bench-electron" : null),
      load: (id) =>
        id === "\0engine-bench-page"
          ? `(${pageMain.toString()})();`
          : id === "\0engine-bench-electron"
            ? `export const app = { getPath: () => ${JSON.stringify(path.join(tmpdir(), "designer-engine-bench"))} }; export default { app };`
            : null,
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://x");
          if (url.pathname === "/__bench/index.html") {
            const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#1e1e1e;overflow:hidden}canvas{display:block}</style></head><body><canvas id="engine-canvas"></canvas><script type="module" src="/__bench/page.js"></script></body></html>`;
            res.setHeader("content-type", "text/html");
            res.end(await s.transformIndexHtml(req.url, html));
            return;
          }
          if (url.pathname === "/__bench/doc.bin") {
            res.setHeader("content-type", "application/octet-stream");
            res.end(Buffer.from(doc.message));
            return;
          }
          if (url.pathname === "/__bench/image") {
            const bytes = doc.images.get(url.searchParams.get("hash") ?? "");
            if (!bytes) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.end(Buffer.from(bytes));
            return;
          }
          if (url.pathname === "/__bench/fonts.json") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify((await systemFonts()).faces));
            return;
          }
          if (url.pathname === "/__bench/font") {
            try {
              res.end(Buffer.from(await fontsModule.readFont(url.searchParams.get("id") ?? "")));
            } catch {
              res.statusCode = 404;
              res.end();
            }
            return;
          }
          next();
        });
      },
    },
  ],
});
await server.listen();
const base = server.resolvedUrls.local[0];
const fontsModule = await server.ssrLoadModule(path.join(repo, "src/main/fonts.ts"));
let fontIndexPromise = null;
const systemFonts = () => (fontIndexPromise ??= fontsModule.fontIndex());

// The document, through the store's import (or generated).
const report = { file: figPath ? path.basename(figPath) : `synthetic ${syntheticCount}`, wasm: wasmDir ?? "src/renderer/src/engine/wasm", viewport: { cssW, cssH, dpr } };
let doc;
{
  const t = performance.now();
  if (figPath) {
    const { prepareFigImport } = await server.ssrLoadModule(path.join(repo, "src/store/import/fig.ts"));
    const bytes = new Uint8Array(readFileSync(figPath));
    const t1 = performance.now();
    const prepared = prepareFigImport(bytes, { name: path.basename(figPath), sessionID: 1 });
    report.importMs = performance.now() - t1;
    report.figBytes = bytes.length;
    doc = { message: prepared.message, images: prepared.images };
  } else {
    const { encodeMessage } = await server.ssrLoadModule(path.join(repo, "src/shared/schema/codec.ts"));
    const { message, images } = syntheticMessage(syntheticCount);
    doc = { message: encodeMessage(message), images };
    report.generateMs = performance.now() - t;
  }
  let imageBytes = 0;
  for (const b of doc.images.values()) imageBytes += b.length;
  report.images = doc.images.size;
  report.imageBytes = imageBytes;
  report.snapshotBytes = doc.message.length;
}
void systemFonts();

// ---- Guards --------------------------------------------------------------------------------------

function freeMemoryPercent() {
  try {
    const out = execFileSync("memory_pressure", [], { encoding: "utf8", timeout: 10000 });
    const m = /free percentage:\s*(\d+)%/.exec(out);
    return m ? Number(m[1]) : 100;
  } catch {
    return 100;
  }
}
// The footprint (MB) of the GPU processes under `pid` (Chrome's browser process): `top` counts GPU memory.
function gpuFootprintMB(pid) {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const gpu = ps
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m) => m && Number(m[2]) === pid && m[3].includes("--type=gpu-process"))
      .map((m) => m[1]);
    let total = 0;
    for (const g of gpu) {
      const top = execFileSync("top", ["-l", "1", "-pid", g, "-stats", "pid,mem"], { encoding: "utf8", timeout: 10000 });
      const line = top.trim().split("\n").pop();
      const m = /(\d+(?:\.\d+)?)([KMG])\+?\s*$/.exec(line);
      if (m) total += Number(m[1]) * (m[2] === "G" ? 1024 : m[2] === "K" ? 1 / 1024 : 1);
    }
    return total;
  } catch {
    return 0;
  }
}
{
  const free = freeMemoryPercent();
  if (free < 25) {
    console.error(`engine-bench: only ${free}% of memory is free (need 25%): not starting`);
    await server.close();
    process.exit(2);
  }
}
let browserServer = null, browser = null, aborted = null;
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {
    // already gone
  }
  try {
    await browserServer?.close();
  } catch {
    browserServer?.process()?.kill("SIGKILL");
  }
  try {
    await server.close();
  } catch {
    // already closed
  }
};
const abort = async (why) => {
  if (aborted) return;
  aborted = why;
  console.error(`engine-bench: aborted — ${why}`);
  await cleanup();
  process.exit(3);
};
const hardTimeout = setTimeout(() => void abort(`over the ${timeoutSec} s time limit`), timeoutSec * 1000);
process.on("SIGINT", () => void abort("interrupted"));
browserServer = await chromium.launchServer({
  executablePath: chromiumPath(),
  headless: !headed,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--enable-precise-memory-info"],
});
const browserPid = browserServer.process()?.pid ?? 0;
let gpuPeakMB = 0;
const gpuWatch = setInterval(() => {
  const mb = gpuFootprintMB(browserPid);
  gpuPeakMB = Math.max(gpuPeakMB, mb);
  if (mb > gpuLimitMB) void abort(`Chrome's GPU process uses ${mb.toFixed(0)} MB (limit ${gpuLimitMB} MB)`);
}, 2000);
browser = await chromium.connect(browserServer.wsEndpoint());
const problems = [];
let engineWatch = null;
let engineGpuPeak = 0;
try {
const page = await browser.newPage({ viewport: { width: cssW, height: cssH }, deviceScaleFactor: dpr });
// The engine's own account of its GPU memory (textures, targets, buffers): half the limit at most.
engineWatch = setInterval(() => {
  page
    .evaluate(() => (window.__bench?.ready ? window.__bench.stats().gpuBytes : 0))
    .then((b) => {
      engineGpuPeak = Math.max(engineGpuPeak, b ?? 0);
      if ((b ?? 0) / 1048576 > gpuLimitMB / 2) void abort(`the engine holds ${((b ?? 0) / 1048576).toFixed(0)} MB on the GPU`);
    })
    .catch(() => {});
}, 1000);
page.on("console", (m) => {
  if ((m.type() === "error" || process.env.BENCH_LOG) && !/favicon|404/.test(m.text())) problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
if (editor) {
  await page.goto(`${base}?editor&doc=empty&bench=editor`);
  await page.waitForFunction(() => window.__designerEditor && window.__designerEditor.canvas, null, { timeout: 60000 }).catch(async (e) => {
    console.error(problems.join("\n"));
    throw e;
  });
  await page.addScriptTag({ type: "module", url: "/__bench/page.js" });
} else {
  await page.goto(`${base}__bench/index.html?w=${cssW}&h=${cssH}`);
}
await page.waitForFunction(() => window.__bench && (window.__bench.ready || window.__bench.error), null, { timeout: 120000 });
const bootError = await page.evaluate(() => window.__bench.error);
if (bootError) {
  console.error(bootError, problems.join("\n"));
  process.exit(1);
}
report.gpu = await page.evaluate(() => window.__bench.gpuInfo);
// CPU profiles (Chrome's sampling profiler): one over the load, one over the scenarios.
let cdp = null;
if (profileOut) {
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
}
report.profiles = {};
const profiled = async (name, fn) => {
  if (!cdp) return fn();
  await cdp.send("Profiler.start");
  const value = await fn();
  const { profile } = await cdp.send("Profiler.stop");
  writeFileSync(profileOut.replace(/(\.cpuprofile|\.json)?$/, `-${name}.cpuprofile`), JSON.stringify(profile));
  report.profiles[name] = summarize(profile);
  return value;
};
function summarize(profile) {
  // Self time by function, and inclusive time (each function once per sample).
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const self = new Map();
  const incl = new Map();
  const dt = profile.timeDeltas;
  const name = (n) => n.callFrame.functionName || "(anonymous)";
  for (let i = 0; i < profile.samples.length; i++) {
    const d = (dt[i + 1] ?? dt[i] ?? 0) / 1000;
    const leaf = byId.get(profile.samples[i]);
    self.set(name(leaf), (self.get(name(leaf)) ?? 0) + d);
    const seen = new Set();
    for (let id = leaf.id; id !== undefined; id = parentOf.get(id)) {
      const nm = name(byId.get(id));
      if (seen.has(nm)) continue;
      seen.add(nm);
      incl.set(nm, (incl.get(nm) ?? 0) + d);
    }
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ fn: k, ms: Math.round(v), pct: Math.round((v / total) * 1000) / 10 }));
  return { totalMs: Math.round(total), self: top(self, 30), inclusive: top(incl, 40) };
}

const pageChoice = (pages) => {
  if (pageArg !== null) {
    const p = /^\d+$/.test(pageArg) ? pages[Number(pageArg)] : pages.find((q) => q.name === pageArg || q.guid === pageArg);
    return p?.guid ?? null;
  }
  return [...pages].sort((a, b) => b.layers - a.layers)[0]?.guid ?? null;
};
let pageGuid = null;
report.gpuSteps = { start: gpuFootprintMB(browserPid) };
await profiled("load", async () => {
  report.load = await page.evaluate(() => window.__bench.load("/__bench/doc.bin", "/__bench/image"));
  report.gpuSteps.loaded = gpuFootprintMB(browserPid);
  pageGuid = pageChoice(report.load.pages);
  report.first = await page.evaluate((p) => window.__bench.firstFrame(p), pageGuid);
  report.gpuSteps.firstFrames = gpuFootprintMB(browserPid);
});
report.page = report.load.pages.find((p) => p.guid === pageGuid) ?? null;
report.dense = await page.evaluate((p) => window.__bench.denseTarget(p), pageGuid);
report.scenarios = await profiled("frames", () => page.evaluate(({ names, p }) => window.__bench.run(names, p), { names: only, p: pageGuid }));
if (inspect) {
  const out = await page.evaluate((code) => new Function("engine", `return (async () => { ${code} })()`)(window.__bench.engine), inspect);
  console.log(JSON.stringify(out, null, 1));
}
if (dumpDir) {
  // Pixels of every page at fit and every node's geometry, to compare two builds (scratch use only: this is
  // the document's content — never save it in the repository).
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dumpDir, { recursive: true });
  await page.evaluate(() => window.__bench.imagesSettled?.());
  writeFileSync(path.join(dumpDir, "geometry.json"), JSON.stringify(await page.evaluate(() => window.__bench.geometry())));
  const guids = report.load.pages.map((p) => p.guid);
  for (let i = 0; i < guids.length; i++) {
    await page.evaluate((g) => window.__bench.showPage(g), guids[i]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(150);
    await page.evaluate((g) => window.__bench.showPage(g), guids[i]);
    await page.screenshot({ path: path.join(dumpDir, `page-${String(i).padStart(2, "0")}.png`) });
  }
}
report.gpuSteps.end = gpuFootprintMB(browserPid);
report.heapEnd = await page.evaluate(() => window.__bench.heap());
report.gpuEnd = await page.evaluate(() => window.__bench.stats());
report.totalMs = performance.now() - t0;
report.problems = problems.slice(0, 20);
} finally {
  clearInterval(gpuWatch);
  if (engineWatch) clearInterval(engineWatch);
  clearTimeout(hardTimeout);
  if (!aborted) await cleanup();
}
report.gpuPeakMB = gpuPeakMB;
report.engineGpuPeakMB = engineGpuPeak / 1048576;

// ---- Print ----------------------------------------------------------------------------------------

const f1 = (v) => (v === undefined || v === null || Number.isNaN(v) ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const L = report.load;
console.log(`\nengine-bench — ${report.file}  (${report.gpu.renderer}; timer query ${report.gpu.timerQuery ? "yes" : "no"})`);
console.log(`viewport ${cssW}×${cssH} CSS @${dpr}x · wasm ${report.wasm}`);
console.log(`\nDocument: ${L.storedNodes} stored nodes, ${report.first.engineNodes} in the engine (instance sublayers included); ${report.images} images (${mb(report.imageBytes)}), ${L.imageRefs} referenced; ${L.pages.length} pages`);
console.log(`  by type: ${Object.entries(L.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`  measured page: "${report.page?.name}" (${report.page?.layers} stored layers); densest frame: ${report.dense ? `${report.dense.layers} layers, ${Math.round(report.dense.w)}×${Math.round(report.dense.h)}` : "—"}`);
console.log(`\nLoad`);
if (report.importMs !== undefined) console.log(`  .fig import (store, Node)     ${f1(report.importMs)} ms   (${mb(report.figBytes)} → ${mb(report.snapshotBytes)} snapshot)`);
console.log(`  decode snapshot (renderer)    ${f1(L.decodeMs)} ms`);
console.log(`  encode engine JSON            ${f1(L.encodeMs)} ms   (${mb(L.jsonBytes)})`);
console.log(`  engine_load (parse+derive)    ${f1(L.engineLoadMs)} ms`);
console.log(`  events after load             ${f1(L.eventsMs)} ms`);
console.log(`  first frame (fit)             ${f1(report.first.firstFrameMs)} ms CPU, ${f1(report.first.firstFrameSyncedMs)} ms to GPU done`);
console.log(`  fonts arrive                  ${f1(report.first.fontsMs)} ms; frame after ${f1(report.first.afterFontsFrameMs)} ms`);
console.log(`  images arrive                 ${f1(report.first.imagesMs)} ms; frame after ${f1(report.first.afterImagesFrameMs)} ms`);
console.log(`  wasm memory                   ${mb(L.heapBefore)} → ${mb(L.heapAfterLoad)} after load → ${mb(report.first.heap)} after first frames → ${mb(report.heapEnd)} at the end`);
console.log(`  GPU memory                    engine ${mb(report.gpuEnd?.gpuBytes ?? 0)} at the end (peak ${report.engineGpuPeakMB.toFixed(0)} MB, layer pool ${mb(report.gpuEnd?.layerPoolBytes ?? 0)}); Chrome's GPU process peak ${report.gpuPeakMB.toFixed(0)} MB (start ${report.gpuSteps?.start?.toFixed(0)}, loaded ${report.gpuSteps?.loaded?.toFixed(0)}, first frames ${report.gpuSteps?.firstFrames?.toFixed(0)}, end ${report.gpuSteps?.end?.toFixed(0)})`);
console.log(`\nFrames (ms; frame = animation-frame interval while it ran, CPU = tick + render call, GPU = timer query,`);
console.log(`        input = the input's own handling (editor mode: the DOM event and everything it ran), long = long tasks)`);
console.log(`  ${"scenario".padEnd(40)} ${"frame med".padStart(9)} ${"p95".padStart(6)}  ${"CPU med".padStart(7)} ${"p95".padStart(6)}  ${"GPU med".padStart(7)} ${"p95".padStart(6)}  ${"input med".padStart(9)} ${"p95".padStart(6)}  ${"long".padStart(5)}  draws`);
for (const s of report.scenarios) {
  const sy = s.synced ? ` (synced ${f1(s.synced.median)})` : "";
  console.log(
    `  ${s.name.padEnd(40)} ${f1(s.frame?.median).padStart(9)} ${f1(s.frame?.p95).padStart(6)}  ${f1(s.cpu?.median).padStart(7)} ${f1(s.cpu?.p95).padStart(6)}  ${f1(s.gpu?.median).padStart(7)} ${f1(s.gpu?.p95).padStart(6)}  ${f1(s.input?.median).padStart(9)} ${f1(s.input?.p95).padStart(6)}  ${f1(s.longTasks?.total).padStart(5)}  ${s.last.drawCalls} calls, ${s.last.shapes} inst, ${s.last.layers} layers${sy}`
  );
}
for (const [name, prof] of Object.entries(report.profiles)) {
  console.log(`\nCPU profile: ${name} (${prof.totalMs} ms sampled) — self time`);
  for (const r of prof.self.slice(0, 25)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
  console.log(`inclusive`);
  for (const r of prof.inclusive.slice(0, 35)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
}
if (problems.length) console.log(`\nconsole errors:\n  ${problems.slice(0, 10).join("\n  ")}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
