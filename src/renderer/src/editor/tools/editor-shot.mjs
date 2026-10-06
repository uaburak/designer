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

try {
  for (const theme of ["dark", "light"]) {
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
