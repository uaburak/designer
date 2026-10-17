// Draws the evaluated frames of the Figma-logo Motion test (engine_tests "motion logo", MOTION_LOGO_DIR) as an MP4
// and a GIF: each frame's pieces are drawn on a 2D canvas with the engine's matrices (what the GPU renderer would
// draw once the wasm is built), shot with Playwright, encoded with ffmpeg.
//   node scripts/motion-logo-render.mjs <dir with figma-logo-frames.json> [out basename]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const dir = process.argv[2];
const base = process.argv[3] ?? "figma-logo-motion";
const data = JSON.parse(readFileSync(join(dir, "figma-logo-frames.json"), "utf8"));
const framesDir = join(dir, "frames");
mkdirSync(framesDir, { recursive: true });
const scale = 2;
const html = `<!doctype html><html><body style="margin:0;background:${data.root.bg}"><canvas id="c" width="${data.root.w * scale}" height="${data.root.h * scale}" style="display:block;width:${data.root.w}px;height:${data.root.h}px"></canvas>
<script>
const data = ${JSON.stringify(data)};
const c = document.getElementById("c"), ctx = c.getContext("2d");
window.draw = (fi) => {
  const f = data.frames[fi];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = data.root.bg;
  ctx.fillRect(0, 0, c.width, c.height);
  for (const p of f) {
    const [a, b, tx, cc, d, ty] = p.m; // the engine's 2×3: [m00 m01 m02; m10 m11 m12]
    ctx.setTransform(${scale} * a, ${scale} * cc, ${scale} * b, ${scale} * d, ${scale} * tx, ${scale} * ty);
    ctx.globalAlpha = Math.max(0, Math.min(1, p.o));
    ctx.fillStyle = p.c;
    ctx.beginPath();
    if (p.e) ctx.ellipse(p.w / 2, p.h / 2, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
    else ctx.roundRect(0, 0, p.w, p.h, p.r);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return true;
};
</script></body></html>`;
const page_html = join(dir, "figma-logo.html");
writeFileSync(page_html, html);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: data.root.w, height: data.root.h }, deviceScaleFactor: scale });
await page.goto(`file://${page_html}`);
const n = data.frames.length;
for (let i = 0; i < n; i++) {
  await page.evaluate((fi) => window.draw(fi), i);
  await page.screenshot({ path: join(framesDir, `f${String(i).padStart(4, "0")}.png`) });
}
await browser.close();
const ff = process.env.FFMPEG ?? "ffmpeg";
execFileSync(ff, ["-y", "-framerate", String(data.fps), "-i", join(framesDir, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", join(dir, `${base}.mp4`)], { stdio: "ignore" });
execFileSync(ff, ["-y", "-framerate", String(data.fps), "-i", join(framesDir, "f%04d.png"), "-vf", `fps=${data.fps},scale=${data.root.w}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer`, "-loop", "0", join(dir, `${base}.gif`)], { stdio: "ignore" });
console.log(`${n} frames → ${join(dir, base)}.mp4 / .gif`);
