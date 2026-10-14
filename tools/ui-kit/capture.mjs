#!/usr/bin/env node
/* global window, document, Image, getComputedStyle */
// Captures Wecra's chrome from the renderer running in a browser (the web dev page, demo data): each screen of
// scenarios.mjs as a tree of boxes, text, icons and pictures (walker.js), with light and dark colours, plus every
// Gallery cell (the ds components in their states) and the icons' glyphs. Writes tools/ui-kit/out/.
//
//   npx vite --config tools/ui-kit/vite.capture.config.ts --mode demo &   (port 5202)
//   node tools/ui-kit/capture.mjs [--only <screen id>…] [--no-gallery]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const BASE = process.env.UIKIT_URL ?? "http://localhost:5202/";
const args = process.argv.slice(2);
const only = args.includes("--only") ? args.slice(args.indexOf("--only") + 1).filter((a) => !a.startsWith("--")) : null;
const withGallery = !args.includes("--no-gallery") && !only;
mkdirSync(join(OUT, "screens"), { recursive: true });
mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(OUT, "images"), { recursive: true });

const { ICONS } = await import("../../src/renderer/src/ds/icons/registry.ts");
const strip = (p, mode) => (typeof mode === "string" ? (p.startsWith("f|") ? p.slice(2) : p) : p.indexOf("|") > 0 ? p.slice(p.indexOf("|") + 1) : p);
const iconKeys = {};
for (const [name, [, mode, ...paths]] of Object.entries(ICONS)) iconKeys[paths.map((p) => strip(p, mode)).join("\n")] = name;

/** The icon's SVG as Icon.tsx draws it, in black, at `scale`. */
function iconSvg(name, scale = 4) {
  const [box, mode, ...paths] = ICONS[name];
  const s = box * scale;
  if (typeof mode === "string") {
    const view = Number(mode.slice(1));
    const inset = (box - view) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="${-inset} ${-inset} ${box} ${box}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${paths.map((p) => (p.startsWith("f|") ? `<path d="${p.slice(2)}" fill="#000" stroke="none"/>` : `<path d="${p}"/>`)).join("")}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${box} ${box}" fill="#000">${paths
    .map((p) => {
      const at = p.indexOf("|");
      const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
      const d = at > 0 ? p.slice(at + 1) : p;
      return `<path d="${d}"${mode === 1 ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""}${tone >= 0.9 ? "" : ` fill-opacity="${tone / 0.9}"`}/>`;
    })
    .join("")}</svg>`;
}

const exe = `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light", deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.warn("page error:", e.message.slice(0, 160)));
const walker = readFileSync(join(HERE, "walker.js"), "utf8");
const images = new Map(); // key → file
let imageSeq = 0;

async function inject() {
  await page.evaluate(walker);
  await page.evaluate((k) => (window.__uikit.iconKeys = k), iconKeys);
  await page.evaluate(walker); // again, so the walker reads the keys
}

/** Draws SVG markup to a PNG (2x) in the page. */
const rasterSvg = (markup, w, h, scale = 2) =>
  page.evaluate(
    async ({ markup, w, h, scale }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/png").split(",")[1];
    },
    { markup, w, h, scale }
  );

const imgToPng = (src) =>
  page.evaluate(async (src) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png").split(",")[1];
  }, src);

function saveImage(key, b64) {
  if (images.has(key)) return images.get(key);
  const file = `img${++imageSeq}.png`;
  writeFileSync(join(OUT, "images", file), Buffer.from(b64, "base64"));
  images.set(key, file);
  return file;
}

/** Pictures for the tree's svg / img / raster nodes; icon names collected. */
async function pictures(node, icons) {
  if (!node) return;
  if (node.kind === "icon") icons.add(node.icon);
  if (node.kind === "svg") {
    try {
      node.image = saveImage(node.svg, await rasterSvg(node.svg, node.w, node.h));
    } catch {
      node.image = null;
    }
    delete node.svg;
  }
  if (node.kind === "img") {
    try {
      node.image = saveImage(node.src, await imgToPng(node.src));
    } catch {
      node.image = null;
    }
  }
  if (node.kind === "raster" && node.w > 0 && node.h > 0) {
    const clip = { x: Math.max(0, node.x), y: Math.max(0, node.y), width: Math.min(node.w, 1440 - Math.max(0, node.x)), height: Math.min(node.h, 900 - Math.max(0, node.y)) };
    if (clip.width > 0 && clip.height > 0) {
      const b64 = (await page.screenshot({ clip })).toString("base64");
      node.image = saveImage(`raster${imageSeq}`, b64);
      Object.assign(node, { x: clip.x, y: clip.y, w: clip.width, h: clip.height });
    }
  }
  for (const c of node.children ?? []) await pictures(c, icons);
}

