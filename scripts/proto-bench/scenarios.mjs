// A prototype's interactions shot frame by frame and timed, many in one run (2026-10-20, the owner's "Yeni Test
// Dosyası" against live Figma: docs/research/figma/live/2026-10-20/prototype-playback.txt §8). The built app's Present
// here on a copy of the user data; each scenario starts the player at its frame, then:
//   pass 1 — the page's clock virtual (as frames.mjs): the screen shot at exact times after each input;
//   pass 2 — real time, the same inputs again: frame gaps (p50 / p95 / max) and long tasks while it plays.
//
//   npm run build && UD=<copy> FILE=<fileKey> PAGE=<page id> SCEN=<scenarios.json> POINTS=<points.json> \
//     SCREENSHOT_DIR=<dir> node scripts/proto-bench/scenarios.mjs [name filter]
// scenarios.json: [{ name, start: "<frame name>", steps: [...] }]; a step is
//   ["click" | "move" | "down", "<frame name>/<layer name>" | [x, y]]   frame coordinates of the screen shown
//   ["up"]   ["key", "Enter"]   ["drag", from, dx, dy, ms]   ["wheel", at, dy]   ["settle", ms]
//   ["shots", label, [ms …]]   the screen at each time after the last input (pass 1; pass 2 records that long)
// POINTS: { pts: { "<frame>/<layer>": { x, y } } } — layer centres (the comparison's scratch tool writes it).
import * as path from "node:path";
import * as fs from "node:fs";
import { launch, openFile, close, sleep, SCR, record, report } from "./lib.mjs";
import * as lib from "./lib.mjs";

const FILE = process.env.FILE;
const PAGE = process.env.PAGE;
const SCEN = JSON.parse(fs.readFileSync(process.env.SCEN, "utf8"));
const PTS = JSON.parse(fs.readFileSync(process.env.POINTS, "utf8")).pts;
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const dir = path.join(SCR, "scenarios");
fs.mkdirSync(dir, { recursive: true });
const results = [];

