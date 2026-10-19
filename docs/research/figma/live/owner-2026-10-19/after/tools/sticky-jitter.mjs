// 2026-10-20: the Layers panel's pinned top-level row while the list scrolls (the owner: "it jitters slightly").
// A long nested tree (a frame with 400 layers, then another frame); the list is scrolled 3 px a frame for 240
// frames, and in each frame — right after the scroll, before anything else runs — the pinned row's offset from the
// list's top edge is read. Rock-steady = 0 every frame while inside the block (the pinned row where the browser
// draws it in the same frame as the scroll); the old row, moved from a React render after the scroll event, sits a
// frame late (−3). Then the push-up by the next top-level row: its offset must follow that row exactly.
// Two web servers (`vite --config vite.web.config.ts`): BEFORE_URL (main) and AFTER_URL (this branch).
// Usage: BEFORE_URL=http://localhost:5371 AFTER_URL=http://localhost:5372 node …/sticky-jitter.mjs
/* global window, document, requestAnimationFrame */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const fill = [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }];
const N = 400;

function nodes() {
  const n = [
    { guid: "8:1", phase: "CREATED", type: "FRAME", name: "Long frame", parentIndex: { guid: "0:1", position: "~" }, size: { x: 400, y: 400 }, transform: at(0, 0), fillPaints: fill },
    { guid: "8:2", phase: "CREATED", type: "FRAME", name: "Next frame", parentIndex: { guid: "0:1", position: "!" }, size: { x: 100, y: 100 }, transform: at(500, 0), fillPaints: fill },
  ];
  // More top-level frames after it, so the list scrolls past the push-up.
  for (let i = 0; i < 30; i++) n.push({ guid: `8:${10 + i}`, phase: "CREATED", type: "FRAME", name: `Frame ${i}`, parentIndex: { guid: "0:1", position: `!${String(i).padStart(2, "0")}` }, size: { x: 50, y: 50 }, transform: at(700, i * 60), fillPaints: fill });
  // Positions in descending paint order so the panel lists them 0 … N-1 under the frame.
  for (let i = 0; i < N; i++) n.push({ guid: `8:${100 + i}`, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: `Layer ${i}`, parentIndex: { guid: "8:1", position: String(100000 + N - i) }, size: { x: 10, y: 10 }, transform: at((i % 20) * 20, Math.floor(i / 20) * 20), fillPaints: fill });
  return n;
}

const lines = [];
for (const [label, base] of [["before", process.env.BEFORE_URL], ["after", process.env.AFTER_URL]]) {
  if (!base) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  await page.goto(`${base}/?editor&doc=empty`);
  await page.waitForFunction(() => window.__designerEditor, null, { timeout: 60000 });
  await settle(page, 1200);
  await page.evaluate((changes) => {
    const ed = window.__designerEditor;
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: changes });
    ed.engine.setSelection([]);
    ed.ui.set({ expanded: new Set(["8:1"]) });
  }, nodes());
  await settle(page, 1000);
  const result = await page.evaluate(
    ({ frames }) =>
      new Promise((resolve) => {
        const v = document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement;
        v.scrollTop = 0;
        const offsets = [];
        let f = 0;
        const step = () => {
          v.scrollTop += 3;
          // The pinned row as this frame lays it out (no React render has run since the scroll).
          const row = [...document.querySelectorAll('[data-sticky-row] [data-ds="LayerRow"]')].find((r) => r.dataset.id === "8:1");
          offsets.push(row ? Math.round((row.getBoundingClientRect().top - v.getBoundingClientRect().top) * 100) / 100 : null);
          if (++f < frames) requestAnimationFrame(step);
          else resolve(offsets);
        };
        requestAnimationFrame(step);
      }),
    { frames: 240 },
  );
  // Inside the block (scrollTop 3 … 720): the row must sit at the top.
  const inside = result.filter((o) => o !== null);
  const jitter = inside.length ? Math.max(...inside.map((o) => Math.abs(o))) : NaN;
  const missing = result.length - inside.length;
  // The push-up: scrolled so the next top-level row arrives (its row at the bottom of the block).
  const push = await page.evaluate(
    ({ n }) =>
      new Promise((resolve) => {
        const v = document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement;
        const pitch = 32;
        const nextTop = (n + 1) * pitch; // the next top-level row: after the block's header and its n rows
        const out = [];
        let s = nextTop - pitch - 12;
        const step = () => {
          v.scrollTop = s;
          const row = [...document.querySelectorAll('[data-sticky-row] [data-ds="LayerRow"]')].find((r) => r.dataset.id === "8:1");
          const got = row ? row.getBoundingClientRect().top - v.getBoundingClientRect().top : null;
          const want = Math.min(0, nextTop - pitch - v.scrollTop);
          out.push([v.scrollTop, got === null ? null : Math.round(got * 100) / 100, want]);
          s += 3;
          if (s < nextTop + 6) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
    { n: N },
  );
  const pushErr = Math.max(...push.filter(([, got, want]) => got !== null && want > -32).map(([, got, want]) => Math.abs(got - want)));
  lines.push(`${label}: ${result.length} frames scrolled 3 px each inside the block — pinned row offset from the list top: max |offset| ${jitter} px, frames without the row ${missing}; offsets ${JSON.stringify(result.slice(0, 24))}…`);
  lines.push(`${label}: push-up by the next top-level row — max |offset − expected| ${pushErr} px; [scrollTop, offset, expected] ${JSON.stringify(push)}`);
  const b = await page.locator("[data-layer-list]").boundingBox();
  await page.evaluate(() => {
    document.querySelector('[data-layer-list] [data-ds="VirtualList"]').parentElement.scrollTop = 500;
  });
  await settle(page, 300);
  if (b) await page.screenshot({ path: path.join(out, `layers-sticky-${label}.png`), clip: { x: b.x, y: b.y, width: Math.min(260, b.width), height: 200 } });
  await page.close();
}
await browser.close();
const text = `Layers pinned row — sticky-jitter.mjs, 2026-10-20\n${lines.join("\n")}\n`;
writeFileSync(path.join(out, "layers-sticky-jitter.txt"), text);
console.log(text.slice(0, 2000));
