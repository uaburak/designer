// Crops a region of a live capture and the matching Wecra shot, scaled up side by side (nearest neighbour), for
// measuring.  node zoom.mjs <case> x y w h [scale=8] [out=/tmp file]   (coordinates in the live image's pixels)
/* global createImageBitmap, Blob, atob, btoa, OffscreenCanvas */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { b64, launch, liveFile, mime, work } from "./lib.mjs";

const [name, x, y, w, h, sc = "8"] = process.argv.slice(2);
let live;
try { live = liveFile(`${name}.png`); } catch { live = liveFile(`${name}.jpg`); }
const ours = path.join(work, "wecra", `${name}.png`);
const browser = await launch();
const page = await browser.newPage();
const png = await page.evaluate(async ([a, at, b, x, y, w, h, s]) => {
  const load = async (d, type) => createImageBitmap(new Blob([Uint8Array.from(atob(d), (c) => c.charCodeAt(0))], { type }));
  const L = await load(a, at), R = await load(b, "image/png");
  const k = R.width / L.width;
  const c = new OffscreenCanvas(w * s * 2 + 8, h * s);
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = "#f0f";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(L, x, y, w, h, 0, 0, w * s, h * s);
  g.drawImage(R, x * k, y * k, w * k, h * k, w * s + 8, 0, w * s, h * s);
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  let str = "";
  for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(str);
}, [b64(live), mime(live), b64(ours), +x, +y, +w, +h, +sc]);
const out = path.join(work, `zoom-${name}-${x}-${y}.png`);
writeFileSync(out, Buffer.from(png, "base64"));
console.log(out);
await browser.close();
