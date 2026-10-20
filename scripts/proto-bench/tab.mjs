// The desktop's Present tab (its own process): open time (click → first screen) and playback, twice.
//   UD=<copy of the user data> node scripts/proto-bench/tab.mjs <fileKey | kahve | b2c>
import { launch, openFile, close, FILES, sleep, record, mark, report, debug, pageOfTab, SCR } from "./lib.mjs";
const which = process.argv[2] || "kahve";
try {
  await launch();
  await sleep(1500);
  const { page } = await openFile(FILES[which]);
  await sleep(3000);
  const scr = await page.evaluate(() => {
    const e = window.__designerEditor.engine;
    const pageId = window.__designerEditor.store.page;
    const out = [];
    const walk = (id) => {
      for (const c of e.readNode(id, { childIds: true }).childIds ?? []) {
        const k = e.readNode(c, { fields: ["type", "name"] });
        if (k.type === "SECTION") walk(c);
        else if (k.type === "FRAME") out.push({ id: c, name: k.name });
      }
    };
    walk(pageId);
    return out;
  });
  const start = scr.find((s) => /splash|home/i.test(s.name)) ?? scr[0];
  await page.evaluate((id) => window.__designerEditor.engine.setSelection([id]), start.id);
  for (let round = 0; round < 2; round++) {
    const before = (await debug()).views.map((v) => v.id);
    const t0 = Date.now();
    await page.evaluate(async () => {
      const ed = window.__designerEditor;
      await window.designer.nav.openPrototype(ed.source.fileKey, ed.store.page, ed.selection[0], "x");
    });
    let tab;
    for (let k = 0; k < 400 && !tab; k++) {
      await sleep(25);
      tab = (await debug()).views.find((v) => !before.includes(v.id) && v.id !== "spare" && !v.spare);
    }
    const tp = await pageOfTab(tab.id);
    await tp.waitForFunction(() => window.__designerPresent && window.__designerPresent.presentState().screen, null, { timeout: 60000, polling: 16 });
    const openMs = Date.now() - t0;
    const marks = await tp.evaluate(() => ({ nav: performance.timing.navigationStart, now: Date.now(), t: performance.now(), res: performance.getEntriesByType("resource").length, gfx: window.__designerPresent.gfx, nodes: window.__designerPresent.stats().nodes }));
    console.log(`round ${round}: present tab open ${openMs} ms (nav started ${marks.nav - t0} ms after the click; page alive ${Math.round(marks.t)} ms) gfx ${marks.gfx} nodes ${marks.nodes}`);
    await record(tp);
    await sleep(1500);
    for (let i = 0; i < 10; i++) {
      const h = await tp.evaluate(() => {
        const pe = window.__designerPresent;
        const c = document.querySelector("canvas");
        const r = c.getBoundingClientRect();
        const st = pe.presentState();
        const sr = st.screenRect ?? { x: 0, y: 0, w: r.width, h: r.height };
        const pts = [];
        for (let y = sr.y + 4; y < sr.y + sr.h; y += 14)
          for (let x = sr.x + 4; x < sr.x + sr.w; x += 14) {
            pe.presentPointer(1, x, y, 0, 0);
            if (pe.presentState().hotspot) pts.push([r.left + x, r.top + y]);
          }
        return { name: st.screenName, pts, rect: sr, canvas: [r.width, r.height] };
      });
      if (!h.pts.length) {
        console.log("no hotspot", JSON.stringify(h).slice(0, 200));
        await tp.evaluate(() => window.__designerPresent.presentCommand("next"));
        await sleep(2500);
        continue;
      }
      const p = h.pts[(i * 7) % h.pts.length];
      const t = await mark(tp);
      await tp.mouse.click(p[0], p[1]);
      await sleep(900);
      const r = await report(tp, t);
      const after = await tp.evaluate(() => window.__designerPresent.presentState().screenName);
      console.log(`tab click ${i} ${h.name} → ${after}: maxGap ${r.maxGap} longTask ${r.longTaskMs} [${r.longTasks.join(",")}] p95 ${r.p95} over33 ${r.over33}`);
    }
    await tp.screenshot({ path: `${SCR}/proto-bench-tab-${which}-${round}.png` });
    // close the tab
    await (await import("./lib.mjs")).app.evaluate((_e, id) => globalThis.__designer.current().tabs.close?.(id), tab.id).catch((e) => console.log("close", e.message));
    await sleep(1500);
  }
} catch (e) {
  console.error(e);
} finally {
  await close();
}
