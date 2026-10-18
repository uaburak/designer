// Shoots Wecra in the states of the live Figma captures (group A). Throwaway; not product code.
//   WECRA_URL=http://localhost:5210 node shoot.mjs [case-name-filter]
// Writes $WORK/wecra/<case>.png and $WORK/wecra/results.json (what was done / failed per case).
/* global window, document, localStorage, requestAnimationFrame */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BASE, launch, work } from "./lib.mjs";

const out = path.join(work, "wecra");
mkdirSync(out, { recursive: true });
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const resultsFile = path.join(out, "results.json");
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : {};

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openEd(page, query = "&doc=capture") {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      /* none */
    }
  });
  await page.goto(`${BASE}/?editor${query}`);
  await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 30000 });
  await page.evaluate(() => window.__designerEditor.ui.set({ propertyLabels: true, railLabels: true }));
  await settle(page);
  await wait(300);
}
const ed = (page, fn, arg) => page.evaluate(fn, arg);
const apply = (page, changes) => ed(page, (c) => window.__designerEditor.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: c }), changes);
const sel = async (page, ids) => {
  await ed(page, (ids) => window.__designerEditor.engine.setSelection(ids), ids);
  await settle(page);
};
const hideUI = async (page) => {
  await ed(page, () => window.__designerEditor.ui.set({ uiHidden: true }));
  await settle(page);
  await wait(200);
};
/** Camera so that doc (dx, dy) lands at page (px, py) with `zoom`. */
const cam = async (page, dx, dy, px, py, zoom) => {
  await ed(page, ([dx, dy, px, py, zoom]) => {
    const e = window.__designerEditor;
    const r = e.canvas.getBoundingClientRect();
    e.engine.setCamera({ x: px - r.left - dx * zoom, y: py - r.top - dy * zoom, zoom });
  }, [dx, dy, px, py, zoom]);
  await settle(page);
};
/** Image-space placement: node's doc top-left (dx, dy) of doc width dw at image px (ix, iy, iw), device scale s. */
const place = (page, s, dx, dy, dw, ix, iy, iw) => cam(page, dx, dy, ix / s, iy / s, iw / s / dw);
const toPage = (page, x, y) =>
  ed(page, ([x, y]) => {
    const e = window.__designerEditor;
    const c = e.engine.getCamera();
    const r = e.canvas.getBoundingClientRect();
    return [r.left + x * c.zoom + c.x, r.top + y * c.zoom + c.y];
  }, [x, y]);
