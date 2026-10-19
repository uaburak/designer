// The owner's 2026-10-19 round: Manage libraries as live Figma's (docs/research/figma/live/2026-10-18/menus.txt), the
// shared header drag of floating panels and modals, and Dev Mode's eyedropper — shot on the browser's dev store, dark,
// at 1440 × 900 (live's measurement window):
//   libraries-this-file.png       an unpublished App with Kit added: the banner, "Libraries added to this file", Remove
//   libraries-published.png       the Kit itself (published): its row with Unpublish / Publish changes…
//   libraries-updates.png         the Updates tab
//   drag-libraries.png            Manage libraries dragged by its header to the window's top-left (clamped)
//   drag-color-picker.png         the colour picker dragged past the window's right edge (clamped)
//   devmode-eyedropper-toolbar.png  Dev Mode's toolbar with the eyedropper slot active and the card on the canvas
//   devmode-eyedropper-copied.png   after a click: the toast, the selection's fill unchanged
//
//   node src/renderer/src/editor/tools/libraries-shot.mjs [outDir]   (default /tmp/designer-work/libraries)
//   SHOT_PORT=5318 (the vite server's port; never the owner's 3000)
/* global process, console, window, requestAnimationFrame, setTimeout, clearTimeout, localStorage */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/designer-work/libraries");
mkdirSync(outDir, { recursive: true });

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : [])
    for (const sub of ["chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = path.join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  return undefined;
}

const server = await createServer({ configFile: path.join(repo, "vite.web.config.ts"), mode: "demo", server: { port: Number(process.env.SHOT_PORT ?? 5318), strictPort: false, fs: { allow: [repo, realpathSync(path.join(repo, "node_modules"))] } }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const hardStop = setTimeout(async () => {
  console.error("libraries-shot: stopped after 180 s");
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(2);
}, 180_000);
hardStop.unref();

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("hardware_acceleration_disabled_warning_shown", "1");
    } catch {
      // storage blocked
    }
  });
  const open = async (query) => {
    await page.goto(`${base}/?editor${query}`);
    await page.waitForFunction(() => window.__designerEditor && !window.__designerEditor.engine.destroyed, null, { timeout: 20000 });
    await settle(page);
  };
  const shot = async (name) => {
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  };

  await open("&doc=empty");
  const keys = await page.evaluate(async (root) => {
    const s = await import("/src/store/index.ts");
    const { encodeMessage, newDocumentMessage } = await import(`/@fs${root}/src/shared/schema/codec.ts`);
    const { COMPONENTS_DOCUMENT } = await import("/src/editor/fixtures.ts");
    const api = s.getStoreClient();
    const mem = await s.getDevStore().ready;
    const folder = await api.workspace.createFolder({ name: "Design system", parentId: null });
    const add = async (name, doc) => (await mem.addFile({ name, folderId: folder.id, snapshot: encodeMessage(s.messageToKiwi(doc)) })).fileKey;
    return { kit: await add("Kit", COMPONENTS_DOCUMENT), app: await add("App", newDocumentMessage()) };
  }, repo);

  // The Kit publishes everything.
  await open(`&file=${keys.kit}`);
  await page.evaluate(async () => {
    const l = await import("/src/editor/libraries.ts");
    const ed = window.__designerEditor;
    const d = await l.draftPublish(ed);
    await l.publishLibrary(ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });
    await ed.libraries.refresh();
  });

  // ---- The App: Kit added; Manage libraries
  await open(`&file=${keys.app}`);
  await page.evaluate(async (kit) => {
    const l = await import("/src/editor/libraries.ts");
    await l.setLibraryEnabled(window.__designerEditor, kit, true);
    window.__designerEditor.ui.set({ librariesDialog: { tab: "libraries" } });
  }, keys.kit);
  await page.locator("[data-publish-banner]").waitFor({ timeout: 10000 });
  await page.locator('[data-library-row="Kit"] img').waitFor({ timeout: 5000 }).catch(() => {});
  await wait(300);
  await shot("libraries-this-file");
  const box = await page.locator('[data-ds="Dialog"]').boundingBox();
  check("Manage libraries: 591 × 641, centred", box && Math.round(box.width) === 591 && Math.round(box.height) === 641 && Math.abs(box.x + box.width / 2 - 720) <= 1, JSON.stringify(box));
  const nav = await page.locator("[data-libraries-dialog] nav").boundingBox();
  check("its nav is 200 wide under the 40 header and its line", nav && Math.round(nav.width) === 200 && Math.round(nav.y - box.y) === 41, JSON.stringify({ nav, box }));
  const row = await page.locator('[data-library-row="Kit"]').boundingBox();
  const thumb = await page.locator('[data-library-row="Kit"] [data-library-thumb]').boundingBox();
  check("a row 74 high, its thumbnail 102 × 58, the content 16 in from the nav (x 216)", row && Math.round(row.height) === 74 && thumb && Math.round(thumb.width) === 102 && Math.round(thumb.height) === 58 && Math.round(thumb.x - box.x) === 216, JSON.stringify({ row, thumb }));
  const remove = await page.locator('[data-library-row="Kit"]').getByRole("button", { name: "Remove" }).boundingBox();
  check("Remove ends 16 from the modal's right (575)", remove && Math.round(remove.x + remove.width - box.x) === 575, JSON.stringify(remove));
  const banner = await page.locator("[data-publish-banner]").boundingBox();
  check("the banner is 359 × 128 at 216", banner && Math.round(banner.width) === 359 && Math.round(banner.height) === 128 && Math.round(banner.x - box.x) === 216, JSON.stringify(banner));

  await page.locator('[data-libraries-tab="updates"]').click();
  await shot("libraries-updates");
  await page.locator('[data-libraries-tab="libraries"]').click();

  // ---- Drag: the header to the top-left, past the window (kept in)
  const header = page.locator('[data-ds="Dialog"] h2');
  const hb = await header.boundingBox();
  await page.mouse.move(hb.x + hb.width + 40, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(200, 300, { steps: 5 });
  await page.mouse.move(-400, -400, { steps: 5 });
  await page.mouse.up();
  const dragged = await page.locator('[data-ds="Dialog"]').boundingBox();
  check("Manage libraries dragged by its header, kept at the window's top-left", dragged && Math.round(dragged.x) === 0 && Math.round(dragged.y) === 0, JSON.stringify(dragged));
  await shot("drag-libraries");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__designerEditor.ui.set({ librariesDialog: null }));
  await page.evaluate(() => window.__designerEditor.ui.set({ librariesDialog: { tab: "libraries" } }));
  await page.locator("[data-libraries-dialog]").waitFor();
  await settle(page);
  const again = await page.locator('[data-ds="Dialog"]').boundingBox();
  check("reopened: centred again", again && Math.abs(again.x + again.width / 2 - 720) <= 1, JSON.stringify(again));
  await page.evaluate(() => window.__designerEditor.ui.set({ librariesDialog: null }));

  // ---- The published Kit's own view
  await open(`&file=${keys.kit}`);
  await page.evaluate(() => window.__designerEditor.ui.set({ librariesDialog: { tab: "libraries" } }));
  await page.locator('[data-library-row="current"]').waitFor({ timeout: 10000 });
  await wait(300);
  await shot("libraries-published");
  await page.evaluate(() => window.__designerEditor.ui.set({ librariesDialog: null }));

  // ---- The colour picker dragged past the right edge
  const layer = await page.evaluate(() => {
    const ed = window.__designerEditor;
    const page0 = ed.engine.readNode("0:1", { childIds: true });
    const id = page0.childIds.find((c) => (ed.engine.readNode(c).fillPaints ?? []).some((p) => p.type === "SOLID"));
    ed.engine.setSelection([id]);
    return id;
  });
  await settle(page);
  await page.locator('[data-paint-row="SOLID"] [data-ds="Swatch"], [data-paint-row="SOLID"] button').first().click();
  const picker = page.locator('[data-ds="Popover"]').first();
  await picker.waitFor({ timeout: 5000 });
  const pb = await picker.boundingBox();
  await page.mouse.move(pb.x + 150, pb.y + 20);
  await page.mouse.down();
  await page.mouse.move(pb.x + 600, pb.y + 120, { steps: 6 });
  await page.mouse.move(pb.x + 2000, pb.y + 140, { steps: 6 });
  await page.mouse.up();
  const pd = await picker.boundingBox();
  check(`the colour picker (on ${layer}) dragged by its header, kept at the window's right edge`, pd && Math.round(pd.x + pd.width) === 1440 && Math.round(pd.y) > Math.round(pb.y), JSON.stringify({ pb, pd }));
  await shot("drag-color-picker");
  await page.keyboard.press("Escape");

  // ---- Dev Mode's eyedropper
  await page.evaluate(async () => {
    const m = await import("/src/editor/devmode/devMode.ts");
    m.setMode(window.__designerEditor, "dev");
  });
  await settle(page);
  const slot = page.locator('[data-ds="EditorToolbar"], [role="toolbar"]').getByRole("radio", { name: /Pick color/ }).or(page.getByRole("button", { name: /Pick color/ })).first();
  check("Dev Mode's toolbar has the eyedropper slot", (await slot.count()) === 1);
  const before = await page.evaluate((id) => JSON.stringify(window.__designerEditor.engine.readNode(id).fillPaints), layer);
  // The slot (the I key is the layout's: a Turkish layout's I key types "ı", so the shot clicks the slot)
  await slot.click();
  await settle(page);
  check("the slot picks the eyedropper in Dev Mode", (await page.evaluate(() => window.__designerEditor.store.tool)) === "EYEDROPPER");
  const canvas = await page.evaluate(() => {
    const r = window.__designerEditor.canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const at = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  await page.mouse.move(at.x - 20, at.y - 20);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await wait(200);
  await shot("devmode-eyedropper-toolbar");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base }).catch(() => {});
  await page.mouse.down();
  await page.mouse.up();
  await page.getByText(/Copied .* to clipboard/).first().waitFor({ timeout: 5000 }).catch(() => {});
  await settle(page);
  await shot("devmode-eyedropper-copied");
  check("the pick shows the copy toast", (await page.getByText(/Copied .* to clipboard/).count()) > 0);
  const after = await page.evaluate((id) => JSON.stringify(window.__designerEditor.engine.readNode(id).fillPaints), layer);
  check("…and leaves the selection's fill", before === after);
  check("…and goes back to Move", (await page.evaluate(() => window.__designerEditor.store.tool)) === "MOVE");
} finally {
  clearTimeout(hardStop);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
console.log(`${failed ? `${failed} FAIL` : "all ok"} — ${outDir}`);
process.exit(failed ? 1 : 0);
