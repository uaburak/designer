// Drives the built app (out/) with Playwright: launch it, look at it, click through it.
//
//   npm run build                           # (`-- --mode demo` builds the same app)
//   node scripts/drive.mjs                  # a REPL — "help" lists the commands
//   node scripts/drive.mjs launch "ss home" new-file "ss file" quit
//   (unset ELECTRON_RUN_AS_NODE first if your shell has it: Electron would run as plain Node)
//
// The window is a set of views, each its own page and renderer process (docs/desktop-impl.md):
// the tab bar (`?tabbar`), Home (`?files`), one per open file (`?editor&file=<fileKey>&tab=<id>`) and the
// spare editor (`?editor`, pre-warmed, adopted by the next file that opens; `spare` prints it,
// `open-timing home|tabbar|<fileKey>` measures click → first canvas frame; DESIGNER_DISABLE_SPARE=1 turns it off).
// The store runs as a utility process (`store` prints it; `new-file`, `open-file`, `files` go through
// main's own store client). DESIGNER_SEED=demo puts the sample .fig files into a new workspace.
// Page commands act on a target — the content view in front unless told otherwise:
//   use tabbar | home | active | <tab id>     the target from now on
//   click @tabbar [data-tab-id]               this command only (any page command takes "@target" first)
// `ss` saves the whole window (the tab bar and the view in front, put together by main); `ss-view`
// one view's page. `tabs` prints main's tabs and each view's renderer process id. `menu <id>` runs a
// menu command (src/shared/commands.ts) through main's click path — keys typed into a page with
// `key` reach that page only, never the menu bar. `answer Close Anyway,Cancel` queues the answers to the next
// native dialogs (they are logged instead of shown).
//
// DESIGNER_EXECUTABLE runs a packaged app instead (npx electron-builder --mac --dir).
// Each run gets its own user data (DESIGNER_USER_DATA, a temp folder unless set), so the
// everyday app's workspace and windows are left alone. Screenshots go to SCREENSHOT_DIR
// (a temp folder unless set).
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), "designer-shots");
const USER_DATA = process.env.DESIGNER_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "designer-run-"));
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin =
  process.platform === "darwin"
    ? path.join(APP_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(APP_DIR, "node_modules/electron/dist/electron");

let app = null;
/** Pages whose renderer crashed: Playwright can't drive them again, even once main reloads the view */
const crashed = new WeakSet();
/** The default target of page commands */
let target = "active";

/** Main's view of the window (src/main/tabs.ts debug()). */
const debug = () => app.evaluate(() => globalThis.__designer.debug());

/** The tab a page's preload says it is (`desktop:init`): a tab's id, null for the spare, undefined when it can't say. */
const tabIdOf = (page) => page.evaluate(() => window.designer?.init?.().then((i) => i.tabId)).catch(() => undefined);

/** The page of a view: "tabbar", "home", "active" (the content view in front), "spare" or a tab's id. */
async function pageOf(which = target, timeout = 10_000) {
  if (!app) throw new Error("launch first");
  const deadline = Date.now() + timeout;
  for (;;) {
    let match;
    let id = null;
    if (which === "tabbar") match = (u) => new URL(u).searchParams.has("tabbar");
    else {
      // The view's page as main has it (Home is ?files; a file tab ?editor&file=…&tab=<id>; the spare, and a tab
      // that adopted one, plain ?editor).
      const d = await debug();
      id = which === "active" ? d?.shown : which;
      const url = d?.views.find((v) => v.id === id)?.url;
      match = (u) => Boolean(url) && u === url;
    }
    let pages = app.windows().filter((p) => {
      try {
        return match(p.url());
      } catch {
        return false;
      }
    });
    // Two pages at the same URL (an adopted spare and the next spare): the one whose preload names this tab.
    if (pages.length > 1 && id !== null) {
      const ids = await Promise.all(pages.map(tabIdOf));
      pages = pages.filter((_, i) => (id === "spare" ? ids[i] === null : ids[i] === id));
    }
    const page = pages.find((p) => !crashed.has(p));
    if (page) return page;
    if (pages.length) throw new Error(`the page of ${which} crashed (main reloaded it, Playwright can't drive it again) — main-eval and ss still work`);
    if (Date.now() > deadline) throw new Error(`no page for ${which}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** "@target rest…" → [target, rest] */
function split(args) {
  const m = /^@(\S+)\s*(.*)$/s.exec(args);
  return m ? [m[1], m[2]] : [target, args];
}

const COMMANDS = {
  async launch() {
    if (app) return console.log("already launched");
    // DESIGNER_EXECUTABLE: a packaged app (dist/mac-arm64/DesignerV2.app/Contents/MacOS/DesignerV2) instead of out/ with the dev Electron.
    const packaged = process.env.DESIGNER_EXECUTABLE;
    // The views are cross-origin isolated (COOP/COEP): their first load swaps the renderer process, and Playwright's
    // attach sometimes waits forever on the page target that went away (the app itself starts fine). A launch that
    // hangs is killed and tried again.
    // ELECTRON_RUN_AS_NODE (set by some Electron-based terminals) would start Electron as plain Node.
    const appEnv = { ...process.env, DESIGNER_USER_DATA: USER_DATA, DESIGNER_TEST: "1" };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    for (let attempt = 1; ; attempt++) {
      try {
        app = await electron.launch({
          executablePath: packaged || electronBin,
          args: packaged ? [] : [APP_DIR, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
          env: appEnv,
          // As the app runs: the renderers sandboxed, prefers-color-scheme the app's own (nativeTheme), not Playwright's "light".
          chromiumSandbox: process.platform !== "linux",
          colorScheme: null,
          timeout: 15_000,
        });
        break;
      } catch (e) {
        if (attempt >= 6 || !/Timeout/.test(e.message)) throw e;
        console.log(`launch: Playwright didn't attach in 15s — trying again (${attempt})`);
      }
    }
    app.on("console", (m) => (m.type() === "error" || m.type() === "warning" || /^\[(openExternal|dialog|home|editor|tabbar)[\] ]/.test(m.text())) && console.log(`[main ${m.type()}] ${m.text()}`));
    app.on("window", (p) => {
      p.on("pageerror", (e) => console.log(`[page error ${p.url()}]`, e.message));
      p.on("crash", () => crashed.add(p));
    });
    await app.firstWindow();
    const tabbar = await pageOf("tabbar", 15_000);
    await tabbar.waitForSelector("#root > :not(style)", { timeout: 15_000 }).catch(() => console.log("TIMEOUT: the tab bar rendered nothing"));
    const front = await pageOf("active", 15_000);
    await front.waitForSelector("#root > :not(style)", { timeout: 15_000 }).catch(() => console.log("TIMEOUT: the view in front rendered nothing"));
    await front.waitForTimeout(800);
    console.log("launched:", front.url(), "user data:", USER_DATA);
  },

  use(which) {
    target = which || "active";
    console.log("target:", target);
  },

  /** The whole window: the tab bar's view over the content view in front, put together by main (each view captured on its own). */
  async ss(name) {
    if (!app) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    const b64 = await app.evaluate(async ({ nativeImage }) => {
      const ctl = globalThis.__designer.current();
      const shots = [await ctl.tabbar.webContents.capturePage(), await ctl.tabs.activeView().webContents.capturePage()];
      // Raw BGRA rows of each (both the window's width), one under the other.
      const bitmaps = shots.map((img) => img.toBitmap());
      const { width: dipWidth, height: dipHeight } = shots[1].getSize();
      const scale = Math.sqrt(bitmaps[1].length / 4 / (dipWidth * dipHeight)) || 1;
      const width = Math.round(dipWidth * scale);
      const height = bitmaps.reduce((h, b) => h + b.length / 4 / width, 0);
      return nativeImage.createFromBitmap(Buffer.concat(bitmaps), { width, height, scaleFactor: scale }).toPNG().toString("base64");
    });
    fs.writeFileSync(f, Buffer.from(b64, "base64"));
    console.log("screenshot:", f);
  },

  /** One view's page: ss-view [@target] name */
  async "ss-view"(args) {
    const [which, name] = split(args);
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    await (await pageOf(which)).screenshot({ path: f });
    console.log("screenshot:", f);
  },

  /** Main's tabs, the one in front, and each view's renderer process. */
  async tabs() {
    if (!app) return console.log("ERROR: launch first");
    const d = await debug();
    const pid = await app.evaluate(() => globalThis.__designer.current().tabbar.webContents.getOSProcessId());
    const what = (t) => `${t.kind}:${t.fileKey}`;
    console.log(`active: ${d.state.active}  shown: ${d.shown}  closed: ${d.state.closed.map(what).join(", ") || "-"}`);
    console.log(` tabbar  pid ${pid}`);
    for (const v of d.views) {
      const tab = d.state.tabs.find((t) => t.id === v.id);
      console.log(` ${v.visible ? "*" : " "} ${v.id.padEnd(10)} ${v.role.padEnd(6)} pid ${String(v.pid).padEnd(6)} wc ${v.webContentsId}${tab ? `  ${what(tab)} "${tab.title}" ${tab.status}` : `  ${new URL(v.url).search}${v.spare ? ` (spare, ${v.loading ? "loading" : "loaded"})` : ""}`}`);
    }
    for (const t of d.state.tabs.filter((t) => !d.views.some((v) => v.id === t.id))) console.log(`   ${t.id.padEnd(10)} (no view) ${what(t)} "${t.title}" ${t.status}`);
    console.log(` order: ${["home", ...d.state.tabs.map((t) => t.title)].join(" | ")}`);
  },

  /** The spare editor (docs/desktop.md §3.1): whether one is waiting, its process, whether its page has loaded. */
  async spare() {
    if (!app) return console.log("ERROR: launch first");
    const d = await debug();
    const s = d.views.find((v) => v.spare);
    if (!s) return console.log(`spare: none${d.spareEnabled === false ? " (DESIGNER_DISABLE_SPARE=1)" : ""}`);
    console.log(`spare: wc ${s.webContentsId} pid ${s.pid} ${s.loading ? "loading" : "loaded"}, made ${((Date.now() - s.since) / 1000).toFixed(1)}s ago  ${new URL(s.url).search}`);
  },

  /**
   * Click → first canvas frame of a file opened from Home (`open-timing home`: a double click on the first card),
   * from the tab bar (`open-timing tabbar`: "+", a new file) or by key (`open-timing <fileKey>`, main's open path):
   * main's time of the open (`nav:open-file` / `nav:new-file`), the page's marks (`window.__designerOpen`:
   * attached, store source open, editor ready, first frame), and whether the spare was adopted — the tab's view is
   * the spare that was waiting before the click.
   */
  async "open-timing"(arg) {
    if (!app) return console.log("ERROR: launch first");
    const how = arg || "home";
    const before = await debug();
    const spareBefore = before.views.find((v) => v.spare) ?? null;
    const lastBefore = before.opens.at(-1) ?? null;
    const fileCard = '[data-collection-item][data-id^="file:"]';
    if (how === "home") {
      // A fresh workspace starts on an empty Recents (DESIGNER_SEED=demo puts the samples in a "Samples" folder): a folder
      // with files is shown first — a folder card in the view, else the sidebar's Samples (or Drafts).
      const home = await pageOf("home");
      if (!(await home.waitForSelector(fileCard, { timeout: 2_000 }).catch(() => null))) {
        const folderCard = await home.$('[data-collection-item][data-id^="folder:"]');
        if (folderCard) await folderCard.dblclick();
        else {
          // A real click (the sidebar's rows act on pointer events) on the first of these the sidebar has.
          let picked = null;
          for (const name of ["Samples", "Drafts"]) {
            const item = home.getByText(name, { exact: true }).first();
            if (await item.count()) {
              await item.click({ timeout: 5_000 });
              picked = name;
              break;
            }
          }
          if (!picked) return console.log("open-timing home: Home shows no file, no folder, and no Samples or Drafts in the sidebar");
        }
        await home.waitForSelector(fileCard, { timeout: 5_000 });
        // The cards are in; a moment for the thumbnails and the selection model to settle before the double click.
        await home.waitForTimeout(300);
      }
    }
    const t0 = Date.now();
    if (how === "home") await (await pageOf("home")).dblclick(fileCard, { timeout: 5_000 });
    else if (how === "tabbar") await (await pageOf("tabbar")).click('button[aria-label="New design file"]', { timeout: 5_000 });
    else await app.evaluate((_e, k) => globalThis.__designer.current().tabs.openFile({ fileKey: k }), how);
    // The open as main saw it, then the page's marks (the frame is on screen within a few seconds; a slow machine gets 30).
    const deadline = Date.now() + 30_000;
    let open;
    for (;;) {
      const last = (await debug()).opens.at(-1) ?? null;
      if (last && (!lastBefore || last.tabId !== lastBefore.tabId || last.at !== lastBefore.at)) {
        open = last;
        break;
      }
      if (Date.now() > deadline) return console.log("open-timing: main recorded no open in 30s");
      await new Promise((r) => setTimeout(r, 25));
    }
    const page = await pageOf(open.tabId, 15_000);
    let marks = null;
    while (Date.now() < deadline) {
      marks = await page.evaluate(() => window.__designerOpen ?? null).catch(() => null);
      if (marks?.firstFrame !== undefined) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const after = await debug();
    const view = after.views.find((v) => v.id === open.tabId);
    const ms = (m) => (marks && m !== undefined ? `${Math.round(marks.timeOrigin + m - open.at)} ms` : "—");
    const adopted = open.adopted && spareBefore && spareBefore.webContentsId === open.webContentsId;
    console.log(`open-timing ${how}: tab ${open.tabId} (${open.fileKey}); the driver's click reached main after ${open.at - t0} ms`);
    console.log(`  main open → attached ${ms(marks?.attached)}, source opened ${ms(marks?.sourceOpened)}, editor ready ${ms(marks?.ready)}, first frame ${ms(marks?.firstFrame)}${marks?.firstFrame === undefined ? " (no first frame in 30s)" : ""}`);
    console.log(`  spare: ${adopted ? "ADOPTED" : open.adopted ? "adopted (but not the one seen before the click)" : "not adopted"} — before: ${spareBefore ? `wc ${spareBefore.webContentsId} pid ${spareBefore.pid}` : "none"}; the tab's view: wc ${view?.webContentsId} pid ${view?.pid}`);
    console.log(`  TIMING ${JSON.stringify({ how, adopted: Boolean(adopted), mainToDriver: open.at - t0, attached: marks?.attached === undefined ? null : Math.round(marks.timeOrigin + marks.attached - open.at), sourceOpened: marks?.sourceOpened === undefined ? null : Math.round(marks.timeOrigin + marks.sourceOpened - open.at), ready: marks?.ready === undefined ? null : Math.round(marks.timeOrigin + marks.ready - open.at), firstFrame: marks?.firstFrame === undefined ? null : Math.round(marks.timeOrigin + marks.firstFrame - open.at) })}`);
  },

  /** The store's utility process: its pid, generation, workspace, the views it has ports for, and what it says about itself. */
  async store() {
    if (!app) return console.log("ERROR: launch first");
    const s = await app.evaluate(async () => {
      const d = globalThis.__designer;
      const client = d.storeClient();
      const info = client ? await Promise.race([client.store.info().catch((e) => ({ error: String(e) })), new Promise((r) => setTimeout(() => r({ error: "no answer in 5s" }), 5000))]) : null;
      return { ...d.store(), info };
    });
    console.log(JSON.stringify(s, null, 1));
  },

  /** A new design file through main (as Home's "New design file" does): new-file [name] */
  async "new-file"(name) {
    if (!app) return console.log("ERROR: launch first");
    console.log("new-file ->", JSON.stringify(await app.evaluate((_e, n) => globalThis.__designer.current().tabs.newFile({ name: n || undefined }), name)));
  },

  /** A workspace file in a tab (nav:open-file): open-file <fileKey> */
  async "open-file"(fileKey) {
    if (!app) return console.log("ERROR: launch first");
    console.log("open-file ->", JSON.stringify(await app.evaluate((_e, k) => globalThis.__designer.current().tabs.openFile({ fileKey: k }), fileKey)));
  },

  /** The workspace's files (main's store client): files [recents|drafts|trash] */
  async files(where) {
    if (!app) return console.log("ERROR: launch first");
    const list = await app.evaluate(async (_e, w) => (await globalThis.__designer.storeClient().workspace.listFiles({ in: w || "drafts" })).map((f) => ({ fileKey: f.fileKey, name: f.name, trashedAt: f.trashedAt })), where);
    for (const f of list) console.log(` ${f.fileKey}  "${f.name}"${f.trashedAt ? " (trash)" : ""}`);
    if (!list.length) console.log(" (none)");
  },

  /**
   * Home's card image for a file (or the first card): loaded, and not blank — sampled on a canvas, it must hold
   * more than one colour, and a real share of pixels unlike the most common one. thumb [fileKey]
   */
  async thumb(fileKey) {
    const home = await pageOf("home");
    const r = await home.evaluate(async (key) => {
      const card = key ? document.querySelector(`[data-id="file:${key}"]`) : document.querySelector('[data-id^="file:"]');
      if (!card) return { error: "no card" };
      const img = card.querySelector("img");
      if (!img) return { error: "the card has no image (no thumbnail saved)" };
      if (!img.complete) await new Promise((res) => img.addEventListener("load", res, { once: true }));
      if (!img.naturalWidth) return { error: `the image didn't load: ${img.src}` };
      // The same URL again with CORS (main's _thumb answers it): under the dev server it is cross-origin, and a canvas
      // that drew it plainly couldn't be read.
      const copy = new Image();
      copy.crossOrigin = "anonymous";
      copy.src = img.src;
      await copy.decode();
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = 60;
      const g = c.getContext("2d");
      g.drawImage(copy, 0, 0, c.width, c.height);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const counts = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const k = `${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3},${px[i + 3] >> 3}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const total = px.length / 4;
      const top = Math.max(...counts.values());
      return { src: img.src, size: `${img.naturalWidth}×${img.naturalHeight}`, colours: counts.size, other: Math.round((100 * (total - top)) / total) };
    }, fileKey || null);
    if (r.error) return console.log("thumb: FAIL —", r.error);
    const ok = r.colours > 1 && r.other >= 2;
    console.log(`thumb: ${ok ? "OK" : "FAIL — blank"} ${r.size}, ${r.colours} colours, ${r.other}% unlike the most common (${r.src})`);
  },

  /** The state as JSON (for scripted checks). */
  async state() {
    if (!app) return console.log("ERROR: launch first");
    console.log(JSON.stringify(await debug()));
  },

  // A DOM click (not coordinates): the element's own .click().
  async click(args) {
    const [which, sel] = split(args);
    const page = await pageOf(which);
    console.log("click", sel, "->", await page.evaluate((s) => (document.querySelector(s) ? (document.querySelector(s).click(), "OK") : "NOT_FOUND"), sel));
  },

  async "click-text"(args) {
    const [which, text] = split(args);
    const page = await pageOf(which);
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return "NOT_FOUND";
      el.click();
      return `OK: ${el.tagName}`;
    }, text);
    console.log("click-text", JSON.stringify(text), "->", r);
  },

  /** A real mouse click at the middle of the first element matching the selector (what a person does). */
  async press(args) {
    const [which, sel] = split(args);
    try {
      await (await pageOf(which)).click(sel, { timeout: 5_000 });
      console.log("press", sel, "-> OK");
    } catch (e) {
      console.log("press", sel, "->", e.message.split("\n")[0]);
    }
  },

  /** A real double click (opening a file on Home). */
  async dblpress(args) {
    const [which, sel] = split(args);
    try {
      await (await pageOf(which)).dblclick(sel, { timeout: 5_000 });
      console.log("dblpress", sel, "-> OK");
    } catch (e) {
      console.log("dblpress", sel, "->", e.message.split("\n")[0]);
    }
  },

  /** A real drag with the mouse, in the target view's points: drag [@target] x1 y1 x2 y2. */
  async drag(args) {
    const [which, rest] = split(args);
    const page = await pageOf(which);
    const [x1, y1, x2, y2] = rest.split(/\s+/).map(Number);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
    await page.mouse.move(x2, y2, { steps: 5 });
    await page.mouse.up();
    console.log("drag", x1, y1, "->", x2, y2);
  },

  /** A file tab dragged in the tab bar with the mouse: drag-tab <from> <to> (file tabs counted from 1, as ⌘2 is the first). */
  async "drag-tab"(args) {
    const [from, to] = args.split(/\s+/).map(Number);
    const bar = await pageOf("tabbar");
    const rects = await bar.evaluate(() => [...document.querySelectorAll("[data-tab-id]")].map((e) => e.getBoundingClientRect().toJSON()));
    const a = rects[from - 1];
    const b = rects[to - 1];
    if (!a || !b) return console.log("drag-tab: no such tab", rects.length, "tabs");
    const y = a.y + a.height / 2;
    const x2 = to > from ? b.x + b.width - 4 : b.x + 4;
    await bar.mouse.move(a.x + a.width / 2, y);
    await bar.mouse.down();
    await bar.mouse.move((a.x + a.width / 2 + x2) / 2, y, { steps: 6 });
    await bar.mouse.move(x2, y, { steps: 6 });
    await bar.mouse.up();
    console.log("drag-tab", from, "->", to);
  },

  /** A real click at a point of the target view: click-at [@target] x y. */
  async "click-at"(args) {
    const [which, rest] = split(args);
    const [x, y] = rest.split(/\s+/).map(Number);
    await (await pageOf(which)).mouse.click(x, y);
    console.log("click-at", x, y);
  },

  /** Ask the window to close, as its red button does (main asks about unsaved tabs first). */
  async close() {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.close());
    console.log("close asked");
  },

  /** Links the app would open in the browser are printed instead. */
  async "stub-browser"() {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => console.log(`[openExternal] ${url}`);
    });
    console.log("browser stubbed: openExternal prints its URL");
  },

  async alive() {
    if (!app) return console.log("ERROR: launch first");
    console.log("windows open:", await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length));
  },

  async key(args) {
    const [which, combo] = split(args);
    await (await pageOf(which)).keyboard.press(combo);
  },
  async type(args) {
    const [which, text] = split(args);
    await (await pageOf(which)).keyboard.type(text, { delay: 20 });
  },
  async sleep(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 1000));
  },

  async wait(args) {
    const [which, sel] = split(args);
    try {
      await (await pageOf(which)).waitForSelector(sel, { timeout: 10_000 });
      console.log("found:", sel);
    } catch (e) {
      console.log("TIMEOUT:", sel, e.message.split("\n")[0]);
    }
  },

  async eval(args) {
    const [which, expr] = split(args);
    try {
      console.log(JSON.stringify(await (await pageOf(which)).evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  /** Runs in main: main-eval <expression> — `electron` is Electron's module, `globalThis.__designer` the window's tabs */
  async "main-eval"(expr) {
    if (!app) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await app.evaluate((electron, src) => new Function("electron", `return (${src});`)(electron), expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  /** A menu command, as the menu bar would run it (src/shared/commands.ts): file.close-tab, window.next-tab, file.save… */
  async menu(id) {
    if (!app) return console.log("ERROR: launch first");
    console.log("menu", id, "->", await app.evaluate((_e, cmd) => globalThis.__designer.command(cmd), id));
  },

  /** The answers to the next native dialogs, by button label: answer Save,Cancel */
  async answer(labels) {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate((_e, list) => globalThis.__designer.answers.push(...list), labels.split(",").map((s) => s.trim()).filter(Boolean));
    console.log("answers queued:", labels);
  },

  /** The native dialogs asked so far, and their answers. */
  async asked() {
    if (!app) return console.log("ERROR: launch first");
    for (const a of await app.evaluate(() => globalThis.__designer.asked)) console.log(` “${a.message}” [${a.buttons.join(" / ")}] → ${a.answer}`);
  },

  async text(args) {
    const [which, sel] = split(args);
    console.log(await (await pageOf(which)).evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)", sel || null));
  },

  /** Playwright's pages (one per view) */
  async pages() {
    if (!app) return console.log("ERROR: launch first");
    for (const p of app.windows()) console.log(` ${crashed.has(p) ? "(crashed) " : ""}${p.url()}`);
  },

  async windows() {
    if (!app) return console.log("ERROR: launch first");
    const wcs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, type: w.getType(), url: w.getURL(), pid: w.getOSProcessId() })));
    for (const w of wcs) console.log(` [${w.id}] ${w.type} pid ${w.pid}: ${w.url}`);
  },

  /** Quits as ⌘Q does — a file whose flush fails is let go (the native box answered "Quit Anyway") — or, stuck after 10s, killed. */
  async quit() {
    if (app) {
      const proc = app.process();
      await app
        .evaluate(() => {
          const answers = globalThis.__designer.answers;
          answers.length = 0;
          answers.push("Quit Anyway");
        })
        .catch(() => {});
      await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
      if (proc.exitCode === null && proc.signalCode === null) {
        console.log("quit: still running after 10s — killed");
        proc.kill("SIGKILL");
      }
    }
    app = null;
  },

  help() {
    console.log("commands:", Object.keys(COMMANDS).join(", "));
  },
};

async function run(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  const fn = COMMANDS[cmd];
  if (!fn) return console.log("unknown:", cmd, "— try: help");
  try {
    await fn(line.trim().slice(cmd.length).trim());
  } catch (e) {
    console.log("ERROR:", e.message);
  }
  void rest;
}

const script = process.argv.slice(2);
if (script.length) {
  for (const line of script) await run(line);
  await COMMANDS.quit();
  process.exit(0);
}

// Electron would take stdin: the REPL reads the raw descriptor.
const input = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
const rl = readline.createInterface({ input, output: process.stdout, prompt: "driver> " });
rl.on("line", async (line) => {
  await run(line);
  if (line.trim() === "quit") {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});
rl.on("close", async () => {
  await COMMANDS.quit();
  process.exit(0);
});
console.log('DesignerV2 driver — "help" for commands, "launch" to start');
rl.prompt();
