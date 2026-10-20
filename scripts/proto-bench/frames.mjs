// Prototype animations frame by frame (2026-10-20, docs/research/figma/live/2026-10-20/prototype-playback.txt
// "Whole-file audit"): the built app's Present here on a frame, the page's clock virtual (performance.now and the
// animation frames' time held by the script), so a transition is shot at exact times after its input — the same
// times as live Figma's presentation shot with the same clock trick.
//
//   npm run build && UD=<copy of the user data> FRAME=1:3894 STEPS='[["move",494,240],["shots","hover",[0,100,200,400,1000]]]' \
//     SCREENSHOT_DIR=<dir> node scripts/proto-bench/frames.mjs
//   STEPS: ["move", x, y] / ["click", x, y] / ["down", x, y] / ["up"] — frame coordinates; the clock is frozen at
//   the input; ["shots", label, [ms…]] — the screen shot at each time after the last input; ["settle", ms] — real
//   time runs on for ms; ["key", name].
//   FILE=<fileKey> (the owner's "Prototype deneme"), PAGE=<page id>, SCALE=<window scale option>.
import * as path from "node:path";
import * as fs from "node:fs";
import { launch, openFile, close, sleep, SCR } from "./lib.mjs";
import * as lib from "./lib.mjs";

const FILE = process.env.FILE || "9wLJowqw1RD5F8DT2mB9Qe";
const PAGE = process.env.PAGE || "1:3531";
const FRAME = process.env.FRAME || "1:3894";
const STEPS = JSON.parse(process.env.STEPS || "[]");
const dir = path.join(SCR, "frames");
fs.mkdirSync(dir, { recursive: true });

try {
  await launch();
  await sleep(800);
  const { page } = await openFile(FILE);
  // The real cursor over the window would send its own pointer events whenever a screenshot is taken (a hover left
  // as the shot is made): the window ignores the system's mouse; the script's input still arrives.
  await lib.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)));
  await page.evaluate((p) => window.__designerEditor.engine.setCurrentPage(p), PAGE);
  await sleep(1200);
  // The virtual clock: animation frames and performance.now read window.__vt while it is set.
  await page.evaluate(() => {
    if (window.__vtInstalled) return;
    window.__vtInstalled = true;
    window.__vt = null;
    const realNow = performance.now.bind(performance);
    window.__realNow = realNow;
    performance.now = () => window.__vt ?? realNow();
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => cb(window.__vt ?? t));
  });
  if (process.env.PTRLOG)
    await page.evaluate(() => {
      window.__ptrLog = [];
      for (const t of ["pointermove", "pointerleave", "pointerout", "pointerover", "pointerdown", "pointerup"])
        document.addEventListener(t, (e) => window.__ptrLog.push([t, Math.round(e.clientX), Math.round(e.clientY), e.target?.id || e.target?.tagName]), true);
    });
  await page.evaluate((f) => window.__designerEditor.engine.setSelection([f]), FRAME);
  await page.getByRole("button", { name: "Present options" }).click();
  await page.getByText("Present in this tab", { exact: true }).click();
  await page.waitForFunction(() => window.__designerPresent?.presentState().screen, null, { timeout: 30000 });
  await sleep(1500);
  const geo = async () =>
    page.evaluate(() => {
      const pe = window.__designerPresent;
      const st = pe.presentState();
      const c = document.getElementById("present-canvas").getBoundingClientRect();
      const sr = st.screenRect;
      const w = pe.readNode(st.screen, { fields: ["size"] })?.size?.x ?? 1440;
      return { left: c.left + sr.x, top: c.top + sr.y, w: sr.w, h: sr.h, k: sr.w / w, screen: st.screen, name: st.screenName };
    });
  let g = await geo();
  console.log("screen", JSON.stringify(g));
  const pt = (x, y) => ({ x: g.left + x * g.k, y: g.top + y * g.k });
  const frames = (n) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  const freeze = () => page.evaluate(() => (window.__T = window.__realNow(), window.__vt = window.__T));
  const shot = async (file) => {
    g = await geo();
    await page.screenshot({ path: path.join(dir, file), clip: { x: g.left, y: g.top, width: g.w, height: g.h } });
  };
  await shot("start.png");
  for (const s of STEPS) {
    const [op, ...a] = s;
    if (op === "move" || op === "click" || op === "down") {
      await page.evaluate(() => (window.__vt = null));
      await sleep(100);
      const p = pt(a[0], a[1]);
      if (op === "move") {
        // A short glide in from where it was, the clock stopped from its start (the hover may begin on the way).
        const from = await page.evaluate(() => window.__lastMouse ?? null);
        await freeze();
        for (let i = 1; i <= 4; i++) {
          await page.mouse.move(from ? from.x + ((p.x - from.x) * i) / 4 : p.x, from ? from.y + ((p.y - from.y) * i) / 4 : p.y);
          await sleep(16);
        }
        await page.evaluate((q) => (window.__lastMouse = q), p);
      } else {
        await page.mouse.move(p.x, p.y);
        await page.evaluate((q) => (window.__lastMouse = q), p);
        await sleep(400);
        await freeze();
        await page.mouse.down();
        if (op === "click") await page.mouse.up();
      }
      await frames(4);
    } else if (op === "up") {
      await page.evaluate(() => (window.__vt = null));
      await freeze();
      await page.mouse.up();
      await frames(4);
    } else if (op === "key") {
      await page.keyboard.press(a[0]);
      await frames(4);
    } else if (op === "read") {
      // A layer as the presentation's engine has it now (its main, place and size).
      const n = await page.evaluate((id) => window.__designerPresent.readNode(id, { fields: ["symbolData", "transform", "size"] }), a[0]);
      console.log("read", a[0], JSON.stringify({ main: n?.symbolData?.symbolID, t: n?.transform && [n.transform.m02, n.transform.m12], size: n?.size }));
      if (process.env.PTRLOG) console.log("pointer events", await page.evaluate(() => JSON.stringify((window.__ptrLog ?? []).splice(0))));
    } else if (op === "settle") {
      await page.evaluate(() => (window.__vt = null));
      await sleep(a[0]);
    } else if (op === "shots") {
      const [label, times] = a;
      for (const ms of times) {
        // In frames of at most 16 ms: the player's clock takes at most 1/30 s a frame.
        await page.evaluate(
          (ms) =>
            new Promise((r) => {
              const to = window.__T + ms;
              const f = () => {
                if (window.__vt >= to) return r();
                window.__vt = Math.min(to, window.__vt + 16);
                requestAnimationFrame(f);
              };
              f();
            }),
          ms,
        );
        await frames(3);
        await shot(`${label}-${String(ms).padStart(4, "0")}.png`);
      }
    }
  }
  await page.evaluate(() => (window.__vt = null));
  console.log("shots in", dir);
} catch (e) {
  console.error(e);
} finally {
  await close();
}
