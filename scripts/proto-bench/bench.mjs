// Every prototype path on a real file, in the Electron app (2026-10-20, docs/handoff.md): the inline preview's opening,
// closing, reopening, the selection jumping it, a page change; playing it (each hotspot of the screen clicked, hover,
// scroll); edits on the canvas while it is open; the Prototype tab; Present here and back; the desktop's Present tab.
// Each scenario: the editor's longest frame gap, its long tasks, p95 frame and the preview engine's own frame times.
//
//   npm run build && UD=<copy of the user data> node scripts/proto-bench/bench.mjs <fileKey | kahve | b2c> [tag]
//   PROFILE=<scenario prefix,…> a CPU profile of those (build the wasm with --profiling-funcs for C++ names);
//   ONLY=<prefix,…> only those; GFX=webgl2 the engines on WebGL2.
import { launch, openFile, close, FILES, sleep, record, mark, report, profile, out, pageOfTab, debug } from "./lib.mjs";
const which = process.argv[2] || "kahve";
const tag = process.argv[3] || "before";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const res = {};
let page;

async function measure(name, action, settle = 900) {
  if (ONLY && !ONLY.some((o) => name.startsWith(o))) return;
  const run = async () => {
    const t = await mark(page);
    const extra = await action();
    await sleep(settle);
    const r = await report(page, t);
    return { ...r, ...(extra && typeof extra === "object" ? extra : {}) };
  };
  let r;
  if (process.env.PROFILE && process.env.PROFILE.split(",").some((p) => name.startsWith(p))) {
    let inner;
    const prof = await profile(page, async () => (inner = await run()));
    console.error(`---- PROFILE ${name}\n${prof}`);
    r = inner;
  } else r = await run();
  const pf = await page.evaluate(() => {
    const a = window.__pf ?? [];
    window.__pf = [];
    return a;
  });
  if (pf.length) {
    const so = [...pf].sort((a, b) => a - b);
    r.pf = { n: pf.length, p95: Math.round(so[Math.floor(so.length * 0.95)] * 10) / 10, max: Math.round(so.at(-1) * 10) / 10 };
  }
  res[name] = r;
  console.log(`${name.padEnd(34)} maxGap ${String(r.maxGap).padStart(5)}  longTask ${String(r.longTaskMs).padStart(5)} [${r.longTasks.slice(0, 8).join(",")}]  p95 ${r.p95} over33 ${r.over33}${r.pf ? ` pvFrames ${r.pf.n} p95 ${r.pf.p95} max ${r.pf.max}` : ""}${r.note ? "  " + r.note : ""}`);
}

const ed = (fn, arg) => page.evaluate(fn, arg);
const waitPreview = () =>
  page.waitForFunction(() => {
    const p = window.__designerPreview;
    return p && !p.destroyed && p.presentState().screen && !document.querySelector("[data-inline-preview][data-closed]");
  }, null, { timeout: 30000 });

/** The page's screens with interactions (top-level frames, frames in sections). */
async function inventory() {
  return ed(() => {
    const e = window.__designerEditor.engine;
    const pageId = window.__designerEditor.store.page;
    const nodes = e.readNodes([pageId], { subtree: true, fields: ["type", "name", "prototypeInteractions", "parentIndex"] });
    const by = {};
    let n = 0;
    for (const x of nodes) {
      for (const i of x.prototypeInteractions ?? []) {
        n++;
        const ev = i.event?.interactionType ?? "?";
        for (const a of i.actions ?? []) {
          const k = `${ev}/${a.navigationType ?? a.connectionType ?? "?"}/${a.transitionType ?? ""}${a.transitionShouldSmartAnimate ? "+SA" : ""}`;
          by[k] = (by[k] ?? 0) + 1;
        }
      }
    }
    const types = {};
    for (const x of nodes) types[x.type] = (types[x.type] ?? 0) + 1;
    return { nodes: nodes.length, interactions: n, by, types };
  });
}

/** Screens of the current page (frames at top level or in sections), with how many interactions are inside each. */
const screens = () =>
  ed(() => {
    const e = window.__designerEditor.engine;
    const pageId = window.__designerEditor.store.page;
    const out = [];
    const walk = (id) => {
      const n = e.readNode(id, { fields: ["type", "name"], childIds: true });
      for (const c of n.childIds ?? []) {
        const k = e.readNode(c, { fields: ["type", "name"], childIds: true });
        if (k.type === "SECTION") walk(c);
        else if (k.type === "FRAME" || k.type === "INSTANCE" || k.type === "SYMBOL") out.push({ id: c, name: k.name });
      }
    };
    walk(pageId);
    return out;
  });

