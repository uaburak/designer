// Design system v2, step 5c (owner, 2026-10-15: "the icons themselves centred too"): in every icon variant the
// drawing (the union of its vectors' bounds) is moved to the middle of the variant's box, on half pixels; the vectors
// keep scaling with the box (constraints SCALE), so a resized icon stays centred. Read back: every variant's drawing
// centred within 0.5 px.
import { session } from "./lib.mjs";

const s = await session();
const kids = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<(\w+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] })).filter((k) => k.id !== id);
const page = (await kids("0:0")).find((p) => p.name === "Icons");
const frame = (await kids(page.id)).find((k) => k.name === "Icons");
const sets = (await kids(frame.id)).filter((k) => k.name.startsWith("Icon / "));

/** A variant's box and its vectors' bounds (relative to the variant). */
async function measure(variantId) {
  const ctx = await s.call("get_design_context", { nodeId: variantId });
  const root = ctx.nodes[0];
  const vectors = [];
  const walk = (n, ox, oy) => {
    for (const k of n.children ?? []) {
      const x = ox + (k.x ?? 0);
      const y = oy + (k.y ?? 0);
      if (k.type === "VECTOR") vectors.push({ id: k.id, x, y, w: k.width, h: k.height, lx: k.x ?? 0, ly: k.y ?? 0 });
      else walk(k, x, y);
    }
  };
  walk(root, 0, 0);
  if (!vectors.length) return null;
  const l = Math.min(...vectors.map((v) => v.x));
  const t = Math.min(...vectors.map((v) => v.y));
  const r = Math.max(...vectors.map((v) => v.x + v.w));
  const b = Math.max(...vectors.map((v) => v.y + v.h));
  return { w: root.width, h: root.height, vectors, dx: (root.width - (r - l)) / 2 - l, dy: (root.height - (b - t)) / 2 - t };
}

const half = (x) => Math.round(x * 2) / 2;
let moved = 0;
let variants = 0;
let off = 0;
for (const [i, set] of sets.entries()) {
  for (const v of (await kids(set.id)).filter((k) => k.type === "component")) {
    variants++;
    const m = await measure(v.id);
    if (!m) continue;
    const dx = half(m.dx);
    const dy = half(m.dy);
    if (dx || dy) {
      await s.call("update_nodes", { updates: m.vectors.map((x) => ({ nodeId: x.id, x: x.lx + dx, y: x.ly + dy })) });
      moved++;
    }
    const after = await measure(v.id);
    if (Math.abs(after.dx) > 0.5 || Math.abs(after.dy) > 0.5) {
      off++;
      console.log(`${set.name} › ${v.name}: still ${after.dx.toFixed(2)}, ${after.dy.toFixed(2)} off centre`);
    }
  }
  if ((i + 1) % 25 === 0) console.log(`sets ${i + 1}/${sets.length}`);
}
console.log(`variants: ${variants}; moved to the centre: ${moved}; centred within 0.5 px: ${variants - off}/${variants}`);
process.exit(off ? 1 : 0);
