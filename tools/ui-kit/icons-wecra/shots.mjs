// Screenshots of icon sets in the file (2 × 2: Set × Style) into one PNG: node tools/ui-kit/icons-wecra/shots.mjs <out.png> <name>…
import { connect } from "../mcp.mjs";
import sharp from "sharp";
import { readFileSync } from "node:fs";
const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const mcp = await connect();
const parts = [];
const names = process.argv.slice(3);
for (const [i, n] of names.entries()) {
  const r = await mcp.call("get_screenshot", { nodeId: m.icons[n].set, maxSize: 300 });
  const img = (Array.isArray(r) ? r : [r]).find((x) => x?.image);
  parts.push({ input: await sharp(Buffer.from(img.image, "base64")).resize(200, 200, { fit: "contain", background: "#fff" }).png().toBuffer(), left: (i % 6) * 210, top: Math.floor(i / 6) * 210 });
}
await sharp({ create: { width: 6 * 210, height: Math.ceil(names.length / 6) * 210, channels: 4, background: "#fff" } }).composite(parts).png().toFile(process.argv[2]);