/** Hotspots of the preview's screen: a grid of pointer moves through the engine, where it says "hotspot". */
const hotspots = () =>
  ed(() => {
    const pe = window.__designerPreview;
    const c = document.getElementById("preview-canvas");
    const r = c.getBoundingClientRect();
    const st = pe.presentState();
    const sr = st.screenRect ?? { x: 0, y: 0, w: r.width, h: r.height };
    const pts = [];
    const step = 12;
    for (let y = sr.y + 4; y < sr.y + sr.h; y += step)
      for (let x = sr.x + 4; x < sr.x + sr.w; x += step) {
        pe.presentPointer(1, x, y, 0, 0);
        if (pe.presentState().hotspot) pts.push([r.left + x, r.top + y]);
      }
    pe.presentPointer(5, 0, 0, 0, 0);
    // One per cluster.
    const kept = [];
    for (const p of pts) if (!kept.some((k) => Math.abs(k[0] - p[0]) < 40 && Math.abs(k[1] - p[1]) < 30)) kept.push(p);
    return { screen: st.screen, name: st.screenName, rect: sr, points: kept };
  });

try {
  await launch();
  await sleep(1500);
  ({ page } = await openFile(FILES[which]));
  await record(page);
  await sleep(2500);
  if (process.env.PAGE) {
    await ed((p) => window.__designerEditor.engine.setCurrentPage(p), process.env.PAGE);
    await sleep(3000);
  }
  res.gfx = await ed(() => window.__designerEditor.engine.gfx);
  res.inventory = await inventory();
  console.log("gfx", res.gfx, "inventory", JSON.stringify(res.inventory));
  const scr = await screens();
  console.log("screens", scr.length, scr.slice(0, 6).map((s) => s.name).join(" | "));
  const start = scr.find((s) => /splash|1$|home/i.test(s.name)) ?? scr[0];
  await ed((id) => window.__designerEditor.engine.setSelection([id]), start.id);
  await page.click("#engine-canvas", { position: { x: 5, y: 5 }, trial: true }).catch(() => {});
  await ed(() => window.__designerEditor.focusCanvas());
  await sleep(500);

  // 1. ⇧Space first open, close, reopen
  await measure("1a preview first open", async () => {
    await page.keyboard.press("Shift+Space");
    await waitPreview();
  }, 1200);
  await measure("1b preview close", async () => {
    await page.keyboard.press("Escape");
  }, 600);
  await ed(() => window.__designerEditor.focusCanvas());
  await measure("1c preview reopen", async () => {
    await page.keyboard.press("Shift+Space");
    await waitPreview();
  }, 1000);
  // switching the selected frame while open
  for (let i = 1; i <= 4 && i < scr.length; i++) {
    await measure(`1d select frame ${i}`, async () => {
      await ed((id) => window.__designerEditor.engine.setSelection([id]), scr[(i * 3) % scr.length].id);
    }, 700);
  }
  // 3. idle with the preview open (presentState poll, preview frames)
  await measure("3a idle 3s preview open", async () => sleep(2100), 900);
  // 2. playback: click hotspots
  await ed((id) => window.__designerEditor.engine.setSelection([id]), start.id);
  await sleep(800);
  // The preview engine's own frames, timed.
  await ed(() => {
    const pe = window.__designerPreview;
    const frame = pe.frame;
    window.__pf = [];
    pe.frame = (t) => {
      const s = performance.now();
      frame(t);
      window.__pf.push(performance.now() - s);
    };
  });
  for (let i = 0; i < 14; i++) {
    let h = await hotspots();
    if (!h.points.length) {
      // After delay screens: wait for them to go on, else next.
      await sleep(2500);
      h = await hotspots();
      if (!h.points.length) {
        console.log("no hotspot on", h.name);
        await ed(() => window.__designerPreview.presentCommand("next"));
        continue;
      }
    }
    await ed(() => (window.__pf = []));
    const p = h.points[i % h.points.length];
    await measure(`2 click ${i} on ${h.name}`.slice(0, 34), async () => {
      await page.mouse.move(p[0], p[1]);
      await page.mouse.down();
      await page.mouse.up();
      const after = await ed(() => window.__designerPreview.presentState());
      return { note: `→ ${after.screenName} ov${after.overlays?.length ?? 0}` };
    }, 900);
  }
  // hover sweep over the preview (While hovering / Mouse enter)
  await measure("2h hover sweep", async () => {
    const r = await ed(() => document.getElementById("preview-canvas").getBoundingClientRect().toJSON());
    for (let k = 0; k < 60; k++) await page.mouse.move(r.x + (r.width * (k % 20)) / 20, r.y + (r.height * (1 + Math.floor(k / 20))) / 4);
  }, 500);
  // scroll inside the preview
  await measure("2s wheel scroll", async () => {
    const r = await ed(() => document.getElementById("preview-canvas").getBoundingClientRect().toJSON());
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    for (let k = 0; k < 30; k++) {
      await page.mouse.wheel(0, 40);
      await sleep(16);
    }
  }, 500);
  // 3. edits on the canvas while the preview is open
  const target = await ed(() => window.__designerPreview.presentState().screen);
  await measure("3b nudge x20 (preview open)", async () => {
    await ed(async (id) => {
      const e = window.__designerEditor.engine;
      e.setSelection([id]);
      for (let i = 0; i < 20; i++) {
        e.command("NUDGE", { dx: 1, dy: 0 });
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, target);
  }, 800);
  await measure("3c fill change x10", async () => {
    await ed(async (id) => {
      const ed = window.__designerEditor;
      for (let i = 0; i < 10; i++) {
        ed.setProps([id], { fillPaints: [{ type: "SOLID", color: { r: i / 10, g: 0.5, b: 0.5, a: 1 }, opacity: 1, visible: true }] }, "Fill");
        await new Promise((r) => requestAnimationFrame(r));
      }
      ed.engine.command("UNDO");
    }, target);
  }, 800);
  await measure("3d drag frame 40 moves", async () => {
    const box = await ed((id) => {
      const ed = window.__designerEditor;
      ed.engine.setSelection([id]);
      ed.engine.command("ZOOM_TO_SELECTION");
      return true;
    }, target);
    void box;
    await sleep(300);
    const c = await ed(() => document.getElementById("engine-canvas").getBoundingClientRect().toJSON());
    const x = c.x + c.width * 0.45;
    const y = c.y + c.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 0; k < 40; k++) {
      await page.mouse.move(x + k * 2, y + k);
      await sleep(16);
    }
    await page.mouse.up();
    await ed(() => window.__designerEditor.engine.command("UNDO"));
  }, 800);
  // change page while open
  const pages = await ed(() => window.__designerEditor.store.pages.map((p) => p.guid));
  const here = await ed(() => window.__designerEditor.store.page);
  const other = pages.find((p) => p !== here);
  if (other) {
    await measure("1e change page while open", async () => {
      await ed((p) => window.__designerEditor.engine.setCurrentPage(p), other);
    }, 1500);
    await measure("1f change page back", async () => {
      await ed((p) => window.__designerEditor.engine.setCurrentPage(p), here);
    }, 2000);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await ed(() => window.__designerEditor.ui.set({ preview: null }));
  await sleep(500);
  res.heapUsedMs = await ed(() => {
    const t = performance.now();
    const used = window.__designerEditor.engine.heapUsed();
    return { ms: Math.round(performance.now() - t), usedMB: Math.round(used / 1048576), memMB: Math.round(window.__designerEditor.engine.memoryBytes() / 1048576) };
  });
  console.log("heapUsed read", JSON.stringify(res.heapUsedMs));
  await measure("3e idle 2s preview closed", async () => sleep(1500), 500);
  // 5. Prototype tab
  await measure("5a prototype tab open", async () => {
    await ed(() => window.__designerEditor.ui.set({ rightTab: "prototype" }));
  }, 1000);
  for (let i = 0; i < 4 && i < scr.length; i++) {
    await measure(`5b proto select ${i}`, async () => ed((id) => window.__designerEditor.engine.setSelection([id]), scr[(i * 5 + 1) % scr.length].id), 700);
  }
  await measure("5c select all on page (proto)", async () => ed(() => window.__designerEditor.engine.command("SELECT_ALL")), 1200);
  await ed(() => window.__designerEditor.engine.setSelection([]));
  await measure("5d pan with connections", async () => {
    const c = await ed(() => document.getElementById("engine-canvas").getBoundingClientRect().toJSON());
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    for (let k = 0; k < 40; k++) {
      await page.mouse.wheel(k < 20 ? 30 : -30, 20);
      await sleep(16);
    }
  }, 500);
  await ed(() => window.__designerEditor.ui.set({ rightTab: "design" }));
  await sleep(500);
  // 4. Present here
  await ed((id) => window.__designerEditor.engine.setSelection([id]), start.id);
  await measure("4a present here open", async () => {
    // The Present menu's "Present in this tab" (the editor's own command, as a click).
    await page.getByRole("button", { name: "Present options" }).click();
    await page.getByText("Present in this tab", { exact: true }).click();
    const r = "menu";
    await page.waitForFunction(() => window.__designerEditor.ui.get().presenting, null, { timeout: 5000 }).catch(async () => {
      console.log("present-here command didn't set presenting:", r);
      await ed(() => window.__designerEditor.ui.set({ presenting: { page: window.__designerEditor.store.page, node: window.__designerEditor.selection[0] ?? null } }));
    });
    await page.waitForFunction(() => window.__designerPresent && !window.__designerPresent.destroyed && window.__designerPresent.presentState().screen, null, { timeout: 30000 });
  }, 1200);
  await measure("4b present here close", async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !window.__designerEditor.ui.get().presenting, null, { timeout: 5000 }).catch(() => ed(() => window.__designerEditor.ui.set({ presenting: null })));
  }, 800);
  await ed(() => window.__designerEditor.focusCanvas());
  await measure("4e preview after present here", async () => {
    await page.keyboard.press("Shift+Space");
    await waitPreview();
  }, 1000);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  // 4. The Present tab
  if (!ONLY || ONLY.some((o) => "4c".startsWith(o) || o.startsWith("4c"))) {
    const t0 = Date.now();
    const before = (await debug()).views.map((v) => v.id);
    const r = await page.evaluate(async () => {
      const ed = window.__designerEditor;
      const fileKey = ed.source.fileKey;
      const t = performance.now();
      await ed.source.flush();
      const flushMs = performance.now() - t;
      const res = await window.designer.nav.openPrototype(fileKey, ed.store.page, ed.selection[0], "x");
      return { flushMs, res };
    });
    console.log("openPrototype", JSON.stringify(r));
    let tab;
    for (let k = 0; k < 200 && !tab; k++) {
      await sleep(50);
      tab = (await debug()).views.find((v) => !before.includes(v.id) && !v.spare);
    }
    if (!tab) console.log("views after present", JSON.stringify((await debug()).views.map((v) => [v.id, v.url])));
    const tp = await pageOfTab(tab.id);
    await tp.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().screen, null, { timeout: 60000 });
    res["4c present tab open ms"] = Date.now() - t0;
    const old = page;
    page = tp;
    await record(page);
    await sleep(1500);
    const lt = await tp.evaluate(() => performance.getEntriesByType("navigation")[0]?.duration);
    console.log("4c present tab open (click → screen)", Date.now() - t0, "ms; nav", lt);
    for (let i = 0; i < 8; i++) {
      const h = await tp.evaluate(() => {
        const pe = window.__designerPresent;
        const c = document.getElementById("present-canvas");
        const r = c.getBoundingClientRect();
        const st = pe.presentState();
        const sr = st.screenRect ?? { x: 0, y: 0, w: r.width, h: r.height };
        const pts = [];
        for (let y = sr.y + 4; y < sr.y + sr.h; y += 14)
          for (let x = sr.x + 4; x < sr.x + sr.w; x += 14) {
            pe.presentPointer(1, x, y, 0, 0);
            if (pe.presentState().hotspot) pts.push([r.left + x, r.top + y]);
          }
        return { name: st.screenName, pts };
      });
      if (!h.pts.length) break;
      const p = h.pts[Math.floor(h.pts.length / 2)];
      await measure(`4d tab click ${i} ${h.name}`.slice(0, 34), async () => {
        await tp.mouse.click(p[0], p[1]);
      }, 900);
    }
    page = old;
  }
  out(`${which}-${tag}`, res);
} catch (e) {
  console.error(e);
  out(`${which}-${tag}-partial`, res);
} finally {
  await close();
}
