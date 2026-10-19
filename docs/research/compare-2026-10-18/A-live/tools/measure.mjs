// Dumps Wecra's Design panel / open popups with the live capture's own dump scripts (docs/research/figma/live/tools)
// in the states of group A's captures, at 1440 × 900 dark with Additional labels on, and diffs them against live's
// dumps with its compare scripts. Writes $WORK/measure/<state>.{txt,diff}. Throwaway.
/* global window, localStorage, requestAnimationFrame, navigator */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BASE, LIVE, launch, work } from "./lib.mjs";

const tools = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../figma/live/tools");
const out = path.join(work, "measure");
mkdirSync(out, { recursive: true });
const dumpPanel = readFileSync(path.join(tools, "dumpPanel.js"), "utf8");
const dumpPopups = readFileSync(path.join(tools, "dumpPopups.js"), "utf8");
const settle = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function openEd(p, q = "&doc=capture") {
  await p.addInitScript(() => { try { localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1"); } catch { /* */ } });
  await p.goto(`${BASE}/?editor${q}`);
  await p.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
  await p.evaluate(() => window.__designerEditor.ui.set({ propertyLabels: true, railLabels: true }));
  await settle(p); await wait(300);
}
const sel = async (p, ids) => { await p.evaluate((ids) => window.__designerEditor.engine.setSelection(ids), ids); await settle(p); await wait(250); };
const cam = (p, dx, dy, px, py, z) => p.evaluate(([dx, dy, px, py, z]) => { const e = window.__designerEditor; const r = e.canvas.getBoundingClientRect(); e.engine.setCamera({ x: px - r.left - dx * z, y: py - r.top - dy * z, zoom: z }); }, [dx, dy, px, py, z]);
const toPage = (p, x, y) => p.evaluate(([x, y]) => { const e = window.__designerEditor; const c = e.engine.getCamera(); const r = e.canvas.getBoundingClientRect(); return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y]; }, [x, y]);

const states = [
  ["panel-autolayout-grid", "design/autolayout-grid.txt", "panel", async (p) => { await openEd(p); await sel(p, ["7:40"]); }],
  ["panel-grid-child", "design/grid-child.txt", "panel", async (p) => { await openEd(p); await sel(p, ["7:44"]); }],
  ["panel-page-nothing-selected", "design/page-nothing-selected.txt", "panel", async (p) => { await openEd(p); await sel(p, []); }],
  ["panel-vector-edit-mode", "design/vector-edit-mode.txt", "panel", async (p) => {
    await openEd(p); await cam(p, 900, 300, 628, 315, 3); await sel(p, ["7:66"]);
    const [x, y] = await toPage(p, 940, 335); await p.mouse.dblclick(x, y); await p.mouse.move(1100, 700); await settle(p); await wait(300);
  }],
  ["popup-shape-tools-menu", "toolbar/shape-tools-menu.txt", "popup", async (p) => { await openEd(p); await sel(p, []); await p.getByRole("button", { name: "Shape tools" }).click(); await settle(p); await wait(300); }],
  ["popup-actions-panel", "toolbar/actions-panel.txt", "popup", async (p) => { await openEd(p); await sel(p, []); await p.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" }).click(); await settle(p); await wait(400); }],
  ["popup-main-view", "menus/main-view.txt", "popup", async (p) => {
    await openEd(p); await p.getByRole("button", { name: "Main menu" }).click(); await settle(p);
    await p.getByRole("menuitem", { name: "View", exact: true }).hover(); await wait(500);
  }],
  ["popup-row-track-menu", "grid/row-track-menu.txt", "popup", async (p) => {
    await openEd(p); await cam(p, 900, 0, 492.1, 289.4, 1.6); await sel(p, ["7:40"]);
    const [x0, y] = await toPage(p, 900, 146);
    await p.mouse.move(x0 + 100, y); await p.mouse.move(x0 - 52.75, y, { steps: 4 }); await p.mouse.click(x0 - 52.75, y); await settle(p); await wait(300);
    await p.mouse.click(x0 - 33.75, y); await settle(p); await wait(300);
  }],
  ["panel-row-track-selected", "grid/row-track-selected-panel.txt", "popup-panel", async (p) => {
    await openEd(p); await cam(p, 900, 0, 492.1, 289.4, 1.6); await sel(p, ["7:40"]);
    const [x0, y] = await toPage(p, 900, 146);
    await p.mouse.move(x0 + 100, y); await p.mouse.move(x0 - 52.75, y, { steps: 4 }); await p.mouse.click(x0 - 52.75, y); await settle(p); await wait(300);
  }],
  ["popup-find-filter-menu", "left/find-filter-menu.txt", "popup", async (p) => {
    await openEd(p); await sel(p, ["7:44"]);
    await p.locator('[data-panel="left"]').getByRole("button", { name: "Find" }).first().click(); await p.keyboard.type("AL_"); await settle(p); await wait(300);
    const f = p.locator('[data-panel="left"]').getByRole("button", { name: "Settings", exact: true }).first(); if (await f.count()) await f.click();
    await settle(p); await wait(300);
  }],
  ["popup-grid-dimensions-picker", "grid/grid-dimensions-picker.txt", "popup", async (p) => {
    await openEd(p); await sel(p, ["7:40"]);
    await p.locator('[data-panel="right"]').getByRole("button", { name: /^Open grid dimensions picker/ }).click(); await settle(p); await wait(300);
  }],
  ["popup-context-component", "menus/context-component.txt", "popup", async (p) => {
    await openEd(p); await cam(p, 100, 600, 700, 400, 2); await sel(p, ["8:1"]);
    const [x, y] = await toPage(p, 104, 604); await p.mouse.click(x, y, { button: "right" }); await settle(p); await wait(400);
  }],
  ["popup-context-multi", "menus/context-multi.txt", "popup", async (p) => {
    await openEd(p); await cam(p, 0, 300, 500, 300, 1.5); await sel(p, ["7:60", "7:61", "7:62"]);
    const [x, y] = await toPage(p, 60, 345); await p.mouse.click(x, y, { button: "right" }); await settle(p); await wait(400);
  }],
];

const browser = await launch();
try {
  for (const [name, liveRel, kind, run] of states) {
    if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) continue;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, "keyboard", { configurable: true, value: { getLayoutMap: async () => new Map() } }); });
    const p = await ctx.newPage();
    try {
      await run(p);
      const text = kind === "panel" ? `RIGHT\n${await p.evaluate(dumpPanel)}` : `POPUPS\n${await p.evaluate(dumpPopups)}`;
      const ours = path.join(out, `${name}.txt`);
      writeFileSync(ours, text + "\n");
      const script = kind === "panel" ? "compare.mjs" : "compare-popups.mjs";
      let diff;
      try { diff = execFileSync("node", [path.join(tools, script), path.join(LIVE, liveRel), ours], { encoding: "utf8" }); } catch (e) { diff = String(e.stdout ?? e); }
      writeFileSync(path.join(out, `${name}.diff`), diff);
      console.log("ok", name, diff.split("\n").length, "lines");
    } catch (e) {
      console.log("FAIL", name, String(e).slice(0, 200));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
