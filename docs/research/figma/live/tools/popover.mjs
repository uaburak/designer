// node popover.mjs <outDir> [case …] — opens each Design-panel popover / menu of live/popovers/ in our editor
// (`?editor&doc=capture`, 1440×900 like the live captures), dumps the open popups (dumpPopups.js) to <outDir>/<case>.txt
// with a screenshot, then compares with the live dump (compare-popups.mjs) when one exists. URL=… picks the server.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const require = createRequire(new URL("../../../../../package.json", import.meta.url));
const { chromium } = require("playwright-core");
const [outDir, ...only] = process.argv.slice(2);
const dump = readFileSync(new URL("./dumpPopups.js", import.meta.url), "utf8");
const base = process.env.URL ?? "http://localhost:5461";
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

// Steps: ["select", ids] · ["click", aria-label] (in the Design panel first) · ["clickIn", aria-label] (in the last
// popup) · ["pick", aria-label] (in the colour picker) · ["text", text] (a visible text) · ["hover", aria-label] · ["key", key] · ["doc", name] (another fixture).
const rect = ["select", ["7:60"]];
const al = ["select", ["7:20"]];
const text = ["select", ["7:90"]];
const picker = [rect, ["click", "Solid color hex: D9D9D9"]];
const stroke = [rect, ["click", "Add stroke"]];
const effect = [["eval", "localStorage.setItem('designer.effects.shaderOnboarding', 'done')"], rect, ["click", "Add effect"], ["click", "Effect settings"]];
const exportRow = [rect, ["click", "Add export settings"]];
const guide = [["select", ["7:1"]], ["click", "Add layout guide"], ["click", "Layout guide settings"]];
export const CASES = {
  // The live fill-picker captures were taken in one session in this order (their y shows it: Solid and Pattern at 347,
  // then the Image tab's 577 moved the picker up to 307 and it stayed there — a popover keeps its top when it shrinks;
  // the Shader tab's browser stayed open beside it from "custom" on). The cases replay that order.
  "fill-picker-solid": picker,
  "fill-picker-pattern": [...picker, ["clickIn", "Pattern"]],
  "fill-picker-image": [...picker, ["clickIn", "Pattern"], ["clickIn", "Image"]],
  "fill-picker-video": [...picker, ["clickIn", "Image"], ["clickIn", "Video"]],
  "fill-picker-custom": [...picker, ["clickIn", "Image"], ["clickIn", "Video"], ["clickIn", "Shader"]],
  "fill-picker-gradient_linear": [...picker, ["clickIn", "Image"], ["clickIn", "Video"], ["clickIn", "Shader"], ["pick", "Gradient"]],
  "fill-picker-gradient-type-menu": [...picker, ["clickIn", "Image"], ["clickIn", "Video"], ["clickIn", "Shader"], ["pick", "Gradient"], ["pick", "Paint type"]],
  "fill-picker-color-format-menu": [...picker, ["clickIn", "Image"], ["clickIn", "Solid"], ["clickIn", "Color format"]],
  "fill-picker-swatch-set-menu": [...picker, ["clickIn", "Image"], ["clickIn", "Solid"], ["clickIn", "Color swatch set selector"]],
  "fill-picker-libraries-tab": [...picker, ["clickIn", "Image"], ["text", "Libraries"]],
  "fill-styles-variables": [rect, ["click", "Fill, Apply styles and variables"]],
  "blend-mode-menu": [rect, ["click", "Apply blend mode"]],
  "boolean-operations-menu": [rect, ["click", "Boolean operations"]],
  "constraint-horizontal-menu": [["select", ["7:2"]], ["click", "Constraints"], ["click", "Horizontal constraints"]],
  "constraint-vertical-menu": [["select", ["7:2"]], ["click", "Constraints"], ["click", "Vertical constraints"]],
  "autolayout-advanced-settings": [al, ["click", "Auto layout settings"]],
  "width-sizing-menu": [al, ["click", "Horizontal resizing sizing"]],
  "height-sizing-menu": [al, ["click", "Vertical resizing sizing"]],
  "gap-menu": [al, ["hover", "Horizontal gap between objects"], ["click", "Gap sizing"]],
  // Round 12: the grid's settings popover (live grid/grid-autolayout-settings.txt, 240 × 249 at 960,485: level with its button)
  "grid-autolayout-settings": [["select", ["7:40"]], ["click", "Auto layout settings"]],
  "autolayout-child-width-menu": [["select", ["7:51"]], ["click", "Width sizing"]],
  "frame-presets-menu": [al, ["click", "Frame, Frame Dimension Presets"]],
  "stroke-advanced-settings": [...stroke, ["click", "Advanced stroke settings"]],
  "stroke-individual-strokes-menu": [...stroke, ["click", "Individual strokes"]],
  "stroke-position-menu": [...stroke, ["click", "Stroke align"]],
  "effect-settings-drop-shadow": effect,
  "effect-type-menu": [...effect, ["clickIn", "Effect settings"]],
  "effect-settings-inner-shadow": [...effect, ["clickIn", "Effect settings"], ["text", "Inner shadow"]],
  "effect-settings-layer-blur": [...effect, ["clickIn", "Effect settings"], ["text", "Layer blur"]],
  "effect-settings-background-blur": [...effect, ["clickIn", "Effect settings"], ["text", "Background blur"]],
  "effect-settings-noise": [...effect, ["clickIn", "Effect settings"], ["text", "Noise"]],
  "effect-settings-texture": [...effect, ["clickIn", "Effect settings"], ["text", "Texture"]],
  "effect-settings-glass": [...effect, ["clickIn", "Effect settings"], ["text", "Glass"]],
  // (Live's capture came after the stroke ones: the rect had a stroke, Effects' button at 759 — the popover's bottom at 884.)
  "effect-styles": [...stroke, ["click", "Effects, Apply styles"]],
  "export-advanced-settings": [...exportRow, ["click", "Advanced export settings"]],
  "export-format-menu": [...exportRow, ["click", "Export file type"]],
  "layout-guide-settings-grid": guide,
  "layout-guide-type-menu": [...guide, ["clickIn", "Layout guide type"]],
  "layout-guide-styles": [["select", ["7:1"]], ["click", "Layout guide, Apply styles"]],
  "font-picker": [text, ["click", "Font family"]],
  "font-picker-filter-menu": [text, ["click", "Font family"], ["click", "Font filter"]],
  "font-size-menu": [text, ["click", "Font sizes"]],
  "font-weight-menu": [text, ["click", "Font style"]],
  "type-settings": [text, ["click", "Type settings"]],
  "type-settings-details": [text, ["click", "Type settings"], ["text", "Details"]],
  "type-settings-variable": [text, ["click", "Type settings"], ["text", "Variable"]],
  "typography-styles": [text, ["click", "Typography, Apply styles"]],
  // Round 9: the header's, the component's and the instance's popovers on the capture's components (8:1 Button, 8:60
  // Button instance, 8:61 Chip instance).
  "instance-more-actions-menu": [["select", ["8:60"]], ["click", "More actions"]],
  "instance-header-swap-menu": [["select", ["8:60"]], ["eval", "document.querySelector('[data-instance-menu]').click()"]],
  "instance-swap-property-picker": [["select", ["8:60"]], ["eval", "document.querySelector('[data-swap-property=\"Icon\"]').click()"]],
  "instance-variant-dropdown": [["select", ["8:61"]], ["click", "State"]],
  "component-create-property-menu": [["select", ["8:1"]], ["click", "Create property"]],
  "component-configuration": [["select", ["8:1"]], ["click", "Component configuration"]],
  // Round 11: Create property › Slot on Card (8:50, as live), and the Effects "+" while the shader onboarding card is up.
  "component-create-slot-property": [["select", ["8:50"]], ["click", "Create property"], ["text", "Slot"]],
  "effects-add-shader-effects": [["eval", "localStorage.removeItem('designer.effects.shaderOnboarding')"], rect, ["click", "Add effect"]],
};

