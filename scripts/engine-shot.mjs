// Loads the engine playground in headless Chromium (playwright-core), drives it
// like a person would and saves screenshots: the Wasm build loads, renders, and
// the gestures work end to end.
//
//   npm run engine:shot -- [outDir]     (default: $TMPDIR/engine-shots)
//   SHOT_ONLY=e4 npm run engine:shot    only the vector / paint / image / effect checks
//   SHOT_ONLY=e6 npm run engine:shot    only the component / instance checks
//   SHOT_ONLY=vars npm run engine:shot  only the variables / modes / styles checks
//   SHOT_ONLY=export npm run engine:shot  only the export checks (PNG = canvas, SVG / PDF drawn again)
//   SHOT_ONLY=e8 npm run engine:shot    only the prototyping checks (noodles, the presentation view)
//   npm run engine:shot -- --gfx webgpu  the same checks on the WebGPU backend (default --gfx webgl; SHOT_GFX too)
//
// Chromium: Google Chrome if installed, else Playwright's cached Chromium
// (CHROMIUM=/path overrides). WebGL: software GL (SwiftShader) for determinism. WebGPU: the real GPU (Metal on
// macOS; headless Chrome needs --enable-unsafe-webgpu, SwiftShader's WebGPU adapter is a fallback adapter the engine
// refuses). The run stops after SHOT_TIMEOUT seconds (default 180).
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const gfxAt = args.indexOf("--gfx");
const gfx = (gfxAt >= 0 ? args.splice(gfxAt, 2)[1] : process.env.SHOT_GFX) === "webgpu" ? "webgpu" : "webgl";
const outDir = path.resolve(args[0] ?? path.join(tmpdir(), gfx === "webgpu" ? "engine-shots-webgpu" : "engine-shots"));
mkdirSync(outDir, { recursive: true });

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

const server = await createServer({
  configFile: false,
  root: path.join(repo, "src/renderer/src/engine/dev"),
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: path.join(repo, "src/renderer/src") + "/" }] },
  server: { port: 0, fs: { allow: [repo] } },
  logLevel: "error",
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args:
    gfx === "webgpu"
      ? ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
// The machine is someone's: a hung run doesn't keep a browser (and its GPU memory) around.
const hardStop = setTimeout(async () => {
  console.error(`engine-shot: stopped after ${process.env.SHOT_TIMEOUT ?? 180} s`);
  await browser.close().catch(() => {});
  process.exit(2);
}, Number(process.env.SHOT_TIMEOUT ?? 180) * 1000);
hardStop.unref();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = async (name) => {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const engine = (fn, arg) => page.evaluate(fn, arg);
// World → page coordinates through the engine's camera (the canvas fills the page).
const toScreen = async (x, y) => {
  const c = await engine(() => window.__designerEngine.getCamera());
  return [x * c.zoom + c.x, y * c.zoom + c.y];
};
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const drag = async (from, to, steps = 8) => {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps });
  await page.mouse.up();
  await settle();
};

// A Figma sample (engine/tools/fixtures.mjs: every field, blobs, images) loaded into the playground, its images
// answered from the fixture's files.
const figmaDir = path.join(repo, "engine/tests/data/figma");
const loadSample = async (name) => {
  const message = JSON.parse(readFileSync(path.join(figmaDir, `${name}.full.json`), "utf8"));
  const images = {};
  for (const f of readdirSync(path.join(figmaDir, "images"))) images[f] = readFileSync(path.join(figmaDir, "images", f)).toString("base64");
  await engine(
    ({ message, images }) => {
      const e = window.__designerEngine;
      e.setImageSource(async (hash) => (images[hash] ? Uint8Array.from(atob(images[hash]), (c) => c.charCodeAt(0)) : null));
      e.load(message);
      e.command("ZOOM_TO_FIT");
    },
    { message, images }
  );
  await page.waitForTimeout(200);
  await engine(() => window.__designerEngine.imagesSettled());
  // Until the images that arrived have been drawn (at most 2 s).
  await page.waitForFunction(() => window.__designerEngine.stats().images >= 2, null, { timeout: 2000 }).catch(() => {});
  await settle();
};
const only = process.env.SHOT_ONLY ?? "";
// The colour on screen at CSS point (x, y): the page's own screenshot, decoded in the page.
const pixelsAt = async (points) => {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, points, dpr }) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return points.map(([x, y]) => Array.from(g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data));
    },
    { png, points, dpr: 2 }
  );
};
const near = (a, b, tol = 24) => a && b.every((v, i) => Math.abs(a[i] - v) <= tol);
// The world point (x, y) of a node's own space, through its ancestors (readNode transforms).
const worldOf = async (ref, x, y) =>
  engine(
    ({ ref, x, y }) => {
      const e = window.__designerEngine;
      let p = { x, y };
      for (let id = ref; id; ) {
        const n = e.readNode(id);
        if (!n || n.type === "CANVAS") break;
        const m = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
        p = { x: m.m00 * p.x + m.m01 * p.y + m.m02, y: m.m10 * p.x + m.m11 * p.y + m.m12 };
        id = n.parentIndex?.guid;
      }
      return p;
    },
    { ref, x, y }
  );
const screenOf = async (ref, x, y) => {
  const w = await worldOf(ref, x, y);
  return toScreen(w.x, w.y);
};

