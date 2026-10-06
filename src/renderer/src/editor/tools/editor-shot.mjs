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
/* global process, console, window, requestAnimationFrame */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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
  server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, "");
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = [];
const problems = [];
const files = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

async function open(page, query) {
  await page.goto(`${base}/?editor${query}`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
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
  check("a gradient fill reads Linear", (await panel.getByRole("button", { name: "Fill: Linear" }).count()) === 1);
  await shot(page, `25-gradient-row-${theme}`);
  await panel.getByRole("button", { name: "Fill: Linear" }).click();
  await settle(page);
  const picker = page.getByRole("dialog", { name: "Color picker" });
  check("the picker opens on the gradient with its stops", (await picker.getByRole("slider", { name: "Stop 2" }).count()) === 1);
  if (capable.paintEdit) check("the gradient handles are on while the picker shows it", await page.evaluate(() => !!window.__designerEditor.engine.paintEdit));
  await shot(page, `26-gradient-picker-${theme}`);
  await picker.getByRole("radio", { name: "Radial" }).click();
  await settle(page);
  check("the picker turns it Radial", (await node(page, "2:2")).fillPaints[0].type === "GRADIENT_RADIAL");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");

  // Selection colors list a frame's gradients as rows.
  await select("2:1");
  check("Selection colors list gradients (one row each)", (await panel.getByRole("button", { name: "Selection color: Diamond" }).count()) === 1);
  await shot(page, `27-selection-colors-gradients-${theme}`);

  // Effects: the row, its settings; "+" adds Figma's drop shadow.
  await select("2:10");
  check("an effect row reads Drop shadow", (await panel.locator('[data-effect-row="DROP_SHADOW"]').count()) === 1);
  await panel.getByRole("button", { name: "Effect settings" }).click();
  await settle(page);
  const fx = page.getByRole("dialog", { name: "Drop shadow" });
  check("the effect settings: X, Y, Blur, Spread, colour, behind", (await fx.getByRole("textbox", { name: "Blur" }).count()) === 1 && (await fx.getByRole("textbox", { name: "Spread" }).count()) === 1 && (await fx.getByText("Show behind transparent areas").count()) === 1);
  await shot(page, `28-effect-settings-${theme}`);
  await page.keyboard.press("Escape");
  await select("2:11");
  await panel.getByRole("button", { name: "Add effect" }).click();
  await settle(page);
  const added = (await node(page, "2:11")).effects ?? [];
  const last = added[added.length - 1];
  check("+ adds a drop shadow 0 4 4 0 #000 25%", added.length === 2 && last.type === "DROP_SHADOW" && last.offset.y === 4 && last.radius === 4 && Math.abs(last.color.a - 0.25) < 0.01, JSON.stringify(last));
  await panel.getByRole("button", { name: "Blend mode" }).click();
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
  await panel.getByRole("button", { name: "Stroke settings" }).click();
  await settle(page);
  const ss = page.getByRole("dialog", { name: "Stroke settings" });
  check("stroke settings read the dash pattern", (await ss.getByRole("textbox", { name: "Dash" }).inputValue()) === "6" && (await ss.getByRole("textbox", { name: "Gap" }).inputValue()) === "4");
  await shot(page, `31-stroke-settings-${theme}`);
  await page.keyboard.press("Escape");
  await select("2:41");
  check("a bottom-only stroke reads Custom/Bottom", (await panel.getByRole("button", { name: "Individual strokes" }).count()) === 1);
  await panel.getByRole("button", { name: "Individual strokes" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Custom" }).click();
  await settle(page);
  check("Custom shows the four side weights", (await panel.getByRole("textbox", { name: "Top stroke" }).count()) === 1);
  await shot(page, `32-individual-strokes-${theme}`);

  // Booleans: the header's menu on two shapes; a boolean group's operation.
  await select("2:10", "2:11");
  const booleans = panel.getByRole("button", { name: "Boolean groups" });
  const menuOn = await booleans.isEnabled();
  if (menuOn) {
    await booleans.click();
    await settle(page);
  }
  await shot(page, `33-boolean-menu-${theme}`);
  const union = page.getByRole("menuitemcheckbox", { name: /Union selection/ });
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
  await panel.getByRole("button", { name: "Fill: Image" }).click();
  await settle(page);
  check("the image picker: scale mode, Choose image, Rotate 90°, adjustments", (await page.getByRole("slider", { name: "Exposure" }).count()) === 1 && (await page.getByRole("button", { name: "Rotate 90°", exact: true }).count()) === 1);
  await shot(page, `36-image-picker-${theme}`);
  await page.getByRole("button", { name: "Rotate 90°", exact: true }).click();
  check("Rotate 90° turns the image", (await page.evaluate(() => window.__designerEditor.selectedNodes()[0].fillPaints[0].rotation)) === 90);
  await page.keyboard.press("Escape");

  // Vector edit mode: the toolbar switches; Done leaves.
  if (capable.vector) {
    await select("2:20");
    await panel.getByRole("button", { name: "Edit object" }).click();
    await settle(page);
    check("vector edit mode: the vector-edit toolbar with Done", (await page.locator("[data-vector-toolbar]").count()) === 1);
    await shot(page, `37-vector-edit-${theme}`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await settle(page);
    check("Done leaves vector edit mode", (await page.locator("[data-vector-toolbar]").count()) === 0);
  } else results.push("info vector edit: the engine has no startVectorEdit yet");

  // The new tools (when the engine has them): L draws a line.
  if (capable.tools.includes("LINE")) {
    await page.locator("#engine-canvas").focus();
    await page.keyboard.press("l");
    await drag(page, await toScreen(page, 0, 460), await toScreen(page, 200, 460));
    const line = await page.evaluate(() => window.__designerEditor.selectedNodes()[0]?.type);
    check("L + drag draws a line", line === "LINE", line);
  }
}

try {
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
  for (const theme of only ? [] : ["dark", "light"]) {
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
      // Minimize UI (⇧\), hide UI (⌘\), the shortcuts (⌃⇧?).
      await page.locator("#engine-canvas").focus();
      await page.keyboard.press("Shift+Backslash");
      await shot(page, `08-minimized-${theme}`);
      check("⇧\\ minimizes the UI", await page.locator("[data-minimized]").count() === 2);
      await page.keyboard.press("Shift+Backslash");
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
      const width = panel.getByRole("textbox", { name: "Width", exact: true });
      const height = panel.getByRole("textbox", { name: "Height", exact: true });
      check("an auto-layout frame reads Fixed width and Hug height", (await width.inputValue()) === "320" && (await height.inputValue()) === "Hug", `${await width.inputValue()} × ${await height.inputValue()}`);
      await shot(page, `16-types-auto-layout-${theme}`);
      await width.hover();
      await panel.getByRole("button", { name: "Width sizing" }).click();
      const menuText = await page.getByRole("menu").innerText();
      check("the W menu: Fixed width, Hug contents, Add min/max width…", ["Fixed width", "Hug contents", "Add min width…", "Add max width…"].every((t) => menuText.includes(t)), menuText.replace(/\n/g, " | "));
      await shot(page, `17-width-menu-${theme}`);
      await page.getByRole("menuitemcheckbox", { name: "Hug contents" }).click();
      await settle(page);
      const hugged = await node(page, "1:1");
      check("Hug contents writes the frame's sizing", hugged.stackPrimarySizing !== "FIXED" && (await width.inputValue()) === "Hug", `${hugged.stackPrimarySizing}, W ${await width.inputValue()}`);
      await page.keyboard.press("Meta+z");
      await settle(page);
      await panel.getByRole("button", { name: "Advanced layout settings" }).click();
      await settle(page);
      check("the auto-layout settings open", (await page.getByRole("dialog", { name: "Auto layout settings" }).count()) === 1);
      await shot(page, `18-auto-layout-settings-${theme}`);
      await page.keyboard.press("Escape");
      await selectLayer("1:3");
      await settle(page);
      check("a Fill child reads Fill", (await width.inputValue()) === "Fill", await width.inputValue());
      check("Ignore auto layout shows for an auto-layout child", (await panel.getByRole("button", { name: "Ignore auto layout" }).count()) === 1);
      await width.hover();
      await panel.getByRole("button", { name: "Width sizing" }).click();
      await page.getByRole("menuitem", { name: "Add min width…" }).click();
      await settle(page);
      const minned = await node(page, "1:3");
      check("Add min width… adds the limit and its row", minned.minSize?.value?.x > 0 && (await panel.getByRole("textbox", { name: "Min width" }).count()) === 1, JSON.stringify(minned.minSize));
      await shot(page, `19-fill-child-min-width-${theme}`);
      await selectLayer("1:11");
      await settle(page);
      const widget = panel.locator('[data-ds-editor="ConstraintsWidget"]');
      check("Constraints show for a frame's child", (await widget.count()) === 1);
      await widget.getByRole("button", { name: "Bottom" }).click();
      await widget.getByRole("button", { name: "Top" }).click({ modifiers: ["Shift"] });
      const pinned = await node(page, "1:11");
      check("the widget writes constraints (⇧ for both)", pinned.verticalConstraint === "STRETCH", pinned.verticalConstraint);
      await shot(page, `20-constraints-${theme}`);
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
      await page.keyboard.press("Escape");
      const up = await selection(page);
      await page.keyboard.press("Escape");
      check("Esc selects the parent, then nothing", up.join() === frameId && (await selection(page)).length === 0, `${up.join()} → ${(await selection(page)).join() || "nothing"}`);
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
      const x = page.getByRole("textbox", { name: "X", exact: true });
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
        // The camera is kept per file (UI state, debounced 2 s); the thumbnail a few seconds after the last change.
        await page.evaluate(() => window.__designerEditor.engine.setCamera({ x: 40, y: 30, zoom: 2 }));
        await page.waitForTimeout(5000);
        const thumb = await page.evaluate(async (key) => {
          const s = await import("/src/store/index.ts");
          const files = await s.getStoreClient().workspace.listFiles({ in: "recents" });
          return files.find((f) => f.fileKey === key)?.thumbnail ?? null;
        }, key);
        check("a thumbnail is saved for Home", !!thumb, thumb ? JSON.stringify(thumb) : "none");
        await page.reload();
        await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
        check("a change on a store file survives a reload", !!made && (await node(page, made)) !== null, made);
        const cam = await page.evaluate(() => window.__designerEditor.engine.getCamera());
        check("the file reopens where it was left", cam.zoom === 2 && cam.x === 40, JSON.stringify(cam));
      }
    }
    await context.close();
  }
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
