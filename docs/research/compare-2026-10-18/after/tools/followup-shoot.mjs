// Follow-up 2026-10-19: before / after shots of the four items (Tools tab gone, Figma's AI-action glyphs in Actions,
// variant rows in Layers). Two web servers (`vite --config vite.web.config.ts`): BEFORE_URL (main) and AFTER_URL (this
// branch). Usage: BEFORE_URL=http://localhost:5361 AFTER_URL=http://localhost:5362 node …/followup-shoot.mjs
/* global window, document */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function open(base, theme) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  // SwiftShader: mark the hardware-acceleration bell shown (editor-shot.mjs does the same)
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`${base}/?editor&doc=capture`);
  await page.waitForFunction(() => window.__designerEditor, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await settle(page, 1200);
  return page;
}

for (const [label, base] of [["before", process.env.BEFORE_URL], ["after", process.env.AFTER_URL]]) {
  if (!base) continue;
  for (const theme of ["dark", "light"]) {
    const page = await open(base, theme);
    // 1. The rail: File, Agents, Assets, Brands (Tools gone after)
    await page.screenshot({ path: path.join(out, `followup-rail-${theme}-${label}.png`), clip: { x: 0, y: 0, width: 320, height: 330 } });
    // 2. Actions (⌘K's panel from the toolbar): the AI rows' glyphs
    await page.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" }).click();
    await settle(page, 600);
    const palette = page.locator("[data-actions-panel]");
    const b = await palette.boundingBox();
    if (b) await page.screenshot({ path: path.join(out, `followup-actions-${theme}-${label}.png`), clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 } });
    await page.keyboard.press("Escape");
    await settle(page);
    // 3. Layers: the Chip component set opened (its variants' glyph, colour and names)
    const opened = await page.evaluate(() => {
      const name = [...document.querySelectorAll("[data-layer-name]")].find((e) => e.textContent === "Chip");
      const row = name?.closest('[role="treeitem"], [data-layer-row], [id]');
      const chevron = row?.querySelector("button");
      chevron?.click();
      return !!chevron;
    });
    await settle(page, 600);
    const chip = page.locator("[data-layer-name]", { hasText: /^Chip$/ }).first();
    const cb = await chip.boundingBox();
    if (opened && cb) await page.screenshot({ path: path.join(out, `followup-layers-variants-${theme}-${label}.png`), clip: { x: 57, y: Math.max(0, cb.y - 12), width: 241, height: 140 } });
    console.log(label, theme, "chip opened", opened);
    await page.close();
  }
}
await browser.close();
