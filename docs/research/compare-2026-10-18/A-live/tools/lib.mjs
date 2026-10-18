// Throwaway helpers for the 2026-10-18 Figma ⇄ Wecra comparison (group A). Not product code.
/* global window, document, createImageBitmap, Blob, atob, btoa, OffscreenCanvas */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const reportDir = path.resolve(here, "..");
export const LIVE = "/Users/burak/Desktop/Burak/Code/DesignerV2/docs/research/figma/live";
export const BASE = process.env.WECRA_URL ?? "http://localhost:5210";
export const work = process.env.WORK ?? "/private/tmp/claude-501/-Users-burak-Desktop-Burak-Code-DesignerV2/183474b4-9948-4411-be95-7471c4d88a86/scratchpad/work";

export function liveFile(name) {
  for (const f of [path.join(LIVE, "img", name), path.join(LIVE, "behaviour/img", name)]) if (existsSync(f)) return f;
  throw new Error(`no live image ${name}`);
}

export async function launch() {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return chromium.launch({
    executablePath: existsSync(chrome) ? chrome : undefined,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}

export const b64 = (file) => readFileSync(file).toString("base64");
export const mime = (file) => (file.endsWith(".png") ? "image/png" : "image/jpeg");

/** Runs `fn(bitmapData)` in a page on a decoded image; fn gets {w,h,d} with d an RGBA array. */
export async function analyse(page, file, fn, arg) {
  return page.evaluate(
    async ([data, type, src, arg]) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const f = new Function("return " + src)();
      return f({ w: bmp.width, h: bmp.height, d }, arg);
    },
    [b64(file), mime(file), fn.toString(), arg]
  );
}
