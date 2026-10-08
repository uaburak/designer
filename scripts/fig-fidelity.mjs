// .fig import fidelity (docs/roadmap.md Phase 5, docs/data-impl.md "Import fidelity"): Figma's own rendering of a
// file — the thumbnail.png in every .fig, meta.json's render_coordinates drawn at its thumbnail_size — against ours.
// For each file: the store's import (Node, as the store's utility process does) → the engine in headless Chromium
// (the app's load path: the snapshot's kiwi bytes, the system's fonts as the desktop indexes them, the file's images)
// → the same page and region drawn offscreen (engine_render_region, supersampled, then scaled down) → a perceptual
// diff against Figma's thumbnail, both composited over the file's canvas colour.
//
//   node scripts/fig-fidelity.mjs [--out dir] [--ss 2] [--json file] [--details] a.fig b.fig …
//   node scripts/fig-fidelity.mjs --samples        docs/research/figma/samples/*.fig
//
// Per file it prints the mean ΔE (CIE76 on Lab, after a 3×3 box blur of both images, so anti-aliasing and
// sub-pixel offsets count little), the share of pixels with ΔE > 10 ("bad") and > 25 ("very bad"), and writes
// <name>.ours.png, <name>.figma.png, <name>.diff.png (ΔE as a heat map over a dimmed copy of Figma's) and
// <name>.triplet.png (ours | Figma's | diff, 2× nearest) into --out (default $TMPDIR/fig-fidelity). --details adds
// the worst 8×8 cells (thumbnail px) to the report, to find what differs.
// --inspect "<js>" (or @file.js) runs code in the page after the render (`engine` in scope, an async function body) and prints
// its JSON: to look at what the engine made of a node.
//
// The page: the one holding DOCUMENT.thumbnailInfo's node ("Set as thumbnail"), else the first page.
// Private files: the output is the file's content — write it to a scratch directory, never into the repository.
// Guards (the machine is someone's): refuses to start under 25 % free memory, one browser, closed in `finally`, a
// hard timeout (--timeout s, default 180), aborts when Chrome's GPU process passes 3 GB.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const outDir = path.resolve(opt("--out", path.join(tmpdir(), "fig-fidelity")));
const ss = Math.max(1, Math.min(4, Number(opt("--ss", "2"))));
const jsonOut = opt("--json");
const timeoutSec = Number(opt("--timeout", "180"));
const details = flag("--details");
const inspectArg = opt("--inspect");
const inspect = inspectArg?.startsWith("@") ? readFileSync(inspectArg.slice(1), "utf8") : inspectArg;
const samples = flag("--samples");
// --ignore-derived: the snapshot without its derivedDataVersion stamp, so the engine lays everything out itself
// (what the import did before it kept Figma's derived data): to measure our layout against Figma's.
const ignoreDerived = flag("--ignore-derived");
// --view <page>,<x>,<y>,<w>,<h>,<width>: draw that region of that page (a GUID or an index among the pages) at that
// pixel width instead, ours only (<name>.view.png): to look at areas the thumbnail doesn't show.
const viewArg = opt("--view");
const files = [...argv];
if (samples) {
  const dir = path.join(repo, "docs/research/figma/samples");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".fig")).sort()) files.push(path.join(dir, f));
}
if (!files.length) {
  console.error("fig-fidelity: pass .fig files, or --samples");
  process.exit(1);
}
for (const f of files)
  if (!existsSync(f)) {
    console.error(`fig-fidelity: no file ${f}`);
    process.exit(1);
  }
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

function freeMemoryPercent() {
  try {
    const out = execFileSync("memory_pressure", [], { encoding: "utf8", timeout: 10000 });
    const m = /free percentage:\s*(\d+)%/.exec(out);
    return m ? Number(m[1]) : 100;
  } catch {
    return 100;
  }
}
// The footprint (MB) of the GPU processes under `pid` (Chrome's browser process).
function gpuFootprintMB(pid) {
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
    let total = 0;
    for (const l of ps.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      if (m && Number(m[2]) === pid && m[4].includes("--type=gpu-process")) total += Number(m[3]) / 1024;
    }
    return total;
  } catch {
    return 0;
  }
}

// ---- The page: the engine, the document, the region; the comparison ----------------------------------------------

