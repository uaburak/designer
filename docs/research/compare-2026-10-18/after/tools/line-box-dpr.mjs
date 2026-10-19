// Follow-up 2026-10-19 (STATUS Group 3 item 15 / A G4): an inline text box's height (a text node's range rect, as
// figma-dump.js reads it) for the UI faces at 1×, at Playwright's emulated 2× and on a real 2× screen. Figma's live
// dumps were taken on the owner's Retina display; the comparison measured Wecra headless at 1×.
// Usage: node docs/research/compare-2026-10-18/after/tools/line-box-dpr.mjs
//        (FIGMA_INTER=<Figma.app's app.asar /assets/Inter.var.woff2, extracted> adds Figma desktop's own face)
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const faces = {
  "Inter Variable (UI, @fontsource-variable/inter)": path.join(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  "Inter 3.19 (static)": path.join(root, "src/renderer/src/engine/fonts/Inter-3.19.ttf"),
};
if (process.env.FIGMA_INTER) faces["Figma desktop's Inter.var.woff2"] = process.env.FIGMA_INTER;
const sizes = [9, 10, 11, 12, 13, 15, 16];
const live = { 9: 11, 10: 12, 11: 13, 12: 15, 13: 16, 15: 18, 16: 20 };
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 1×; Playwright's emulated 2× (deviceScaleFactor); a real 2× screen (--force-device-scale-factor=2: Chrome lays the
// page out in device pixels — zoom for DSF —, as on a Retina Mac, so the font's metrics are rounded at 22 px for 11).
const runs = [
  { label: "1x", args: [], dpr: 1 },
  { label: "2x emulated", args: [], dpr: 2 },
  { label: "2x screen", args: ["--force-device-scale-factor=2"], dpr: 0 },
];
for (const run of runs) {
  const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, args: run.args });
  for (const [name, file] of Object.entries(faces)) {
    const fmt = file.endsWith(".ttf") ? "truetype" : "woff2";
    const url = `data:font/${fmt};base64,${readFileSync(file).toString("base64")}`;
    const page = await browser.newPage(run.dpr ? { deviceScaleFactor: run.dpr, viewport: { width: 400, height: 400 } } : { viewport: { width: 400, height: 400 } });
    await page.setContent(`<style>@font-face{font-family:F;src:url(${url}) format("${fmt}");font-weight:100 900}body{font-family:F}</style>` + sizes.map((s) => `<div><span style="font-size:${s}px;font-weight:450">Agw Layers</span></div>`).join(""));
    await page.evaluate(() => document.fonts.ready);
    const h = await page.evaluate(() =>
      [...document.querySelectorAll("span")].map((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return r.getBoundingClientRect().height;
      })
    );
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const row = sizes.map((s, i) => `${s}→${h[i]}${Math.round(h[i]) === live[s] ? "" : ` (live ${live[s]})`}`).join("  ");
    console.log(`${name} ${run.label} (devicePixelRatio ${dpr}): ${row}`);
    await page.close();
  }
  await browser.close();
}
