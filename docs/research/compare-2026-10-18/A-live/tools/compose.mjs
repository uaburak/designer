// Builds images/<case>-compare.png (Figma left, Wecra right, same scale, labelled) and images/<case>-diff.png (a
// difference blend: black where both agree) from the live captures and $WORK/wecra/<case>.png. Throwaway.
//   node compose.mjs [filter]
/* global createImageBitmap, Blob, atob, btoa, OffscreenCanvas */
import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { analyse, b64, launch, liveFile, mime, reportDir, work } from "./lib.mjs";

const imgDir = path.join(reportDir, "images");
mkdirSync(imgDir, { recursive: true });
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const NO_DIFF = new Set((process.env.NO_DIFF ?? "").split(",").filter(Boolean));
const browser = await launch();
const page = await browser.newPage();
const stats = {};
for (const f of readdirSync(path.join(work, "wecra")).filter((f) => f.endsWith(".png"))) {
  const name = f.replace(/\.png$/, "");
  if (filter && !filter.test(name)) continue;
  let live;
  try {
    live = liveFile(`${name}.png`);
  } catch {
    try {
      live = liveFile(`${name}.jpg`);
    } catch {
      continue;
    }
  }
  const ours = path.join(work, "wecra", f);
  const res = await page.evaluate(
    async ([a, at, b, name, withDiff]) => {
      const load = async (d, type) => createImageBitmap(new Blob([Uint8Array.from(atob(d), (c) => c.charCodeAt(0))], { type }));
      const L = await load(a, at), R = await load(b, "image/png");
      // Same scale: ours drawn at live's size (ours is shot at live's CSS window × its device scale).
      let w = L.width, h = L.height;
      const gap = 12, head = 26;
      const k = Math.min((1600 - gap) / (2 * w), Math.max(1, 560 / w));
      const W = Math.round(w * k), H = Math.round(h * k);
      const c = new OffscreenCanvas(W * 2 + gap, H + head);
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#ff00ff";
      g.fillRect(W, 0, gap, c.height);
      g.imageSmoothingQuality = "high";
      g.drawImage(L, 0, head, W, H);
      g.drawImage(R, 0, 0, R.width, R.height, W + gap, head, W, H);
      g.font = "600 14px -apple-system, Helvetica, Arial";
      g.fillStyle = "#000000";
      g.fillText(`Figma (live) — ${name}`, 6, 18);
      g.fillText("Wecra", W + gap + 6, 18);
      const toB64 = async (cv) => {
        const bytes = new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const out = { compare: await toB64(c), size: [c.width, c.height], ourSize: [R.width, R.height], liveSize: [L.width, L.height] };
      if (withDiff) {
        const d = new OffscreenCanvas(W, H);
        const dg = d.getContext("2d");
        dg.drawImage(L, 0, 0, W, H);
        dg.globalCompositeOperation = "difference";
        dg.drawImage(R, 0, 0, R.width, R.height, 0, 0, W, H);
        const px = dg.getImageData(0, 0, W, H).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) n++;
        out.diffPct = Math.round((1000 * n) / (W * H)) / 10;
        out.diff = await toB64(d);
      }
      return out;
    },
    [b64(live), mime(live), b64(ours), name, !NO_DIFF.has(name)]
  );
  writeFileSync(path.join(imgDir, `${name}-compare.png`), Buffer.from(res.compare, "base64"));
  if (res.diff) writeFileSync(path.join(imgDir, `${name}-diff.png`), Buffer.from(res.diff, "base64"));
  stats[name] = { live: res.liveSize, ours: res.ourSize, diffPct: res.diffPct };
  console.log(name, JSON.stringify(stats[name]));
}
writeFileSync(path.join(work, "compose-stats.json"), JSON.stringify(stats, null, 1));
await browser.close();
void analyse;
void existsSync;