/** Pairs the dark colours (by element index) onto the tree. */
function addDark(node, dark) {
  if (!node) return;
  if (node.i != null && dark[node.i]) node.cd = dark[node.i];
  if (node.ci != null && dark[node.ci]) node.cd = dark[node.ci];
  if (node.pseudoOf != null && dark[node.pseudoOf]) {
    const p = dark[node.pseudoOf][node.which === "::before" ? "pb" : "pa"];
    if (p) node.cd = { bg: p[0], bt: p[1] };
  }
  for (const c of node.children ?? []) addDark(c, dark);
}

const setTheme = (el, theme) =>
  page.evaluate(
    async ({ sel, theme }) => {
      const t = sel ? document.querySelector(sel) : document.documentElement;
      document.documentElement.setAttribute("data-theme-switching", "");
      t.setAttribute("data-theme", theme);
      await new Promise((r) => setTimeout(r, 250));
    },
    { sel: el, theme }
  );

const icons = new Set();
const index = { screens: [], gallery: null, icons: {} };

for (const sc of SCENARIOS) {
  if (only && !only.includes(sc.id)) continue;
  try {
    if (sc.init) await page.addInitScript(sc.init);
    await page.goto(BASE + sc.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(sc.wait ?? 2500);
    for (const step of sc.steps ?? []) {
      await step(page);
      await page.waitForTimeout(400);
    }
    await page.mouse.move(1439, 899);
    await page.waitForTimeout(sc.settle ?? 500);
    await page.screenshot({ path: join(OUT, "shots", `${sc.id}.png`) });
    await inject();
    const tree = await page.evaluate(() => window.__uikit.capture("body", true));
    await setTheme(null, "dark");
    const dark = await page.evaluate(() => window.__uikit.readColors());
    await setTheme(null, "light");
    addDark(tree, dark);
    await pictures(tree, icons);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    writeFileSync(join(OUT, "screens", `${sc.id}.json`), JSON.stringify({ id: sc.id, title: sc.title, page: sc.page, width: 1440, height: 900, bg, tree }));
    index.screens.push({ id: sc.id, title: sc.title, page: sc.page });
    console.log("captured", sc.id);
  } catch (err) {
    console.warn("FAILED", sc.id, err.message.split("\n")[0]);
  }
}

if (withGallery) {
  await page.goto(BASE + "?gallery&theme=both&section=components&static=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await inject();
  // Each cell's content (its last child is the label), light column; then the light column switched to dark.
  const cells = await page.evaluate(() => {
    const out = [];
    const col = document.querySelector('[data-gallery-theme="light"]');
    window.__uikit.els = [];
    for (const cell of col.querySelectorAll("[data-gallery-id]")) {
      const kids = [...cell.children].slice(0, -1);
      const comp = cell.closest("[data-gallery-component]")?.getAttribute("data-gallery-component");
      const nodes = kids.map((k) => window.__uikit.walkOne(k)).flat().filter(Boolean);
      out.push({ gid: cell.dataset.galleryId, comp, nodes });
    }
    return out;
  });
  const gallery = cells;
  await setTheme('[data-gallery-theme="light"]', "dark");
  const dark = await page.evaluate(() => window.__uikit.readColors());
  await setTheme('[data-gallery-theme="light"]', "light");
  for (const c of gallery) for (const n of c.nodes) addDark(n, dark);
  for (const c of gallery) for (const n of c.nodes) await pictures(n, icons);
  writeFileSync(join(OUT, "gallery.json"), JSON.stringify(gallery));
  console.log("gallery cells", gallery.length);
}

// The icons' glyphs (4x, black: drawn as alpha masks under a colour layer).
mkdirSync(join(OUT, "icons"), { recursive: true });
const prev = (() => {
  try {
    return JSON.parse(readFileSync(join(OUT, "index.json"), "utf8"));
  } catch {
    return null;
  }
})();
const allIcons = new Set([...icons, ...Object.keys(prev?.icons ?? {})]);
for (const name of allIcons) {
  const box = ICONS[name][0];
  const b64 = await rasterSvg(iconSvg(name, 1), box, box, 4);
  writeFileSync(join(OUT, "icons", `${name}.png`), Buffer.from(b64, "base64"));
  index.icons[name] = box;
}
if (prev && only) index.screens = [...prev.screens.filter((s) => !index.screens.some((n) => n.id === s.id)), ...index.screens];
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
await browser.close();
console.log("icons", allIcons.size);
