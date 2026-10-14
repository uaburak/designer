#!/usr/bin/env node
// Side by side: each screen's captured reference (out/shots/<id>.png, the real app) next to the file's screen as the
// app draws it now (get_screenshot) → out/polish/<id>.png. Read-only. With --crop x,y,w,h a region of both, at 2×.
//
//   node tools/ui-kit/shots.mjs [<screen id>…] [--crop x,y,w,h]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { connect } from "./mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "polish");
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const crop = args.includes("--crop") ? args[args.indexOf("--crop") + 1].split(",").map(Number) : null;
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--crop");
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const mcp = await connect();
const sel = await mcp.call("get_selection");
if (sel.file !== manifest.file) throw new Error(`Bound to "${sel.file}", not "${manifest.file}"`);

for (const [id, s] of Object.entries(manifest.screens)) {
  if (ids.length && !ids.includes(id)) continue;
  const r = await mcp.call("get_screenshot", { nodeId: s.id, maxSize: 1440 }, { soft: true });
  const img = (Array.isArray(r) ? r : [r]).find((x) => x?.image);
  if (!img) { console.log(`${id}: no screenshot`); continue; }
  const now = await sharp(Buffer.from(img.image, "base64")).resize(1440, 900, { fit: "fill" }).png().toBuffer();
  const ref = await sharp(join(HERE, "out", "shots", `${id}.png`)).resize(1440, 900, { fit: "fill" }).png().toBuffer();
  const part = async (b) => (crop ? sharp(b).extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] }).resize(crop[2] * 2).png().toBuffer() : b);
  const [a, b] = [await part(ref), await part(now)];
  const { width: w, height: h } = await sharp(a).metadata();
  const vertical = w > h * 1.2;
  const W = vertical ? w : w * 2 + 8, H = vertical ? h * 2 + 8 : h;
  await sharp({ create: { width: W, height: H, channels: 4, background: "#ff00ff" } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: vertical ? 0 : w + 8, top: vertical ? h + 8 : 0 }])
    .png().toFile(join(OUT, `${id}${crop ? ".crop" : ""}.png`));
  writeFileSync(join(OUT, `${id}.now.png`), now);
  console.log(`${id} → out/polish/${id}${crop ? ".crop" : ""}.png`);
}