const hover = async (page, x, y) => {
  const [px, py] = await toPage(page, x, y);
  await page.mouse.move(px - 30, py - 30);
  await page.mouse.move(px, py, { steps: 4 });
  await settle(page);
  await wait(250);
  return [px, py];
};
const away = async (page) => {
  await page.mouse.move(2, 2);
  await settle(page);
};
const shotFull = async (page, name) => {
  await settle(page);
  await wait(150);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const shotClip = async (page, name, clip) => {
  await settle(page);
  await wait(150);
  await page.screenshot({ path: path.join(out, `${name}.png`), clip });
};
const hex = (v, a = 1) => ({ r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a });
const fill = (v, a = 1) => [{ type: "SOLID", color: hex(v), opacity: a, visible: true, blendMode: "NORMAL" }];
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const rect = (guid, name, parent, pos, x, y, w, h, color, more = {}) => ({ guid, phase: "CREATED", type: "RECTANGLE", name, parentIndex: { guid: parent, position: pos }, size: { x: w, y: h }, transform: at(x, y), fillPaints: fill(color), ...more });
const addPage = (guid, name, pos, bg = 0x1e1e1e) => ({ guid, phase: "CREATED", type: "CANVAS", name, parentIndex: { guid: "0:0", position: pos }, backgroundColor: hex(bg), backgroundEnabled: true });
const pageBg = (guid, bg) => ({ guid, phase: "CHANGED", backgroundColor: hex(bg), backgroundEnabled: true });
// Live's file had Page 1, Capture, Page 3 (and Behaviour for the behaviour pass).
const PAGE3 = [addPage("0:9", "Page 3", "~0")];

/** The behaviour page: S1–S3, X1, X2, AL, Parent, Txt, SmallFrame, Ln (docs/research/figma/live/behaviour/*.md, positions from the captures). */
function behaviourPage() {
  const P = "0:20";
  return [
    addPage("0:9", "Page 3", "~0"),
    addPage(P, "Behaviour", "~1"),
    { guid: "20:1", phase: "CREATED", type: "FRAME", name: "Parent", parentIndex: { guid: P, position: "!" }, size: { x: 400, y: 300 }, transform: at(0, 0), fillPaints: fill(0xffffff), frameMaskDisabled: false },
    rect("20:2", "A", "20:1", "!", 20, 20, 60, 40, 0xd9d9d9),
    rect("20:3", "B_hidden", "20:1", '"', 120, 20, 60, 40, 0xd9d9d9, { visible: false }),
    rect("20:4", "C_locked", "20:1", "#", 220, 20, 60, 40, 0xd9d9d9, { locked: true }),
    rect("20:5", "D", "20:1", "$", 20, 120, 60, 40, 0xd9d9d9),
    { guid: "20:6", phase: "CREATED", type: "FRAME", name: "Inner", parentIndex: { guid: "20:1", position: "%" }, size: { x: 160, y: 100 }, transform: at(180, 140), fillPaints: fill(0xffffff), strokePaints: fill(0x000000), strokeWeight: 1 },
    rect("20:7", "E", "20:6", "!", 20, 20, 60, 40, 0xd9d9d9),
    { guid: "20:8", phase: "CREATED", type: "TEXT", name: "Txt", parentIndex: { guid: P, position: '"' }, size: { x: 120, y: 39 }, transform: at(0, 360), fillPaints: fill(0xffffff), textData: { characters: "Edit me" }, fontName: { family: "Inter", style: "Regular", postscript: "" }, fontSize: 32, textAutoResize: "WIDTH_AND_HEIGHT" },
    rect("20:11", "S1", P, "#", 500, 0, 60, 60, 0x808080),
    rect("20:12", "S2", P, "$", 580, 0, 60, 60, 0x808080),
    rect("20:13", "S3", P, "%", 660, 0, 60, 60, 0x808080),
    rect("20:14", "X1", P, "&", 500, 141, 60, 40, 0xd98080),
    rect("20:15", "X2", P, "'", 620, 170, 60, 40, 0x8080e0, { locked: true }),
    { guid: "20:16", phase: "CREATED", type: "FRAME", name: "AL", parentIndex: { guid: P, position: "(" }, size: { x: 184, y: 64 }, transform: at(500, 261), fillPaints: fill(0xd9d9d9), stackMode: "HORIZONTAL", stackSpacing: 20, stackHorizontalPadding: 12, stackVerticalPadding: 12, stackPaddingRight: 12, stackPaddingBottom: 12, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" },
    rect("20:17", "AL1", "20:16", "!", 12, 12, 40, 40, 0xb07a45),
    rect("20:18", "AL2", "20:16", '"', 72, 12, 40, 40, 0xb07a45),
    rect("20:19", "AL3", "20:16", "#", 132, 12, 40, 40, 0xb07a45),
    { guid: "20:20", phase: "CREATED", type: "FRAME", name: "SmallFrame", parentIndex: { guid: P, position: ")" }, size: { x: 100, y: 100 }, transform: at(900, 300), fillPaints: fill(0xffffff), frameMaskDisabled: false },
    { guid: "20:21", phase: "CREATED", type: "LINE", name: "Ln", parentIndex: { guid: P, position: "*" }, size: { x: 200, y: 0 }, transform: at(935, 99), strokePaints: fill(0xffffff), strokeWeight: 1 },
  ];
}
async function openBehaviour(page) {
  await openEd(page);
  await apply(page, behaviourPage());
  await ed(page, () => window.__designerEditor.store.setPage?.("0:20") ?? window.__designerEditor.engine.setCurrentPage?.("0:20"));
  await settle(page);
  await wait(300);
  const cur = await ed(page, () => window.__designerEditor.store.page);
  if (cur !== "0:20") {
    await page.locator('[data-ds="PageRow"]', { hasText: "Behaviour" }).first().click();
    await settle(page);
  }
}

// ---------------------------------------------------------------------------------------------------------------
const cases = [];
const add = (name, opts, run) => cases.push({ name, ...opts, run });
const W = (s, w, h) => ({ viewport: { width: Math.round(w / s), height: Math.round(h / s) }, dpr: s });

// ---- canvas-* (UI hidden, the pane's natural size, zoomed in) ----
add("canvas-arrow-line-selected", W(1, 480, 201), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1, 740, 350, 120, 67, 96, 344); await sel(p, ["7:65"]); await away(p);
});
add("canvas-autolayout-child-selected", W(1.47, 640, 441), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.47, 506, 16, 60, 232, 156, 174); await sel(p, ["7:22"]); await away(p);
});
add("canvas-autolayout-selected-hover-gap", W(1.53, 640, 361), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.53, 420, 0, 232, 51, 91, 538); await sel(p, ["7:20"]); await hover(p, 420 + 81, 36);
});
add("canvas-autolayout-selected-hover-padding", W(1.53, 640, 361), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.53, 420, 0, 232, 51, 91, 538); await sel(p, ["7:20"]); await hover(p, 420 + 116, 7);
});
add("canvas-hover-outline-nothing-selected", W(1.53, 640, 361), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.53, 420, 0, 232, 51, 91, 538); await sel(p, []); await hover(p, 420 + 116, 36);
});
add("canvas-component-set-selected", W(1.15, 720, 406), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.15, 300, 600, 364, 47, 163, 624); await sel(p, ["8:40"]); await away(p);
});
add("canvas-ellipse-selected-arc-handle", W(1.7, 540, 586), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.7, 160, 300, 100, 66, 82, 409); await sel(p, ["7:61"]); await hover(p, 210, 350);
});
const columns = [{ pattern: "STRIPES", axis: "X", numSections: 5, type: "STRETCH", offset: 0, gutterSize: 20, sectionSize: 10, color: { r: 1, g: 0, b: 0, a: 0.1 }, visible: true }];
add("canvas-frame-layout-guide-columns-unselected", W(1, 640, 521), async (p) => {
  await openEd(p); await apply(p, [{ guid: "7:1", phase: "CHANGED", layoutGrids: columns }]); await hideUI(p); await place(p, 1, 0, 0, 240, 91, 86, 457); await sel(p, []); await away(p);
});
add("canvas-frame-selected-with-layout-guide", W(1, 640, 521), async (p) => {
  await openEd(p); await apply(p, [{ guid: "7:1", phase: "CHANGED", layoutGrids: columns }]); await hideUI(p); await place(p, 1, 0, 0, 240, 92, 85, 456); await sel(p, ["7:1"]); await away(p);
});
add("canvas-grid-frame-selected", W(2, 800, 1436), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 2, 900, 0, 320, 37, 490, 728); await sel(p, ["7:40"]); await hover(p, 900 + 135, 6);
});
add("canvas-grid-hover-cell-compact-pills", W(1.08, 480, 862), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.08, 900, 0, 320, 83, 332, 315); await sel(p, ["7:40"]); await hover(p, 900 + 60, 150);
});
add("canvas-grid-hover-column-track-pill", W(1.58, 640, 497), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.58, 900, 0, 320, 30, 89, 581); await sel(p, ["7:40"]);
  const [x, y] = await hover(p, 900 + 160, 6); await p.mouse.move(x, y - 31.5, { steps: 4 }); await settle(p); await wait(300);
});
add("canvas-grid-hover-row-track-pill", W(1.58, 560, 401), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.58, 900, 0, 320, 111, 84, 419); await sel(p, ["7:40"]);
  const [x, y] = await hover(p, 900 + 6, 150); await p.mouse.move(x - 31.5, y, { steps: 4 }); await settle(p); await wait(300);
});
add("canvas-grid-hover-top-pill", W(1.58, 640, 497), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.58, 900, 0, 320, 30, 89, 581); await sel(p, ["7:40"]); await hover(p, 900 + 135, 6);
});
async function rowTrack(p, menu) {
  await openEd(p); await hideUI(p); await place(p, 1.08, 900, 0, 320, 83, 332, 315); await sel(p, ["7:40"]);
  await hover(p, 900 + 60, 150);
  const [x0, y] = await toPage(p, 900, 150);
  await p.mouse.move(x0 - 52.75, y, { steps: 4 }); await settle(p); await p.mouse.click(x0 - 52.75, y); await settle(p); await wait(300);
  if (menu) { await p.mouse.move(x0 - 33.75, y); await p.mouse.click(x0 - 33.75, y); await settle(p); await wait(300); }
  return JSON.stringify(await ed(p, () => window.__designerEditor.ui.get().gridTracks));
}
add("canvas-grid-row-track-selected", W(1.08, 480, 862), (p) => rowTrack(p, false));
add("canvas-grid-row-track-menu", W(1.08, 480, 862), (p) => rowTrack(p, true));
add("canvas-group-selected", W(1, 640, 361), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1, 1220, 300, 140, 153, 81, 333); await sel(p, ["7:80"]); await away(p);
});
add("canvas-instance-selected", W(1.12, 540, 316), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.12, 100, 720, 95, 117, 83, 305); await sel(p, ["8:60"]); await hover(p, 140, 742);
});
add("canvas-main-component-selected", W(1.12, 540, 316), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.12, 100, 600, 95, 117, 83, 305); await sel(p, ["8:1"]); await hover(p, 140, 622);
});
add("canvas-multi-select-two-shapes", W(1, 640, 361), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1, 160, 300, 240, 69, 72, 502); await sel(p, ["7:61", "7:62"]); await away(p);
});
add("canvas-polygon-selected-handles", W(1.52, 480, 521), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.52, 300, 300, 100, 59, 73, 363); await sel(p, ["7:62"]); await hover(p, 350, 360);
});
add("canvas-rect-selected-hover-radius-handles", W(1.72, 540, 496), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.72, 0, 300, 120, 75, 95, 391); await sel(p, ["7:60"]); await hover(p, 60, 345);
});
add("canvas-rect-selected", W(1.72, 540, 496), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.72, 0, 300, 120, 75, 95, 391); await sel(p, ["7:60"]); await away(p);
});
add("canvas-rotated-star-selected", W(1, 480, 441), async (p) => {
  await openEd(p);
  const a = (20 * Math.PI) / 180;
  await apply(p, [{ guid: "7:63", phase: "CHANGED", transform: { m00: Math.cos(a), m01: Math.sin(a), m02: 440, m10: -Math.sin(a), m11: Math.cos(a), m12: 300 } }]);
  await hideUI(p); await cam(p, 440, 300, 57, 130, 2.85); await sel(p, ["7:63"]); await away(p);
});
add("canvas-section-selected", W(1, 640, 521), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1, 0, 1100, 400, 54, 57, 532); await sel(p, ["7:95"]); await away(p);
});
add("canvas-star-selected-handles", W(1.52, 480, 521), async (p) => {
  await openEd(p); await hideUI(p); await place(p, 1.52, 440, 300, 100, 58, 73, 363); await sel(p, ["7:63"]); await hover(p, 490, 360);
});
const liveText = (p) => apply(p, [{ guid: "7:90", phase: "CHANGED", textData: { characters: "Hello Figma text" } }]);
add("canvas-text-selected", W(1, 640, 201), async (p) => {
  await openEd(p); await liveText(p); await hideUI(p); await place(p, 1, 0, 460, 184, 101, 62, 438); await sel(p, ["7:90"]); await away(p);
});
add("canvas-text-edit-mode", W(1, 640, 193), async (p) => {
  await openEd(p); await liveText(p); await hideUI(p); await place(p, 1, 0, 460, 184, 79, 56, 482); await sel(p, ["7:90"]);
  await p.locator("#engine-canvas").focus(); await p.keyboard.press("Enter"); await settle(p); await p.keyboard.press("End"); await away(p); await wait(100);
});
add("canvas-text-edit-partial-selection", W(1, 640, 193), async (p) => {
  await openEd(p); await liveText(p); await hideUI(p); await place(p, 1, 0, 460, 184, 79, 56, 482); await sel(p, []);
  const [x, y] = await toPage(p, 165, 474); await p.mouse.dblclick(x, y); await settle(p); await away(p); await wait(100);
});
add("canvas-text-hover-baseline-underline", W(1, 320, 574), async (p) => {
  await openEd(p); await liveText(p); await hideUI(p); await cam(p, 0, 300, 40, 60, 1.3); await sel(p, []); await hover(p, 90, 474);
});