const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const stop = setTimeout(() => { browser.close(); process.exit(2); }, 170000);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("designer-theme", "dark"));
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  const open = async (doc) => {
    await page.goto(`${base}/?editor&doc=${doc}&theme=dark`);
    await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
    await page.waitForTimeout(600);
  };
  const panel = page.locator('[data-panel="right"]');
  const lastPopup = () => page.locator('[data-ds="Popover"], [role="menu"], [role="listbox"]').last();
  for (const [name, steps] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    await open("capture");
    let failed = null;
    for (const [op, arg] of steps) {
      try {
        if (op === "eval") await page.evaluate(arg);
        else if (op === "select") await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), arg);
        else if (op === "doc") await open(arg);
        else if (op === "click") {
          // A control before a group of the same name (the Boolean operations chevron, not its split group)
          const sel = `:is(button, input, [role="combobox"], [role="radio"], [role="tab"])[aria-label="${arg}"]`;
          const candidates = [panel.locator(sel), panel.locator(`[aria-label="${arg}"]`), page.locator(sel), page.locator(`[aria-label="${arg}"]`)];
          let target = null;
          for (const c of candidates) if (!target && (await c.count())) target = c.first();
          await (target ?? candidates[3].first()).click({ timeout: 3000, force: true });
        } else if (op === "clickIn") await lastPopup().locator(`[aria-label="${arg}"]`).first().click({ timeout: 3000, force: true });
        // In the colour picker (another popover may be open beside it)
        else if (op === "pick") await page.locator(`[aria-label="Color picker"] [aria-label="${arg}"]`).first().click({ timeout: 3000, force: true });
        else if (op === "text") await page.getByText(arg, { exact: true }).filter({ visible: true }).last().click({ timeout: 3000 });
        else if (op === "hover") await page.locator(`[aria-label="${arg}"]`).first().hover({ timeout: 3000, force: true });
        else if (op === "key") await page.keyboard.press(arg);
      } catch {
        failed = `${op} ${arg}`;
        break;
      }
      await page.waitForTimeout(250);
    }
    const text = await page.evaluate(dump);
    writeFileSync(`${outDir}/${name}.txt`, `# ${failed ? "FAILED at " + failed : "ok"}\n${text}\n`);
    await page.screenshot({ path: `${outDir}/${name}.png` });
    const live = [new URL(`../popovers/${name}.txt`, import.meta.url), new URL(`../grid/${name}.txt`, import.meta.url)].find((u) => existsSync(u)) ?? new URL(`../popovers/${name}.txt`, import.meta.url);
    let diff = "";
    if (existsSync(live)) diff = execFileSync("node", [new URL("./compare-popups.mjs", import.meta.url).pathname, live.pathname, `${outDir}/${name}.txt`], { encoding: "utf8" });
    writeFileSync(`${outDir}/${name}.diff`, diff);
    console.log(failed ? `FAIL ${name} (${failed})` : `ok   ${name}  ${diff.split("\n").filter((l) => /^(MISSING|DIFF|EXTRA)/.test(l)).length} differences`);
  }
} finally {
  clearTimeout(stop);
  await browser.close();
}