// A sheet of E4/E5 content: shapes, strokes, gradients, image modes, effects, blend modes, masks.
function e4Scene(imageHash) {
  const solid = (r, g, b, a = 1) => ({ type: "SOLID", color: { r, g, b, a: 1 }, opacity: a, visible: true });
  const T = (x, y, extra = {}) => ({ transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y }, ...extra });
  const stops = [
    { color: { r: 1, g: 0.2, b: 0.4, a: 1 }, position: 0 },
    { color: { r: 0.2, g: 0.4, b: 1, a: 1 }, position: 1 },
  ];
  const id = { n: 0 };
  const nodes = [];
  const add = (type, name, x, y, w, h, extra = {}, parent = "50:1") => {
    const guid = `50:${++id.n + 1}`;
    nodes.push({ guid, phase: "CREATED", type, name, parentIndex: { guid: parent, position: `!${String(id.n).padStart(3, "0")}` },
      size: { x: w, y: h }, ...T(x, y), fillPaints: [solid(0.85, 0.85, 0.85)], strokeWeight: 1, strokeAlign: "INSIDE", ...extra });
    return guid;
  };
  nodes.push({ guid: "50:1", phase: "CREATED", type: "FRAME", name: "E4 + E5", parentIndex: { guid: "0:1", position: "~~" },
    size: { x: 1240, y: 900 }, ...T(0, 1300), fillPaints: [solid(1, 1, 1)] });
  // Row 1: shapes.
  add("REGULAR_POLYGON", "Polygon", 20, 20, 100, 100, { count: 3 });
  add("STAR", "Star", 140, 20, 100, 100, { count: 5, starInnerScale: 0.382, fillPaints: [solid(1, 0.8, 0.1)] });
  add("STAR", "Star rounded", 260, 20, 100, 100, { count: 8, starInnerScale: 0.6, cornerRadius: 6, fillPaints: [solid(0.3, 0.7, 0.4)] });
  add("ELLIPSE", "Pie", 380, 20, 100, 100, { arcData: { startingAngle: 0, endingAngle: 4.5, innerRadius: 0 }, fillPaints: [solid(0.9, 0.3, 0.2)] });
  add("ELLIPSE", "Donut", 500, 20, 100, 100, { arcData: { startingAngle: 0, endingAngle: 6.283185307, innerRadius: 0.6 }, fillPaints: [solid(0.2, 0.5, 0.9)] });
  add("ROUNDED_RECTANGLE", "Squircle 60%", 620, 20, 100, 100, { cornerRadius: 30, cornerSmoothing: 0.6, fillPaints: [solid(0.5, 0.3, 0.9)] });
  add("LINE", "Line", 740, 70, 120, 0, { fillPaints: [], strokePaints: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: "CENTER", strokeCap: "ROUND" });
  add("LINE", "Arrow", 880, 30, 140, 0, { fillPaints: [], strokePaints: [solid(0, 0, 0)], strokeWeight: 2, strokeAlign: "CENTER", strokeCap: "ARROW_LINES",
    transform: { m00: 0.7071, m01: -0.7071, m02: 880, m10: 0.7071, m11: 0.7071, m12: 30 } });
  add("LINE", "Triangle arrow", 1040, 70, 160, 0, { fillPaints: [], strokePaints: [solid(0.9, 0.2, 0.3)], strokeWeight: 3, strokeAlign: "CENTER", strokeCap: "ARROW_EQUILATERAL" });
  // Row 2: strokes.
  const strokeBase = { fillPaints: [solid(0.95, 0.95, 0.95)], strokePaints: [solid(0.1, 0.1, 0.1)], strokeWeight: 8, starInnerScale: 0.45 };
  add("STAR", "Inside", 20, 160, 100, 100, { ...strokeBase, strokeAlign: "INSIDE", strokeJoin: "MITER" });
  add("STAR", "Center", 140, 160, 100, 100, { ...strokeBase, strokeAlign: "CENTER", strokeJoin: "ROUND" });
  add("STAR", "Outside", 260, 160, 100, 100, { ...strokeBase, strokeAlign: "OUTSIDE", strokeJoin: "BEVEL" });
  add("ROUNDED_RECTANGLE", "Dashed", 380, 160, 100, 100, { ...strokeBase, strokeWeight: 3, strokeAlign: "CENTER", dashPattern: [10, 6], cornerRadius: 16 });
  add("ELLIPSE", "Dotted", 500, 160, 100, 100, { ...strokeBase, strokeWeight: 4, strokeAlign: "CENTER", dashPattern: [0, 8], strokeCap: "ROUND" });
  add("ROUNDED_RECTANGLE", "Per side", 620, 160, 100, 100, { ...strokeBase, borderStrokeWeightsIndependent: true, borderTopWeight: 2, borderRightWeight: 8, borderBottomWeight: 14, borderLeftWeight: 0 });
  add("ROUNDED_RECTANGLE", "Gradient stroke", 740, 160, 100, 100, { fillPaints: [], strokeWeight: 10, strokeAlign: "INSIDE", cornerRadius: 24,
    strokePaints: [{ type: "GRADIENT_LINEAR", stops, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, opacity: 1, visible: true }] });
  // Row 3: gradients.
  const grad = (type, transform = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }) => ({ fillPaints: [{ type, stops, transform, opacity: 1, visible: true }] });
  add("ROUNDED_RECTANGLE", "Linear", 20, 300, 160, 100, grad("GRADIENT_LINEAR"));
  add("ROUNDED_RECTANGLE", "Linear 45°", 200, 300, 160, 100, grad("GRADIENT_LINEAR", { m00: 0.5, m01: 0.5, m02: 0, m10: -0.5, m11: 0.5, m12: 0.5 }));
  add("ROUNDED_RECTANGLE", "Radial", 380, 300, 160, 100, grad("GRADIENT_RADIAL"));
  add("ROUNDED_RECTANGLE", "Angular", 560, 300, 160, 100, grad("GRADIENT_ANGULAR"));
  add("ROUNDED_RECTANGLE", "Diamond", 740, 300, 160, 100, grad("GRADIENT_DIAMOND"));
  add("STAR", "Gradient star", 920, 300, 100, 100, { ...grad("GRADIENT_RADIAL"), starInnerScale: 0.5 });
  add("ROUNDED_RECTANGLE", "Two fills", 1040, 300, 160, 100, { fillPaints: [solid(1, 0.8, 0), { ...grad("GRADIENT_LINEAR").fillPaints[0], opacity: 0.5 }] });
  // Row 4: images.
  const img = (mode, extra = {}) => ({ type: "IMAGE", image: { hash: imageHash }, imageScaleMode: mode, opacity: 1, visible: true, scale: 0.25,
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, originalImageWidth: 1024, originalImageHeight: 512, ...extra });
  add("ROUNDED_RECTANGLE", "Fill", 20, 440, 160, 120, { fillPaints: [img("FILL")] });
  add("ROUNDED_RECTANGLE", "Fit", 200, 440, 160, 120, { fillPaints: [solid(0.9, 0.9, 0.9), img("FIT")] });
  add("ROUNDED_RECTANGLE", "Crop", 380, 440, 160, 120, { fillPaints: [img("STRETCH", { transform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 0.5, m12: 0.25 } })] });
  add("ROUNDED_RECTANGLE", "Tile", 560, 440, 160, 120, { fillPaints: [img("TILE")] });
  add("ELLIPSE", "Fill, rotated, filters", 740, 440, 160, 120, { fillPaints: [img("FILL", { rotation: 90, paintFilter: { exposure: 0.3, contrast: 0.3, vibrance: -1 } })] });
  add("ROUNDED_RECTANGLE", "Missing image", 920, 440, 120, 120, { fillPaints: [img("FILL", { image: { hash: "0123456789012345678901234567890123456789" } })] });
  // Row 5: effects.
  const fx = (effects, extra = {}) => ({ fillPaints: [solid(1, 1, 1)], cornerRadius: 12, effects, ...extra });
  const drop = (x, y, r, spread = 0, a = 0.35) => ({ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a }, offset: { x, y }, radius: r, spread, visible: true, blendMode: "NORMAL", showShadowBehindNode: false });
  const inner = (x, y, r, spread = 0) => ({ type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x, y }, radius: r, spread, visible: true, blendMode: "NORMAL" });
  add("ROUNDED_RECTANGLE", "Drop shadow", 20, 600, 120, 100, fx([drop(0, 8, 16)]));
  add("ROUNDED_RECTANGLE", "Spread", 170, 600, 120, 100, fx([drop(0, 0, 0, 6, 1)]));
  add("ROUNDED_RECTANGLE", "Inner shadow", 320, 600, 120, 100, fx([inner(4, 4, 8)], { fillPaints: [solid(0.6, 0.8, 1)] }));
  add("ELLIPSE", "Ellipse shadow", 470, 600, 100, 100, fx([drop(6, 6, 10)], { fillPaints: [solid(1, 0.6, 0.2)] }));
  add("STAR", "Star shadow + inner", 600, 600, 100, 100, fx([drop(0, 6, 8), inner(0, 4, 6)], { fillPaints: [solid(1, 0.85, 0.2)], starInnerScale: 0.5, cornerRadius: 4 }));
  add("ROUNDED_RECTANGLE", "Layer blur", 730, 600, 100, 100, fx([{ type: "FOREGROUND_BLUR", radius: 8, visible: true }], { fillPaints: [solid(0.2, 0.6, 0.3)] }));
  add("ROUNDED_RECTANGLE", "Behind glass", 860, 600, 160, 100, { fillPaints: [grad("GRADIENT_ANGULAR").fillPaints[0]] });
  add("ROUNDED_RECTANGLE", "Background blur", 900, 620, 140, 80, fx([{ type: "BACKGROUND_BLUR", radius: 12, visible: true }], { fillPaints: [solid(1, 1, 1, 0.3)] }));
  add("ROUNDED_RECTANGLE", "50% opacity", 1060, 600, 120, 100, { fillPaints: [solid(0.9, 0.2, 0.2)], strokePaints: [solid(0, 0, 0)], strokeWeight: 6, opacity: 0.5 });
  // Row 6: blend modes and masks.
  add("ELLIPSE", "Base", 20, 740, 120, 120, { fillPaints: [solid(1, 0.8, 0)] });
  add("ELLIPSE", "Multiply", 70, 740, 120, 120, { fillPaints: [solid(0.2, 0.6, 1)], blendMode: "MULTIPLY" });
  add("ELLIPSE", "Base 2", 220, 740, 120, 120, { fillPaints: [solid(1, 0.8, 0)] });
  add("ELLIPSE", "Difference", 270, 740, 120, 120, { fillPaints: [solid(0.2, 0.6, 1)], blendMode: "DIFFERENCE" });
  const group = add("FRAME", "Masked group", 440, 740, 200, 120, { resizeToFit: true, fillPaints: [] });
  add("ELLIPSE", "Mask", 0, 0, 120, 120, { mask: true, maskType: "ALPHA", fillPaints: [solid(0, 0, 0)] }, group);
  add("ROUNDED_RECTANGLE", "Masked", 40, 20, 160, 80, { fillPaints: [img("FILL")] }, group);
  const group2 = add("FRAME", "Vector mask", 680, 740, 200, 120, { resizeToFit: true, fillPaints: [] });
  add("STAR", "Star mask", 0, 0, 120, 120, { mask: true, maskType: "OUTLINE", fillPaints: [solid(0, 0, 0, 0.2)], starInnerScale: 0.5 }, group2);
  add("ROUNDED_RECTANGLE", "Under star", 0, 0, 200, 120, grad("GRADIENT_LINEAR"), group2);
  return { type: "NODE_CHANGES", sessionID: 0, nodeChanges: nodes };
}

