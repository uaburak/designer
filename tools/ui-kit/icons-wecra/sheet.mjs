#!/usr/bin/env node
// The contact sheet: every icon of the file as Figma | Wecra | Figma Outline | Wecra Outline, large (×3) with the
// real size (×1) underneath — to check by eye that each Wecra glyph reads as the same icon.
//
//   node tools/ui-kit/icons-wecra/sheet.mjs [<name>…]  → tools/ui-kit/icons-wecra/contact-sheet.png
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { wecraSvg, figmaOutlineSvg } from "./render.mjs";
import { lightSvg } from "../icons.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "..", "manifest.json"), "utf8"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const names = Object.keys(manifest.icons).sort().filter((n) => !only.length || only.includes(n));
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(HERE, "contact-sheet.png");

const BIG = 3, CELL = 84, LABEL = 200, PER_ROW = 3, HEAD = 28;
const GROUP = LABEL + 4 * CELL + 20;
const cols = ["Figma", "Wecra", "Figma Outline", "Wecra Outline"];
const scaled = (svg, k) => svg.replace(/width="(\d+)" height="(\d+)"/, (_, w, h) => `width="${w * k}" height="${h * k}"`);
const render = async (svg, k) => sharp(Buffer.from(scaled(svg, k))).png().toBuffer();
const text = (s, w, size = 12, anchor = "start", weight = "normal") =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20"><text x="${anchor === "middle" ? w / 2 : 4}" y="14" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="Helvetica, Arial">${s}</text></svg>`);

const rows = Math.ceil(names.length / PER_ROW);
const parts = [];
for (let g = 0; g < PER_ROW; g++) cols.forEach((c, k) => parts.push({ input: text(c, CELL, 11, "middle", "bold"), left: g * GROUP + LABEL + k * CELL, top: 4 }));
for (const [i, n] of names.entries()) {
  const gx = (i % PER_ROW) * GROUP, gy = HEAD + Math.floor(i / PER_ROW) * (CELL + 30);
  const box = n.startsWith("16") ? 16 : 24;
  parts.push({ input: text(n, LABEL, 12), left: gx, top: gy + 30 });
  const svgs = [lightSvg(n, "figma"), wecraSvg(n, "default"), figmaOutlineSvg(n), wecraSvg(n, "outline")];
  for (const [k, svg] of svgs.entries()) {
    const x = gx + LABEL + k * CELL;
    const big = 24 * BIG;
    parts.push({ input: await render(svg, (24 * BIG) / box), left: x + (CELL - big) / 2, top: gy });
    parts.push({ input: await render(svg, 1), left: x + (CELL - box) / 2, top: gy + big + 4 });
  }
}
await sharp({ create: { width: PER_ROW * GROUP, height: HEAD + rows * (CELL + 30), channels: 4, background: "#ffffff" } }).composite(parts).png().toFile(out);
console.log(`${names.length} icons → ${out}`);
