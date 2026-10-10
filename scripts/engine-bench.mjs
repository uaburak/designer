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
//   --only a,b          run only these scenarios (rest, slowPan, fastPan, zoom, dense, hover, select, drag, and the
//                       instance ones: instSelect, instDrag, altDrag, multiDrag; variantMain (a variant dragged in its
//                       set), flowDrag (live auto-layout reorder, nested), selectMany; menuState in --editor mode)
//   --open              the file-open path instead: the real EditorApp mounted (panels, Layers, fonts, images,
//                       thumbnail) on a DocumentSource over the imported snapshot; marks every step (see "Open")
//   --no-strict         --open without React.StrictMode (the app's main.tsx mounts under StrictMode, which in dev
//                       runs the mount effect twice: source.load() twice)
//   --no-prepare        --open through source.load() on the main thread instead of the source's load worker
//   --snapshot-out <f>  --open: save the engine's own snapshot (derived data included) once the editor writes it (~15 s)
//   --snapshot-in <f>   --open from that snapshot instead of the import's, as the next open of the file would
//   --headed            a visible window instead of headless (the GPU is used either way on macOS)
//   --gfx webgl|webgpu  the canvas's GPU backend (default: the app's choice, WebGPU where available); WebGPU has no
//                       synchronous readback, so its "synced" and timer-query GPU columns stay empty
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
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
// --open with a kiwi-reading engine: --snapshot-out saves the engine's own snapshot (derived data included, what the
// editor hands the store) once the editor writes it; --snapshot-in opens that file instead of the import's snapshot,
// as the next open of the file would (the first frame from stored glyphs and instance layout).
const snapshotOut = opt("--snapshot-out");
const snapshotIn = opt("--snapshot-in");
const [cssW, cssH] = (opt("--size", "1440x900") ?? "").split("x").map(Number);
const dpr = Number(opt("--dpr", "2"));
const only = (opt("--only", "") ?? "").split(",").filter(Boolean);
const headed = flag("--headed");
const gfxOpt = opt("--gfx");
const timeoutSec = Number(opt("--timeout", "180"));
const gpuLimitMB = Number(opt("--gpu-limit", "3072"));
const openMode = flag("--open");  // the file-open path: the real EditorApp mounted on the snapshot
const noStrict = flag("--no-strict");
const editor = flag("--editor") || openMode;  // the real editor (?editor: panels, Layers, rulers) around the engine
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
  // Component sets (the owner's files: sets of variants, each variant nested auto layout with a nested instance):
  // 4 sets of 24 variants (Size × State) above the buttons, and variant instances in every third card.
  const sets = [];
  const SIZES = ["Small", "Medium", "Large", "XL"], STATES = ["Default", "Hover", "Pressed", "Disabled", "Focus", "Loading"];
  for (let k = 0; k < 4; k++) {
    const sizeDef = guid(), stateDef = guid();
    const setH = 16 + SIZES.length * 72, setW = 16 + STATES.length * 256;
    const set = add(
      {
        type: "FRAME", name: `Chip ${k}`, transform: T(k * (setW + 120), -400 - setH), size: { x: setW, y: setH }, fillPaints: [], frameMaskDisabled: false,
        isStateGroup: true, strokePaints: solid(0.59, 0.28, 1), strokeWeight: 1, strokeAlign: "INSIDE", dashPattern: [10, 5],
        componentPropDefs: [
          { id: sizeDef, name: "Size", type: "VARIANT", sortPosition: "!", initialValue: { textValue: { characters: SIZES[0] } } },
          { id: stateDef, name: "State", type: "VARIANT", sortPosition: "#", initialValue: { textValue: { characters: STATES[0] } } },
        ],
        stateGroupPropertyValueOrders: [{ property: "Size", values: SIZES }, { property: "State", values: STATES }],
      },
      PAGE,
      top++
    );
    const variants = [];
    for (let a = 0; a < SIZES.length; a++)
      for (let b = 0; b < STATES.length; b++) {
        const v = add(
          {
            type: "SYMBOL", name: `Size=${SIZES[a]}, State=${STATES[b]}`, transform: T(16 + b * 256, 16 + a * 72), size: { x: 240, y: 56 },
            fillPaints: solid(0.95 - 0.05 * b, 0.95, 1), cornerRadius: 10, rectangleTopLeftCornerRadius: 10, rectangleTopRightCornerRadius: 10,
            rectangleBottomLeftCornerRadius: 10, rectangleBottomRightCornerRadius: 10, frameMaskDisabled: false,
            stackMode: "HORIZONTAL", stackSpacing: 8, stackHorizontalPadding: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12,
            stackCounterAlignItems: "CENTER", stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
            variantPropSpecs: [{ propDefId: sizeDef, value: SIZES[a] }, { propDefId: stateDef, value: STATES[b] }],
          },
          set,
          variants.length
        );
        add({ type: "ELLIPSE", name: "Icon", transform: T(12, 20), size: { x: 16, y: 16 }, fillPaints: solid(0.2 * a, 0.3, 0.1 * b) }, v, 0);
        const col = add(
          { type: "FRAME", name: "Label", transform: T(36, 12), size: { x: 92, y: 32 }, fillPaints: [], frameMaskDisabled: true, stackMode: "VERTICAL", stackSpacing: 2, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
          v,
          1
        );
        text(col, 0, 0, 0, `${SIZES[a]} chip`, 12, "Semi Bold", [0.1, 0.1, 0.1]);
        text(col, 1, 0, 17, STATES[b], 10, "Regular", [0.4, 0.4, 0.45]);
        add({ type: "INSTANCE", name: "Button", transform: T(136, 12), size: { x: 96, y: 32 }, symbolData: { symbolID: components[(a + b) % components.length] } }, v, 2);
        variants.push(v);
      }
    sets.push(variants);
  }
  // Screens. Every other one is a vertical auto-layout list (header and cards in flow, nested in the cards' own).
  const perScreen = 186;
  const screens = Math.max(1, Math.round(target / perScreen));
  const cols = Math.max(1, Math.round(Math.sqrt(screens * 2)));
  for (let s = 0; s < screens; s++) {
    const sx = (s % cols) * 490, sy = Math.floor(s / cols) * 944;
    const fade = s % 7 === 3;
    const flow = s % 2 === 1;
    const screen = add(
      {
        type: "FRAME", name: `Screen ${s}`, transform: T(sx, sy), size: { x: 390, y: 844 }, fillPaints: solid(1, 1, 1), frameMaskDisabled: false, opacity: fade ? 0.85 : 1,
        ...(flow ? { stackMode: "VERTICAL", stackSpacing: 8, stackCounterAlignItems: "CENTER", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" } : {}),
      },
      PAGE,
      top++
    );
    const header = add({ type: "FRAME", name: "Header", transform: T(0, 0), size: { x: 390, y: 64 }, fillPaints: solid(0.1, 0.1, 0.12), frameMaskDisabled: false }, screen, 0);
    text(header, 0, 16, 20, `Screen ${s} title`, 20, "Bold", [1, 1, 1]);
    for (let k = 0; k < 3; k++)
      add({ type: k === 1 ? "REGULAR_POLYGON" : "STAR", name: `Icon ${k}`, transform: T(290 + k * 30, 22), size: { x: 20, y: 20 }, fillPaints: solid(0.9, 0.9, 0.9), count: k === 1 ? 6 : 5, starInnerScale: 0.45 }, header, 1 + k);
    for (let r = 0; r < 30; r++) {
      const y = flow ? 72 + r * 80 : 72 + r * 76;
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
      if (r % 3 === 1) {
        const v = sets[(s + r) % sets.length][(s * 7 + r) % 24];
        add({ type: "INSTANCE", name: "Chip", transform: T(140, 8), size: { x: 214, y: 56 }, symbolData: { symbolID: v } }, card, 2);
      } else add({ type: "INSTANCE", name: "Button", transform: T(264, 20), size: { x: 96, y: 32 }, symbolData: { symbolID: components[(s + r) % components.length] } }, card, 2);
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
    const [{ Engine }, { fonts, BUNDLED_FACES }, { mergedDocument }, _codec, abi] = await Promise.all([
      import("@/engine/Engine.ts"),
      import("@/engine/fonts.ts"),
      import("@/store/documentSource.ts"),
      import("@/engine/codec.ts"),
      import("@/engine/abi.ts"),
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
          const url = (await import("@/engine/fonts/Inter-3.19.ttf?url")).default;
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
      // `mods`: the engine's modifier bits (abi MOD_*); editor mode turns them into the event's key flags.
      pointer(type, px, py, buttons, mods = 0) {
        if (!editorMode) return engine.pointer(type, px, py, 0, buttons, mods, 0, 1, 0, performance.now());
        const b = box();
        const name = ["pointerdown", "pointermove", "pointerup"][type];
        canvas.dispatchEvent(
          new PointerEvent(name, {
            clientX: b.left + px, clientY: b.top + py, pointerId: 1, pointerType: "mouse", isPrimary: true, button: type === 1 ? -1 : 0, buttons,
            shiftKey: !!(mods & abi.MOD_SHIFT), altKey: !!(mods & abi.MOD_ALT), metaKey: !!(mods & (abi.MOD_META | abi.MOD_PRIMARY)), bubbles: true, cancelable: true,
          })
        );
      },
    };
    // WebGL: timer queries and a readback for "synced"; WebGPU: neither (its readback is asynchronous).
    const gl = engine.gfx === "webgl2" ? canvas.getContext("webgl2") : null;
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    const timer = gl?.getExtension("EXT_disjoint_timer_query_webgl2");
    let gpuInfo;
    if (gl) {
      gpuInfo = { backend: "webgl2", renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : "", timerQuery: !!timer };
    } else {
      const info = x.module.engineGpuDevice?.adapterInfo ?? {};
      gpuInfo = { backend: "webgpu", renderer: `WebGPU ${info.vendor ?? ""} ${info.architecture ?? ""}`.trim(), vendor: info.vendor ?? "", timerQuery: false };
    }

    // Every render, timed: CPU (the call), GPU (a timer query around it), and when it ran.
    const renders = [];
    let recording = false;
    let syncEach = false;
    const pendingQueries = [];
    const origRender = x.render;
    const origTick = x.tick;
    const pixel = new Uint8Array(4);
    const sync = () => {
      if (!gl) return;
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
      if (recording && syncEach && gl) {
        sync();
        synced = performance.now() - t0;
      }
      if (recording) {
        const rec = { at: t0, cpu: t1 - t0 + tickMs, render: t1 - t0, synced, gpu: NaN, regions: NaN, draws: NaN };
        if (perFrameStats) {
          // What the frame drew: the content cache's regions (0 = composite only, 1 = one part or the whole page) and draws.
          const s = engine.stats();
          rec.regions = s.cachedRegions;
          rec.draws = s.drawCalls;
        }
        renders.push(rec);
        if (q) pendingQueries.push([q, rec]);
      }
      tickMs = 0;
    };
    let perFrameStats = false;
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
    // `opts.micro`: also time each input until after a microtask checkpoint — React flushes the panels' store updates
    // (useSyncExternalStore) in a microtask right after the DOM event, so `inputMicro` − `input` is the panels' synchronous
    // re-render work the input caused. `opts.frameStats`: the content cache's regions and draws per frame.
    async function scenario(name, steps, input, opts = {}) {
      await settleFrames(2);
      renders.length = 0;
      longTasks = [];
      const inputs = [];
      const micros = [];
      const frames = [];
      syncEach = !!opts.sync;
      perFrameStats = !!opts.frameStats;
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
        if (opts.micro) {
          await null;
          micros.push(performance.now() - a);
        }
      }
      await settleFrames(3);
      const elapsed = performance.now() - t0;
      recording = false;
      syncEach = false;
      perFrameStats = false;
      await collectQueries();
      const intervals = [];
      for (let i = 1; i < renders.length; i++) intervals.push(renders[i].at - renders[i - 1].at);
      const s = engine.stats();
      return {
        name, steps, renders: renders.length, fps: (renders.length / elapsed) * 1000,
        cpu: stats(renders.map((r) => r.cpu)), gpu: stats(renders.map((r) => r.gpu)), synced: stats(renders.map((r) => r.synced)),
        input: stats(inputs), inputMicro: opts.micro ? stats(micros) : null, interval: stats(intervals), frame: stats(frames),
        longTasks: { n: longTasks.length, total: longTasks.reduce((a, b) => a + b, 0), max: Math.max(0, ...longTasks) },
        regions: opts.frameStats ? stats(renders.map((r) => r.regions)) : null, draws: opts.frameStats ? stats(renders.map((r) => r.draws)) : null,
        last: { shapes: s.shapes, drawCalls: s.drawCalls, glyphs: s.glyphs, paths: s.paths, layers: s.layers },
      };
    }

    // ---- Instance scenarios (docs: what a drag or a click costs on instances, variants, nested instances) ----

    // The world transform of a node (derived ones included): its parents' transforms composed, up to the page.
    const mul = (a, b) => ({
      m00: a.m00 * b.m00 + a.m01 * b.m10, m01: a.m00 * b.m01 + a.m01 * b.m11, m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
      m10: a.m10 * b.m00 + a.m11 * b.m10, m11: a.m10 * b.m01 + a.m11 * b.m11, m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
    });
    const I = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    function worldOf(id) {
      let m = I;
      let n = engine.readNode(id);
      const first = n;
      for (let depth = 0; n && n.type !== "CANVAS" && n.type !== "DOCUMENT" && depth < 256; depth++) {
        m = mul(n.transform ?? I, m);
        n = n.parentIndex?.guid ? engine.readNode(n.parentIndex.guid) : null;
      }
      const w = first?.size?.x ?? 0, h = first?.size?.y ?? 0;
      const c = { x: m.m00 * (w / 2) + m.m01 * (h / 2) + m.m02, y: m.m10 * (w / 2) + m.m11 * (h / 2) + m.m12 };
      return { m, w, h, cx: c.x, cy: c.y };
    }
    // The camera that puts world point (x, y) at the canvas centre.
    const centreOn = async (x, y, zoom = 1) => {
      engine.setCamera({ x: W2 - x * zoom, y: H2 - y * zoom, zoom });
      engine.pump();
      await settleFrames(2);
    };
    const screenOf = (x, y) => {
      const c = engine.getCamera();
      return [x * c.zoom + c.x, y * c.zoom + c.y];
    };
    // The drawn subtree of a node, read through the engine (derived rows included), up to `max` nodes.
    function subtree(id, max = 20000) {
      const out = [];
      let level = [id];
      while (level.length && out.length < max) {
        const next = [];
        for (const n of engine.readNodes(level, { childIds: true })) {
          out.push(n);
          for (const c of n.childIds ?? []) next.push(c);
        }
        level = next;
      }
      return out;
    }
    const describe = (id) => {
      const sub = subtree(id, 5000);
      const effects = sub.filter((k) => (k.effects ?? []).some((e) => e.visible !== false)).length;
      const texts = sub.filter((k) => k.type === "TEXT").length;
      return { subtree: sub.length, effects, texts };
    };
    // Targets on `page`, chosen from the stored document: a plain shape, instances (free and in an auto-layout
    // parent), variant instances of the largest component sets (free and in auto layout), a nested instance in one,
    // and twenty instances. Only ids, types and counts are reported — never names or text.
    function findTargets(page) {
      const byId = this._byId;
      const parentOf = (n) => (n?.parentIndex ? byId.get(n.parentIndex.guid) : undefined);
      const pageOf = (id) => {
        let cur = byId.get(id);
        for (let i = 0; cur && i < 1000; i++) {
          if (cur.type === "CANVAS") return cur.guid;
          cur = parentOf(cur);
        }
        return null;
      };
      const isAuto = (p) => !!p && !!p.stackMode && p.stackMode !== "NONE";
      const area = (n) => (n.size?.x ?? 0) * (n.size?.y ?? 0);
      const children = new Map();
      for (const n of byId.values()) {
        const p = n.parentIndex?.guid;
        if (!p) continue;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(n.guid);
      }
      const descCount = new Map();
      const countDesc = (id) => {
        if (descCount.has(id)) return descCount.get(id);
        let n = 0;
        for (const c of children.get(id) ?? []) n += 1 + countDesc(c);
        descCount.set(id, n);
        return n;
      };
      const onPage = [...byId.values()].filter((n) => n.visible !== false && n.locked !== true && pageOf(n.guid) === page);
      const visibleChain = (n) => {
        for (let cur = parentOf(n); cur && cur.type !== "CANVAS"; cur = parentOf(cur)) if (cur.visible === false) return false;
        return true;
      };
      // Ancestors below the page: 1 = on the page itself, 2 = in a top-level frame. One click selects depth ≤ 2 (the
      // engine picks a top-level frame's child, as Figma); deeper layers need the parents opened first.
      const depth = (n) => {
        let d = 0;
        for (let cur = n; cur && cur.type !== "CANVAS"; cur = parentOf(cur)) d++;
        return d;
      };
      const clickable = (n) => depth(n) <= 2 && !(depth(n) === 2 && parentOf(n)?.type === "INSTANCE");
      const shapes = onPage
        .filter((n) => ["RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE"].includes(n.type) && !isAuto(parentOf(n)) && area(n) >= 400 && area(n) <= 400000 && visibleChain(n))
        .sort((a, b) => Number(clickable(b)) - Number(clickable(a)) || area(b) - area(a));
      const instances = onPage.filter((n) => n.type === "INSTANCE" && n.symbolData?.symbolID && byId.has(n.symbolData.symbolID) && visibleChain(n));
      const setOf = (sym) => {
        const p = parentOf(sym);
        return p && p.isStateGroup ? p : null;
      };
      const info = (n) => {
        const sym = byId.get(n.symbolData.symbolID);
        const set = setOf(sym);
        return { sym, set, variants: set ? (children.get(set.guid) ?? []).length : 0, mainSize: countDesc(sym.guid), auto: isAuto(parentOf(n)) };
      };
      const plain = instances.filter((n) => !info(n).set);
      const variants = instances.filter((n) => info(n).set);
      // One-click-selectable candidates first, then by the main's size (or the set's variants × size).
      const bySize = (list) => [...list].sort((a, b) => Number(clickable(b)) - Number(clickable(a)) || info(b).mainSize - info(a).mainSize);
      const byVariants = (list) =>
        [...list].sort((a, b) => Number(clickable(b)) - Number(clickable(a)) || info(b).variants * (1 + info(b).mainSize) - info(a).variants * (1 + info(a).mainSize));
      // Among the clickable ones, middle-of-the-pack sizes for the plain instances (the biggest is a whole screen).
      const pickMid = (list) => {
        const c = list.filter(clickable);
        const pool = c.length >= 4 ? c : list;
        return pool.length > 6 ? pool.slice(Math.floor(pool.length * 0.2), Math.floor(pool.length * 0.2) + 2) : pool.slice(0, 2);
      };
      const t = {
        shape: shapes.slice(0, 2).map((n) => n.guid),
        instanceFree: pickMid(bySize(plain.filter((n) => !info(n).auto))).map((n) => n.guid),
        instanceAuto: pickMid(bySize(plain.filter((n) => info(n).auto))).map((n) => n.guid),
        variantFree: byVariants(variants.filter((n) => !info(n).auto)).slice(0, 2).map((n) => n.guid),
        variantAuto: byVariants(variants.filter((n) => info(n).auto)).slice(0, 2).map((n) => n.guid),
        nested: [],
        many: [],
      };
      // A variant (SYMBOL) in the set with the most variants, in its middle (the one with the most instances first),
      // and layers in auto-layout flows: a card in a vertical list (mid-list, in view at 100 %) and the first layer of
      // a card in such a list (nested auto layout), for the live reorder.
      const instCount = new Map();
      for (const n of instances) instCount.set(n.symbolData.symbolID, (instCount.get(n.symbolData.symbolID) ?? 0) + 1);
      const mains = onPage.filter((n) => n.type === "SYMBOL" && parentOf(n)?.isStateGroup === true);
      mains.sort((a, b) => (children.get(parentOf(b).guid) ?? []).length - (children.get(parentOf(a).guid) ?? []).length || (instCount.get(b.guid) ?? 0) - (instCount.get(a.guid) ?? 0));
      t.variantMain = mains.slice(0, 1).map((n) => n.guid);
      const flowKids = (pred) =>
        onPage.filter((n) => {
          const p = parentOf(n);
          return isAuto(p) && n.stackPositioning !== "ABSOLUTE" && pred(n, p) && (children.get(p.guid) ?? []).length >= 3;
        });
      const listCards = flowKids((n, p) => p.stackMode === "VERTICAL" && parentOf(p)?.type === "CANVAS" && n.type === "FRAME");
      // The fourth child of its list (index 3): three cards above, in view under the list's top at 100 %.
      const fourth = listCards.filter((n) => (children.get(n.parentIndex.guid) ?? []).indexOf(n.guid) === 3);
      t.flowCard = (fourth.length ? fourth : listCards).slice(0, 1).map((n) => n.guid);
      const inCard = flowKids((n, p) => p.stackMode === "HORIZONTAL" && isAuto(parentOf(p)) && (children.get(p.guid) ?? [])[0] === n.guid);
      t.flowNested = inCard.slice(0, 1).map((n) => n.guid);
      // Many layers: every card of the page's lists, up to 600.
      t.manyLayers = listCards.slice(0, 600).map((n) => n.guid);
      // A nested instance inside the first variant instance (or the first instance): a derived INSTANCE row.
      const host = t.variantFree[0] ?? t.variantAuto[0] ?? t.instanceFree[0] ?? t.instanceAuto[0];
      if (host) {
        const rows = subtree(host, 5000).slice(1).filter((n) => n.type === "INSTANCE" && n.guid.startsWith("I"));
        rows.sort((a, b) => (b.childIds?.length ?? 0) - (a.childIds?.length ?? 0));
        t.nested = rows.slice(0, 2).map((n) => n.guid);
        t.nestedHost = host;
      }
      // Twenty instances: siblings of the first free instance where it has them, the rest by size.
      const sib = t.instanceFree[0] ? instances.filter((n) => n.parentIndex?.guid === byId.get(t.instanceFree[0]).parentIndex?.guid) : [];
      const many = [...sib];
      for (const n of bySize(instances)) if (many.length < 20 && !many.includes(n)) many.push(n);
      t.many = many.slice(0, 20).map((n) => n.guid);
      const about = (id) => {
        const n = byId.get(id) ?? engine.readNode(id);
        if (!n) return null;
        const p = parentOf(n) ?? (n.parentIndex ? engine.readNode(n.parentIndex.guid) : null);
        const d = describe(id);
        const base = { id, type: n.type, size: [Math.round(n.size?.x ?? 0), Math.round(n.size?.y ?? 0)], parentType: p?.type, parentAuto: isAuto(p), depth: byId.has(id) ? depth(n) : -1, ...d };
        if (n.type === "INSTANCE" && n.symbolData?.symbolID && byId.has(n.symbolData.symbolID)) {
          const i = info(n);
          return { ...base, mainSize: i.mainSize, variants: i.variants };
        }
        return base;
      };
      const out = {};
      for (const [k, v] of Object.entries(t)) out[k] = k === "manyLayers" ? v.map((id) => ({ id })) : Array.isArray(v) ? v.map(about).filter(Boolean) : v;
      out.page = { layers: onPage.length, instances: instances.length, instancesFree: instances.filter((n) => !info(n).auto).length, variantInstances: variants.length, clickableInstances: instances.filter(clickable).length };
      return out;
    }

    // Figma's pick: a click selects a top-level frame's child; deeper layers need their parent selected first. So a
    // target deeper than that is reached in two steps — its parent selected through the API, then the click.
    const parentOfRef = (id) => engine.readNode(id)?.parentIndex?.guid ?? null;
    const oneClick = (id) => {
      const p = parentOfRef(id);
      const pp = p ? parentOfRef(p) : null;
      const pn = p ? engine.readNode(p) : null;
      return !p || pn?.type === "CANVAS" || (pp && engine.readNode(pp)?.type === "CANVAS" && pn?.type !== "INSTANCE");
    };

    // Click-select. Targets a click reaches (on the page, or in a top-level frame): clicks alternate between A and B,
    // both in view. Deeper targets (inside nested frames, as most instances are): the parent is selected through the
    // API on the even steps and the click on A follows on the odd ones — every step is a selection change, and the
    // odd steps select the target itself. `mods` is held on the clicks; what each click selected is counted.
    async function clickScenario(name, ids, mods = 0) {
      const a = worldOf(ids[0]);
      const direct = oneClick(ids[0]) || mods !== 0;
      const b = direct && ids[1] ? worldOf(ids[1]) : null;
      let zoom = 1;
      if (b) {
        const dx = Math.abs(a.cx - b.cx) + (a.w + b.w) / 2, dy = Math.abs(a.cy - b.cy) + (a.h + b.h) / 2;
        zoom = Math.min(1, 0.8 * Math.min(W / Math.max(dx, 1), H / Math.max(dy, 1)));
      }
      await centreOn(b ? (a.cx + b.cx) / 2 : a.cx, b ? (a.cy + b.cy) / 2 : a.cy, zoom);
      engine.setSelection([]);
      engine.pump();
      await settleFrames(2);
      const parent = direct ? null : parentOfRef(ids[0]);
      const hits = { A: 0, B: 0, other: 0, none: 0, parent: 0 };
      let selected = [];
      const off = engine.on("SELECTION_CHANGED", (e) => (selected = e.refs));
      const r = await scenario(
        name, 20,
        (i) => {
          if (!direct) {
            if (i % 2 === 0) {
              engine.setSelection([parent]);
              if (selected.includes(parent)) hits.parent++;
              return;
            }
            const [px, py] = screenOf(a.cx, a.cy);
            input.pointer(0, px, py, 1, mods);
            input.pointer(2, px, py, 0, mods);
            if (!selected.length) hits.none++;
            else if (selected.includes(ids[0])) hits.A++;
            else hits.other++;
            return;
          }
          const t = i % 2 === 0 || !b ? a : b;
          const [px, py] = screenOf(t.cx, t.cy);
          if (i % 2 === 1 && !b) {
            engine.setSelection([]);  // no second target: deselect through the API
          } else {
            input.pointer(0, px, py, 1, mods);
            input.pointer(2, px, py, 0, mods);
          }
          const want = i % 2 === 0 || !b ? ids[0] : ids[1];
          if (!selected.length) hits.none++;
          else if (selected.includes(want)) hits[i % 2 === 0 || !b ? "A" : "B"]++;
          else hits.other++;
        },
        { micro: true, frameStats: true }
      );
      off();
      r.hits = hits;
      r.direct = direct;
      r.lastSelected = selected.slice(0, 3);
      r.targets = ids;
      engine.setSelection([]);
      engine.pump();
      return r;
    }

    // Drag: the pointer pressed on the first target (at 100%), moved 60 frames with `mods` held (⌥ duplicates),
    // released; then undone. In the editor the whole chrome follows (the panels re-read, Layers).
    // One target: its parent is selected first (nothing for a top-level one), so the press selects the target and
    // drags it — the engine picks the child of the deepest selected ancestor, and a press on a child of an already
    // selected layer selects that child instead (Figma keeps the selection on mouse-down and drills in on a click;
    // here a selected instance covered by its children can't be dragged by the pointer at all — see the no-op rows).
    // Several targets (or a derived one): they are selected and the first one pressed, as a user would.
    async function dragScenario(name, ids, mods = 0, opts = {}) {
      const t = worldOf(ids[0]);
      await centreOn(t.cx, t.cy, 1);
      const single = ids.length === 1 && !ids[0].startsWith("I");
      const parent = single ? parentOfRef(ids[0]) : null;
      const parentIsPage = parent ? engine.readNode(parent)?.type === "CANVAS" : true;
      // `opts.select`: the selection before the press instead (a variant: nothing, so the press picks the set's child).
      engine.setSelection(opts.select ?? (single ? (parentIsPage ? [] : [parent]) : ids));
      engine.pump();
      await settleFrames(3);
      const counts = {};
      const offAny = engine.onAny((e) => (counts[e.type] = (counts[e.type] ?? 0) + 1));
      // A press point of its own: the centre, else near a corner or an edge, where nothing under the pointer is a
      // child of it (the hit path then holds only it and its ancestors).
      let [px, py] = [W2, H2];
      let pressHit = null;
      {
        const chain = new Set([ids[0]]);
        for (let p = parentOfRef(ids[0]); p; p = parentOfRef(p)) chain.add(p);
        const hw = t.w / 2, hh = t.h / 2, in3 = 3;
        const candidates = [[0, 0], [-hw + in3, -hh + in3], [hw - in3, -hh + in3], [-hw + in3, hh - in3], [hw - in3, hh - in3], [0, -hh + in3], [0, hh - in3], [-hw + in3, 0], [hw - in3, 0], [-hw + 12, -hh + 6], [hw - 12, hh - 6]];
        for (const [dx, dy] of candidates) {
          const x = W2 + dx, y = H2 + dy;
          if (x < 2 || y < 2 || x > W - 2 || y > H - 2) continue;
          const hit = engine.hitTest(x, y);
          if (hit.includes(ids[0]) && hit.every((h) => chain.has(h))) {
            [px, py] = [x, y];
            pressHit = hit;
            break;
          }
        }
        pressHit ??= engine.hitTest(px, py);
      }
      let selected = null;
      const off = engine.on("SELECTION_CHANGED", (e) => (selected = e.refs));
      input.pointer(0, px, py, 1, mods);
      // `opts.path(i)`: the pointer's offset at step i (default: right 3 px a frame, wobbling ±20 px).
      const at = opts.path ?? ((i) => [3 * (i + 1), 20 * Math.sin(i / 5)]);
      const steps = opts.steps ?? 60;
      const r = await scenario(name, steps, (i) => input.pointer(1, px + at(i)[0], py + at(i)[1], 1, mods), { micro: true, frameStats: true });
      const end = at(steps - 1);
      input.pointer(2, px + end[0], py + end[1], 0, mods);
      engine.pump();
      await settleFrames(2);
      off();
      offAny();
      const movedId = selected?.[0] ?? ids[0];
      const after = worldOf(movedId);
      r.moved = selected ? selected.slice(0, 3) : ids.slice(0, 3);
      r.movedTarget = movedId === ids[0] || (mods & abi.MOD_ALT ? true : false);
      r.movedBy = [Math.round(after.m.m02 - t.m.m02), Math.round(after.m.m12 - t.m.m12)];
      r.pressOffset = [Math.round(px - W2), Math.round(py - H2)];
      r.pressHit = pressHit.length;
      r.locked = engine.readNode(ids[0])?.locked === true;
      r.events = counts;
      r.targets = ids;
      engine.undo();
      engine.pump();
      engine.setSelection([]);
      engine.pump();
      await settleFrames(2);
      return r;
    }

    // The desktop's per-frame work the browser bench can't see otherwise: menuState(ed) runs every registry command's
    // enabled() after each NODES_CHANGED (desktop.ts), then the menu patch goes to main over IPC.
    async function menuStateScenario() {
      if (!editorMode || !window.__designerEditor) return null;
      const { menuState } = await import("@/editor/desktop.ts");
      const ed = window.__designerEditor;
      const times = [];
      for (let i = 0; i < 20; i++) {
        const a = performance.now();
        menuState(ed);
        times.push(performance.now() - a);
      }
      return { name: "menuState(ed) ×20 (desktop only)", ms: stats(times), commands: Object.keys(menuState(ed).enabled).length };
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
        // The engine reads documents as kiwi only: the store's snapshot bytes go in as they are (the app's path).
        const bytes = snapshot;
        out.encodeMs = 0;
        out.kiwiBytes = bytes.length;
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
      // The instance scenarios, one group per call (so Node can profile each): targets found once per page.
      targets(page) {
        this._targets ??= {};
        return (this._targets[page] ??= findTargets.call(this, page));
      },
      async runOne(kind, page) {
        const t = this.targets(page);
        const ids = (k) => (t[k] ?? []).map((x) => x.id);
        const out = [];
        const sel = async (label, k, mods = 0) => {
          const list = ids(k);
          if (list.length) out.push(await clickScenario(`click ${label}`, list, mods));
        };
        const drag = async (label, list, mods = 0) => {
          if (list.length) out.push(await dragScenario(`drag ${label}`, list, mods));
        };
        switch (kind) {
          case "instSelect":
            await sel("plain shape", "shape");
            await sel("instance (free)", "instanceFree");
            await sel("instance (auto layout)", "instanceAuto");
            await sel("variant instance (free)", "variantFree");
            await sel("variant instance (auto)", "variantAuto");
            await sel("nested instance (⌘-click)", "nested", abi.MOD_PRIMARY);
            break;
          case "instDrag":
            await drag("plain shape", ids("shape").slice(0, 1));
            await drag("instance (free)", ids("instanceFree").slice(0, 1));
            await drag("instance (auto layout)", ids("instanceAuto").slice(0, 1));
            await drag("variant instance (free)", ids("variantFree").slice(0, 1));
            await drag("variant instance (auto)", ids("variantAuto").slice(0, 1));
            await drag("nested instance (selected)", ids("nested").slice(0, 1));
            break;
          case "altDrag":
            await drag("⌥-drag instance (free)", ids("instanceFree").slice(0, 1), abi.MOD_ALT);
            await drag("⌥-drag variant instance", (ids("variantFree").length ? ids("variantFree") : ids("variantAuto")).slice(0, 1), abi.MOD_ALT);
            break;
          case "multiDrag":
            await drag(`${ids("many").length} instances`, ids("many"));
            break;
          case "variantMain":
            // A variant moved inside its component set (its set selected first, as a click into the set does).
            // Nothing selected first: the press picks the variant (a top-level frame's child), as a click does. Then the
            // set itself (selected, pressed on the same variant).
            if (ids("variantMain").length) {
              const v = ids("variantMain")[0];
              out.push(await dragScenario("drag a variant in its set", [v], 0, { select: [] }));
              out.push(await dragScenario("drag the component set", [v], 0, { select: [parentOfRef(v)] }));
            }
            break;
          case "flowDrag":
            // The live reorder, each layer selected first (a press on a child of a selected layer drags that one): a card
            // down its vertical list (~4 swaps), a card's first layer across the card (nested auto layout).
            if (ids("flowCard").length) out.push(await dragScenario("flow: card down its list", ids("flowCard").slice(0, 1), 0, { steps: 90, path: (i) => [2 * Math.sin(i / 9), 3.5 * (i + 1)], select: ids("flowCard").slice(0, 1) }));
            if (ids("flowNested").length) out.push(await dragScenario("flow: nested, across a card", ids("flowNested").slice(0, 1), 0, { steps: 60, path: (i) => [4 * (i + 1), Math.sin(i / 7)], select: ids("flowNested").slice(0, 1) }));
            break;
          case "selectMany": {
            // Selection of many layers: every card of the page's lists selected and cleared, alternating; then ⌘A.
            const many = ids("manyLayers");
            if (many.length) {
              engine.command("ZOOM_TO_FIT");
              engine.pump();
              await settleFrames(3);
              const r = await scenario(`select ${many.length} layers / none`, 20, (i) => (engine.setSelection(i % 2 ? [] : many), engine.pump()), { micro: true, frameStats: true });
              out.push(r);
              const r2 = await scenario("select all (⌘A) / none", 10, (i) => (i % 2 ? engine.setSelection([]) : engine.command("SELECT_ALL"), engine.pump()), { micro: true, frameStats: true });
              out.push(r2);
              engine.setSelection([]);
              engine.pump();
            }
            break;
          }
          case "menuState": {
            const m = await menuStateScenario();
            if (m) out.push(m);
            break;
          }
        }
        return out;
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

// ---- The open page: the real EditorApp mounted on the snapshot, every step marked -----------------------------------

// Runs as an inline module in /__bench/open.html (editor server mode: `@/` and bare imports resolve). It mounts
// EditorApp exactly as EditorRoute does (StrictMode unless ?strict=0) on a DocumentSource whose load() is the app's
// own mergedDocument over the imported snapshot, images from the bench server, and records: modules loaded, snapshot
// fetched, mergedDocument (per call — StrictMode calls it twice), Engine.create, engine.load (+ the JSON encode on its
// own), onReady (the chrome's first commit), the chrome painted, Layers rows and the Design panel in the DOM, the
// first canvas frame, fonts settled (+ the relayout frame), images settled (+ frame), the thumbnail written, long
// tasks throughout.
function openPageMain() {
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
  const marks = { t0: now(), long: [] };
  window.__open = { done: false, marks };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) marks.long.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // no long-task timing
  }
  const mo = new MutationObserver(() => {
    if (!marks.layersDom && document.querySelector('[data-ds="LayerRow"]')) marks.layersDom = now();
    if (!marks.designDom && document.querySelector("[data-open-variables], [data-instance-header], [data-component-header]")) marks.designDom = now();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  (async () => {
    const params = new URLSearchParams(location.search);
    const strict = params.get("strict") !== "0";
    const pageGuid = params.get("page") || null;
    const [{ Engine }, { fonts, BUNDLED_FACES }, { mergedDocument, prepareDocument }, codec, React, { createRoot }, { EditorApp }] = await Promise.all([
      import("@/engine/Engine.ts"),
      import("@/engine/fonts.ts"),
      import("@/store/documentSource.ts"),
      import("@/engine/codec.ts"),
      import("react"),
      import("react-dom/client"),
      import("@/editor/EditorApp.tsx"),
    ]);
    // ?prepare=0: the editor's older path (source.load() on the main thread) instead of the source's worker.
    const usePrepare = params.get("prepare") !== "0" && typeof prepareDocument === "function";
    marks.modules = now();
    const system = await (await fetch("/__bench/fonts.json")).json();
    marks.fontIndex = now();
    const bundled = new Map(BUNDLED_FACES.map((f) => [f.id, f]));
    // Every font the editor or the engine asks for, and when (the ones after engine_load cause a relayout).
    marks.fontRequests = [];
    const req0 = fonts.request.bind(fonts);
    fonts.request = (family, style) => {
      marks.fontRequests.push({ at: Math.round(now() - marks.t0), family: String(family).slice(0, 24), style: String(style).slice(0, 16) });
      return req0(family, style);
    };
    fonts.setSource({
      async list() {
        return [...BUNDLED_FACES, ...system.filter((f) => f.family.toLowerCase() !== "inter")];
      },
      async read(face) {
        if (bundled.has(face.id)) {
          const url = (await import("@/engine/fonts/Inter-3.19.ttf?url")).default;
          return new Uint8Array(await (await fetch(url)).arrayBuffer());
        }
        return new Uint8Array(await (await fetch(`/__bench/font?id=${encodeURIComponent(face.id)}`)).arrayBuffer());
      },
    });
    const docResponse = await fetch("/__bench/doc.bin");
    const snapshot = new Uint8Array(await docResponse.arrayBuffer());
    marks.fetched = now();
    marks.snapshotBytes = snapshot.length;
    // The snapshot's derived-data stamp, as the store would record it (a snapshot the engine wrote, --snapshot-in).
    const derivedVersion = Number(docResponse.headers.get("x-derived-data-version") || params.get("derived") || 0) || 0;
    let engine = null;
    const origCreate = Engine.create;
    Engine.create = async (...a) => {
      const t = now();
      const e = await origCreate.apply(Engine, a);
      marks.engineCreateMs = (marks.engineCreateMs ?? 0) + (now() - t);
      marks.engineCreated = now();
      engine = e;
      const x = e["x"];
      const r0 = x.render;
      let n = 0;
      // Every canvas render over 8 ms after the load (a raster of the page: the first, fonts, images arriving).
      marks.heavyRenders = [];
      x.render = (hh) => {
        const t1 = now();
        r0(hh);
        const ms = now() - t1;
        if (marks.engineLoaded && ms > 8) {
          // What it drew: content-cache regions (r) and tiles (t).
          const st = e.stats();
          marks.heavyRenders.push(Math.round(ms * 10) / 10);
          (marks.heavyWhat ??= []).push(`${Math.round(ms)}:${st.cachedRegions}r${st.tilesRastered}t`);
        }
        if (!n++) {
          marks.firstRender = now();
          marks.firstRenderMs = marks.firstRender - t1;
        }
      };
      // engine_load itself (the worker path hands the bytes straight to it; Engine.load encodes first; a kiwi-reading
      // engine takes the store's snapshot bytes through `loadKiwi` → engine_load / engine_load_at). The first canvas
      // frame that counts is the first one after it (Engine.create draws an empty canvas before).
      const onLoad = (bytes, t1) => {
        marks.engineLoadRawMs = now() - t1;
        marks.engineLoaded = now();
        marks.loadBytes ??= bytes.length;
        marks.jsonBytes ??= bytes.length;
        // The first byte tells the two forms apart (docs/engine-build.md "Figma parity round 3"): "{" is the JSON.
        marks.wire ??= bytes[0] === 0x7b || bytes[0] === 0x5b || bytes[0] === 0x20 ? "json" : "kiwi";
        n = 0;
        delete marks.firstRender;
      };
      for (const name of ["load", "loadAt"]) {
        const f = x[name];
        if (typeof f !== "function") continue;
        x[name] = (hh, bytes, ...rest) => {
          const t1 = now();
          const r = f(hh, bytes, ...rest);
          onLoad(bytes, t1);
          return r;
        };
      }
      // Journal frames replayed after the load (a kiwi engine applies the store's frames as they are).
      const a0 = x.applyChanges;
      x.applyChanges = (hh, bytes, flags) => {
        const t1 = now();
        const r = a0(hh, bytes, flags);
        if (!marks.ready) {
          marks.framesReplayed = (marks.framesReplayed ?? 0) + 1;
          marks.framesReplayMs = (marks.framesReplayMs ?? 0) + (now() - t1);
        }
        return r;
      };
      return e;
    };
    const origLoad = Engine.prototype.load;
    Engine.prototype.load = function (m) {
      const t = now();
      const r = origLoad.call(this, m);
      marks.engineLoadMs = now() - t;
      marks.engineLoaded = now();
      return r;
    };
    let loads = 0;
    const source = {
      fileName: "Bench",
      location: "Drafts",
      sessionID: 1,
      async load() {
        loads++;
        const t = now();
        const m = mergedDocument({ snapshot, journal: [], sessionID: 1 });
        marks.mergedMs = (marks.mergedMs ?? 0) + (now() - t);
        marks.loads = loads;
        if (loads === 1) {
          const t2 = now();
          marks.jsonBytes = codec.encodeMessage(m).length;
          marks.encodeMs = now() - t2;
          marks.storedNodes = m.nodeChanges.length;
        }
        return m;
      },
      onChanges() {},
      async flush() {},
      ...(usePrepare
        ? {
            // The app's path: the store's source prepares the engine's bytes in its worker (memoized across StrictMode's
            // two mounts; asked again for the wire form the engine turned out to read, as the store's source does).
            prepare(format) {
              if (this._prepared && (!format || this._prepared.format === format)) return this._prepared.load;
              const t = now();
              marks.prepareStart ??= now();
              marks.prepareFormat = format ?? "json";
              const p = prepareDocument({ snapshot, journal: [], sessionID: 1, derivedDataVersion: derivedVersion }, format);
              const facts = this._prepared ? this._prepared.load.facts : p.facts;
              void facts.then((known) => {
                marks.fontsKnown ??= now();
                marks.fontCount = known.fonts.length + (known.needsFallbackFont ? 1 : 0);
                marks.fontPages = Object.keys(known.fontsByPage ?? {}).length;
                marks.storedDerivedVersion = known.derivedDataVersion;
              });
              void p.document.then((d) => {
                marks.preparedMs = now() - t;
                marks.prepared = now();
                marks.jsonBytes = d.bytes ? d.bytes.length : 0;
                marks.convertedBytes = d.bytes ? d.bytes.length : 0;
                marks.storedNodes = d.nodeCount;
                marks.prepareTiming = d.timing;
                marks.preparedFormat = d.format;
              });
              this._prepared = { format: format ?? "json", load: { ...p, facts } };
              return this._prepared.load;
            },
            async saveSnapshot(bytes, info) {
              marks.snapshotSaved ??= now();
              marks.savedSnapshotBytes = bytes.length;
              marks.snapshotDerivedVersion = info?.derivedDataVersion ?? 0;
              // Kept by the bench server when --snapshot-out asks (the next run opens from it).
              await fetch(`/__bench/snapshot?derived=${info?.derivedDataVersion ?? 0}`, { method: "POST", body: bytes }).catch(() => {});
              return true;
            },
          }
        : {}),
      images: {
        async put() {
          return "";
        },
        async get(hash) {
          const r = await fetch(`/__bench/image?hash=${hash}`);
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        },
      },
      uiState: pageGuid ? { currentPageId: pageGuid, pages: {}, leftPanelWidth: 0, rightPanelWidth: 0 } : null,
      setUiState() {},
      async saveThumbnail(png) {
        marks.thumbnail = now();
        marks.thumbnailBytes = png.length;
      },
    };
    const root = createRoot(document.getElementById("root"));
    marks.mountStart = now();
    const app = React.createElement(EditorApp, {
      source,
      onReady: (ed) => {
        marks.ready ??= now();
        window.__designerEditor = ed;
      },
    });
    root.render(strict ? React.createElement(React.StrictMode, null, app) : app);
    while (!marks.ready) await sleep(5);
    await painted();
    marks.chromePainted = now();
    await fonts.settled();
    marks.fonts = now();
    engine.pump();  // the relayout the fonts caused runs on this call; its frame follows
    await painted();
    marks.fontsFrame = now();
    await engine.imagesSettled();
    await window.__designerEditor?.images?.settled?.();
    marks.images = now();
    engine.pump();
    await painted();
    marks.imagesFrame = now();
    for (let i = 0; i < 70 && !marks.thumbnail; i++) await sleep(100);
    // --snapshot-out: the engine's snapshot is written ~15 s after an open whose snapshot lacked this engine's derived data.
    if (params.get("waitSnapshot") === "1") for (let i = 0; i < 300 && !marks.snapshotSaved; i++) await sleep(100);
    marks.end = now();
    marks.heap = engine["x"].module.HEAPU8.length;
    marks.stats = engine.stats();
    marks.engineWire = typeof engine.wire === "string" ? engine.wire : undefined;
    marks.pages = engine.pages().length;
    marks.page = engine.getSelection().pageId;
    window.__open.done = true;
  })().catch((e) => {
    window.__open.error = String(e?.stack ?? e);
    window.__open.done = true;
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
  server: { port: 5207, strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules")), ...(wasmDir ? [path.resolve(wasmDir)] : [])] }, hmr: false, watch: null, headers: {} },
  appType: editor ? "spa" : "custom",
  logLevel: "error",
  ssr: { noExternal: ["electron"] },
  ...(editor ? {} : { optimizeDeps: { noDiscovery: true, include: [] } }),
  plugins: [
    {
      name: "engine-bench",
      enforce: "pre",
      // src/main/fonts.ts (the desktop's font index) runs here without Electron: app.getPath → a temp dir.
      // Its window bookkeeping (./views: the desktop's views, protocol, store host) is stubbed: no views here.
      resolveId: (id, importer) =>
        id === "/__bench/page.js"
          ? "\0engine-bench-page"
          : id === "electron"
            ? "\0engine-bench-electron"
            : id === "./views" && importer?.endsWith(path.join("src", "main", "fonts.ts"))
              ? "\0engine-bench-views"
              : null,
      load: (id) =>
        id === "\0engine-bench-page"
          ? `(${pageMain.toString()})();`
          : id === "\0engine-bench-electron"
            ? `export const app = { getPath: () => ${JSON.stringify(path.join(tmpdir(), "designer-engine-bench"))} }; export const webContents = { getAllWebContents: () => [] }; export default { app, webContents };`
            : id === "\0engine-bench-views"
              ? "export const viewOf = () => undefined;"
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
          if (url.pathname === "/__bench/open.html") {
            const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>DesignerV2</title></head><body><div id="root"></div><script type="module">(${openPageMain.toString()})();</script></body></html>`;
            res.setHeader("content-type", "text/html");
            res.end(await s.transformIndexHtml(req.url, html));
            return;
          }
          if (url.pathname === "/__bench/doc.bin") {
            res.setHeader("content-type", "application/octet-stream");
            if (doc.derivedDataVersion) res.setHeader("x-derived-data-version", String(doc.derivedDataVersion));
            res.end(Buffer.from(doc.message));
            return;
          }
          if (url.pathname === "/__bench/snapshot" && req.method === "POST") {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", async () => {
              const bytes = Buffer.concat(chunks);
              report.engineSnapshotBytes = bytes.length;
              // The store's check (src/shared/store/snapshotCheck.ts): would it adopt this snapshot over the file?
              try {
                const [{ decodeMessage }, { NodeTable }, { snapshotLosses }] = await Promise.all([
                  s.ssrLoadModule(path.join(repo, "src/shared/schema/codec.ts")),
                  s.ssrLoadModule(path.join(repo, "src/shared/schema/patch.ts")),
                  s.ssrLoadModule(path.join(repo, "src/shared/store/snapshotCheck.ts")),
                ]);
                const l = snapshotLosses(NodeTable.fromMessage(decodeMessage(doc.message)), NodeTable.fromMessage(decodeMessage(new Uint8Array(bytes))));
                report.engineSnapshotLosses = { total: l.total, missingNodes: l.missingNodes, droppedFields: l.droppedFields, examples: l.examples };
              } catch (e) {
                report.engineSnapshotLosses = { error: String(e) };
              }
              report.engineSnapshotDerivedVersion = Number(url.searchParams.get("derived") || 0);
              if (snapshotOut) {
                writeFileSync(snapshotOut, bytes);
                writeFileSync(`${snapshotOut}.json`, JSON.stringify({ derivedDataVersion: report.engineSnapshotDerivedVersion, bytes: bytes.length, file: report.file }));
              }
              res.end("ok");
            });
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
    if (snapshotIn) {
      // The engine's own snapshot of this file (a previous run's --snapshot-out): the images stay the import's.
      const meta = existsSync(`${snapshotIn}.json`) ? JSON.parse(readFileSync(`${snapshotIn}.json`, "utf8")) : {};
      doc.message = new Uint8Array(readFileSync(snapshotIn));
      doc.derivedDataVersion = Number(meta.derivedDataVersion || 0);
      report.snapshotIn = { path: snapshotIn, derivedDataVersion: doc.derivedDataVersion };
    }
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
// CPU profiles (Chrome's sampling profiler): one over the load, one per scenario group (or the open).
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

if (openMode) {
  // The open path. The page to open: --page, else the one with the most stored layers (decoded here).
  let openPage = null;
  {
    const { decodeMessage } = await server.ssrLoadModule(path.join(repo, "src/shared/schema/codec.ts"));
    const t = performance.now();
    const msg = decodeMessage(doc.message);
    report.nodeDecodeMs = performance.now() - t;
    const key = (g) => `${g.sessionID}:${g.localID}`;
    const byId = new Map();
    for (const n of msg.nodeChanges) if (n.guid) byId.set(key(n.guid), n);
    const pageOf = (n) => {
      let cur = n;
      for (let i = 0; cur && i < 1000; i++) {
        if (cur.type === "CANVAS") return cur.internalOnly ? null : key(cur.guid);
        cur = cur.parentIndex ? byId.get(key(cur.parentIndex.guid)) : null;
      }
      return null;
    };
    const counts = new Map();
    const names = new Map();
    for (const n of byId.values()) {
      if (n.type === "CANVAS" && !n.internalOnly) names.set(key(n.guid), n.name ?? "");
      const p = pageOf(n);
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const pages = [...names.keys()].map((guid) => ({ guid, name: names.get(guid), layers: (counts.get(guid) ?? 1) - 1 }));
    report.load = { pages, storedNodes: msg.nodeChanges.length };
    openPage = pageChoice(pages);
    report.page = pages.find((p) => p.guid === openPage) ?? null;
  }
  await profiled("open", async () => {
    await page.goto(`${base}__bench/open.html?strict=${noStrict ? 0 : 1}&prepare=${flag("--no-prepare") ? 0 : 1}&page=${encodeURIComponent(openPage ?? "")}&waitSnapshot=${snapshotOut ? 1 : 0}`);
    await page.waitForFunction(() => window.__open && window.__open.done, null, { timeout: 150000 });
  });
  const open = await page.evaluate(() => window.__open);
  if (open.error) {
    console.error(open.error, problems.join("\n"));
    process.exit(1);
  }
  report.open = open.marks;
  // The dev server's module requests (the app loads this way under `npm run dev`): count and span.
  report.open.resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => ({ name: e.name.replace(location.origin, ""), start: Math.round(e.startTime), dur: Math.round(e.duration), bytes: e.transferSize }))
  );
  report.gpuSteps = { end: gpuFootprintMB(browserPid) };
  report.totalMs = performance.now() - t0;
  report.problems = problems.slice(0, 20);
} else {
if (editor) {
  await page.goto(`${base}?editor&doc=empty&bench=editor`);
  await page.waitForFunction(() => window.__designerEditor && window.__designerEditor.canvas, null, { timeout: 60000 }).catch(async (e) => {
    console.error(problems.join("\n"));
    throw e;
  });
  await page.addScriptTag({ type: "module", url: "/__bench/page.js" });
} else {
  await page.goto(`${base}__bench/index.html?w=${cssW}&h=${cssH}${gfxOpt ? `&gfx=${gfxOpt}` : ""}`);
}
await page.waitForFunction(() => window.__bench && (window.__bench.ready || window.__bench.error), null, { timeout: 120000 });
const bootError = await page.evaluate(() => window.__bench.error);
if (bootError) {
  console.error(bootError, problems.join("\n"));
  process.exit(1);
}
report.gpu = await page.evaluate(() => window.__bench.gpuInfo);
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
// The instance scenario groups run one at a time from here (each gets its own CPU profile); the rest as before.
const GROUPS = ["instSelect", "instDrag", "altDrag", "multiDrag", "menuState", "variantMain", "flowDrag", "selectMany"];
const groups = only.filter((n) => GROUPS.includes(n));
const legacy = only.filter((n) => !GROUPS.includes(n));
report.scenarios = [];
if (!only.length || legacy.length) report.scenarios = await profiled("frames", () => page.evaluate(({ names, p }) => window.__bench.run(names, p), { names: legacy, p: pageGuid }));
if (groups.length) {
  report.targets = await page.evaluate((p) => window.__bench.targets(p), pageGuid);
  for (const g of groups) {
    const out = await profiled(g, () => page.evaluate(({ g, p }) => window.__bench.runOne(g, p), { g, p: pageGuid }));
    report.scenarios.push(...out);
  }
}
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
}
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
if (openMode) {
  // The open path, step by step, as the editor's own code ran it.
  const m = report.open;
  const rel = (k) => (m[k] === undefined ? null : m[k] - m.t0);
  const at = (k) => (rel(k) === null ? "—" : `${rel(k).toFixed(0)} ms`);
  console.log(`\nengine-bench --open — ${report.file}  (${noStrict ? "no StrictMode" : "StrictMode, as main.tsx"}; wasm ${report.wasm})`);
  console.log(`viewport ${cssW}×${cssH} CSS @${dpr}x · page "${report.page?.name}" (${report.page?.layers} stored layers) · ${L.storedNodes} stored nodes, ${m.pages} pages`);
  if (report.importMs !== undefined) console.log(`  .fig import (store, Node)            ${f1(report.importMs)} ms   (${mb(report.figBytes)} → ${mb(report.snapshotBytes)} snapshot; once, at import)`);
  console.log(`\nOpen (time since the page started; the dev server serves modules as npm run dev does)`);
  console.log(`  modules loaded (editor code)          ${at("modules")}   (${report.open.resources.filter((r) => /\.(tsx?|mjs|js)(\?|$)/.test(r.name)).length} script requests)`);
  console.log(`  system font index fetched             ${at("fontIndex")}`);
  console.log(`  snapshot fetched                      ${at("fetched")}   (${mb(m.snapshotBytes)})`);
  console.log(`  mount started                         ${at("mountStart")}`);
  if (m.preparedMs !== undefined) {
    const pt = m.prepareTiming ?? {};
    console.log(`  source.prepare() in the load worker   ${f1(m.preparedMs)} ms wall → at ${at("prepared")}   (worker: table ${f1(pt.table)} + engine form ${f1(pt.convert)} + bytes ${f1(pt.encode)} ms; ${m.storedNodes} nodes, ${mb(m.jsonBytes)}; fonts known at ${at("fontsKnown")}, ${m.fontCount} faces)`);
  } else {
    console.log(`  source.load() = mergedDocument        ${f1(m.mergedMs)} ms total over ${m.loads} call(s)${m.loads > 1 ? " (StrictMode: the first result is thrown away)" : ""}; ${m.storedNodes} nodes`);
    console.log(`  engine JSON encode (measured apart)   ${f1(m.encodeMs)} ms   (${mb(m.jsonBytes)})`);
  }
  console.log(`  Engine.create (wasm + GL)             ${f1(m.engineCreateMs)} ms → at ${at("engineCreated")}`);
  if (m.engineLoadMs !== undefined) console.log(`  engine.load (encode + engine_load)    ${f1(m.engineLoadMs)} ms → at ${at("engineLoaded")}   (engine_load alone ≈ ${f1(m.engineLoadRawMs ?? m.engineLoadMs - m.encodeMs)} ms)`);
  else console.log(`  engine_load (${m.wire === "kiwi" ? "the store's kiwi bytes" : "the prepared bytes"})${m.wire === "kiwi" ? " " : "      "}${f1(m.engineLoadRawMs)} ms → at ${at("engineLoaded")}   (${mb(m.loadBytes ?? m.jsonBytes)} ${m.wire ?? "json"}${m.framesReplayed ? `, ${m.framesReplayed} journal frames replayed in ${f1(m.framesReplayMs)} ms` : ""}${m.prepareFormat ? `; worker asked for ${m.prepareFormat}` : ""})`);
  if (m.storedDerivedVersion || m.stats?.derivedUsed || m.stats?.derivedStale) console.log(`  derived data                          stored version ${m.storedDerivedVersion ?? 0}; at load: ${m.stats?.derivedUsed ?? "—"} entries used, ${m.stats?.derivedStale ?? "—"} re-derived`);
  if (m.snapshotSaved) console.log(`  engine snapshot saved                 ${at("snapshotSaved")}   (${mb(m.savedSnapshotBytes)}, derived version ${m.snapshotDerivedVersion})`);
  if (report.engineSnapshotLosses) {
    const l = report.engineSnapshotLosses;
    console.log(l.total ? `  the store would REFUSE it:            ${l.missingNodes} nodes and ${l.total - l.missingNodes} values the file holds are missing — ${Object.entries(l.droppedFields).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}×${n}`).join(", ")}` : `  the store would adopt it              (nothing of the file's is missing)${l.error ? ` — check failed: ${l.error}` : ""}`);
  }
  console.log(`  onReady (chrome committed)            ${at("ready")}`);
  console.log(`  chrome painted                        ${at("chromePainted")}`);
  console.log(`  Layers rows in the DOM                ${at("layersDom")}`);
  console.log(`  Design panel in the DOM               ${at("designDom")}`);
  console.log(`  first canvas frame                    ${at("firstRender")}   (${f1(m.firstRenderMs)} ms CPU)`);
  console.log(`  fonts settled                         ${at("fonts")}; relayout frame painted ${at("fontsFrame")}`);
  console.log(`  images settled                        ${at("images")}; frame painted ${at("imagesFrame")}`);
  if (m.heavyRenders) console.log(`  canvas renders > 8 ms after load     ${m.heavyRenders.length}, ${f1(m.heavyRenders.reduce((a, b) => a + b, 0))} ms in all (ms:regions r tiles t — ${(m.heavyWhat ?? []).slice(0, 40).join(" ")}${m.heavyRenders.length > 40 ? " …" : ""})`);
  console.log(`  thumbnail written                     ${at("thumbnail")}${m.thumbnailBytes ? ` (${mb(m.thumbnailBytes)})` : " (none within 7 s)"}`);
  console.log(`  wasm memory                           ${mb(m.heap)}`);
  if (m.fontRequests?.length) {
    const loadedAt = rel("engineLoaded") ?? Infinity;
    const after = m.fontRequests.filter((r) => r.at > loadedAt);
    console.log(`  font requests                         ${m.fontRequests.length} (${m.fontRequests.length - after.length} before engine_load, ${after.length} after${after.length ? `: ${after.map((r) => `${r.family} ${r.style} @${r.at}`).join(", ")}` : ""})`);
  }
  const long = m.long.filter((l) => l.ms >= 50);
  console.log(`\nLong tasks (≥ 50 ms, main thread blocked): ${long.length}, total ${long.reduce((a, l) => a + l.ms, 0)} ms`);
  for (const l of long) console.log(`  at ${String(l.at).padStart(6)} ms  ${String(l.ms).padStart(5)} ms`);
  const res = report.open.resources;
  const scripts = res.filter((r) => /\.(tsx?|mjs|js)(\?|$)/.test(r.name));
  const fontsRes = res.filter((r) => r.name.includes("/__bench/font?"));
  const imgRes = res.filter((r) => r.name.includes("/__bench/image?"));
  const span = (list) => (list.length ? `${Math.min(...list.map((r) => r.start)).toFixed(0)}–${Math.max(...list.map((r) => r.start + r.dur)).toFixed(0)} ms` : "—");
  console.log(`\nRequests: ${scripts.length} scripts (${span(scripts)}), ${fontsRes.length} font files (${span(fontsRes)}, ${mb(fontsRes.reduce((a, r) => a + (r.bytes || 0), 0))}), ${imgRes.length} images (${span(imgRes)})`);
  for (const [name, prof] of Object.entries(report.profiles)) {
    console.log(`\nCPU profile: ${name} (${prof.totalMs} ms sampled) — self time`);
    for (const r of prof.self.slice(0, 30)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
    console.log(`inclusive`);
    for (const r of prof.inclusive.slice(0, 40)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
  }
  if (problems.length) console.log(`\nconsole errors:\n  ${problems.slice(0, 10).join("\n  ")}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
  process.exit(0);
}
console.log(`\nengine-bench — ${report.file}  (${report.gpu.backend ?? "webgl2"}: ${report.gpu.renderer}; timer query ${report.gpu.timerQuery ? "yes" : "no"})`);
console.log(`viewport ${cssW}×${cssH} CSS @${dpr}x · wasm ${report.wasm}`);
console.log(`\nDocument: ${L.storedNodes} stored nodes, ${report.first.engineNodes} in the engine (instance sublayers included); ${report.images} images (${mb(report.imageBytes)}), ${L.imageRefs} referenced; ${L.pages.length} pages`);
console.log(`  by type: ${Object.entries(L.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`  measured page: "${report.page?.name}" (${report.page?.layers} stored layers); densest frame: ${report.dense ? `${report.dense.layers} layers, ${Math.round(report.dense.w)}×${Math.round(report.dense.h)}` : "—"}`);
console.log(`\nLoad`);
if (report.importMs !== undefined) console.log(`  .fig import (store, Node)     ${f1(report.importMs)} ms   (${mb(report.figBytes)} → ${mb(report.snapshotBytes)} snapshot)`);
console.log(`  decode snapshot (renderer)    ${f1(L.decodeMs)} ms`);
if (L.jsonBytes) console.log(`  encode engine JSON            ${f1(L.encodeMs)} ms   (${mb(L.jsonBytes)})`);
console.log(`  engine_load (parse+derive)    ${f1(L.engineLoadMs)} ms${L.kiwiBytes ? `   (the store's kiwi bytes, ${mb(L.kiwiBytes)})` : ""}`);
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
  if (!s.frame) continue;
  const sy = s.synced ? ` (synced ${f1(s.synced.median)})` : "";
  console.log(
    `  ${s.name.padEnd(40)} ${f1(s.frame?.median).padStart(9)} ${f1(s.frame?.p95).padStart(6)}  ${f1(s.cpu?.median).padStart(7)} ${f1(s.cpu?.p95).padStart(6)}  ${f1(s.gpu?.median).padStart(7)} ${f1(s.gpu?.p95).padStart(6)}  ${f1(s.input?.median).padStart(9)} ${f1(s.input?.p95).padStart(6)}  ${f1(s.longTasks?.total).padStart(5)}  ${s.last.drawCalls} calls, ${s.last.shapes} inst, ${s.last.layers} layers${sy}`
  );
}
const inst = report.scenarios.filter((s) => s.inputMicro);
if (inst.length) {
  console.log(`\nInstance scenarios (input+micro = the input and the panels' synchronous re-render after it; regions = content-cache parts drawn per frame,`);
  console.log(`        0 composite only, 1 whole or one part; hits = what the clicks selected; moved = the drag's selection and its offset)`);
  console.log(`  ${"scenario".padEnd(34)} ${"frame med".padStart(9)} ${"p95".padStart(6)}  ${"CPU med".padStart(7)} ${"p95".padStart(6)}  ${"GPU med".padStart(7)}  ${"input med".padStart(9)} ${"p95".padStart(6)}  ${"+micro".padStart(7)} ${"p95".padStart(6)}  ${"long".padStart(5)}  ${"regions".padStart(7)}  ${"draws".padStart(5)}  notes`);
  for (const s of inst) {
    const notes = s.hits
      ? s.direct
        ? `1-click: hits A ${s.hits.A} B ${s.hits.B} other ${s.hits.other} none ${s.hits.none}`
        : `parent then click: parent ${s.hits.parent} target ${s.hits.A} other ${s.hits.other}`
      : s.moved !== undefined
        ? `${s.movedTarget ? "target" : "a CHILD"} moved by ${s.movedBy ? s.movedBy.join(",") : "—"} (${s.pressHit} under the press${s.locked ? ", locked" : ""}); events ${Object.entries(s.events ?? {}).map(([k, v]) => `${k.replace("_CHANGED", "")}:${v}`).join(" ")}`
        : "";
    console.log(
      `  ${s.name.padEnd(34)} ${f1(s.frame?.median).padStart(9)} ${f1(s.frame?.p95).padStart(6)}  ${f1(s.cpu?.median).padStart(7)} ${f1(s.cpu?.p95).padStart(6)}  ${f1(s.gpu?.median).padStart(7)}  ${f1(s.input?.median).padStart(9)} ${f1(s.input?.p95).padStart(6)}  ${f1(s.inputMicro?.median).padStart(7)} ${f1(s.inputMicro?.p95).padStart(6)}  ${f1(s.longTasks?.total).padStart(5)}  ${`${f1(s.regions?.median)}/${f1(s.regions?.max)}`.padStart(7)}  ${f1(s.draws?.median).padStart(5)}  ${notes}`
    );
  }
}
for (const s of report.scenarios) if (s.ms) console.log(`\n${s.name}: median ${f1(s.ms.median)} ms, p95 ${f1(s.ms.p95)} ms (${s.commands} commands)`);
if (report.targets) {
  const pg = report.targets.page;
  if (pg) console.log(`\nPage: ${pg.layers} visible stored layers, ${pg.instances} instances (${pg.instancesFree} in free parents, ${pg.variantInstances} of component sets, ${pg.clickableInstances} reachable by one click)`);
  console.log(`Targets (ids and counts only): subtree = drawn nodes under it, effects = nodes with visible effects, texts = TEXT nodes; mainSize = the main's stored subtree, variants = the set's`);
  for (const [k, list] of Object.entries(report.targets)) {
    if (!Array.isArray(list)) continue;
    if (k === "manyLayers") {
      console.log(`  ${k.padEnd(13)} ${list.length} layers`);
      continue;
    }
    for (const t of list)
      console.log(`  ${k.padEnd(13)} ${t.id.padEnd(12)} ${t.type.padEnd(18)} ${`${t.size[0]}×${t.size[1]}`.padEnd(10)} in ${String(t.parentType).padEnd(9)}${t.parentAuto ? " auto " : " free "} depth ${String(t.depth).padStart(2)} subtree ${String(t.subtree).padStart(5)} effects ${String(t.effects).padStart(3)} texts ${String(t.texts).padStart(4)}${t.mainSize !== undefined ? ` mainSize ${t.mainSize} variants ${t.variants}` : ""}`);
  }
}
for (const [name, prof] of Object.entries(report.profiles)) {
  console.log(`\nCPU profile: ${name} (${prof.totalMs} ms sampled) — self time`);
  for (const r of prof.self.slice(0, 25)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
  console.log(`inclusive`);
  for (const r of prof.inclusive.slice(0, 35)) console.log(`  ${String(r.ms).padStart(6)} ms ${String(r.pct).padStart(5)}%  ${r.fn}`);
}
if (problems.length) console.log(`\nconsole errors:\n  ${problems.slice(0, 10).join("\n  ")}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