async function e4Checks(files) {
  // structure.fig: the Sketch logo (8 vectors), two images, a group with a drop shadow, as Figma draws them.
  await loadSample("structure");
  const s1 = await engine(() => window.__designerEngine.stats());
  check("structure.fig draws its vectors as paths", s1.paths >= 8, `${s1.paths} paths, ${s1.layers} layers, ${s1.drawCalls} draw calls`);
  check("structure.fig's images are uploaded", s1.images >= 2, `${s1.images} images, ${(s1.imageBytes / 1024).toFixed(0)} KB`);
  files.push(await shot("30-structure-fig"));
  // Pixels Figma's own thumbnail shows: the logo's yellow, the banner's navy, the drop shadow under the first card.
  {
    const logo = await screenOf("1:33", 9.2, 4);  // the logo's top facet ("Vector", #FEEEB7)
    const banner = await screenOf("1:34", 30, 30);  // "social-twitter 1": an image, Fill
    const shadowAt = await screenOf("1:3", 50, 101.5);  // just under the first grey card
    const [pl, pb, ps] = await pixelsAt([logo, banner, shadowAt]);
    check("the logo's vectors are filled like Figma's", near(pl, [254, 238, 183, 255], 30), `${pl}`);
    check("the image fill (FILL) is drawn", pb && pb[2] > pb[0] && pb[0] < 60, `${pb}`);
    check("the group's drop shadow darkens what is under it", ps && ps[0] < 250 && ps[0] > 150, `${ps}`);
  }

  // The E4 / E5 sheet.
  await engine((message) => {
    const e = window.__designerEngine;
    e.applyChanges(message, "user");
    e.setSelection(["50:1"]);
    e.command("ZOOM_TO_SELECTION");
    e.setSelection([]);
  }, e4Scene("93e8eeb27e934c4b9ae9e7929c7df9e96a6ec90c"));
  await page.waitForTimeout(200);
  await engine(() => window.__designerEngine.imagesSettled());
  await settle();
  const s2 = await engine(() => window.__designerEngine.stats());
  check("the E4/E5 sheet draws", s2.paths > 20 && s2.layers >= 6, `${s2.paths} paths, ${s2.layers} layers, ${s2.drawCalls} draw calls`);
  files.push(await shot("31-e4-sheet"));
  {
    const inside = await screenOf("50:3", 50, 55);   // the yellow star
    const grad = await screenOf("50:18", 5, 50);     // the linear gradient's left end (pink)
    const gradR = await screenOf("50:18", 155, 50);  // and its right end (blue)
    const mul = await screenOf("50:41", 25, 60);      // the multiplied overlap of yellow and blue
    const blurred = await screenOf("50:36", 0, 50);   // the layer blur's soft edge
    const [ps, pg, pgr, pm, pb] = await pixelsAt([inside, grad, gradR, mul, blurred]);
    check("star fill", near(ps, [255, 204, 26, 255], 30), `${ps}`);
    check("linear gradient: pink → blue", pg && pgr && pg[0] > 200 && pgr[2] > 200 && pgr[0] < 120, `${pg} → ${pgr}`);
    check("MULTIPLY blends with what is below", pm && pm[0] < 80 && pm[1] > 80 && pm[1] < 170 && pm[2] < 60, `${pm}`);
    check("layer blur softens the edge", pb && pb[1] > 120 && pb[1] < 240, `${pb}`);
  }

  // Up close: vectors stay crisp at 3200 %.
  await engine(() => {
    const e = window.__designerEngine;
    e.setSelection(["50:3"]);
    e.command("ZOOM_TO_SELECTION");
    const c = e.getCamera();
    e.setCamera({ x: c.x, y: c.y, zoom: c.zoom });
    e.setSelection([]);
  });
  await page.mouse.move(5, 5);
  await settle();
  files.push(await shot("32-star-close"));

  // The Pen: four clicks and back to the first point make a closed, filled vector.
  await engine(() => {
    const e = window.__designerEngine;
    e.setSelection(["50:1"]);
    e.command("ZOOM_TO_SELECTION");
    e.setSelection([]);
  });
  await settle();
  await page.keyboard.press("p");
  const penPts = [[1100, 760], [1200, 760], [1200, 860], [1150, 900]];
  for (const [x, y] of penPts) await page.mouse.click(...(await screenOf("50:1", x, y)));
  await page.mouse.move(...(await screenOf("50:1", 1120, 880)));
  await settle();
  files.push(await shot("33-pen"));
  await page.mouse.click(...(await screenOf("50:1", 1100, 760)));
  await settle();
  const pen = await engine(() => {
    const e = window.__designerEngine;
    const ref = e.vectorEdit?.ref;
    return ref ? { node: e.readNode(ref), edit: e.vectorEdit } : null;
  });
  check("the Pen makes a closed vector", pen?.node?.type === "VECTOR" && pen.edit.vertexCount === 4 && pen.edit.segmentCount === 4,
    pen ? `${pen.node.name} ${pen.edit.vertexCount} points, ${pen.edit.segmentCount} segments` : "not editing");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle();
  const after = await engine(() => window.__designerEngine.vectorEdit);
  check("Esc leaves vector edit mode", after === null);

  // Double-click a star: vector edit mode, its points and the selected point's handles.
  await engine(() => window.__designerEngine.setSelection(["50:3"]));
  await page.waitForTimeout(600);  // not a triple click with the last one
  await page.mouse.dblclick(...(await screenOf("50:3", 50, 50)));
  await settle();
  const ve = await engine(() => window.__designerEngine.vectorEdit);
  check("double-click enters vector edit mode", ve?.active === true && ve.vertexCount === 10, ve ? `${ve.vertexCount} points` : "no");
  await page.mouse.click(...(await screenOf("50:3", 50, 0)));
  await settle();
  files.push(await shot("34-vector-edit"));
  await page.keyboard.press("Enter");

  // Booleans: two circles, ⌥⇧S.
  await engine(() => window.__designerEngine.setSelection(["50:42", "50:43"]));
  await page.keyboard.press("Alt+Shift+KeyS");
  await settle();
  const bool = await engine(() => {
    const e = window.__designerEngine;
    return e.readNode(e.getSelection().refs[0]);
  });
  check("⌥⇧S makes a Subtract boolean", bool?.type === "BOOLEAN_OPERATION" && bool.booleanOperation === "SUBTRACT", bool ? `${bool.name}` : "");
  files.push(await shot("35-boolean"));

  // Gradient handles on the linear gradient.
  await engine(() => {
    const e = window.__designerEngine;
    e.setSelection(["50:18"]);
    e.startPaintEdit("50:18", { paints: "FILL", index: 0 });
  });
  await settle();
  const pe = await engine(() => window.__designerEngine.paintEdit);
  check("gradient handles show", pe?.active === true && pe.ref === "50:18");
  files.push(await shot("36-gradient-handles"));
  await page.keyboard.press("Escape");

  // A thumbnail draws effects and images offscreen too.
  const thumb = await engine(() => {
    const t = window.__designerEngine.renderThumbnailPixels({ maxSize: 400 });
    if (!t) return null;
    let colours = new Set();
    for (let i = 0; i < t.pixels.length; i += 4 * 97) colours.add(`${t.pixels[i] >> 4},${t.pixels[i + 1] >> 4},${t.pixels[i + 2] >> 4}`);
    return { w: t.width, h: t.height, colours: colours.size };
  });
  check("thumbnails draw the new content", thumb && thumb.colours > 40, thumb ? `${thumb.w}×${thumb.h}, ${thumb.colours} colours` : "null");
}