// ---- full UI at 1440 × 900 (live jpgs are 800 × 500) ----
const FULL = { viewport: { width: 1440, height: 900 }, dpr: 1 };
add("grid-frame-selected-full-ui", FULL, async (p) => {
  await openEd(p); await cam(p, 900, 0, 428, 248, 2); await sel(p, ["7:40"]); await hover(p, 900 + 6, 100);
});
add("grid-selected-hover-gap-1440", FULL, async (p) => {
  await openEd(p); await apply(p, PAGE3); await cam(p, 900, 0, 492.1, 289.4, 1.6); await sel(p, ["7:40"]); await hover(p, 900 + 109.3, 146);
});
add("grid-track-selected-grid-panel-and-menu-1440", FULL, async (p) => {
  await openEd(p); await apply(p, PAGE3); await cam(p, 900, 0, 492.1, 289.4, 1.6); await sel(p, ["7:40"]);
  await hover(p, 900 + 109.3, 146);
  const [x0, y] = await toPage(p, 900, 146);
  await p.mouse.move(x0 - 52.75, y, { steps: 4 }); await settle(p); await p.mouse.click(x0 - 52.75, y); await settle(p); await wait(300);
  await p.mouse.move(x0 - 33.75, y); await p.mouse.click(x0 - 33.75, y); await settle(p); await wait(300);
  return JSON.stringify(await ed(p, () => window.__designerEditor.ui.get().gridTracks));
});
const z300 = async (p) => { await apply(p, PAGE3); await cam(p, 900, 0, 621, 45, 3); };
add("left-find-results-and-filter-menu", FULL, async (p) => {
  await openEd(p); await z300(p); await sel(p, ["7:44"]);
  await p.locator('[data-panel="left"]').getByRole("button", { name: "Find" }).first().click();
  await p.keyboard.type("AL_"); await settle(p); await wait(300);
  const f = p.locator('[data-panel="left"]').getByRole("button", { name: "Settings", exact: true }).first();
  if (await f.count()) await f.click();
  await settle(p); await wait(300);
});
add("left-rail-assets-components", FULL, async (p) => {
  await openEd(p); await z300(p); await sel(p, ["7:44"]);
  await p.locator('[data-rail-tab="assets"]').click(); await settle(p);
  await p.locator("[data-library-card]").first().click(); await p.locator('[data-asset-page="Capture"]').click(); await settle(p); await wait(500);
});
add("left-rail-tools", FULL, async (p) => {
  await openEd(p); await z300(p); await sel(p, ["7:44"]);
  await p.locator('[data-rail-tab="tools"]').click(); await settle(p); await wait(800);
});
add("left-rail-variables-full-view", FULL, async (p) => {
  await openEd(p, "&doc=variables"); await p.locator('[data-rail-tab="variables"]').click(); await settle(p); await wait(500); await away(p);
});
add("toolbar-actions-panel", FULL, async (p) => {
  await openEd(p); await z300(p); await sel(p, []);
  await p.locator('[data-ds="EditorToolbar"]').getByRole("button", { name: "Actions" }).click(); await settle(p); await wait(400);
});
add("toolbar-shape-tools-menu", FULL, async (p) => {
  await openEd(p); await z300(p); await sel(p, []);
  await p.getByRole("button", { name: "Shape tools" }).click(); await settle(p); await wait(300);
});
add("vector-edit-mode-full-ui", FULL, async (p) => {
  await openEd(p); await cam(p, 900, 300, 628, 315, 3); await sel(p, ["7:66"]);
  const [x, y] = await toPage(p, 940, 335); await p.mouse.dblclick(x, y); await p.mouse.move(1100, 700); await settle(p); await wait(300);
});
add("panel-grid-dimensions-picker", { ...FULL, clip: { x: 954, y: 360, width: 486, height: 450 } }, async (p) => {
  await openEd(p); await cam(p, 900, 0, 428, 248, 2); await sel(p, ["7:40"]);
  await p.locator('[data-panel="right"]').getByRole("button", { name: /^Open grid dimensions picker/ }).click(); await settle(p);
  await p.locator('[data-grid-cell="4x3"]').hover(); await settle(p); await wait(300);
});

