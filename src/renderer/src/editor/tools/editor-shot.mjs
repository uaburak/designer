// The editor's visual and end-to-end check (docs/editor.md "Visual check"):
// loads `?editor` in headless Chromium (playwright-core, SwiftShader GL),
// shoots the states the reference screenshots show — nothing selected, a
// frame selected, the frame with auto layout — in dark and light at
// 1512 × 945, plus menus, Minimize UI and the shortcuts; then drives the
// editor like a person: draw a frame and a rectangle, Esc, ⌘Z / ⇧⌘Z,
// Delete, rename from the Layers panel, and checks the DocumentSource got
// every change.
//
//   node src/renderer/src/editor/tools/editor-shot.mjs [outDir]   (default /tmp/designer-work/editor)
//   EDITOR_URL=http://localhost:5202 node …                       (use a running server instead of starting one)
//   EDITOR_ONLY=paints node …                                      (only the E4 / E5 section: paints, effects, images, vectors)
//   EDITOR_ONLY=components node …                                  (only the E6 section: components, instances, Assets)
//   EDITOR_ONLY=variables node …                                   (only the variables / modes / styles section)
//   EDITOR_ONLY=libraries node …                                   (only the libraries section: publish, enable, insert, update)
//   EDITOR_ONLY=export node …                                      (only the export section: Export panel, dialog, Copy as PNG)
//   EDITOR_ONLY=prototype node …                                   (only the E8 section: Prototype tab, noodles, presentation view, inline preview)
//   EDITOR_ONLY=grid node …                                        (only the grid auto layout section: flow, counts, tracks, gaps, spans)
//   EDITOR_ONLY=text node …                                        (only the text round: specimen, Mixed runs, Type settings, links, lists)
//   EDITOR_ONLY=devmode node …                                     (only round 6: annotations, measurements, statuses, Dev Mode, Compare changes, focus view)
//   EDITOR_ONLY=fonts node …                                       (only the fonts section: font picker, Google fonts, Missing fonts)
//   EDITOR_ONLY=slots node …                                       (round 6: Convert to slot, an instance's slot, Limits, variant values)
//   EDITOR_ONLY=variables6 node …                                  (round 6: Import / Export mode menus, Minimize / Expand, Hide panel)
//   EDITOR_ONLY=selection node …                                   (round 7: sections, the canvas menu, keys, radius / gap / auto-layout handles, outlines)
//   EDITOR_ONLY=design node …                                      (round 7: the Design panel on the live capture's layers — a shot per case, fields' Enter / Esc / math, padding, gap Auto, menus)
//   EDITOR_ONLY=menus9 node …                                      (round 9 at 1440 × 900, run on its own: the Figma menu, canvas and tool menus, Actions, Preferences, right-drag pan, Assets, Variables)
//   EDITOR_ONLY=menus10 node …                                     (round 10 at 1440 × 900, run on its own: flush menus, key colours, frame title / Layers row menus, vector edit toolbar, Actions Recents, Assets grid, page rows, Find)
//   EDITOR_ONLY=menus11 node …                                     (round 11 at 1440 × 900, run on its own: Variables empty state and table, Tools filter, Actions Recents, toolbar lit row, tall Object submenu, key glyph widths, Flatten on an instance)
//   EDITOR_ONLY=header9 node …                                     (round 9: the header of a layer in a frame, Frame ▾, the boolean menu, the component / variant / instance panels, Component configuration, the swap menu)
//   EDITOR_ONLY=selection8 node …                                  (round 8: reorder rings, ⌥R origin, ruler guides, Scale / Slice / Comment / eyedropper, inline padding, Select layer icons, nudge, pixel preview)
//   EDITOR_ONLY=panel10 node …                                     (round 10 at 1440 × 900: Design panel states, popovers and sub-menus against the live captures)
//   EDITOR_ONLY=panel11 node …                                     (round 11 at 1440 × 900, run on its own: instance flow, text edit header, list menus, Text styles, Type settings › Details, gradient stops)
//   EDITOR_ONLY=overlays9 node …                                   (round 9, only on its own: shape handles, the </>, padding badge, grid cells and pills, section pill)
//   EDITOR_ONLY=features11 node …                                  (round 11 at 1440 × 900, run on its own: Create property › Slot as live's form, shader fills and effects — browsers, presets drawn, settings)
//   EDITOR_ONLY=grid12 node …                                      (round 12 at 1440 × 900, only on its own: a grid's gap boxes and gap drag, the row pill's click and its chevron's field and sizing list against the live captures)
//   EDITOR_ONLY=overlays11 node …                                  (round 11 at 1440 × 900, only on its own: the component set's "3 Variants" pill, "+" and gap boxes, no instance title, the text's baseline underline, smart selection dots)
//   EDITOR_PART=1 node … / EDITOR_PART=2 node …                     (the full run in two parts: the sections, then the main walk-through in both themes)
//   EDITOR_GFX=webgpu node …                                       (the canvas on WebGPU — the real GPU, Metal — instead of WebGL2 on SwiftShader)
//
// Every run fails on a GPU validation error on the console (WebGPU), a feedback loop (WebGL) or a draw the engine's
// own check skipped (gfx::samplesAttachment). The browser is closed after EDITOR_TIMEOUT seconds (default 180).
/* global process, console, window, document, navigator, requestAnimationFrame, fetch, setTimeout, performance, MediaRecorder, Blob, File, DataTransfer, DragEvent, localStorage, getComputedStyle, createImageBitmap, atob, btoa, Buffer, OffscreenCanvas, NodeFilter */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/designer-work/editor");
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

let server = null;
let base = process.env.EDITOR_URL;
if (!base) {
  server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.SHOT_PORT ?? 5312), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, "");
}

const gfx = process.env.EDITOR_GFX === "webgpu" ? "webgpu" : "webgl";
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args:
    gfx === "webgpu"
      ? ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
// The machine is someone's: a hung run doesn't keep a browser (and its GPU memory) around.
const hardStop = setTimeout(async () => {
  console.error(`editor-shot: stopped after ${process.env.EDITOR_TIMEOUT ?? 180} s`);
  await browser.close().catch(() => {});
  await server?.close().catch(() => {});
  process.exit(2);
}, Number(process.env.EDITOR_TIMEOUT ?? 180) * 1000);
hardStop.unref();
// GPU errors from any page of any context (the engine logs them as warnings: WebGPU's uncaptured errors, its own
// gfx::samplesAttachment check).
const gpuError = /WebGPU error|GPUDevice|GPUValidationError|Invalid CommandBuffer|is invalid due to a previous error|sampled the texture it renders into|feedback loop|GL_INVALID/i;
const gpuProblems = [];
const newContext = browser.newContext.bind(browser);
browser.newContext = async (options) => {
  const context = await newContext(options);
  context.on("console", (m) => {
    if (gpuError.test(m.text())) gpuProblems.push(m.text());
  });
  return context;
};
const gfxQuery = gfx === "webgpu" ? "&gfx=webgpu" : "";
const results = [];
const problems = [];
const files = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

let openedOnWebGPU = false;
async function open(page, query) {
  await page.goto(`${base}/?editor${query}${gfxQuery}`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
  if (gfx === "webgpu" && !openedOnWebGPU) {
    openedOnWebGPU = true;
    const backend = await page.evaluate(() => window.__designerEditor.engine.gfx);
    check("the canvas draws with WebGPU", backend === "webgpu", backend);
  }
  await settle(page);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const shot = async (page, name) => {
  await settle(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  files.push(file);
};
/** Page coordinates of a document point (through the camera; the canvas's offset in the window). */
const toScreen = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const ed = window.__designerEditor;
      const c = ed.engine.getCamera();
      const r = ed.canvas.getBoundingClientRect();
      return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y];
    },
    [x, y]
  );
const drag = async (page, from, to, steps = 8) => {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps });
  await page.mouse.up();
  await settle(page);
};
const selection = (page) => page.evaluate(() => window.__designerEditor.selection);
const node = (page, id) => page.evaluate((id) => window.__designerEditor.engine.readNode(id), id);

const only = process.env.EDITOR_ONLY ?? "";
// The full run in two parts, each within the 180 s stop on a busy machine: EDITOR_PART=1 the sections, 2 the main
// walk-through (both themes); unset, both.
const part = process.env.EDITOR_PART ?? "";