// E6: components and instances — Figma's own instances (structure.fig), then a set, an instance and their purple.
async function e6Checks(files) {
  await loadSample("structure");
  await settle();
  {
    const red = await screenOf("I1:45;1:35", 20, 20);  // "Component 3": its rectangle overridden red
    const grey = await screenOf("I1:38;1:35", 20, 20);  // "Component 2": the main's grey
    const [pr, pg] = await pixelsAt([red, grey]);
    check("structure.fig's instance overrides draw (red rectangle)", near(pr, [255, 0, 0, 255], 40), `${pr}`);
    check("structure.fig's other instance keeps the main's fill", near(pg, [217, 217, 217, 255], 30), `${pg}`);
    const xyz = await engine(() => window.__designerEngine.readNode("I1:38;1:42")?.textData?.characters);
    check("its text override reads back", xyz === "XYZ", JSON.stringify(xyz));
  }
  // A click picks the instance whole; a double-click goes inside.
  await page.waitForTimeout(600);
  const at = await screenOf("1:45", 20, 20);
  await page.mouse.click(...at);
  await settle();
  let sel = await engine(() => window.__designerEngine.getSelection().refs);
  check("a click selects the instance whole", sel.join() === "1:45", sel.join());
  {
    // The selection box is purple (component colour) on the instance's top edge.
    const edge = await screenOf("1:45", 50, 0);
    const [pe] = await pixelsAt([edge]);
    check("an instance's selection is purple", pe && pe[0] > 110 && pe[2] > 200 && pe[1] < 120, `${pe}`);
  }
  files.push(await shot("40-instance-selected"));
  await page.mouse.dblclick(...at);
  await settle();
  sel = await engine(() => window.__designerEngine.getSelection().refs);
  check("double-click selects inside the instance", sel.join() === "I1:45;1:35", sel.join());
  await page.mouse.dblclick(...at);  // again: no vector editing inside an instance
  await settle();
  const ve = await engine(() => window.__designerEngine.vectorEdit);
  check("a shape inside an instance doesn't enter vector edit mode", ve === null, JSON.stringify(ve?.ref));

  // A component, a variant, a set and an instance made with the commands.
  const made = await engine(() => {
    const e = window.__designerEngine;
    const red = { type: "SOLID", color: { r: 0.95, g: 0.3, b: 0.3, a: 1 }, opacity: 1, visible: true };
    e.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [
      { guid: "60:1", phase: "CREATED", type: "FRAME", name: "Button", parentIndex: { guid: "0:1", position: "~~~" }, size: { x: 120, y: 40 },
        transform: { m00: 1, m01: 0, m02: 800, m10: 0, m11: 1, m12: 0 }, fillPaints: [red], cornerRadius: 8, rectangleCornerRadiiIndependent: false },
      { guid: "60:2", phase: "CREATED", type: "TEXT", name: "Label", parentIndex: { guid: "60:1", position: "!" }, size: { x: 80, y: 20 },
        transform: { m00: 1, m01: 0, m02: 20, m10: 0, m11: 1, m12: 10 }, textData: { characters: "Button" }, fontSize: 14,
        fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }], textAutoResize: "WIDTH_AND_HEIGHT" },
    ] }, "user");
    e.setSelection(["60:1"]);
    const created = e.command("CREATE_COMPONENT");
    const variant = e.command("ADD_VARIANT");
    const set = e.readNode("60:1")?.parentIndex?.guid;
    const inserted = e.command("INSERT_INSTANCE", { main: "60:1", x: 1100, y: 20 });
    const inst = e.getSelection().refs[0];
    e.setProps([`I${inst};60:2`], { textData: { characters: "Instance" } });
    e.setSelection([set, inst]);
    e.command("ZOOM_TO_SELECTION");
    e.setSelection([inst]);
    const info = e.componentInfo(inst);
    return { created, variant, inserted, set, inst, setNode: e.readNode(set), label: e.readNode(`I${inst};60:2`), info };
  });
  await settle();
  check("Create component + Add variant make a set", made.created === 0 && made.variant === 0 && made.setNode?.isStateGroup === true,
    `${made.setNode?.name}: ${made.setNode?.componentPropDefs?.map((d) => d.name).join()}`);
  check("an inserted instance takes a text override", made.inserted === 0 && made.label?.textData?.characters === "Instance",
    JSON.stringify(made.label?.textData?.characters));
  check("componentInfo reads the instance's variant and changes", made.info?.kind === "INSTANCE" && made.info.overrides.length === 1 &&
    made.info.properties[0]?.type === "VARIANT", `${made.info?.properties.map((p) => `${p.name}=${p.value}`).join(", ")}`);
  {
    const dash = await screenOf(made.set, 0.5, 30);  // the set's dashed purple stroke (left edge)
    const [pd] = await pixelsAt([dash]);
    check("a component set has the dashed purple stroke", pd && pd[2] > 180 && pd[1] < 160, `${pd}`);
    const top = await screenOf(made.inst, 60, 0);  // the selected instance's box: purple
    const [pt] = await pixelsAt([top]);
    check("the selected instance's box is purple", pt && pt[2] > 200 && pt[1] < 120, `${pt}`);
  }
  files.push(await shot("41-component-set-instance"));
}