// ---- narrow panes ----
add("menu-main-view", { viewport: { width: 444, height: 798 }, dpr: 0.9 }, async (p) => {
  await openEd(p); await cam(p, 900, 0, 200, 300, 1.3); await sel(p, ["7:40"]);
  await p.getByRole("button", { name: "Main menu" }).click(); await settle(p);
  await p.getByRole("menuitem", { name: "View", exact: true }).hover(); await wait(500);
  const pp = p.getByRole("menuitem", { name: /^Pixel preview/ }).first();
  if (await pp.count()) await pp.hover();
  await settle(p); await wait(300);
});
add("panel-grid-autolayout-highres", { viewport: { width: 444, height: 798 }, dpr: 1.8 }, async (p) => {
  await openEd(p); await cam(p, 900, 0, 50, 300, 1.3); await sel(p, ["7:40"]); await away(p);
});
const ctxCam = async (p) => { await hideUI(p); await cam(p, 0, 0, 22 / 1.08, -3.5 / 1.08, 0.93); };
add("menu-context-main-component", W(1.08, 480, 862), async (p) => {
  await openEd(p); await ctxCam(p); await sel(p, ["8:1"]);
  const [x, y] = await toPage(p, 104, 604); await p.mouse.click(x, y, { button: "right" }); await settle(p); await wait(400);
});
add("menu-context-multi-and-smart-selection", W(1.08, 480, 862), async (p) => {
  await openEd(p); await ctxCam(p); await sel(p, ["7:60", "7:61", "7:62"]);
  const [x, y] = await toPage(p, 60, 345); await p.mouse.click(x, y, { button: "right" }); await settle(p); await wait(400);
});

