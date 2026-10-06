// Loads the engine playground in headless Chromium (playwright-core), drives it
// like a person would and saves screenshots: the Wasm build loads, renders, and
// the gestures work end to end.
//
//   npm run engine:shot -- [outDir]     (default: $TMPDIR/engine-shots)
//
// Chromium: Google Chrome if installed, else Playwright's cached Chromium
// (CHROMIUM=/path overrides). Software GL (SwiftShader) for determinism.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(tmpdir(), "engine-shots"));
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
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
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

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__designerEngine && !window.__designerEngine.destroyed, null, { timeout: 15000 });
  await settle();
  const stats = await engine(() => window.__designerEngine.stats());
  check("wasm loads and renders", stats.drawCalls > 0, `${stats.nodes} nodes, ${stats.shapes} shapes, ${stats.drawCalls} draw calls`);
  const files = [await shot("01-playground")];

  // Click "Card" (1:5 at 24,88 in Desktop at 0,0): selected, with handles and the size badge.
  await page.mouse.click(...(await toScreen(100, 150)));
  await settle();
  let sel = await engine(() => window.__designerEngine.getSelection().refs);
  check("click selects the frame's child", sel.join() === "1:5", sel.join());
  files.push(await shot("02-selected"));

  // Drag it 60 px right: one undo step; ⌘Z puts it back.
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

  console.log(results.join("\n"));
  console.log(`\nscreenshots:\n${files.join("\n")}`);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
} catch (error) {
  console.log(results.join("\n"));
  console.error(error);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  await shot("error").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