// Variables, modes and styles (E6): two frames, Light and Dark, of the same bound content (fills, text, radius, padding,
// a colour style holding a variable, an instance of a bound component); a mode switch and a value edit redraw them.
async function variablesChecks(files) {
  const made = await engine(() => {
    const e = window.__designerEngine;
    const solid = (r, g, b) => ({ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true });
    const T = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
    const run = (name, args) => e.runCommand(name, args);
    const [set, light] = run("CREATE_VARIABLE_COLLECTION", { name: "Theme" }).created;
    run("RENAME_VARIABLE_MODE", { collection: set, mode: light, name: "Light" });
    const dark = run("ADD_VARIABLE_MODE", { collection: set, name: "Dark" }).created[0];
    const [prims, base] = run("CREATE_VARIABLE_COLLECTION", { name: "Primitives" }).created;
    const v = (collection, type, name, value) => run("CREATE_VARIABLE", { collection, type, name, value }).created[0];
    const blue = v(prims, "COLOR", "blue/500", { r: 0.05, g: 0.6, b: 1, a: 1 });
    const surface = v(set, "COLOR", "surface", { r: 1, g: 1, b: 1, a: 1 });
    const card = v(set, "COLOR", "card", { r: 0.94, g: 0.94, b: 0.94, a: 1 });
    const text = v(set, "COLOR", "text", { r: 0.1, g: 0.1, b: 0.1, a: 1 });
    const accent = v(set, "COLOR", "accent", { type: "VARIABLE_ALIAS", id: blue });
    const alpha = v(set, "FLOAT", "accent/alpha", 100);
    const tint = v(set, "COLOR", "accent/tint", { color: { type: "VARIABLE_ALIAS", id: accent }, opacity: { type: "VARIABLE_ALIAS", id: alpha } });
    const radius = v(set, "FLOAT", "radius", 8);
    const pad = v(set, "FLOAT", "space/pad", 16);
    const label = v(set, "STRING", "label", "Light mode");
    const set2 = (variable, value) => e.command("SET_VARIABLE_VALUE", { variable, mode: dark, value });
    set2(surface, { r: 0.12, g: 0.12, b: 0.12, a: 1 });
    set2(card, { r: 0.2, g: 0.2, b: 0.22, a: 1 });
    set2(text, { r: 1, g: 1, b: 1, a: 1 });
    set2(alpha, 40);
    set2(radius, 24);
    set2(pad, 32);
    set2(label, "Dark mode");
    // A component: a card (auto layout, padding bound) with a bound fill, a title and an accent bar.
    e.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [
      { guid: "70:1", phase: "CREATED", type: "FRAME", name: "Light", parentIndex: { guid: "0:1", position: "~~~~" }, size: { x: 360, y: 300 },
        transform: T(0, 3000), fillPaints: [solid(1, 1, 1)] },
      { guid: "70:2", phase: "CREATED", type: "FRAME", name: "Dark", parentIndex: { guid: "0:1", position: "~~~~~" }, size: { x: 360, y: 300 },
        transform: T(400, 3000), fillPaints: [solid(1, 1, 1)] },
      { guid: "70:10", phase: "CREATED", type: "SYMBOL", name: "Card", parentIndex: { guid: "0:1", position: "~~~~~~" }, size: { x: 240, y: 120 },
        transform: T(0, 3400), fillPaints: [solid(0.9, 0.9, 0.9)], stackMode: "VERTICAL", stackSpacing: 12, stackPrimarySizing: "FIXED",
        stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16 },
      { guid: "70:11", phase: "CREATED", type: "TEXT", name: "Title", parentIndex: { guid: "70:10", position: "!" }, size: { x: 100, y: 20 },
        transform: T(16, 16), textData: { characters: "Title" }, fontSize: 18, fontName: { family: "Inter", style: "Semi Bold", postscript: "" },
        textAutoResize: "WIDTH_AND_HEIGHT", fillPaints: [solid(0, 0, 0)] },
      { guid: "70:12", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Accent", parentIndex: { guid: "70:10", position: "\"" }, size: { x: 200, y: 24 },
        transform: T(16, 50), fillPaints: [solid(0, 0, 1)] },
    ] }, "user");
    const bind = (refs, target, variable) => e.command("BIND_VARIABLE", { refs, target, variable });
    bind(["70:1", "70:2"], "fillPaints[0].color", surface);
    bind(["70:10"], "fillPaints[0].color", card);
    bind(["70:10"], "CORNER_RADIUS", radius);
    for (const side of ["LEFT", "TOP", "RIGHT", "BOTTOM"]) bind(["70:10"], `STACK_PADDING_${side}`, pad);
    bind(["70:11"], "fillPaints[0].color", text);
    bind(["70:11"], "TEXT_DATA", label);
    // The accent bar through a colour style that holds the composed colour.
    const style = run("CREATE_STYLE", { type: "FILL", name: "Accent/Tint", from: "70:12", apply: true }).created[0];
    bind([style], "fillPaints[0].color", tint);
    // An instance in each frame; the Dark frame set to Dark.
    e.command("INSERT_INSTANCE", { main: "70:10", x: 180, y: 3150, parent: "70:1" });
    const i1 = e.getSelection().refs[0];
    e.command("INSERT_INSTANCE", { main: "70:10", x: 580, y: 3150, parent: "70:2" });
    const i2 = e.getSelection().refs[0];
    e.command("SET_VARIABLE_MODE", { refs: ["70:2"], collection: set, mode: dark });
    e.setSelection(["70:1", "70:2"]);
    e.command("ZOOM_TO_SELECTION");
    e.setSelection([]);
    return { set, light, dark, prims, base, blue, surface, card, alpha, style, i1, i2, rows: [`I${i1};70:12`, `I${i2};70:12`],
      titles: [e.readNode(`I${i1};70:11`)?.textData?.characters, e.readNode(`I${i2};70:11`)?.textData?.characters],
      pads: [e.readNode(`I${i1};70:11`)?.transform?.m02, e.readNode(`I${i2};70:11`)?.transform?.m02],
      collections: e.variableCollections().map((c) => c.name), styles: e.styles().map((s) => `${s.name}×${s.usageCount}`) };
  });
  await page.waitForTimeout(300);
  await settle();
  check("collections and a style exist", made.collections.join() === "Theme,Primitives" && made.styles.join() === "Accent/Tint×1",
    `${made.collections.join()} / ${made.styles.join()}`);
  check("instances resolve text and padding in their frame's mode", made.titles.join() === "Light mode,Dark mode" && made.pads.join() === "16,32",
    `${made.titles.join(" | ")}; padding ${made.pads.join(" | ")}`);
  const sample = async () => {
    const pts = [await screenOf("70:1", 10, 10), await screenOf("70:2", 10, 10), await screenOf(made.i1, 6, 100), await screenOf(made.i2, 6, 100),
      await screenOf(made.rows[0], 100, 12), await screenOf(made.rows[1], 100, 12)];
    return pixelsAt(pts);
  };
  let [lf, df, lc, dc, la, da] = await sample();
  check("Light frame: white surface, light card", near(lf, [255, 255, 255, 255], 6) && near(lc, [240, 240, 240, 255], 8), `${lf} / ${lc}`);
  check("Dark frame: dark surface, dark card", near(df, [31, 31, 31, 255], 8) && near(dc, [51, 51, 56, 255], 8), `${df} / ${dc}`);
  check("the style's composed colour: the accent alias at 100 % / 40 %", near(la, [13, 153, 255, 255], 12) && near(da, [28, 77, 113, 255], 30),
    `${la} / ${da}`);
  files.push(await shot("50-variables-modes"));
  // The Light frame switches to Dark; a primitive's value edit reaches both accents through the alias chain.
  const after = await engine((m) => {
    const e = window.__designerEngine;
    e.command("SET_VARIABLE_MODE", { refs: ["70:1"], collection: m.set, mode: m.dark });
    e.command("SET_VARIABLE_VALUE", { variable: m.blue, mode: m.base, value: { r: 1, g: 0.3, b: 0.1, a: 1 } });
    return { title: e.readNode(`I${m.i1};70:11`)?.textData?.characters };
  }, made);
  await settle();
  [lf, df, lc, dc, la, da] = await sample();
  check("a mode switch redraws the Light frame dark", near(lf, [31, 31, 31, 255], 8) && near(lc, [51, 51, 56, 255], 8) && after.title === "Dark mode",
    `${lf} / ${lc} / ${after.title}`);
  check("a primitive's edit reaches both accents (alias chain, style, instances)", la && la[0] > 80 && la[2] < 80 && da && da[0] > 80 && da[2] < 80,
    `${la} / ${da}`);
  files.push(await shot("51-mode-switch"));
  // Undo puts the Light frame back.
  await engine(() => {
    window.__designerEngine.undo();
    window.__designerEngine.undo();
  });
  await settle();
  [lf] = await sample();
  check("undo restores the Light frame", near(lf, [255, 255, 255, 255], 6), `${lf}`);
}