// ---- behaviour/img ----
// Auto-layout drags (the owner's recording: Frame 406, dark canvas drawn black, half size ≈ 0.91 px per CSS px).
const AL_S = 0.91;
function frame406(order, rotated) {
  const colors = { green: 0x26fa00, blue: 0x004aff, red: 0xff0000, grey: 0xd9d9d9 };
  const ids = { green: "9:2", blue: "9:3", red: "9:4", grey: "9:5" };
  const gap = rotated ? 10 : 52;
  const h = 116 + 176 + 3 * gap;
  const tf = rotated ? { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 0 } : at(0, 0);
  const out = [
    pageBg("0:1", 0x000000),
    { guid: "9:1", phase: "CREATED", type: "FRAME", name: "Frame 406", parentIndex: { guid: "0:1", position: "~~" }, size: { x: 261, y: h }, transform: tf, fillPaints: fill(0xffffff), stackMode: "VERTICAL", stackSpacing: gap, stackHorizontalPadding: 40, stackVerticalPadding: 58, stackPaddingRight: 40, stackPaddingBottom: 58, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED" },
  ];
  order.forEach((c, i) => out.push(rect(ids[c], `Rect ${c}`, "9:1", String.fromCharCode(33 + i), 40, 58 + i * (44 + gap), 181, 44, colors[c], { stackChildAlignSelf: "STRETCH" })));
  return { changes: out, ids, gap };
}
async function alDrag(p, order, rotated) {
  await openEd(p, "&doc=empty");
  const f = frame406(order, rotated);
  await apply(p, [{ guid: "0:1", phase: "CHANGED", backgroundColor: hex(0), backgroundEnabled: true }, ...f.changes.slice(1)]);
  await settle(p);
  await hideUI(p);
  if (rotated) await cam(p, 0, 0, 106 / AL_S, 434 / AL_S, 1.34);
  else await cam(p, 0, 0, 153 / AL_S, 87 / AL_S, 1);
  await sel(p, []);
  // Page point of a child's flow slot centre (i = 0..3), plus an offset along the screen.
  const slot = async (i) => {
    const ly = 58 + i * (44 + f.gap) + 22, lx = 130;
    return rotated ? toPage(p, ly, -lx) : toPage(p, lx, ly);
  };
  return { slot, ids: f.ids };
}
const DRAG = W(AL_S, 554, 597);
add("autolayout-drag-01-pressed", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "red", "grey"], false);
  const [x, y] = await slot(0); await p.mouse.move(x + 50, y + 8); await p.mouse.down(); await settle(p); await wait(200);
});
add("autolayout-drag-02-moving-chrome-kept", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "red", "grey"], false);
  const [x, y] = await slot(0); await p.mouse.move(x + 50, y + 8); await p.mouse.down(); await p.mouse.move(x + 52, y + 8 + 53, { steps: 8 }); await settle(p); await wait(200);
});
add("autolayout-drag-03-first-swap-chrome-hidden", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "red", "grey"], false);
  const [x, y] = await slot(0); await p.mouse.move(x + 50, y + 8); await p.mouse.down(); await p.mouse.move(x + 52, y + 8 + 60, { steps: 8 }); await p.mouse.move(x + 53, y + 8 + 88, { steps: 3 }); await wait(30);
});
add("autolayout-drag-04-sibling-sliding", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "red", "grey"], false);
  const [x, y] = await slot(0); await p.mouse.move(x + 50, y + 8); await p.mouse.down(); await p.mouse.move(x + 53, y + 8 + 150, { steps: 12 }); await wait(400); await p.mouse.move(x + 54, y + 8 + 180, { steps: 3 }); await wait(30);
});
add("autolayout-drag-05-drop-instant", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "red", "grey"], false);
  const [x, y] = await slot(0); await p.mouse.move(x + 50, y + 8); await p.mouse.down(); await p.mouse.move(x + 52, y + 8 + 100, { steps: 12 }); await wait(400); await p.mouse.up(); await settle(p); await wait(60);
});
add("autolayout-drag-06-last-child-chrome-hidden-at-once", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["blue", "grey", "red", "green"], true);
  const [x, y] = await slot(3); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 4, y + 4, { steps: 3 }); await settle(p); await wait(100);
});
add("autolayout-drag-07-rotated-sibling-sliding", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "grey", "red"], true);
  const [x, y] = await slot(1); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 50, y, { steps: 8 }); await wait(400); await p.mouse.move(x + 79, y, { steps: 3 }); await wait(30);
});
add("autolayout-drag-08-rotated-drop", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["green", "blue", "grey", "red"], true);
  const [x, y] = await slot(1); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 160, y, { steps: 16 }); await wait(400); await p.mouse.up(); await p.mouse.move(x + 175, y + 5); await settle(p); await wait(200);
});
add("autolayout-drag-09-overlap-before-centre-no-swap", DRAG, async (p) => {
  const { slot } = await alDrag(p, ["blue", "green", "grey", "red"], true);
  const [x, y] = await slot(0); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 24, y, { steps: 6 }); await settle(p); await wait(200);
});
// Round 2: Frame 4883 (light canvas, 54 × 27 layers, ≈ 3.7 px per unit).
const R2 = { viewport: { width: 700, height: 575 }, dpr: 1, scheme: "light" };
const Z2 = 3.695;
async function frame4883(p, colors, extra = []) {
  await openEd(p, "&doc=empty");
  const kids = colors.map((c, i) => rect(`9:${10 + i}`, `Rectangle ${i + 1}`, "9:1", String.fromCharCode(33 + i), 13, 18 + i * 41, 54, 27, c));
  await apply(p, [
    { guid: "9:1", phase: "CREATED", type: "FRAME", name: "Frame 4883", parentIndex: { guid: "0:1", position: "~~" }, size: { x: 82, y: 35 + colors.length * 27 + (colors.length - 1) * 14 }, transform: at(0, 0), fillPaints: fill(0xffffff), frameMaskDisabled: false, stackMode: "VERTICAL", stackSpacing: 14, stackHorizontalPadding: 13, stackVerticalPadding: 18, stackPaddingRight: 15, stackPaddingBottom: 17, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED" },
    ...kids,
    ...extra,
  ]);
  await hideUI(p);
  await cam(p, 0, 0, 217, 84, Z2);
  await sel(p, []);
  return (i) => toPage(p, 13 + 27, 18 + i * 41 + 13.5);
}
add("autolayout-drag-r2-01-alt-copy-ghost-line", R2, async (p) => {
  const k = await frame4883(p, [0xd9d9d9, 0xd9d9d9]);
  const [x, y] = await k(0); await p.mouse.move(x, y); await p.keyboard.down("Alt"); await p.mouse.down(); await p.mouse.move(x + 50, y + 60, { steps: 10 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-02-alt-copy-outside-opaque", R2, async (p) => {
  const k = await frame4883(p, [0xd9d9d9, 0xd9d9d9, 0xd9d9d9]);
  const [x, y] = await k(0); await p.mouse.move(x, y); await p.keyboard.down("Alt"); await p.mouse.down(); await p.mouse.move(x - 240, y, { steps: 14 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-03-drag-in-ghost-no-space", R2, async (p) => {
  const k = await frame4883(p, [0xd9d9d9, 0xd9d9d9, 0xd9d9d9], [rect("9:30", "Rectangle 9", "0:1", "~~~", -50, 40, 54, 27, 0xd9d9d9)]);
  const [x0, y0] = await toPage(p, -23, 53.5); const [x, y] = await k(1);
  await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x, y - 20, { steps: 14 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-04-out-clipped-chrome-kept", R2, async (p) => {
  const k = await frame4883(p, [0xe30613, 0xd9d9d9, 0xf5f5f5]);
  const [x, y] = await k(0); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x - 172, y + 5, { steps: 10 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-05-out-closed-at-once", R2, async (p) => {
  const k = await frame4883(p, [0xe30613, 0xd9d9d9, 0xf5f5f5]);
  const [x, y] = await k(0); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x - 270, y + 62, { steps: 16 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-06-drag-in-red-ghost", R2, async (p) => {
  await frame4883(p, [0xd9d9d9, 0xf5f5f5], [rect("9:30", "Rectangle 1", "0:1", "~~~", -58.7, 34.9, 54, 27, 0xe30613)]);
  const [x0, y0] = await toPage(p, -31, 48); const [x, y] = await toPage(p, 21, 51);
  await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x, y, { steps: 14 }); await settle(p); await wait(200);
});
add("autolayout-drag-r2-07-dropped-fixed-width", R2, async (p) => {
  await frame4883(p, [0xd9d9d9, 0xf5f5f5], [rect("9:30", "Rectangle 1", "0:1", "~~~", -58.7, 34.9, 54, 27, 0xe30613)]);
  const [x0, y0] = await toPage(p, -31, 48); const [x, y] = await toPage(p, 21, 51);
  await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x, y, { steps: 14 }); await wait(200); await p.mouse.up(); await settle(p); await wait(200);
});
// The Behaviour page.
add("bulk-rename-dialog-and-smart-selection", FULL, async (p) => {
  await openBehaviour(p); await cam(p, 500, 0, 381 / 0.5556, 60 / 0.5556, 2); await sel(p, ["20:11", "20:12", "20:13"]);
  await p.locator("#engine-canvas").focus(); await p.keyboard.press("Meta+r"); await settle(p); await wait(400);
});
add("minimize-ui-nothing-selected", FULL, async (p) => {
  await openBehaviour(p); await cam(p, 500, 0, 263 / 0.5556, 208 / 0.5556, 2.5); await sel(p, []);
  await p.locator("#engine-canvas").focus(); await p.keyboard.press("Meta+Shift+Backslash"); await settle(p); await wait(400);
  await cam(p, 500, 0, 263 / 0.5556, 208 / 0.5556, 2.5); await away(p);
});
add("minimize-ui-with-selection-floating-panel", FULL, async (p) => {
  await openBehaviour(p); await sel(p, []);
  await p.locator("#engine-canvas").focus(); await p.keyboard.press("Meta+Shift+Backslash"); await settle(p); await wait(400);
  await cam(p, 500, 0, 263 / 0.5556, 208 / 0.5556, 2.5); await sel(p, ["20:12"]); await away(p); await wait(300);
});
add("outlines-shift-cmd-o", { ...FULL, out: 480 }, async (p) => {
  await openBehaviour(p); await cam(p, 0, 0, 133 / 0.3333, 67 / 0.3333, 0.75); await sel(p, []);
  await p.locator("#engine-canvas").focus(); await p.keyboard.press("Meta+Shift+o"); await settle(p); await wait(500); await away(p);
});
const S_SM = 0.5556;
add("smart-selection-three-equal-rects", { ...FULL, clip: { x: 400, y: 300, width: Math.round(288 / S_SM), height: Math.round(128 / S_SM) } }, async (p) => {
  await openBehaviour(p); await cam(p, 500, 0, 400 + 18 / S_SM, 300 + 30 / S_SM, 2); await sel(p, ["20:11", "20:12", "20:13"]); await away(p);
});
add("smart-selection-after-dragging-spacing-handle", { ...FULL, clip: { x: 400, y: 300, width: Math.round(288 / S_SM), height: Math.round(128 / S_SM) } }, async (p) => {
  await openBehaviour(p); await cam(p, 500, 0, 400 + 18 / S_SM, 300 + 30 / S_SM, 2); await sel(p, ["20:11", "20:12", "20:13"]);
  const [x, y] = await toPage(p, 570, 30); await p.mouse.move(x, y, { steps: 3 }); await wait(300);
  await p.mouse.down(); await p.mouse.move(x + 22, y, { steps: 8 }); await p.mouse.up(); await settle(p);
  const [hx, hy] = await toPage(p, 500 + 60 + 21, 30); await p.mouse.move(hx, hy, { steps: 3 }); await settle(p); await wait(300);
  return JSON.stringify(await ed(p, () => ["20:11", "20:12", "20:13"].map((id) => window.__designerEditor.engine.readNode(id).transform.m02)));
});
for (const [zoom, name] of [[2, "pixel-grid-200-none"], [3, "pixel-grid-300"], [8, "pixel-grid-800"]]) {
  add(name, { ...FULL, clip: { x: 500, y: 300, width: Math.round(132 / S_SM), height: Math.round(108 / S_SM) } }, async (p) => {
    await openBehaviour(p); await cam(p, 500, 0, 500 + 68 / S_SM, 300 + 59 / S_SM, zoom); await sel(p, []); await away(p);
    return JSON.stringify(await ed(p, () => window.__designerEditor.ui.get().pixelGrid));
  });
}
const leftClip = (y, h) => ({ x: 58, y, width: Math.round(136 / S_SM), height: Math.round(h / S_SM) });
add("pages-divider-dashes", { ...FULL, clip: leftClip(71, 150) }, async (p) => {
  await openBehaviour(p);
  await apply(p, [addPage("0:21", "---", "~2"), addPage("0:22", "– Divider test", "~3")]); await settle(p); await away(p); await wait(300);
});
async function layerRowClip(p, id, dy, h) {
  const b = await p.locator(`[data-ds="LayerRow"][data-id="${id}"]`).first().boundingBox();
  return { x: 58, y: Math.round(b.y - dy), width: Math.round(136 / S_SM), height: Math.round(h / S_SM) };
}
add("layers-drag-across-eyes-hidden-rows", { ...FULL, dynamicClip: true }, async (p) => {
  await openBehaviour(p);
  await apply(p, ["20:11", "20:12", "20:13"].map((guid) => ({ guid, phase: "CHANGED", visible: false }))); await settle(p);
  const row = p.locator('[data-ds="LayerRow"][data-id="20:11"]').first(); await row.hover(); await settle(p); await wait(300);
  return { clip: await layerRowClip(p, "20:13", 2, 56) };
});
add("layers-row-inline-rename", { ...FULL, dynamicClip: true }, async (p) => {
  await openBehaviour(p);
  const row = p.locator('[data-ds="LayerRow"][data-id="20:11"]').first(); await row.click(); await settle(p);
  await row.locator("[data-layer-name], span").first().dblclick().catch(() => row.dblclick()); await settle(p); await wait(300);
  return { clip: await layerRowClip(p, "20:11", 10, 40) };
});
add("move-big-layer-nested-into-small-frame", { ...FULL, clip: { x: 500, y: 250, width: Math.round(257 / S_SM), height: Math.round(210 / S_SM) } }, async (p) => {
  await openBehaviour(p);
  await apply(p, [rect("20:30", "Big", "0:20", "~~", 860, 260, 333, 133, 0x404040)]);
  await cam(p, 900, 300, 500 + 116 / S_SM, 250 + 70 / S_SM, 0.63 / S_SM * 0.556 * 1.8);
  const [x, y] = await toPage(p, 1026, 326); const [tx, ty] = await toPage(p, 950, 350);
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(tx, ty, { steps: 10 }); await p.mouse.up(); await settle(p); await wait(200);
  return JSON.stringify(await ed(p, () => window.__designerEditor.engine.readNode("20:30").parentIndex.guid));
});

// ---------------------------------------------------------------------------------------------------------------
const browser = await launch();
try {
  for (const c of cases) {
    if (filter && !filter.test(c.name)) continue;
    const t0 = Date.now();
    const context = await browser.newContext({ viewport: c.viewport, deviceScaleFactor: c.dpr, colorScheme: c.scheme ?? "dark" });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "keyboard", { configurable: true, value: { getLayoutMap: async () => new Map() } });
    });
    const page = await context.newPage();
    const logs = [];
    page.on("pageerror", (e) => logs.push(String(e).slice(0, 200)));
    try {
      const r = await Promise.race([c.run(page), wait(45000).then(() => { throw new Error("timeout"); })]);
      const clip = c.clip ?? (r && typeof r === "object" ? r.clip : null);
      if (clip) await shotClip(page, c.name, clip);
      else await shotFull(page, c.name);
      results[c.name] = { ok: true, note: typeof r === "string" ? r : undefined, ms: Date.now() - t0, errors: logs.slice(0, 3) };
      console.log("ok  ", c.name, typeof r === "string" ? r : "");
    } catch (e) {
      results[c.name] = { ok: false, error: String(e).slice(0, 300), errors: logs.slice(0, 3) };
      console.log("FAIL", c.name, String(e).slice(0, 200));
      await page.screenshot({ path: path.join(out, `${c.name}.png`) }).catch(() => {});
    }
    await page.mouse.up().catch(() => {});
    await page.keyboard.up("Alt").catch(() => {});
    await context.close();
  }
} finally {
  writeFileSync(resultsFile, JSON.stringify(results, null, 1));
  await browser.close();
}
