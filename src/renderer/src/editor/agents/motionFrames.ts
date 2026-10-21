/**
 * The agents' `get_motion_frames` (docs/research/motion-for-agents.md §3c, docs/motion.md §9.2): a frame's timeline drawn at
 * chosen times — one contact sheet PNG (a grid, each cell under its time), or a PNG per frame — returned as images in the
 * tool result, so a model sees its animation and refines it; `gif: true` also hands back a small looping GIF file. The
 * frames are the Animated export's (`engine.motionRenderFrame`: the root's box with the motion layer at t), so what it
 * shows is what MP4 / GIF exports contain.
 */
import type { Pixels } from "@/engine/codec";
import { textResult, type ToolContent, type ToolResult } from "@shared/agents/tools";
import type { ToolEnv } from "./mcpTools";
import { ToolError } from "./toolError";
import { normId, type Spec } from "./nodeSpec";
import { base64, encodePng } from "./png";
import { timelineOf } from "../motion/publicApi";
import { renderAnimated } from "../motion/export/exportAnimated";

const US = 1e6;
export const MAX_FRAMES = 24;
const PAD = 8;
const LABEL_H = 16;

// A 3 × 5 pixel font for the cells' times ("0.40 s").
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001111",
  ".": "000000000000010", s: "011100010001110", " ": "000000000000000",
};

function drawText(sheet: Uint8Array, width: number, x0: number, y0: number, text: string, px: number, rgb: [number, number, number]): void {
  let x = x0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++) {
          if (g[r * 3 + c] !== "1") continue;
          for (let dy = 0; dy < px; dy++)
            for (let dx = 0; dx < px; dx++) {
              const i = ((y0 + r * px + dy) * width + x + c * px + dx) * 4;
              sheet[i] = rgb[0];
              sheet[i + 1] = rgb[1];
              sheet[i + 2] = rgb[2];
              sheet[i + 3] = 255;
            }
        }
    }
    x += 4 * px;
  }
}

