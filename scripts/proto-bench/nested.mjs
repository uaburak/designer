// Nested interactive components in the built app (docs/engine.md §3.4 "nested interactive components"): the owner's
// "finder" (AnexEUI – B2C) in the inline preview — a click at each level (Segment-control-finder's segments change
// finder-segmented, adv-banner its slide, a second finder-segmented on its own), a hover on search-input's "People" —
// with every instance's variant dumped after each step and the preview's canvas saved (SCREENSHOT_DIR).
//   UD=<copy of the user data> node scripts/proto-bench/nested.mjs
import * as path from "node:path";
import { launch, openFile, close, sleep, SCR } from "./lib.mjs";

const FILE = process.env.FILE || "ArJehBxaYI0GGp8ZAmSQBC";
const PAGE = process.env.PAGE || "15013:12562";
const FRAME = process.env.FRAME || "17672:27133";
const ROOTS = ["17672:27052", "6291477:2"]; // homesearch, the second finder-segmented
// Frame coordinates of the layers in the app (with its fonts; the native replay, without them, lays search-input out narrower).
const STEPS = [
  ["click", "Hotel (Segment-control-finder in homesearch)", 528, 368],
  ["click", "adv-banner", 720, 292],
  ["click", "Cruise", 606, 364],
  ["click", "Flight", 684, 364],
  ["hover", "People (search-input)", 968, 428],
  ["hover", "off People, still on homesearch", 300, 200],
  ["click", "Weather (the second finder-segmented)", 873, 522],
];

const pv = "__designerPreview";
let page;
const at = (x, y) =>
  page.evaluate(
    ([g, x, y]) => {
      const pe = window[g];
      const st = pe.presentState();
      const c = document.getElementById("preview-canvas").getBoundingClientRect();
      const sr = st.screenRect;
      const w = pe.readNode(st.screen, { fields: ["size"] })?.size?.x ?? 1440;
      const k = sr.w / w;
      return { x: c.left + sr.x + x * k, y: c.top + sr.y + y * k };
    },
    [pv, x, y],
  );
const mains = () =>
  page.evaluate(
    ([g, roots]) => {
      const pe = window[g];
      const out = [];
      const walk = (id, d) => {
        const n = pe.readNode(id, { childIds: true, fields: ["type", "name"] });
        if (!n) return;
        if (n.type === "INSTANCE" && !/Icon|Iconset/.test(n.name)) out.push(`${"  ".repeat(d)}${n.name} = ${pe.componentInfo(id)?.main?.name}`);
        for (const c of n.childIds ?? []) walk(c, d + 1);
      };
      for (const r of roots) walk(r, 0);
      return out.join("\n");
    },
    [pv, ROOTS],
  );

try {
  await launch();
  await sleep(1000);
  ({ page } = await openFile(FILE));
  await page.evaluate((p) => window.__designerEditor.engine.setCurrentPage(p), PAGE);
  await sleep(1500);
  await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), FRAME);
  await page.evaluate(() => window.__designerEditor.focusCanvas());
  await sleep(300);
  await page.keyboard.press("Shift+Space");
  await page.waitForFunction(() => window.__designerPreview?.presentState().screen && !document.querySelector("[data-inline-preview][data-closed]"), null, { timeout: 30000 });
  await sleep(1500);
  console.log(`---- start\n${await mains()}`);
  await page.locator("#preview-canvas").screenshot({ path: path.join(SCR, "nested-0-start.png") });
  let k = 1;
  for (const [kind, label, x, y] of STEPS) {
    const p = await at(x, y);
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(p.x - (6 - i) * 4, p.y);
      await sleep(10);
    }
    await sleep(400);
    if (kind === "click") {
      await page.mouse.down();
      await page.mouse.up();
    }
    await sleep(900);
    console.log(`---- ${kind} ${label}\n${await mains()}`);
    await page.locator("#preview-canvas").screenshot({ path: path.join(SCR, `nested-${k++}-${label.split(" ")[0]}.png`) });
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await close();
}
