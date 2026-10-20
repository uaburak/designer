// Prototype playback on the owner's "Prototype deneme" (2026-10-20, docs/research/figma/live/2026-10-20/prototype-playback.txt):
// hover animations (Change to + Smart animate, springs) and the click path 1 → 4 → 6 → 1 → 2 → 3 → 1, in the inline
// preview, Present here and the Present tab; Play with the section / a frame in it selected. Real mouse input; per step
// the editor's frame gaps, long tasks and the prototype engine's own frame times.
//
//   npm run build && UD=<user data> node scripts/proto-bench/playback.mjs [tag]
//   FILE=<fileKey>  ONLY=preview,here,tab,section  PROFILE=<step prefix>  GFX=webgl2
import { launch, openFile, close, sleep, record, mark, report, profile, out, pageOfTab, debug } from "./lib.mjs";
import * as lib from "./lib.mjs";
const FILE = process.env.FILE || "9wLJowqw1RD5F8DT2mB9Qe";
const tag = process.argv[2] || "before";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const on = (k) => !ONLY || ONLY.includes(k);
const PAGE = "1:3531";
const SECTION = "75:3803";
const FRAMES = { 1: "1:3894", 2: "29:3053", 3: "32:1742", 4: "124:1807", 5: "124:1856", 6: "124:3459" };
const nameOf = Object.fromEntries(Object.entries(FRAMES).map(([k, v]) => [v, k]));
// Points in frame coordinates (live Figma's absoluteBoundingBox, the same file).
const HOVERS = [
  ["card 2", 870, 240],
  ["card 3", 1246, 240],
  ["create news", 494, 240],
  ["card 2", 870, 240],
  ["card 3", 1246, 240],
  ["pagination 3", 1269, 872],
  ["pagination 4", 1408, 872],
  ["sidebar news", 156, 92],
];
const CLICKS = [
  ["1→4 sidebar News", 156, 92, "4"],
  ["4→6 card", 494, 240, "6"],
  ["6→1 sidebar button", 156, 811, "1"],
  ["1→2 pagination 2", 1221, 872, "2"],
  ["2→3 Read", 583, 393, "3"],
  ["3→1 startItem", 355, 32, "1"],
  ["1→4 again", 156, 92, "4"],
  ["4→6 again", 494, 240, "6"],
];
const res = {};
let page; // the page whose frames are recorded (the editor, or the Present tab)
let pv = "__designerPreview"; // the prototype engine's global there
let canvasId = "preview-canvas";

async function step(name, action, settle = 1100) {
  const t = await mark(page);
  await page.evaluate(() => {
    window.__pf = [];
    window.__moves = [];
  });
  const run = async () => {
    const extra = await action();
    await sleep(settle);
    return extra;
  };
  let extra;
  if (process.env.PROFILE && process.env.PROFILE.split(",").some((p) => name.startsWith(p))) {
    const prof = await profile(page, async () => (extra = await run()));
    console.error(`---- PROFILE ${name}\n${prof}`);
  } else extra = await run();
  const r = await report(page, t);
  const pf = await page.evaluate(() => window.__pf ?? []);
  if (pf.length) {
    const so = [...pf].sort((a, b) => a - b);
    r.pf = { n: pf.length, p50: Math.round(so[Math.floor(so.length / 2)] * 10) / 10, p95: Math.round(so[Math.floor(so.length * 0.95)] * 10) / 10, max: Math.round(so.at(-1) * 10) / 10 };
  }
  Object.assign(r, extra && typeof extra === "object" ? extra : {});
  // How long the picture moved: from the first changed frame to the last.
  const moves = await page.evaluate(() => window.__moves ?? []);
  if (moves.length) r.motionMs = Math.round(moves.at(-1) - moves[0]);
  res[name] = r;
  console.log(`${name.padEnd(30)} maxGap ${String(r.maxGap).padStart(4)} p50 ${r.p50} p95 ${r.p95} over33 ${r.over33} longTasks [${r.longTasks.slice(0, 6).join(",")}]${r.pf ? ` engine frame p50 ${r.pf.p50} p95 ${r.pf.p95} max ${r.pf.max} (${r.pf.n})` : ""}${r.motionMs !== undefined ? ` motion ${r.motionMs} ms` : ""}${r.note ? "  " + r.note : ""}`);
}

