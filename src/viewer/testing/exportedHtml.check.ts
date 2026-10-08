// The exported preview, end to end in headless Chromium (npm run viewer:check, after build:viewer): a synthetic file's
// derived snapshot packaged by the store's code into the built viewer page, written to disk and opened from file://
// — it must render (the frame, the image, both texts: the italic one from its stored outlines), select layers, show
// Dev Mode's Inspect (CSS with the variable's name, the text style), measure on hover and switch pages.
// Screenshots go to $TMPDIR/designer-viewer-check. One browser, closed in finally, under 180 s.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { inlinePreviewHtml } from "@shared/preview/html";
import { buildPreviewPackage } from "@shared/preview/package";
import { syntheticPreview } from "./synthetic";

const template = fileURLToPath(new URL("../../../out/viewer/index.html", import.meta.url));
const outDir = join(tmpdir(), "designer-viewer-check");

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse() : [])
    for (const sub of ["chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(cache, dir, sub);
      if (existsSync(p)) return p;
    }
  return undefined;
}

/** How much of a screen region differs from its first pixel (0…1), measured in the page from a screenshot. */
async function busyness(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) diff++;
    return diff / (d.length / 4);
  }, png.toString("base64"));
}

describe("the exported preview HTML (headless Chromium)", () => {
  it("opens from file://, renders, selects and inspects", async () => {
    if (!existsSync(template)) throw new Error("out/viewer/index.html is missing: npm run build:viewer");
    mkdirSync(outDir, { recursive: true });
    const { snapshot, image } = await syntheticPreview();
    const pkg = await buildPreviewPackage(
      { snapshot, fileName: "Synthetic", previewId: "c".repeat(22), now: Date.now(), options: { pageIds: "all", inspect: true, export: true, expiresInDays: 7 }, readImage: async (s) => (s === image.sha1 ? image.bytes : null) },
      { deflateRaw: (d) => new Uint8Array(deflateRawSync(d)) },
    );
    const file = join(outDir, "Synthetic.html");
    writeFileSync(file, inlinePreviewHtml(readFileSync(template, "utf8"), pkg));

    const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const problems: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") problems.push(`console: ${m.text()}`);
      });
      await page.goto(pathToFileURL(file).href);
      await page.waitForSelector("[data-viewer][data-ready]", { timeout: 30_000 });
      await page.waitForTimeout(800);
      expect(await page.title()).toBe("Synthetic – Developer preview");
      await page.screenshot({ path: join(outDir, "01-opened.png") });

      // The canvas renders the page: a busy picture, not one flat colour.
      const canvas = (await page.locator("#engine-canvas").boundingBox())!;
      expect(await busyness(page, await page.screenshot({ clip: canvas }))).toBeGreaterThan(0.02);

      // Select the card from the Layers panel, zoom to it: the Inspect panel shows its CSS and its variable by name.
      await page.locator('[data-ds="LayerRow"][data-id="1:1"]').click();
      await page.keyboard.press("Shift+Digit2");
      await page.waitForTimeout(400);
      const inspect = page.locator('[data-panel="inspect"]');
      await expect.poll(() => inspect.innerText()).toContain("Card");
      const text = await inspect.innerText();
      expect(text).toContain("Frame");
      expect(text).toContain("display: flex;");
      expect(text).toContain("width: 320px;");
      expect(text).toContain("padding: 16px 24px;");
      expect(text).toContain("background: var(--Surface, #FFF);");
      expect(text).toContain("Surface");
      expect(text).toContain("Export Card");
      await page.screenshot({ path: join(outDir, "02-card-inspect.png") });

      // Zoomed to the card: still a busy picture (the photo's bands, the texts).
      const zoomed = (await page.locator("#engine-canvas").boundingBox())!;
      expect(await busyness(page, await page.screenshot({ clip: zoomed }))).toBeGreaterThan(0.05);

      // Inspect the title (the card's row opened): typography with its text style.
      await page.locator('[data-ds="LayerRow"][data-id="1:1"] button[aria-expanded]').click();
      await page.locator('[data-ds="LayerRow"][data-id="1:2"]').click();
      await expect.poll(() => inspect.innerText()).toContain("Heading 1");
      const title = await inspect.innerText();
      expect(title).toContain("/* Heading 1 */");
      expect(title).toContain("font-family: Inter;");
      expect(title).toContain("font-weight: 700;");
      expect(title).toContain("line-height: 30px; /* 125% */");

      // SwiftUI and Compose.
      await page.locator('[data-panel="inspect"] [data-ds="Select"]').first().click();
      await page.getByRole("option", { name: "iOS (SwiftUI)" }).click();
      await expect.poll(() => inspect.innerText()).toContain('Text("Hello preview")');
      await page.locator('[data-panel="inspect"] [data-ds="Select"]').first().click();
      await page.getByRole("option", { name: "Android (Compose)" }).click();
      await expect.poll(() => inspect.innerText()).toContain("fontWeight = FontWeight(700)");
      await page.screenshot({ path: join(outDir, "03-title-compose.png") });

      // The italic caption is drawn though the viewer has no italic font: its region isn't blank.
      await page.locator('[data-ds="LayerRow"][data-id="1:4"]').click();
      await page.keyboard.press("Shift+Digit2");
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const c = (await page.locator("#engine-canvas").boundingBox())!;
      const centre = { x: c.x + c.width / 2 - 150, y: c.y + c.height / 2 - 40, width: 300, height: 80 };
      expect(await busyness(page, await page.screenshot({ clip: centre }))).toBeGreaterThan(0.02);
      await page.screenshot({ path: join(outDir, "04-italic-caption.png") });

      // Measurements: select the photo, hover the title.
      await page.keyboard.press("Shift+Digit1");
      await page.waitForTimeout(300);
      await page.locator('[data-ds="LayerRow"][data-id="1:3"]').click();
      await page.keyboard.press("Shift+Digit2");
      await page.waitForTimeout(400);
      // The title sits above the photo: scan upward from the photo for a hover that measures.
      const area = (await page.locator("#engine-canvas").boundingBox())!;
      let measured = "";
      for (let dy = 20; dy < 200 && !measured; dy += 10) {
        await page.mouse.move(area.x + area.width / 2 - 100, area.y + area.height / 2 - 60 - dy);
        await page.waitForTimeout(60);
        measured = await page.evaluate(() => document.querySelector("svg[data-measurements]")?.getAttribute("data-measurements") ?? "");
      }
      expect(measured).not.toBe("");
      await page.screenshot({ path: join(outDir, "05-measure.png") });

      // The second page.
      await page.getByRole("option", { name: "Second page" }).click();
      await expect.poll(() => page.locator('[data-ds="LayerRow"][data-id="1:40"]').count()).toBe(1);
      await page.screenshot({ path: join(outDir, "06-second-page.png") });

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 170_000);

  it("reads a published preview's files over HTTP (the Firebase Storage layout), and refuses an expired one", async () => {
    const { snapshot, image } = await syntheticPreview();
    const build = (expiresInDays: 7 | null, now: number) =>
      buildPreviewPackage(
        { snapshot, fileName: "Published", previewId: "h".repeat(22), now, options: { pageIds: ["0:3"], inspect: false, export: false, expiresInDays }, readImage: async (s) => (s === image.sha1 ? image.bytes : null) },
        { deflateRaw: (d) => new Uint8Array(deflateRawSync(d)) },
      );
    const live = await build(null, Date.now());
    const expired = await build(7, Date.now() - 8 * 86400000);
    const files = new Map<string, Uint8Array | string>([
      ["/index.html", readFileSync(template, "utf8")],
      ["/live/manifest.json", JSON.stringify(live.manifest)],
      ["/live/doc.kiwi", live.doc],
      ["/expired/manifest.json", JSON.stringify(expired.manifest)],
      ["/expired/doc.kiwi", expired.doc],
    ]);
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const body = files.get(path);
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": path.endsWith(".html") ? "text/html" : path.endsWith(".json") ? "application/json" : "application/octet-stream" }).end(body);
    });
    await new Promise<void>((r) => server.listen(5234, "127.0.0.1", r));
    const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:5234/index.html?src=/live/");
      await page.waitForSelector("[data-viewer][data-ready]", { timeout: 30_000 }).catch(async (e) => {
        throw new Error(`${(e as Error).message}\npage: ${await page.locator("body").innerText()}\nerrors: ${errors.join("\n")}`);
      });
      // Only the chosen page; Inspect off as published.
      await expect.poll(() => page.locator('[data-ds="LayerRow"]').count()).toBe(1);
      expect(await page.locator('[data-panel="inspect"]').innerText()).toContain("Inspect is off");
      await page.screenshot({ path: join(outDir, "07-published.png") });
      await page.goto("http://127.0.0.1:5234/index.html?src=/expired/");
      await expect.poll(() => page.locator("[data-viewer]").innerText()).toContain("This preview has expired");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
    }
  }, 170_000);
});
