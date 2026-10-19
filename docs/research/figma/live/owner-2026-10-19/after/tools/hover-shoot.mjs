// Shoots Wecra's hover chrome in the states of the owner's 2026-10-19 Figma captures (hover-figma-*.webp) and composes
// Figma (left) beside Wecra (right). Throwaway research tooling, not product code.
//   npm run web -- --mode demo --port 5413 --strictPort     (another terminal)
//   WECRA_URL=http://localhost:5413 OUT=<dir> node docs/research/figma/live/owner-2026-10-19/after/tools/hover-shoot.mjs [filter]
// Writes <OUT>/<case>.png (Wecra, canvas only) and <OUT>/<case>.json (the overlay's hover / selection).
/* global window, localStorage, requestAnimationFrame */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.WECRA_URL ?? "http://localhost:5413";
const OUT = process.env.OUT ?? path.resolve("hover-shots");
mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;

// The Figma captures: 2000 × 1299 of a Retina window; the canvas is image x 412–1680, y 122–1299 (1.3228 image px a pt).
export const FIG = { x0: 412, y0: 122, x1: 1680, y1: 1299, s: 2000 / 1512 };
const VIEW = { width: Math.round((FIG.x1 - FIG.x0) / FIG.s), height: Math.round((FIG.y1 - FIG.y0) / FIG.s) };

const hex = (v) => ({ r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 });
const fill = (v) => [{ type: "SOLID", color: hex(v), opacity: 1, visible: true, blendMode: "NORMAL" }];
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const pos = (i) => String.fromCharCode(33 + i);
const P = "0:40";
const ANA = { x: -3000, y: 0 };

