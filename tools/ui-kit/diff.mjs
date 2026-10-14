#!/usr/bin/env node
// Where the file's texts are against the app's: each text layer of a screen (or, with --components, of each main
// component) next to the captured run with the same characters (screens: out/screens; components: the Gallery's
// cells in out/gallery.json), line centre against line centre. Reads out/polish/ctx (dump.mjs). Read-only.
//
//   node tools/ui-kit/diff.mjs [<screen id>…] [--components [<set>…]] [--all]
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CTX = join(OUT, "polish", "ctx");
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith("--"));
const verbose = names.length > 0 || args.includes("--all");
const TOL = 1.5;

/** A capture tree's text runs, relative to (ox, oy): {chars, x, cy} (cy: the line's centre). */
export function runs(root, ox = 0, oy = 0) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.kind === "text") {
        const y = c.y ?? n.y;
        const h = c.h ?? n.h;
        out.push({ chars: c.chars.trim(), x: c.x - ox, cy: y + h / 2 - oy, w: c.w });
      } else walk(c);
    }
  };
  walk(root);
  return out;
}
/** A text layer's first line centre, from its box, vertical alignment and line height. */
export function lineCentre(n, Y) {
  const lh = typeof n.lineHeight === "number" ? n.lineHeight : n.fontSize * 1.2;
  const lines = /HEIGHT/.test(n.textAutoResize ?? "") ? Math.max(1, Math.round(n.height / lh)) : 1;
  const free = n.height - lines * lh;
  const top = n.textAlignVertical === "CENTER" ? free / 2 : n.textAlignVertical === "BOTTOM" ? free : 0;
  return Y + top + (lines === 1 ? lh / 2 : (lines * lh) / 2);
}
/** Text layers that sit away from their run: [{id, chars, dx, dy}] ({id, chars, missing} when none matches). */
export function compare(tree, texts, ox = 0, oy = 0) {
  const out = [];
  const walk = (n, ax, ay, vis) => {
    const X = ax + (n.x ?? 0);
    const Y = ay + (n.y ?? 0);
    vis = vis && n.visible !== false;
    if (n.type === "TEXT" && vis && n.characters?.trim()) {
      const ch = n.characters.trim();
      const cy = lineCentre(n, Y);
      const m = texts.filter((q) => q.chars === ch).sort((a, b) => Math.hypot(a.x - X, a.cy - cy) - Math.hypot(b.x - X, b.cy - cy))[0];
      if (!m) out.push({ id: n.id, chars: ch, missing: true });
      else if (n.textAlignHorizontal === "CENTER" && m.w) {
        const dx = X + n.width / 2 - (m.x + m.w / 2);
        if (Math.abs(dx) > TOL || Math.abs(cy - m.cy) > TOL) out.push({ id: n.id, chars: ch, dx, dy: cy - m.cy });
      } else if (Math.abs(X - m.x) > TOL || Math.abs(cy - m.cy) > TOL) out.push({ id: n.id, chars: ch, dx: X - m.x, dy: cy - m.cy });
    }
    for (const c of n.children ?? []) walk(c, X, Y, vis);
  };
  walk(tree, ox, oy, true);
  return out;
}
const line = (d) => `  ${JSON.stringify(d.chars).slice(0, 34).padEnd(36)}${d.missing ? "not in the capture" : `dx ${d.dx.toFixed(1).padStart(6)}  dy ${d.dy.toFixed(1).padStart(6)}`}  ${d.id}`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (args.includes("--components")) {
    const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
    const gallery = new Map(JSON.parse(readFileSync(join(OUT, "gallery.json"), "utf8")).map((g) => [g.gid, g]));
    const byId = new Map();
    for (const f of readdirSync(CTX).filter((f) => f.startsWith("set."))) {
      const walk = (n) => {
        byId.set(n.id, n);
        (n.children ?? []).forEach(walk);
      };
      walk(JSON.parse(readFileSync(join(CTX, f), "utf8")));
    }
    for (const rec of Object.values(manifest.components)) {
      if (names.length && !names.includes(rec.set)) continue;
      const g = gallery.get(rec.gid);
      const n = byId.get(rec.id);
      if (!g || !n) continue;
      const root = g.nodes[0];
      const d = compare({ ...n, x: 0, y: 0 }, runs(root, root.x, root.y));
      const size = Math.abs(n.width - root.w) > 1 || Math.abs(n.height - root.h) > 1 ? ` — ${n.width} × ${n.height}, the app's ${root.w.toFixed(1)} × ${root.h.toFixed(1)}` : "";
      if (d.length || size) {
        console.log(`${rec.set} / ${rec.name}${size}`);
        for (const x of d) console.log(line(x));
      }
    }
  } else {
    for (const f of readdirSync(CTX).filter((f) => f.startsWith("screen."))) {
      const id = f.slice(7, -5);
      if (names.length && !names.includes(id)) continue;
      const tree = JSON.parse(readFileSync(join(CTX, f), "utf8"));
      const cap = JSON.parse(readFileSync(join(OUT, "screens", `${id}.json`), "utf8")).tree;
      const d = compare({ ...tree, x: 0, y: 0 }, runs(cap));
      console.log(`${id}: ${d.length}`);
      if (verbose) for (const x of d) console.log(line(x));
    }
  }
}
