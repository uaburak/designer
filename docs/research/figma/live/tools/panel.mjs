// node panel.mjs <doc> <outPrefix> <name>=<guid,guid> ...  — dumps + screenshots the right panel per selection.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/Users/burak/Desktop/Burak/Code/DesignerV2/.claude/worktrees/agent-ab4131d246f72417a/package.json");
const { chromium } = require("playwright-core");
const [doc, outPrefix, ...cases] = process.argv.slice(2);
const dump = readFileSync(new URL("./dumpPanel.js", import.meta.url), "utf8");
const base = process.env.URL ?? "http://localhost:5421";
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const stop = setTimeout(() => { browser.close(); process.exit(2); }, 170000);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("designer-theme", "dark"));
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`${base}/?editor&doc=${doc}&theme=dark`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  for (const c of cases) {
    const [name, ids] = c.split("=");
    await page.evaluate((ids) => window.__designerEditor.engine.setSelection(ids ? ids.split(",") : []), ids);
    await page.waitForTimeout(300);
    const text = await page.evaluate(dump);
    writeFileSync(`${outPrefix}${name}.txt`, text + "\n");
    const panel = page.locator('[data-panel="right"] [role="tabpanel"]');
    await panel.screenshot({ path: `${outPrefix}${name}.png` });
    console.log("ok", name);
  }
} finally {
  clearTimeout(stop);
  await browser.close();
}