/**
 * Times the prototype engine's frames (window.__pf). MOTION=1: also how long the picture moves after an input — each
 * frame's canvas drawn small and compared with the last one (window.__moves: the times it changed); a separate run, the
 * read-back costs frame time.
 */
const timeFrames = () =>
  page.evaluate(([g, id, motion]) => {
    const pe = window[g];
    if (!pe || pe.__timed) return;
    const frame = pe.frame.bind(pe);
    pe.__timed = true;
    window.__pf = [];
    window.__moves = [];
    const small = motion ? document.createElement("canvas") : null;
    if (small) small.width = small.height = 64;
    const ctx = small?.getContext("2d", { willReadFrequently: true });
    let last = null;
    pe.frame = (t) => {
      const s = performance.now();
      frame(t);
      window.__pf.push(performance.now() - s);
      if (!ctx) return;
      ctx.drawImage(document.getElementById(id), 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      let diff = 0;
      if (last) for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i] - last[i]) + Math.abs(d[i + 1] - last[i + 1]) + Math.abs(d[i + 2] - last[i + 2]);
      if (last && diff > 64) window.__moves.push(performance.now());
      last = d.slice();
    };
  }, [pv, canvasId, !!process.env.MOTION]);

/** A point of the shown screen (frame coordinates) in the page's coordinates. */
const at = (x, y) =>
  page.evaluate(
    ([g, id, x, y]) => {
      const pe = window[g];
      const st = pe.presentState();
      const c = document.getElementById(id).getBoundingClientRect();
      const sr = st.screenRect;
      const w = pe.readNode(st.screen, { fields: ["size"] })?.size?.x ?? 1440;
      const k = sr.w / w;
      return { x: c.left + sr.x + x * k, y: c.top + sr.y + y * k, screen: st.screen, name: st.screenName };
    },
    [pv, canvasId, x, y],
  );
const shown = () => page.evaluate((g) => window[g].presentState(), pv);

async function playScenarios(prefix) {
  await timeFrames();
  await sleep(1200);
  // Hovers
  for (const [label, x, y] of HOVERS) {
    const p = await at(x, y);
    await step(`${prefix} hover ${label}`, async () => {
      // A short glide in, as a hand moves (Figma's own numbers were taken the same way).
      const from = await page.evaluate(() => window.__lastMouse ?? null);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const fx = from ? from.x + ((p.x - from.x) * i) / steps : p.x;
        const fy = from ? from.y + ((p.y - from.y) * i) / steps : p.y;
        await page.mouse.move(fx, fy);
        await sleep(8);
      }
      await page.evaluate((q) => (window.__lastMouse = q), p);
    }, 1000);
  }
  // Clicks through the screens
  for (const [label, x, y, want] of CLICKS) {
    const st = await shown();
    const p = await at(x, y);
    await page.mouse.move(p.x, p.y);
    await page.evaluate((q) => (window.__lastMouse = q), p);
    await sleep(500);
    await step(`${prefix} click ${label}`, async () => {
      await page.mouse.down();
      await page.mouse.up();
      await sleep(900);
      const after = await shown();
      const got = nameOf[after.screen] ?? after.screenName;
      return { note: `${nameOf[st.screen] ?? st.screenName} → ${got}${got === want ? "" : ` (WANTED ${want})`}` };
    }, 400);
  }
}