function pageMain() {
  window.__fid = { ready: false };
  (async () => {
    const [{ Engine }, { fonts, BUNDLED_FACES }] = await Promise.all([import("@/engine/Engine.ts"), import("@/engine/fonts.ts")]);
    const system = await (await fetch("/__fid/fonts.json")).json();
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
        return new Uint8Array(await (await fetch(`/__fid/font?id=${encodeURIComponent(face.id)}`)).arrayBuffer());
      },
    });
    const canvas = document.getElementById("c");
    const engine = await Engine.create(canvas, { sessionID: 1, theme: "LIGHT" });
    engine.setViewport(64, 64, 1, 64, 64);
    const b64 = (bytes) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const pngOf = async (c) => b64(new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
    const toCanvas = (px) => {
      const c = new OffscreenCanvas(px.width, px.height);
      // The engine draws in the document's colour space; Figma's thumbnail is sRGB (a P3 file's colours converted).
      const colorSpace = engine.colorProfile === "DISPLAY_P3" ? "display-p3" : "srgb";
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px.pixels.slice().buffer), px.width, px.height, { colorSpace }), 0, 0);
      return c;
    };
    // sRGB → Lab (D65).
    const lin = new Float32Array(256).map((_, i) => {
      const c = i / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const lab = (r, g, b) => {
      const R = lin[r], G = lin[g], B = lin[b];
      const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
      const fx = f(x), fy = f(y), fz = f(z);
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    };
    const blur = (d, w, h) => {
      const out = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const o = (yy * w + xx) * 4;
              r += d[o];
              g += d[o + 1];
              b += d[o + 2];
              n++;
            }
          const o = (y * w + x) * 3;
          out[o] = r / n;
          out[o + 1] = g / n;
          out[o + 2] = b / n;
        }
      return out;
    };
    window.__fid = {
      ready: true,
      // Loads the snapshot, shows the page, waits for fonts and images, draws the region; compares with Figma's.
      async run({ id, page, region, thumbW, thumbH, ss, bg, figmaPng, details, inspect }) {
        const out = { problems: [] };
        window.__lastId = id;
        const snapshot = new Uint8Array(await (await fetch(`/__fid/doc.bin?id=${id}`)).arrayBuffer());
        engine.setImageSource(async (hash) => {
          const r = await fetch(`/__fid/image?id=${id}&hash=${hash}`);
          return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
        });
        const t0 = performance.now();
        const st = engine.loadKiwi(snapshot, page ? { page } : {});
        if (st !== 0) out.problems.push(`load status ${st}`);
        if (page) engine.setCurrentPage(page);
        engine.pump();
        const draw = () => engine.renderRegionPixels({ page: page ?? undefined, x: region.x, y: region.y, w: region.width, h: region.height, width: thumbW * ss, height: thumbH * ss });
        // Drawing asks for the fonts and images of what is in the region; repeat until nothing more arrives.
        for (let round = 0; round < 6; round++) {
          draw();
          engine.pump();
          await fonts.settled();
          engine.pump();
          await engine.imagesSettled();
          engine.pump();
        }
        const px = draw();
        out.loadMs = Math.round(performance.now() - t0);
        if (!px) {
          out.problems.push("render_region failed");
          return out;
        }
        // Ours, scaled down to the thumbnail (area-ish: the browser's high-quality resampling).
        const big = toCanvas(px);
        if (!figmaPng) {
          out.images = { view: await pngOf(big) };
          return out;
        }
        const W = thumbW, H = thumbH;
        const bgCss = `rgb(${Math.round(bg.r * 255)},${Math.round(bg.g * 255)},${Math.round(bg.b * 255)})`;
        const ours = new OffscreenCanvas(W, H);
        {
          const g = ours.getContext("2d");
          g.fillStyle = bgCss;
          g.fillRect(0, 0, W, H);
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = "high";
          g.drawImage(big, 0, 0, W, H);
        }
        const figma = new OffscreenCanvas(W, H);
        {
          const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${figmaPng}`)).blob());
          const g = figma.getContext("2d");
          g.fillStyle = bgCss;
          g.fillRect(0, 0, W, H);
          g.drawImage(img, 0, 0, W, H);
          if (img.width !== W || img.height !== H) out.problems.push(`thumbnail is ${img.width}×${img.height}, meta says ${W}×${H}`);
        }
        const A = ours.getContext("2d").getImageData(0, 0, W, H).data;
        const B = figma.getContext("2d").getImageData(0, 0, W, H).data;
        const a = blur(A, W, H), b = blur(B, W, H);
        const dE = new Float32Array(W * H);
        let sum = 0, bad = 0, veryBad = 0;
        for (let i = 0; i < W * H; i++) {
          const la = lab(Math.round(a[i * 3]), Math.round(a[i * 3 + 1]), Math.round(a[i * 3 + 2]));
          const lb = lab(Math.round(b[i * 3]), Math.round(b[i * 3 + 1]), Math.round(b[i * 3 + 2]));
          const d = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
          dE[i] = d;
          sum += d;
          if (d > 10) bad++;
          if (d > 25) veryBad++;
        }
        out.meanDE = sum / (W * H);
        out.bad = bad / (W * H);
        out.veryBad = veryBad / (W * H);
        // The diff: Figma's dimmed to grey, ΔE in red (10 → faint, ≥ 40 → full).
        const diff = new OffscreenCanvas(W, H);
        {
          const g = diff.getContext("2d");
          const im = g.createImageData(W, H);
          for (let i = 0; i < W * H; i++) {
            const grey = (B[i * 4] * 0.3 + B[i * 4 + 1] * 0.59 + B[i * 4 + 2] * 0.11) * 0.35 + 140;
            const t = Math.max(0, Math.min(1, (dE[i] - 4) / 36));
            im.data[i * 4] = grey * (1 - t) + 255 * t;
            im.data[i * 4 + 1] = grey * (1 - t);
            im.data[i * 4 + 2] = grey * (1 - t);
            im.data[i * 4 + 3] = 255;
          }
          g.putImageData(im, 0, 0);
        }
        const gap = 8;
        const trip = new OffscreenCanvas(W * 6 + gap * 2, H * 2);
        {
          const g = trip.getContext("2d");
          g.imageSmoothingEnabled = false;
          g.fillStyle = "#808080";
          g.fillRect(0, 0, trip.width, trip.height);
          g.drawImage(ours, 0, 0, W * 2, H * 2);
          g.drawImage(figma, W * 2 + gap, 0, W * 2, H * 2);
          g.drawImage(diff, W * 4 + gap * 2, 0, W * 2, H * 2);
        }
        if (details) {
          // The worst 8×8 cells, in thumbnail px and world coordinates.
          const cells = [];
          for (let cy = 0; cy < H; cy += 8)
            for (let cx = 0; cx < W; cx += 8) {
              let s = 0, n = 0;
              for (let y = cy; y < Math.min(H, cy + 8); y++) for (let x = cx; x < Math.min(W, cx + 8); x++) {
                  s += dE[y * W + x];
                  n++;
                }
              cells.push({ x: cx, y: cy, meanDE: s / n, world: { x: region.x + (cx / W) * region.width, y: region.y + (cy / H) * region.height } });
            }
          out.worst = cells.sort((p, q) => q.meanDE - p.meanDE).slice(0, 12);
        }
        out.images = { ours: await pngOf(ours), figma: await pngOf(figma), diff: await pngOf(diff), triplet: await pngOf(trip), big: await pngOf(big) };
        out.stats = engine.stats();
        if (inspect) out.inspect = await new Function("engine", `return (async () => { ${inspect} })()`)(engine);
        return out;
      },
    };
  })().catch((e) => {
    window.__fid = { error: String(e?.stack ?? e) };
  });
}

// ---- Server, import, browser ----------------------------------------------------------------------------------------

const docs = new Map();
const server = await createServer({
  configFile: false,
  mode: "demo",
  root: repo,
  resolve: { alias: [{ find: /^@\//, replacement: path.join(repo, "src/renderer/src") + "/" }] },
  server: { port: 5411, strictPort: false, fs: { allow: [repo] }, hmr: false, watch: null },
  appType: "custom",
  logLevel: "error",
  ssr: { noExternal: ["electron"] },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "fig-fidelity",
      enforce: "pre",
      // src/main/fonts.ts imports ./views (the WebContentsView wiring, which reads __dirname at load): a stub.
      resolveId: (id, importer) =>
        id === "/__fid/page.js"
          ? "\0fid-page"
          : id === "electron"
            ? "\0fid-electron"
            : id === "./views" && importer?.endsWith(path.join("src", "main", "fonts.ts"))
              ? "\0fid-views"
              : null,
      load: (id) =>
        id === "\0fid-page"
          ? `(${pageMain.toString()})();`
          : id === "\0fid-electron"
            ? `export const app = { getPath: () => ${JSON.stringify(path.join(tmpdir(), "designer-fig-fidelity"))} }; export const webContents = { getAllWebContents: () => [] }; export default { app };`
            : id === "\0fid-views"
              ? "export const viewOf = () => null;"
              : null,
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://x");
          const doc = docs.get(url.searchParams.get("id") ?? "");
          if (url.pathname === "/__fid/index.html") {
            const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="c" width="64" height="64"></canvas><script type="module" src="/__fid/page.js"></script></body></html>`;
            res.setHeader("content-type", "text/html");
            res.end(await s.transformIndexHtml(req.url, html));
            return;
          }
          if (url.pathname === "/__fid/doc.bin" && doc) {
            res.setHeader("content-type", "application/octet-stream");
            res.end(Buffer.from(doc.message));
            return;
          }
          if (url.pathname === "/__fid/image") {
            const bytes = doc?.images.get(url.searchParams.get("hash") ?? "");
            res.statusCode = bytes ? 200 : 404;
            res.end(bytes ? Buffer.from(bytes) : undefined);
            return;
          }
          if (url.pathname === "/__fid/fonts.json") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify((await systemFonts()).faces));
            return;
          }
          if (url.pathname === "/__fid/font") {
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

let browser = null;
let done = false;
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {
    // already gone
  }
  try {
    await server.close();
  } catch {
    // already closed
  }
};
const abort = async (why) => {
  if (done) return;
  done = true;
  console.error(`fig-fidelity: aborted — ${why}`);
  await cleanup();
  process.exit(3);
};
const hardTimeout = setTimeout(() => void abort(`over the ${timeoutSec} s time limit`), timeoutSec * 1000);
process.on("SIGINT", () => void abort("interrupted"));