// E7: exports drawn by the engine against what the canvas shows; SVG and PDF drawn again by a browser / macOS and
// compared with the PNG export.
async function exportChecks(files) {
  // The E4 / E5 sheet (on its own run: the sample's images first, for the image fills).
  const has = await engine(() => !!window.__designerEngine.readNode("50:1"));
  if (!has) {
    await loadSample("structure");
    await engine((message) => window.__designerEngine.applyChanges(message, "user"), e4Scene("93e8eeb27e934c4b9ae9e7929c7df9e96a6ec90c"));
    await page.waitForTimeout(200);
    await engine(() => window.__designerEngine.imagesSettled());
  }
  // A text layer (Inter Semi Bold 40) for the vector writers' text: outlines in SVG, Type 3 glyphs in PDF.
  await engine(() =>
    window.__designerEngine.applyChanges(
      { type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "51:1", phase: "CREATED", type: "TEXT", name: "Export text",
        parentIndex: { guid: "0:1", position: "~~~" }, size: { x: 300, y: 48 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 2300 },
        textData: { characters: "Export 123" }, fontName: { family: "Inter", style: "Semi Bold", postscript: "" }, fontSize: 40, textAutoResize: "WIDTH_AND_HEIGHT",
        fillPaints: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.4, a: 1 }, opacity: 1, visible: true }] }] },
      "user"
    )
  );
  await page.waitForTimeout(300);
  await settle();
  const imageHash = "93e8eeb27e934c4b9ae9e7929c7df9e96a6ec90c";
  const imageB64 = readFileSync(path.join(figmaDir, "images", imageHash)).toString("base64");
  // Each layer's 2x PNG export against the canvas at 100 % (the page is 2 device px per CSS px): every opaque pixel.
  const layers = { "50:3": "star", "50:18": "linear gradient", "50:21": "angular gradient", "50:25": "image (Fill)", "50:31": "drop shadow", "50:12": "centre stroke" };
  for (const [ref, name] of Object.entries(layers)) {
    const info = await engine((ref) => window.__designerEngine.exportInfo([ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } }), ref);
    const b = info.targets[0].bounds;
    await engine(({ b }) => {
      const e = window.__designerEngine;
      e.setSelection([]);
      e.setCamera({ x: 100 - b.x, y: 100 - b.y, zoom: 1 });
    }, { b });
    await page.mouse.move(5, 5);
    await settle();
    await page.waitForTimeout(100);
    await engine(() => window.__designerEngine.imagesSettled());
    await settle();
    const png = (await page.screenshot()).toString("base64");
    const r = await page.evaluate(
      async ({ png, ref }) => {
        const e = window.__designerEngine;
        let out = e.exportNodes([ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } });
        for (let i = 0; out.status === "busy" && i < 50; i++) {
          await new Promise((r) => setTimeout(r, 60));
          out = e.exportNodes([ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } });
        }
        if (out.status !== "ok") return { error: JSON.stringify(out) };
        const { width, height, pixels } = out.pixels;
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const screen = g.getImageData(200, 200, width, height).data;
        let opaque = 0, same = 0;
        for (let i = 0; i < width * height; i++) {
          if (pixels[i * 4 + 3] !== 255) continue;
          opaque++;
          const d = Math.max(...[0, 1, 2].map((k) => Math.abs(pixels[i * 4 + k] - screen[i * 4 + k])));
          if (d <= 12) same++;
        }
        return { width, height, opaque, same };
      },
      { png, ref }
    );
    check(`PNG export = the canvas: ${name}`, !r.error && r.opaque > 100 && r.same / r.opaque >= 0.98,
      r.error ?? `${r.width}×${r.height}, ${r.same}/${r.opaque} opaque pixels match`);
  }
  files.push(await shot("40-export-canvas"));

  // SVG drawn again by the browser — an <img> on the page, on white, screenshotted at 2 device px per px (an SVG with a
  // foreignObject would taint a canvas) — against the 2x PNG export on white: every pixel.
  const svgLayers = { "50:3": "star", "50:12": "centre stroke", "50:11": "inside stroke", "50:13": "outside stroke", "50:18": "linear gradient",
    "50:19": "linear 45°", "50:20": "radial", "50:21": "angular", "50:22": "diamond", "50:25": "image (Fill)", "50:28": "image (Tile)",
    "50:31": "drop shadow", "50:33": "inner shadow", "50:36": "layer blur", "50:44": "alpha mask", "50:47": "vector mask", "51:1": "text (outlines)" };
  for (const [ref, name] of Object.entries(svgLayers)) {
    const shown = await page.evaluate(
      async ({ ref, imageHash, imageB64 }) => {
        const e = window.__designerEngine;
        const bytes = Uint8Array.from(atob(imageB64), (c) => c.charCodeAt(0));
        e.exportImage(imageHash, { kind: "file", width: 1024, height: 512, data: bytes });
        const svg = e.exportNodes([ref], { imageType: "SVG", svgOutlineText: true }, { allowPending: true });
        e.clearExportImages();
        if (svg.status !== "ok") return { error: svg.status };
        document.getElementById("svg-check")?.remove();
        const host = document.createElement("div");
        host.id = "svg-check";
        host.style.cssText = "position:fixed;left:0;top:0;z-index:99999;background:#fff;line-height:0";
        const img = new Image();
        img.src = URL.createObjectURL(new Blob([svg.bytes], { type: "image/svg+xml" }));
        host.appendChild(img);
        document.body.appendChild(host);
        try {
          await img.decode();
        } catch {
          return { error: "the SVG doesn't load" };
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { w: img.naturalWidth, h: img.naturalHeight, size: svg.bytes.length };
      },
      { ref, imageHash, imageB64 }
    );
    if (shown.error) {
      check(`SVG re-renders the same: ${name}`, false, shown.error);
      continue;
    }
    const shotB64 = (await page.screenshot({ clip: { x: 0, y: 0, width: shown.w, height: shown.h }, path: path.join(outDir, `41-svg-${ref.replace(":", "_")}.png`) })).toString("base64");
    const r = await page.evaluate(
      async ({ ref, shotB64 }) => {
        document.getElementById("svg-check")?.remove();
        const e = window.__designerEngine;
        const png = e.exportNodes([ref], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } }, { allowPending: true });
        if (png.status !== "ok") return { error: png.status };
        const { width, height, pixels } = png.pixels;
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${shotB64}`)).blob());
        const c = new OffscreenCanvas(width, height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, width, height);
        const drawn = g.getImageData(0, 0, width, height).data;
        let same = 0;
        for (let i = 0; i < width * height; i++) {
          const a = pixels[i * 4 + 3] / 255;
          let d = 0;
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(pixels[i * 4 + k] * a + 255 * (1 - a) - drawn[i * 4 + k]));
          if (d <= 24) same++;
        }
        return { width, height, same, total: width * height };
      },
      { ref, shotB64 }
    );
    // Photos (the browser resamples the original, the canvas a mipmapped texture), the engine's approximate blur and
    // flattened stroke outlines, and text (a fractional size: the <img> lands a sub-pixel off) differ at a few edge pixels
    // more than flat shapes do.
    const loose = /image|mask|inner|outside|text/.test(name);
    check(`SVG re-renders the same: ${name}`, !r.error && r.same / r.total >= (loose ? 0.93 : 0.97),
      r.error ?? `${r.width}×${r.height}, ${((100 * r.same) / r.total).toFixed(1)} % of pixels, ${shown.size} bytes`);
  }

  // PDF drawn by macOS (sips: CoreGraphics, 72 dpi = 1x) against the 1x PNG export, where the export is opaque.
  if (existsSync("/usr/bin/sips")) {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const pdfLayers = { "50:3": "star", "50:18": "linear gradient", "50:20": "radial gradient", "50:21": "angular gradient", "50:25": "image (Fill)", "50:12": "centre stroke", "50:11": "inside stroke", "50:31": "drop shadow (an image)", "50:44": "alpha mask", "51:1": "text (Type 3 glyphs)" };
    for (const [ref, name] of Object.entries(pdfLayers)) {
      const made = await page.evaluate(
        async ({ ref, imageHash, imageB64 }) => {
          const e = window.__designerEngine;
          // PDF images: a JPEG of the colour (the playground has no store: made here).
          const bytes = Uint8Array.from(atob(imageB64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes]));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          c.getContext("2d").drawImage(bmp, 0, 0);
          const jpeg = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
          e.exportImage(imageHash, { kind: "jpeg", width: bmp.width, height: bmp.height, data: jpeg });
          const pdf = e.exportNodes([ref], { imageType: "PDF" }, { allowPending: true });
          const png = e.exportNodes([ref], { imageType: "PNG" }, { allowPending: true });
          e.clearExportImages();
          if (pdf.status !== "ok" || png.status !== "ok") return { error: `${pdf.status} / ${png.status}` };
          let s = "";
          for (let i = 0; i < pdf.bytes.length; i += 0x8000) s += String.fromCharCode(...pdf.bytes.subarray(i, i + 0x8000));
          return { pdf: btoa(s), width: png.pixels.width, height: png.pixels.height, rgba: Array.from(png.pixels.pixels) };
        },
        { ref, imageHash, imageB64 }
      );
      if (made.error) {
        check(`PDF renders the same: ${name}`, false, made.error);
        continue;
      }
      const pdfPath = path.join(outDir, `export-${ref.replace(":", "_")}.pdf`);
      const pngPath = pdfPath.replace(/\.pdf$/, ".png");
      writeFileSync(pdfPath, Buffer.from(made.pdf, "base64"));
      try {
        execFileSync("/usr/bin/sips", ["-s", "format", "png", pdfPath, "--out", pngPath], { stdio: "ignore", timeout: 20000 });
      } catch (err) {
        check(`PDF renders the same: ${name}`, false, `sips: ${err.message}`);
        continue;
      }
      const drawn = readFileSync(pngPath).toString("base64");
      const r = await page.evaluate(
        async ({ drawn, width, height, rgba }) => {
          const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${drawn}`)).blob());
          const c = new OffscreenCanvas(width, height);
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0, width, height);
          const d = g.getImageData(0, 0, width, height).data;
          let opaque = 0, same = 0;
          for (let i = 0; i < width * height; i++) {
            if (rgba[i * 4 + 3] !== 255) continue;
            opaque++;
            const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(rgba[i * 4 + k] - d[i * 4 + k])));
            if (diff <= 24) same++;
          }
          return { pdfSize: [img.width, img.height], opaque, same };
        },
        { drawn, width: made.width, height: made.height, rgba: made.rgba }
      );
      check(`PDF renders the same: ${name}`, r.opaque > 50 && r.same / r.opaque >= 0.95 && r.pdfSize[0] === made.width,
        `${r.pdfSize.join("×")} pt, ${r.same}/${r.opaque} opaque pixels match`);
    }
  }

  // A 4x export of the whole sheet (4960 px wide) is drawn in tiles: no seam where they meet.
  const tiles = await page.evaluate(() => {
    const e = window.__designerEngine;
    const big = e.exportNodes(["50:1"], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 4 } }, { allowPending: true });
    const half = e.exportNodes(["50:1"], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } }, { allowPending: true });
    if (big.status !== "ok" || half.status !== "ok") return { error: `${big.status} / ${half.status}` };
    const B = big.pixels, H = half.pixels;
    // Around x = 4096 (the first tile's edge): the 4x pixels, averaged 2 × 2, against the 2x ones (a seam: far apart).
    let bad = 0, total = 0;
    for (let y = 0; y + 1 < B.height; y += 2)
      for (let x = 4088; x < 4104; x += 2) {
        for (let k = 0; k < 4; k++) {
          const at = (xx, yy) => B.pixels[(yy * B.width + xx) * 4 + k];
          const avg = (at(x, y) + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1)) / 4;
          const h = H.pixels[((y / 2) * H.width + x / 2) * 4 + k];
          total++;
          if (Math.abs(avg - h) > 96) bad++;
        }
      }
    return { size: [B.width, B.height], bad, total };
  });
  check("a 4x export larger than a texture is drawn in tiles, without seams", !tiles.error && tiles.size[0] === 4960 && tiles.bad / tiles.total < 0.01,
    tiles.error ?? `${tiles.size.join("×")}, ${tiles.bad} of ${tiles.total} samples apart at the tiles' edge`);
}

