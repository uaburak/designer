// Drives the built app (out/) with Playwright: launch it, look at it, click through it.
//
//   npm run build -- --mode demo            # the demo's data: no Firebase, no sign-in
//   node scripts/drive.mjs                  # a REPL — "help" lists the commands
//   node scripts/drive.mjs launch "ss home" "click-text All projects" "ss all" quit
//
// DESIGNER_EXECUTABLE runs a packaged app instead (npx electron-builder --mac --dir).
// Each run gets its own user data (DESIGNER_USER_DATA, a temp folder unless set), so the
// everyday app's sign-in and windows are left alone. Screenshots go to SCREENSHOT_DIR
// (a temp folder unless set). A tab's page is a frame of the window: `frame-eval` runs in
// the one in front.
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
let page = null;

/** The frame of the tab in front (the shell's iframe that is visible), or null on Home. */
async function activeFrame() {
  const handle = await page.$("iframe:not(.invisible)");
  return handle ? handle.contentFrame() : null;
}

const COMMANDS = {
  async launch() {
    if (app) return console.log("already launched");
    // DESIGNER_EXECUTABLE: a packaged app (dist/mac-arm64/DesignerV2.app/Contents/MacOS/DesignerV2) instead of out/ with the dev Electron.
    const packaged = process.env.DESIGNER_EXECUTABLE;
    app = await electron.launch({
      executablePath: packaged || electronBin,
      args: packaged ? [] : [APP_DIR, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
      env: { ...process.env, DESIGNER_USER_DATA: USER_DATA },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    app.on("console", (m) => (m.type() === "error" || m.type() === "warning" || m.text().startsWith("[openExternal]")) && console.log(`[main ${m.type()}] ${m.text()}`));
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[page ${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => console.log("[page error]", e.message));
    await page.waitForSelector("#root > *", { timeout: 15_000 }).catch(() => console.log("TIMEOUT: nothing rendered"));
    await page.waitForTimeout(800);
    console.log("launched:", page.url(), "user data:", USER_DATA);
  },

  async ss(name) {
    if (!page) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
    await page.screenshot({ path: f });
    console.log("screenshot:", f);
  },

  // A DOM click (not coordinates): the element's own .click().
  async click(sel) {
    if (!page) return console.log("ERROR: launch first");
    console.log("click", sel, "->", await page.evaluate((s) => (document.querySelector(s) ? (document.querySelector(s).click(), "OK") : "NOT_FOUND"), sel));
  },

  async "click-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return "NOT_FOUND";
      el.click();
      return `OK: ${el.tagName}`;
    }, text);
    console.log("click-text", JSON.stringify(text), "->", r);
  },

  /** A real mouse click at the middle of the first element matching the selector (what a person does). */
  async press(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.click(sel, { timeout: 5_000 });
      console.log("press", sel, "-> OK");
    } catch (e) {
      console.log("press", sel, "->", e.message.split("\n")[0]);
    }
  },

  /** A real drag with the mouse, in the window's points: drag x1 y1 x2 y2 (a tab's canvas gets it as a person's). */
  async drag(args) {
    if (!page) return console.log("ERROR: launch first");
    const [x1, y1, x2, y2] = args.split(/\s+/).map(Number);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
    await page.mouse.move(x2, y2, { steps: 5 });
    await page.mouse.up();
    console.log("drag", x1, y1, "->", x2, y2);
  },

  /** A real click at a point of the window: click-at x y. */
  async "click-at"(args) {
    if (!page) return console.log("ERROR: launch first");
    const [x, y] = args.split(/\s+/).map(Number);
    await page.mouse.click(x, y);
    console.log("click-at", x, y);
  },

  /** Ask the window to close, as its red button does (the page may ask about unsaved tabs first). */
  async close() {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    console.log("close asked");
  },

  /** Links the app would open in the browser are printed instead (e.g. the sign-in page's address, to open by hand). */
  async "stub-browser"() {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => console.log(`[openExternal] ${url}`);
    });
    console.log("browser stubbed: openExternal prints its URL");
  },

  async alive() {
    if (!app) return console.log("ERROR: launch first");
    console.log("windows open:", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length));
  },

  async key(combo) {
    if (page) await page.keyboard.press(combo);
  },
  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 20 });
  },
  async sleep(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 1000));
  },

  async wait(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.waitForSelector(sel, { timeout: 10_000 });
      console.log("found:", sel);
    } catch {
      console.log("TIMEOUT:", sel);
    }
  },

  async eval(expr) {
    if (!page) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  async "frame-eval"(expr) {
    if (!page) return console.log("ERROR: launch first");
    const frame = await activeFrame();
    if (!frame) return console.log("ERROR: no tab in front (Home)");
    try {
      console.log(JSON.stringify(await frame.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  /** The app's menu, as the menu bar would send it (see src/main/menu.ts): new-project, close-tab, next-tab, save… */
  async menu(command) {
    if (!app) return console.log("ERROR: launch first");
    await app.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]?.webContents.send("menu:command", cmd), command);
    console.log("menu", command);
  },

  async text(sel) {
    if (!page) return console.log("ERROR: launch first");
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)", sel || null));
  },

  async windows() {
    if (!app) return console.log("ERROR: launch first");
    const wcs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, type: w.getType(), url: w.getURL() })));
    for (const w of wcs) console.log(` [${w.id}] ${w.type}: ${w.url}`);
    for (const f of page.frames()) console.log("  frame:", f.url());
  },

  async quit() {
    if (app) await app.close().catch(() => {});
    app = null;
    page = null;
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
    await fn(rest.join(" "));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
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