try {
  await launch();
  await sleep(1000);
  ({ page } = await openFile(FILE));
  const editor = page;
  await record(page);
  await page.evaluate((p) => window.__designerEditor.engine.setCurrentPage(p), PAGE);
  await sleep(1500);
  res.gfx = await page.evaluate(() => window.__designerEditor.engine.gfx);
  console.log("gfx", res.gfx);

  // ---- Section: what Play / ⇧Space start on
  if (on("section")) {
    const results = {};
    for (const [label, sel] of [
      ["section selected", [SECTION]],
      ["frame 4 selected", [FRAMES[4]]],
      ["nothing selected", []],
    ]) {
      await page.evaluate((s) => window.__designerEditor.engine.setSelection(s), sel);
      await page.evaluate(() => window.__designerEditor.focusCanvas());
      await sleep(300);
      await page.keyboard.press("Shift+Space");
      await page.waitForFunction(() => window.__designerPreview?.presentState().screen, null, { timeout: 20000 });
      await sleep(600);
      const st = await page.evaluate(() => {
        const s = window.__designerPreview.presentState();
        return { screen: s.screen, name: s.screenName, rect: s.screenRect };
      });
      results[`⇧Space, ${label}`] = st;
      await page.keyboard.press("Escape");
      await sleep(400);
      // The toolbar's Play (Present) in this tab
      await page.evaluate((s) => window.__designerEditor.engine.setSelection(s), sel);
      await page.getByRole("button", { name: "Present options" }).click();
      await page.getByText("Present in this tab", { exact: true }).click();
      await page.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 20000 });
      await sleep(600);
      results[`Present here, ${label}`] = await page.evaluate(() => {
        const s = window.__designerPresent.presentState();
        return { screen: s.screen, name: s.screenName, rect: s.screenRect };
      });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !window.__designerEditor.ui.get().presenting, null, { timeout: 5000 }).catch(() => page.evaluate(() => window.__designerEditor.ui.set({ presenting: null })));
      await sleep(400);
    }
    // The toolbar's Play (the Present tab, its own process), as a click
    for (const [label, sel] of [
      ["section selected", [SECTION]],
      ["frame 4 selected", [FRAMES[4]]],
      ["a layer in frame 2 selected", ["124:3341"]],
    ]) {
      await page.evaluate((s) => window.__designerEditor.engine.setSelection(s), sel);
      await sleep(300);
      const before = (await debug()).views.map((v) => v.id);
      await page.getByRole("button", { name: "Present", exact: true }).click();
      let tab;
      for (let k = 0; k < 300 && !tab; k++) {
        await sleep(50);
        tab = (await debug()).views.find((v) => !before.includes(v.id) && !v.spare);
      }
      const tp = await pageOfTab(tab.id);
      await tp.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 60000 });
      await sleep(800);
      results[`Play (Present tab), ${label}`] = await tp.evaluate(() => {
        const s = window.__designerPresent.presentState();
        return { screen: s.screen, name: s.screenName, rect: s.screenRect, url: location.search };
      });
      await tp.screenshot({ path: `${process.env.SCREENSHOT_DIR ?? "/tmp"}/play-tab-${label.replace(/\W+/g, "-")}.png` });
      await lib.app.evaluate((_e, id) => globalThis.__designer.current().tabs.close([id]), tab.id);
      await sleep(600);
    }
    res.section = results;
    console.log("section", JSON.stringify(results, null, 1));
  }

  // ---- Inline preview from "1"
  if (on("preview")) {
    await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), FRAMES[1]);
    await page.evaluate(() => window.__designerEditor.focusCanvas());
    await sleep(300);
    await step("preview open", async () => {
      await page.keyboard.press("Shift+Space");
      await page.waitForFunction(() => window.__designerPreview?.presentState().screen && !document.querySelector("[data-inline-preview][data-closed]"), null, { timeout: 20000 });
    }, 1200);
    pv = "__designerPreview";
    canvasId = "preview-canvas";
    await playScenarios("preview");
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }

  // ---- Present here
  if (on("here")) {
    await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), FRAMES[1]);
    await step("here open", async () => {
      await page.getByRole("button", { name: "Present options" }).click();
      await page.getByText("Present in this tab", { exact: true }).click();
      await page.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 20000 });
    }, 1200);
    pv = "__designerPresent";
    canvasId = "present-canvas";
    await playScenarios("here");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !window.__designerEditor.ui.get().presenting, null, { timeout: 5000 }).catch(() => {});
    await sleep(500);
  }

  // ---- The Present tab (its own process)
  if (on("tab")) {
    await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), FRAMES[1]);
    const before = (await debug()).views.map((v) => v.id);
    await page.evaluate(async () => {
      const ed = window.__designerEditor;
      await ed.source.flush();
      await window.designer.nav.openPrototype(ed.source.fileKey, ed.store.page, ed.selection[0], "x");
    });
    let tab;
    for (let k = 0; k < 200 && !tab; k++) {
      await sleep(50);
      tab = (await debug()).views.find((v) => !before.includes(v.id) && !v.spare);
    }
    page = await pageOfTab(tab.id);
    await page.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 60000 });
    await record(page);
    pv = "__designerPresent";
    canvasId = "present-canvas";
    await playScenarios("tab");
    page = editor;
  }
  out(`playback-${tag}`, res);
} catch (e) {
  console.error(e);
  out(`playback-${tag}-partial`, res);
} finally {
  await close();
}