try {
  await launch();
  await sleep(800);
  const { page } = await openFile(FILE);
  if (process.env.ENGINE_LOG) page.on("console", (m) => m.text().includes(process.env.ENGINE_LOG) && console.log(m.text()));
  await lib.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)));
  await page.evaluate((p) => window.__designerEditor.engine.setCurrentPage(p), PAGE);
  await sleep(1200);
  await page.evaluate(() => {
    if (window.__vtInstalled) return;
    window.__vtInstalled = true;
    window.__vt = null;
    const realNow = performance.now.bind(performance);
    window.__realNow = realNow;
    performance.now = () => window.__vt ?? realNow();
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => cb(window.__vt ?? t));
    // Timeouts set while the clock is held run on the held clock (the engine sleeps to its next After delay with a
    // timeout); released, they go back to real time.
    const realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
    const held = new Map();
    let seq = 1e9;
    window.setTimeout = (cb, ms = 0, ...args) => {
      if (window.__vt == null) return realSet(cb, ms, ...args);
      held.set(++seq, { cb: () => cb(...args), due: window.__vt + ms });
      return seq;
    };
    window.clearTimeout = (id) => (held.delete(id) ? undefined : realClear(id));
    window.__vtRun = () => {
      for (const [id, t] of [...held])
        if (t.due <= window.__vt) {
          held.delete(id);
          t.cb();
        }
    };
    window.__vtFlush = () => {
      for (const [id, t] of [...held]) {
        held.delete(id);
        realSet(t.cb, 0);
      }
    };
  });
  const frameOf = (name) => PTS[Object.keys(PTS).find((k) => k.startsWith(name + "/"))].frame;
  const first = SCEN.find((s) => !only || only.test(s.name));
  await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), frameOf(first.start));
  await page.getByRole("button", { name: "Present options" }).click();
  await page.getByText("Present in this tab", { exact: true }).click();
  await page.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 30000 });
  await sleep(1500);
  await record(page);
  const geo = async () =>
    page.evaluate(() => {
      const pe = window.__designerPresent;
      const st = pe.presentState();
      const c = document.getElementById("present-canvas").getBoundingClientRect();
      const sr = st.screenRect;
      const w = pe.readNode(st.screen, { fields: ["size"] })?.size?.x ?? 1440;
      return { left: c.left + sr.x, top: c.top + sr.y, w: sr.w, h: sr.h, k: sr.w / w, screen: st.screen, name: st.screenName, overlays: st.overlays ?? [] };
    });
  const frames = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const freeze = () => page.evaluate(() => (window.__T = window.__realNow(), window.__vt = window.__T));
  const thaw = () => page.evaluate(() => (window.__vt = null, window.__vtFlush()));
  const advance = (ms) =>
    page.evaluate(
      (ms) =>
        new Promise((r) => {
          const to = window.__T + ms;
          const f = () => {
            if (window.__vt >= to) return r();
            window.__vt = Math.min(to, window.__vt + 16);
            window.__vtRun();
            requestAnimationFrame(f);
          };
          f();
        }),
      ms,
    );
  for (const sc of SCEN) {
    if (only && !only.test(sc.name)) continue;
    const start = frameOf(sc.start);
    for (const pass of [1, 2]) {
      await thaw();
      // A fresh start at the scenario's frame: variables, overlays and history reset as a restart does.
      await page.evaluate(([pg, node]) => window.__designerPresent.presentStart({ page: pg, node }), [PAGE, start]);
      await sleep(700);
      let g = await geo();
      // A layer's centre as the player has laid it out now (its parents' transforms up to the screen); a layer the
      // walk doesn't reach (an instance's sublayer) keeps the file's point.
      const pt = async (a) => {
        let p = Array.isArray(a) ? { x: a[0], y: a[1] } : PTS[a];
        if (!p) throw new Error("no point " + a);
        if (!Array.isArray(a)) {
          const live = await page.evaluate(
            ([id, screen]) => {
              const pe = window.__designerPresent;
              const n = pe.readNode(id, { fields: ["size", "transform", "parentIndex"] });
              if (!n?.size) return null;
              let x = n.size.x / 2, y = n.size.y / 2;
              for (let c = n, i = 0; c && i < 40; i++) {
                const gid = (g) => (typeof g === "string" ? g : g ? `${g.sessionID}:${g.localID}` : null);
                const key = gid(c.guid);
                if (key === screen) return { x, y };
                x += c.transform?.m02 ?? 0;
                y += c.transform?.m12 ?? 0;
                const pg = c.parentIndex?.guid;
                c = pg ? pe.readNode(gid(pg), { fields: ["transform", "parentIndex"] }) : null;
              }
              return null;
            },
            [p.id, p.frame],
          );
          if (process.env.PTLOG) console.log("pt", a, JSON.stringify(p), JSON.stringify(live));
          if (live) p = live;
        }
        return { x: g.left + p.x * g.k, y: g.top + p.y * g.k };
      };
      const shot = async (file) => {
        g = await geo();
        await page.screenshot({ path: path.join(dir, file), clip: { x: g.left, y: g.top, width: g.w, height: g.h } });
      };
      let from = 0;
      const pace = [];
      if (pass === 1) await shot(`${sc.name}--start.png`);
      for (const s of sc.steps) {
        const [op, ...a] = s;
        if (op === "move" || op === "click" || op === "down") {
          await thaw();
          await sleep(100);
          g = await geo();
          const p = await pt(a[0]);
          await page.mouse.move(p.x, p.y, { steps: 4 });
          if (op !== "move") await sleep(300);
          if (pass === 1) await freeze();
          else from = await lib.mark(page);
          if (op !== "move") {
            await page.mouse.down();
            if (op === "click") await page.mouse.up();
          }
          if (pass === 1) await frames(4);
        } else if (op === "up") {
          await thaw();
          if (pass === 1) await freeze();
          else from = await lib.mark(page);
          await page.mouse.up();
          if (pass === 1) await frames(4);
        } else if (op === "key") {
          await thaw();
          if (pass === 1) await freeze();
          else from = await lib.mark(page);
          await page.keyboard.press(a[0]);
          if (pass === 1) await frames(4);
        } else if (op === "drag") {
          await thaw();
          g = await geo();
          const p = await pt(a[0]);
          await page.mouse.move(p.x, p.y);
          await page.mouse.down();
          const n = Math.max(4, Math.round((a[3] ?? 300) / 16));
          for (let i = 1; i <= n; i++) {
            await page.mouse.move(p.x + (a[1] * g.k * i) / n, p.y + (a[2] * g.k * i) / n);
            await sleep(16);
          }
          if (pass === 1) await freeze();
          else from = await lib.mark(page);
          await page.mouse.up();
          if (pass === 1) await frames(4);
        } else if (op === "wheel") {
          await thaw();
          g = await geo();
          const p = await pt(a[0]);
          await page.mouse.move(p.x, p.y);
          await page.mouse.wheel(0, a[1]);
          await sleep(400);
        } else if (op === "settle") {
          await thaw();
          await sleep(a[0]);
        } else if (op === "shots") {
          const [label, times] = a;
          if (pass === 1) {
            for (const ms of times) {
              await advance(ms);
              await frames(3);
              await shot(`${sc.name}--${label}-${String(ms).padStart(4, "0")}.png`);
            }
          } else {
            await sleep(Math.max(...times) + 300);
            pace.push({ label, ...(await report(page, from)) });
          }
        }
      }
      if (pass === 1) {
        const st = await page.evaluate(() => window.__designerPresent.presentState());
        results.push({ name: sc.name, end: st.screenName, overlays: st.overlays?.length ?? 0 });
      } else results.at(-1).pace = pace;
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  await thaw();
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 1));
  console.log("shots in", dir);
} catch (e) {
  console.error(e);
} finally {
  await close();
}
