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
/* global process, console, window, document, navigator, requestAnimationFrame */
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
    // In screen space near the canvas's top left: the fitted content can reach under the toolbar.
    const area = await page.locator("#engine-canvas").boundingBox();
    await drag(page, [area.x + 60, area.y + 60], [area.x + 260, area.y + 60]);
    const line = await page.evaluate(() => window.__designerEditor.selectedNodes()[0]?.type);
    check("L + drag draws a line", line === "LINE", line);
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
  check("the instance panel: header, Boolean, Text, Instance swap, the exposed nested instance", (await panel.getByRole("button", { name: "Instance menu: Button" }).count()) === 1 && (await panel.getByRole("switch", { name: "Show icon" }).count()) === 1 && (await panel.getByRole("textbox", { name: "Label" }).inputValue()) === "Sign in" && (await panel.locator('[data-nested-instance]').count()) === 1);
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

  // The instance menu (swap), the ⋯ menu with Reset ▸.
  await panel.getByRole("button", { name: "Instance menu: Button" }).click();
  await settle(page);
  check("the instance menu lists the file's components by page and frame", (await page.locator("[data-component-picker]").getByRole("menuitemradio").count()) >= 4);
  await shot(page, `39-instance-menu-${theme}`);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reset" }).hover();
  await page.waitForTimeout(400);
  const resetText = await page.getByRole("menu").last().innerText();
  check("⋯ › Reset lists Reset all changes and the changed properties", resetText.includes("Reset all changes") && resetText.includes("Reset fill"), resetText.replace(/\n/g, " | "));
  await shot(page, `40-instance-more-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await select("2:2");

  // An Instance swap property: its picker (preferred first).
  await panel.getByRole("button", { name: /^Icon: / }).click();
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

  // Reset all changes (⋯) on the button.
  await select("2:2");
  await panel.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reset" }).hover();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: "Reset all changes" }).click();
  await settle(page);
  const reset = await node(page, "2:2");
  check("Reset all changes clears the overrides and the values", (reset.symbolData?.symbolOverrides ?? []).length === 0 && (reset.componentPropAssignments ?? []).length === 0, JSON.stringify({ o: reset.symbolData?.symbolOverrides, a: reset.componentPropAssignments }));
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
  check("a main component shows Properties with its three", (await panel.locator("[data-component-properties]").getByRole("button", { name: /^Edit property / }).count()) === 3);
  await panel.getByRole("button", { name: "Edit property Icon" }).click();
  await settle(page);
  check("an Instance swap property's settings list its preferred values", (await page.locator('[data-property-editor="INSTANCE_SWAP"]').getByText("Preferred values").count()) === 1);
  await shot(page, `45-property-settings-${theme}`);
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Create component property" }).click();
  await settle(page);
  await shot(page, `46-add-property-menu-${theme}`);
  await page.getByRole("menuitem", { name: "Boolean" }).click();
  await settle(page);
  await page.locator('[data-property-editor="BOOL"]').getByRole("textbox", { name: "Name" }).fill("Disabled");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Create property" }).click();
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
  check("a component set shows its variant properties", (await panel.getByRole("button", { name: "Edit property State" }).count()) === 1);
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
  check("⌥2 opens Assets with the file's components", (await page.locator("[data-asset]").count()) === 4, String(await page.locator("[data-asset]").count()));
  await shot(page, `50-assets-list-${theme}`);
  await page.getByRole("button", { name: "Show as grid" }).click();
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
  check("nothing selected: Local variables and the Styles list (Text, Color, Effect, Layout guide)", (await panel.locator("[data-open-variables]").count()) === 1 && (await panel.locator("[data-style-item]").count()) === 9);
  await shot(page, `53-styles-list-${theme}`);

  // The Local variables window: collections, groups, a column per mode, aliases.
  await panel.locator("[data-open-variables]").click();
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
  await win.locator('[data-name-cell="bg/primary"]').getByRole("button", { name: "Edit variable" }).click();
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
  await win.getByRole("button", { name: "Close" }).click();
  await settle(page);
  check("× closes the window", (await win.count()) === 0);

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

  // ---- Assets: the libraries' sections with their thumbnails; a click inserts an instance of the Button.
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
  await panel.locator('[data-export-row="2"]').getByRole("combobox", { name: "File format" }).click().catch(() => {});
  await page.getByRole("option", { name: "SVG" }).click().catch(() => {});
  await settle(page);
  const third = await page.evaluate(() => window.__designerEditor.engine.readNode("1:1").exportSettings[2]);
  check("Export: the format menu makes it SVG (1x, suffix kept)", third?.imageType === "SVG" && third.suffix === "@3x", JSON.stringify(third));
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, `90-export-section-${theme}`);
  // The "…" settings: Suffix and the format's options.
  await panel.locator('[data-export-row="2"]').getByRole("button", { name: "Export settings", exact: true }).click();
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
  check("the options with a device: Responsive / Fixed size, Show device frame", (await page.getByRole("menuitemcheckbox", { name: "Fixed size" }).count()) === 1 && (await page.getByRole("menuitemcheckbox", { name: "Show device frame" }).count()) === 1);
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

  // The prototype tab's own route on a store file (Figma's Present opens a new tab): read-only, from the store.
  const fileKey = await page.evaluate(async (repo) => {
    const s = await import("/src/store/index.ts");
    const { encodeMessage } = await import(`/@fs${repo}/src/shared/schema/codec.ts`);
    const { PROTOTYPE_DOCUMENT } = await import("/src/editor/fixtures.ts");
    const mem = await s.getDevStore().ready;
    return (await mem.addFile({ name: "Prototype file", folderId: null, snapshot: encodeMessage(s.messageToKiwi(PROTOTYPE_DOCUMENT)) })).fileKey;
  }, repo);
  await page.goto(`${base}/?present&file=${fileKey}`);
  await page.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().active, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  s = await state();
  check("?present&file= plays the store's file (read-only) at its flow", s.screen === "2:1" && s.flowName === "Onboarding", JSON.stringify(s));
  await shot(page, `104-present-route-${theme}`);
}

try {
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
  if (only === "export" || !only) {
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