function fixture() {
  const n = [];
  n.push({ guid: P, phase: "CREATED", type: "CANVAS", name: "Test", parentIndex: { guid: "0:0", position: "~5" }, backgroundColor: hex(0x1e1e1e), backgroundEnabled: true });
  // "ana frame" (no auto layout) and its two vertical auto-layout "iç frame"s, each a text and a rectangle.
  n.push({ guid: "40:1", phase: "CREATED", type: "FRAME", name: "ana frame", parentIndex: { guid: P, position: "!" }, size: { x: 1554, y: 3356 }, transform: at(ANA.x, ANA.y), fillPaints: fill(0xffffff), frameMaskDisabled: true });
  const ic = (g, i, y, label, rect) => {
    n.push({ guid: g, phase: "CREATED", type: "FRAME", name: "iç frame", parentIndex: { guid: "40:1", position: pos(i) }, size: { x: 1080, y: 1440 }, transform: at(198, y), fillPaints: fill(0xeae9e9), frameMaskDisabled: true, stackMode: "VERTICAL", stackSpacing: 10, stackPrimaryAlignItems: "MAX", stackCounterAlignItems: "MIN", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" });
    n.push({ guid: rect, phase: "CREATED", type: "RECTANGLE", name: "çocuk", parentIndex: { guid: g, position: "!" }, size: { x: 492, y: 515 }, transform: at(0, 925), fillPaints: fill(0xd9d9d9) });
    n.push({ guid: rect + "0", phase: "CREATED", type: "TEXT", name: label, parentIndex: { guid: g, position: '"' }, size: { x: 370, y: 136 }, transform: at(355, 292), stackPositioning: "ABSOLUTE", fillPaints: fill(0x000000), textData: { characters: label }, fontName: { family: "Inter", style: "Bold", postscript: "" }, fontSize: 56, textAlignHorizontal: "CENTER", textAutoResize: "HEIGHT" });
  };
  ic("40:2", 0, 154, "BU SEÇİLİ OLAN FRAME", "40:3");
  ic("40:5", 1, 1727, "BU HOVER OLAN FRAME", "40:6");
  // "test": horizontal auto layout (gap 299) holding "test-Frame" (a wrapped 3 × 3 grid of vertical auto-layout cells,
  // each with a rectangle) and "test-Rectangle" (the same grid of rectangles) — autolayout-drag-frames.txt.
  n.push({ guid: "41:1", phase: "CREATED", type: "FRAME", name: "test", parentIndex: { guid: P, position: '"' }, size: { x: 7503, y: 4806 }, transform: at(0, 0), fillPaints: [], frameMaskDisabled: true, stackMode: "HORIZONTAL", stackSpacing: 299, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" });
  const grid = (g, i, name) => n.push({ guid: g, phase: "CREATED", type: "FRAME", name, parentIndex: { guid: "41:1", position: pos(i) }, size: { x: 3602, y: 4806 }, transform: at(i * 3901, 0), fillPaints: fill(0xffffff), frameMaskDisabled: false, stackMode: "HORIZONTAL", stackWrap: "WRAP", stackSpacing: 10, stackCounterSpacing: 10, stackHorizontalPadding: 171, stackPaddingRight: 171, stackVerticalPadding: 233, stackPaddingBottom: 233, stackPrimarySizing: "FIXED", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" });
  grid("41:2", 0, "test-Frame");
  grid("41:3", 1, "test-Rectangle");
  const align = ["MIN", "CENTER", "MAX"];
  for (let k = 0; k < 9; k++) {
    const row = Math.floor(k / 3), col = k % 3, x = 171 + col * 1090, y = 233 + row * 1450;
    const cell = `42:${k + 1}`;
    n.push({ guid: cell, phase: "CREATED", type: "FRAME", name: `Frame ${15 + k}`, parentIndex: { guid: "41:2", position: pos(k) }, size: { x: 1080, y: 1440 }, transform: at(x, y), fillPaints: fill(k === 4 ? 0xff0000 : 0x737373), frameMaskDisabled: true, stackMode: "VERTICAL", stackPrimaryAlignItems: align[row], stackCounterAlignItems: align[col], stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" });
    n.push({ guid: `43:${k + 1}`, phase: "CREATED", type: "RECTANGLE", name: "Rectangle 11", parentIndex: { guid: cell, position: "!" }, size: { x: 492, y: 515 }, transform: at(0, 0), fillPaints: fill(0xd9d9d9) });
    n.push({ guid: `44:${k + 1}`, phase: "CREATED", type: "RECTANGLE", name: "Rectangle 11", parentIndex: { guid: "41:3", position: pos(k) }, size: { x: 1080, y: 1440 }, transform: at(x, y), fillPaints: fill(k === 4 ? 0xff0000 : 0xd9d9d9) });
  }
  return n;
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ed = (page, fn, arg) => page.evaluate(fn, arg);

async function open(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      /* none */
    }
  });
  await page.goto(`${BASE}/?editor&doc=capture`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 60000 });
  await ed(page, (c) => window.__designerEditor.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: c }), fixture());
  await ed(page, (p) => window.__designerEditor.engine.setCurrentPage(p), P);
  await ed(page, () => window.__designerEditor.ui.set({ uiHidden: true }));
  await settle(page);
  await wait(400);
}
/** Camera: doc (dx, dy) at Figma image (ix, iy), `perUnit` image px per doc unit. */
async function camera(page, dx, dy, ix, iy, perUnit) {
  const zoom = perUnit / FIG.s;
  const px = (ix - FIG.x0) / FIG.s, py = (iy - FIG.y0) / FIG.s;
  await ed(page, ([dx, dy, px, py, zoom]) => {
    const e = window.__designerEditor;
    const r = e.canvas.getBoundingClientRect();
    e.engine.setCamera({ x: px - r.left - dx * zoom, y: py - r.top - dy * zoom, zoom });
  }, [dx, dy, px, py, zoom]);
  await settle(page);
}
async function hoverDoc(page, x, y) {
  const [px, py] = await ed(page, ([x, y]) => {
    const e = window.__designerEditor;
    const c = e.engine.getCamera();
    const r = e.canvas.getBoundingClientRect();
    return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y];
  }, [x, y]);
  await page.mouse.move(px - 40, py - 40);
  await page.mouse.move(px, py, { steps: 5 });
  await settle(page);
  await wait(300);
}

const cases = [
  // A: one "iç frame" selected, the pointer over its sibling (hover-figma-icframe-selected-hover-sibling, 25 %).
  { name: "hover-A-icframe-selected-hover-sibling", fig: "hover-figma-icframe-selected-hover-sibling", sel: ["40:2"], cam: [ANA.x + 198, 154, 867, 163, 353 / 1080], at: [ANA.x + 198 + 700, 1727 + 600] },
  // B: "ana frame" selected, the pointer over a child "iç frame" (live 2026-10-18 spec; no owner capture).
  { name: "hover-B-anaframe-selected-hover-child", fig: "hover-figma-icframe-selected-hover-sibling", sel: ["40:1"], cam: [ANA.x + 198, 154, 867, 163, 353 / 1080], at: [ANA.x + 198 + 700, 1727 + 600] },
  // C: test-Frame (the wrap grid) selected, the pointer over a cell (spec C).
  { name: "hover-C-testframe-selected-hover-cell", fig: "hover-figma-testframe-selected", sel: ["41:2"], cam: [0, 0, 487, 347, 508 / 3602], at: [171 + 1090 + 540, 233 + 1450 * 2 + 1000] },
  // C': test-Frame selected, the pointer over test-Rectangle (hover-figma-testframe-selected-zoom, 29 %; the owner's Wecra capture).
  { name: "hover-C2-testframe-selected-hover-sibling", fig: "hover-figma-testframe-selected-zoom", sel: ["41:2"], cam: [3602, 0, 823, 372, 114 / 299], at: [3901 + 1500, 1000] },
  // D: a cell selected, the pointer over the next cell (hover-figma-cell-selected-hover-sibling, 30 %).
  { name: "hover-D-cell-selected-hover-sibling", fig: "hover-figma-cell-selected-hover-sibling", sel: ["42:7"], cam: [171, 3133, 653, 465, 434 / 1080], at: [171 + 1090 + 540, 3133 + 300] },
  // E: "test" selected, the pointer over test-Rectangle (hover-figma-test-selected, 11 %).
  { name: "hover-E-test-selected-hover-child", fig: "hover-figma-test-selected", sel: ["41:1"], cam: [0, 0, 527, 351, 1059 / 7503], at: [3901 + 1800, 2400] },
];

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  for (const c of cases) {
    if (filter && !filter.test(c.name)) continue;
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await open(page);
    await camera(page, ...c.cam);
    await ed(page, (ids) => window.__designerEditor.engine.setSelection(ids), c.sel);
    await settle(page);
    await hoverDoc(page, ...c.at);
    await wait(200);
    await page.screenshot({ path: path.join(OUT, `${c.name}.png`) });
    const info = await ed(page, () => {
      const e = window.__designerEditor.engine;
      return { selection: e.getSelection?.() ?? null, hover: e.getHover?.() ?? null };
    });
    writeFileSync(path.join(OUT, `${c.name}.json`), JSON.stringify({ ...c, ...info }, null, 1));
    console.log("ok", c.name, JSON.stringify(info));
    await ctx.close();
  }
} finally {
  await browser.close();
}