const results = [];
let gpuWatch = null;
try {
  const free = freeMemoryPercent();
  if (free < 25) throw new Error(`only ${free}% of memory is free (need 25%)`);
  await server.listen();
  const base = server.resolvedUrls.local[0];
  var fontsModule = await server.ssrLoadModule(path.join(repo, "src/main/fonts.ts"));
  let fontIndexPromise = null;
  var systemFonts = () => (fontIndexPromise ??= fontsModule.fontIndex());
  void systemFonts();
  const { prepareFigImport } = await server.ssrLoadModule(path.join(repo, "src/store/import/fig.ts"));
  const { decodeMessage, encodeMessage } = await server.ssrLoadModule(path.join(repo, "src/shared/schema/codec.ts"));
  const { readFigFile } = await server.ssrLoadModule(path.join(repo, "src/shared/fig/figFile.ts"));
  const { nodeCodecs } = await server.ssrLoadModule(path.join(repo, "src/store/kiwi/codecs.ts"));

  browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const browserPid = browser.process?.()?.pid ?? 0;
  gpuWatch = setInterval(() => {
    const mb = gpuFootprintMB(browserPid);
    if (mb > 3072) void abort(`Chrome's GPU process uses ${mb.toFixed(0)} MB`);
  }, 2000);
  const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|404/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}__fid/index.html`);
  await page.waitForFunction(() => window.__fid && (window.__fid.ready || window.__fid.error), null, { timeout: 120000 });
  const bootError = await page.evaluate(() => window.__fid.error);
  if (bootError) throw new Error(bootError);

  for (const [i, file] of files.entries()) {
    const name = path.basename(file).replace(/\.fig$/i, "");
    const bytes = new Uint8Array(readFileSync(file));
    const fig = readFigFile(bytes, nodeCodecs);
    const meta = fig.meta?.client_meta;
    if (!viewArg && (!fig.thumbnail || !meta?.thumbnail_size || !meta?.render_coordinates)) {
      results.push({ name, skipped: "no thumbnail or render_coordinates" });
      continue;
    }
    const prepared = prepareFigImport(bytes, { name: path.basename(file), sessionID: 1 });
    // The page: DOCUMENT.thumbnailInfo's node's page, else the first page.
    const msg = decodeMessage(prepared.message);
    const key = (g) => `${g.sessionID}:${g.localID}`;
    const byId = new Map(msg.nodeChanges.filter((n) => n.guid).map((n) => [key(n.guid), n]));
    const docNode = byId.get("0:0");
    let pageGuid = null;
    const thumbNode = docNode?.thumbnailInfo?.nodeID;
    for (let cur = thumbNode ? byId.get(key(thumbNode)) : null, k = 0; cur && k < 1000; k++) {
      if (cur.type === "CANVAS") {
        pageGuid = key(cur.guid);
        break;
      }
      cur = cur.parentIndex ? byId.get(key(cur.parentIndex.guid)) : null;
    }
    if (!pageGuid) {
      const pages = msg.nodeChanges.filter((n) => n.type === "CANVAS" && !n.internalOnly && n.parentIndex && key(n.parentIndex.guid) === "0:0");
      pages.sort((p, q) => (p.parentIndex.position < q.parentIndex.position ? -1 : p.parentIndex.position > q.parentIndex.position ? 1 : 0));
      pageGuid = pages[0] ? key(pages[0].guid) : null;
    }
    let view = null;
    if (viewArg) {
      const [pg, x, y, w, h, width] = viewArg.split(",");
      const pages = msg.nodeChanges.filter((n) => n.type === "CANVAS" && n.parentIndex && key(n.parentIndex.guid) === "0:0").sort((p, q) => (p.parentIndex.position < q.parentIndex.position ? -1 : 1));
      pageGuid = /^\d+$/.test(pg) ? key(pages[Number(pg)].guid) : pg;
      view = { region: { x: +x, y: +y, width: +w, height: +h }, thumbW: Math.round(+width), thumbH: Math.round((+width * +h) / +w) };
    }
    const id = String(i);
    docs.set(id, { message: ignoreDerived ? encodeMessage({ ...msg, derivedDataVersion: 0 }) : prepared.message, images: prepared.images });
    const t0 = performance.now();
    const r = await page.evaluate((a) => window.__fid.run(a), {
      id,
      page: pageGuid,
      region: view?.region ?? meta.render_coordinates,
      thumbW: view?.thumbW ?? meta.thumbnail_size.width,
      thumbH: view?.thumbH ?? meta.thumbnail_size.height,
      ss: view ? 1 : ss,
      bg: meta?.background_color ?? { r: 1, g: 1, b: 1, a: 1 },
      figmaPng: view ? null : Buffer.from(fig.thumbnail).toString("base64"),
      details,
      inspect,
    });
    docs.delete(id);
    const entry = {
      name,
      page: pageGuid,
      thumbnailNode: thumbNode ? key(thumbNode) : null,
      size: view ? { width: view.thumbW, height: view.thumbH } : meta.thumbnail_size,
      region: view?.region ?? meta.render_coordinates,
      meanDE: r.meanDE,
      bad: r.bad,
      veryBad: r.veryBad,
      ms: Math.round(performance.now() - t0),
      problems: [...(r.problems ?? []), ...problems.splice(0)],
      ...(r.worst ? { worst: r.worst } : {}),
      ...(r.inspect !== undefined ? { inspect: r.inspect } : {}),
    };
    if (r.images) for (const [k, v] of Object.entries(r.images)) writeFileSync(path.join(outDir, `${name}.${k}.png`), Buffer.from(v, "base64"));
    results.push(entry);
    const pct = (x) => `${(x * 100).toFixed(2)}%`;
    console.log(
      view
        ? `${name}: view of ${pageGuid} written${entry.problems.length ? ` [${entry.problems.join("; ")}]` : ""}`
        : r.meanDE === undefined
        ? `${name}: failed — ${entry.problems.join("; ")}`
        : `${name.padEnd(28)} ΔE mean ${r.meanDE.toFixed(2).padStart(6)}   >10 ${pct(r.bad).padStart(7)}   >25 ${pct(r.veryBad).padStart(7)}   (${entry.size.width}×${entry.size.height}, ${entry.ms} ms)${entry.problems.length ? `  [${entry.problems.slice(0, 3).join("; ")}]` : ""}`
    );
    if (r.inspect !== undefined) console.log(JSON.stringify(r.inspect, null, 1));
    if (details && r.worst) for (const c of r.worst) console.log(`    cell (${c.x},${c.y}) ΔE ${c.meanDE.toFixed(1)}  world (${c.world.x.toFixed(0)}, ${c.world.y.toFixed(0)})`);
  }
  console.log(`\n${outDir}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
} catch (e) {
  console.error(`fig-fidelity: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  done = true;
  clearTimeout(hardTimeout);
  if (gpuWatch) clearInterval(gpuWatch);
  await cleanup();
}