/** A frame over white into the sheet at (x0, y0) (straight RGBA; the cell is white where the frame is transparent). */
function blit(sheet: Uint8Array, width: number, p: Pixels, x0: number, y0: number): void {
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const s = (y * p.width + x) * 4;
      const d = ((y0 + y) * width + x0 + x) * 4;
      const a = p.pixels[s + 3] / 255;
      for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(p.pixels[s + c] * a + 255 * (1 - a));
      sheet[d + 3] = 255;
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const label = (s: number) => `${(Math.round(s * 100) / 100).toFixed(2)} s`;

/** get_motion_frames: the timeline at `times` (or `count` evenly spread, the ends included) as images. */
export async function getMotionFramesTool(env: ToolEnv, args: Spec): Promise<ToolResult> {
  const id = normId(args.nodeId) || env.ed.selection[0];
  if (!id) throw new ToolError("get_motion_frames: nodeId — the top-level frame (or any layer in it).");
  if (!env.ed.engine.readNode(id, { fields: ["name"] })) throw new ToolError(`No layer ${id} in this file. Use get_metadata to find ids.`);
  const model = timelineOf(env.ed, id);
  if (!model) throw new ToolError(`get_motion_frames: ${id} isn't in a top-level frame (a page's direct child holds the timeline).`);
  const root = model.root;
  const duration = model.durationUs / US;
  let times: number[];
  if (Array.isArray(args.times) && args.times.length) {
    if (args.times.length > MAX_FRAMES) throw new ToolError(`get_motion_frames: at most ${MAX_FRAMES} times`);
    times = args.times.map((t, i) => {
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw new ToolError(`times[${i}]: seconds, 0 or more`);
      return Math.min(t, duration);
    });
  } else {
    const count = typeof args.count === "number" ? Math.max(1, Math.min(MAX_FRAMES, Math.round(args.count))) : 6;
    times = count === 1 ? [0] : Array.from({ length: count }, (_, k) => (duration * k) / (count - 1));
  }
  const node = env.ed.engine.readNode(root, { fields: ["size"] }) as { size?: { x: number; y: number } } | null;
  const w = Math.max(1, node?.size?.x ?? 1);
  const h = Math.max(1, node?.size?.y ?? 1);
  const sheet = args.sheet !== false;
  const n = times.length;
  const maxSize = typeof args.maxSize === "number" ? Math.max(128, Math.min(2048, args.maxSize)) : sheet ? 1024 : 512;
  const cols = sheet ? Math.max(1, Math.min(n, typeof args.columns === "number" ? Math.round(args.columns) : Math.round(Math.sqrt((n * h) / w)) || 1)) : 1;
  const rows = Math.ceil(n / cols);
  const scale = sheet
    ? Math.min((maxSize - PAD * (cols + 1)) / (cols * w), (maxSize - PAD * (rows + 1) - LABEL_H * rows) / (rows * h), 2)
    : Math.min(maxSize / Math.max(w, h), 2);

  // The first frame waits for what the frame draws (fonts, images), as the exports do.
  const frames: Pixels[] = [];
  const deadline = Date.now() + 8000;
  for (const [k, t] of times.entries()) {
    const at = Math.round(t * US);
    let p = env.ed.engine.motionRenderFrame(root, at, scale);
    while (!p && k === 0 && env.ed.engine.motionRenderBusy && Date.now() < deadline) {
      await sleep(60);
      p = env.ed.engine.motionRenderFrame(root, at, scale);
    }
    if (!p) p = env.ed.engine.motionRenderFrame(root, at, scale, { allowPending: true });
    if (!p) throw new ToolError("get_motion_frames: the frame couldn't be drawn.");
    frames.push(p);
  }

  const content: ToolContent[] = [];
  let grid: { columns: number; rows: number } | undefined;
  if (sheet) {
    const cw = Math.max(...frames.map((f) => f.width));
    const ch = Math.max(...frames.map((f) => f.height));
    const W = PAD + cols * (cw + PAD);
    const H = PAD + rows * (ch + LABEL_H + PAD);
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < px.length; i += 4) px.set([228, 228, 228, 255], i);
    frames.forEach((f, k) => {
      const x = PAD + (k % cols) * (cw + PAD);
      const y = PAD + Math.floor(k / cols) * (ch + LABEL_H + PAD);
      drawText(px, W, x + 1, y + 3, label(times[k]), 2, [24, 24, 24]);
      blit(px, W, f, x, y + LABEL_H);
    });
    content.push({ type: "image", data: base64(await encodePng(W, H, px)), mimeType: "image/png" });
    grid = { columns: cols, rows };
  } else {
    for (const f of frames) {
      const px = new Uint8Array(f.width * f.height * 4);
      blit(px, f.width, f, 0, 0);
      content.push({ type: "image", data: base64(await encodePng(f.width, f.height, px)), mimeType: "image/png" });
    }
  }
  const out: ToolResult = { content };
  const info: Record<string, unknown> = {
    frame: model.rootName,
    duration,
    playback: model.playback,
    times: times.map((t) => Math.round(t * 1000) / 1000),
    size: { width: frames[0].width, height: frames[0].height },
    ...(grid ? { grid, order: "row by row, left to right; each cell under its time" } : {}),
  };
  // A small GIF of the whole timeline, saved in the working folder (main writes the file and gives its path).
  if (args.gif === true) {
    const g = await renderAnimated(env.ed, { root, name: model.rootName, settings: { format: "GIF", size: { scale: Math.min(1, 480 / Math.max(w, h)) }, fps: 24, quality: "MEDIUM", loop: true } });
    if ("error" in g) info.gif = `not made: ${g.error}`;
    else {
      const file = `${model.rootName || "Animation"} preview.gif`;
      out.files = [{ name: file, data: base64(g.bytes), mimeType: "image/gif" }];
      info.gif = file;
    }
  }
  content.push(textResult(info).content[0]);
  return out;
}