// Prototyping (E8): the editor's fixture (src/renderer/src/editor/fixtures.ts PROTOTYPE_DOCUMENT) in prototype mode —
// noodles and the flow label drawn by the engine —, then the presentation view on the same canvas: the flow's first
// frame on the prototype background, a click navigating, an overlay over a dimmed screen, scrolling.
async function e8Checks(files) {
  await engine(async (repo) => {
    const { PROTOTYPE_DOCUMENT } = await import(`/@fs${repo}/src/renderer/src/editor/fixtures.ts`);
    const e = window.__designerEngine;
    e.load(PROTOTYPE_DOCUMENT);
    e.setCamera({ x: 40, y: 60, zoom: 0.8 });
    e.setPrototypeMode(true);
    e.setSelection([]);
  }, repo);
  await settle();
  {
    // Next (24, 720, 327 × 56 in Home) → Details (475, 0): the noodle leaves Next's right edge at y 748.
    const mid = await toScreen(400, 748);
    const label = await toScreen(2.5, -20);  // the label's left padding
    const [pm, pl] = await pixelsAt([mid, label]);
    check("prototype mode: a noodle from Next to Details (blue)", pm && pm[2] > 180 && pm[0] < 120, `${pm}`);
    check("prototype mode: the flow's label above Home (blue)", pl && pl[2] > 180 && pl[0] < 120, `${pl}`);
  }
  await engine(() => window.__designerEngine.setSelection(["2:4"]));
  await settle();
  files.push(await shot("60-prototype-noodles"));
  // The presentation view: the flow's first frame, fitted, on #1E1E1E.
  const state = await engine(() => {
    const e = window.__designerEngine;
    e.setPrototypeMode(false);
    e.presentStart({ page: "0:1" });
    return e.presentState();
  });
  await page.waitForTimeout(100);
  await settle();
  const sp = (x, y) => [state.screenRect.x + (x * state.screenRect.w) / 375, state.screenRect.y + (y * state.screenRect.h) / 812];
  {
    const [bg, white, card] = await pixelsAt([[4, 400], sp(200, 600), sp(100, 200)]);
    check("presenting: Home on the prototype background", state.screen === "2:1" && near(bg, [30, 30, 30, 255], 6) && near(white, [255, 255, 255, 255], 6) && near(card, [13, 153, 255, 255], 12),
      `${state.screen} ${bg} ${white} ${card}`);
  }
  files.push(await shot("61-present-home"));
  // The carousel scrolls; Slide 2 moves left under the pointer.
  await page.mouse.move(...sp(200, 400));
  await page.mouse.wheel(250, 0);
  await page.waitForTimeout(50);
  await settle();
  {
    const [p] = await pixelsAt([sp(160, 410)]);
    check("presenting: the carousel scrolls sideways (Slide 2 under x 160)", near(p, [20, 174, 92, 255], 20), `${p}`);
  }
  files.push(await shot("62-present-scrolled"));
  // The menu button opens Menu from the bottom over a 40 % dim.
  await page.mouse.click(...sp(331, 60));
  await page.waitForTimeout(700);
  await settle();
  {
    const s = await engine(() => window.__designerEngine.presentState());
    const [dim, menu] = await pixelsAt([sp(200, 200), sp(100, 700)]);
    check("presenting: Open overlay — Menu at the bottom over the dimmed screen", JSON.stringify(s.overlays) === '["2:20"]' && near(dim, [8, 92, 153, 255], 12) && near(menu, [255, 255, 255, 255], 6),
      `${JSON.stringify(s.overlays)} ${dim} ${menu}`);
  }
  files.push(await shot("63-present-overlay"));
  // Outside it: closed. Next → Details (Smart animate), then there.
  await page.mouse.click(...sp(200, 200));
  await page.mouse.click(...sp(100, 740));
  await page.waitForTimeout(900);
  await settle();
  {
    const s = await engine(() => window.__designerEngine.presentState());
    const [card] = await pixelsAt([sp(200, 320)]);
    check("presenting: Next → Details, its card grown (Smart animate's end)", s.screen === "2:10" && near(card, [13, 153, 255, 255], 12), `${s.screen} ${card}`);
  }
  files.push(await shot("64-present-details"));
  await engine(() => window.__designerEngine.presentStop());
  await settle();
}

