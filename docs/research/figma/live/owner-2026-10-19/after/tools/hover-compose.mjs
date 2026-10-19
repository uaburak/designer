// Figma capture (its canvas, cropped) | Wecra after (hover-shoot.mjs), side by side with a caption strip.
//   node hover-compose.mjs <shots dir> <out dir>
// Throwaway research tooling, not product code.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const live = path.resolve(here, "../..");
const [shots, out] = process.argv.slice(2);
const FIG = { x0: 412, y0: 122, x1: 1680, y1: 1299 };
const W = FIG.x1 - FIG.x0, H = FIG.y1 - FIG.y0, CAP = 44;

const cases = [
  ["hover-A-icframe-selected-hover-sibling", "hover-figma-icframe-selected-hover-sibling", "A — one iç frame selected, pointer over its sibling"],
  ["hover-B-anaframe-selected-hover-child", null, "B — ana frame selected, pointer over a child iç frame (live spec; no owner capture)"],
  ["hover-C-testframe-selected-hover-cell", "hover-figma-testframe-selected", "C — test-Frame selected, pointer over a cell (Figma capture: pointer elsewhere)"],
  ["hover-C2-testframe-selected-hover-sibling", "hover-figma-testframe-selected-zoom", "C' — test-Frame selected, pointer over test-Rectangle"],
  ["hover-D-cell-selected-hover-sibling", "hover-figma-cell-selected-hover-sibling", "D — a cell selected, pointer over the next cell"],
  ["hover-E-test-selected-hover-child", "hover-figma-test-selected", "E — test selected, pointer over test-Rectangle"],
];

const caption = (text, w) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${CAP}"><rect width="100%" height="100%" fill="#ffffff"/><text x="12" y="29" font-family="Helvetica, Arial" font-size="20" font-weight="bold" fill="#111">${text.replace(/&/g, "&amp;")}</text></svg>`);

for (const [shot, fig, title] of cases) {
  const wecra = await sharp(readFileSync(path.join(shots, `${shot}.png`))).resize(W, H, { fit: "fill" }).png().toBuffer();
  const left = fig
    ? await sharp(path.join(live, `${fig}.webp`)).extract({ left: FIG.x0, top: FIG.y0, width: W, height: H }).png().toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: "#2c2c2c" } }).png().toBuffer();
  await sharp({ create: { width: W * 2 + 8, height: H + CAP, channels: 3, background: "#ff00ff" } })
    .composite([
      { input: caption(fig ? `Figma (owner's capture) — ${title}` : `Figma — no capture of this state`, W), left: 0, top: 0 },
      { input: caption("Wecra after", W), left: W + 8, top: 0 },
      { input: left, left: 0, top: CAP },
      { input: wecra, left: W + 8, top: CAP },
    ])
    .png()
    .toFile(path.join(out, `${shot}.png`));
  console.log("wrote", shot);
}