/** E4 / E5 in the panels on `?editor&doc=paints` (dark): paints of every type, effects, guides, strokes, booleans, images, vector edit. */
async function paintsSection(page, theme) {
  await open(page, "&doc=paints");
  const panel = page.locator('[data-panel="right"]');
  const select = async (...ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const capable = await page.evaluate(() => {
    const ed = window.__designerEditor;
    return { vector: ed.vector.available, tools: [...ed.tools], paintEdit: typeof ed.engine.startPaintEdit === "function" };
  });
  results.push(`info engine: tools ${capable.tools.join(" ")}; vector edit ${capable.vector}; gradient handles ${capable.paintEdit}`);

  // Gradients: the row names the type; the picker opens on it (the engine's handles, when it has them).
  await select("2:2");
  check("a gradient fill reads Linear", (await panel.getByRole("button", { name: "Color: Linear" }).count()) === 1);
  await shot(page, `25-gradient-row-${theme}`);
  await panel.getByRole("button", { name: "Color: Linear" }).click();
  await settle(page);
  const picker = page.getByRole("dialog", { name: "Color picker" });
  check("the picker opens on the gradient with its stops", (await picker.getByRole("slider", { name: "Stop 2" }).count()) === 1);
  if (capable.paintEdit) check("the gradient handles are on while the picker shows it", await page.evaluate(() => !!window.__designerEditor.engine.paintEdit));
  await shot(page, `26-gradient-picker-${theme}`);
  // Figma's live picker: the Gradient tab's own "Paint type" dropdown.
  await picker.getByRole("combobox", { name: "Paint type" }).click();
  await page.getByRole("option", { name: "Radial" }).click();
  await settle(page);
  check("the picker turns it Radial", (await node(page, "2:2")).fillPaints[0].type === "GRADIENT_RADIAL");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");

  // Selection colors list a frame's gradients as rows.
  await select("2:1");
  const seeAll = panel.locator('section[aria-label="Selection colors"]').getByRole("button", { name: /^See all/ });
  if (await seeAll.count()) await seeAll.click();
  check("Selection colors list gradients (one row each)", (await panel.locator("section[aria-label=\"Selection colors\"]").getByRole("button", { name: "Color: Diamond" }).count()) === 1);
  await shot(page, `27-selection-colors-gradients-${theme}`);

  // Effects: the row, its settings (live Figma's popover); "+" opens the Shader effects (Beta) browser while its
  // onboarding card is up, then adds Figma's drop shadow.
  await select("2:10");
  check("an effect row reads Drop shadow", (await panel.locator('[data-effect-row="DROP_SHADOW"]').count()) === 1 && (await panel.locator('[data-effect-row="DROP_SHADOW"]').getByText("Drop shadow").count()) === 1);
  await panel.getByRole("button", { name: "Effect settings" }).click();
  await settle(page);
  const fx = page.getByRole("dialog", { name: "Drop shadow" });
  check("the effect settings: type, blend mode, X, Y, Blur, Spread, colour", (await fx.getByRole("combobox", { name: "Effect settings" }).count()) === 1 && (await fx.getByRole("button", { name: "Blend mode" }).count()) === 1 &&
    (await fx.getByRole("textbox", { name: "Position Y" }).count()) === 1 && (await fx.getByRole("textbox", { name: "Blur radius" }).count()) === 1 && (await fx.getByRole("textbox", { name: "Spread" }).count()) === 1);
  await shot(page, `28-effect-settings-${theme}`);
  await page.keyboard.press("Escape");
  await select("2:11");
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  const browser = page.getByRole("dialog", { name: "Shader effects" });
  if ((await browser.count()) === 1) {
    check("the first + opens Shader effects (Beta): search, the card, Figma's presets", (await browser.getByText("Beta").count()) === 1 && (await browser.locator("[data-shader-onboarding]").count()) === 1 && (await browser.locator("[data-shader-preset]").count()) === 25);
    await shot(page, `29-shader-effects-${theme}`);
    await browser.getByRole("button", { name: "Got it" }).click();
    await settle(page);
    await panel.getByRole("button", { name: "Add effect" }).click();
    await settle(page);
  }
  const added = (await node(page, "2:11")).effects ?? [];
  const last = added[added.length - 1];
  check("+ adds a drop shadow 0 4 4 0 #000 25%", added.length === 2 && last.type === "DROP_SHADOW" && last.offset.y === 4 && last.radius === 4 && Math.abs(last.color.a - 0.25) < 0.01, JSON.stringify(last));
  // The new types through the header's type menu: Layer blur → Progressive (Start, End), Noise, Texture, Glass.
  const fxOf = async (name) => {
    await panel.getByRole("button", { name: "Effect settings" }).first().click();
    await settle(page);
    return page.getByRole("dialog", { name });
  };
  const retype = async (dialog, label) => {
    await dialog.getByRole("combobox", { name: "Effect settings" }).click();
    await page.getByRole("option", { name: label }).click();
    await settle(page);
  };
  {
    let d = await fxOf("Drop shadow");
    await retype(d, "Layer blur");
    d = page.getByRole("dialog", { name: "Layer blur" });
    await d.getByRole("radio", { name: "Progressive" }).click();
    await settle(page);
    const blur = (await node(page, "2:11")).effects.at(-1);
    check("Layer blur → Progressive: Start 0, End 4, stored as blurOpType", blur.type === "FOREGROUND_BLUR" && blur.blurOpType === "PROGRESSIVE" && blur.startRadius === 0 && blur.radius === 4 &&
      (await d.getByRole("textbox", { name: "Start" }).count()) === 1 && (await d.getByRole("textbox", { name: "End" }).count()) === 1, JSON.stringify(blur));
    await shot(page, `29a-effect-progressive-${theme}`);
    await retype(d, "Noise");
    d = page.getByRole("dialog", { name: "Noise" });
    check("Noise: Mono / Duo / Multi, size, density, colour, blend mode", (await d.getByRole("radio", { name: "Duo" }).count()) === 1 && (await d.getByRole("textbox", { name: "Noise size X" }).count()) === 1 &&
      (await d.getByRole("textbox", { name: "Density" }).count()) === 1 && (await d.getByRole("button", { name: "Blend mode" }).count()) === 1);
    await shot(page, `29b-effect-noise-${theme}`);
    await retype(d, "Texture");
    d = page.getByRole("dialog", { name: "Texture" });
    check("Texture: size, radius, Clip to shape", (await d.getByRole("textbox", { name: "Size Y" }).count()) === 1 && (await d.getByRole("textbox", { name: "Radius" }).count()) === 1 && (await d.getByText("Clip to shape").count()) === 1);
    await retype(d, "Glass");
    d = page.getByRole("dialog", { name: "Glass" });
    const glass = (await node(page, "2:11")).effects.at(-1);
    check("Glass: light dial, Angle −45°, Intensity, Refraction … Splay", glass.type === "GLASS" && glass.specularAngle === -45 && (await d.getByRole("slider", { name: "Light" }).count()) === 1 &&
      (await d.getByRole("slider", { name: "Splay" }).count()) === 1 && (await d.getByRole("textbox", { name: "Dispersion" }).count()) === 1, JSON.stringify(glass));
    await shot(page, `29c-effect-glass-${theme}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await settle(page);
  }
  await panel.getByRole("button", { name: "Blend mode" }).first().click();
  await settle(page);
  await shot(page, `29-blend-mode-${theme}`);
  await page.keyboard.press("Escape");

  // Layout guide: rows and the settings.
  await select("2:50");
  check("layout guide rows: Columns 4, Grid 20px", (await panel.getByText("Columns 4").count()) === 1 && (await panel.getByText("Grid 20px").count()) === 1);
  await panel.getByRole("button", { name: "Layout guide settings" }).first().click();
  await settle(page);
  await shot(page, `30-layout-guide-${theme}`);
  await page.keyboard.press("Escape");

  // Stroke: settings (dash 6 / gap 4), individual strokes.
  await select("2:40");
  await panel.getByRole("button", { name: "Advanced stroke settings" }).click();
  await settle(page);
  const ss = page.getByRole("dialog", { name: "Stroke settings" });
  check("stroke settings read the dash pattern", (await ss.getByRole("textbox", { name: "Dash" }).inputValue()) === "6" && (await ss.getByRole("textbox", { name: "Gap" }).inputValue()) === "4");
  await shot(page, `31-stroke-settings-${theme}`);
  await page.keyboard.press("Escape");
  await select("2:41");
  check("a bottom-only stroke reads Custom/Bottom", (await panel.getByRole("button", { name: "Individual strokes" }).count()) === 1);
  await panel.getByRole("button", { name: "Individual strokes" }).click();
  // (Live stroke-individual-strokes-menu.txt: the sides are menuitemradio.)
  await page.getByRole("menuitemradio", { name: "Custom" }).click();
  await settle(page);
  check("Custom shows the four side weights", (await panel.getByRole("textbox", { name: "Top stroke" }).count()) === 1);
  await shot(page, `32-individual-strokes-${theme}`);

  // Booleans: the header's menu on two shapes; a boolean group's operation.
  await select("2:10", "2:11");
  const booleans = panel.getByRole("button", { name: "Boolean operations" });
  const menuOn = await booleans.isEnabled();
  if (menuOn) {
    await booleans.click();
    await settle(page);
  }
  await shot(page, `33-boolean-menu-${theme}`);
  const union = page.getByRole("menuitemcheckbox", { name: /^Union/ });
  const unionEnabled = menuOn && (await union.count()) === 1 && (await union.getAttribute("aria-disabled")) !== "true";
  if (unionEnabled) {
    await union.click();
    await settle(page);
    const made = await page.evaluate(() => window.__designerEditor.selectedNodes().map((n) => n.type));
    check("Union selection makes a boolean group", made.join() === "BOOLEAN_OPERATION", made.join());
    await page.keyboard.press("Meta+z");
  } else {
    if (menuOn) await page.keyboard.press("Escape");
    results.push("info Union selection: disabled (the engine has no BOOLEAN_UNION yet)");
  }
  await select("2:30");
  check("a boolean group reads Subtract", (await panel.getByText("Subtract", { exact: true }).count()) >= 1);

  // Images: ⇧⌘K → the file picker → a click places it at its size, filled; the store has the bytes.
  await select();
  await page.locator("#engine-canvas").focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Shift+Meta+KeyK");
  await (await chooser).setFiles(path.join(repo, "build/icon.png"));
  await page.locator("[data-image-placer]").waitFor({ timeout: 5000 });
  await page.mouse.move(...(await toScreen(page, 40, 620)));
  await page.mouse.move(...(await toScreen(page, 60, 640)), { steps: 4 });
  await shot(page, `34-image-placing-${theme}`);
  await page.mouse.click(...(await toScreen(page, 60, 640)));
  await settle(page);
  const placed = await page.evaluate(() => window.__designerEditor.selectedNodes()[0] ?? null);
  const fill = placed?.fillPaints?.[0];
  check("a click places the image: a rectangle its size, IMAGE fill, named after the file", placed?.name === "icon" && fill?.type === "IMAGE" && Array.isArray(fill.image?.hash) && fill.image.hash.length === 20 && Math.round(placed.transform.m02) === 60, placed ? `${placed.name} ${placed.size.x}×${placed.size.y} ${fill?.type}` : "nothing");
  check("the image's bytes are in the file's image store", await page.evaluate(async (h) => !!(await window.__designerEditor.source.images.get(h)), fill ? fill.image.hash.map((b) => b.toString(16).padStart(2, "0")).join("") : ""));
  await page.evaluate(() => window.__designerEditor.engine.command("ZOOM_TO_SELECTION"));
  await shot(page, `35-image-placed-${theme}`);
  await panel.getByRole("button", { name: "Color: Image" }).click();
  await settle(page);
  check("the image picker: scale mode, Choose image, Rotate 90°, adjustments", (await page.getByRole("slider", { name: "Exposure" }).count()) === 1 && (await page.getByRole("button", { name: "Rotate 90º", exact: true }).count()) === 1);
  await shot(page, `36-image-picker-${theme}`);
  await page.getByRole("button", { name: "Rotate 90º", exact: true }).click();
  check("Rotate 90° turns the image", (await page.evaluate(() => window.__designerEditor.selectedNodes()[0].fillPaints[0].rotation)) === 90);
  await page.keyboard.press("Escape");

  // Vector edit mode: the toolbar switches; Done leaves.
  if (capable.vector) {
    // A star's header (Figma's live panel) has no Edit object button: it is in More actions.
    await select("2:20");
    await panel.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Edit object" }).click();
    await settle(page);
    // Round 10 (live toolbar/vector-edit-toolbar.txt): a secondary toolbar over the bottom one, ✕ Close leaves.
    check("vector edit mode: the vector-edit toolbar over the bottom toolbar, with Close", (await page.locator("[data-vector-toolbar]").count()) === 1 && (await page.locator('[data-ds="EditorToolbar"]').count()) === 1);
    await shot(page, `37-vector-edit-${theme}`);
    await page.locator("[data-vector-toolbar]").getByRole("button", { name: "Close", exact: true }).click();
    await settle(page);
    check("Close leaves vector edit mode", (await page.locator("[data-vector-toolbar]").count()) === 0);
  } else results.push("info vector edit: the engine has no startVectorEdit yet");

  // The new tools (when the engine has them): L draws a line.
  if (capable.tools.includes("LINE")) {
    await page.locator("#engine-canvas").focus();
    await page.keyboard.press("l");
    // In screen space near the canvas's top left: the fitted content can reach under the toolbar.
    const area = await page.locator("#engine-canvas").boundingBox();
    await drag(page, [area.x + 60, area.y + 60], [area.x + 260, area.y + 60]);
    const line = await page.evaluate(() => window.__designerEditor.selectedNodes()[0]?.type);
    check("L + drag draws a line", line === "LINE", line);
    // Its Stroke section: Start point and End point (live design/line.txt); End point → Triangle arrow, per end.
    await settle(page);
    const ends = panel.locator("[data-end-points]");
    check("a line's Stroke shows Start point and End point (None)", (await ends.getByRole("button", { name: "Start point" }).count()) === 1 && (await ends.getByRole("button", { name: "End point" }).count()) === 1);
    await ends.getByRole("button", { name: "End point" }).click();
    await settle(page);
    await shot(page, `38-end-points-${theme}`);
    await page.getByRole("menuitemcheckbox", { name: "Triangle arrow" }).click();
    await settle(page);
    const caps = await page.evaluate(() => { const e = window.__designerEditor.engine; return e.endCaps(e.getSelection().refs[0]); });
    check("End point → Triangle arrow, the start stays None", caps?.start === "NONE" && caps?.end === "ARROW_EQUILATERAL", JSON.stringify(caps));
  }
}

/** Components on `?editor&doc=components` (dark): Layers, the instance panel and menus, variants, Go to main component, a main's Properties, binding, Assets. */
async function componentsSection(page, theme) {
  await open(page, "&doc=components");
  const panel = page.locator('[data-panel="right"]');
  const row = (id) => page.locator(`[data-ds="LayerRow"][data-id="${id}"]`);
  const select = async (...ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const info = await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    return { componentInfo: typeof e.componentInfo === "function" };
  });
  results.push(`info engine: componentInfo ${info.componentInfo}`);

  // Layers: the instance with its layers (derived from the main until the engine materializes them), purple.
  await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["2:1", "2:2", "I2:2;1:2"]) }));
  await select("2:2");
  check("Layers: an instance row in purple with its layers below", (await row("2:2").getAttribute("data-tone")) === "component" && (await row("I2:2;1:3").count()) === 1);
  check("the instance panel: header, Boolean, Text, Instance swap, the exposed nested instance", (await panel.locator('[data-instance-menu="Button"]').count()) === 1 && (await panel.getByRole("switch", { name: "Show icon" }).count()) === 1 && (await panel.getByRole("textbox", { name: "Label" }).inputValue()) === "Sign in" && (await panel.locator('[data-nested-instance]').count()) === 1);
  await shot(page, `38-instance-${theme}`);

  // A Text property: the field writes the instance's value (one step).
  const label = panel.getByRole("textbox", { name: "Label" });
  await label.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Log in");
  await page.keyboard.press("Enter");
  await settle(page);
  const assigned = await page.evaluate(() => JSON.stringify(window.__designerEditor.engine.readNode("2:2").componentPropAssignments ?? []));
  check("a Text property's field writes the value", assigned.includes("Log in"), assigned);
  await panel.getByRole("switch", { name: "Show icon" }).click();
  await settle(page);
  const toggled = await page.evaluate(() => JSON.stringify(window.__designerEditor.engine.readNode("2:2").componentPropAssignments ?? []));
  check("a Boolean property's toggle writes the value", toggled.includes("false"), toggled);

  // The instance menu (swap), the ⋯ menu (Figma's live list: … Create component, Detach instance, Reset instance …).
  await panel.locator("[data-instance-menu]").click();
  await settle(page);
  // Live: the swap menu opens at the main's level — its page's components, then its folders (the "Icons" frame).
  const swapMenu = page.locator("[data-component-picker]");
  check("the swap menu opens at the main's page: its components, then its folders", (await swapMenu.getByRole("menuitemradio").count()) >= 2 && (await swapMenu.locator('[data-folder="Icons"]').count()) === 1 && (await swapMenu.locator("[data-level]").getAttribute("data-level")) === "Components");
  await shot(page, `39-instance-menu-${theme}`);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "More actions" }).click();
  await settle(page);
  const moreText = await page.getByRole("menu").last().innerText();
  check("⋯ lists Create component, Detach instance, Reset instance (the live menu)", ["Create component", "Detach instance", "Reset instance"].every((t) => moreText.includes(t)), moreText.replace(/\n/g, " | "));
  await shot(page, `40-instance-more-${theme}`);
  await page.keyboard.press("Escape");
  await select("2:2");

  // An Instance swap property: its picker (preferred first).
  await panel.locator('[data-swap-property="Icon"]').click();
  await settle(page);
  check("an Instance swap picker lists Preferred first", (await page.locator("[data-component-picker]").getByText("Preferred").count()) === 1);
  await page.locator("[data-component-picker]").getByRole("menuitemradio", { name: "Heart" }).first().click();
  await settle(page);
  const swapped = await page.evaluate(() => JSON.stringify(window.__designerEditor.engine.readNode("2:2").componentPropAssignments ?? []));
  check("picking writes the Instance swap value", swapped.includes('"localID":21') || swapped.includes("1:21"), swapped);

  // A variant instance: one dropdown per property; a pick switches the variant.
  await select("2:3");
  check("a variant instance shows State and Size", (await panel.getByRole("combobox", { name: "State" }).count()) === 1 && (await panel.getByRole("combobox", { name: "Size" }).count()) === 1);
  await panel.getByRole("combobox", { name: "State" }).click();
  await settle(page);
  await shot(page, `41-variant-instance-${theme}`);
  await page.getByRole("option", { name: "Hover" }).click();
  await settle(page);
  const chip = await node(page, "2:3");
  const target = chip.symbolData?.symbolID;
  check("a variant pick switches to that variant", target && target.sessionID === 1 && target.localID === 42, JSON.stringify(target));
  // Round 5 — "Assign variable" on a variant property (help "Modes for variables"): a string variable picks the variant.
  const stringVar = await page.evaluate(async () => {
    const ed = window.__designerEditor;
    const v = await import("/src/editor/variables.ts");
    const c = v.createCollection(ed);
    const sv = v.createVariable(ed, c, "STRING");
    const mode = ed.variables.get().lookup.collection(c).defaultMode;
    v.setVariableValue(ed, sv, mode, { kind: "literal", value: "Default" });
    return sv;
  });
  await settle(page);
  check("a variant row offers Apply variable at its end", (await panel.locator('[data-property="State"]').getByRole("button", { name: "Apply variable" }).count()) === 1);
  await panel.locator('[data-apply-variable="State"]').click();
  await settle(page);
  await shot(page, `41b-assign-variable-${theme}`);
  const pickedFromUi = await page.locator('[data-variable-picker] [data-variable="String"]').first().click({ timeout: 3000 }).then(() => true, () => false);
  results.push(`info Assign variable picked from the picker: ${pickedFromUi}`);
  await settle(page);
  if ((await panel.locator('[data-bound-variable]').count()) === 0)
    await page.evaluate(async (sv) => (await import("/src/editor/components.ts")).bindPropertyVariable(window.__designerEditor, "2:3", "State", sv), stringVar);
  await settle(page);
  const picked = (await node(page, "2:3")).symbolData?.symbolID;
  check("an assigned variable picks its variant (Default) and shows as a pill", (await panel.locator('[data-bound-variable]').count()) >= 1 && picked && picked.localID !== 42, JSON.stringify(picked));
  await shot(page, `41c-variant-variable-${theme}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);

  // Reset instance (⋯) on the button: every change.
  await select("2:2");
  await panel.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reset instance" }).click();
  await settle(page);
  const reset = await node(page, "2:2");
  check("Reset instance clears the overrides and the values", (reset.symbolData?.symbolOverrides ?? []).length === 0 && (reset.componentPropAssignments ?? []).length === 0, JSON.stringify({ o: reset.symbolData?.symbolOverrides, a: reset.componentPropAssignments }));
  await page.keyboard.press("Meta+z");
  await settle(page);

  // The canvas menu on an instance, the main menu's Object submenu.
  await select("2:2");
  const box = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const n = ed.engine.readNode("2:2");
    return [n.transform.m02 + 10, n.transform.m12 + 10];
  });
  await page.mouse.click(...(await toScreen(page, ...box)), { button: "right" });
  await settle(page);
  const canvasText = (await page.getByRole("menu").count()) ? await page.getByRole("menu").first().innerText() : "";
  check("the canvas menu on an instance: Go to main component, Reset, Detach instance", canvasText.includes("Go to main component") && canvasText.includes("Detach instance"), canvasText.replace(/\n/g, " | "));
  await shot(page, `42-instance-canvas-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Main menu" }).first().click();
  await page.getByRole("menuitem", { name: "Object" }).hover();
  await page.waitForTimeout(400);
  await shot(page, `43-object-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Go to main component (⌃⌥⌘K): its page, selected; Return to instance comes back.
  await select("2:2");
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Control+Alt+Meta+KeyK");
  await settle(page);
  const went = await page.evaluate(() => ({ page: window.__designerEditor.store.page, sel: window.__designerEditor.selection }));
  check("⌃⌥⌘K goes to the main on its page", went.page === "0:3" && went.sel.join() === "1:1", JSON.stringify(went));
  check("the Return to instance pill shows", (await page.locator("[data-return-to-instance]").count()) === 1);
  await shot(page, `44-go-to-main-${theme}`);

  // The main component: Properties (+), its rows, the description.
  check("a main component shows Properties with its three", (await panel.locator("[data-component-properties] [data-property-def]").count()) === 3);
  await panel.locator('[data-property-def="Icon"]').click();
  await settle(page);
  check("an Instance swap property's settings list its preferred instances", (await page.locator('[data-property-editor="INSTANCE_SWAP"]').getByText("Preferred instances").count()) === 1);
  await shot(page, `45-property-settings-${theme}`);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Create property" }).click();
  await settle(page);
  await shot(page, `46-add-property-menu-${theme}`);
  await page.getByRole("menuitem", { name: "Boolean" }).click();
  await settle(page);
  await page.locator('[data-property-editor="BOOL"]').getByRole("textbox", { name: "Name" }).fill("Disabled");
  await page.keyboard.press("Enter");
  await page.locator('[data-property-editor="BOOL"]').getByRole("button", { name: "Create property" }).click();
  await settle(page);
  const defs = (await node(page, "1:1")).componentPropDefs ?? [];
  check("Create property adds a Boolean property", defs.some((d) => d.name === "Disabled" && d.type === "BOOL"), defs.map((d) => d.name).join(", "));

  await page.locator("[data-return-to-instance] button").first().click();
  await settle(page);
  const back = await page.evaluate(() => ({ page: window.__designerEditor.store.page, sel: window.__designerEditor.selection }));
  check("Return to instance goes back", back.page === "0:1" && back.sel.join() === "2:2", JSON.stringify(back));

  // The set, a variant, a bound layer.
  await page.evaluate(() => window.__designerEditor.engine.setCurrentPage("0:3"));
  await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["1:1", "1:40", "1:30"]) }));
  await select("1:40");
  check("Layers: the set's glyph, purple", (await row("1:40").getAttribute("data-tone")) === "component");
  check("a component set shows its variant properties", (await panel.locator('[data-property-def="State"]').count()) === 1);
  await shot(page, `47-component-set-${theme}`);
  await select("1:42");
  check("a variant shows Current variant", (await panel.locator("[data-current-variant]").count()) === 1);
  await shot(page, `48-variant-${theme}`);
  await select("1:3");
  const pill = panel.locator('[data-bind="TEXT_DATA"]');
  check("a bound text layer shows its property's pill", (await pill.innerText()).includes("Label"), await pill.innerText());
  await pill.getByRole("button", { name: "Apply text property" }).click();
  await settle(page);
  await shot(page, `49-bind-menu-${theme}`);
  await page.keyboard.press("Escape");

  // Assets: list and grid; a click inserts an instance.
  await page.keyboard.press("Alt+Digit2");
  await settle(page);
  const localCard = page.locator('[data-library-card="Created in this file"]');
  check("⌥2 opens Assets: All libraries, the file's card with its count", (await localCard.count()) === 1 && (await localCard.innerText()).includes("4 components"), (await localCard.count()) ? await localCard.innerText() : "no card");
  await shot(page, `50-assets-all-libraries-${theme}`);
  await localCard.click();
  await settle(page);
  check("a library card opens its pages (Back, the path)", (await page.locator("[data-asset-page]").count()) >= 1 && (await page.getByRole("button", { name: "Back" }).count()) === 1);
  await shot(page, `50b-assets-library-${theme}`);
  const mainPage = await page.evaluate(() => window.__designerEditor.store.pages.find((p) => p.guid === "0:3")?.name);
  await page.locator(`[data-asset-page="${mainPage}"]`).click();
  await settle(page);
  check("a page shows its components", (await page.locator('[data-asset="1:1"]').count()) === 1);
  await shot(page, `50c-assets-page-list-${theme}`);
  await page.getByRole("button", { name: "Libraries and settings" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Grid" }).or(page.getByRole("menuitem", { name: "Grid" })).first().click();
  await settle(page);
  await shot(page, `51-assets-grid-${theme}`);
  const before = await page.evaluate(() => window.__designerEditor.engine.encodeDocument().nodeChanges.filter((n) => n.type === "INSTANCE").length);
  const asset = page.locator('[data-asset="1:1"]');
  const from = await asset.boundingBox();
  const canvasBox = await page.locator("#engine-canvas").boundingBox();
  await drag(page, [from.x + from.width / 2, from.y + from.height / 2], [canvasBox.x + canvasBox.width / 2 + 200, canvasBox.y + 300], 12);
  const after = await page.evaluate(() => window.__designerEditor.engine.encodeDocument().nodeChanges.filter((n) => n.type === "INSTANCE").length);
  const made = await page.evaluate(() => window.__designerEditor.selectedNodes()[0]);
  check("dragging an asset onto the canvas inserts an instance", after === before + 1 && made?.type === "INSTANCE", `${before} → ${after}`);
  await shot(page, `52-assets-dropped-${theme}`);
  await page.keyboard.press("Alt+Digit1");
}

/** Variables, modes and styles on `?editor&doc=variables` (dark): the Local variables window, binding, modes, styles. */
async function variablesSection(page, theme) {
  await open(page, "&doc=variables");
  const panel = page.locator('[data-panel="right"]');
  const win = page.locator("[data-local-variables]");
  const select = async (...ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const info = await page.evaluate(() => typeof window.__designerEditor.engine.variableCollections === "function");
  results.push(`info engine: variables build ${info}`);
  const fillHex = (id) =>
    page.evaluate((id) => {
      const c = window.__designerEditor.engine.readNode(id).fillPaints[0].color;
      return "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    }, id);

  // Nothing selected: Page (Apply variable mode), Local variables, the Styles list by kind and folder.
  await select();
  check("nothing selected: the Styles list (Text, Color, Effect, Layout guide)", (await panel.locator("[data-style-item]").count()) === 9);
  await shot(page, `53-styles-list-${theme}`);

  // The Local variables window: collections, groups, a column per mode, aliases.
  await page.locator('[data-rail-tab="variables"]').click(); // the rail (r7: the right panel has no Local variables row)
  await settle(page);
  check("Local variables opens with the collections and the first one's groups", (await win.locator("[data-collection]").count()) === 2 && (await win.locator("[data-group]").count()) >= 4);
  await win.locator('[data-collection="Theme"]').click();
  await settle(page);
  check("Theme: Light and Dark columns, aliases as pills", (await win.locator("[data-mode]").count()) === 2 && (await win.locator('[data-value-cell="bg/primary|Dark"]').getByText("color/gray/900").count()) === 1);
  await shot(page, `54-local-variables-${theme}`);
  // A literal edited in place reaches the bound layers (one step).
  const cell = win.locator('[data-value-cell="text/primary|Light"]').getByRole("textbox");
  await cell.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("FF0000");
  await page.keyboard.press("Enter");
  await settle(page);
  check("a value typed in the table reaches the bound text in that mode", (await fillHex("2:2")) === "#ff0000", await fillHex("2:2"));
  await win.press("Meta+z");
  await settle(page);
  // "+ Create variable" with its type menu; the new row renames in place.
  await win.getByRole("button", { name: "Create variable" }).click();
  await settle(page);
  await shot(page, `55-create-variable-menu-${theme}`);
  await page.getByRole("menuitem", { name: "Number" }).click();
  await settle(page);
  await page.keyboard.type("gap");
  await page.keyboard.press("Enter");
  await settle(page);
  check("+ Create variable ▸ Number adds a row renamed in place", (await win.locator('[data-name-cell="gap"]').count()) === 1);
  // Mode header menu; "+" adds a mode.
  await win.locator('[data-mode="Dark"]').click({ button: "right" });
  await settle(page);
  await shot(page, `56-mode-menu-${theme}`);
  await page.keyboard.press("Escape");
  await win.getByRole("button", { name: "New variable mode" }).click();
  await settle(page);
  await page.keyboard.press("Enter");
  check("New variable mode adds a third column", (await win.locator("[data-mode]").count()) === 3);
  // Edit variable; the alias picker.
  await win.locator('[data-variable-row] [data-name-cell="bg/primary"]').hover();
  await win.locator('[data-edit-cell="bg/primary"]').getByRole("button", { name: "Edit variable" }).click(); // live: its own column
  await settle(page);
  check("Edit variable: name, values per mode, scoping, code syntax, publishing", (await page.locator("[data-edit-variable]").count()) === 1 && (await page.getByText("Show in all supported properties").count()) === 1);
  await shot(page, `57-edit-variable-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  await win.locator('[data-value-cell="text/primary|Dark"]').hover();
  await win.locator('[data-value-cell="text/primary|Dark"]').getByRole("button", { name: "Apply variable" }).click();
  await settle(page);
  await shot(page, `58-alias-picker-${theme}`);
  await page.locator('[data-variable-picker] [data-variable="color/white"]').click();
  await settle(page);
  check("aliasing from the picker", (await win.locator('[data-value-cell="text/primary|Dark"]').getByText("color/white").count()) === 1);
  // Row context menu with two rows selected; Delete removes both (one step).
  await win.locator('[data-name-cell="label/cta"]').click();
  await win.locator('[data-name-cell="feature/beta"]').click({ modifiers: ["Meta"] });
  await win.locator('[data-name-cell="feature/beta"]').click({ button: "right" });
  await settle(page);
  await shot(page, `59-variable-menu-${theme}`);
  await page.keyboard.press("Escape");
  await win.press("Backspace");
  await settle(page);
  check("⌫ deletes the selected variables", (await win.locator('[data-name-cell="label/cta"], [data-name-cell="feature/beta"]').count()) === 0);
  await win.press("Meta+z");
  // Live (rail-variables-table.txt): no ×; the navigation bar's Variables closes the view.
  await page.locator('[data-rail-tab="variables"]').click();
  await settle(page);
  check("the navigation bar's Variables closes the window", (await win.count()) === 0);

  // Binding in the Design panel: hover "Apply variable", the picker, the pill, Detach.
  await select("2:3");
  const radius = panel.locator('[data-bind-field="CORNER_RADIUS"]');
  await radius.hover();
  await settle(page);
  await shot(page, `60-apply-variable-hover-${theme}`);
  await radius.getByRole("button", { name: "Apply variable" }).click();
  await settle(page);
  await shot(page, `61-variable-picker-${theme}`);
  await page.locator('[data-variable-picker] [data-variable="radius/lg"]').click();
  await settle(page);
  const bound = await page.evaluate(() => window.__designerEditor.engine.readNode("2:3").cornerRadius);
  check("a picked variable binds the field: a pill, the resolved value written", (await radius.locator("[data-bound-variable]").count()) === 1 && bound === 16, String(bound));
  await shot(page, `62-bound-pill-${theme}`);
  await radius.hover();
  await radius.getByRole("button", { name: "Detach variable" }).click();
  await settle(page);
  check("Detach variable keeps the value", (await radius.locator("[data-bound-variable]").count()) === 0 && (await page.evaluate(() => window.__designerEditor.engine.readNode("2:3").cornerRadius)) === 16);

  // Apply variable mode on a frame, the mode row; Auto back.
  await select("2:1");
  await panel.getByRole("button", { name: "Apply variable mode" }).click();
  await settle(page);
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.waitForTimeout(300);
  await shot(page, `63-apply-mode-menu-${theme}`);
  await page.locator('[role="menu"]').getByText("Dark", { exact: true }).last().click();
  await settle(page);
  check("Apply variable mode ▸ Dark: the frame and its layers resolve Dark, the mode row shows", (await fillHex("2:1")) === "#1e1e1e" && (await panel.locator('[data-mode-row="Theme"]').count()) === 1, await fillHex("2:1"));
  await shot(page, `64-mode-row-${theme}`);
  await page.keyboard.press("Meta+z");
  await settle(page);

  // Styles: the applied style row, the picker (styles and colour variables), Edit style, the text style row.
  await select("2:12");
  check("a fill style shows as its row; an effect style too", (await panel.locator('[data-applied-style="Brand/Primary"]').count()) === 1 && (await panel.locator('[data-applied-style="Shadow/Small"]').count()) === 1);
  await panel.locator('[data-styles-button="fill"]').click();
  await settle(page);
  await shot(page, `65-style-picker-${theme}`);
  await page.locator('[data-variable-picker] [data-style="Brand/Secondary"]').click();
  await settle(page);
  check("picking another style applies it", (await fillHex("2:12")) === "#9747ff", await fillHex("2:12"));
  await panel.locator('[data-applied-style="Brand/Secondary"] button').first().click();
  await settle(page);
  await shot(page, `66-edit-style-${theme}`);
  await page.keyboard.press("Escape");
  await panel.locator('[data-applied-style="Brand/Secondary"]').getByRole("button", { name: "Detach style" }).click();
  await settle(page);
  check("Detach style keeps the colour", (await panel.locator("[data-applied-style]").count()) === 1 && (await fillHex("2:12")) === "#9747ff");
  await select("2:11");
  check("a text style replaces the font rows", (await panel.locator('[data-applied-style="Heading/H2"]').count()) === 1);
  await shot(page, `67-text-style-${theme}`);
  // The Styles list's context menu; View ▸ Local variables.
  await select();
  await panel.locator('[data-style-item="Brand/Primary"]').click({ button: "right" });
  await settle(page);
  await shot(page, `68-style-menu-${theme}`);
  await page.keyboard.press("Escape");

  // Round 5 — "Extend collection" (R3-32): the extended collection inherits Theme's variables and modes (no new ones);
  // a value edited there is an override, in blue, and "Reset change" brings back the parent's.
  await page.locator('[data-rail-tab="variables"]').click(); // the rail (r7: the right panel has no Local variables row)
  await settle(page);
  await win.locator('[data-collection="Theme"]').click({ button: "right" });
  await settle(page);
  await page.getByRole("menuitem", { name: "Extend collection" }).click();
  await settle(page);
  await page.keyboard.press("Enter");
  await settle(page);
  check(
    "Extend collection: Theme's modes and variables, no Create variable",
    (await win.locator("[data-extension]").count()) === 1 &&
      (await win.locator("[data-mode]").count()) >= 2 &&
      (await win.locator('[data-extended-from="Theme"]').count()) === 1 &&
      (await win.getByRole("button", { name: "Create variable" }).count()) === 0
  );
  const extCell = win.locator('[data-value-cell="text/primary|Light"]');
  await extCell.getByRole("textbox").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("00FF00");
  await page.keyboard.press("Enter");
  await settle(page);
  check("a value edited in the extended collection is its override (blue)", (await win.locator('[data-value-cell="text/primary|Light"][data-overridden]').count()) === 1);
  await shot(page, `69-extended-collection-${theme}`);
  await extCell.hover();
  await extCell.getByRole("button", { name: "Reset change" }).click();
  await settle(page);
  check("Reset change: the parent's value again", (await win.locator("[data-overridden]").count()) === 0);
  await page.evaluate(() => window.__designerEditor.ui.set({ variablesOpen: false }));
  await settle(page);
}

/**
 * Libraries on the browser's dev store (docs/data.md §9): two library files in a folder ("Kit": components;
 * "Tokens": variables and styles) and an "App" in Drafts. Publish library (the modal, then the toast), Drafts can't
 * publish, the Libraries modal (Add to file, a library's preview), Assets with the libraries' sections, a remote
 * component inserted (an instance of its read-only copy), a remote variable bound through the picker's library
 * list; the Kit changes and publishes again; the App opens with the blue badge, the Updates list and the review
 * (side by side, overlay), Update.
 */
async function librariesSection(page, theme) {
  await open(page, "&doc=empty");
  const keys = await page.evaluate(async (repo) => {
    const s = await import("/src/store/index.ts");
    const { encodeMessage, newDocumentMessage } = await import(`/@fs${repo}/src/shared/schema/codec.ts`);
    const { COMPONENTS_DOCUMENT, VARIABLES_DOCUMENT } = await import("/src/editor/fixtures.ts");
    const api = s.getStoreClient();
    const mem = await s.getDevStore().ready;
    const folder = await api.workspace.createFolder({ name: "Design system", parentId: null });
    const add = async (name, doc, folderId) => (await mem.addFile({ name, folderId, snapshot: encodeMessage(s.messageToKiwi(doc)) })).fileKey;
    return { kit: await add("Kit", COMPONENTS_DOCUMENT, folder.id), tokens: await add("Tokens", VARIABLES_DOCUMENT, folder.id), app: await add("App", newDocumentMessage(), null), kit2: await add("Kit 2", newDocumentMessage(), folder.id) };
  }, repo);
  const ed = (fn, arg) => page.evaluate(fn, arg);
  const dialog = page.getByRole("dialog");
  const publishFromUi = async (name) => {
    await ed(() => window.__designerEditor.ui.set({ publishOpen: true }));
    await page.locator("[data-publish-dialog] [data-change]").first().waitFor({ timeout: 10000 });
    await settle(page);
    if (name) await shot(page, name);
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await page.locator("[data-publish-dialog]").waitFor({ state: "detached", timeout: 10000 });
  };

  // ---- The Kit publishes (the modal lists its components as new); the Tokens too.
  await open(page, `&file=${keys.kit}`);
  await publishFromUi(`70-publish-library-${theme}`);
  await page.getByText("Library published").first().waitFor({ timeout: 5000 }).catch(() => {});
  await shot(page, `71-library-published-${theme}`);
  const v1 = await ed(async (k) => (await (await import("/src/store/index.ts")).getStoreClient().libraries.getRecord(k))?.latestVersion ?? 0, keys.kit);
  check("Publish library: version 1 of the Kit is in the registry", v1 === 1, `version ${v1}`);
  await open(page, `&file=${keys.tokens}`);
  await publishFromUi(null);

  // ---- The App (in Drafts): Publish says "Move to a folder to publish"; the Libraries modal adds both.
  await open(page, `&file=${keys.app}`);
  await ed(() => window.__designerEditor.ui.set({ publishOpen: true }));
  await page.locator("[data-publish-drafts]").waitFor({ timeout: 5000 });
  await shot(page, `72-publish-drafts-${theme}`);
  check("a file in Drafts can't publish (Move to a folder to publish)", (await page.getByText("Move to a folder to publish").count()) > 0);
  await page.keyboard.press("Escape");
  await ed(() => window.__designerEditor.ui.set({ railTab: "assets", publishOpen: false }));
  await settle(page);
  await page.locator("[data-libraries-button]").click();
  await page.locator('[data-library-row="Kit"]').waitFor({ timeout: 10000 });
  await settle(page);
  await shot(page, `73-libraries-modal-${theme}`);
  for (const name of ["Kit", "Tokens"]) {
    await page.locator(`[data-library-row="${name}"]`).getByRole("button", { name: "Add to file" }).click();
    await page.locator('section[aria-label="Added to this file"]').locator(`[data-library-row="${name}"]`).waitFor({ timeout: 10000 });
  }
  check("Add to file: both libraries are enabled in the App", (await ed(() => window.__designerEditor.libraries.get().enabled.length)) === 2);
  await page.getByRole("button", { name: "Preview Kit" }).click();
  await page.locator("[data-library-preview] img, [data-library-preview] canvas").first().waitFor({ timeout: 5000 }).catch(() => {});
  await settle(page);
  await shot(page, `74-library-preview-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  check("Esc closes the Libraries modal from a library's preview", (await page.locator("[data-libraries-dialog]").count()) === 0);
  if (await page.locator("[data-libraries-dialog]").count()) await dialog.getByRole("button", { name: "Close" }).click();

  // ---- Assets: the libraries' cards; a search lists Kit's Button with its thumbnail; a click inserts an instance.
  await page.locator('[data-library-card="Kit"]').waitFor({ timeout: 10000 });
  await shot(page, `75a-assets-library-cards-${theme}`);
  await page.getByRole("searchbox", { name: "Search all libraries" }).fill("Button");
  await page.locator('[data-assets-section="Kit"] [data-asset-name="Button"]').waitFor({ timeout: 10000 });
  await settle(page);
  await shot(page, `75-assets-libraries-${theme}`);
  await page.locator('[data-assets-section="Kit"] [data-asset-name="Button"]').click();
  await page.waitForFunction(() => window.__designerEditor.selection.length === 1, null, { timeout: 10000 }).catch(() => {});
  const inserted = await ed(() => {
    const e = window.__designerEditor;
    const id = e.selection[0];
    const n = id ? e.engine.readNode(id) : null;
    const main = n?.symbolData?.symbolID;
    const copy = main ? e.engine.readNode(`${main.sessionID}:${main.localID}`) : null;
    return { id, type: n?.type, library: copy?.sourceLibraryKey ?? null };
  });
  check("a click on a library component inserts an instance of its read-only copy", inserted.type === "INSTANCE" && inserted.library === keys.kit, JSON.stringify(inserted));
  await settle(page);
  await shot(page, `76-library-instance-${theme}`);

  // ---- A remote variable bound through the picker (its library listed under "All libraries").
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("r");
  const area = await page.locator("#engine-canvas").boundingBox();
  await drag(page, [area.x + 120, area.y + 120], [area.x + 220, area.y + 200]);
  await settle(page);
  const panel = page.locator('[data-panel="right"]');
  const radius = panel.locator('[data-bind-field="CORNER_RADIUS"]');
  await radius.hover();
  await radius.getByRole("button", { name: "Apply variable" }).click();
  await page.locator('[data-variable-picker] [data-picker-library="Tokens"]').waitFor({ timeout: 10000 }).catch(() => {});
  await settle(page);
  await shot(page, `77-variable-picker-libraries-${theme}`);
  const remoteVar = page.locator('[data-variable-picker] [data-library="Tokens"][data-variable="radius/lg"]');
  if (await remoteVar.count()) {
    await remoteVar.click();
    await radius.locator("[data-bound-variable]").waitFor({ timeout: 10000 }).catch(() => {});
    await settle(page);
    check("a library variable binds through its copy (the pill shows its name)", (await radius.locator("[data-bound-variable]").count()) === 1);
    await shot(page, `78-bound-pill-library-${theme}`);
  } else check("a library variable binds through its copy (the pill shows its name)", false, "radius/lg not listed under Tokens");
  await page.evaluate(() => window.__designerEditor.source.flush());

  // ---- The Kit changes its Button and publishes v2 (the modal lists it as modified).
  await open(page, `&file=${keys.kit}`);
  await ed(() => {
    const e = window.__designerEditor;
    e.setProps(["1:1"], { fillPaints: [{ type: "SOLID", color: { r: 0.95, g: 0.28, b: 0.13, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }] }, "Fill");
  });
  await publishFromUi(`79-publish-modified-${theme}`);
  await page.evaluate(() => window.__designerEditor.source.flush());

  // ---- The App opens with the update waiting: the blue badge, the toast; the Updates list and the review.
  await open(page, `&file=${keys.app}`);
  await ed(() => window.__designerEditor.ui.set({ railTab: "assets" }));
  await page.locator("[data-updates-badge]").waitFor({ timeout: 10000 }).catch(() => {});
  await settle(page);
  check("the Libraries icon has the blue badge when an enabled library has a newer version", (await page.locator("[data-updates-badge]").count()) === 1);
  await shot(page, `80-updates-badge-${theme}`);
  await page.locator("[data-libraries-button]").click();
  await page.locator('[data-update="Button"]').waitFor({ timeout: 10000 });
  await settle(page);
  await shot(page, `81-updates-list-${theme}`);
  await page.locator('[data-update="Button"]').click();
  await page.locator("[data-review-update]").waitFor({ timeout: 5000 });
  await settle(page);
  await shot(page, `82-review-side-by-side-${theme}`);
  await page.locator("[data-review-update]").getByText("Overlay", { exact: true }).click();
  await settle(page);
  await shot(page, `83-review-overlay-${theme}`);
  await page.locator("[data-review-update]").getByRole("button", { name: "Update", exact: true }).click();
  await page.waitForFunction(() => window.__designerEditor.libraries.pendingCount() === 0, null, { timeout: 10000 }).catch(() => {});
  const fill = await ed((id) => {
    const c = window.__designerEditor.engine.readNode(id)?.fillPaints?.[0]?.color;
    return c ? Math.round(c.r * 255) : null;
  }, inserted.id);
  check("Update: the instance follows the new version (one step), no updates left", fill === 242 && (await ed(() => window.__designerEditor.libraries.pendingCount())) === 0, `r = ${fill}`);
  await page.keyboard.press("Escape");
  await settle(page);
  await shot(page, `84-updated-${theme}`);
  await page.evaluate(() => window.__designerEditor.source.flush());

  // ---- What a published asset uses goes with it: the Kit changes the Star and the Button; the Star's row is locked
  // ("Used by Button") while the Button is selected.
  await open(page, `&file=${keys.kit}`);
  await ed(() => {
    const e = window.__designerEditor;
    e.setProps(["1:20"], { size: { x: 20, y: 20 } }, "Resize");
    e.setProps(["1:1"], { fillPaints: [{ type: "SOLID", color: { r: 0.08, g: 0.68, b: 0.36, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }] }, "Fill");
  });
  await ed(() => window.__designerEditor.ui.set({ publishOpen: true }));
  const starRow = page.locator('[data-publish-dialog] [data-change="Icons/Star"]');
  await starRow.waitFor({ timeout: 10000 });
  await settle(page);
  check("Publish: a modified component the selected Button uses goes with it (Used by Button, locked)", (await page.locator('[data-change="Icons/Star"][data-locked]').count()) === 1 && (await starRow.getByText("Used by Button").count()) === 1);
  await shot(page, `85-publish-used-by-${theme}`);
  await page.locator('[data-publish-dialog] [data-change="Button"]').getByRole("checkbox").click({ force: true });
  await settle(page);
  check("Publish: deselecting the Button frees the Star's row", (await page.locator('[data-change="Icons/Star"][data-locked]').count()) === 0);
  await page.locator('[data-publish-dialog] [data-change="Button"]').getByRole("checkbox").click({ force: true });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await page.locator("[data-publish-dialog]").waitFor({ state: "detached", timeout: 10000 });

  // ---- Moved out: ⌘X of Icons/Heart in the Kit, ⌘V in Kit 2, which publishes with Move to this file; the Kit's
  // Publish then lists it under Moved components ("Moved to Kit 2") and can publish that alone.
  const cut = await ed(() => {
    const e = window.__designerEditor;
    e.engine.setSelection(["1:21"]);
    const m = e.engine.encodeSelection({ cut: true });
    e.engine.command("DELETE");
    return m;
  });
  await page.evaluate(() => window.__designerEditor.source.flush());
  await open(page, `&file=${keys.kit2}`);
  await ed((m) => window.__designerEditor.engine.paste(m), cut);
  await ed(() => window.__designerEditor.ui.set({ publishOpen: true }));
  const moveRow = page.locator('[data-publish-dialog] [data-move="Icons/Heart"]');
  await moveRow.waitFor({ timeout: 10000 });
  await settle(page);
  const fit = await moveRow.evaluate((row) => {
    const name = row.querySelector("[class*=changeName]");
    const select = row.querySelector('[data-ds="Select"]');
    return { name: !!name && name.scrollWidth <= name.clientWidth, select: Math.round(select?.getBoundingClientRect().width ?? 0), row: Math.round(row.getBoundingClientRect().width) };
  });
  check("Publish: a moved component's name keeps its row (Move / Copy hugs its value)", fit.name && fit.select > 0 && fit.select < fit.row / 2, JSON.stringify(fit));
  await publishFromUi(`86-publish-move-here-${theme}`);
  await page.evaluate(() => window.__designerEditor.source.flush());
  await open(page, `&file=${keys.kit}`);
  await ed(() => window.__designerEditor.ui.set({ publishOpen: true }));
  await page.locator('[data-publish-dialog] [data-moved-out="Icons/Heart"]').waitFor({ timeout: 10000 }).catch(() => {});
  await settle(page);
  const movedOut = page.locator('[data-moved-out="Icons/Heart"]');
  check("Publish in the old library: the moved component is listed (Moved to Kit 2) and Publish is enabled", (await movedOut.getByText("Moved to Kit 2").count()) === 1 && (await dialog.getByRole("button", { name: "Publish", exact: true }).isEnabled()));
  await shot(page, `87-publish-moved-out-${theme}`);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await page.locator("[data-publish-dialog]").waitFor({ state: "detached", timeout: 10000 });
  await page.evaluate(() => window.__designerEditor.source.flush());

  // ---- The App: one row per asset; Update selected instance on a second instance, then Update all (one step).
  await open(page, `&file=${keys.app}`);
  const second = await ed(async (k) => {
    const e = window.__designerEditor;
    const { insertLibraryComponent } = await import("/src/editor/libraries.ts");
    const v = await e.source.libraries.version(k);
    return insertLibraryComponent(e, k, v.assets.find((a) => a.name === "Button"));
  }, keys.kit);
  await ed(() => window.__designerEditor.libraries.refresh());
  await ed((id) => window.__designerEditor.engine.setSelection([id]), inserted.id);
  await ed(() => window.__designerEditor.ui.set({ railTab: "assets", librariesDialog: { tab: "updates" } }));
  await page.locator('[data-update="Button"]').waitFor({ timeout: 10000 });
  check("Updates: one row per asset", (await page.locator('[data-update="Button"]').count()) === 1);
  await page.locator('[data-update="Button"]').click();
  await page.locator("[data-review-update]").waitFor({ timeout: 5000 });
  const layersBefore = await ed((id) => window.__designerEditor.engine.readNode(id, { childIds: true })?.childIds?.length ?? 0, second);
  await page.locator("[data-review-update]").getByRole("button", { name: "Update selected instance" }).click();
  await page.waitForFunction(() => window.__designerEditor.libraries.copies().filter((c) => c.name === "Button").length === 2, null, { timeout: 10000 }).catch(() => {});
  await settle(page);
  const after = await ed(
    ([a, b]) => {
      const e = window.__designerEditor;
      const kids = (id) => e.engine.readNode(id, { childIds: true })?.childIds?.length ?? 0;
      const g = (id) => Math.round((e.engine.readNode(id)?.fillPaints?.[0]?.color?.g ?? 0) * 255);
      return { a: kids(a), b: kids(b), ga: g(a), gb: g(b), copies: e.libraries.copies().filter((c) => c.name === "Button").length };
    },
    [inserted.id, second]
  );
  check("Update selected instance: a complete second copy, the selected instance on it with its layers, the other unchanged", after.copies === 2 && after.a === layersBefore && after.ga === 173 && after.gb !== 173, JSON.stringify(after));
  await shot(page, `88-update-selected-instance-${theme}`);
  await page.locator("[data-review-update]").getByRole("button", { name: "Back to updates" }).click().catch(() => {});
  await page.getByRole("button", { name: "Update all" }).click();
  await page.waitForFunction(() => window.__designerEditor.libraries.pendingCount() === 0, null, { timeout: 10000 }).catch(() => {});
  const all = await ed(() => {
    const e = window.__designerEditor;
    return { pending: e.libraries.pendingCount(), undo: e.store.undo.undoLabel };
  });
  check("Update all: every copy of every asset updated, one undo step", all.pending === 0 && all.undo === "Update library assets", JSON.stringify(all));
  await settle(page);
  await shot(page, `89-updated-all-${theme}`);
}


// E7: the Export section (rows, settings, preview, the button), the Export dialog (⇧⌘E), Copy as PNG.
async function exportSection(page, theme) {
  await open(page, "&doc=reference");
  const panel = page.locator('[data-panel="right"]');
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:1"]));
  await settle(page);
  const section = panel.locator('[aria-label="Export"]').first();
  await section.scrollIntoViewIfNeeded().catch(() => {});
  const add = panel.getByRole("button", { name: "Add export settings" });
  for (let i = 0; i < 3; i++) await add.click();
  await settle(page);
  const settings = await page.evaluate(() => (window.__designerEditor.engine.readNode("1:1").exportSettings ?? []).map((s) => `${s.constraint.value}x${s.suffix}`));
  check("Export: '+' adds 1x, 2x @2x, 3x @3x", settings.join() === "1x,2x@2x,3x@3x", settings.join());
  check("Export: three rows and 'Export Frame 1'", (await panel.locator("[data-export-row]").count()) === 3 && (await panel.locator("[data-export-button]").textContent()) === "Export Frame 1");
  // The third as SVG (its scale field goes 1x and off).
  await panel.locator('[data-export-row="2"]').getByRole("combobox", { name: "Export file type" }).click().catch(() => {});
  await page.getByRole("option", { name: "SVG" }).click().catch(() => {});
  await settle(page);
  const third = await page.evaluate(() => window.__designerEditor.engine.readNode("1:1").exportSettings[2]);
  check("Export: the format menu makes it SVG (1x, suffix kept)", third?.imageType === "SVG" && third.suffix === "@3x", JSON.stringify(third));
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, `90-export-section-${theme}`);
  // The "…" settings: Suffix and the format's options.
  await panel.locator('[data-export-row="2"]').getByRole("button", { name: "Advanced export settings", exact: true }).click();
  await settle(page);
  const pop = page.locator("[data-export-settings]");
  check("Export settings: SVG's options", (await pop.getByText("Outline text").count()) === 1 && (await pop.getByText("Simplify stroke").count()) === 1 && (await pop.getByText('Include "id" attribute').count()) === 1);
  await shot(page, `91-export-settings-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  // Preview.
  await panel.getByRole("button", { name: "Preview" }).click();
  await page.waitForFunction(() => document.querySelector("[data-export-preview] img")?.complete && document.querySelector("[data-export-preview] img").naturalWidth > 0, null, { timeout: 10000 }).catch(() => {});
  const previewW = await page.evaluate(() => document.querySelector("[data-export-preview] img")?.naturalWidth ?? 0);
  check("Export: the preview shows the 1x PNG", previewW === 437, `${previewW} px wide`);
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, `92-export-preview-${theme}`);
  // The button: three files — in a browser, one ZIP download.
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }).catch(() => null), panel.locator("[data-export-button]").click()]);
  if (download) {
    const file = path.join(outDir, `93-export-${theme}.zip`);
    await download.saveAs(file);
    const { readFileSync } = await import("node:fs");
    const zip = readFileSync(file);
    const names = [];
    for (let at = 0; at + 4 <= zip.length; at++) if (zip.readUInt32LE(at) === 0x02014b50) names.push(zip.subarray(at + 46, at + 46 + zip.readUInt16LE(at + 28)).toString());
    check("Export Frame 1: the three files", names.join() === "Frame 1.png,Frame 1@2x.png,Frame 1@3x.svg", `${download.suggestedFilename()}: ${names.join(", ")}`);
  } else check("Export Frame 1: the three files", false, "no download");
  // ⇧⌘E: the dialog lists the frame.
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await page.keyboard.press("Meta+Shift+e");
  await settle(page);
  const rows = await page.locator("[data-export-dialog-row]").count();
  check("⇧⌘E: the Export dialog lists the page's layers with export settings", rows === 1, `${rows} rows`);
  await page.waitForTimeout(200);
  await shot(page, `94-export-dialog-${theme}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  // Copy as PNG (⇧⌘C): an image/png on the clipboard.
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await page.keyboard.press("Meta+Shift+c");
  await page.waitForTimeout(800);
  const types = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      return items.flatMap((i) => i.types);
    } catch (e) {
      return [`error: ${e.message}`];
    }
  });
  check("Copy as PNG puts a PNG on the clipboard", types.includes("image/png"), types.join(", "));
}

/**
 * Fonts (docs/editor.md "Font picker"): the desktop's font API mocked in the page — installed families, Figma's Inter,
 * Google families, a font folder that changes — then Figma's font picker on `?editor&doc=types`'s Heading: the list
 * in its faces, search, filters, on-canvas preview on hover, a pick (one undo step), a family's styles, a font
 * installed while the picker is open (`fonts:changed`), and the Missing fonts dialog's "Replace fonts".
 */
async function fontsSection(page, theme) {
  await page.addInitScript((repo) => {
    const local = (family, styles) =>
      styles.map(([style, weight, italic], i) => ({ id: `${family}-${i}`, family, style, postscriptName: "", weight, italic, stretch: 5, source: "user", collectionIndex: 0 }));
    const google = (family, category, popularity, weights, variable) => ({
      family, category, popularity, axes: variable ? [{ tag: "wght", min: 100, max: 900, default: 400 }] : [],
      styles: weights.flatMap((w) => [false, true].filter((it) => it === false || weights.includes(-w)).map((it) => ({
        style: ({ 100: "Thin", 400: "Regular", 600: "SemiBold", 700: "Bold", 900: "Black" })[w] + (it ? " Italic" : "").replace("Regular Italic", "Italic"),
        weight: w, italic: it, id: `g:${variable ? (it ? "vi" : "v") : `${w}${it ? "i" : ""}`}:${family}`,
      }))).filter((s) => s.weight > 0),
    });
    let faces = [
      ...local("Helvetica Neue", [["Regular", 400, false], ["Italic", 400, true], ["Bold", 700, false], ["Bold Italic", 700, true]]),
      ...local("Georgia", [["Regular", 400, false], ["Bold", 700, false]]),
    ];
    const catalog = [
      google("Lora", "Serif", 40, [400, 700], true),
      google("Outfit", "Sans Serif", 120, [100, 400, 600, 900], true),
      google("Roboto Mono", "Monospace", 17, [400, 700], true),
      google("Abril Fatface", "Display", 300, [400], false),
      // Google's Inter: Figma's own (bundled) wins over it.
      google("Inter", "Sans Serif", 5, [400, 700], true),
    ];
    const listeners = new Set();
    let bytes = null;
    const inter = async () => (bytes ??= new Uint8Array(await (await fetch(`/@fs${repo}/src/renderer/src/engine/fonts/Inter-3.19.ttf`)).arrayBuffer()));
    window.__fontsMock = {
      reads: [],
      previews: [],
      install(family) {
        faces = [...faces, ...local(family, [["Regular", 400, false]])];
        for (const l of listeners) l();
      },
    };
    window.designer = {
      fonts: {
        list: async () => ({ version: 1, faces, google: catalog }),
        read: async (id) => {
          window.__fontsMock.reads.push(id);
          return (await inter()).slice();
        },
        preview: async (family) => {
          window.__fontsMock.previews.push(family);
          return (await inter()).slice();
        },
        onChanged: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    };
  }, repo);
  await open(page, "&doc=types");
  const panel = page.locator('[data-panel="right"]');
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:22"]));
  await settle(page);
  const field = panel.locator("[data-font-field]");
  check("Typography's Font family is the font picker's field, on Inter", (await field.count()) === 1 && (await field.innerText()).trim() === "Inter");
  await field.click();
  await settle(page);
  const picker = page.locator("[data-font-picker]");
  check("the font picker opens with Search fonts and All fonts", (await picker.count()) === 1 && (await picker.getByRole("searchbox", { name: "Search fonts" }).count()) === 1 && (await picker.locator("[data-font-filter]").innerText()).includes("All fonts"));
  const rows = picker.locator("[data-font-row]");
  await page.waitForFunction(() => document.querySelectorAll("[data-font-row] [data-font-preview]").length >= 5, null, { timeout: 8000 }).catch(() => {});
  const names = await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-font-row")}:${e.getAttribute("data-font-source")}`));
  check("one list: installed, Figma's Inter (over Google's) and Google families, by name", names.join(" ") === "Abril Fatface:google Georgia:local Helvetica Neue:local Inter:bundled Lora:google Outfit:google Roboto Mono:google", names.join(" "));
  check("each name is drawn in its own face (Google ones from a subset of their name)", (await picker.locator("[data-font-preview]").count()) >= 5 && (await page.evaluate(() => window.__fontsMock.previews.includes("Lora"))));
  check("the current family is ticked", (await picker.locator('[data-font-row="Inter"][aria-selected="true"]').count()) === 1);
  await shot(page, `130-font-picker-${theme}`);

  // Search.
  await picker.getByRole("searchbox", { name: "Search fonts" }).fill("lo");
  await settle(page);
  check("a search narrows the list", (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-font-row")))).join(",") === "Lora");
  await shot(page, `131-font-search-${theme}`);
  await picker.getByRole("searchbox", { name: "Search fonts" }).fill("");
  await settle(page);

  // Hover previews on the canvas; leaving puts the text back.
  await picker.locator('[data-font-row="Lora"]').hover();
  await page.waitForTimeout(400);
  check("hovering a family previews it on the selected text", (await node(page, "1:22")).fontName?.family === "Lora", JSON.stringify((await node(page, "1:22")).fontName));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  check("leaving the list puts the text's font back", ((await node(page, "1:22")).fontName?.family ?? "Inter") === "Inter");

  // A pick: one undo step.
  await picker.locator('[data-font-row="Outfit"]').click();
  await settle(page);
  const picked = (await node(page, "1:22")).fontName;
  check("a click applies the family, keeping the style", picked?.family === "Outfit" && picked?.style === "Regular", JSON.stringify(picked));
  check("the Google family's file was asked for (downloaded on first use)", await page.evaluate(() => window.__fontsMock.reads.includes("g:v:Outfit")));
  check("the Font style menu lists the family's styles", (await panel.getByRole("combobox", { name: "Font style" }).count()) === 1);
  await panel.getByRole("combobox", { name: "Font style" }).click();
  const styleList = await page.locator('[data-ds="Menu"][role="listbox"]').innerText();
  check("Outfit's styles: Thin, Regular, SemiBold, Black", ["Thin", "Regular", "SemiBold", "Black"].every((s) => styleList.includes(s)), styleList.replace(/\n/g, " | "));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await settle(page);
  check("one ⌘Z undoes the pick", ((await node(page, "1:22")).fontName?.family ?? "Inter") === "Inter");

  // Filters and a family's styles.
  await field.click();
  await settle(page);
  const filter = picker.locator("[data-font-filter]");
  const pickFilter = async (label) => {
    await filter.getByRole("combobox").click();
    await page.getByRole("option", { name: label }).click();
    await settle(page);
    return rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-font-row")));
  };
  check("Google fonts lists Google's families only", (await pickFilter("Google fonts")).join(",") === "Abril Fatface,Lora,Outfit,Roboto Mono");
  await shot(page, `132-font-filter-google-${theme}`);
  check("Installed by you lists the computer's", (await pickFilter("Installed by you")).join(",") === "Georgia,Helvetica Neue");
  const inFile = await pickFilter("In this file");
  check("In this file lists the file's fonts", inFile.join(",") === "Inter", `${inFile.join(",")} / ${JSON.stringify(await page.evaluate(() => window.__designerEditor.engine.documentFonts()))}`);
  check("Variable fonts lists families with axes", (await pickFilter("Variable fonts")).join(",") === "Inter,Lora,Outfit,Roboto Mono");
  await pickFilter("All fonts");
  await picker.locator('[data-font-row="Helvetica Neue"]').hover();
  await picker.getByRole("button", { name: "Helvetica Neue styles" }).click();
  await settle(page);
  const menu = page.locator('[data-font-styles="Helvetica Neue"]');
  check("a family's styles open beside it", (await menu.locator("[data-font-style]").evaluateAll((els) => els.map((e) => e.getAttribute("data-font-style")))).join(",") === "Regular,Italic,Bold,Bold Italic");
  await shot(page, `133-font-styles-${theme}`);
  await menu.locator('[data-font-style="Bold Italic"]').click();
  await settle(page);
  const styled = (await node(page, "1:22")).fontName;
  check("a style from the submenu applies family and style", styled?.family === "Helvetica Neue" && styled?.style === "Bold Italic", JSON.stringify(styled));

  // A font installed while the app runs appears (the desktop's fonts:changed).
  await field.click();
  await settle(page);
  await page.evaluate(() => window.__fontsMock.install("Zilla Freshly Installed"));
  await page.waitForTimeout(300);
  check("a font installed while the picker is open appears (fonts:changed)", (await picker.locator('[data-font-row="Zilla Freshly Installed"]').count()) === 1);
  await page.keyboard.press("Escape");
  await settle(page);

  // Missing fonts: a font nobody has; the icon, the dialog, Replace fonts.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.setProps(["1:22"], { fontName: { family: "Matter", style: "Medium", postscript: "" } }, "Font");
  });
  await page.waitForSelector("[data-missing-fonts]", { timeout: 4000 }).catch(() => {});
  check("a missing font shows the navigation bar's missing font alert", (await page.locator("[data-missing-fonts]").count()) === 1);
  check("and the missing font icon next to the family", (await panel.locator("[data-font-field] [data-missing-font]").count()) === 1);
  await shot(page, `134-missing-font-${theme}`);
  await page.locator("[data-missing-fonts]").click();
  await settle(page);
  const dialog = page.getByRole("dialog", { name: "Missing fonts" });
  check("Missing fonts lists the font with its layers and a Replacement", (await dialog.count()) === 1 && (await dialog.locator('[data-missing-font="Matter Medium"]').count()) === 1 && (await dialog.innerText()).includes("Replacement"));
  await shot(page, `135-missing-fonts-dialog-${theme}`);
  await dialog.locator("[data-replace-fonts]").click();
  await settle(page);
  const replaced = (await node(page, "1:22")).fontName;
  check("Replace fonts swaps it everywhere (Inter, same style)", replaced?.family === "Inter" && replaced?.style === "Medium", JSON.stringify(replaced));
  await page.waitForTimeout(1300);
  check("the missing font icon goes", (await page.locator("[data-missing-fonts]").count()) === 0);
  await page.keyboard.press("Meta+z");
  await settle(page);
  check("one ⌘Z brings the missing font back", (await node(page, "1:22")).fontName?.family === "Matter");
}

/** E8 on `?editor&doc=prototype` (dark): the Prototype tab, interaction details, noodles and a noodle drag, flows, and the presentation view (in this tab, and the `?present` route on a store file). */
async function prototypeSection(page, theme) {
  await open(page, "&doc=prototype");
  const panel = page.locator('[data-panel="right"]');
  const select = async (...ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const interactions = async (id) => ((await node(page, id)).prototypeInteractions ?? []).filter((i) => !i.isDeleted);
  await page.evaluate(() => window.__designerEditor.engine.command("ZOOM_TO_FIT"));
  await panel.getByRole("tab", { name: "Prototype" }).click();
  await settle(page);
  // Nothing selected: Device, Background, Flows.
  check("Prototype tab, nothing selected: Device, Background, Flows", (await panel.getByRole("region", { name: "Device" }).count()) === 1 && (await panel.getByRole("region", { name: "Background" }).count()) === 1 && (await panel.getByRole("region", { name: "Flows" }).count()) === 1);
  check("Flows lists the page's flow", (await panel.locator("[data-flow]").getByText("Onboarding").count()) === 1);
  await shot(page, `90-prototype-tab-${theme}`);

  // A hotspot: its interaction row; the details.
  await select("2:4");
  const row = panel.locator("[data-interaction]").first();
  check("an interaction row reads On click · Details", (await row.getByText("On click").count()) === 1 && (await row.getByText("Details").count()) === 1);
  check("Scroll behavior: Position for a layer in a frame", (await panel.getByRole("region", { name: "Scroll behavior" }).getByText("Position").count()) === 1);
  await shot(page, `91-prototype-hotspot-${theme}`);
  await row.getByRole("button").first().click();
  await settle(page);
  const details = page.getByRole("dialog", { name: "Interaction details" });
  check("Interaction details: the trigger, the action, its destination, Smart animate", (await details.count()) === 1 && (await details.getByText("Smart animate").count()) >= 1 && (await details.getByText("Navigate to").count()) >= 1);
  await shot(page, `92-interaction-details-${theme}`);
  // Animation → Move in: MOVE_FROM_RIGHT (Figma's ← default), then undo.
  await details.getByRole("combobox", { name: "Animation" }).click();
  await page.getByRole("option", { name: "Move in" }).click();
  await settle(page);
  check("Move in ← is stored as MOVE_FROM_RIGHT", (await interactions("2:4"))[0].actions[0].transitionType === "MOVE_FROM_RIGHT", JSON.stringify((await interactions("2:4"))[0].actions[0]));
  await shot(page, `93-interaction-move-in-${theme}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await page.keyboard.press("Meta+z");
  await settle(page);
  check("undo puts Smart animate back", (await interactions("2:4"))[0].actions[0].transitionType === "SMART_ANIMATE");

  // The canvas: noodles, the flow label, a "+" handle; a drag from it to a frame connects them.
  await select("2:5");
  await shot(page, `94-noodles-${theme}`);
  const from = await toScreen(page, 351, 60);
  const to = await toScreen(page, 475 + 187, 500);
  await drag(page, from, to, 12);
  await settle(page);
  const after = await interactions("2:5");
  check("dragging the + handle to Details adds On click → Navigate to Details", after.length === 2 && after[1].actions[0].navigationType === "NAVIGATE" && after[1].actions[0].transitionNodeID?.localID === 10, JSON.stringify(after[1] ?? null));
  check("the new connection's details open", (await page.getByRole("dialog", { name: "Interaction details" }).count()) === 1);
  await shot(page, `95-noodle-connected-${theme}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await page.keyboard.press("Meta+z");
  await settle(page);
  check("one undo takes the new connection back", (await interactions("2:5")).length === 1);

  // A top-level frame: Flow starting point "+".
  await select("2:10");
  await panel.getByRole("button", { name: "Add starting point" }).click();
  await settle(page);
  check("+ adds a flow starting point named Flow 2", (await node(page, "2:10")).prototypeStartingPoint?.name === "Flow 2", JSON.stringify((await node(page, "2:10")).prototypeStartingPoint ?? null));
  await shot(page, `96-flow-starting-point-${theme}`);
  await page.keyboard.press("Meta+z");

  // Present in this tab: the player over the editor. Next's Smart animate made slow and linear (2 s) for the shot.
  await select();
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const list = ed.engine.readNode("2:4").prototypeInteractions;
    list[0].actions[0] = { ...list[0].actions[0], transitionDuration: 2, easingType: "LINEAR" };
    ed.setProps(["2:4"], { prototypeInteractions: list }, "Edit interaction");
  });
  await page.evaluate(() => window.__designerEditor.ui.set({ presenting: { page: "0:1", node: null } }));
  await page.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().active, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => window.__designerPresent.presentState());
  const screenPoint = async (x, y) => {
    const s = await state();
    const r = await page.locator("[data-presentation] canvas").boundingBox();
    const k = s.screenRect.w / 375;
    return [r.x + s.screenRect.x + x * k, r.y + s.screenRect.y + y * k];
  };
  let s = await state();
  check("presenting starts at the flow's frame (Home, Onboarding)", s.screen === "2:1" && s.flowName === "Onboarding", JSON.stringify(s));
  await shot(page, `97-present-home-${theme}`);
  // Figma's toolbar: the sidebar toggle, comments (not available: no multiplayer), Share, the options, full screen.
  const pres = page.locator("[data-presentation]");
  check(
    "the presentation's toolbar: sidebar, comments (disabled), Share, Options, Full screen, Restart",
    (await pres.getByRole("button", { name: "Show sidebar" }).count()) === 1 &&
      (await pres.getByRole("button", { name: "Comments aren't available in this app" }).isDisabled()) &&
      (await pres.getByRole("button", { name: "Share" }).count()) === 1 &&
      (await pres.getByRole("button", { name: "Options" }).count()) === 1 &&
      (await pres.getByRole("button", { name: "Full screen" }).count()) === 1 &&
      (await pres.getByRole("button", { name: "Restart" }).count()) === 1
  );
  await pres.getByRole("button", { name: "Show sidebar" }).click();
  await settle(page);
  check("the flows sidebar lists the page's flows", (await pres.getByRole("complementary", { name: "Flows" }).locator("[data-flow]").getByText("Onboarding").count()) === 1);
  await shot(page, `140-present-flows-sidebar-${theme}`);
  await pres.getByRole("button", { name: "Hide sidebar" }).click();
  await pres.getByRole("button", { name: "Options" }).click();
  check(
    "the options: Enable Figma shortcuts, Show hints on click, Show sidebar, Hide UI, Recommended scales, Keyboard shortcuts",
    (await page.getByRole("menuitemcheckbox", { name: "Enable Figma shortcuts" }).count()) === 1 &&
      (await page.getByRole("menuitemcheckbox", { name: "Hide UI" }).count()) === 1 &&
      (await page.getByText("Recommended").count()) >= 1 &&
      (await page.getByRole("menuitem", { name: /Keyboard shortcuts/ }).count()) === 1
  );
  await page.keyboard.press("Escape");
  await page.locator("[data-presentation] canvas").focus();
  await page.keyboard.press("Shift+Slash");
  await settle(page);
  check("? shows the keyboard shortcuts", (await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count()) === 1);
  await shot(page, `142-present-keyboard-shortcuts-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  check("Esc closes the shortcuts, the presentation stays", (await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count()) === 0 && (await pres.count()) === 1);
  // The carousel scrolls sideways.
  const [cx, cy] = await screenPoint(200, 400);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(300, 0);
  await page.waitForTimeout(100);
  await shot(page, `98-present-scrolled-${theme}`);
  // Next → Details with Smart animate: half way, then there.
  const [nx, ny] = await screenPoint(100, 740);
  await page.mouse.click(nx, ny);
  await page.waitForTimeout(900);
  check("Smart animate is under way (the screen is Details, the transition runs)", await page.evaluate(() => window.__designerPresent.presentState().screen === "2:10"));
  await shot(page, `99-present-smart-animate-${theme}`);
  await page.waitForTimeout(1600);
  s = await state();
  check("a click on Next navigates to Details", s.screen === "2:10" && s.canBack === true, JSON.stringify(s));
  await shot(page, `100-present-details-${theme}`);
  // Back, then the menu overlay (bottom, dimmed).
  const [bx, by] = await screenPoint(60, 400);
  await page.mouse.click(bx, by);
  await page.waitForTimeout(100);
  check("Back returns to Home (the reverse of the Smart animate)", (await state()).screen === "2:1", JSON.stringify(await state()));
  const [mx, my] = await screenPoint(331, 60);
  await page.mouse.click(mx, my);
  await page.waitForTimeout(600);
  s = await state();
  check("Back returns; the menu button opens Menu as an overlay", s.screen === "2:1" && JSON.stringify(s.overlays) === '["2:20"]', JSON.stringify(s));
  await shot(page, `101-present-overlay-${theme}`);
  // A click where nothing reacts: hotspot hints.
  const [ox, oy] = await screenPoint(100, 150);
  await page.mouse.click(ox, oy);
  check("a click outside the overlay closes it", (await state()).overlays.length === 0);
  await page.mouse.click(ox, oy);
  await page.waitForTimeout(120);
  await shot(page, `102-present-hotspot-hints-${theme}`);
  // The toggle (an interactive component): Change to, Smart animate.
  const [tx, ty] = await screenPoint(320, 655);
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(500);
  check("the toggle changes to On", await page.evaluate(() => window.__designerEditor.engine.readNode("2:7") !== null && window.__designerPresent.readNode("2:7").symbolData.symbolID.localID === 4));
  await shot(page, `103-present-toggle-${theme}`);
  // R restarts, Esc leaves.
  await page.keyboard.press("r");
  s = await state();
  check("R restarts at the flow's start", s.screen === "2:1" && s.history === 0);
  await page.keyboard.press("Escape");
  await settle(page);
  check("Esc leaves the presentation", (await page.locator("[data-presentation]").count()) === 0);

  // Round 5 — the inline preview (⇧Space): a floating window over the canvas playing the selected frame; it follows
  // the canvas selection and edits.
  await select("2:1");
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await page.keyboard.press("Shift+Space");
  await page.waitForFunction(() => window.__designerPreview && window.__designerPreview.presentState().active, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const preview = () => page.evaluate(() => window.__designerPreview.presentState());
  let p = await preview();
  check("⇧Space opens the inline preview at the selected frame", (await page.locator("[data-inline-preview]").count()) === 1 && p.screen === "2:1", JSON.stringify(p));
  await shot(page, `105-inline-preview-${theme}`);
  if (gfx === "webgpu") check("the inline preview's own engine draws with WebGPU too", (await page.evaluate(() => window.__designerPreview.gfx)) === "webgpu");
  const previewPoint = async (x, y) => {
    const s = await preview();
    const r = await page.locator("#preview-canvas").boundingBox();
    const k = s.screenRect.w / 375;
    return [r.x + s.screenRect.x + x * k, r.y + s.screenRect.y + y * k];
  };
  const [px, py] = await previewPoint(100, 740);
  await page.mouse.click(px, py);
  await page.waitForTimeout(2300);
  check("a click in the preview plays the prototype (Next → Details)", (await preview()).screen === "2:10", JSON.stringify(await preview()));
  await select("2:20");
  await page.waitForTimeout(200);
  check("selecting another frame on the canvas jumps the preview to it", (await preview()).screen === "2:20", JSON.stringify(await preview()));
  await page.locator("[data-inline-preview]").getByRole("button", { name: "Preview options" }).click();
  check("the preview's menu: Responsive, Follow prototype, Resize window to 100%, Respect aspect ratio", (await page.getByRole("menuitemcheckbox", { name: "Follow prototype" }).count()) === 1 && (await page.getByRole("menuitemcheckbox", { name: "Respect aspect ratio" }).count()) === 1 && (await page.getByText("Resize window to 100%").count()) === 1);
  await shot(page, `106-inline-preview-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.locator("[data-inline-preview]").getByRole("button", { name: "Close preview" }).click();
  await settle(page);
  check("× closes the inline preview", (await page.locator("[data-inline-preview]").count()) === 0);

  // A device with a frame and a Model: the Prototype tab's Model, the presentation's bezel.
  await select();
  await page.evaluate(() => window.__designerEditor.setProps(["0:1"], { prototypeDevice: { type: "PRESET", presetIdentifier: "IPHONE_16_PRO_DESERT_TITANIUM", size: { x: 402, y: 874 }, rotation: "NONE" } }, "Prototype device"));
  await settle(page);
  check("Device: the preset's Model (Desert Titanium)", (await panel.getByRole("combobox", { name: "Model" }).count()) === 1 && (await panel.getByRole("combobox", { name: "Model" }).textContent()).includes("Desert Titanium"));
  await shot(page, `107-device-model-${theme}`);
  await page.evaluate(() => window.__designerEditor.ui.set({ presenting: { page: "0:1", node: null } }));
  await page.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().active, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  s = await state();
  check("presenting on a device draws its frame (Fit device on screen)", s.hasDeviceFrame === true && s.deviceFrame === true && s.scale === "FIT", JSON.stringify(s));
  await shot(page, `108-present-device-frame-${theme}`);
  await page.locator("[data-presentation]").getByRole("button", { name: "Options" }).click();
  check("the options with a device: Responsive / Fixed size", (await page.getByRole("menuitemcheckbox", { name: "Fixed size" }).count()) === 1 && (await page.getByRole("menuitemcheckbox", { name: "Responsive" }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.locator("[data-presentation]").getByRole("button", { name: "Device" }).click();
  check("the bottom bar's device menu: Fit device on screen … Show device frame", (await page.getByRole("menuitemcheckbox", { name: "Fit device on screen" }).count()) === 1 && (await page.getByRole("menuitemcheckbox", { name: "Show device frame" }).count()) === 1);
  await shot(page, `141-present-device-menu-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);
  await page.evaluate(() => window.__designerEditor.setProps(["0:1"], { prototypeDevice: null }, "Prototype device"));

  // Conditional: Figma's If expression, typed; an invalid one is outlined in red.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    const list = ed.engine.readNode("2:4").prototypeInteractions;
    const lit = (v) => ({ value: { floatValue: v }, dataType: "FLOAT" });
    const cond = { value: { expressionValue: { expressionFunction: "EQUALS", expressionArguments: [{ value: { expressionValue: { expressionFunction: "ADDITION", expressionArguments: [lit(1), lit(1)] } }, dataType: "EXPRESSION" }, lit(2)] } }, dataType: "EXPRESSION" };
    list[0].actions = [{ connectionType: "CONDITIONAL", conditionalActions: [{ condition: cond, actions: [{ ...list[0].actions[0], connectionType: "INTERNAL_NODE" }] }, { actions: [] }] }];
    ed.setProps(["2:4"], { prototypeInteractions: list }, "Edit interaction");
  });
  await select("2:4");
  await panel.locator("[data-interaction]").first().getByRole("button").first().click();
  await settle(page);
  const expr = page.getByRole("dialog", { name: "Interaction details" }).locator("[data-expression] input");
  check("the If field shows the stored expression as text", (await expr.inputValue()) === "1 + 1 == 2", await expr.inputValue());
  await expr.click();
  await expr.fill("1 + ");
  await expr.press("Enter");
  await settle(page);
  check("an unfinished expression is refused, outlined in red with its reason", (await page.getByRole("dialog", { name: "Interaction details" }).getByRole("alert").textContent()) === "The expression isn't finished");
  await shot(page, `109-conditional-expression-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await videoChecks(page, theme, panel, select);

  // The prototype tab's own route on a store file (Figma's Present opens a new tab): read-only, from the store.
  const fileKey = await page.evaluate(async (repo) => {
    const s = await import("/src/store/index.ts");
    const { encodeMessage } = await import(`/@fs${repo}/src/shared/schema/codec.ts`);
    const { PROTOTYPE_DOCUMENT } = await import("/src/editor/fixtures.ts");
    const mem = await s.getDevStore().ready;
    return (await mem.addFile({ name: "Prototype file", folderId: null, snapshot: encodeMessage(s.messageToKiwi(PROTOTYPE_DOCUMENT)) })).fileKey;
  }, repo);
  await page.goto(`${base}/?present&file=${fileKey}${gfxQuery}`);
  await page.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().active, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  s = await state();
  check("?present&file= plays the store's file (read-only) at its flow", s.screen === "2:1" && s.flowName === "Onboarding", JSON.stringify(s));
  await shot(page, `104-present-route-${theme}`);
  if (gfx === "webgpu") check("?present&file= draws with WebGPU", (await page.evaluate(() => window.__designerPresent.gfx)) === "webgpu");
}

/**
 * Video (help.figma.com 8878274530455): a .webm recorded in the page (a canvas's stream through MediaRecorder) dropped
 * on Home — a layer its size with a VIDEO fill over its poster frame, Prototype › Video —, then presented: the browser
 * plays it, its frames are drawn by the engine (two shots of the screen differ), and a video action pauses it.
 */
async function videoChecks(page, theme, panel, select) {
  const made = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 96;
    const g = c.getContext("2d");
    const stream = c.captureStream(30);
    const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 240) % 360} 80% 50%)`;
        g.fillRect(0, 0, 160, 96);
        g.fillStyle = "#fff";
        g.fillRect(((t * 120) % 200) - 40, 30, 40, 36);
        if (t < 2) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: "video/webm" });
    const file = new File([blob], "Clip.webm", { type: "video/webm" });
    const ed = window.__designerEditor;
    const r = ed.canvas.getBoundingClientRect();
    const cam = ed.engine.getCamera();
    const dt = new DataTransfer();
    dt.items.add(file);
    const at = { clientX: r.left + 20 * cam.zoom + cam.x, clientY: r.top + 120 * cam.zoom + cam.y };
    ed.canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    ed.canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    return file.size;
  });
  await page.waitForFunction(() => window.__designerEditor.engine.readNodes(["2:1"], { subtree: true, fields: ["fillPaints"] }).some((n) => n.fillPaints?.some((p) => p.type === "VIDEO")), null, { timeout: 15000 }).catch(() => {});
  const placed = await page.evaluate(() => window.__designerEditor.engine.readNodes(["2:1"], { subtree: true, fields: ["name", "size", "fillPaints", "videoPlayback"] }).find((n) => n.fillPaints?.some((p) => p.type === "VIDEO")) ?? null);
  const fill = placed?.fillPaints?.find((p) => p.type === "VIDEO");
  const hex = (h) => (h ? h.map((b) => b.toString(16).padStart(2, "0")).join("") : "");
  check(
    "a dropped .webm becomes a layer its size with a VIDEO fill (poster + video), named after the file, autoplaying",
    !!placed && placed.name === "Clip" && Math.round(placed.size.x) === 160 && Math.round(placed.size.y) === 96 && hex(fill?.video?.hash).length === 40 && hex(fill?.image?.hash).length === 40 && placed.videoPlayback?.autoplay === true,
    placed ? `${placed.name} ${placed.size.x}×${placed.size.y} ${JSON.stringify(placed.videoPlayback)} (${made} bytes)` : `nothing (${made} bytes)`
  );
  if (!placed) return;
  const stored = await page.evaluate(async ([v, p]) => {
    const images = window.__designerEditor.source.images;
    return [(await images.get(v))?.length ?? 0, (await images.get(p))?.length ?? 0];
  }, [hex(fill.video.hash), hex(fill.image.hash)]);
  check("the video file and its poster frame are in the file's image store", stored[0] > 1000 && stored[1] > 100, JSON.stringify(stored));
  await select(placed.guid);
  check("Prototype › Video: Autoplay, Loop, Sound", (await panel.getByRole("region", { name: "Video" }).count()) === 1 && (await panel.locator("[data-video-settings]").getByText("Autoplay").count()) === 1);
  await shot(page, `143-video-prototype-section-${theme}`);
  // Next (2:4): On click → Pause video on the clip.
  await page.evaluate((clip) => {
    const ed = window.__designerEditor;
    const [s, l] = clip.split(":").map(Number);
    ed.setProps(["2:4"], { prototypeInteractions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "UPDATE_MEDIA_RUNTIME", transitionNodeID: { sessionID: s, localID: l }, mediaAction: "PAUSE" }] }] }, "Edit interaction");
  }, placed.guid);
  await select("2:4");
  await panel.locator("[data-interaction]").first().getByRole("button").first().click();
  await settle(page);
  const details = page.getByRole("dialog", { name: "Interaction details" });
  check("Interaction details: Play/pause video › Pause video on Clip", (await details.getByText("Play/pause video").count()) >= 1 && (await details.getByText("Pause video").count()) >= 1 && (await details.getByText("Clip").count()) >= 1);
  await shot(page, `144-video-action-details-${theme}`);
  await page.keyboard.press("Escape");
  await select();
  await page.evaluate(() => window.__designerEditor.ui.set({ presenting: { page: "0:1", node: "2:1" } }));
  await page.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().active, null, { timeout: 15000 });
  await page.waitForFunction(() => (window.__designerPresent.presentMedia()[0]?.time ?? 0) > 0.3, null, { timeout: 8000 }).catch(() => {});
  const media = await page.evaluate(() => window.__designerPresent.presentMedia());
  check("presenting plays the video (the browser's time reaches the engine)", media.length === 1 && media[0].playing && media[0].time > 0.3, JSON.stringify(media));
  const box = await page.evaluate((id) => {
    const p = window.__designerPresent;
    const s = p.presentState();
    const r = document.querySelector("[data-presentation] canvas").getBoundingClientRect();
    const k = s.screenRect.w / 375;
    const n = window.__designerEditor.engine.readNode(id);
    return { x: r.left + s.screenRect.x + n.transform.m02 * k, y: r.top + s.screenRect.y + n.transform.m12 * k, width: n.size.x * k, height: n.size.y * k };
  }, placed.guid);
  const a = await page.screenshot({ clip: box });
  await page.waitForTimeout(400);
  const b = await page.screenshot({ clip: box });
  check("the video's frames are drawn on the screen (two moments differ)", !a.equals(b));
  await shot(page, `145-present-video-${theme}`);
  const pt = await page.evaluate(() => {
    const s = window.__designerPresent.presentState();
    const r = document.querySelector("[data-presentation] canvas").getBoundingClientRect();
    const k = s.screenRect.w / 375;
    return [r.left + s.screenRect.x + 100 * k, r.top + s.screenRect.y + 740 * k];
  });
  await page.mouse.click(pt[0], pt[1]);
  await page.waitForTimeout(200);
  const paused = await page.evaluate(() => [window.__designerPresent.presentMedia()[0]?.playing, [...(window.__designerVideos?.elements.values() ?? [])][0]?.paused]);
  check("Pause video pauses it (the engine's state and the browser's video)", paused[0] === false && paused[1] === true, JSON.stringify(paused));
  await page.keyboard.press("Escape");
  await settle(page);
  await page.evaluate(() => window.__designerEditor.engine.undo());
}

/** Grid auto layout on `?editor&doc=reference` (dark): the Grid flow, its counts, track sizes, gaps, spans, the track pills. */
async function gridSection(page, theme) {
  await open(page, "&doc=reference");
  const panel = page.locator('[data-panel="right"]');
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:1"]));
  await settle(page);
  // Flow (Figma's live Layout section): Grid straight from a plain frame.
  await panel.getByRole("radio", { name: "Grid" }).click();
  await settle(page);
  let n = await node(page, "1:1");
  check("Grid: the flow makes a 2 × 2 grid with automatic positioning", n.stackMode === "GRID" && n.gridColumns?.entries?.length === 2 && n.gridRows?.entries?.length === 2 && n.gridReflowEnabled === true, JSON.stringify({ mode: n.stackMode, cols: n.gridColumns?.entries?.length, rows: n.gridRows?.entries?.length }));
  // The counts live in the grid dimensions picker (the "Grid" row's button).
  const dims = panel.getByRole("button", { name: /^Open grid dimensions picker/ });
  check("Grid: the Grid row's button reads 2 columns and auto rows", ((await dims.getAttribute("aria-label")) ?? "").includes("2 columns and auto rows"), (await dims.getAttribute("aria-label")) ?? "");
  await dims.click();
  await settle(page);
  const cols = page.locator("[data-grid-picker]").getByRole("textbox", { name: "Number of columns" });
  await cols.click();
  await cols.fill("3");
  await cols.press("Enter");
  await settle(page);
  n = await node(page, "1:1");
  check("Grid: Number of columns 3", n.gridColumns?.entries?.length === 3, `${n.gridColumns?.entries?.length}`);
  await page.keyboard.press("Escape");
  await settle(page);
  // Column 1 at 2fr (the panel has no track rows any more — Figma's live panel; the canvas's label editor and this
  // model function write the same fields), the frame's width Fixed.
  await page.evaluate(async () => {
    const g = await import("/src/editor/model/grid.ts");
    const e = window.__designerEditor.engine;
    const f = e.readNode("1:1");
    e.setProps(["1:1"], { ...g.setTrackSizing(f, "columns", 0, g.parseTrackInput("2fr")), stackPrimarySizing: "FIXED" });
  });
  await settle(page);
  n = await node(page, "1:1");
  const sizing = n.gridColumnsSizing?.entries?.find((e) => e.id.localID === n.gridColumns.entries[0].id.localID)?.trackSize?.maxSizing;
  check("Grid: column 1 at 2fr is Fill 2fr (the frame's width Fixed)", sizing?.type === "FLEX" && sizing?.value === 2 && n.stackPrimarySizing === "FIXED", JSON.stringify(sizing));
  const gap = panel.getByRole("textbox", { name: "Gap between columns" });
  await gap.click();
  await gap.fill("24");
  await gap.press("Enter");
  await settle(page);
  check("Grid: Gap between columns 24", (await node(page, "1:1")).gridColumnGap === 24);
  await panel.locator('[aria-label="Auto layout"], [aria-label="Layout"]').first().scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, `110-grid-panel-${theme}`);
  // The track pills (live Figma, round 9): column 1's pill 31.5 px above the frame, over the middle of the column — 2fr
  // beside two Hug columns (a new grid's), 24 px gaps, no padding: it ends a gap before the first layer right of it
  // (no layers: the Hug columns are empty, it takes the width less the gaps). Expanded under the pointer.
  const pillOfColumn1 = async () => {
    const f = await node(page, "1:1");
    const kids = (await page.evaluate(() => window.__designerEditor.engine.readNode("1:1", { childIds: true }).childIds ?? [])) ?? [];
    let right = f.size.x - 2 * 24;
    for (const id of kids) {
      const k = await node(page, id);
      if (k && k.transform.m02 > 1) right = Math.min(right, k.transform.m02 - 24);
    }
    const [cx, top] = await toScreen(page, f.transform.m02 + right / 2, f.transform.m12);
    return [cx, top - 31.5];
  };
  const [x, y] = await pillOfColumn1();
  await page.mouse.move(x, y);
  await settle(page);
  await shot(page, `111-grid-track-pill-${theme}`);
  // Layers in the grid flow into its cells; one of them spans two columns.
  await page.evaluate(() => {
    const rect = (guid, position, fill) => ({ guid, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Cell", parentIndex: { guid: "1:1", position }, size: { x: 60, y: 40 }, fillPaints: [{ type: "SOLID", color: fill, opacity: 1, visible: true }] });
    window.__designerEditor.engine.applyChanges({ type: "NODE_CHANGES", nodeChanges: [rect("9:1", "!", { r: 0.05, g: 0.6, b: 1, a: 1 }), rect("9:2", '"', { r: 0.08, g: 0.68, b: 0.36, a: 1 }), rect("9:3", "#", { r: 1, g: 0.78, b: 0, a: 1 }), rect("9:4", "$", { r: 0.95, g: 0.28, b: 0.13, a: 1 })] });
  });
  await settle(page);
  const kids = ["9:1", "9:2", "9:3", "9:4"];
  await page.evaluate((id) => window.__designerEditor.engine.setSelection([id]), kids[0]);
  await settle(page);
  const span = panel.getByRole("textbox", { name: "Column span" });
  await span.click();
  await span.fill("2");
  await span.press("Enter");
  await settle(page);
  check("Grid: Column span 2 on a layer in the grid", (await node(page, kids[0])).gridColumnSpan === 2);
  await shot(page, `112-grid-span-${theme}`);
  // Number of rows: Auto (a new grid's rows), on the Grid row's button.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:1"]));
  await settle(page);
  check("Grid: Number of rows reads Auto (a new grid)", ((await panel.getByRole("button", { name: /^Open grid dimensions picker/ }).getAttribute("aria-label")) ?? "").includes("auto rows"));
  // A click on the first column's pill label selects it (round 12, live: nothing opens); Enter opens the label's field
  // and the sizing list; 120 makes it Fixed 120.
  const [px, py] = await pillOfColumn1();
  await page.mouse.move(px, py);
  await settle(page);
  await page.mouse.click(px, py);
  await settle(page);
  const editor = page.locator("[data-grid-track-editor]");
  check("Grid: a click on a column's pill selects it, nothing opens (round 12, live Figma)", (await editor.count()) === 0 && (await page.evaluate(() => window.__designerEditor.ui.get().gridTracks?.tracks?.join())) === "0");
  await page.keyboard.press("Enter");
  await settle(page);
  check("Grid: Enter on the selected column opens its label's field and its sizing list", (await editor.count()) === 1 && (await page.getByRole("menu", { name: "Column sizing" }).count()) === 1);
  await shot(page, `113-grid-track-editor-${theme}`);
  if (await editor.count()) {
    const field = editor.getByRole("textbox", { name: "Column size" });
    await field.fill("120");
    await field.press("Enter");
    await settle(page);
    n = await node(page, "1:1");
    const s0 = n.gridColumnsSizing?.entries?.find((e) => e.id.localID === n.gridColumns.entries[0].id.localID)?.trackSize?.maxSizing;
    check("Grid: the label editor makes the column Fixed 120", s0?.type === "FIXED" && s0?.value === 120, JSON.stringify(s0));
  }
  await page.keyboard.press("Escape");
  await settle(page);
  // The grid picker: 4 × 2 from the board (rows no longer Auto).
  await panel.getByRole("button", { name: /^Open grid dimensions picker/ }).click();
  await settle(page);
  await page.locator('[data-grid-cell="4x2"]').hover();
  await shot(page, `114-grid-picker-${theme}`);
  await page.locator('[data-grid-cell="4x2"]').click();
  await settle(page);
  n = await node(page, "1:1");
  check("Grid: the picker sets 4 columns × 2 rows", n.gridColumns?.entries?.length === 4 && n.gridRows?.entries?.length === 2 && n.gridAutoTracks !== "ROWS", JSON.stringify({ c: n.gridColumns?.entries?.length, r: n.gridRows?.entries?.length, auto: n.gridAutoTracks }));
}

/**
 * Round 11 at live's viewport on `&doc=capture`: Create property › Slot as live's form (popovers/
 * component-create-slot-property.txt: 304 × 626 at 896, 121) creating the property with what it collected, a property no
 * layer uses ("Not used within component" at 208, design/component-with-slot.txt); Figma's shader fills and effects — the
 * browsers' rows where live has them (fill-picker-custom.txt, effects-add-shader-effects.txt), a preset applied and drawn
 * (the node's pixels change), its settings.
 */
async function features11Section(page, theme) {
  await open(page, "&doc=capture");
  const panel = page.locator('[data-panel="right"]');
  const body = panel.locator('[role="tabpanel"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const near = (a, b, d = 1) => Math.abs(a - b) <= d;
  const rel = async (loc, box) => {
    const b = await loc.boundingBox();
    return b ? { x: Math.round(b.x - box.x), y: Math.round(b.y - box.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  // 1. Create property › Slot on Card (8:50), as live.
  await select(["8:50"]);
  await panel.getByRole("button", { name: "Create property" }).click();
  await settle(page);
  await page.getByRole("menuitem", { name: "Slot" }).click();
  await settle(page);
  const form = page.locator("[data-slot-form]");
  const pop = page.locator('[data-ds="Popover"]').filter({ has: form });
  const pb = await pop.boundingBox();
  check("R11 slot: Create property › Slot opens live's 304 × 626 form at 896, 121", !!pb && near(pb.x, 896) && near(pb.y, 121) && near(pb.width, 304) && near(pb.height, 626), JSON.stringify(pb));
  check("R11 slot: titled Create property, the name Slot", (await pop.getByRole("heading", { name: "Create property" }).count()) === 1 && (await form.getByRole("textbox", { name: "Name" }).inputValue()) === "Slot");
  const name = await rel(form.getByRole("textbox", { name: "Name" }), pb);
  check("R11 slot: Name 272 × 24 at 16, 72", !!name && near(name.x, 16) && near(name.y, 72) && near(name.w, 272) && name.h === 24, JSON.stringify(name));
  const editor = await rel(form.locator("[data-description-editor]"), pb);
  check("R11 slot: Description 272 × 155 at 16, 128, How to use this slot", !!editor && near(editor.y, 128) && near(editor.w, 272) && near(editor.h, 155) && (await form.getByText("How to use this slot").count()) === 1, JSON.stringify(editor));
  const tools = await form.getByRole("toolbar", { name: "Formatting" }).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check("R11 slot: the description's nine tools", tools.join() === "Bold,Italic,Strikethrough,Header 1,Bulleted list,Ordered list,Link,Code,Code block", tools.join());
  const bold = await rel(form.getByRole("button", { name: "Bold" }), pb);
  check("R11 slot: the tools at y 250 from 21", !!bold && near(bold.x, 21) && near(bold.y, 250), JSON.stringify(bold));
  const min = await rel(form.locator('[data-ds="NumericInput"]').filter({ has: page.getByRole("textbox", { name: "Minimum layers" }) }), pb);
  const max = await rel(form.locator('[data-ds="NumericInput"]').filter({ has: page.getByRole("textbox", { name: "Maximum layers" }) }), pb);
  check("R11 slot: Minimum / Maximum layers 120 wide at 168, 336 / 372", !!min && !!max && near(min.x, 168) && near(min.y, 336) && min.w === 120 && near(max.y, 372), JSON.stringify({ min, max }));
  const minInput = await rel(form.getByRole("textbox", { name: "Minimum layers" }), pb);
  check("R11 slot: their inputs 96 wide from the box's start (live)", !!minInput && near(minInput.x, 168) && near(minInput.w, 96), JSON.stringify(minInput));
  const checks = await form.getByRole("checkbox").evaluateAll((els) => els.map((e) => `${e.closest("label")?.textContent}${e.disabled ? " (disabled)" : ""}`));
  check("R11 slot: the three settings, fill-on-counter-axis disabled without auto layout", checks.join("|") === "Only allow preferred instances|By default, display empty slot|By default, fill items on slot's counter axis (disabled)", checks.join("|"));
  check("R11 slot: its row says Slot must have auto layout", (await form.locator('[data-tooltip="Slot must have auto layout"]').count()) === 1);
  const counter = await rel(form.locator("[data-slot-counter-axis]"), pb);
  check("R11 slot: the settings' rows at 408, 444, 480", !!counter && near(counter.y, 480), JSON.stringify(counter));
  const plus = await rel(form.getByRole("button", { name: "Select preferred values" }), pb);
  check("R11 slot: Preferred instances, Learn more and + at 272, 545", !!plus && near(plus.x, 272) && near(plus.y, 545) && (await form.getByRole("link", { name: "Learn more" }).count()) === 1, JSON.stringify(plus));
  const create = await rel(form.getByRole("button", { name: "Create property" }), pb);
  check("R11 slot: Create property 100 × 24 at 188, 594", !!create && near(create.x, 188, 2) && near(create.y, 594) && near(create.w, 100, 2), JSON.stringify(create));
  await shot(page, `320-r11-create-slot-property-${theme}`);
  await form.getByRole("textbox", { name: "Minimum layers" }).fill("1");
  await page.keyboard.press("Enter");
  await form.getByRole("textbox", { name: "Maximum layers" }).fill("3");
  await page.keyboard.press("Enter");
  await form.getByText("By default, display empty slot").click();
  await form.getByRole("button", { name: "Create property" }).click();
  await settle(page);
  const defs = await page.evaluate(() => window.__designerEditor.engine.readNode("8:50").componentPropDefs ?? []);
  const slot = defs.find((d) => d.type === "SLOT");
  check("R11 slot: Create property makes the Slot property with what the form held", slot?.name === "Slot" && slot.slotPropConfig?.minChildren === 1 && slot.slotPropConfig?.maxChildren === 3 && slot.slotPropConfig?.displayByDefault === true, JSON.stringify(slot));
  const unused = await rel(body.locator('[data-property-unused="Slot"]'), await body.boundingBox());
  check("R11 slot: a property no layer uses shows Not used within component at 208", !!unused && unused.x === 208, JSON.stringify(unused));
  await shot(page, `321-r11-component-with-slot-${theme}`);

  // 2. Shader fills: the browser beside the picker (live 240 × 510 at 719, 307), its rows, a preset applied and drawn.
  await select(["7:60"]);
  const before = await page.evaluate(() => Array.from(window.__designerEditor.engine.renderNodeThumbnailPixels({ node: "7:60", maxSize: 60 })?.pixels ?? []));
  await panel.getByRole("button", { name: "Solid color hex: D9D9D9" }).first().click();
  await settle(page);
  const picker = page.getByRole("dialog", { name: "Color picker" });
  await picker.getByRole("radio", { name: "Shader" }).click();
  await settle(page);
  const fills = page.getByRole("dialog", { name: "Shader fills" });
  const fb = await fills.boundingBox();
  const kb = await picker.boundingBox();
  // (Live's capture came after the Image tab had moved the picker up to 307; the browser sits level with the picker.)
  check("R11 shaders: Shader fills 240 × 510 at 719, level with the picker (live)", !!fb && !!kb && near(fb.x, 719) && near(fb.y, kb.y) && fb.width === 240 && near(fb.height, 510), JSON.stringify({ fb, picker: kb?.y }));
  // A text's glyph box from the popup's top, as the live dumps measure it (a Range over its text node).
  const textY = (dialog, text) =>
    dialog.evaluate((el, text) => {
      const top = el.getBoundingClientRect().top;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (t.textContent.trim() !== text) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        return Math.round(r.getBoundingClientRect().top - top);
      }
      return null;
    }, text);
  const row = (text) => textY(fills, text);
  const rows = { created: await row("Created by you"), make: await row("Create new"), figma: await row("By Figma"), first: await row("Moving gradient") };
  check("R11 shaders: the rows where live has them (95, 229, 257, 389 ± 2)", near(rows.created, 95, 2) && near(rows.make, 229, 2) && near(rows.figma, 257, 2) && near(rows.first, 389, 2), JSON.stringify(rows));
  check("R11 shaders: the ten fill presets are enabled", (await fills.locator("[data-shader-preset]:not([disabled])").count()) === 10);
  check("R11 shaders: Create with agents stays disabled (AI)", await fills.getByRole("button", { name: "Create with agents" }).isDisabled());
  await shot(page, `322-r11-shader-fills-${theme}`);
  await fills.locator('[data-shader-preset="Nebula"]').click();
  await settle(page);
  const fill = (await node(page, "7:60")).fillPaints?.[0];
  check("R11 shaders: a preset turns the fill into Figma's CUSTOM paint", fill?.type === "CUSTOM" && fill.customEffectId?.assetRef?.key === "shader.nebula" && (fill.componentPropAssignments ?? []).length === 6, JSON.stringify(fill?.customEffectId));
  check("R11 shaders: the picker shows the shader's settings", (await picker.locator('[data-shader-settings="shader.nebula"]').count()) === 1 && (await picker.getByRole("radio", { name: "Shader" }).getAttribute("aria-checked")) === "true");
  check("R11 shaders: the fill row names it", (await panel.getByRole("button", { name: "Color: Nebula" }).count()) >= 1 || (await panel.getByText("Nebula").count()) >= 1);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => Array.from(window.__designerEditor.engine.renderNodeThumbnailPixels({ node: "7:60", maxSize: 60 })?.pixels ?? []));
  const differs = (a, b) => {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 4) n += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30 ? 1 : 0;
    return n;
  };
  check("R11 shaders: the engine draws the shader fill (the layer's pixels change)", after.length > 0 && differs(before, after) > after.length / 4 / 2, `${differs(before, after)} of ${after.length / 4}`);
  await shot(page, `323-r11-shader-fill-settings-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 3. Shader effects: the Effects "+" with its onboarding card, a preset added and drawn, its settings.
  await page.evaluate(() => localStorage.removeItem("designer.effects.shaderOnboarding"));
  await select(["7:61"]);
  const plain = await page.evaluate(() => Array.from(window.__designerEditor.engine.renderNodeThumbnailPixels({ node: "7:61", maxSize: 60 })?.pixels ?? []));
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  const fx = page.getByRole("dialog", { name: "Shader effects" });
  const eb = await fx.boundingBox();
  const fxRows = { created: await textY(fx, "Created by you"), figma: await textY(fx, "By Figma") };
  check("R11 shaders: Shader effects with the card at 959, 374, its rows at 339 / 501 (live ± 2)", !!eb && near(eb.x, 959) && near(eb.y, 374) && near(fxRows.created, 339, 2) && near(fxRows.figma, 501, 2), JSON.stringify({ eb, fxRows }));
  check("R11 shaders: the 25 effect presets are enabled", (await fx.locator("[data-shader-preset]:not([disabled])").count()) === 25);
  await fx.locator('[data-shader-preset="Halftone"]').click();
  await settle(page);
  const effect = (await node(page, "7:61")).effects?.[0];
  check("R11 shaders: a preset adds Figma's CUSTOM effect", effect?.type === "CUSTOM" && effect.customEffectId?.assetRef?.key === "shader.halftone", JSON.stringify(effect?.customEffectId));
  check("R11 shaders: the effect row names the shader", (await panel.locator('[data-effect-row="CUSTOM"]').getByText("Halftone").count()) === 1);
  await page.waitForTimeout(150);
  const shaded = await page.evaluate(() => Array.from(window.__designerEditor.engine.renderNodeThumbnailPixels({ node: "7:61", maxSize: 60 })?.pixels ?? []));
  check("R11 shaders: the engine draws the shader effect (the layer's pixels change)", shaded.length > 0 && differs(plain, shaded) > 20, `${differs(plain, shaded)} px`);
  await panel.locator('[data-effect-row="CUSTOM"]').getByRole("button", { name: "Effect settings" }).click();
  await settle(page);
  const settings = page.locator('[data-shader-settings="shader.halftone"]');
  const params = await settings.locator("[data-shader-param]").evaluateAll((els) => els.map((e) => e.getAttribute("data-shader-param")));
  check("R11 shaders: the effect's settings list its parameters", params.join() === "Dot size,Angle,Mode,Ink", params.join());
  await settings.getByRole("textbox", { name: "Dot size" }).fill("16");
  await page.keyboard.press("Enter");
  await settle(page);
  const sized = (await node(page, "7:61")).effects?.[0]?.componentPropAssignments?.find((a) => (a.defID?.localID ?? Number(String(a.defID).split(":")[1])) === 1)?.value?.floatValue;
  check("R11 shaders: a parameter edit writes its assignment", sized === 16, String(sized));
  await shot(page, `324-r11-shader-effect-settings-${theme}`);
  await page.keyboard.press("Escape");
}

/** Round 6 on the engine's sample (dark): Convert to slot from the panel, an instance's slot (Limits, Add instances, More actions). */
async function slotsSection(page, theme) {
  await open(page, "");
  const panel = page.locator('[data-panel="right"]');
  await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    e.setSelection(["1:1"]);
    e.runCommand("CREATE_COMPONENT");
    e.setSelection(["1:7"]);
  });
  await settle(page);
  const convert = panel.getByRole("button", { name: "Convert to slot" });
  check("Slots: a frame inside a main shows Convert to slot", (await convert.count()) === 1);
  if (await convert.count()) await convert.click();
  await settle(page);
  const defs = await page.evaluate(() => window.__designerEditor.engine.readNode("1:1").componentPropDefs ?? []);
  check("Slots: Convert to slot adds a Slot property bound to the frame", defs.some((d) => d.name === "Slot" && d.type === "SLOT") && (await node(page, "1:7")).isSlot === true, JSON.stringify(defs.map((d) => d.name)));
  // A limit of one layer (the slot holds two): its instance's Limits turn orange.
  await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    const n = e.readNode("1:1");
    const defs = (n.componentPropDefs ?? []).map((d) => (d.type === "SLOT" ? { ...d, slotPropConfig: { maxChildren: 1, minChildren: 0 } } : d));
    e.setProps(["1:1"], { componentPropDefs: defs });
    e.runCommand("INSERT_INSTANCE", { main: "1:1", x: 1400, y: 300 });
  });
  await settle(page);
  const slot = panel.locator("[data-slot-control]");
  check("Slots: the instance's slot row has Limits, Add instances and More actions", (await slot.count()) === 1 && (await slot.getByRole("button", { name: "Add instances" }).count()) === 1 && (await slot.locator("[data-slot-limits]").count()) === 1);
  check("Slots: two layers over a limit of one is ABOVE_MAX", ((await slot.getAttribute("data-slot-violations")) ?? "").includes("ABOVE_MAX"), (await slot.getAttribute("data-slot-violations")) ?? "");
  await slot.locator("[data-slot-limits]").click();
  await settle(page);
  check("Slots: Limits lists its guidelines", (await page.locator("[data-slot-guidelines] [data-ok]").count()) >= 1);
  await shot(page, `150-slot-limits-${theme}`);
  await page.keyboard.press("Escape");
  await slot.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete contents" }).click();
  await settle(page);
  check("Slots: Delete contents empties the instance's slot", (await panel.locator("[data-slot-control]").getAttribute("data-slot-count")) === "0");
  await panel.locator("[data-slot-control]").getByRole("button", { name: "Add instances" }).click();
  await settle(page);
  check("Slots: Add instances lists the components", (await page.locator("[data-component-picker]").getByRole("menuitemradio").count()) >= 1);
  await shot(page, `151-slot-add-instances-${theme}`);
  await page.locator("[data-component-picker]").getByRole("menuitemradio").first().click();
  await settle(page);
  check("Slots: an added instance fills the slot", (await panel.locator("[data-slot-control]").getAttribute("data-slot-count").catch(() => null)) === "1" || (await selection(page)).length === 1);
}

/**
 * Round 7, the Design panel on `?editor&doc=capture` (the layers of docs/research/figma/live/design): a shot of the
 * panel per capture case (shots 170–192), then the number fields as live Figma behaves (live/behaviour/fields.md) —
 * Enter commits and gives the keys back to the canvas, the first Esc reverts and stays, the second leaves, "+10"
 * typed over a value is 10, "2^3" is 8, "Mixed+100" adds to each layer, Tab goes on to the next control — the gap's
 * Auto, "1,2,3,4" in Horizontal padding, the inline Constraints row and the Frame ▾ presets.
 */
async function designSection(page, theme) {
  await open(page, "&doc=capture");
  const panel = page.locator('[data-panel="right"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const cases = [
    ["page-nothing-selected", []],
    ["frame", ["7:1"]],
    ["frame-child-constraints", ["7:2"]],
    ["autolayout-vertical", ["7:10"]],
    ["autolayout-horizontal", ["7:20"]],
    ["autolayout-wrap", ["7:30"]],
    ["autolayout-grid", ["7:40"]],
    ["autolayout-parent-fixed", ["7:50"]],
    ["autolayout-child", ["7:51"]],
    ["rectangle", ["7:60"]],
    ["ellipse", ["7:61"]],
    ["polygon", ["7:62"]],
    ["star", ["7:63"]],
    ["line", ["7:64"]],
    ["arrow", ["7:65"]],
    ["vector", ["7:66"]],
    ["boolean", ["7:70"]],
    ["group", ["7:80"]],
    ["text", ["7:90"]],
    ["section", ["7:95"]],
    ["image-fill", ["7:96"]],
    ["multi-two-shapes", ["7:60", "7:61"]],
  ];
  for (const [i, [name, ids]] of cases.entries()) {
    await select(ids);
    await shot(page, `${170 + i}-design-${name}-${theme}`);
  }
  await select(["7:60"]);
  const header = await panel.locator("[data-type-header]").boundingBox();
  check("Design: the type header is 48 and its line (49)", Math.round(header?.height ?? 0) === 49, String(header?.height));
  check("Design: Rotate 90˚ right (Figma's ˚), no Apply variable mode without collections, no Blend mode row by default", (await panel.getByRole("button", { name: "Rotate 90˚ right" }).count()) === 1 && (await panel.getByRole("button", { name: "Apply variable mode" }).count()) === 0 && (await panel.getByRole("combobox", { name: "Blend mode" }).count()) === 0);
  const x = panel.getByRole("textbox", { name: "X-position" });
  const focus = () => page.evaluate(() => (document.activeElement?.id === "engine-canvas" ? "canvas" : (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "")));
  const xOf = (id) => page.evaluate((id) => Math.round(window.__designerEditor.engine.readNode(id).transform.m02 * 100) / 100, id);
  const x0 = await xOf("7:60");
  await x.click();
  await settle(page);
  await x.fill(`${x0}+5`);
  await x.press("Enter");
  await settle(page);
  check("Design: Enter commits (\"0+5\") and gives the keys back to the canvas", (await xOf("7:60")) === x0 + 5 && (await focus()) === "canvas", `${await xOf("7:60")} ${await focus()}`);
  await x.click();
  await settle(page);
  await x.fill("777");
  await x.press("Escape");
  await settle(page);
  const afterEsc = await x.inputValue();
  check("Design: the first Esc reverts and keeps the field focused", afterEsc === String(x0 + 5) && (await focus()) === "X-position", `${afterEsc} ${await focus()}`);
  await page.keyboard.press("Escape");
  await settle(page);
  check("Design: the second Esc gives the keys back to the canvas, the selection kept", (await focus()) === "canvas" && (await selection(page)).join() === "7:60");
  await x.click();
  await settle(page);
  await x.fill("+10");
  await x.press("Enter");
  await settle(page);
  check('Design: "+10" typed over the value sets 10', (await xOf("7:60")) === 10, String(await xOf("7:60")));
  await x.click();
  await settle(page);
  await x.fill("2^3");
  await x.press("Enter");
  await settle(page);
  check('Design: "2^3" is 8', (await xOf("7:60")) === 8, String(await xOf("7:60")));
  await x.click();
  await settle(page);
  await page.keyboard.press("Tab");
  check("Design: Tab goes on to Y", (await focus()) === "Y-position", await focus());
  await page.keyboard.press("Escape");
  await select(["7:60", "7:61"]);
  const before = [await xOf("7:60"), await xOf("7:61")];
  await x.click();
  await settle(page);
  await page.keyboard.press("End");
  await page.keyboard.type("+100");
  await page.keyboard.press("Enter");
  await settle(page);
  const after = [await xOf("7:60"), await xOf("7:61")];
  check('Design: "Mixed+100" adds 100 to each layer', after[0] === before[0] + 100 && after[1] === before[1] + 100, `${before} → ${after}`);
  // Auto layout: the gap's Auto (space between, the gap kept) and "1,2,3,4" in Horizontal padding (left 1, right 2).
  await select(["7:20"]);
  const gap = panel.getByRole("textbox", { name: "Horizontal gap between objects" });
  await gap.click();
  await settle(page);
  await gap.fill("Auto");
  await gap.press("Enter");
  await settle(page);
  const al = await node(page, "7:20");
  check('Design: gap "Auto" is space between, the gap kept', ["SPACE_BETWEEN", "SPACE_EVENLY"].includes(al.stackPrimaryAlignItems) && al.stackSpacing === 10 && (await gap.inputValue()) === "Auto", `${al.stackPrimaryAlignItems} ${al.stackSpacing}`);
  const padH = panel.getByRole("textbox", { name: "Horizontal padding" });
  await padH.click();
  await settle(page);
  await padH.fill("1,2,3,4");
  await padH.press("Enter");
  await settle(page);
  const padded = await node(page, "7:20");
  check('Design: "1,2,3,4" in Horizontal padding sets left 1 and right 2 only', padded.stackHorizontalPadding === 1 && padded.stackPaddingRight === 2 && padded.stackVerticalPadding === 16 && (padded.stackPaddingBottom ?? 16) === 16, JSON.stringify([padded.stackHorizontalPadding, padded.stackPaddingRight, padded.stackVerticalPadding, padded.stackPaddingBottom]));
  // A layer in a frame: the Constraints toggle opens the inline row (dropdowns and the widget).
  await select(["7:2"]);
  await panel.getByRole("button", { name: "Constraints" }).click();
  await settle(page);
  check("Design: Constraints opens the inline row", (await panel.locator("[data-constraints-row]").count()) === 1 && (await panel.getByRole("combobox", { name: "Horizontal constraints" }).count()) === 1);
  await shot(page, `193-design-constraints-row-${theme}`);
  await panel.getByRole("button", { name: "Constraints" }).click();
  // Frame ▾: Frame Layout Options, then the live presets under their headers.
  await select(["7:1"]);
  await panel.getByRole("button", { name: "Frame, Frame Dimension Presets" }).click();
  await settle(page);
  check("Design: Frame ▾ lists Section / Frame / Group and the presets (Phone Presets: iPhone 17 402×874)", (await page.getByText("Phone Presets").count()) === 1 && (await page.getByRole("menuitemcheckbox", { name: /iPhone 17\b/ }).count()) + (await page.getByRole("menuitem", { name: /iPhone 17\b/ }).count()) >= 1);
  await shot(page, `194-design-frame-presets-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  await designRound8(page, theme, panel, select, focus);
  await designRound9(page, theme, panel, select);
}

/** Round 8 (docs/editor.md "Round 8 — Design panel"): the live popovers, the picker's paint tabs, the Grid panel, ⇧ align. */
async function designRound8(page, theme, panel, select, focus) {
  const popup = () => page.locator('[data-ds="Popover"]').last();
  const popupBox = async () => popup().boundingBox();
  // Tab goes on through the panel's buttons as live (behaviour/fields.md #10): Rotation → Rotate 90˚ right → Flip horizontal.
  await select(["7:60"]);
  await panel.getByRole("textbox", { name: "Rotation" }).click();
  await settle(page);
  await page.keyboard.press("Tab");
  const t1 = await focus();
  await page.keyboard.press("Tab");
  const t2 = await focus();
  await page.keyboard.press("Shift+Tab");
  check("Design r8: Tab from Rotation → Rotate 90˚ right → Flip horizontal, ⇧Tab back", t1 === "Rotate 90˚ right" && t2 === "Flip horizontal" && (await focus()) === "Rotate 90˚ right", `${t1} ${t2}`);
  await select(["7:60"]);
  // The colour picker as live: six paint types (Solid … Video, Shader), flush with the panel (x 960 of 1440 here: the
  // panel's left − 240), the reticle 208 square, "On this page" squares named "Solid color hex: …".
  await panel.getByRole("button", { name: "Solid color hex: D9D9D9" }).click();
  await settle(page);
  const picker = popup();
  const types = await picker.locator('[role="radiogroup"][aria-label="Fill type"] button').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const pb = await popupBox();
  const panelBox = await panel.boundingBox();
  const reticle = await picker.getByRole("slider", { name: "Color picker reticle" }).boundingBox();
  check("Design r8: the picker's types are Solid, Gradient, Pattern, Image, Video, Shader", types.join() === "Solid,Gradient,Pattern,Image,Video,Shader", types.join());
  check("Design r8: the picker sits flush with the panel; its reticle is 208 square", pb && panelBox && Math.abs(pb.x + pb.width - (panelBox.x + 1)) <= 1 && reticle && Math.round(reticle.width) === 208 && Math.round(reticle.height) === 208, JSON.stringify([pb, panelBox?.x, reticle]));
  check("Design r8: the page's colours as live squares", (await picker.getByRole("button", { name: /^Solid color hex: [0-9A-F]{6}$/ }).count()) > 3);
  await shot(page, `250-design-picker-solid-${theme}`);
  // Pattern: Select source… then a click on a layer (Ellipse) sets it; Tile type / Scale / Spacing / Alignment.
  await picker.getByRole("radio", { name: "Pattern" }).click();
  await settle(page);
  check("Design r8: Pattern makes a PATTERN fill with Figma's defaults", (await node(page, "7:60")).fillPaints?.[0]?.type === "PATTERN");
  await picker.getByRole("button", { name: "Select source…" }).click();
  await settle(page);
  // (The Ellipse moved with "Mixed+100" above: its middle where it is now.)
  const el = await node(page, "7:61");
  const pt = await toScreen(page, el.transform.m02 + el.size.x / 2, el.transform.m12 + el.size.y / 2);
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? document.elementFromPoint(x, y)?.className, pt);
  await page.mouse.click(...pt);
  await settle(page);
  const src = (await node(page, "7:60")).fillPaints?.[0]?.sourceNodeId;
  check("Design r8: Select source… then a click on the Ellipse makes it the source (the selection kept)", src && `${src.sessionID}:${src.localID}` === "7:61" && (await selection(page)).join() === "7:60", `${JSON.stringify(src)} at ${pt} on ${under}, selection ${await selection(page)}`);
  await popup().getByRole("radio", { name: "Align bottom right" }).click();
  await settle(page);
  const pat = (await node(page, "7:60")).fillPaints?.[0];
  check("Design r8: the anchor writes the pattern's alignment", pat?.horizontalAlignment === "END" && pat?.verticalAlignment === "END", JSON.stringify(pat));
  await shot(page, `251-design-picker-pattern-${theme}`);
  // Shader: the "Shader fills (Beta)" browser beside the picker (a radio of the paint types since round 11); nothing painted until a preset is picked.
  await popup().getByRole("radio", { name: "Shader" }).click();
  await settle(page);
  check("Design r8: Shader opens the Shader fills browser", (await page.getByRole("dialog", { name: "Shader fills" }).count()) === 1);
  await shot(page, `252-design-picker-shader-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  // The gap's list over its field: its number and Auto.
  await select(["7:20"]);
  const gapField = panel.getByRole("textbox", { name: "Horizontal gap between objects" });
  await gapField.hover();
  await panel.getByRole("button", { name: "Gap sizing" }).click({ force: true });
  await settle(page);
  const gapItems = (await page.getByRole("menu").last().getByRole("menuitemcheckbox").allTextContents()).map((t) => t.trim());
  check("Design r8: the gap's list reads its number and Auto", gapItems.length === 2 && gapItems[1] === "Auto", gapItems.join());
  await page.keyboard.press("Escape");
  // Auto layout settings as live: 240 wide, Inside stroke / Canvas stacking / Align text baseline / Auto spacing / Layout.
  await panel.getByRole("button", { name: "Auto layout settings" }).click();
  await settle(page);
  const alBox = await popupBox();
  check("Design r8: Auto layout settings is 240 wide with Inside stroke, Canvas stacking, Align text baseline, Auto spacing, Layout", alBox && Math.round(alBox.width) === 240 && (await popup().getByRole("combobox", { name: "Inside stroke" }).count()) === 1 && (await popup().getByRole("radiogroup", { name: "Align text baseline" }).count()) === 1 && (await popup().getByRole("combobox", { name: "Layout" }).count()) === 1);
  await shot(page, `253-design-autolayout-settings-${theme}`);
  await page.keyboard.press("Escape");
  // Typography: the font size list over its field (the sizes only), Type settings with its preview, the font picker.
  await select(["7:90"]);
  await panel.locator('[aria-label="Font size"]').first().hover();
  await panel.getByRole("button", { name: "Font sizes" }).click({ force: true });
  await settle(page);
  const sizes = (await page.getByRole("menu").last().locator('[role="menuitemcheckbox"]').allTextContents()).map((t) => t.trim());
  check("Design r8: the font size list is 10 … 128, no Apply variable", sizes[0] === "10" && sizes[sizes.length - 1] === "128" && !sizes.some((s) => s.startsWith("Apply")), sizes.join());
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Type settings" }).click();
  await settle(page);
  const ts = await popupBox();
  check("Design r8: Type settings opens on its preview (506 high in all)", (await page.locator("[data-type-preview]").count()) === 1 && ts && Math.round(ts.height) === 506, JSON.stringify(ts));
  await shot(page, `254-design-type-settings-${theme}`);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Font family" }).click();
  await settle(page);
  check("Design r8: the font picker is titled Fonts, its search holding the family", (await popup().getByText("Fonts", { exact: true }).count()) >= 1 && (await popup().getByRole("searchbox", { name: "Search fonts" }).inputValue()) === "Inter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Effects' styles: "Effect styles", Create style, "No effect styles." and Browse libraries….
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Effects, Apply styles" }).click();
  await settle(page);
  check("Design r8: Effect styles as live (216, Browse libraries…)", Math.round((await popupBox())?.width ?? 0) === 216 && (await popup().getByText("No effect styles.").count()) === 1 && (await popup().getByRole("button", { name: "Browse libraries…" }).count()) === 1);
  await page.keyboard.press("Escape");
  // Fill's "Apply styles and variables": the colour picker on Libraries.
  await panel.getByRole("button", { name: "Fill, Apply styles and variables" }).click();
  await settle(page);
  check("Design r8: Fill's styles open the colour picker on Libraries", (await popup().getByRole("tab", { name: "Libraries" }).getAttribute("aria-selected")) === "true" && (await popup().getByText("No colors available").count()) === 1);
  await page.keyboard.press("Escape");
  // ⇧-click align: each layer to its own parent (the frame's child to F_frame's right edge, the page's Rect stays).
  const x0 = await page.evaluate(() => window.__designerEditor.engine.readNode("7:60").transform.m02);
  await select(["7:2", "7:60"]);
  await panel.getByRole("button", { name: "Align right" }).click({ modifiers: ["Shift"] });
  await settle(page);
  const child = await node(page, "7:2");
  check("Design r8: ⇧-click Align right aligns each layer in its own parent", Math.round(child.transform.m02 + child.size.x) === 240 && (await page.evaluate(() => window.__designerEditor.engine.readNode("7:60").transform.m02)) === x0, `${child.transform.m02}`);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  // The Grid panel: a selected track (the engine's SELECT_GRID_TRACKS, as a pill click) replaces the Design panel.
  await select(["7:40"]);
  await page.evaluate(() => window.__designerEditor.engine.command("SELECT_GRID_TRACKS", { frame: "7:40", axis: "ROWS", tracks: [1] }));
  await settle(page);
  const gp = panel.locator("[data-grid-panel]");
  check("Design r8: a selected row shows the Grid panel (Columns 3, Rows 2, row 2 selected)", (await gp.count()) === 1 && (await gp.getByRole("button", { name: /^Grid column \d of 3/ }).count()) === 3 && (await gp.getByRole("button", { name: "Grid row 2 of 2, selected" }).count()) === 1);
  await shot(page, `255-design-grid-panel-${theme}`);
  await gp.getByRole("button", { name: "Add column" }).click();
  await settle(page);
  check("Design r8: Add column makes 4", (await node(page, "7:40")).gridColumns?.entries?.length === 4);
  await gp.getByRole("button", { name: "Remove column 4 of 4" }).click();
  await settle(page);
  check("Design r8: Remove column 4 of 4 makes 3", (await node(page, "7:40")).gridColumns?.entries?.length === 3);
  await gp.getByRole("button", { name: "Close" }).click();
  await settle(page);
  check("Design r8: × lets the tracks go — the Design panel again", (await panel.locator("[data-grid-panel]").count()) === 0 && (await panel.locator("[data-type-header]").count()) === 1);
}

/**
 * Round 9 (docs/editor.md "Round 9 — Design panel header, component and instance panels"), on `&doc=capture` at live's
 * 1440 × 900: the header of a layer in a frame, Frame ▾ (222, hidden block titles, Section), the boolean menu (151,
 * one layer), the component block (name field, Add variant / Component configuration / More actions, Properties rows,
 * Create property), Component configuration (320 at the panel's left and top: Description in Markdown, Link), the
 * variant's Current variant, the instance (name, More actions as live with Reset name, Go to main component, the
 * 208 apply buttons, the 32 × 16 toggle, the swap menu 240 × 441 by page and folder).
 */
async function header9Section(page, theme) {
  await open(page, "&doc=capture");
  const panel = page.locator('[data-panel="right"]');
  const body = panel.locator('[role="tabpanel"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const origin = async () => body.boundingBox();
  const xs = async (locator) => {
    const o = await origin();
    return Promise.all((await locator.all()).map(async (l) => Math.round((await l.boundingBox()).x - o.x)));
  };
  const lastMenu = () => page.getByRole("menu").last();
  // 1. A rectangle in an auto layout: Select matching layers, Create component, Use as mask, More actions at 124 … 208.
  await select(["7:51"]);
  const header = panel.locator("[data-type-header]");
  const names = await header.locator("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check("R9 header: a layer in a frame has Select matching layers, Create component, Use as mask, More actions", names.join() === "Select matching layers,Create component,Use as mask,More actions", names.join());
  check("R9 header: at 124, 152, 180, 208 (live autolayout-child)", (await xs(header.locator("button"))).join() === "124,152,180,208", (await xs(header.locator("button"))).join());
  await shot(page, `260-r9-nested-header-${theme}`);
  // 2. Frame ▾ on AL_horizontal: 222 wide under its button, Section first and offered, the block titles hidden.
  await select(["7:20"]);
  const typeButton = panel.getByRole("button", { name: "Frame, Frame Dimension Presets" });
  await typeButton.click();
  await settle(page);
  const presets = lastMenu();
  const pb = await presets.boundingBox();
  const tb = await typeButton.boundingBox();
  const phone = presets.getByText("Phone Presets");
  // (Round 10, live frame-presets-menu.txt at 125 for the button's 117: 8 under it.)
  check("R9 Frame ▾: 222 wide, 8 under its button, at its left", Math.round(pb.width) === 222 && Math.round(pb.x) === Math.round(tb.x) && Math.round(pb.y) === Math.round(tb.y + tb.height + 8), JSON.stringify([pb, tb]));
  check("R9 Frame ▾: Section offered, the block titles hidden, sizes as three runs", (await presets.getByRole("menuitemcheckbox", { name: "Section" }).getAttribute("aria-disabled")) === null && ((await phone.boundingBox())?.height ?? 0) <= 1 && (await presets.getByRole("menuitem", { name: /iPhone 17\b/ }).first().locator("span > span").count()) === 3);
  await shot(page, `261-r9-frame-presets-${theme}`);
  await presets.getByRole("menuitemcheckbox", { name: "Section" }).click();
  await settle(page);
  const sel = await selection(page);
  const made = sel[0] ? await node(page, sel[0]) : null;
  check("R9 Frame ▾ › Section: a section in its place, its layers kept", made?.type === "SECTION" && made.name === "AL_horizontal" && made.transform.m02 === 420 && (await node(page, "7:21"))?.parentIndex?.guid === sel[0], JSON.stringify({ type: made?.type, name: made?.name }));
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  check("R9 Frame ▾ › Section: one undo step", (await node(page, "7:20"))?.type === "FRAME");
  // 3. Boolean operations on one rectangle: 151 wide (±2 — ⌥⇧ come from the system font, 150 on some machines), right-aligned with the chevron, every operation offered.
  await select(["7:60"]);
  const chevron = panel.getByRole("group", { name: "Boolean operations" }).getByRole("button", { name: "Boolean operations" });
  await chevron.click();
  await settle(page);
  const bm = await lastMenu().boundingBox();
  const cb = await chevron.boundingBox();
  const disabled = await lastMenu().locator('[aria-disabled="true"]').count();
  check("R9 Boolean menu: 151 wide (±2: the keys' glyphs are font metrics), its right edge the chevron's, nothing disabled for one layer", Math.abs(bm.width - 151) <= 2 && Math.round(bm.x + bm.width) === Math.round(cb.x + cb.width) && disabled === 0, JSON.stringify([bm, cb, disabled]));
  await shot(page, `262-r9-boolean-menu-${theme}`);
  await lastMenu().getByRole("menuitem", { name: /^Union/ }).click();
  await settle(page);
  const union = await node(page, (await selection(page))[0]);
  check("R9 Boolean menu › Union on one layer: a boolean group around it", union?.type === "BOOLEAN_OPERATION" && (await node(page, "7:60"))?.parentIndex?.guid === union.guid);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  // 4. The component: its name as a field, Add variant / Component configuration / More actions, Properties.
  await select(["8:1"]);
  const block = panel.locator('[data-component-header="component"]');
  check("R9 component: the name's field and Add variant, Component configuration, More actions at 152, 180, 208", (await block.locator("[data-component-name]").inputValue()) === "Button" && (await xs(block.locator(":scope > div > button"))).join() === "152,180,208", (await xs(block.locator(":scope > div > button"))).join());
  const rows = await block.locator("[data-property-def]").evaluateAll((els) => els.map((e) => e.textContent));
  check("R9 component: Properties rows read “Show icon・True”, “Label・Label”, “Icon・Star”", rows.join("|") === "Show icon・True|Label・Label|Icon・Star", rows.join("|"));
  const firstRow = await block.locator("[data-property-def]").first().boundingBox();
  const o = await origin();
  check("R9 component: the rows are 208 × 24 at 16, 76", Math.round(firstRow.width) === 208 && Math.round(firstRow.height) === 24 && Math.round(firstRow.x - o.x) === 16 && Math.round(firstRow.y - o.y) === 76, JSON.stringify(firstRow));
  await block.getByRole("button", { name: "Create property" }).click();
  await settle(page);
  const createMenu = await lastMenu().innerText();
  check("R9 Create property: caption, Variant, Text, Boolean, Instance swap, Slot, Expose properties from › Nested instances", createMenu.replace(/\n+/g, "|") === "Create property|Variant|Text|Boolean|Instance swap|Slot|Expose properties from|Nested instances", createMenu.replace(/\n+/g, "|"));
  await shot(page, `263-r9-create-property-${theme}`);
  await page.keyboard.press("Escape");
  await block.getByRole("button", { name: "Component configuration" }).click();
  await settle(page);
  const config = page.locator('[data-ds="Popover"]').last();
  const cfg = await config.boundingBox();
  const pane = await body.boundingBox();
  check("R9 Component configuration: 320 wide at the panel's left, level with its top", Math.round(cfg.width) === 320 && Math.round(cfg.x + cfg.width) === Math.round(pane.x) && Math.round(cfg.y) === Math.round(pane.y), JSON.stringify([cfg, pane]));
  const editor = config.getByRole("textbox", { name: "Description" });
  await editor.click();
  await page.keyboard.type("Primary ");
  await page.keyboard.press("Meta+b");
  await page.keyboard.type("action");
  await config.getByRole("textbox", { name: "Link to documentation" }).click();
  await page.keyboard.type("https://example.com/button");
  await page.keyboard.press("Enter");
  await settle(page);
  const described = await node(page, "8:1");
  check("R9 Component configuration: the description in Markdown (bold), the link as symbolLinks", described.description === "Primary **action**" && described.symbolLinks?.[0]?.uri === "https://example.com/button", JSON.stringify([described.description, described.symbolLinks]));
  await shot(page, `264-r9-component-configuration-${theme}`);
  await page.keyboard.press("Escape");
  // 5. The set and a variant.
  await select(["8:40"]);
  check("R9 set: Multi-edit variants at 124", (await xs(panel.locator('[data-component-header="set"]').locator(":scope > div > button"))).join() === "124,152,180,208");
  await select(["8:41"]);
  const variant = panel.locator('[data-component-header="variant"]');
  check("R9 variant: the set's name, Multi-edit variants, Select matching layers, Component configuration", (await variant.locator("[data-component-name]").inputValue()) === "Chip" && (await variant.locator(":scope > div > button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).join() === "Multi-edit variants,Select matching layers,Component configuration");
  const value = variant.getByRole("textbox", { name: "Edit property value for State" });
  await value.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Active");
  await page.keyboard.press("Enter");
  await settle(page);
  check("R9 Current variant: a typed value is this variant's", (await node(page, "8:41"))?.name === "State=Active", (await node(page, "8:41"))?.name);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  await variant.getByRole("button", { name: "Select component" }).click();
  await settle(page);
  check("R9 Current variant: Select component selects the set", (await selection(page)).join() === "8:40");
  // 6. The instance: name, More actions as live, Reset name, the property rows, the swap menu.
  await select(["8:60"]);
  const inst = panel.locator("[data-instance-header]");
  check("R9 instance: the main's name, a 32 × 16 toggle, apply buttons at 208", (await inst.locator("[data-instance-menu]").innerText()).trim() === "Button" && Math.round((await inst.getByRole("switch", { name: "Show icon" }).boundingBox()).width) === 32 && (await xs(inst.getByRole("button", { name: /^Apply variable\/property to / }))).join() === "208,208");
  await inst.getByRole("button", { name: "More actions" }).click();
  await settle(page);
  const more = (await lastMenu().locator('[role^="menuitem"]').allInnerTexts()).map((t) => t.split("\n")[0].trim());
  check("R9 instance More actions as live", more.join("|") === "Toggle ready for dev status|Create component|Detach instance|Reset instance|Reset name|Use as mask|Union|Subtract|Intersect|Exclude|Flatten", more.join("|"));
  check("R9 instance More actions: 221 wide, right-aligned with its button", Math.abs(Math.round((await lastMenu().boundingBox()).width) - 221) <= 1);
  await shot(page, `265-r9-instance-more-${theme}`);
  await lastMenu().getByRole("menuitem", { name: "Reset name" }).click();
  await settle(page);
  check("R9 Reset name: the main's name back", (await node(page, "8:60"))?.name === "Button");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  await inst.getByRole("button", { name: "More actions" }).click();
  await lastMenu().getByRole("menuitem", { name: /^Flatten/ }).click();
  await settle(page);
  const flat = await node(page, (await selection(page))[0] ?? "");
  check("R9 instance › Flatten: detached and flattened into one vector, one undo step", flat?.type === "VECTOR", flat?.type);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  check("R9 instance › Flatten undone: the instance again", (await node(page, "8:60"))?.type === "INSTANCE");
  await select(["8:60"]);
  await inst.locator("[data-instance-menu]").click();
  await settle(page);
  const swap = page.locator('[data-ds="Popover"]').last();
  const sb = await swap.boundingBox();
  const panelBox = await panel.boundingBox();
  check("R9 swap menu: 240 × 441, 40 from the panel's right, under the name", Math.round(sb.width) === 240 && Math.round(sb.height) === 441 && Math.round(sb.x + sb.width) === Math.round(panelBox.x + panelBox.width - 40), JSON.stringify(sb));
  check("R9 swap menu: Swap instance, Search in this library, Created in this file, the page Capture with Button, Card, Chip and the folder Icon", (await swap.getByText("Swap instance", { exact: true }).count()) >= 1 && (await swap.getByRole("textbox", { name: "Search in this library" }).count()) === 1 && (await swap.locator("[data-level]").getAttribute("data-level")) === "Capture" && (await swap.getByRole("menuitemradio").allInnerTexts()).map((t) => t.trim()).join() === "Button,Card,Chip" && (await swap.locator('[data-folder="Icon"]').count()) === 1);
  await shot(page, `266-r9-swap-menu-${theme}`);
  await swap.locator('[data-folder="Icon"]').click();
  await settle(page);
  check("R9 swap menu: a folder lists its components", (await swap.locator("[data-level]").getAttribute("data-level")) === "Icon" && (await swap.getByRole("menuitemradio").allInnerTexts()).map((t) => t.trim()).join() === "Heart,Star");
  await page.keyboard.press("Escape");
  await settle(page);
  await inst.locator('[data-swap-property="Icon"]').click();
  await settle(page);
  const choose = page.locator('[data-ds="Popover"]').last();
  check("R9 Instance swap property: Choose instance, opened at the Icon folder", (await choose.getByText("Choose instance", { exact: true }).count()) === 1 && (await choose.locator("[data-level]").getAttribute("data-level")) === "Icon");
  await page.keyboard.press("Escape");
  await select(["8:61"]);
  check("R9 variant instance: the set's name", (await panel.locator("[data-instance-menu]").innerText()).trim() === "Chip");
}

/** Round 9 (docs/editor.md "Round 9 — Design panel sections and popovers"): the sections and popovers against live/. */
async function designRound9(page, theme, panel, select) {
  const popup = () => page.locator('[data-ds="Popover"]').last();
  const popupBox = async () => popup().boundingBox();
  const box = async (loc) => loc.boundingBox();
  // Individual corners (live design/rectangle-individual-corners.txt): a 2 × 2 grid, no captions, smoothing beside the bottom row.
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Individual corners" }).click();
  await settle(page);
  const tl = await box(panel.getByRole("textbox", { name: "Top left corner radius" }));
  const bl = await box(panel.getByRole("textbox", { name: "Bottom left corner radius" }));
  const sm = await box(panel.getByRole("button", { name: "Corner smoothing" }));
  check("Design r9: individual corners in two rows 32 apart, Corner smoothing beside the bottom one, no captions", tl && bl && sm && Math.round(bl.y - tl.y) === 32 && Math.round(sm.y) === Math.round(bl.y) && (await panel.getByText("Top corners").count()) === 0, JSON.stringify([tl?.y, bl?.y, sm?.y]));
  await shot(page, `256-design-individual-corners-${theme}`);
  await panel.getByRole("button", { name: "Individual corners" }).click();
  // Add stroke on a rectangle: Inside (live design/rectangle-with-stroke.txt).
  await panel.getByRole("button", { name: "Add stroke" }).click();
  await settle(page);
  check("Design r9: Add stroke on a rectangle makes it Inside", (await node(page, "7:60")).strokeAlign === "INSIDE", (await node(page, "7:60")).strokeAlign);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  // Line: "Start point" / "End point" over two dropdowns, 76 and 72 wide (live design/line.txt).
  await select(["7:64"]);
  const sp = await box(panel.getByRole("button", { name: "Start point" }));
  const ep = await box(panel.getByRole("button", { name: "End point" }));
  check("Design r9: Start point 76 and End point 72 under their captions", sp && ep && Math.round(sp.width) === 76 && Math.round(ep.width) === 72 && (await panel.getByText("Start point", { exact: true }).count()) === 1 && (await panel.getByText("End point", { exact: true }).count()) === 1, JSON.stringify([sp?.width, ep?.width]));
  // Effects: the row's name 11px / 400; the type menu flips above its button when there is no room below (live 967,449).
  await page.evaluate(() => localStorage.setItem("designer.effects.shaderOnboarding", "done"));
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  const weight = await panel.getByText("Drop shadow", { exact: true }).first().evaluate((el) => getComputedStyle(el).fontWeight);
  check("Design r9: the effect row's name is 11px / 400", weight === "400", weight);
  await panel.getByRole("button", { name: "Effect settings" }).first().click();
  await settle(page);
  const trigger = await box(popup().getByRole("combobox", { name: "Effect settings" }));
  await popup().getByRole("combobox", { name: "Effect settings" }).click();
  await settle(page);
  const list = await box(page.getByRole("listbox").last());
  check("Design r9: the effect type menu opens 12 above its button, at its left (no room below)", trigger && list && Math.round(list.y + list.height) === Math.round(trigger.y) - 12 && Math.round(list.x) === Math.round(trigger.x), JSON.stringify([trigger, list]));
  await shot(page, `257-design-effect-type-menu-${theme}`);
  await page.getByRole("option", { name: "Layer blur" }).click();
  await settle(page);
  check("Design r9: Layer blur's Type control has its legend", (await popup().getByText("Type", { exact: true }).count()) === 1 && (await popup().getByRole("radiogroup", { name: "Type" }).count()) === 1);
  await popup().getByRole("combobox", { name: "Effect settings" }).click();
  await page.getByRole("option", { name: "Glass" }).click();
  await settle(page);
  check("Design r9: Glass's Refraction … Splay are sliders with their values", (await popup().getByRole("slider", { name: "Refraction" }).count()) === 1 && (await popup().getByRole("slider", { name: "Splay" }).count()) === 1 && (await popup().getByRole("textbox", { name: "Splay" }).count()) === 1);
  await shot(page, `258-design-effect-glass-${theme}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  // The shader effects browser with its onboarding: 240 × 510, "Try an example" enabled.
  await page.evaluate(() => localStorage.removeItem("designer.effects.shaderOnboarding"));
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  const shaders = page.getByRole("dialog", { name: "Shader effects" });
  const sb = await box(shaders);
  check("Design r9: the shader effects browser is 240 × 510 with Try an example enabled", sb && Math.round(sb.width) === 240 && Math.round(sb.height) === 510 && (await shaders.getByRole("button", { name: "Try an example" }).isEnabled()), JSON.stringify(sb));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  await settle(page);
  // Styles popovers: 216 × 165 (live popovers/effect-styles.txt).
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Effects, Apply styles" }).click();
  await settle(page);
  const st = await popupBox();
  check("Design r9: Effect styles is 216 × 165", st && Math.round(st.width) === 216 && Math.round(st.height) === 165, JSON.stringify(st));
  await page.keyboard.press("Escape");
  // Export: Export file type (74) and Advanced export settings (240 × 184); the menu reads JPEG.
  await panel.getByRole("button", { name: "Add export settings" }).click();
  await settle(page);
  const ft = await box(panel.getByRole("combobox", { name: "Export file type" }));
  check("Design r9: the export row's file type is 74 wide", ft && Math.round(ft.width) === 74, JSON.stringify(ft));
  await panel.getByRole("combobox", { name: "Export file type" }).click();
  await settle(page);
  check("Design r9: the file types read PNG, JPEG, SVG, PDF", (await page.getByRole("option", { name: "JPEG" }).count()) === 1);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Advanced export settings" }).click();
  await settle(page);
  const ex = await popupBox();
  check("Design r9: Advanced export settings is 240 × 184", ex && Math.round(ex.width) === 240 && Math.round(ex.height) === 184, JSON.stringify(ex));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.undo());
  // The grid dimensions picker (live grid/grid-dimensions-picker.txt): 210 × 204, 12 × 8 cells, Open grid settings.
  await select(["7:40"]);
  const dims = panel.getByRole("button", { name: /^Open grid dimensions picker/ });
  const db = await box(dims);
  await dims.click();
  await settle(page);
  const gpk = await box(page.locator("[data-grid-picker]").locator("xpath=.."));
  const pk = await popupBox();
  check("Design r9: the grid picker is 210 × 204, 12 left of and 57 above the grid's button, 96 cells", pk && db && Math.round(pk.width) === 210 && Math.round(pk.height) === 204 && Math.round(pk.x) === Math.round(db.x) - 12 && Math.round(pk.y) === Math.round(db.y) - 57 && (await page.locator("[data-grid-cell]").count()) === 96, JSON.stringify([pk, db, gpk]));
  await page.locator('[data-grid-cell="4x3"]').hover();
  await settle(page);
  await shot(page, `259-design-grid-picker-${theme}`);
  await page.getByRole("button", { name: "Open grid settings" }).click();
  await settle(page);
  check("Design r9: Open grid settings shows the Grid panel", (await panel.locator("[data-grid-panel]").count()) === 1);
  await panel.locator("[data-grid-panel]").getByRole("button", { name: "Close" }).click();
  await settle(page);
  check("Design r9: its × goes back to the Design panel", (await panel.locator("[data-grid-panel]").count()) === 0);
}

/**
 * Round 10 (docs/editor.md "Round 10 — Design panel states, popovers and sub-menus") at live's 1440 × 900: the nested
 * instance's locks, Align on a frame, disabled fields, grid spans, Selection colors, Frame ▾ past the window,
 * Individual strokes above its button, the font filter's groups, the settings popovers' numbers, the grid track list,
 * vector edit mode, the instance's name, Auto layout settings' place.
 */
async function panel10Section(page, theme) {
  await open(page, "&doc=capture");
  const panel = page.locator('[data-panel="right"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const box = async (loc) => loc.boundingBox();
  const disabled = async (loc) => loc.first().isDisabled();
  // 1. The Button inside Card instance (live design/nested-instance.txt).
  await select(["I8:62;8:51"]);
  const locks = await Promise.all(["X-position", "Rotation"].map((n) => disabled(panel.getByRole("textbox", { name: n }))));
  const flow = await panel.getByRole("radiogroup", { name: "Layout" }).getByRole("radio").evaluateAll((els) => els.every((e) => e.disabled));
  const r90 = await disabled(panel.getByRole("button", { name: /^Rotate 90/ }));
  check("R10 nested instance: X / Y, Rotation, Rotate 90, Flow disabled; W / H as live's lists", locks.every(Boolean) && flow && r90 && (await panel.getByRole("listbox", { name: "Advanced auto layout settings" }).count()) === 2, JSON.stringify({ locks, flow, r90 }));
  await shot(page, `300-r10-nested-instance-${theme}`);
  // 2. Align on a single frame enabled; an ellipse's corner radius and a line's height disabled.
  await select(["7:1"]);
  check("R10 a frame alone: Align left enabled", !(await disabled(panel.getByRole("button", { name: "Align left" }))));
  await select(["7:61"]);
  check("R10 an ellipse: Corner radius disabled", await disabled(panel.getByRole("textbox", { name: "Corner radius" })));
  await select(["7:64"]);
  check("R10 a line: Height disabled", await disabled(panel.getByRole("textbox", { name: "Height" })));
  // 3. A grid child: Column span and Row span captions.
  await select(["7:41"]);
  check("R10 grid child: Column span and Row span", (await panel.getByText("Column span", { exact: true }).count()) === 1 && (await panel.getByText("Row span", { exact: true }).count()) === 1);
  // 4. Rect + Ellipse + Text + F_frame: four colours, no link, live's order.
  await select(["7:60", "7:61", "7:90", "7:1"]);
  const colors = await panel.locator('section[aria-label="Selection colors"] button[aria-label^="Solid color hex"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").slice(-6)));
  check("R10 Selection colors: D9D9D9, 000000, 3380FF, FFFFFF, no See all", colors.join() === "D9D9D9,000000,3380FF,FFFFFF" && (await panel.getByText(/^See all/).count()) === 0, colors.join());
  // 5. Frame ▾: one list past the window's bottom, 8 under the button.
  await select(["7:20"]);
  const fb = await box(panel.getByRole("button", { name: "Frame, Frame Dimension Presets" }));
  await panel.getByRole("button", { name: "Frame, Frame Dimension Presets" }).click();
  await settle(page);
  const pm = await box(page.getByRole("menu").last());
  check("R10 Frame ▾: 222 wide, 8 under its button, longer than the window (not cut)", pm && fb && Math.round(pm.width) === 222 && Math.round(pm.y) === Math.round(fb.y + fb.height + 8) && pm.height > 900, JSON.stringify(pm));
  await page.keyboard.press("Escape");
  await settle(page);
  // 6. Individual strokes: flips above its button, 12 away.
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Add stroke" }).click();
  await settle(page);
  const sb = await box(panel.getByRole("button", { name: "Individual strokes" }));
  await panel.getByRole("button", { name: "Individual strokes" }).click();
  await settle(page);
  const sm = await box(page.getByRole("menu").last());
  check("R10 Individual strokes: 117 × 159 above its button", sm && sb && Math.round(sm.width) === 117 && Math.round(sm.height) === 159 && Math.round(sm.y + sm.height) === Math.round(sb.y - 12), JSON.stringify([sm, sb]));
  await shot(page, `301-r10-individual-strokes-${theme}`);
  await page.keyboard.press("Escape");
  // 7. Effect settings: the numbers 110 wide, 1 from the field's end.
  await page.evaluate(() => localStorage.setItem("designer.effects.shaderOnboarding", "done"));
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  await panel.getByRole("button", { name: "Effect settings" }).first().click();
  await settle(page);
  const blur = await box(page.locator('[data-ds="Popover"]').last().getByRole("textbox", { name: "Blur radius" }));
  check("R10 effect settings: Blur radius's number 110 wide", blur && Math.round(blur.width) === 110, JSON.stringify(blur));
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.__designerEditor.engine.undo();
    window.__designerEditor.engine.undo();
  });
  await settle(page);
  // 8. The font filter's groups (live popovers/font-picker-filter-menu.txt).
  await select(["7:90"]);
  await panel.getByRole("button", { name: "Font family" }).click();
  await settle(page);
  await page.getByRole("combobox", { name: "Font filter" }).click();
  await settle(page);
  const filters = await page.getByRole("listbox").last().getByRole("option").allInnerTexts();
  check("R10 font filter: live's order and wording", filters.map((t) => t.trim()).join() === "All fonts,In this file,Popular fonts,Google fonts,Variable fonts,Uploaded by you,Installed by you", filters.join());
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);
  // 9. A grid's row: Fixed height with its size.
  await select(["7:40"]);
  await page.evaluate(() => window.__designerEditor.engine.command("SELECT_GRID_TRACKS", { frame: "7:40", axis: "ROWS", tracks: [1] }));
  await settle(page);
  await panel.getByRole("button", { name: "Row 2 sizing" }).click();
  await settle(page);
  const tm = page.getByRole("menu").last();
  check("R10 grid track list: Fixed height (84), 156 wide", (await tm.getByText("Fixed height (84)").count()) === 1 && Math.round((await box(tm)).width) === 156, JSON.stringify(await box(tm)));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.engine.command("SELECT_GRID_TRACKS", { frame: "7:40", axis: "ROWS", tracks: [] }));
  await settle(page);
  // 10. Vector edit mode (live design/vector-edit-mode.txt): Vector, Mirroring, Fill and Stroke only.
  await select(["7:66"]);
  const started = await page.evaluate(() => window.__designerEditor.vector.start("7:66"));
  await settle(page);
  if (started) {
    const titles = await panel.locator('[role="tabpanel"] section').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check("R10 vector edit: Vector, Fill, Stroke; Mirroring's three glyphs", titles.join() === "Vector,Fill,Stroke" && (await panel.getByRole("radiogroup", { name: "Mirroring" }).getByRole("radio").count()) === 3, titles.join());
    await shot(page, `302-r10-vector-edit-${theme}`);
    await page.evaluate(() => window.__designerEditor.vector.end());
    await settle(page);
  } else results.push("info R10 vector edit: the engine has no startVectorEdit");
  // 11. The instance's name is plain text (no button), Auto layout settings 4 above its button.
  await select(["8:60"]);
  check("R10 instance: the name isn't a button", (await panel.locator("[data-instance-menu]").evaluate((e) => e.tagName)) !== "BUTTON");
  await select(["7:20"]);
  const ab = await box(panel.getByRole("button", { name: "Auto layout settings" }));
  await panel.getByRole("button", { name: "Auto layout settings" }).click();
  await settle(page);
  const ap = await box(page.locator('[data-ds="Popover"]').last());
  check("R10 Auto layout settings: 4 above its button", ap && ab && Math.round(ap.y) === Math.round(ab.y) - 4, JSON.stringify([ap?.y, ab?.y]));
  await page.keyboard.press("Escape");
}

/**
 * Round 11 (docs/editor.md "Round 11 — Design panel and popovers") at 1440 × 900 on `&doc=capture`: an instance's
 * flow, a mixed selection's W / H, the text edit header, Auto layout settings, the gradient stop row, the list menus
 * over their field, Text styles and the font size list, Type settings › Details — live's places
 * (docs/research/figma/live/design, popovers).
 */
async function panel11Section(page, theme) {
  await open(page, "&doc=capture");
  const panel = page.locator('[data-panel="right"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  const box = async (loc) => loc.boundingBox();
  const lastPopup = () => page.locator('[data-ds="Popover"], [role="menu"], [role="listbox"]').last();
  // 1. The Chip instance (a component without auto layout): Layout > Dimensions, no Flow, no Use auto layout.
  await select(["8:61"]);
  const dims = await box(panel.getByText("Dimensions", { exact: true }));
  check("R11 Chip instance: no Flow row, no Use auto layout, Dimensions at 350 (live)", (await panel.getByRole("radiogroup", { name: "Layout" }).count()) === 0 && (await panel.getByRole("button", { name: "Use auto layout" }).count()) === 0 && dims && Math.round(dims.y) - 80 === 350, JSON.stringify(dims));
  // 2. The Button instance (auto layout): Flow and Wrap shown, disabled.
  await select(["8:60"]);
  const radios = await panel.getByRole("radiogroup", { name: "Layout" }).getByRole("radio").evaluateAll((els) => els.map((e) => e.disabled));
  check("R11 Button instance: the four Flow radios and Wrap disabled", radios.length === 4 && radios.every(Boolean) && (await panel.getByRole("button", { name: "Wrap" }).isDisabled()), JSON.stringify(radios));
  // 3. Rect + Ellipse + Text + F_frame: W and H disabled, Mixed.
  await select(["7:60", "7:61", "7:90", "7:1"]);
  const w = panel.getByRole("textbox", { name: "Width", exact: true });
  check("R11 mixed selection: Width and Height disabled", (await w.isDisabled()) && (await panel.getByRole("textbox", { name: "Height", exact: true }).isDisabled()));
  // 4. Text edit mode: Create link 152, Apply variable 180, Create component 208, no More actions.
  await select(["7:90"]);
  await page.evaluate(() => window.__designerEditor.engine.startTextEdit?.("7:90"));
  await settle(page);
  const header = panel.locator("[data-type-header]");
  const xs = await Promise.all(["Create link", "Apply variable", "Create component"].map(async (n) => Math.round(((await box(header.getByRole("button", { name: n }))) ?? { x: 0 }).x) - 1200));
  check("R11 text edit header: Create link 152, Apply variable 180, Create component 208, no More actions", xs.join() === "152,180,208" && (await header.getByRole("button", { name: "More actions" }).count()) === 0, xs.join());
  await page.evaluate(() => window.__designerEditor.engine.endTextEdit?.());
  await settle(page);
  // 5. Auto layout settings on AL_horizontal: Inside stroke Included; Auto spacing's Between dimmed.
  await select(["7:20"]);
  await panel.getByRole("button", { name: "Auto layout settings" }).click();
  await settle(page);
  const between = await lastPopup().getByText("Between", { exact: true }).evaluate((e) => getComputedStyle(e).color);
  check("R11 Auto layout settings: Inside stroke Included, Between #ffffff66", (await lastPopup().getByText("Included", { exact: true }).count()) === 1 && between === "rgba(255, 255, 255, 0.4)", between);
  await page.keyboard.press("Escape");
  // 6. The W list over its field (live 166 × 129 at 1138,399) and the gap list (1244,473).
  await panel.getByRole("button", { name: "Horizontal resizing sizing" }).click({ force: true });
  await settle(page);
  const wm = await box(page.getByRole("menu").last());
  check("R11 W list at 1138,399, 166 wide (±1)", wm && Math.abs(wm.x - 1138) <= 1 && Math.round(wm.y) === 399 && Math.abs(wm.width - 166) <= 1, JSON.stringify(wm));
  await page.keyboard.press("Escape");
  await panel.getByRole("textbox", { name: "Horizontal gap between objects" }).hover();
  await panel.getByRole("button", { name: "Gap sizing" }).click({ force: true });
  await settle(page);
  const gm = await box(page.getByRole("menu").last());
  check("R11 gap list at 1244,473, 156 × 64", gm && Math.round(gm.x) === 1244 && Math.round(gm.y) === 473 && Math.round(gm.width) === 156, JSON.stringify(gm));
  await page.keyboard.press("Escape");
  // 7. Text styles (live 216 × 165 at 984,427) and the font size list (96 × 437).
  await select(["7:90"]);
  await panel.getByRole("button", { name: "Typography, Apply styles" }).click();
  await settle(page);
  const ts = await box(page.locator('[data-ds="Popover"]').last());
  check("R11 Text styles at 984,427", ts && Math.round(ts.x) === 984 && Math.round(ts.y) === 427, JSON.stringify(ts));
  await page.keyboard.press("Escape");
  await panel.locator('[aria-label="Font size"]').first().hover();
  await panel.getByRole("button", { name: "Font sizes" }).click({ force: true });
  await settle(page);
  const fs = await box(page.getByRole("menu").last());
  check("R11 font size list 96 × 437", fs && Math.round(fs.width) === 96 && Math.round(fs.height) === 437, JSON.stringify(fs));
  await page.keyboard.press("Escape");
  // 8. Type settings: Paragraph spacing's number 63 wide at 161; Underline details enabled; Details on live's text.
  await page.evaluate(() => window.__designerEditor.engine.setProps(["7:90"], { textData: { characters: "Hello Figma text" } }));
  await settle(page);
  await panel.getByRole("button", { name: "Type settings" }).click();
  await settle(page);
  const ps = await box(lastPopup().getByRole("textbox", { name: "Paragraph spacing" }));
  check("R11 Type settings: Paragraph spacing 63 × 24 at 160-161, Underline details enabled", ps && Math.round(ps.width) === 63 && Math.abs(ps.x - 960 - 161) <= 1 && !(await lastPopup().getByRole("button", { name: "Underline details" }).isDisabled()), JSON.stringify(ps));
  await lastPopup().getByRole("tab", { name: "Details" }).click();
  await settle(page);
  const dim = async (label) => lastPopup().getByText(label, { exact: true }).evaluate((e) => getComputedStyle(e).color);
  const colors = await Promise.all(["Slashed zero", "Open four", "Lower-case L with tail", "Kerning pairs"].map(dim).map((p) => p.catch(() => "")));
  const curves = await box(lastPopup().getByText("Disambiguation without slashed zero", { exact: true }));
  check("R11 Details: Slashed zero, Open four dimmed; Lower-case L with tail, Kerning pairs not; long names on two lines", colors[0] === "rgba(255, 255, 255, 0.4)" && colors[1] === "rgba(255, 255, 255, 0.4)" && colors[2].startsWith("rgba(255, 255, 255, 0.69") && colors[3].startsWith("rgba(255, 255, 255, 0.69") && curves && curves.height > 28, JSON.stringify({ colors, h: curves?.height }));
  await shot(page, `310-r11-type-details-${theme}`);
  await page.keyboard.press("Escape");
  // 9. The gradient's stop row (live: the hex 58 at 93, the opacity's number 32 at 152; Delete enabled with two stops).
  await select(["7:60"]);
  await panel.getByRole("button", { name: "Solid color hex: D9D9D9" }).click();
  await settle(page);
  await page.locator('[aria-label="Color picker"] [aria-label="Gradient"]').first().click({ force: true });
  await settle(page);
  const picker = page.locator('[aria-label="Color picker"]').last();
  const pb = await box(picker);
  const hex = await box(picker.getByRole("textbox", { name: "Gradient Stop Color" }).first());
  const op = await box(picker.getByRole("textbox", { name: "Gradient Stop Color opacity" }).first());
  check("R11 gradient stop row: hex 58 at 93, opacity 32 at 152, Delete enabled with two stops, Paint type 96 × 32", pb && hex && op && Math.round(hex.x - pb.x) === 93 && Math.round(hex.width) === 58 && Math.round(op.x - pb.x) === 152 && Math.round(op.width) === 32 && !(await picker.getByRole("button", { name: "Delete gradient stop" }).first().isDisabled()) && Math.round((await box(picker.getByRole("group", { name: "Paint type" })))?.height ?? 0) === 32, JSON.stringify({ hex, op, pb }));
  await page.keyboard.press("Escape");
}

/** Round 6: the Local variables window's mode and collection menus (Import / Export), Minimize / Expand, Hide panel. */
async function variables6Section(page, theme) {
  await open(page, "&doc=variables");
  await page.evaluate(() => window.__designerEditor.ui.set({ variablesOpen: true }));
  await settle(page);
  const win = page.locator("[data-local-variables]");
  await win.locator("[data-mode]").first().click({ button: "right" });
  await settle(page);
  check("Variables: a mode's menu has Import mode and Export mode", (await page.getByRole("menuitem", { name: "Import mode" }).count()) === 1 && (await page.getByRole("menuitem", { name: "Export mode" }).count()) === 1);
  await shot(page, `152-variables-mode-menu-${theme}`);
  await page.keyboard.press("Escape");
  await win.locator("[data-collection]").first().click({ button: "right" });
  await settle(page);
  check("Variables: a collection's menu has Export modes", (await page.getByRole("menuitem", { name: "Export modes" }).count()) === 1);
  await page.keyboard.press("Escape");
  // Live (rail-variables-table.txt): Minimize is a toggle; Hide panel in the sidebar's header.
  await win.getByRole("checkbox", { name: "Minimize" }).click();
  await settle(page);
  check("Variables: Minimize makes it a modal", (await win.getAttribute("data-minimized")) === "true");
  await shot(page, `153-variables-minimized-${theme}`);
  await win.getByRole("button", { name: "Hide panel" }).click();
  await settle(page);
  check("Variables: Hide panel hides the collections", (await win.getByRole("complementary", { name: "Collections" }).count()) === 0);
  await win.getByRole("checkbox", { name: "Minimize" }).click();
  await settle(page);
  check("Variables: Expand fills the window again", (await win.getAttribute("data-minimized")) === null);
}

/**
 * Round 7 on `?editor&doc=empty` (dark): live Figma's selection and canvas — sections (⌘S, the pill), the canvas menu's
 * items, Paste to replace in the menu, Esc / \, N, the opacity digits, ] / [, corner radius handles, smart selection's
 * gap handles, auto layout's bars and its Hug badge, the dashed auto-layout parent, ⇧⌘O outlines, the pixel grid.
 */
async function selectionSection(page, theme) {
  await open(page, "&doc=empty");
  const fill = (hex) => [{ type: "SOLID", color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  await page.evaluate((fills) => {
    const e = window.__designerEditor.engine;
    const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
    const rect = (id, name, x, y, w, h, parent = "0:1", pos = "!", f = fills.grey) => ({ guid: id, phase: "CREATED", type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: f });
    e.applyChanges({
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        rect("5:1", "S1", 0, 0, 60, 60, "0:1", "!"),
        rect("5:2", "S2", 80, 0, 60, 60, "0:1", '"'),
        rect("5:3", "S3", 160, 0, 60, 60, "0:1", "#"),
        rect("5:4", "Big", 0, 120, 240, 160, "0:1", "$", fills.blue),
        { guid: "5:5", phase: "CREATED", type: "FRAME", name: "AL_horizontal", parentIndex: { guid: "0:1", position: "%" }, size: { x: 232, y: 72 }, transform: at(320, 0), fillPaints: fills.white, stackMode: "HORIZONTAL", stackSpacing: 10, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
        rect("5:6", "A", 16, 16, 60, 40, "5:5", "!", fills.orange),
        rect("5:7", "B", 86, 16, 60, 40, "5:5", '"', fills.orange),
        rect("5:8", "C", 156, 16, 60, 40, "5:5", "#", fills.orange),
      ],
    });
    e.setCamera({ x: 120, y: 160, zoom: 1.5 });
  }, { grey: fill(0xd9d9d9), blue: fill(0x0d99ff), white: fill(0xffffff), orange: fill(0xd97054) });
  await settle(page);
  const opacity = async (id) => (await node(page, id))?.opacity ?? 1;

  // Smart selection: three equally spaced layers — dots, and gap handles under the pointer.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["5:1", "5:2", "5:3"]));
  await page.mouse.move(...(await toScreen(page, 110, 30)));
  await settle(page);
  await shot(page, `170-smart-selection-${theme}`);
  // Opacity digits: "5" → 50 %, then "0","5" quickly → 5 %.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("5");
  check("Opacity keys: 5 sets 50 %", Math.abs((await opacity("5:1")) - 0.5) < 1e-6, String(await opacity("5:1")));
  await page.waitForTimeout(600);  // past the two-digit window
  await page.keyboard.press("0");
  await page.keyboard.press("5");
  check("Opacity keys: 0 then 5 quickly sets 5 %", Math.abs((await opacity("5:2")) - 0.05) < 1e-6, String(await opacity("5:2")));
  await page.keyboard.press("0");
  await page.waitForTimeout(600);
  // ⌘S: Wrap in new section; its pill above it.
  await page.keyboard.press("Meta+s");
  await settle(page);
  const sel = await selection(page);
  const section = sel.length === 1 ? await node(page, sel[0]) : null;
  check("⌘S wraps the selection in a new section", section?.type === "SECTION", section ? `${section.name}` : JSON.stringify(sel));
  await shot(page, `171-section-${theme}`);
  // Esc clears the selection (live Figma).
  await page.keyboard.press("Escape");
  check("Esc clears the selection", (await selection(page)).length === 0);
  // The canvas menu over a layer: live Figma's items (Paste to replace, Move to page…, no Cut, no Delete).
  await page.mouse.click(...(await toScreen(page, 120, 200)), { button: "right" });
  await settle(page);
  const menu = page.getByRole("menu");
  const labels = (await menu.getByRole("menuitem").allTextContents()).map((t) => t.replace(/[⌘⇧⌥⌃⌫\][]|[A-Z]$/g, "").trim());
  check("Canvas menu: Paste to replace, Move to page, Bring to front, Show/Hide; no Cut or Delete", ["Paste to replace", "Move to page", "Bring to front", "Show/Hide", "Flip horizontal"].every((l) => labels.some((t) => t.startsWith(l))) && !labels.some((t) => t === "Cut" || t === "Delete"), labels.slice(0, 8).join(", "));
  await shot(page, `172-canvas-menu-${theme}`);
  await page.keyboard.press("Escape");
  // ] / [: to the front and back.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["5:4"]));
  await page.locator("#engine-canvas").focus();
  const order = () => page.evaluate(() => window.__designerEditor.engine.readNode("0:1", { childIds: true }).childIds);
  await page.keyboard.press("BracketLeft");
  check("[ sends to the back", (await order())[0] === "5:4", (await order()).join());
  await page.keyboard.press("BracketRight");
  const top = await order();
  check("] brings to the front", top[top.length - 1] === "5:4", top.join());
  // Corner radius handles: the selected rectangle under the pointer.
  await page.mouse.move(...(await toScreen(page, 120, 200)));
  await settle(page);
  await shot(page, `173-radius-handles-${theme}`);
  const [hx, hy] = await toScreen(page, 0 + 12 / 1.5, 120 + 12 / 1.5);
  await drag(page, [hx, hy], [hx + 15, hy + 15]);
  const big = await node(page, "5:4");
  check("A radius handle dragged sets the corners", (big?.rectangleTopLeftCornerRadius ?? big?.cornerRadius ?? 0) > 5, JSON.stringify({ r: big?.cornerRadius, tl: big?.rectangleTopLeftCornerRadius }));
  // An auto-layout frame: its bars under the pointer and "Hug" in its badge; a child: the parent dashed.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["5:5"]));
  await page.mouse.move(...(await toScreen(page, 401, 36)));
  await settle(page);
  await shot(page, `174-auto-layout-bars-${theme}`);
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["5:7"]));
  await settle(page);
  await shot(page, `175-auto-layout-child-${theme}`);
  // N: the view to the next frame; the selection stays.
  const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("n");
  const cam2 = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  check("N zooms to the next frame, the selection stays", (cam2.zoom !== cam.zoom || cam2.x !== cam.x) && (await selection(page)).join() === "5:7", `${cam.zoom.toFixed(2)} → ${cam2.zoom.toFixed(2)}`);
  // ⇧⌘O: outline mode; the pixel grid at 800 %.
  await page.keyboard.press("Shift+Meta+o");
  await settle(page);
  check("⇧⌘O turns outline mode on", (await page.evaluate(() => window.__designerEditor.ui.get().outlines)) === true);
  await shot(page, `176-outlines-${theme}`);
  await page.keyboard.press("Shift+Meta+o");
  await page.evaluate(() => window.__designerEditor.engine.setCamera({ x: -200, y: -200, zoom: 8 }));
  await settle(page);
  await shot(page, `177-pixel-grid-${theme}`);
}

/**
 * Round 9 on `?editor&doc=capture` (dark): canvas chrome as live Figma draws it (docs/research/figma/live/img/canvas-*) —
 * the ellipse's arc handle dragged (an arc), the star's ratio and the polygon's count handles, the `</>` at a selected
 * frame's top right (a click marks it ready for dev), the auto-layout padding badge by the pointer, a selected grid's
 * cells and pills (a pill click opens its size editor), the section's pill.
 */
/** Offsets (row-major) of the pixels in `clip` that are the dark theme's selection blue (#0c8ce9), from a page shot. */
async function bluePixels(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 80 && d[i + 1] > 100 && d[i + 1] < 180) out.push(i / 4);
    return out;
  }, png.toString("base64"));
}

async function overlays9Section(page, theme) {
  await open(page, "&doc=capture");
  const canvas = page.locator("#engine-canvas");
  // A layer's top-left at canvas (300, 260), zoom `z`; `local` points in its own space → page coordinates.
  const frameOn = async (id, z) => {
    await page.evaluate(([id, z]) => {
      const e = window.__designerEditor.engine;
      const n = e.readNode(id);
      e.setSelection([id]);
      e.setCamera({ x: 300 - n.transform.m02 * z, y: 260 - n.transform.m12 * z, zoom: z });
    }, [id, z]);
    await settle(page);
    const n = await node(page, id);
    return (lx, ly) => toScreen(page, n.transform.m02 + lx, n.transform.m12 + ly);
  };
  // The ellipse (7:61): its one ring 9 px inside the right edge; a quarter turn up round the centre makes an arc.
  let at = await frameOn("7:61", 2);
  const [ex, ey] = await at(100, 50);
  const [cx, cy] = await at(50, 50);
  await page.mouse.move(cx, cy);
  await settle(page);
  await shot(page, `190-ellipse-arc-handle-${theme}`);
  await page.mouse.move(ex - 9, ey);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) {
    const a = (-Math.PI / 2) * (i / 18);
    await page.mouse.move(cx + Math.cos(a) * 91, cy + Math.sin(a) * 91);
  }
  await page.mouse.up();
  await settle(page);
  const arc = (await node(page, "7:61")).arcData;
  check("Shape handles: the ellipse's arc handle dragged a quarter turn up makes a 270° arc", !!arc && Math.abs(arc.endingAngle - arc.startingAngle - 1.5 * Math.PI) < 0.08, JSON.stringify(arc));
  await page.mouse.move(cx - 20, cy + 20);
  await settle(page);
  await shot(page, `191-ellipse-arc-${theme}`);
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  await settle(page);
  // The star (7:63): radius, ratio (the first inner corner) and count (the right tip); the ratio dragged out.
  at = await frameOn("7:63", 2.2);
  const [sx, sy] = await at(50, 55);
  await page.mouse.move(sx, sy);
  await settle(page);
  await shot(page, `192-star-handles-${theme}`);
  const inner = [50 + 50 * 0.382 * Math.cos(-0.3 * Math.PI), 50 + 50 * 0.382 * Math.sin(-0.3 * Math.PI)];
  const [rx, ry] = await at(inner[0], inner[1]);
  const [ox, oy] = await at(50, 50);
  const d = Math.hypot(rx - ox, ry - oy);
  await drag(page, [rx, ry], [rx + ((rx - ox) / d) * 22, ry + ((ry - oy) / d) * 22]);
  const ratio = (await node(page, "7:63")).starInnerScale;
  check("Shape handles: the star's ratio handle dragged out raises its ratio", ratio > 0.45, String(ratio));
  await page.keyboard.press("Meta+z");
  await settle(page);
  // The triangle (7:62): its count handle on the bottom-right corner, turned up to 72° from the top: five corners.
  at = await frameOn("7:62", 2.2);
  const [px0, py0] = await at(50, 50);
  await page.mouse.move(px0, py0);
  await settle(page);
  await shot(page, `193-polygon-handles-${theme}`);
  const r = 50 * 2.2;
  await page.mouse.move(px0 + Math.sin((2 * Math.PI) / 3) * r, py0 - Math.cos((2 * Math.PI) / 3) * r);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const from = (2 * Math.PI) / 3 + ((2 * Math.PI) / 5 - (2 * Math.PI) / 3) * (i / 12);
    await page.mouse.move(px0 + Math.sin(from) * r, py0 - Math.cos(from) * r);
  }
  await page.mouse.up();
  await settle(page);
  const count = (await node(page, "7:62")).count;
  check("Shape handles: the polygon's count handle turned up to 72° makes five corners", count === 5, String(count));
  await page.keyboard.press("Meta+z");
  await settle(page);
  // AL_horizontal (7:20): the `</>` at its top right; the top padding's badge where the pointer is.
  at = await frameOn("7:20", 1.5);
  const [tx, ty] = await at(150, 7);
  await page.mouse.move(tx, ty);
  await settle(page);
  await shot(page, `194-auto-layout-padding-badge-${theme}`);
  const info = await page.evaluate(() => window.__designerEditor.engine.devInfo());
  const icon = info.hits.statuses.find((h) => h.ref === "7:20");
  check("The </> at a selected frame's top right (where live Figma draws it)", !!icon && icon.kind === 0, JSON.stringify(info.hits.statuses));
  if (icon) {
    const [fx] = await at(232, 0);
    const box = await canvas.boundingBox();
    check("The </> ends at the frame's right edge", Math.abs(box.x + icon.x + icon.width - 2 - fx) <= 1.5, `${box.x + icon.x + icon.width - 2} vs ${fx}`);
    await page.mouse.click(box.x + icon.x + icon.width / 2, box.y + icon.y + icon.height / 2);
    await settle(page);
    const st = (await page.evaluate(() => window.__designerEditor.engine.readNode("7:20", { fields: ["sectionStatusInfo"] })))?.sectionStatusInfo?.status;
    check("A click on the </> marks the frame ready for dev", st === "BUILD", String(st));
    await shot(page, `195-ready-for-dev-${theme}`);
    await page.keyboard.press("Meta+z");
    await settle(page);
  }
  // AL_grid (7:40): cells outlined, the pill over the hovered column; a click on its label selects the column.
  at = await frameOn("7:40", 1.6);
  const [gx, gy] = await at(160, 6);
  await page.mouse.move(gx, gy);
  await settle(page);
  await shot(page, `196-grid-selected-${theme}`);
  const [, gtop] = await at(160, 0);
  await page.mouse.move(gx, gtop - 31.5);
  await settle(page);
  await shot(page, `197-grid-column-pill-${theme}`);
  {
    // Round 10 (live canvas-grid-hover-column-track-pill): the column's 2 px outline centred on its sides, its ends inside
    // the frame's top edge. The middle column's left side at x 113.33; the selection blue's runs across it and down
    // through the frame's top at the column's middle.
    const [lx, my] = await at(113.33, 100);
    const across = await bluePixels(page, { x: Math.round(lx) - 6, y: Math.round(my), width: 12, height: 1 });
    const [, ty] = await at(160, 0);
    const down = await bluePixels(page, { x: Math.round(gx), y: Math.round(ty) - 6, width: 1, height: 12 });
    const run = (px, from) => (px.length ? { first: from + px[0], count: px.length } : null);
    const a = run(across, Math.round(lx) - 6), d = run(down, Math.round(ty) - 6);
    check(
      "Round 10: a hovered grid column's outline is 2 px centred on its side and inside the frame's top (live Figma)",
      !!a && a.count >= 2 && a.count <= 3 && Math.abs(a.first + a.count / 2 - lx) <= 1 && !!d && d.first >= Math.round(ty) - 1 && d.count >= 2 && d.count <= 4,
      JSON.stringify({ lx, across: a, ty, down: d })
    );
  }
  await page.mouse.click(gx, gtop - 31.5);
  await settle(page);
  const sel = await page.evaluate(() => window.__designerEditor.ui.get().gridTracks);
  check("Grid: a click on a column's pill selects the column (the Grid panel)", !!sel && sel.axis === "COLUMNS" && sel.tracks.join() === "1", JSON.stringify(sel));
  check("Grid: …and nothing else opens (round 12, live grid/row-track-menu.txt)", (await page.locator("[data-grid-track-editor]").count()) === 0 && (await page.getByRole("menu").count()) === 0);
  await shot(page, `198-grid-column-selected-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);
  // The section (7:95): its pill.
  await frameOn("7:95", 1.3);
  await shot(page, `199-section-pill-${theme}`);
  // Round 10: the gap badge (20 × 17 for "10", live canvas-autolayout-selected-hover-gap scaled by its 11 px title: 20.8 ×
  // 17.4) over AL_horizontal's first gap.
  at = await frameOn("7:20", 1.5);
  await page.mouse.move(...(await at(81, 36)));
  await settle(page);
  await shot(page, `200-gap-badge-${theme}`);
  {
    // The pink badge's box in a shot of the gap's neighbourhood (decoded in the page).
    const [gx0, gy0] = await at(81, 0);
    const png = await page.screenshot({ clip: { x: gx0 - 10, y: gy0 - 10, width: 80, height: 54 } }); // above the bar (its top 48 px down)
    const box = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < bmp.height; y++)
        for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4;
          if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 130) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }, png.toString("base64"));
    check("Round 10: the hovered gap's badge is 20 × 17 for \"10\" (live Figma)", !!box && Math.abs(box.w - 20) <= 1 && Math.abs(box.h - 17) <= 1, JSON.stringify(box));
  }
  // Round 10: the capture's Vector is live's triangle; a double-click opens vector edit mode on its three points.
  at = await frameOn("7:66", 3);
  const [vx, vy] = await at(40, 35);
  await page.mouse.dblclick(vx, vy);
  await page.mouse.move(vx + 200, vy + 200);
  await settle(page);
  const ve = await page.evaluate(() => window.__designerEditor.engine.vectorEdit);
  check("Round 10: the capture's Vector opens in vector edit mode with its 3 points and 3 segments", !!ve && ve.ref === "7:66" && ve.vertexCount === 3 && ve.segmentCount === 3, JSON.stringify(ve)?.slice(0, 160));
  await shot(page, `201-vector-edit-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  // The live file's pages: Page 1, then Capture (open).
  const pages = await page.evaluate(() => window.__designerEditor.engine.pages().map((p) => p.name).join());
  check("Round 10: the capture's pages are Page 1 and Capture (the page it opens on)", pages === "Page 1,Capture" && (await page.evaluate(() => window.__designerEditor.store.page)) === "0:1", pages);
}

/** Pixels of a page region (RGBA rows), decoded in the page. */
async function regionPixels(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, data: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, png.toString("base64"));
}

/** A live screenshot (docs/research/figma/live/img, kept out of git: this checkout's, else the main checkout's). */
function liveImage(name) {
  const mainCheckout = path.dirname(realpathSync(path.join(repo, "node_modules")));
  return [path.join(repo, "docs/research/figma/live/img", name), path.join(mainCheckout, "docs/research/figma/live/img", name)].find((f) => existsSync(f)) ?? null;
}

/**
 * Ours next to live: the page's `clip` (CSS px of the 1440 × 900 window) left, the same box of a 1440 × 900 live
 * screenshot (scaled to `liveWidth` px wide) right, both at 2×, saved as `name`.png.
 */
async function sideBySide(page, clip, liveName, liveWidth, name) {
  const file = liveImage(liveName);
  if (!file) return;
  const ours = (await page.screenshot({ clip })).toString("base64");
  const live = readFileSync(file).toString("base64");
  const png = await page.evaluate(
    async ([ours, live, clip, k]) => {
      const load = async (b64, type) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
      const a = await load(ours, "image/png"), b = await load(live, "image/jpeg");
      const c = new OffscreenCanvas(clip.width * 4 + 8, clip.height * 2);
      const g = c.getContext("2d");
      g.fillStyle = "#ff00ff";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(a, 0, 0, clip.width * 2, clip.height * 2);
      g.drawImage(b, clip.x * k, clip.y * k, clip.width * k, clip.height * k, clip.width * 2 + 8, 0, clip.width * 2, clip.height * 2);
      const blob = await c.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const x of bytes) bin += String.fromCharCode(x);
      return btoa(bin);
    },
    [ours, live, clip, liveWidth / 1440]
  );
  const out = path.join(outDir, `${name}.png`);
  writeFileSync(out, Buffer.from(png, "base64"));
  files.push(out);
}

/**
 * Round 12 on `?editor&doc=capture` (dark, 1440 × 900): a selected grid's gaps and its track sizing list against live
 * Figma — AL_grid (7:40) where live has it (img/grid-selected-hover-gap-1440, grid-track-selected-grid-panel-and-menu-1440:
 * its top-left at 492.1, 289.4, 160 %): the pointer in a gap outlines every gap of that axis pink (each row's), the
 * padding bars give way, a drag changes the gap; a click on a row's pill selects the row only, its chevron opens the
 * label's field and the list at grid/row-track-menu.txt's place (156 × 72 at 419,549), a row picked sizes the row.
 */
async function grid12Section(page, theme) {
  await open(page, "&doc=capture");
  const canvas = page.locator("#engine-canvas");
  const cbox = await canvas.boundingBox();
  const Z = 1.6, LX = 492.1, LY = 289.4;
  const f = await node(page, "7:40");
  await page.evaluate(
    ([x, y, z]) => {
      const e = window.__designerEditor.engine;
      e.setSelection(["7:40"]);
      e.setCamera({ x, y, zoom: z });
    },
    [LX - cbox.x - f.transform.m02 * Z, LY - cbox.y - f.transform.m12 * Z, Z]
  );
  await settle(page);
  const at = (lx, ly) => [LX + lx * Z, LY + ly * Z];
  const [ox, oy] = await toScreen(page, f.transform.m02, f.transform.m12);
  check("R12 grid: AL_grid where live has it (492.1, 289.4 at 160 %)", Math.abs(ox - LX) < 0.01 && Math.abs(oy - LY) < 0.01, JSON.stringify([ox, oy]));
  const isPink = (d, i) => d[i] > 200 && d[i + 1] < 170 && d[i + 2] > 130 && d[i] - d[i + 1] > 60;
  const isBlue = (d, i) => d[i] < 80 && d[i + 1] > 100 && d[i + 1] < 190 && d[i + 2] > 200;
  const count = async (clip, test) => {
    const px = await regionPixels(page, clip);
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) n += test(px.data, i) ? 1 : 0;
    return n;
  };

  // N1: the pointer between columns 1 and 2, in row 2 — live: a pink box in every column gap of every row (the gap wide,
  // the row high), no padding bars.
  await page.mouse.move(...at(109.3, 146));
  await settle(page);
  await shot(page, `260-r12-grid-gap-hover-${theme}`);
  await sideBySide(page, { x: 470, y: 260, width: 560, height: 370 }, "grid-selected-hover-gap-1440.jpg", 800, `260-r12-grid-gap-hover-vs-live-${theme}`);
  {
    const across = async (ly, lx0, lx1) => count({ x: Math.round(LX + lx0 * Z), y: Math.round(LY + ly * Z), width: Math.round((lx1 - lx0) * Z), height: 1 }, isPink);
    // Across the column gaps, at each row's middle: a box's two sides per gap (2 gaps).
    const row1 = await across(54, 100, 220), row2 = await across(146, 100, 220);
    // Across the row gap (y 100) under column 2: no box (the rows' gaps stay plain), nor along the frame's top padding.
    const rowGap = await count({ x: Math.round(LX + 120 * Z), y: Math.round(LY + 100 * Z), width: Math.round(80 * Z), height: 1 }, isPink);
    // Down the first column gap's left side: pink from row 1's top to row 2's bottom except the row gap.
    const down = await count({ x: Math.floor(LX + 105.333 * Z), y: Math.round(LY + 12 * Z), width: 2, height: Math.round(176 * Z) }, isPink);
    const topBar = await count({ x: Math.round(LX + 160 * Z) - 10, y: Math.round(LY) + 2, width: 20, height: Math.round(12 * Z) - 3 }, isBlue);
    check(
      "R12 grid gap hover: pink boxes in both column gaps of both rows, none in the row gap; the padding bars give way (live grid-selected-hover-gap-1440)",
      row1 >= 4 && row2 >= 4 && rowGap === 0 && down >= 260 && topBar === 0,
      JSON.stringify({ row1, row2, rowGap, down, topBar })
    );
  }
  // N1: the drag (8 px right = 5 units at 160 %: the box under the pointer follows it, 8 → 18; unverified in live).
  const g0 = at(109.3, 146);
  await drag(page, g0, [g0[0] + 8, g0[1]]);
  let n = await node(page, "7:40");
  check("R12 grid: dragging a column gap 8 px at 160 % makes every column gap 18, the rows' stays 8", n.gridColumnGap === 18 && n.gridRowGap === 8, JSON.stringify({ c: n.gridColumnGap, r: n.gridRowGap }));
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  await settle(page);
  n = await node(page, "7:40");
  check("R12 grid: ⌘Z takes the gap drag back in one step", n.gridColumnGap === 8, String(n.gridColumnGap));

  // N2: row 2's pill (left of the frame, its right end 24.75 off it; live: 411–467 wide 56 — an 18 px grabber, "1fr"'s
  // 20, an 18 px chevron — 514–532).
  const rowY = LY + 146 * Z, pillRight = LX - 24.75;
  await page.mouse.move(pillRight - 18 - 10, rowY);
  await settle(page);
  await page.mouse.click(pillRight - 18 - 10, rowY);
  await settle(page);
  const sel = await page.evaluate(() => window.__designerEditor.ui.get().gridTracks);
  check(
    "R12 grid pill: a click on row 2's pill selects the row (the Grid panel), nothing opens (live grid/row-track-menu.txt)",
    !!sel && sel.axis === "ROWS" && sel.tracks.join() === "1" && (await page.locator("[data-grid-track-editor]").count()) === 0 && (await page.getByRole("menu").count()) === 0 && (await page.locator("[data-grid-panel]").count()) === 1,
    JSON.stringify(sel)
  );
  await shot(page, `261-r12-grid-row-selected-${theme}`);
  // Its chevron: the label's field, its text selected, and the list.
  await page.mouse.move(pillRight - 9, rowY);
  await page.mouse.click(pillRight - 9, rowY);
  await settle(page);
  const fieldBox = await page.locator("[data-grid-track-editor]").boundingBox();
  const input = await page.evaluate(() => {
    const el = document.querySelector("[data-grid-track-editor] input");
    const box = el?.closest('[data-ds="TextInput"]');
    const r = box?.getBoundingClientRect();
    const cs = box ? getComputedStyle(box) : null;
    return el ? { value: el.value, focused: document.activeElement === el, from: el.selectionStart, to: el.selectionEnd, box: r && [r.x, r.y, r.width, r.height], bg: cs?.backgroundColor, color: cs?.color, font: cs && `${cs.fontSize}/${cs.fontWeight}` } : null;
  });
  check(
    "R12 grid pill: its chevron turns the label into its field (over the label, 18 high, \"1fr\" selected): a white box hugging the text, ~18 × 14, its text dark 11px Medium (live)",
    !!fieldBox && Math.abs(fieldBox.x + fieldBox.width - (pillRight - 18)) <= 0.5 && Math.abs(fieldBox.x - (LX - 24.75 - 56 + 18)) <= 0.5 && Math.abs(fieldBox.y - (rowY - 9)) <= 0.5 && Math.round(fieldBox.height) === 18 &&
      !!input && input.value === "1fr" && input.focused && input.from === 0 && input.to === 3 && input.box[2] >= 16 && input.box[2] <= 19 && Math.round(input.box[3]) === 14 && Math.abs(input.box[1] - (rowY - 7)) <= 0.5 &&
      input.bg === "rgb(255, 255, 255)" && /^rgba\(0, 0, 0/.test(input.color) && input.font === "11px/500",
    JSON.stringify({ fieldBox, input })
  );
  const tools = path.join(repo, "docs/research/figma/live/tools");
  const dump = await page.evaluate(readFileSync(path.join(tools, "dumpPopups.js"), "utf8"));
  const oursFile = path.join(outDir, `r12-row-track-menu-${theme}.txt`);
  writeFileSync(oursFile, `${dump}\n`);
  const report = spawnSync(process.execPath, [path.join(tools, "compare-popups.mjs"), path.join(repo, "docs/research/figma/live/grid/row-track-menu.txt"), oursFile], { encoding: "utf8" }).stdout.trim();
  check("R12 grid pill: the list as live's — 156 × 72 at 419,549, its rows' text at 52 (compare-popups: no DIFF / MISSING)", report.startsWith("same") && !/^(DIFF|MISSING)/m.test(report), report.replace(/\n/g, " | "));
  const look = await page.evaluate(() => {
    const m = document.querySelector('[role="menu"]');
    if (!m) return null;
    const before = getComputedStyle(m, "::before");
    const rows = [...m.querySelectorAll('[role^="menuitem"]')];
    return {
      box: [before.top, before.bottom, before.left, before.right, before.borderRadius],
      lit: rows.findIndex((r) => r.hasAttribute("data-highlighted")),
      checked: rows.findIndex((r) => r.getAttribute("aria-checked") === "true"),
      glyphs: rows.map((r) => !!r.querySelector("svg")),
    };
  });
  check(
    "R12 grid pill: the menu box 8 above and below the list (live canvas-grid-row-track-menu), no row lit (live's dump and 1440 capture), Fill container checked, a glyph each",
    !!look && look.box[0] === "-8px" && look.box[1] === "-8px" && look.box[2] === "0px" && look.box[3] === "0px" && look.lit === -1 && look.checked === 2 && look.glyphs.every(Boolean),
    JSON.stringify(look)
  );
  await shot(page, `262-r12-grid-row-track-menu-${theme}`);
  await page.mouse.move(700, 800);  // off the pill and the list, as live's capture
  await settle(page);
  await sideBySide(page, { x: 380, y: 480, width: 260, height: 170 }, "grid-track-selected-grid-panel-and-menu-1440.jpg", 800, `262-r12-grid-row-track-menu-vs-live-${theme}`);
  await sideBySide(page, { x: 400, y: 506, width: 80, height: 34 }, "grid-track-selected-grid-panel-and-menu-1440.jpg", 800, `262-r12-grid-row-pill-field-vs-live-${theme}`);
  // "Fixed height (84)": the row Fixed at its laid-out 84; the field and the list close.
  await page.getByRole("menuitemradio", { name: "Fixed height (84)" }).click();
  await settle(page);
  n = await node(page, "7:40");
  const rowId = n.gridRows?.entries?.[1]?.id;
  const sizing = n.gridRowsSizing?.entries?.find((e) => e.id.localID === rowId?.localID && e.id.sessionID === rowId?.sessionID)?.trackSize?.maxSizing;
  check(
    "R12 grid pill: Fixed height (84) makes row 2 Fixed 84 (the frame keeps 320 × 200); the field and the list close",
    sizing?.type === "FIXED" && sizing?.value === 84 && n.size.x === 320 && n.size.y === 200 && (await page.locator("[data-grid-track-editor]").count()) === 0 && (await page.getByRole("menu").count()) === 0,
    JSON.stringify({ sizing, size: n.size })
  );
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  await settle(page);
  // Typed in the field: "120" makes the row Fixed 120; Esc in the field closes both.
  await page.mouse.move(pillRight - 9, rowY);
  await page.mouse.click(pillRight - 9, rowY);
  await settle(page);
  await page.keyboard.press("Escape");
  await settle(page);
  check("R12 grid pill: Esc in the label's field closes it and the list", (await page.locator("[data-grid-track-editor]").count()) === 0 && (await page.getByRole("menu").count()) === 0);
  await page.mouse.click(pillRight - 9, rowY);
  await settle(page);
  await page.keyboard.type("120");
  await page.keyboard.press("Enter");
  await settle(page);
  n = await node(page, "7:40");
  const typed = n.gridRowsSizing?.entries?.find((e) => e.id.localID === rowId?.localID && e.id.sessionID === rowId?.sessionID)?.trackSize?.maxSizing;
  check("R12 grid pill: 120 typed in the label's field makes row 2 Fixed 120", typed?.type === "FIXED" && typed?.value === 120, JSON.stringify(typed));
  await canvas.focus();
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Escape");
  await settle(page);
}

/**
 * Round 11 on `?editor&doc=capture` (dark, 1440 × 900): the canvas chrome of docs/research/audit-2026-10-08/sweep-round10.md
 * R24–R27 against live Figma's captures — the component set's "3 Variants" pill, its "+" (Add variant) and gap boxes;
 * no title over the Button instance; the hovered text's baseline underline; smart selection's dots off the selection.
 */
async function overlays11Section(page, theme) {
  await open(page, "&doc=capture");
  const canvas = page.locator("#engine-canvas");
  const cbox = await canvas.boundingBox();
  const away = [cbox.x + cbox.width / 2, cbox.y + 780];
  // The layers' box (wx, wy, w × h) centred in the canvas between the panels, at zoom z.
  const frameOn = async (ids, wx, wy, z, w, h) => {
    await page.evaluate(([ids, wx, wy, z, w, h, cw]) => {
      const e = window.__designerEditor.engine;
      e.setSelection(ids);
      e.setCamera({ x: cw / 2 - (wx + w / 2) * z, y: 380 - (wy + h / 2) * z, zoom: z });
    }, [ids, wx, wy, z, w, h, cbox.width]);
    await page.mouse.move(...away);
    await settle(page);
  };
  const isPurple = (d, i) => d[i] > 110 && d[i] < 170 && d[i + 1] < 100 && d[i + 2] > 200;
  const isBlue = (d, i) => d[i] < 80 && d[i + 1] > 100 && d[i + 1] < 190 && d[i + 2] > 200;
  // The spacing pink, and pink blended with white or the layer under it (a 1.5 px core at 1×: (248, 129, 212)).
  const isPink = (d, i) => d[i] > 200 && d[i + 1] < 160 && d[i + 2] > 130 && d[i] - d[i + 1] > 70;

  // R24: the set Chip (8:40, 364 × 40 at 300, 600) at live's 1.714×.
  await frameOn(["8:40"], 300, 600, 1.714, 364, 40);
  const info = await page.evaluate(() => window.__designerEditor.engine.devInfo());
  const plus = info.hits.addVariant;
  const [setL, setB] = await toScreen(page, 300, 640);
  const [setR] = await toScreen(page, 664, 640);
  check("R24: a selected component set has the \"+\" (Add variant): 16 × 16, centred under it, 4 px under its 17 px pill 6 px below it", !!plus && plus.ref === "8:40" && plus.width === 16 && plus.height === 16 && Math.abs(cbox.x + plus.x + 8 - (setL + setR) / 2) <= 1 && Math.abs(cbox.y + plus.y - (setB + 6 + 17 + 4)) <= 1, JSON.stringify(plus));
  {
    // The pill's purple run along its middle: "3 Variants" (live 67 px at the capture's 1.08: 62.0), not the size (~84).
    const px = await regionPixels(page, { x: Math.round((setL + setR) / 2) - 60, y: Math.round(setB + 6 + 3), width: 120, height: 1 });
    let x0 = -1, x1 = -1;
    for (let x = 0; x < px.width; x++) {
      if (!isPurple(px.data, x * 4)) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    check("R24: the pill reads \"3 Variants\": ~62 px wide (live 67 px at the capture's 1.08: 62.0)", x0 >= 0 && Math.abs(x1 - x0 + 1 - 62) <= 2, `${x1 - x0 + 1}`);
    // The gap boxes: pink at the first gap's left edge (x 416 in the set's space 116), y 16..24.
    const [gx, gy] = await toScreen(page, 416, 620);
    const g = await regionPixels(page, { x: Math.round(gx) - 2, y: Math.round(gy), width: 5, height: 1 });
    let pink = 0;
    for (let x = 0; x < g.width; x++) pink += isPink(g.data, x * 4) ? 1 : 0;
    check("R24: a pink box in each gap between the variants (live canvas-component-set-selected)", pink >= 1, `${pink} pink px`);
  }
  await shot(page, `210-r11-component-set-${theme}`);
  if (plus) {
    await page.mouse.click(cbox.x + plus.x + 8, cbox.y + plus.y + 8);
    await settle(page);
    const after = await page.evaluate(() => {
      const e = window.__designerEditor.engine;
      const set = e.readNode("8:40");
      return { kids: e.children ? e.children("8:40")?.length : undefined, w: set.size.x, h: set.size.y, sel: window.__designerEditor.selection };
    });
    check("R24: a click on the \"+\" adds a variant into the set's flow (the set hugs it: 480 × 40) and selects it", after.w === 480 && after.h === 40 && after.sel.length === 1 && after.sel[0] !== "8:40", JSON.stringify(after));
    await shot(page, `211-r11-added-variant-${theme}`);
    await canvas.focus();
    await page.keyboard.press("Meta+z");
    await settle(page);
    check("R24: ⌘Z takes it back", (await node(page, "8:40")).size.x === 364);
  }

  // R26: the Button instance (8:60 at 100, 720) selected, then not: no title over it (live canvas-instance-selected,
  // menu-context-main-component); the main component (8:1) keeps "❖ Button".
  const titleInk = async (wx, wy) => {
    const [x, y] = await toScreen(page, wx, wy);
    const px = await regionPixels(page, { x: Math.round(x), y: Math.round(y) - 18, width: 60, height: 14 });
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i] > 120 && px.data[i + 2] > 180 && px.data[i + 1] < px.data[i + 2] - 30) n++;
    return n;
  };
  await frameOn(["8:60"], 100, 720, 3.22, 95, 44);
  const instSel = await titleInk(100, 720);
  await shot(page, `212-r11-instance-selected-${theme}`);
  await frameOn([], 100, 720, 3.22, 95, 44);
  const instRest = await titleInk(100, 720);
  await frameOn(["8:1"], 100, 600, 3.22, 95, 44);
  const main = await titleInk(100, 600);
  check("R26: no title over a top-level instance, selected or not; the main component keeps its own", instSel === 0 && instRest === 0 && main > 10, JSON.stringify({ instSel, instRest, main }));

  // R25: the text (7:90 "Hello, Capture", 184 × 29 at 0, 460) hovered at 2.38×: a 2 px blue line just under the
  // baseline, no box; selected and hovered: 1 px.
  const underline = async () => {
    const [x, y0] = await toScreen(page, 90, 460);
    const [, y1] = await toScreen(page, 90, 489);
    const col = await regionPixels(page, { x: Math.round(x) + 3, y: Math.round(y0) - 3, width: 1, height: Math.round(y1 - y0) + 6 });
    const rows = [];
    for (let y = 0; y < col.height; y++) if (isBlue(col.data, y * 4)) rows.push(y + Math.round(y0) - 3);
    return { rows, top: Math.round(y0), bottom: Math.round(y1) };
  };
  await frameOn([], 0, 460, 2.38, 184, 29);
  await page.mouse.move(...(await toScreen(page, 60, 470)));
  await settle(page);
  const hover = await underline();
  await shot(page, `213-r11-text-hover-${theme}`);
  // Inter 24's baseline 23.25 under the top of its 29-high line: at 2.38×, 55 px down.
  const base = hover.top + 23.25 * 2.38;
  check("R25: a hovered text's baseline underlined: 2 px from its baseline down, no box edge", hover.rows.length === 2 && Math.abs(hover.rows[0] - base) <= 1.5 && !hover.rows.includes(hover.top), JSON.stringify({ ...hover, base }));
  await frameOn(["7:90"], 0, 460, 2.38, 184, 29);
  await page.mouse.move(...(await toScreen(page, 60, 470)));
  await settle(page);
  const selHover = await underline();
  check("R25: a hovered selected text keeps a 1 px baseline line in its box (live canvas-text-selected)", selHover.rows.filter((y) => y > selHover.top + 2 && y < selHover.bottom - 2).length === 1, JSON.stringify(selHover));

  // R27: Ellipse + Polygon (7:61, 7:62) selected, the pointer away: tiny white dots with a pink core at their centres,
  // no ring; the pointer on the selection: rings.
  await frameOn(["7:61", "7:62"], 160, 300, 2, 240, 100);
  const [ecx, ecy] = await toScreen(page, 210, 350);
  const dot = await regionPixels(page, { x: Math.round(ecx) - 6, y: Math.round(ecy) - 6, width: 13, height: 13 });
  const count = (d, f) => {
    let n = 0;
    for (let i = 0; i < d.data.length; i += 4) n += f(d.data, i) ? 1 : 0;
    return n;
  };
  const whiteish = (d, i) => d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235;
  const pinkAway = count(dot, isPink);
  await shot(page, `214-r11-multi-dots-${theme}`);
  await page.mouse.move(...(await toScreen(page, 280, 350)));
  await settle(page);
  const ring = await regionPixels(page, { x: Math.round(ecx) - 6, y: Math.round(ecy) - 6, width: 13, height: 13 });
  check("R27: off the selection a ~3 px dot (a pink core, a few pixels), on it the 9 px ring", pinkAway >= 1 && pinkAway <= 6 && count(ring, isPink) >= 16, JSON.stringify({ pinkAway, ring: count(ring, isPink), white: count(dot, whiteish) }));
  await shot(page, `215-r11-multi-rings-${theme}`);
  // The Group (7:80): its two layers' centres dotted.
  await frameOn(["7:80"], 1220, 300, 2.38, 140, 80);
  const [gcx, gcy] = await toScreen(page, 1250, 340);
  const gdot = await regionPixels(page, { x: Math.round(gcx) - 5, y: Math.round(gcy) - 5, width: 11, height: 11 });
  // Lighter than the layer (its colour in the region's corner) by 60 and grey: the dot's white.
  const lighter = (d, i) => d[i] > gdot.data[0] + 60 && d[i + 1] > gdot.data[1] + 60 && Math.abs(d[i] - d[i + 2]) < 24;
  check("R27: a selected group's equally spaced layers get the dots (live canvas-group-selected)", count(gdot, isPink) >= 1 && count(gdot, lighter) >= 2, JSON.stringify({ pink: count(gdot, isPink), white: count(gdot, lighter) }));
  await shot(page, `216-r11-group-dots-${theme}`);
}

/**
 * Round 8 on `?editor&doc=empty` (dark): the selection / canvas audit's open items — smart selection's centre rings
 * dragged to reorder, the ⌥R rotation origin, ruler guides dragged out of the rulers (selected, snapped to), the Scale
 * tool (K), the Slice tool (S) and Show slices, the Comment tool's note, the eyedropper (I) with its loupe, an
 * auto-layout padding edited in place, "Select layer ▸" with type icons, Nudge amount…, Snap to pixel grid, pixel
 * preview (⌃P).
 */
async function selection8Section(page, theme) {
  await open(page, "&doc=empty");
  const fill = (hex) => [{ type: "SOLID", color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
  await page.evaluate((fills) => {
    const e = window.__designerEditor.engine;
    const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
    const rect = (id, name, x, y, w, h, parent = "0:1", pos = "!", f = fills.grey, extra = {}) => ({ guid: id, phase: "CREATED", type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: f, ...extra });
    e.applyChanges({
      type: "NODE_CHANGES",
      sessionID: 0,
      nodeChanges: [
        rect("6:1", "S1", 0, 0, 60, 60, "0:1", "!"),
        rect("6:2", "S2", 80, 0, 60, 60, "0:1", '"'),
        rect("6:3", "S3", 160, 0, 60, 60, "0:1", "#"),
        { guid: "6:4", phase: "CREATED", type: "FRAME", name: "Card", parentIndex: { guid: "0:1", position: "$" }, size: { x: 160, y: 120 }, transform: at(0, 120), fillPaints: fills.white, cornerRadius: 8, rectangleTopLeftCornerRadius: 8, rectangleTopRightCornerRadius: 8, rectangleBottomLeftCornerRadius: 8, rectangleBottomRightCornerRadius: 8 },
        rect("6:5", "Swatch", 16, 16, 60, 40, "6:4", "!", fills.blue, { strokePaints: fills.grey, strokeWeight: 2 }),
        { guid: "6:6", phase: "CREATED", type: "FRAME", name: "Stack", parentIndex: { guid: "0:1", position: "%" }, size: { x: 232, y: 72 }, transform: at(320, 0), fillPaints: fills.white, stackMode: "HORIZONTAL", stackSpacing: 10, stackHorizontalPadding: 16, stackVerticalPadding: 16, stackPaddingRight: 16, stackPaddingBottom: 16, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
        rect("6:7", "A", 16, 16, 60, 40, "6:6", "!", fills.orange),
        rect("6:8", "B", 86, 16, 60, 40, "6:6", '"', fills.orange),
        rect("6:9", "C", 156, 16, 60, 40, "6:6", "#", fills.orange),
        rect("6:10", "Under", 320, 140, 120, 80, "0:1", "&", fills.orange),
        rect("6:11", "Over", 360, 160, 120, 80, "0:1", "'", fills.blue, { locked: true }),
      ],
    });
    e.setCamera({ x: 160, y: 200, zoom: 1.5 });
  }, { grey: fill(0xd9d9d9), blue: fill(0x0d99ff), white: fill(0xffffff), orange: fill(0xd97054) });
  await settle(page);
  const canvas = page.locator("#engine-canvas");
  const world = (id) => page.evaluate((id) => {
    const ed = window.__designerEditor;
    const n = ed.engine.readNode(id);
    return n ? { x: n.transform.m02, y: n.transform.m12, w: n.size.x, h: n.size.y } : null;
  }, id);

  // Smart selection: S1's centre ring dragged past S3 — the layers swap places, the gaps stay.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:1", "6:2", "6:3"]));
  await page.mouse.move(...(await toScreen(page, 30, 30)));
  await settle(page);
  await shot(page, `180-reorder-ring-${theme}`);
  await drag(page, await toScreen(page, 30, 30), await toScreen(page, 220, 30));
  const order = [(await world("6:1")).x, (await world("6:2")).x, (await world("6:3")).x];
  check("Smart selection: a centre ring dragged past the last layer reorders them (gaps kept)", order.join() === "160,0,80", order.join());

  // ⌥R: the rotation origin at the selection's centre.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:4"]));
  await canvas.focus();
  await page.keyboard.press("Alt+r");
  await settle(page);
  check("⌥R shows the rotation origin", (await page.evaluate(() => window.__designerEditor.engine.commandState("SHOW_ROTATION_ORIGIN") & 2)) === 2);
  await drag(page, await toScreen(page, 80, 180), await toScreen(page, 2, 122));
  await shot(page, `181-rotation-origin-${theme}`);
  await page.keyboard.press("Alt+r");

  // Ruler guides: out of the top ruler onto the page (rulers on by default); a click selects it; ⌫ removes it.
  const rulerTop = page.locator('[data-ruler="top"]');
  const box = await rulerTop.boundingBox();
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  const guideY = await toScreen(page, 0, 300);
  await drag(page, [box.x + 600, box.y + 10], [box.x + 600, guideY[1]], 10);
  const guides = () => page.evaluate(() => window.__designerEditor.engine.readNode("0:1")?.guides ?? []);
  const g1 = await guides();
  check("A guide dragged out of the top ruler lands on the page", g1.length === 1 && g1[0].axis === "Y" && Math.abs(g1[0].offset - 300) <= 1, JSON.stringify(g1));
  // And one from the left ruler with Card selected: the frame's own guide.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:4"]));
  const rulerLeft = page.locator('[data-ruler="left"]');
  const lbox = await rulerLeft.boundingBox();
  const guideX = await toScreen(page, 80, 0);
  await drag(page, [lbox.x + 10, lbox.y + 400], [guideX[0], lbox.y + 400], 10);
  const cardGuides = await page.evaluate(() => window.__designerEditor.engine.readNode("6:4")?.guides ?? []);
  check("With a frame selected, the left ruler's guide is the frame's", cardGuides.length === 1 && cardGuides[0].axis === "X" && Math.abs(cardGuides[0].offset - 80) <= 1, JSON.stringify(cardGuides));
  const [gx, gy] = await toScreen(page, 260, 300);
  await page.mouse.click(gx, gy);
  await settle(page);
  const guideSelected = (await page.evaluate(() => window.__designerEditor.engine.commandState("REMOVE_GUIDE") & 1)) === 1;
  check("A click on a guide selects it (the layers let go)", guideSelected && (await selection(page)).length === 0);
  await shot(page, `182-ruler-guides-${theme}`);
  await canvas.focus();
  if (guideSelected) await page.keyboard.press("Backspace");
  check("⌫ removes the selected guide", (await guides()).length === 0, JSON.stringify(await guides()));

  // The Scale tool (K): Card's corner dragged — the swatch's stroke scales with it.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:4"]));
  await canvas.focus();
  await page.keyboard.press("k");
  check("K picks the Scale tool", (await page.evaluate(() => window.__designerEditor.store.tool)) === "SCALE");
  await drag(page, await toScreen(page, 160, 240), await toScreen(page, 240, 300));
  const swatch = await node(page, "6:5");
  const card = await world("6:4");
  check("The Scale tool scales the frame and its layers' strokes", card.w === 240 && card.h === 180 && swatch?.strokeWeight === 3, `${card.w}×${card.h}, stroke ${swatch?.strokeWeight}`);
  await shot(page, `183-scale-tool-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");

  // The Slice tool (S): a slice, dashed (View › Show slices).
  await canvas.focus();
  await page.keyboard.press("s");
  await drag(page, await toScreen(page, 180, 260), await toScreen(page, 280, 330));
  const slice = (await selection(page)).length === 1 ? await node(page, (await selection(page))[0]) : null;
  check("S draws a slice with an export setting", slice?.type === "SLICE" && (slice?.exportSettings?.length ?? 0) === 1, slice ? `${slice.type} ${slice.name}` : "none");
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await settle(page);
  await shot(page, `184-slice-${theme}`);

  // C: the Comment tool says comments come with multiplayer; Esc back to Move.
  await canvas.focus();
  await page.keyboard.press("c");
  await settle(page);
  check("C picks the Comment tool, with its note", (await page.evaluate(() => window.__designerEditor.store.tool)) === "COMMENT" && (await page.getByText("Comments come with multiplayer").count()) > 0);
  await page.keyboard.press("Escape");

  // I: the eyedropper — the loupe follows the pointer; a click on the orange rectangle fills the selected S1 with it.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:1"]));
  await canvas.focus();
  await page.keyboard.press("i");
  await page.mouse.move(...(await toScreen(page, 380, 170)));
  await page.mouse.move(...(await toScreen(page, 330, 160)), { steps: 3 });
  await settle(page);
  await page.waitForTimeout(100);
  check("I shows the eyedropper's loupe", (await page.locator("[data-loupe]").count()) === 1 && (await page.locator("[data-loupe]").isVisible()));
  await shot(page, `185-eyedropper-${theme}`);
  await page.mouse.click(...(await toScreen(page, 330, 160)));
  await settle(page);
  const s1 = await node(page, "6:1");
  const c = s1?.fillPaints?.[0]?.color;
  check("The eyedropper's click fills the selection with the colour there (the orange, not S1's grey)", !!c && c.g < 0.6 && c.r > c.b + 0.3, JSON.stringify(c));
  check("…and the tool goes back to Move", (await page.evaluate(() => window.__designerEditor.store.tool)) === "MOVE");

  // An auto-layout frame's left padding clicked: its value edited in place (24, Enter).
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:6"]));
  await page.mouse.move(...(await toScreen(page, 328, 36)));
  await settle(page);
  await page.mouse.click(...(await toScreen(page, 328, 36)));
  await settle(page);
  const field = page.locator('[data-inline-value="PADDING_LEFT"] input');
  check("A click on a padding bar edits its value in place", (await field.count()) === 1);
  await shot(page, `186-padding-inline-${theme}`);
  if (await field.count()) {
    await field.fill("24");
    await field.press("Enter");
  }
  check("…Enter keeps it", (await node(page, "6:6"))?.stackHorizontalPadding === 24, String((await node(page, "6:6"))?.stackHorizontalPadding));

  // "Select layer ▸": the layers under the pointer, their type icons, the locked one's padlock.
  await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
  await page.mouse.click(...(await toScreen(page, 400, 200)), { button: "right" });
  await settle(page);
  await page.getByRole("menuitem", { name: "Select layer" }).hover();
  await page.waitForTimeout(300);
  const subItems = page.getByRole("menu").last().getByRole("menuitemcheckbox");
  check("Select layer ▸ lists the layers under the pointer, locked ones too", (await subItems.count()) >= 2, String(await subItems.count()));
  await shot(page, `187-select-layer-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Preferences › Nudge amount…: 5 and 50; → moves 5.
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "Preferences" }).hover();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: "Nudge amount…" }).click();
  await settle(page);
  const dialog = page.getByRole("dialog");
  check("Preferences › Nudge amount… opens its dialog", (await dialog.count()) === 1);
  await shot(page, `188-nudge-amount-${theme}`);
  await dialog.getByLabel("Small nudge").fill("5");
  await dialog.getByLabel("Big nudge").fill("50");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["6:2"]));
  const before = (await world("6:2")).x;
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  check("The arrows move by the Small nudge", (await world("6:2")).x === before + 5, `${before} → ${(await world("6:2")).x}`);

  // ⇧⌘′ Snap to pixel grid off and on; ⌃P pixel preview at 800 % (live's toast).
  await page.keyboard.press("Shift+Meta+Quote");
  check("⇧⌘′ turns Snap to pixel grid off", (await page.evaluate(() => window.__designerEditor.ui.get().snapToPixelGrid)) === false);
  await page.keyboard.press("Shift+Meta+Quote");
  await page.evaluate(() => window.__designerEditor.engine.setCamera({ x: -200, y: -150, zoom: 8 }));
  await page.keyboard.press("Control+p");
  await settle(page);
  check("⌃P turns pixel preview on (1x)", (await page.evaluate(() => window.__designerEditor.ui.get().pixelPreview)) === 1 && (await page.getByText("Pixel preview enabled (1x)").count()) > 0);
  await shot(page, `189-pixel-preview-${theme}`);
  await page.keyboard.press("Control+p");
  check("⌃P again turns it off", !(await page.evaluate(() => window.__designerEditor.ui.get().pixelPreview)));
}

/** Round 6 on `?editor&doc=reference` (dark): annotations (⇧T, the menu, + Property, a category), a measurement (⇧M), the frame's `</>` (ready for dev), Changed after an edit, Dev Mode (⇧D: Inspect, dots), Compare changes, Done with changes, focus view. */
async function devmodeSection(page, theme) {
  await open(page, "&doc=reference");
  const dev = () => page.evaluate(() => window.__designerEditor.engine.devInfo());
  const canvasPoint = async (x, y) => page.evaluate(([x, y]) => {
    const r = window.__designerEditor.canvas.getBoundingClientRect();
    return [r.left + x, r.top + y];
  }, [x, y]);
  // A card and a button in Frame 1 (−34, 3, 437 × 305).
  await page.evaluate(() => {
    const rect = (guid, name, position, x, y, w, h, fill) => ({ guid, phase: "CREATED", type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: "1:1", position }, size: { x: w, y: h }, transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y }, fillPaints: [{ type: "SOLID", color: fill, opacity: 1, visible: true }] });
    window.__designerEditor.engine.applyChanges({ type: "NODE_CHANGES", nodeChanges: [rect("9:1", "Card", "!", 40, 40, 200, 120, { r: 0.05, g: 0.6, b: 1, a: 1 }), rect("9:2", "Button", '"', 40, 220, 140, 44, { r: 0.08, g: 0.68, b: 0.36, a: 1 })] });
    window.__designerEditor.engine.command("ZOOM_TO_FIT");
  });
  await settle(page);
  await page.locator("#engine-canvas").focus();

  // ⇧T: the Annotation tool; a click on the card opens the annotation menu.
  await page.keyboard.press("Shift+KeyT");
  await settle(page);
  check("Annotations: ⇧T picks the Annotation tool", (await page.evaluate(() => window.__designerEditor.store.tool)) === "ANNOTATION");
  await page.mouse.click(...(await toScreen(page, -34 + 140, 3 + 100)));
  await page.locator("[data-annotation-editor]").waitFor({ timeout: 5000 });
  const note = page.getByRole("textbox", { name: "Note" });
  await note.fill("Use the **brand** blue\n- 8 px radius");
  await note.press("Meta+Enter");
  await settle(page);
  await page.getByRole("button", { name: "Property" }).click();
  await page.getByRole("menuitem", { name: "Width" }).click();
  await settle(page);
  let card = await node(page, "9:1");
  check("Annotations: the note is stored as Figma's annotation (markdown in labelV2, the pinned Width)",
    card.annotations?.[0]?.labelV2 === "Use the **brand** blue\n- 8 px radius" && card.annotations?.[0]?.properties?.[0]?.type === "WIDTH", JSON.stringify(card.annotations));
  // A category: Development (the file gets Figma's presets).
  await page.locator("[data-annotation-editor]").getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Development" }).click();
  await settle(page);
  card = await node(page, "9:1");
  check("Annotations: a category from Figma's presets", !!card.annotations?.[0]?.categoryId, JSON.stringify(card.annotations?.[0]?.categoryId));
  await shot(page, `160-annotation-menu-${theme}`);
  await page.getByRole("button", { name: "Done" }).click();
  await settle(page);
  let info = await dev();
  check("Annotations: the label drawn beside the design by the engine", info.hits.annotations.length === 1 && !info.hits.annotations[0].dot, JSON.stringify(info.hits.annotations));
  await shot(page, `161-annotation-label-${theme}`);
  // View › Annotations (⇧Y) hides them.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+KeyY");
  await settle(page);
  check("Annotations: ⇧Y hides them", (await dev()).hits.annotations.length === 0);
  await page.keyboard.press("Shift+KeyY");
  await settle(page);

  // ⇧M: a measurement from the card's bottom edge to the button's top edge.
  await page.keyboard.press("Shift+KeyM");
  await settle(page);
  const from = await toScreen(page, -34 + 120, 3 + 160 - 1);
  const to = await toScreen(page, -34 + 120, 3 + 220 + 1);
  await page.mouse.move(...from);
  await settle(page);
  await drag(page, from, to, 10);
  info = await dev();
  check("Measurements: ⇧M and a drag between two edges save a measurement (60)", info.measurements.length === 1 && Math.round(info.measurements[0].value) === 60, JSON.stringify(info.measurements));
  await shot(page, `162-measurement-${theme}`);
  // Its text: a double-click.
  const pill = info.hits.measurements[0];
  if (pill) {
    await page.mouse.dblclick(...(await canvasPoint(pill.x + pill.width / 2, pill.y + pill.height / 2)));
    const field = page.getByRole("textbox", { name: "Measurement text" });
    await field.waitFor({ timeout: 5000 });
    await field.fill("Gap 60");
    await field.press("Enter");
    await settle(page);
    check("Measurements: a double-click customizes its text", (await dev()).measurements[0]?.freeText === "Gap 60");
  } else check("Measurements: a double-click customizes its text", false, "no pill drawn");

  // The `</>` at a selected frame's top right (live Figma, round 9) marks it ready for dev.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:1"]));
  await page.mouse.move(...(await toScreen(page, -34 + 400, 3 + 290)));
  await settle(page);
  info = await dev();
  const mark = info.hits.statuses.find((s) => s.ref === "1:1");
  check("Statuses: the </> at a selected frame's top right", !!mark && mark.kind === 0, JSON.stringify(info.hits.statuses));
  if (mark) await page.mouse.click(...(await canvasPoint(mark.x + 4, mark.y + 4)));
  await settle(page);
  check("Statuses: a click marks it ready for dev", (await dev()).statuses[0]?.status === "READY", JSON.stringify((await dev()).statuses));
  await shot(page, `163-ready-for-dev-${theme}`);
  // An edit a second later: Changed.
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__designerEditor.setProps(["9:2"], { size: { x: 180, y: 44 } }, "Resize"));
  await settle(page);
  check("Statuses: an edit after it was marked shows Changed", (await dev()).statuses[0]?.status === "CHANGED", JSON.stringify((await dev()).statuses));
  await shot(page, `164-changed-${theme}`);

  // ⇧D: Dev Mode — Inspect, the left panel, dots.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Shift+KeyD");
  await settle(page);
  check("Dev Mode: ⇧D shows Inspect", await page.locator('[data-panel="inspect"]').isVisible());
  check("Dev Mode: annotations as dots", (await dev()).hits.annotations[0]?.dot === true);
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:1"]));
  await settle(page);
  const inspect = page.locator('[data-panel="inspect"]');
  await expectText(inspect, "Changed");
  await shot(page, `165-dev-mode-${theme}`);

  // Compare changes: the version saved when it was marked, the button Edited.
  await inspect.locator("[data-compare-changes]").click();
  await page.locator("[data-compare]").waitFor({ timeout: 5000 });
  await page.locator('[data-change="Edited"]').first().waitFor({ timeout: 10000 }).catch(() => {});
  const edited = await page.locator('[data-change="Edited"]').allInnerTexts();
  check("Compare changes: the button is listed Edited", edited.some((t) => t.includes("Button")), JSON.stringify(edited));
  await page.locator('[data-change="Edited"]').filter({ hasText: "Button" }).first().click().catch(() => {});
  await settle(page);
  const props = await page.locator("[data-properties]").innerText().catch(() => "");
  check("Compare changes: Size 140 × 44 → 180 × 44", props.includes("140 × 44") && props.includes("180 × 44"), props.replace(/\n/g, " | "));
  await page.locator("[data-before]").waitFor({ timeout: 10000 }).catch(() => {});
  await shot(page, `166-compare-changes-${theme}`);
  await page.getByRole("radio", { name: "Overlay" }).click();
  await settle(page);
  await page.getByRole("radio", { name: "Compare code" }).click().catch(() => {});
  await settle(page);
  await shot(page, `167-compare-overlay-code-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);

  // Done with changes, from Inspect's status.
  await inspect.locator('[data-status="CHANGED"]').click();
  await page.locator("[data-done-with-changes]").waitFor({ timeout: 5000 });
  await page.getByRole("textbox", { name: "Reason" }).fill("Wider button");
  await shot(page, `168-done-with-changes-${theme}`);
  await page.getByRole("button", { name: "Done with changes" }).click();
  await settle(page);
  const status = (await node(page, "1:1")).sectionStatusInfo;
  check("Statuses: Done with changes — Ready for dev again, with the reason", (await dev()).statuses[0]?.status === "READY" && status?.description === "Wider button", JSON.stringify(status));

  // Focus view from the left panel's Ready for development.
  await page.locator('[data-status-row]').first().click();
  await settle(page);
  check("Focus view: opened from Ready for development", (await dev()).focus === "1:1" && (await page.locator("[data-focus-bar]").isVisible()));
  await shot(page, `169-focus-view-${theme}`);
  await page.getByRole("button", { name: "Inspect on page" }).click();
  await settle(page);
  check("Focus view: Inspect on page leaves it, the design selected", (await dev()).focus === null && (await selection(page)).join() === "1:1");
  await page.keyboard.press("Shift+KeyD");
  await settle(page);
  check("Dev Mode: ⇧D back to Design", await page.locator('[data-panel="right"]').isVisible());
}

const expectText = async (locator, text) => {
  for (let i = 0; i < 40; i++) {
    if ((await locator.innerText().catch(() => "")).includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(`text "${text}" shown`, false);
  return false;
};

/** The text round on `?editor&doc=text` (dark): the specimen, Typography's Mixed, Type settings' tabs, a link on a range (⇧⌘U), a list (⇧⌘8). */
async function textSection(page, theme) {
  await open(page, "&doc=text");
  const panel = page.locator('[data-panel="right"]');
  const select = async (...ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  await page.evaluate(() => window.__designerEditor.engine.command("ZOOM_TO_FIT"));
  await page.evaluate(() => window.__designerEditor.engine.pump());
  await settle(page);
  await shot(page, `120-text-specimen-${theme}`);
  const layouts = await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    const l = (id) => e.textLayout(id);
    return { link: l("4:3")?.hyperlinkBoxes ?? [], list: l("4:4")?.glyphs.length ?? 0, truncated: l("4:9")?.truncationStartIndex ?? -1, trim: l("4:11")?.layoutSize.y ?? 0 };
  });
  check("a run's link has a box (hyperlinkBoxes)", layouts.link.length === 1 && layouts.link[0].url === "https://help.figma.com", JSON.stringify(layouts.link));
  check("a truncated line is cut where … fits", layouts.truncated > 10, String(layouts.truncated));
  check("vertical trim: the box is cap height to baseline (< the line height)", layouts.trim > 0 && layouts.trim < 32, String(layouts.trim));

  // Mixed runs: the paragraph with a link and a bold range.
  await select("4:3");
  const style = panel.getByRole("combobox", { name: "Font style" });
  check("Typography: a layer whose runs differ shows Mixed for the style", (await style.textContent())?.includes("Mixed") ?? false, await style.textContent());
  check("Fill: a text whose runs' colours differ reads mixed", (await panel.getByText("Click + to replace mixed content").count()) === 1);
  await shot(page, `121-typography-mixed-${theme}`);
  await panel.getByRole("button", { name: "Type settings" }).click();
  await settle(page);
  const settings = page.getByRole("dialog", { name: "Type settings" });
  check("Type settings: Basics with List style and Wrap style", (await settings.getByRole("tab", { name: "Basics" }).count()) === 1 && (await settings.getByText("List style").count()) === 1 && (await settings.getByText("Wrap style").count()) === 1);
  await shot(page, `122-type-settings-basics-${theme}`);
  await settings.getByRole("tab", { name: "Details" }).click();
  await settle(page);
  check("Type settings: Details lists the font's stylistic sets", (await settings.getByText("Stylistic sets").count()) === 1 && (await settings.getByText("Kerning").count()) === 1);
  await shot(page, `123-type-settings-details-${theme}`);
  const variable = settings.getByRole("tab", { name: "Variable" });
  check("Type settings: a Variable tab for Inter (a variable font)", (await variable.count()) === 1);
  if (await variable.count()) {
    await variable.click();
    await settle(page);
    check("Variable: a Weight slider", (await settings.getByRole("slider", { name: "Weight" }).count()) === 1);
    const weight = settings.getByRole("textbox", { name: "Weight value" });
    const weightShown = (await weight.inputValue()) || (await weight.getAttribute("placeholder"));
    // Figma's Inter 3.19 (bundled since the fonts round): wght and slnt (Inter 4's opsz isn't in it).
    const slant = await settings.getByRole("textbox", { name: "Slant value" }).inputValue();
    check("Variable: Weight Mixed (Regular and Bold runs), Slant 0", weightShown === "Mixed" && slant === "0", `${weightShown} / ${slant}`);
    await shot(page, `124-type-settings-variable-${theme}`);
  }
  await page.keyboard.press("Escape");

  // Edit the heading: select its last 5 characters, ⇧⌘U, a URL, Enter.
  await page.evaluate(() => window.__designerEditor.engine.startTextEdit("4:2", { selectAll: false }));
  await settle(page);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+Meta+KeyU");
  await settle(page);
  const field = page.getByRole("textbox", { name: "Link" });
  check("⇧⌘U opens the link field", (await field.count()) === 1);
  await shot(page, `125-create-link-${theme}`);
  if (await field.count()) {
    await field.fill("figma.com");
    await field.press("Enter");
    await settle(page);
  }
  const linked = await page.evaluate(() => window.__designerEditor.engine.textRangeStyle("4:2", { from: 5, to: 10 }));
  check("the selected characters are linked and underlined", linked?.values.hyperlink?.url === "https://figma.com" && linked.values.textDecoration === "UNDERLINE", JSON.stringify(linked?.values.hyperlink));
  const whole = await page.evaluate(() => window.__designerEditor.engine.textRangeStyle("4:2", { from: 0, to: 10 }));
  check("…only them (the rest isn't)", whole?.mixed.includes("hyperlink") ?? false);
  // ⇧⌘8 while editing: a bulleted list.
  await page.keyboard.press("Shift+Meta+Digit8");
  await settle(page);
  const listed = await page.evaluate(() => window.__designerEditor.engine.textRangeStyle("4:2"));
  check("⇧⌘8 makes the paragraph a bulleted list", listed?.values.lineType === "UNORDERED_LIST", listed?.values.lineType);
  await shot(page, `126-text-link-and-list-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
}

/**
 * Round 7: the left side against the live capture (docs/research/figma/live/left, menus): the navigation bar's
 * geometry and tabs, Pages / Layers positions, row pitch and indent, hover cells, Collapse layers (⌥L), Enter selecting
 * the children, the lock drag, a page row keeping the shortcuts, Add new page's rename, Find (⌘F) and its results,
 * Rename layers (⌘R on several), Assets / Agents / Tools headers. Shots 170–179.
 */
async function leftPanelSection(page, theme) {
  await open(page, "");
  // Positions relative to the left panel, as the live dumps give them (x, y, w, h).
  const geo = () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-panel="left"]').getBoundingClientRect();
      const rel = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.left - panel.left), Math.round(r.top - panel.top), Math.round(r.width), Math.round(r.height)];
      };
      const abs = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      };
      const pages = document.querySelector('[aria-label="Pages"][data-ds="PanelSection"]');
      const layers = document.querySelector('[aria-label="Layers"][data-ds="PanelSection"]');
      const rows = [...document.querySelectorAll('[data-ds="LayerRow"]')];
      const rowGeo = (row) => ({ id: row.dataset.id, row: rel(row), icon: rel(row.querySelector("span[class*=type]")), name: rel(row.querySelector("span[class*=name]")) });
      return {
        panelX: Math.round(panel.left),
        rail: abs(document.querySelector('[data-ds="Rail"]')),
        menu: abs(document.querySelector('[data-ds="RailItem"][aria-label="Main menu"] span')),
        tabs: [...document.querySelectorAll("[data-rail-tab]")].map((b) => [b.dataset.railTab, ...abs(b)]),
        pagesTop: rel(pages)?.[1],
        pagesTitle: rel(pages?.querySelector("span[class*=title]")),
        find: rel(pages?.querySelector('button[aria-label="Find"]')),
        addPage: rel(pages?.querySelector('button[aria-label="Add new page"]')),
        pageRow: rel(document.querySelector('[data-ds="PageRow"] span[class*=name]')),
        handle: rel(document.querySelector("[data-pages-resize]")),
        layersTitle: rel(layers?.querySelector("span[class*=title]")),
        collapse: rel(document.querySelector("[data-collapse-layers]")),
        rows: rows.slice(0, 12).map(rowGeo),
      };
    });
  await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set(["1:1"]) }));
  await settle(page);
  const g = await geo();
  check("the navigation bar is 56 + a line; the Figma menu tile at 12, 8", g.rail[2] === 57 && g.menu?.[0] === 12 && g.menu?.[1] === 8, JSON.stringify([g.rail, g.menu]));
  const tabs = Object.fromEntries(g.tabs.map(([t, x, y, w, h]) => [t, [x, y, w, h]]));
  check("File, Agents, Assets, Tools at y 56 / 112 / 168 / 224 (56 × 56); Variables at 296", tabs.file?.[1] === 56 && tabs.agents?.[1] === 112 && tabs.assets?.[1] === 168 && tabs.tools?.[1] === 224 && tabs.variables?.[1] === 296 && tabs.file?.[2] === 56, JSON.stringify(tabs));
  check("the left panel starts at x 57", g.panelX === 57, String(g.panelX));
  check("Pages: title at 16, Find at 180, Add new page at 208 (8 down)", g.pagesTitle?.[0] === 16 && g.find?.[0] === 180 && g.find?.[1] - g.pagesTop === 8 && g.addPage?.[0] === 208, JSON.stringify([g.pagesTitle, g.find, g.addPage, g.pagesTop]));
  check("a page's name at x 16", g.pageRow?.[0] === 16, JSON.stringify(g.pageRow));
  check("the Pages resize handle is 8 high across the panel", g.handle?.[3] === 8 && g.handle?.[2] >= 240, JSON.stringify(g.handle));
  const [r0, r1, r2] = g.rows;
  check("layer rows on a 32 pitch", r1 && r1.row[1] - r0.row[1] === 32 && r0.row[3] === 32, JSON.stringify(g.rows.slice(0, 3).map((r) => r.row)));
  const desktop = g.rows.find((r) => r.id === "1:1");
  const child = g.rows.find((r) => r.id === "1:9" || r.id === "1:7");
  check("depth 0: glyph at 28, name at 52; depth 1: glyph at 52 (indent 24)", desktop?.icon?.[0] === 28 && desktop?.name?.[0] === 52 && child?.icon?.[0] === 52, JSON.stringify([desktop, child]));
  check("Collapse layers shows while a layer is open, at 208", g.collapse?.[0] === 208, JSON.stringify(g.collapse));
  void r2;
  // Hover: lock and eye at 184 / 208.
  await page.locator('[data-ds="LayerRow"][data-id="1:20"]').hover();
  const cells = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="left"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-ds="LayerRow"][data-id="1:20"] [data-cell]')].map((c) => [c.getAttribute("aria-label"), Math.round(c.getBoundingClientRect().left - panel.left)]);
  });
  check("hover: Toggle layer locking at 184, Toggle layer visibility at 208", JSON.stringify(cells) === JSON.stringify([["Toggle layer locking", 184], ["Toggle layer visibility", 208]]), JSON.stringify(cells));
  await shot(page, `170-left-panel-${theme}`);

  // ⌥L collapses (the selection's branch stays open).
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Alt+KeyL");
  await settle(page);
  check("⌥L collapses the layers", (await page.evaluate(() => window.__designerEditor.ui.get().expanded.size)) === 0);

  // Enter on the list selects the children.
  await page.locator('[data-ds="LayerRow"][data-id="1:1"]').click();
  await page.keyboard.press("Enter");
  await settle(page);
  const kids = await selection(page);
  check("Enter on a layer row selects its children (no rename)", kids.length === 6 && kids.includes("1:2") && (await page.locator('[data-ds="LayerRow"] input').count()) === 0, kids.join());

  // The lock dragged across three rows locks them all, one undo step.
  await page.evaluate(() => window.__designerEditor.ui.set({ expanded: new Set() }));
  await settle(page);
  await page.locator('[data-ds="LayerRow"][data-id="1:20"]').hover();
  const lock = page.locator('[data-ds="LayerRow"][data-id="1:20"] [data-cell="lock"]');
  const lb = await lock.boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width / 2, lb.y - 32 * 2 + lb.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const locked = await page.evaluate(() => ["1:20", "1:21", "1:22"].map((id) => window.__designerEditor.engine.readNode(id).locked === true));
  check("a drag from the lock locks every row it crosses", locked.every(Boolean), JSON.stringify(locked));
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+z");
  await settle(page);
  const unlocked = await page.evaluate(() => ["1:20", "1:21", "1:22"].map((id) => window.__designerEditor.engine.readNode(id).locked === true));
  check("…as one undo step", unlocked.every((v) => !v), JSON.stringify(unlocked));

  // A page row clicked keeps the editor's shortcuts (R picks the Rectangle tool).
  await page.locator('[data-ds="PageRow"]').first().click();
  await page.keyboard.press("r");
  check("with a page row focused, R still picks the Rectangle tool", (await page.evaluate(() => window.__designerEditor.store.tool)) === "RECTANGLE");
  await page.keyboard.press("Escape");

  // Add new page: the new row is in rename.
  await page.getByRole("button", { name: "Add new page" }).click();
  await settle(page);
  check("Add new page opens the new page's rename", (await page.locator('[data-ds="PageRow"] input').count()) === 1);
  await page.keyboard.type("Archive");
  await page.keyboard.press("Enter");
  await settle(page);
  check("…and the typed name sticks", (await page.locator('[data-ds="PageRow"]', { hasText: "Archive" }).count()) === 1);
  await page.locator('[data-ds="PageRow"]').first().click();
  await settle(page);

  // ⌘F: Find replaces Pages and Layers; "Card" finds layers; Enter goes to the first; Esc goes back.
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+KeyF");
  await settle(page);
  await page.keyboard.type("Card");
  await settle(page);
  const count = await page.locator("[data-find-count]").getAttribute("data-find-count").catch(() => null);
  check("⌘F opens Find; typing lists the matches with a count", (await page.locator("[data-find]").count()) === 1 && count === "2" && (await page.locator('[data-ds="LayerRow"]').count()) === 0, String(count));
  const fg = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="left"]').getBoundingClientRect();
    const r = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return [Math.round(b.left - panel.left), Math.round(b.width)];
    };
    return { field: r("[data-find-query]"), settings: r('[data-find] button[aria-label="Settings"]'), close: r('[data-find] button[aria-label="Close"]'), next: r('[data-find] button[aria-label="Next result"]') };
  });
  check("Find: the field 156 at 16, Settings 180, Close 204, Next result 208", JSON.stringify(fg) === JSON.stringify({ field: [16, 156], settings: [180, 24], close: [204, 24], next: [208, 24] }), JSON.stringify(fg));
  await page.keyboard.press("Enter");
  await settle(page);
  check("Enter in Find selects the first result", (await selection(page)).join() === "1:5", (await selection(page)).join());
  await shot(page, `171-find-${theme}`);
  await page.locator('[data-find] button[aria-label="Settings"]').click();
  await settle(page);
  await shot(page, `172-find-settings-${theme}`);
  await page.keyboard.press("Escape");
  await page.locator("[data-find-query] input").focus();
  await page.keyboard.press("Escape");
  await settle(page);
  check("Esc closes Find (the layers come back)", (await page.locator("[data-find]").count()) === 0 && (await page.locator('[data-ds="LayerRow"]').count()) > 0);

  // ⌘R on two layers: Rename layers.
  await page.evaluate(() => window.__designerEditor.engine.setSelection(["1:20", "1:21"]));
  await page.locator("#engine-canvas").focus();
  await page.keyboard.press("Meta+KeyR");
  await settle(page);
  check("⌘R on several layers opens Rename layers", (await page.locator("[data-rename-layers]").count()) === 1);
  await page.locator("[data-rename-to] input").fill("Shape $n");
  await settle(page);
  await shot(page, `173-rename-layers-${theme}`);
  await page.locator("[data-rename-apply]").click();
  await settle(page);
  const names = await page.evaluate(() => ["1:20", "1:21"].map((id) => window.__designerEditor.engine.readNode(id).name));
  check("Rename layers numbers from the bottom row up", JSON.stringify(names) === JSON.stringify(["Shape 1", "Shape 2"]), JSON.stringify(names));

  // The other tabs: their headers in place of the file's.
  for (const [tab, title] of [["assets", "Assets"], ["tools", "Tools"], ["agents", "Agents"]]) {
    await page.locator(`[data-rail-tab="${tab}"]`).click();
    await settle(page);
    check(`${title}: the tab is current and the panel has its header`, (await page.locator(`[data-rail-tab="${tab}"][aria-current="true"]`).count()) === 1 && (await page.locator(`[data-tab-header="${title}"]`).count()) === 1);
    await shot(page, `174-tab-${tab}-${theme}`);
  }
  await page.locator('[data-rail-tab="variables"]').click();
  await settle(page);
  check("Variables opens the variables view", (await page.evaluate(() => window.__designerEditor.ui.get().variablesOpen)) === true);
  await page.locator('[data-rail-tab="variables"]').click();
  await page.locator('[data-rail-tab="file"]').click();
  // The Figma menu opens under its tile (live: 12, 44) with Preferences and Libraries.
  await page.getByRole("button", { name: "Main menu" }).click();
  await settle(page);
  const top = await page.getByRole("menu").first().innerText();
  check("the Figma menu: Back to files, Actions…, File … Vector, Plugins, Widgets, Preferences, Libraries, Help and account", ["Back to files", "Actions", "Plugins", "Widgets", "Preferences", "Libraries", "Help and account"].every((w) => top.includes(w)), top.replace(/\n/g, " | "));
  await page.getByRole("menuitem", { name: "Preferences" }).hover();
  await page.waitForTimeout(300);
  await shot(page, `175-main-menu-preferences-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

/**
 * Round 9 at 1440 × 900 (the live captures' viewport; docs/research/figma/live/menus, toolbar, left): the Figma menu at
 * 12, 44 (194 wide, Actions… enabled, Open in desktop app), a submenu 4 past it, the canvas menu 200 wide with its text
 * at 16, the Move tools menu at the chevron, the Actions palette over the toolbar, Preferences kept across a reload,
 * a right drag panning, the row glyphs' names, Assets' card and Libraries, the Variables view.
 */
async function menus9Section(page, theme) {
  await open(page, "&doc=capture");
  const box = (loc) => loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  });
  await page.getByRole("button", { name: "Main menu" }).click();
  await settle(page);
  const main = page.getByRole("menu", { name: "Main menu" });
  check("r9: the Figma menu at 12, 44, 194 × 444 (live main-menu.txt)", JSON.stringify(await box(main)) === "[12,44,194,444]", JSON.stringify(await box(main)));
  check("r9: Actions… enabled, Open in desktop app listed", (await main.getByRole("menuitem", { name: /^Actions…/ }).getAttribute("aria-disabled")) === null && (await main.getByRole("menuitem", { name: "Open in desktop app" }).count()) === 1);
  await main.getByRole("menuitem", { name: "File", exact: true }).hover();
  await page.waitForTimeout(400);
  const file = page.getByRole("menu").nth(1);
  check("r9: File opens 4 past the menu (210, 126)", JSON.stringify((await box(file)).slice(0, 2)) === "[210,126]", JSON.stringify(await box(file)));
  await shot(page, `190-r9-main-menu-file-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);

  await page.mouse.click(1013, 614, { button: "right" });
  await settle(page);
  const canvasMenu = page.getByRole("menu", { name: "Canvas" });
  const geo = await canvasMenu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const item = el.querySelector('[role="menuitem"]');
    const label = item?.querySelector("span:not(:empty)");
    const range = document.createRange();
    range.selectNodeContents(label);
    return { w: Math.round(r.width), x: Math.round(range.getBoundingClientRect().left - r.left), checks: el.querySelectorAll('[role="menuitemcheckbox"]').length };
  });
  check("r9: the canvas menu 200 wide, its text at 16, no check column (live context-empty-canvas.txt)", geo.w === 200 && geo.x === 16 && geo.checks === 0, JSON.stringify(geo));
  await shot(page, `191-r9-canvas-menu-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);

  await page.getByRole("button", { name: "Move tools" }).click();
  await settle(page);
  check("r9: Move tools at the chevron, 151 × 72 at 497, 764 (live move-tools-menu.txt)", JSON.stringify(await box(page.getByRole("menu", { name: "Move tools" }))) === "[497,764,151,72]", JSON.stringify(await box(page.getByRole("menu", { name: "Move tools" }))));
  await page.keyboard.press("Escape");
  await settle(page);

  await page.evaluate(() => window.__designerEditor.engine.setSelection(["7:60"]));
  await page.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" }).click();
  await settle(page);
  const palette = page.locator("[data-actions-panel]");
  check("r9: the Actions palette 529 × 354 at 456, 478 (live actions-panel.txt)", JSON.stringify(await box(palette)) === "[456,478,529,354]", JSON.stringify(await box(palette)));
  await page.keyboard.type("flat");
  await settle(page);
  check("r9: typing lights the best match (Flatten)", (await palette.locator('[role="option"][aria-selected="true"]').innerText()).startsWith("Flatten"));
  await shot(page, `192-r9-actions-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);
  check("r9: Esc closes the palette", (await palette.count()) === 0);

  // Preferences: kept per machine (a reload keeps Use scroll wheel zoom on); a plain wheel then zooms.
  await page.evaluate(() => window.__designerEditor.ui.get());
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "Preferences", exact: true }).hover();
  await page.waitForTimeout(400);
  await shot(page, `193-r9-preferences-${theme}`);
  await page.getByRole("menuitemcheckbox", { name: "Use scroll wheel zoom" }).click();
  await open(page, "&doc=capture");
  check("r9: Preferences are kept (Use scroll wheel zoom after a reload)", (await page.evaluate(() => window.__designerEditor.ui.get().scrollWheelZoom)) === true);
  const zoom0 = await page.evaluate(() => window.__designerEditor.engine.getCamera().zoom);
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, 120);
  await settle(page);
  check("r9: Use scroll wheel zoom — a plain wheel zooms", (await page.evaluate(() => window.__designerEditor.engine.getCamera().zoom)) < zoom0);
  await page.evaluate(() => localStorage.removeItem("designer.preferences"));
  await open(page, "&doc=capture");

  // Right-click and drag to pan (on by default): the view moves, no menu.
  const cam0 = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  await page.mouse.move(900, 600);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(960, 640, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await settle(page);
  const cam1 = await page.evaluate(() => window.__designerEditor.engine.getCamera());
  check("r9: a right drag pans, no menu", Math.round(cam1.x - cam0.x) === 60 && Math.round(cam1.y - cam0.y) === 40 && (await page.getByRole("menu", { name: "Canvas" }).count()) === 0, JSON.stringify([cam0, cam1]));

  // Layers: the row glyphs named (live img [Rectangle], [Auto layout]…).
  check("r9: the Layers rows' glyphs are named", (await page.locator('[data-panel="left"] [role="img"][aria-label="Auto layout"]').count()) >= 4 && (await page.locator('[data-panel="left"] [role="img"][aria-label="Rectangle"]').count()) >= 1);

  // Assets on the components fixture: Libraries in the header, the card's ground, Add more libraries.
  await open(page, "&doc=components");
  await page.locator('[data-rail-tab="assets"]').click();
  await settle(page);
  const card = page.locator("[data-library-card] span").first();
  const cardStyle = await card.evaluate((el) => [getComputedStyle(el).backgroundColor, Math.round(el.getBoundingClientRect().width)]);
  check("r9: Assets — Libraries at 261, 12; the card 206 wide on white 10 %; Add more libraries", JSON.stringify((await box(page.locator("[data-libraries-button]"))).slice(0, 2)) === "[261,12]" && cardStyle[1] === 206 && /0\.1\)$/.test(cardStyle[0]) && (await page.getByRole("button", { name: "Add more libraries" }).count()) === 1, JSON.stringify(cardStyle));
  await shot(page, `194-r9-assets-${theme}`);

  // The Variables view (live rail-variables-table.txt).
  await open(page, "&doc=variables");
  await page.locator('[data-rail-tab="variables"]').click();
  await settle(page);
  const view = page.locator("[data-local-variables]");
  const head = await view.locator('[role="columnheader"]').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  check("r9: Variables — the file's name, Hide panel, Collections options, Collapse groups, Name 200, Create variable at 306, 868", (await view.getByRole("button", { name: "Hide panel" }).count()) === 1 && (await view.getByRole("button", { name: "Collections options" }).count()) === 1 && (await view.getByRole("button", { name: "Collapse groups" }).count()) === 1 && head === 200 && JSON.stringify((await box(view.getByRole("button", { name: "Create variable" }))).slice(0, 2)) === "[306,868]", String(head));
  await shot(page, `195-r9-variables-${theme}`);
}

/**
 * Round 10 at 1440 × 900 (live's viewport; docs/editor.md "Round 10 — Menus, commands, left side and toolbar"): menus
 * under their trigger without padding (S8), the keys' colours (S10), the frame title's and a Layers row's menus, the
 * vector edit toolbar and its More, Actions on Recents, the Assets grid, page rows, the left Resize handle, Find.
 */
async function menus10Section(page, theme) {
  await open(page, "&doc=capture");
  const box = (loc) => loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  });
  const near = (a, b, d = 1) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= d);
  const panel = page.locator('[data-panel="right"]');
  const select = async (ids) => {
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids);
    await settle(page);
  };
  // S8 / S10: the Boolean menu flush under its chevron, its first row lit with its keys at #ffffffcc.
  await select(["7:60"]);
  await panel.getByRole("group", { name: "Boolean operations" }).getByRole("button", { name: "Boolean operations" }).click();
  await settle(page);
  const bool = page.getByRole("menu").last();
  const bb = await box(bool);
  const litKey = await bool.locator("[data-highlighted]").first().evaluate((el) => [el.textContent, getComputedStyle(el.lastElementChild).color]);
  check("R10 S8: Boolean menu 151 × 120 (±2 / live boolean-operations-menu.txt), no padding above its rows", Math.abs(bb[2] - 151) <= 2 && bb[3] === 120, JSON.stringify(bb));
  check("R10 S10: its first row lit (Union), the lit row's keys #ffffffcc", /^Union/.test(litKey[0]) && litKey[1] === "rgba(255, 255, 255, 0.8)", JSON.stringify(litKey));
  await shot(page, `270-r10-boolean-menu-${theme}`);
  await page.keyboard.press("Escape");
  await select([]);
  // S10: a disabled row's keys #ffffff66 (Figma menu › Arrange, nothing selected).
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "Arrange", exact: true }).hover();
  await page.waitForTimeout(400);
  const keyColor = await page.getByRole("menu").last().locator('[aria-disabled="true"]').first().evaluate((el) => getComputedStyle(el.lastElementChild).color);
  check("R10 S10: a disabled row's keys #ffffff66 (live main-arrange.txt)", keyColor === "rgba(255, 255, 255, 0.4)", keyColor);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page);

  // A right-click on a frame's title: the frame's menu (live context-frame.txt, 200 × 749).
  const [tx, ty] = await toScreen(page, 300, 0);
  await page.mouse.click(tx + 10, ty - 8, { button: "right" });
  await settle(page);
  const frameMenu = page.getByRole("menu", { name: "Canvas" });
  check("R10: a frame title's right click opens the frame's menu (200 × 749, Convert to section)", (await selection(page)).join() === "7:10" && near(await box(frameMenu).then((b) => b.slice(2)), [200, 749]) && (await frameMenu.getByRole("menuitem", { name: "Convert to section" }).count()) === 1, JSON.stringify(await box(frameMenu)));
  await page.keyboard.press("Escape");
  // A Layers row's menu: Copy first, Rename ⌘R, Rename layers (AI), 200 × 677 (live context-layer-row.txt).
  await page.locator('[data-panel="left"] [data-ds="LayerRow"]').filter({ hasText: /^Rect$/ }).first().click({ button: "right" });
  await settle(page);
  const rowMenu = page.getByRole("menu", { name: "Canvas" });
  check("R10: a Layers row's menu 200 × 677 with Rename and Rename layers (AI), no Paste here", near((await box(rowMenu)).slice(2), [200, 677]) && (await rowMenu.getByRole("menuitem", { name: /^Rename/ }).count()) === 2 && (await rowMenu.getByRole("menuitem", { name: "Paste here" }).count()) === 0, JSON.stringify(await box(rowMenu)));
  await shot(page, `271-r10-layer-row-menu-${theme}`);
  await page.keyboard.press("Escape");

  // Vector edit: live's secondary toolbar 529 × 40 at 455, 792 over the bottom toolbar; More's menu 189 × 48 at 869, 736.
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.engine.setSelection(["7:60"]);
    ed.vector.start("7:60");
  });
  await settle(page);
  const vbar = page.locator("[data-vector-toolbar]");
  const names = await vbar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check("R10: the vector edit toolbar (live vector-edit-toolbar.txt): Move, Lasso, Paint, Bend, Cut, Erase, More, Close", names.join() === "Move,Lasso,Paint,Bend,Cut,Erase,More,Close", names.join());
  check("R10: 529 × 40 at 455, 792 (±2), the bottom toolbar still there", near(await box(vbar), [455, 792, 529, 40], 2) && (await page.locator('[data-ds="EditorToolbar"]').count()) === 1, JSON.stringify(await box(vbar)));
  await vbar.getByRole("button", { name: "More" }).click();
  await settle(page);
  const more = page.getByRole("menu", { name: "Vector editing tools" });
  check("R10: More › Vector editing tools 189 × 48 at 869, 736 (±2): Shape builder M, Variable width ⇧W", near(await box(more), [869, 736, 189, 48], 2) && (await more.getByRole("menuitemradio").count()) === 2, JSON.stringify(await box(more)));
  await shot(page, `272-r10-vector-toolbar-${theme}`);
  await page.keyboard.press("Escape");
  await vbar.getByRole("button", { name: "Cut" }).click();
  const [cx, cy] = await toScreen(page, 60, 300);
  await page.mouse.click(cx, cy);
  await settle(page);
  const cut = await page.evaluate(() => window.__designerEditor.vector.state.get());
  check("R10: Cut — a click on a segment cuts it apart (4 → 5 segments)", cut.segmentCount === 5 && cut.tool === "CUT", JSON.stringify([cut.segmentCount, cut.tool]));
  await vbar.getByRole("button", { name: "Close" }).click();
  await settle(page);
  check("R10: Close leaves vector edit mode", (await page.locator("[data-vector-toolbar]").count()) === 0);
  await page.evaluate(() => window.__designerEditor.engine.undo());

  // Actions: 529 × 354 at 456, 478; after a run, it opens on Recents.
  const toolbarActions = page.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" });
  await toolbarActions.click();
  await settle(page);
  await page.keyboard.type("zoom to fit");
  await page.keyboard.press("Enter");
  await settle(page);
  await toolbarActions.click();
  await settle(page);
  const palette = page.locator("[data-actions-panel]");
  const firstHeader = await palette.locator('[role="presentation"]').first().innerText();
  check("R10: Actions 529 × 354 at 456, 478, on Recents, Visual search (AI beta) listed", JSON.stringify(await box(palette)) === "[456,478,529,354]" && firstHeader === "Recents" && (await palette.locator('[role="option"]').count()) === 1 && (await palette.getByRole("button", { name: "Visual search (AI beta)" }).count()) === 1, JSON.stringify([await box(palette), firstHeader]));
  await shot(page, `273-r10-actions-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);

  // The left side: page rows 224 × 24 at 65; the Resize handle 8 × 900 at 295; Find at 400.
  check("R10: a page row is a 224 × 24 button at 65, 109 (live pages-add-page-rename.txt)", JSON.stringify(await box(page.locator('[data-ds="PageRow"]').first())) === "[65,109,224,24]" && (await page.locator('[data-ds="PageRow"]').first().getAttribute("role")) === "button");
  check("R10: the left panel's Resize handle 8 × 900 at 295", JSON.stringify(await box(page.locator('[data-panel="left"] > [role="slider"][aria-label="Resize handle"]'))) === "[295,0,8,900]", JSON.stringify(await box(page.locator('[data-panel="left"] > [role="slider"][aria-label="Resize handle"]'))));
  await page.locator('[data-panel="left"]').getByRole("button", { name: "Find" }).first().click();
  await page.keyboard.type("AL_");
  await settle(page);
  const weights = await page.locator('[data-panel="left"]').evaluate((el) => {
    const parent = el.querySelector('[data-find-results] [class*="parent"]');
    const scope = el.querySelector('[aria-label^="Search scope set to"]');
    return [parent && getComputedStyle(parent).fontWeight, scope && getComputedStyle(scope).fontWeight];
  });
  check("R10: Find's parent names 10 / 400 and its scope 11 / 400 (live find-layers-search.txt)", weights.join() === "400,400", weights.join());
  await page.keyboard.press("Escape");

  // Assets: the grid (96 tiles at 73 / 185, 125), Back at 65, 93; the Assets button expanded.
  await page.locator('[data-rail-tab="assets"]').click();
  await settle(page);
  await page.locator("[data-library-card]").first().click();
  await page.locator('[data-asset-page="Capture"]').click();
  await settle(page);
  const tiles = await page.locator('[data-panel="left"] [role="treeitem"]').evaluateAll((els) => els.slice(0, 3).map((e) => {
    const r = e.firstElementChild.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }));
  check("R10: Assets › Created in this file › Capture — 96 tiles at 73 / 185, 125, rows 132 apart (live)", JSON.stringify(tiles) === "[[73,125,96,96],[185,125,96,96],[73,257,96,96]]", JSON.stringify(tiles));
  check("R10: Back at 65, 93; the Assets button expanded", JSON.stringify((await box(page.locator('[data-panel="left"]').getByRole("button", { name: "Back" }))).slice(0, 2)) === "[65,93]" && (await page.locator('[data-rail-tab="assets"]').getAttribute("aria-expanded")) === "true");
  await shot(page, `274-r10-assets-${theme}`);
}

/**
 * Round 11 at 1440 × 900 (docs/research/figma/live/left/rail-variables-full-view.txt, rail-tools.txt, toolbar/*.txt,
 * menus/main-object.txt, main-*.txt): the Variables empty state, the selected collection's bar, Edit variable on hover,
 * Tools' Filter by price and type, Actions on Recents with live's two status lines, a slot menu lighting the slot's
 * own tool, the Object submenu running past the window, the key glyphs' widths, Flatten on an instance.
 */
async function menus11Section(page, theme) {
  await open(page, "&doc=capture");
  const box = (loc) => loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  });
  const near = (a, b, d = 1) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= d);
  // 1. Variables, a file with no collection.
  await page.locator('[data-rail-tab="variables"]').click();
  await settle(page);
  const win = page.locator("[data-local-variables]");
  const title = await win.locator("h2").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return [el.textContent, Math.round(b.left), Math.round(b.top), getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight];
  });
  check("R11 Variables empty: the title 'Variables' 13 / 450 at 322, 16 (live rail-variables-full-view.txt)", title[0] === "Variables" && Math.abs(title[1] - 322) <= 1 && title[2] === 16 && title[3] === "13px" && title[4] === "450", JSON.stringify(title));
  const heading = win.getByText("No variables created in this file");
  const hb = await heading.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight];
  });
  check("R11 Variables empty: 'No variables created in this file' 15 / 550 at 759, 414 (±3 text metrics)", Math.abs(hb[0] - 759) <= 3 && hb[1] === 414 && hb[2] === "15px" && hb[3] === "550", JSON.stringify(hb));
  const create = win.getByRole("button", { name: "Create variable button" });
  const imp = win.getByRole("button", { name: "Import variables button" });
  check("R11 Variables empty: Create 71 × 24 at 794, 491 and Import 71 × 24 at 873, 491 (±1)", near(await box(create), [794, 491, 71, 24], 1) && near(await box(imp), [873, 491, 71, 24], 1), JSON.stringify([await box(create), await box(imp)]));
  check("R11 Variables empty: Learn more →, no search, no filter, the left panel holds only Collections", (await win.getByRole("link", { name: /Learn more/ }).count()) === 1 && (await win.getByRole("group", { name: "Search and filter" }).count()) === 0 && (await win.getByRole("button", { name: "Create collection" }).count()) === 1 && (await win.getByText("Create your first collection").count()) === 0);
  await shot(page, `280-r11-variables-empty-${theme}`);
  await create.click();
  await settle(page);
  const made = await page.evaluate(() => window.__designerEditor.assets?.variables?.length ?? null);
  check("R11 Variables empty: Create makes a collection with its first variable", (await win.getByRole("row").count()) >= 2 && (await win.getByRole("button", { name: "Create variable button" }).count()) === 0, String(made));
  // 2. The table (the variables fixture): the selected collection's bar, Edit variable on hover only.
  await open(page, "&doc=variables");
  await page.locator('[data-rail-tab="variables"]').click();
  await settle(page);
  const bar = await page.locator("[data-local-variables] [data-collection]").first().evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return [s.backgroundColor, s.height, s.borderRadius];
  });
  check("R11 Variables table: the selected collection has a #383838 bar, 24 high, 5 radius", bar[0] === "rgb(56, 56, 56)" && bar[1] === "24px" && bar[2] === "5px", JSON.stringify(bar));
  const editBtn = page.locator("[data-local-variables]").getByRole("button", { name: "Edit variable" }).first();
  const op0 = await editBtn.evaluate((el) => getComputedStyle(el).opacity);
  await page.locator("[data-local-variables] [data-variable-row]").first().hover();
  const op1 = await editBtn.evaluate((el) => getComputedStyle(el).opacity);
  check("R11 Variables table: Edit variable's glyph is drawn on the hovered row only", op0 === "0" && op1 === "1", `${op0} -> ${op1}`);
  await shot(page, `281-r11-variables-table-${theme}`);
  await page.locator('[data-rail-tab="variables"]').click();
  // 3. Tools: Filter by price and type enabled, with a menu.
  await open(page, "&doc=capture");
  await page.locator('[data-rail-tab="tools"]').click();
  const filter = page.getByRole("button", { name: "Filter by price and type" });
  check("R11 Tools: Filter by price and type is enabled and opens a menu", (await filter.isEnabled()) && (await filter.getAttribute("aria-haspopup")) === "menu");
  await filter.click();
  await settle(page);
  check("R11 Tools: its menu lists prices and types", (await page.getByRole("menuitemradio").count()) + (await page.getByRole("menuitem").count()) >= 6 || (await page.getByRole("menu").count()) === 1);
  await page.keyboard.press("Escape");
  await page.locator('[data-rail-tab="file"]').click();
  // 4. Actions with nothing run yet: Recents alone, the two status lines at -1, 0 and -1, 24.
  await page.evaluate(() => localStorage.removeItem("designer.actions.recents"));
  await page.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" }).click();
  await settle(page);
  const palette = page.locator("[data-actions-panel]");
  const pb = await box(palette);
  const statuses = await palette.locator('[role="status"]').evaluateAll((els) => els.map((e) => [e.textContent, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().top)]));
  check("R11 Actions: 529 × 354 at 456, 478; no recents: the Recents header alone, no command list", near(pb, [456, 478, 529, 354], 0) && (await palette.locator('[role="option"]').count()) === 0 && (await palette.getByText("Recents", { exact: true }).count()) === 1, JSON.stringify(pb));
  check("R11 Actions: 'Results will update as you type.' at -1, 0 and '0 results available.' 24 below (live -1, 3 / -1, 27 as text)", statuses.length === 2 && statuses[0][0] === "Results will update as you type." && statuses[0][1] === pb[0] - 1 && statuses[0][2] === pb[1] && statuses[1][2] === pb[1] + 24 && /results available\./.test(statuses[1][0]), JSON.stringify(statuses));
  await shot(page, `282-r11-actions-${theme}`);
  await page.keyboard.press("Escape");
  await settle(page);
  // 5. A slot's menu lights the slot's own tool, whichever tool is active.
  await page.keyboard.press("o");
  await settle(page);
  await page.getByRole("button", { name: "Region tools" }).click();
  await settle(page);
  const region = page.getByRole("menu").last();
  const litRegion = await region.locator("[data-highlighted]").first().evaluate((el) => [el.textContent, getComputedStyle(el.lastElementChild).color]);
  check("R11 Toolbar: with Ellipse active, Region tools lights Frame, its key #ffffffcc (live region-tools-menu.txt)", /^Frame/.test(litRegion[0]) && litRegion[1] === "rgba(255, 255, 255, 0.8)", JSON.stringify(litRegion));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Type tools" }).click();
  await settle(page);
  const litType = await page.getByRole("menu").last().locator("[data-highlighted]").first().evaluate((el) => el.textContent);
  check("R11 Toolbar: Type tools lights Text", /^Text/.test(litType), litType);
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  // 6. The Object submenu runs past the window (live: 185 × 1050 at 210, 6), no bar.
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "Object", exact: true }).hover();
  await page.waitForTimeout(400);
  const objectMenu = page.getByRole("menu").last();
  const ob = await box(objectMenu);
  check("R11 Object submenu: 185 × 1050 at 210, 6 (±1), past the window's 900", near(ob, [210, 6, 185, 1050], 1), JSON.stringify(ob));
  await shot(page, `283-r11-object-menu-${theme}`);
  // 7. Key glyph widths: Edit 190, Vector 198, Preferences 235 (live main-*.txt).
  const widths = {};
  for (const [name, want] of [["Edit", 190], ["Vector", 198], ["Preferences", 235], ["File", 198]]) {
    await page.getByRole("menuitem", { name, exact: true }).first().hover();
    await page.waitForTimeout(350);
    widths[name] = [(await box(page.getByRole("menu").last()))[2], want];
  }
  check("R11 key glyphs: Edit 190, Vector 198, Preferences 235, File 198 wide (±1; live main-*.txt)", Object.values(widths).every(([w, want]) => Math.abs(w - want) <= 1), JSON.stringify(widths));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 8. Flatten on an instance: enabled, one undo step.
  const inst = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const all = [];
    const walk = (g) => {
      const n = ed.engine.readNode(g);
      if (!n) return;
      all.push([g, n]);
      for (const c of ed.engine.readNodes([g], { childIds: true })[0]?.childIds ?? []) walk(c);
    };
    walk("0:0");
    return all.find(([, n]) => n.type === "INSTANCE" && n.name === "Button instance")?.[0] ?? null;
  });
  await page.evaluate((id) => window.__designerEditor.engine.setSelection([id]), inst);
  await settle(page);
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "Object", exact: true }).hover();
  await page.waitForTimeout(350);
  const flat = page.getByRole("menu").last().getByRole("menuitem", { name: /^Flatten/ });
  check("R11 Flatten on an instance is enabled (live context-instance.txt)", inst !== null && (await flat.getAttribute("aria-disabled")) === null, String(inst));
  await flat.click();
  await settle(page);
  const afterType = await page.evaluate((id) => window.__designerEditor.engine.readNode(id).type, inst);
  await page.evaluate(() => window.__designerEditor.engine.undo());
  const undoneType = await page.evaluate((id) => window.__designerEditor.engine.readNode(id).type, inst);
  check("R11 Flatten on an instance: it becomes a vector; one undo brings the instance back", afterType === "VECTOR" && undoneType === "INSTANCE", `${afterType} -> ${undoneType}`);
  // 9. Vector editing tools: Figma Draw's two stay listed disabled (not built).
  await page.evaluate(() => {
    const ed = window.__designerEditor;
    ed.engine.setSelection(["7:60"]);
    ed.vector.start("7:60");
  });
  await settle(page);
  await page.locator("[data-vector-toolbar]").getByRole("button", { name: "More" }).click();
  await settle(page);
  const dis = await page.getByRole("menu", { name: "Vector editing tools" }).getByRole("menuitemradio").evaluateAll((els) => els.map((e) => e.getAttribute("aria-disabled")));
  check("R11 Vector editing tools: Shape builder and Variable width listed disabled (Figma Draw: not built)", dis.join() === "true,true", dis.join());
  await page.keyboard.press("Escape");
  // 10. A store-backed file (what the desktop app opens; the browser's dev store stands in): the file commands that need
  // a document source are enabled — Duplicate, Save to version history…, Show version history, Create
  // branch…; Save local copy… needs the desktop's own bridge (window.designer.files), so it is off here.
  const key = await page.evaluate(async (repo) => {
    const st = await import("/src/store/index.ts");
    const { encodeMessage, newDocumentMessage } = await import(`/@fs${repo}/src/shared/schema/codec.ts`);
    const mem = await st.getDevStore().ready;
    return (await mem.addFile({ name: "Round 11", folderId: null, snapshot: encodeMessage(st.messageToKiwi(newDocumentMessage())) })).fileKey;
  }, repo);
  await open(page, `&file=${key}`);
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "File", exact: true }).hover();
  await page.waitForTimeout(350);
  const fileMenu = page.getByRole("menu").last();
  const states = {};
  for (const name of ["Duplicate", "Save local copy…", "Save to version history…", "Show version history", "Create branch…"]) {
    const row = fileMenu.getByRole("menuitem", { name }).first();
    states[name] = (await row.count()) === 1 && (await row.getAttribute("aria-disabled")) === null;
  }
  check("R11 a store-backed file: Duplicate, Save to version history…, Show version history and Create branch… are enabled", ["Duplicate", "Save to version history…", "Show version history", "Create branch…"].every((n) => states[n]), JSON.stringify(states));
  check("R11 a store-backed file in a browser: Save local copy… stays off (the desktop's own bridge)", states["Save local copy…"] === false);
  await page.getByRole("menuitem", { name: "Duplicate" }).first().click();
  await settle(page);
  const toast = await page.getByText(/Duplicated as/).count();
  check("R11 File › Duplicate runs (a toast names the copy in a browser; the desktop opens it in a tab)", toast === 1);
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("menuitem", { name: "File", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Show version history" }).click();
  await settle(page);
  check("R11 File › Show version history opens the history", (await page.getByRole("dialog").count()) >= 1 || (await page.evaluate(() => !!window.__designerEditor.ui.get().versionDialog)));
  await page.keyboard.press("Escape");
}

try {
  if (only === "menus11") {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await menus11Section(page, "dark");
    await context.close();
  }
  if (only === "leftpanel" || (!only && part !== "2")) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await leftPanelSection(page, "dark");
    await context.close();
  }
  if (only === "menus10") {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await menus10Section(page, "dark");
    await context.close();
  }
  if (only === "menus9") {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await menus9Section(page, "dark");
    await context.close();
  }
  if (only === "grid" || (!only && part !== "2")) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await gridSection(page, "dark");
    await context.close();
  }
  for (const [name, section] of [
    ["selection", selectionSection],
    ["selection8", selection8Section],
    ["slots", slotsSection],
    ["variables6", variables6Section],
    ["devmode", devmodeSection],
    ["design", designSection],
  ]) {
    if ((only !== name && only) || part === "2") continue;
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await section(page, "dark");
    await context.close();
  }
  if (only === "panel10" || (!only && part !== "2")) {
    // Live's viewport (the captures' absolute places).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await panel10Section(page, "dark");
    await context.close();
  }
  if (only === "panel11") {
    // Live's viewport (the captures' absolute places).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await panel11Section(page, "dark");
    await context.close();
  }
  if (only === "features11") {
    // Live's viewport (the captures' absolute places); on its own, as panel11 (the full run's parts stay within 180 s).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await features11Section(page, "dark");
    await context.close();
  }
  if (only === "header9" || (!only && part !== "2")) {
    // Live's viewport (the captures' absolute places).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await header9Section(page, "dark");
    await context.close();
  }
  if (only === "text" || (!only && part !== "2")) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await textSection(page, "dark");
    await context.close();
  }
  if (only === "overlays9") {
    // Round 9's canvas chrome on its own (the full run stays within its 180 s).
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await overlays9Section(page, "dark");
    await context.close();
  }
  if (only === "grid12") {
    // Round 12's grid gaps and track menu at live's viewport, on its own (the full run stays within its 180 s).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await grid12Section(page, "dark");
    await context.close();
  }
  if (only === "overlays11") {
    // Round 11's canvas chrome at live's viewport, on its own (the full run stays within its 180 s).
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await overlays11Section(page, "dark");
    await context.close();
  }
  if (only === "prototype") {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await prototypeSection(page, "dark");
    await context.close();
  }
  if (only === "fonts" || (!only && part !== "2")) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await fontsSection(page, "dark");
    await context.close();
  }
  if (only === "export" || (!only && part !== "2")) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark", acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await exportSection(page, "dark");
    await context.close();
  }
  if (only === "libraries") {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()} (${m.location()?.url ?? ""})`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await librariesSection(page, "dark");
    await context.close();
  }
  if (only === "variables") {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await variablesSection(page, "dark");
    await context.close();
  }
  if (only === "paints") {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    page.on("response", (r) => {
      if (r.status() >= 400) problems.push(`dark ${r.status()}: ${r.url()}`);
    });
    await paintsSection(page, "dark");
    await context.close();
  }
  if (only === "components") {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`dark console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`dark pageerror: ${e.message}`));
    await componentsSection(page, "dark");
    await context.close();
  }
  for (const theme of only || part === "1" ? [] : ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 1, colorScheme: theme });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${theme} console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`${theme} pageerror: ${e.message}`));

    // 1. The reference file, nothing selected.
    await open(page, "&doc=reference");
    await shot(page, `01-nothing-${theme}`);

    // 2. "Frame 1" selected (a click on it).
    await page.mouse.click(...(await toScreen(page, 100, 150)));
    const sel = await selection(page);
    if (theme === "dark") check("click selects Frame 1", sel.join() === "1:1", sel.join());
    await shot(page, `02-frame-selected-${theme}`);

    // 3. The frame with auto layout (⇧A; the panel's button when the engine has no command yet).
    await page.keyboard.press("Shift+KeyA");
    await settle(page);
    let frame = await node(page, "1:1");
    if (frame.stackMode !== "VERTICAL" && frame.stackMode !== "HORIZONTAL") {
      const add = page.getByRole("button", { name: "Add auto layout" });
      if (await add.count()) await add.first().click();
      await settle(page);
      frame = await node(page, "1:1");
    }
    if (theme === "dark") check("auto layout on the frame", frame.stackMode === "VERTICAL" || frame.stackMode === "HORIZONTAL", String(frame.stackMode));
    await shot(page, `03-auto-layout-${theme}`);

    // 4. The sample document (several kinds of layers), a rectangle selected; then the menus.
    await open(page, "");
    await page.mouse.click(...(await toScreen(page, 100, 150)));
    const picked = await selection(page);
    await shot(page, `04-sample-rectangle-${theme}`);
    await page.mouse.click(...(await toScreen(page, 100, 150)), { button: "right" });
    await shot(page, `05-context-menu-${theme}`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Main menu" }).first().click();
    await page.getByRole("menuitem", { name: "Object" }).hover();
    await page.waitForTimeout(400);
    await shot(page, `06-main-menu-${theme}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Zoom" }).click();
    await shot(page, `07-zoom-menu-${theme}`);
    await page.keyboard.press("Escape");

    if (theme === "dark") {
      // Minimize UI (⇧⌘\, the live View menu), hide UI (⌘\), the shortcuts (⌃⇧?).
      await page.locator("#engine-canvas").focus();
      // (The menus' Escapes may have reached the canvas: Esc clears the selection there, live Figma.)
      const selected = (await selection(page)).length ? await selection(page) : picked;
      await page.evaluate(() => window.__designerEditor.engine.setSelection([]));
      await page.keyboard.press("Meta+Shift+Backslash");
      await shot(page, `08-minimized-${theme}`);
      check("⇧⌘\\ minimizes the UI", (await page.locator("[data-minimized]").count()) === 2);
      await page.evaluate((s) => window.__designerEditor.engine.setSelection(s), selected);
      await settle(page);
      check("minimized with a selection: the properties panel floats at the right", (await page.locator('[data-panel="right"][data-floating]').count()) === 1 && (await page.locator('[data-minimized="left"]').count()) === 1);
      await shot(page, `08b-minimized-selection-${theme}`);
      await page.keyboard.press("Meta+Shift+Backslash");
      await page.keyboard.press("Meta+Backslash");
      await shot(page, `09-hidden-${theme}`);
      check("⌘\\ hides the UI", (await page.locator('[data-ds="Rail"]').count()) === 0);
      await page.keyboard.press("Meta+Backslash");
      await page.keyboard.press("Control+Shift+Slash");
      await shot(page, `10-shortcuts-${theme}`);
      check("⌃⇧? opens the shortcuts", (await page.getByRole("dialog").count()) === 1);
      await page.keyboard.press("Escape");

      // ---- Phase 2: sizing menus, min / max, auto-layout settings, constraints, Selection colors, layer types ----
      await open(page, "&doc=types");
      const row = (id) => page.locator(`[data-ds="LayerRow"][data-id="${id}"]`);
      const panel = page.locator('[data-panel="right"]');
      const selectLayer = (id) => page.evaluate((id) => window.__designerEditor.engine.setSelection([id]), id);
      await row("1:1").click();
      await settle(page);
      // Figma's live panel: an axis that hugs or fills makes the row "Resizing" ("Horizontal resizing" / "Vertical
      // resizing"), each field the number and its mode ("320", "200 … Hug").
      const width = panel.getByRole("textbox", { name: "Horizontal resizing", exact: true });
      const height = panel.getByRole("textbox", { name: "Vertical resizing", exact: true });
      const mode = async (field) => ((await field.locator("xpath=..").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      check("an auto-layout frame reads Fixed width and Hug height", (await width.inputValue()) === "320" && (await mode(height)).endsWith("Hug"), `${await width.inputValue()} × ${await mode(height)}`);
      await shot(page, `16-types-auto-layout-${theme}`);
      await width.hover();
      await panel.getByRole("button", { name: "Horizontal resizing sizing" }).click();
      const menuText = await page.getByRole("menu").innerText();
      check("the W menu: Fixed width, Hug contents, Add min/max width…", ["Fixed width", "Hug contents", "Add min width…", "Add max width…"].every((t) => menuText.includes(t)), menuText.replace(/\n/g, " | "));
      await shot(page, `17-width-menu-${theme}`);
      await page.getByRole("menuitemcheckbox", { name: "Hug contents" }).click();
      await settle(page);
      const hugged = await node(page, "1:1");
      check("Hug contents writes the frame's sizing", hugged.stackPrimarySizing !== "FIXED" && (await mode(width)).endsWith("Hug"), `${hugged.stackPrimarySizing}, W ${await mode(width)}`);
      await page.keyboard.press("Meta+z");
      await settle(page);
      await panel.getByRole("button", { name: "Auto layout settings" }).click();
      await settle(page);
      check("the auto-layout settings open", (await page.getByRole("dialog", { name: "Auto layout settings" }).count()) === 1);
      await shot(page, `18-auto-layout-settings-${theme}`);
      await page.keyboard.press("Escape");
      await selectLayer("1:3");
      await settle(page);
      check("a Fill child reads Fill", (await mode(width)).endsWith("Fill"), await mode(width));
      check("Ignore auto layout shows for an auto-layout child", (await panel.getByRole("button", { name: "Ignore auto layout" }).count()) === 1);
      await width.hover();
      await panel.getByRole("button", { name: "Horizontal resizing sizing" }).click();
      await page.getByRole("menuitem", { name: "Add min width…" }).click();
      await settle(page);
      const minned = await node(page, "1:3");
      check("Add min width… adds the limit and its row", minned.minSize?.value?.x > 0 && (await panel.getByRole("textbox", { name: "Min width" }).count()) === 1, JSON.stringify(minned.minSize));
      await shot(page, `19-fill-child-min-width-${theme}`);
      await selectLayer("1:11");
      await settle(page);
      // Constraints: Position's toggle opens the inline row (Figma's live panel).
      const widget = panel.locator('[data-ds-editor="ConstraintsWidget"]');
      if (!(await widget.count())) await panel.getByRole("button", { name: "Constraints" }).click();
      await settle(page);
      check("Constraints show for a frame's child", (await widget.count()) === 1);
      await widget.getByRole("button", { name: "Bottom" }).click();
      await widget.getByRole("button", { name: "Top" }).click({ modifiers: ["Shift"] });
      const pinned = await node(page, "1:11");
      check("the widget writes constraints (⇧ for both)", pinned.verticalConstraint === "STRETCH", pinned.verticalConstraint);
      await shot(page, `20-constraints-${theme}`);
      await panel.getByRole("button", { name: "Constraints" }).click();
      await row("1:10").click();
      await settle(page);
      check("Selection colors list a frame's colours", (await panel.getByText("Selection colors").count()) === 1);
      await shot(page, `21-selection-colors-${theme}`);
      await row("1:20").click();
      await settle(page);
      check("a vector reads Vector path", (await panel.getByText("Vector path", { exact: true }).count()) === 1);
      await shot(page, `22-vector-${theme}`);
      await row("1:22").click();
      await settle(page);
      check("a text layer shows Typography", (await panel.getByText("Typography", { exact: true }).count()) === 1);
      await shot(page, `23-text-${theme}`);
      await panel.getByRole("button", { name: "Type settings" }).click();
      await settle(page);
      await shot(page, `24-type-settings-${theme}`);
      await page.keyboard.press("Escape");

      // ---- E4 / E5: paints, effects, guides, strokes, booleans, images, vector edit ----
      await paintsSection(page, theme);

      // ---- E6: components, instances, variants, properties, Assets ----
      await componentsSection(page, theme);

      // ---- Variables, modes, styles ----
      await variablesSection(page, theme);

      // ---- Libraries (the dev store: publish, enable, insert, update) ----
      if (theme === "dark") await librariesSection(page, theme);

      // ---- End to end: draw, Esc, undo / redo, delete, rename, the source's changes ----
      await open(page, "&doc=empty");
      const before = await page.evaluate(() => window.__designerEditor.source.changes.length);
      await page.keyboard.press("f");
      await drag(page, await toScreen(page, 100, 100), await toScreen(page, 400, 300));
      const frameId = (await selection(page))[0];
      const made = frameId ? await node(page, frameId) : null;
      check("F + drag draws a frame", made?.type === "FRAME", made ? `${made.name} ${made.size.x}×${made.size.y}` : "nothing");
      await shot(page, `11-drawn-frame-${theme}`);
      await page.keyboard.press("r");
      await drag(page, await toScreen(page, 140, 140), await toScreen(page, 240, 220));
      const rectId = (await selection(page))[0];
      const rect = rectId ? await node(page, rectId) : null;
      check("R + drag draws a rectangle in the frame", (rect?.type === "ROUNDED_RECTANGLE" || rect?.type === "RECTANGLE") && rect.parentIndex?.guid === frameId, rect ? `${rect.name} in ${rect.parentIndex?.guid}` : "nothing");
      const layers = await page.locator('[data-ds="LayerRow"]').count();
      check("Layers shows the frame and the rectangle", layers === 2, `${layers} rows`);
      await shot(page, `12-drawn-rectangle-${theme}`);
      // Live Figma: \ (and ⇧Enter) selects the parent; Esc clears the selection.
      await page.keyboard.press("Backslash");
      const up = await selection(page);
      await page.keyboard.press("Escape");
      check("\\ selects the parent, Esc clears the selection", up.join() === frameId && (await selection(page)).length === 0, `${up.join()} → ${(await selection(page)).join() || "nothing"}`);
      await page.keyboard.press("Meta+z");
      await settle(page);
      check("⌘Z undoes the rectangle", (await node(page, rectId)) === null);
      await page.keyboard.press("Meta+Shift+z");
      await settle(page);
      check("⇧⌘Z redoes it", (await node(page, rectId)) !== null);
      await page.locator(`[data-ds="LayerRow"][data-id="${rectId}"]`).click();
      check("a Layers click selects", (await selection(page)).join() === rectId);
      await page.locator(`[data-ds="LayerRow"][data-id="${rectId}"]`).dblclick();
      await page.keyboard.type("Card");
      await page.keyboard.press("Enter");
      await settle(page);
      check("double-click renames in Layers", (await node(page, rectId))?.name === "Card", (await node(page, rectId))?.name);
      // The Design panel writes: X through the field.
      const x = page.getByRole("textbox", { name: "X-position", exact: true });
      if (await x.count()) {
        await x.click();
        await page.keyboard.type("60");
        await page.keyboard.press("Enter");
        await settle(page);
        const moved = await node(page, rectId);
        check("X field moves the layer", Math.round(moved.transform.m02) === 60, `x = ${moved.transform.m02}`);
      } else check("X field moves the layer", false, "no X field");
      await page.locator("#engine-canvas").focus();
      await page.keyboard.press("Backspace");
      await settle(page);
      check("Delete removes the selection", (await node(page, rectId)) === null);
      const after = await page.evaluate(() => window.__designerEditor.source.changes.length);
      check("the DocumentSource got every change", after - before >= 6, `${after - before} change messages`);
      await shot(page, `13-after-edits-${theme}`);

      // ---- A file on the store (the browser's dev store): draw, flush, reopen — it is still there ----
      const key = await page.evaluate(async () => {
        const s = await import("/src/store/index.ts");
        const files = await s.getStoreClient().workspace.listFiles({ in: "recents" });
        return files[0]?.fileKey ?? null;
      });
      if (!key) check("a store file opens", false, "no files in the dev store");
      else {
        await open(page, `&file=${key}`);
        const name = await page.evaluate(() => window.__designerEditor.ui.get().fileName);
        check("a store file opens", name.length > 0 && name !== "Sample file", name);
        await page.locator("#engine-canvas").focus();
        await page.keyboard.press("r");
        const area = await page.locator("#engine-canvas").boundingBox();
        await drag(page, [area.x + area.width - 120, area.y + 40], [area.x + area.width - 60, area.y + 100]);
        const made = (await selection(page))[0];
        await page.evaluate(() => window.__designerEditor.source.flush());
        await shot(page, `14-store-file-${theme}`);
        // ⌥⌘S saves a version; the history lists it.
        await page.keyboard.press("Alt+Meta+KeyS");
        await page.getByRole("dialog").getByRole("textbox").first().fill("Before review");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        await page.evaluate(() => window.__designerEditor.ui.set({ versionDialog: "history" }));
        await page.getByText("Before review").waitFor({ timeout: 5000 }).catch(() => {});
        check("⌥⌘S saves a version the history lists", (await page.getByText("Before review").count()) > 0);
        await shot(page, `15-version-history-${theme}`);
        await page.keyboard.press("Escape");
        // The camera is kept per file (UI state, debounced 2 s). The thumbnail comes a few seconds after the last
        // change on an idle moment — never within 10 s of the open — and at the latest when the tab flushes (main's
        // close / quit handshake runs `ed.beforeFlush`): the flush path is what is checked here.
        await page.evaluate(() => window.__designerEditor.engine.setCamera({ x: 40, y: 30, zoom: 2 }));
        await page.waitForTimeout(2500);
        await page.evaluate(async () => {
          const ed = window.__designerEditor;
          await Promise.all([...ed.beforeFlush].map((work) => work().catch(() => {})));
          await ed.source.flush();
        });
        const thumb = await page.evaluate(async (key) => {
          const s = await import("/src/store/index.ts");
          const files = await s.getStoreClient().workspace.listFiles({ in: "recents" });
          return files.find((f) => f.fileKey === key)?.thumbnail ?? null;
        }, key);
        check("a thumbnail is saved for Home (at the latest when the tab flushes)", !!thumb, thumb ? JSON.stringify(thumb) : "none");
        await page.reload();
        await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
        check("a change on a store file survives a reload", !!made && (await node(page, made)) !== null, made);
        const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
        check("the file reopens where it was left", cam.zoom === 2 && cam.x === 40, JSON.stringify(cam));
      }
    }
    await context.close();
  }
  check(`no GPU validation errors on the console (${gfx === "webgpu" ? "WebGPU" : "WebGL2"})`, gpuProblems.length === 0,
    gpuProblems.length ? `${gpuProblems.length}: ${gpuProblems[0].slice(0, 300)}` : "");
  console.log(results.join("\n"));
  console.log(`\nscreenshots:\n${files.join("\n")}`);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
} catch (error) {
  console.log(results.join("\n"));
  console.error(error);
  if (problems.length) console.log(`\nconsole:\n${problems.join("\n")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server?.close();

}