try {
  await page.goto(`${url}?gfx=${gfx === "webgpu" ? "webgpu" : "webgl"}`);
  await page.waitForFunction(() => window.__designerEngine && !window.__designerEngine.destroyed, null, { timeout: 15000 });
  await settle();
  const backend = await engine(() => window.__designerEngine.gfx);
  check(`the canvas draws with ${gfx === "webgpu" ? "WebGPU" : "WebGL2"}`, backend === (gfx === "webgpu" ? "webgpu" : "webgl2"), backend);
  if (only === "e4" || only === "e6" || only === "vars" || only === "export" || only === "e8") {
    const files = [];
    if (only === "e4") await e4Checks(files);
    else if (only === "e6") await e6Checks(files);
    else if (only === "export") await exportChecks(files);
    else if (only === "e8") await e8Checks(files);
    else await variablesChecks(files);
    console.log(results.join("\n"));
    console.log(`\nscreenshots:\n${files.join("\n")}`);
    if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
    process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
    throw "done";
  }
  const stats = await engine(() => window.__designerEngine.stats());
  check("wasm loads and renders", stats.drawCalls > 0, `${stats.nodes} nodes, ${stats.shapes} shapes, ${stats.drawCalls} draw calls`);
  const files = [await shot("01-playground")];

  // Click "Card" (1:5 at 24,88 in Desktop at 0,0): selected, with handles and the size badge.
  await page.mouse.click(...(await toScreen(100, 150)));
  await settle();
  let sel = await engine(() => window.__designerEngine.getSelection().refs);
  check("click selects the frame's child", sel.join() === "1:5", sel.join());
  files.push(await shot("02-selected"));

  // Drag it 60 px right: one undo step; ⌘Z puts it back. (Not within a double-click's time of the click.)
  await page.waitForTimeout(600);
  await drag(await toScreen(100, 150), await toScreen(160, 150));
  let card = await engine(() => window.__designerEngine.readNode("1:5"));
  check("drag moves", Math.round(card.transform.m02) === 84, `x = ${card.transform.m02}`);
  files.push(await shot("03-moved"));
  await page.keyboard.press("Meta+z");
  await settle();
  card = await engine(() => window.__designerEngine.readNode("1:5"));
  check("⌘Z undoes the move", Math.round(card.transform.m02) === 24, `x = ${card.transform.m02}`);

  // Hover outline over the ellipse "Ring".
  await page.mouse.move(...(await toScreen(260, 484)));
  await settle();
  files.push(await shot("04-hover"));

  // R, then draw a rectangle on empty canvas.
  await page.keyboard.press("r");
  await drag(await toScreen(1060, 40), await toScreen(1180, 160));
  sel = await engine(() => window.__designerEngine.getSelection().refs);
  const made = sel.length ? await engine((id) => window.__designerEngine.readNode(id), sel[0]) : null;
  check("R + drag draws a rectangle", made?.type === "ROUNDED_RECTANGLE" && made?.name?.startsWith("Rectangle"), made ? `${made.name} ${made.size.x}×${made.size.y}` : "nothing");
  files.push(await shot("05-drawn"));

  // Resize it from its bottom-right handle with ⇧.
  await page.keyboard.down("Shift");
  await drag(await toScreen(1180, 160), await toScreen(1240, 170));
  await page.keyboard.up("Shift");
  const resized = await engine((id) => window.__designerEngine.readNode(id), sel[0]);
  check("⇧ resize keeps the ratio", Math.abs(resized.size.x - resized.size.y) < 0.01, `${resized.size.x}×${resized.size.y}`);

  // Marquee across the page's bottom row.
  await page.mouse.click(...(await toScreen(1100, 700)));
  await drag(await toScreen(-30, 450), await toScreen(560, 640));
  sel = await engine(() => window.__designerEngine.getSelection().refs);
  check("marquee selects", sel.length >= 3, sel.join(", "));
  files.push(await shot("06-marquee"));

  // Zoom in around a point with ⌘-wheel (a pinch), then pan with the wheel.
  const before = await engine(() => window.__designerEngine.getCamera());
  await page.mouse.move(...(await toScreen(850, 200)));
  await page.keyboard.down("Meta");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Meta");
  await settle();
  const zoomed = await engine(() => window.__designerEngine.getCamera());
  check("⌘-wheel zooms", zoomed.zoom > before.zoom * 1.5, `${before.zoom.toFixed(3)} → ${zoomed.zoom.toFixed(3)}`);
  files.push(await shot("07-zoomed"));
  // (An emulated device scale can change the deltas Chromium delivers: compare with what the page got.)
  await page.evaluate(() => {
    window.__wheel = { dx: 0, dy: 0 };
    window.addEventListener("wheel", (e) => ((window.__wheel.dx += e.deltaX), (window.__wheel.dy += e.deltaY)), { capture: true });
  });
  await page.mouse.wheel(120, 80);
  await settle();
  const panned = await engine(() => window.__designerEngine.getCamera());
  const got = await page.evaluate(() => window.__wheel);
  check(
    "wheel pans",
    Math.abs(zoomed.x - panned.x - got.dx) < 0.5 && Math.abs(zoomed.y - panned.y - got.dy) < 0.5 && got.dx > 0,
    `moved ${(zoomed.x - panned.x).toFixed(0)}, ${(zoomed.y - panned.y).toFixed(0)} for wheel deltas ${got.dx}, ${got.dy}`
  );
  await page.keyboard.press("Shift+Digit1");
  await settle();
  files.push(await shot("08-fit"));

  // E3 text: T, click on empty canvas, type through the hidden field (the IME path), Esc.
  await page.waitForFunction(() => {
    const d = window.__designerEngine.textLayout ? true : false;
    return d;
  });
  await page.keyboard.press("t");
  const at = await toScreen(1100, 40);
  await page.mouse.click(...at);
  await settle();
  await page.keyboard.type("Hello Figma", { delay: 5 });
  await settle();
  files.push(await shot("09-typing"));
  const typed = await engine(() => {
    const e = window.__designerEngine;
    const ref = e.textEdit?.ref;
    return ref ? { node: e.readNode(ref), layout: e.textLayout(ref), focused: document.activeElement?.tagName } : null;
  });
  check(
    "T + click + typing makes a text",
    typed?.node?.type === "TEXT" && typed.node.textData?.characters === "Hello Figma" && typed.focused === "TEXTAREA",
    typed ? `"${typed.node?.textData?.characters}" ${typed.node?.size?.x?.toFixed(2)}×${typed.node?.size?.y} focus ${typed.focused}` : "not editing"
  );
  check("text is laid out with Inter (not missing)", typed?.layout && !typed.layout.missingFont && !typed.layout.pendingFont && typed.layout.glyphs.length === 11,
    typed?.layout ? `${typed.layout.glyphs.length} glyphs, line height ${typed.layout.baselines[0]?.lineHeight}` : "");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  await settle();
  files.push(await shot("10-text-selection"));
  const selected = await engine(() => window.__designerEngine.textSelection());
  check("⌥⇧← selects the last word", selected === "Figma", JSON.stringify(selected));
  await page.keyboard.press("Escape");
  await settle();
  const after = await engine(() => ({ edit: window.__designerEngine.textEdit, sel: window.__designerEngine.getSelection().refs }));
  check("Esc leaves editing, the text selected", after.edit === null && after.sel.length === 1, after.sel.join());

  // A typography sheet: sizes, weights, alignment, decoration, wrapping, a missing font.
  await engine(() => {
    const black = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];
    const blue = [{ type: "SOLID", color: { r: 0.05, g: 0.6, b: 1, a: 1 }, opacity: 1, visible: true }];
    const t = (id, x, y, characters, extra = {}) => ({
      guid: id, phase: "CREATED", type: "TEXT", parentIndex: { guid: "0:1", position: `~${id}` }, name: characters.slice(0, 20),
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y }, size: { x: 0, y: 0 }, fillPaints: black,
      textData: { characters }, textAutoResize: "WIDTH_AND_HEIGHT", autoRename: true, ...extra,
    });
    window.__designerEngine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [
      t("7:1", 0, 800, "Display 48 Bold", { fontSize: 48, fontName: { family: "Inter", style: "Bold", postscript: "" } }),
      t("7:2", 0, 870, "Heading 24 Semi Bold — the quick brown fox", { fontSize: 24, fontName: { family: "Inter", style: "Semi Bold", postscript: "" } }),
      t("7:3", 0, 910, "Body 14 Regular: Sphinx of black quartz, judge my vow. 0123456789", { fontSize: 14 }),
      t("7:4", 0, 935, "Caption 11 Medium, underlined", { fontSize: 11, fontName: { family: "Inter", style: "Medium", postscript: "" }, textDecoration: "UNDERLINE" }),
      t("7:5", 0, 960, "Italic 16 with fi ffi ligatures & kerning AV To", { fontSize: 16, fontName: { family: "Inter", style: "Italic", postscript: "" } }),
      t("7:6", 0, 990, "A fixed-width paragraph that wraps onto several lines, centred, with Auto line height and 8 px paragraph spacing.\nSecond paragraph.", {
        textAutoResize: "HEIGHT", size: { x: 240, y: 0 }, textAlignHorizontal: "CENTER", paragraphSpacing: 8, fillPaints: blue }),
      t("7:7", 300, 990, "Truncated text that is far too long for its two lines of room here", {
        textAutoResize: "HEIGHT", size: { x: 160, y: 0 }, textTruncation: "ENDING", maxLines: 2, fontSize: 13 }),
      t("7:8", 300, 1040, "A font nobody has", { fontName: { family: "Missing Font", style: "Regular", postscript: "" } }),
    ] }, "user");
    window.__designerEngine.setSelection(["7:1", "7:2", "7:3", "7:4", "7:5", "7:6", "7:7", "7:8"]);
    window.__designerEngine.command("ZOOM_TO_SELECTION");
    window.__designerEngine.setSelection([]);
  });
  await page.waitForTimeout(300);
  await settle();
  files.push(await shot("11-typography"));
  const sheet = await engine(() => ["7:1", "7:6", "7:7", "7:8"].map((id) => ({ node: window.__designerEngine.readNode(id), layout: window.__designerEngine.textLayout(id) })));
  check("auto width / auto height sizes", sheet[0].node.size.x > 300 && sheet[0].node.size.y === 58 && sheet[1].node.size.x === 240 && sheet[1].node.size.y > 60,
    `48px: ${sheet[0].node.size.x.toFixed(1)}×${sheet[0].node.size.y}; paragraph ${sheet[1].node.size.x}×${sheet[1].node.size.y}`);
  check("truncation", sheet[2].layout.truncationStartIndex > 0 && sheet[2].layout.baselines.length === 2, `at ${sheet[2].layout.truncationStartIndex}`);
  check("missing font marked", sheet[3].layout.missingFont === true);

  // Up close: glyphs stay crisp at 1600%.
  await engine(() => {
    const e = window.__designerEngine;
    e.setCamera({ x: -60 * 16 + 100, y: -800 * 16 + 100, zoom: 16 });
  });
  await settle();
  files.push(await shot("12-text-1600"));

  // Size badge and frame titles.
  await page.keyboard.press("Shift+Digit1");
  await settle();
  await engine(() => window.__designerEngine.setSelection(["1:1"]));
  await settle();
  files.push(await shot("13-badge-titles"));

  // E4 / E5.
  await e4Checks(files);
  // E6.
  await e6Checks(files);
  await variablesChecks(files);
  // E7.
  await exportChecks(files);
  // E8.
  await e8Checks(files);

  console.log(results.join("\n"));
  console.log(`\nscreenshots:\n${files.join("\n")}`);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
} catch (error) {
  if (error === "done") {
    await browser.close();
    await server.close();
    process.exit(process.exitCode ?? 0);
  }
  console.log(results.join("\n"));
  console.error(error);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  await shot("error").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
