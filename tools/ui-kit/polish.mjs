#!/usr/bin/env node
// Polishes the "Wecra UI" file in place from what dump.mjs read (out/polish/ctx): each fix finds the layers it
// applies to, changes only those (by id, never the selection), in small paced batches, and reads bounds back.
// Fixes at the main component when the layer is inside an instance; screens' own layers otherwise.
//
//   node tools/ui-kit/polish.mjs <fix>… [--dry]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { guard } from "./guard.mjs";
import { tokenFor } from "./convert.mjs";
import { runs, compare } from "./diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = join(HERE, "out", "polish", "ctx");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const fixes = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : [];
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const mcp = await connect();
const sel = await mcp.call("get_selection");
if (sel.file !== manifest.file) throw new Error(`Bound to "${sel.file}", not "${manifest.file}"`);

/** Every dumped tree with the page it is on: [{file, page, root, screen?}] */
const trees = readdirSync(CTX).map((f) => {
  const root = JSON.parse(readFileSync(join(CTX, f), "utf8"));
  const [kind, id] = f.replace(/\.json$/, "").split(/\.(.+)/);
  return { file: f, kind, id, root, page: kind === "screen" ? manifest.screens[id].page : "Components" };
});
const walk = (n, fn, parent = null) => {
  fn(n, parent);
  for (const c of n.children ?? []) walk(c, fn, n);
};
/** A write in batches of `size` ids, guarded: the screens touched are read back (1440 × 900), sets ≤ 4,000 px. */
async function setProps(ids, properties, label) {
  console.log(`${label}: ${ids.length} layers${dry ? " (dry)" : ""}`);
  if (dry || !ids.length) return;
  for (let i = 0; i < ids.length; i += 40) {
    const r = await mcp.call("set_properties", { nodeIds: ids.slice(i, i + 40), properties });
    if (!/everything applied/.test(r.summary)) console.warn(`  ${r.summary.slice(0, 300)}`);
  }
}
async function update(updates, label) {
  console.log(`${label}: ${updates.length} updates${dry ? " (dry)" : ""}`);
  if (dry || !updates.length) return;
  for (let i = 0; i < updates.length; i += 40) {
    const r = await mcp.call("update_nodes", { updates: updates.slice(i, i + 40) });
    if (!/everything applied/.test(r.summary)) console.warn(`  ${r.summary.slice(0, 300)}`);
  }
}
async function checkAll() {
  for (const s of Object.values(manifest.screens)) await guard(mcp, s.id, { exact: { width: 1440, height: 900 }, top: true });
  for (const [name, s] of Object.entries(manifest.sets)) if (s.id) await guard(mcp, s.id, { max: 4000, what: name });
  console.log("guards: screens 1440 × 900, sets ≤ 4,000 px, inside the canvas bound");
}

/** Binds paint `field` (e.g. "strokes[0]") of layers to the colour variable their colour stands for. */
async function bindColors(items, field, usage, label) {
  const by = new Map();
  for (const { id, color } of items) {
    const t = tokenFor(color.slice(0, 7).toUpperCase() + (color.length === 9 ? color.slice(7).toUpperCase() : ""), null, usage);
    const v = t && manifest.variables.colors[t.name];
    if (v) by.set(v, [...(by.get(v) ?? []), id]);
  }
  for (const [variableId, ids] of by) {
    console.log(`${label}: bind ${field} of ${ids.length} → ${variableId}${dry ? " (dry)" : ""}`);
    if (!dry) for (let i = 0; i < ids.length; i += 40) await mcp.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field, variableId });
  }
}

/** Each screen's captured text runs (absolute x, the line box's y and height). */
function captureTexts(screen) {
  const cap = JSON.parse(readFileSync(join(HERE, "out", "screens", `${screen}.json`), "utf8")).tree;
  const out = [];
  const walkCap = (n) => {
    for (const c of n.children ?? []) {
      if (c.kind === "text") out.push({ chars: c.chars.trim(), x: c.x, y: n.y, h: n.h });
      else walkCap(c);
    }
  };
  walkCap(cap);
  return out;
}
/** The captured run a text layer stands for (same characters, nearest), with the layer's offset from it. */
function offsetFromCapture(texts, n, X, Y) {
  const ch = n.characters?.trim();
  if (!ch) return null;
  const m = texts.filter((q) => q.chars === ch).sort((a, b) => Math.hypot(a.x - X, a.y - Y) - Math.hypot(b.x - X, b.y - Y))[0];
  return m ? { dx: X - m.x, dy: Y + n.height / 2 - (m.y + m.h / 2) } : null;
}
/** Walks a screen with absolute positions. */
const walkAbs = (n, fn, ax = 0, ay = 0, parent = null) => {
  const X = ax + (n.x ?? 0);
  const Y = ay + (n.y ?? 0);
  fn(n, X, Y, parent);
  for (const c of n.children ?? []) walkAbs(c, fn, X, Y, n);
};

const FIX = {
  /** Per-side strokes (a CSS border on some sides) were written with strokeWeight 0: the renderer draws nothing. */
  async sideStrokes() {
    const byW = new Map();
    for (const t of trees)
      walk(t.root, (n) => {
        if (n.id.startsWith("I") || !n.strokes?.length || n.strokeWeight) return;
        const w = Math.max(n.strokeTopWeight ?? 0, n.strokeRightWeight ?? 0, n.strokeBottomWeight ?? 0, n.strokeLeftWeight ?? 0);
        if (w > 0) byW.set(w, [...(byW.get(w) ?? []), n.id]);
      });
    for (const [w, ids] of byW) await setProps(ids, { strokeWeight: w }, `side strokes ${w}px`);
  },
  /**
   * Layer rows: the Gallery's rows (depth 1, 2) stand for the screens' rows at other depths, and an instance can't
   * move its layers. The app's row is a flex box (inset, depth × 24 indent, chevron, glyph + 8, name), so each
   * 32-px variant's box becomes that auto layout (padding-left = inset + indent; the glyph's frame takes its 8 as
   * right padding; the selection background and the lock / eye cells stay absolute) — then each screen row sets
   * its own depth as the box's left padding, an override Figma allows.
   */
  async layerRowsLayout() {
    const set = trees.find((t) => t.file === "set.LayerRow.json").root;
    for (const v of set.children.filter((c) => c.type === "COMPONENT" && c.height === 32)) {
      const box = v.children?.[0];
      if (!box || box.layoutMode || (only.length && !only.some((o) => v.name.includes(o)))) continue;
      const kids = box.children ?? [];
      const abs = kids.filter((c) => /^(before|cell)$/.test(c.name));
      const flow = kids.filter((c) => !abs.includes(c));
      const type = flow.find((c) => c.name === "type");
      const name = flow[flow.length - 1];
      console.log(`${v.name}: box auto layout, padding-left ${flow[0].x}`);
      if (dry) continue;
      await mcp.call("set_auto_layout", { nodeId: box.id, layoutMode: "HORIZONTAL", itemSpacing: 0, padding: [0, 0, 0, flow[0].x], counterAxisAlignItems: "CENTER", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
      const u = abs.map((c) => ({ nodeId: c.id, layoutPositioning: "ABSOLUTE", x: c.x, y: c.y }));
      if (type) u.push({ nodeId: type.id, paddingRight: name.x - (type.x + type.width) });
      u.push({ nodeId: name.id, layoutSizingHorizontal: "FILL" });
      u.push({ nodeId: box.id, width: box.width, height: box.height });
      await mcp.call("update_nodes", { updates: u });
      // read back: the same places as before
      const back = (await mcp.call("get_design_context", { nodeId: box.id, depth: 1 })).nodes[0];
      for (const c of kids) {
        const b = back.children.find((x) => x.id === c.id);
        if (!b || Math.abs(b.x - c.x) > 0.5 || Math.abs(b.y - c.y) > 0.5) console.warn(`  ${c.name} moved: ${c.x},${c.y} → ${b?.x},${b?.y}`);
      }
    }
  },
  async layerRows() {
    const updates = [];
    for (const t of trees.filter((t) => t.kind === "screen")) {
      const texts = captureTexts(t.id);
      walkAbs(t.root, (n, X, Y) => {
        if (n.type !== "INSTANCE" || n.name !== "LayerRow") return;
        const box = n.children?.[0];
        const name = box?.children?.find((c) => c.type === "TEXT");
        if (!name || box.layoutMode !== "HORIZONTAL") return;
        const off = offsetFromCapture(texts, name, X + box.x + name.x, Y + box.y + name.y);
        if (!off || Math.abs(off.dx) < 1.5 || Math.abs(off.dx) > 80) return;
        updates.push({ nodeId: box.id, paddingLeft: (box.padding?.[3] ?? 0) - off.dx });
      }, -t.root.x, -t.root.y);
    }
    await update(updates, "layer rows: each at its depth");
  },
  /**
   * Field texts: an <input>'s value and a field's 24-px label span were written as top-aligned text boxes — the value
   * 4 px high, the label's letter at its left. The value box centres its line; the label is the span's 24 × 24 with
   * its letter centred, as the app draws it. Main components only (instances follow).
   */
  async fieldTexts() {
    const manifest_ = manifest;
    const gallery = new Map(JSON.parse(readFileSync(join(HERE, "out", "gallery.json"), "utf8")).map((g) => [g.gid, g]));
    const byId = new Map();
    for (const t of trees.filter((t) => t.kind === "set")) walk(t.root, (n) => byId.set(n.id, n));
    const updates = new Map();
    for (const rec of Object.values(manifest_.components)) {
      const g = gallery.get(rec.gid);
      const n = byId.get(rec.id);
      if (!g || !n) continue;
      const root = g.nodes[0];
      for (const d of compare({ ...n, x: 0, y: 0 }, runs(root, root.x, root.y))) {
        if (d.missing || d.id.startsWith("I")) continue;
        const t = byId.get(d.id);
        const lh = t.lineHeight;
        if (Math.abs(d.dy + 4) > 0.6 || typeof lh !== "number") continue;
        if (t.height >= lh + 7) updates.set(d.id, { nodeId: d.id, textAlignVertical: "CENTER" });
        else if (Math.abs(t.width - 24) < 0.5 && d.dx < -4) updates.set(d.id, { nodeId: d.id, textAlignHorizontal: "CENTER", textAlignVertical: "CENTER", layoutSizingVertical: "FIXED", height: 24 });
      }
    }
    // Every main's input value (a fixed box taller than its one line) the same way, Gallery cell or not
    for (const n of byId.values())
      if (n.type === "TEXT" && !n.id.startsWith("I") && n.textAutoResize === "NONE" && typeof n.lineHeight === "number" && n.height >= n.lineHeight + 4 && (n.textAlignVertical ?? "TOP") === "TOP" && !/\n/.test(n.characters))
        updates.set(n.id, { ...(updates.get(n.id) ?? { nodeId: n.id }), textAlignVertical: "CENTER" });
    // and every field's one-letter label (X, Y, W, H…: a 24-wide text first in a 24-high row)
    for (const t of trees.filter((t) => t.kind === "set"))
      walk(t.root, (n, parent) => {
        if (n.type !== "TEXT" || n.id.startsWith("I") || Math.abs(n.width - 24) > 0.5 || n.characters.trim().length > 3) return;
        if (parent?.layoutMode !== "HORIZONTAL" || Math.abs(parent.height - 24) > 0.5 || parent.children[0] !== n || n.textAlignHorizontal === "CENTER") return;
        updates.set(n.id, { nodeId: n.id, textAlignHorizontal: "CENTER", textAlignVertical: "CENTER", layoutSizingVertical: "FIXED", height: 24 });
      });
    await update([...updates.values()], "field texts centred");
  },
  /**
   * Colour fields: the opacity part was placed for the Gallery's 184-px field and stayed there in narrower ones
   * (paint rows, 156): it keeps to the right edge, the hex value stretches; each instance's value then ends where
   * its opacity begins.
   */
  async colorInputs() {
    const set = trees.find((t) => t.file === "set.ColorInput.json").root;
    const u = [];
    for (const v of set.children.filter((c) => c.type === "COMPONENT")) {
      const kids = v.children ?? [];
      const op = kids.find((c) => c.name === "opacity");
      const tx = kids.find((c) => c.type === "TEXT");
      if (op) u.push({ nodeId: op.id, constraints: { horizontal: "MAX", vertical: "MIN" } });
      if (tx) u.push({ nodeId: tx.id, constraints: { horizontal: "STRETCH", vertical: "MIN" } });
    }
    await update(u, "colour fields: constraints");
    if (dry) return;
    const fix = [];
    for (const t of trees.filter((t) => t.kind === "screen"))
      for (const s of Object.keys(manifest.screens).filter((k) => k === t.id)) {
        const r = await mcp.call("get_design_context", { nodeId: manifest.screens[s].id, depth: 60 });
        walk(r.nodes[0], (n) => {
          if (n.type !== "INSTANCE" || n.name !== "ColorInput") return;
          const op = n.children?.find((c) => c.name === "opacity");
          const tx = n.children?.find((c) => c.type === "TEXT");
          if (op && tx && Math.abs(tx.x + tx.width - op.x) > 0.5) fix.push({ nodeId: tx.id, width: op.x - tx.x });
        });
      }
    await update(fix, "colour fields: value up to the opacity");
  },
  /**
   * Home's sidebar: Trash came before the folder tree (the tree's wrapper was placed last), and the folders sat at the
   * top level's inset — in the app they are a tree under All folders, 20 px in, then Trash.
   */
  async sidebarTree() {
    const moves = [];
    const pads = [];
    const textOf = (n) => {
      let s = null;
      walk(n, (c) => (s ??= c.type === "TEXT" ? c.characters : null));
      return s;
    };
    for (const t of trees.filter((t) => t.kind === "screen")) {
      walk(t.root, (n) => {
        if (n.name !== "navGroup" || n.layoutMode !== "VERTICAL") return;
        const kids = n.children ?? [];
        const trash = kids.findIndex((c) => c.type === "INSTANCE" && textOf(c) === "Trash");
        const tree = kids.findIndex((c) => c.type === "FRAME" && c.name === "div");
        if (trash >= 0 && tree > trash) moves.push({ id: kids[trash].id, parent: n.id, index: kids.length - 1, page: t.page });
        if (tree < 0) return;
        walk(kids[tree], (c) => {
          if (c.type !== "INSTANCE" || c.name !== "SidebarItem") return;
          const box = c.children?.[0];
          if (box?.name === "box" && box.padding?.[3] === 4) pads.push({ nodeId: box.id, paddingLeft: 24 });
        });
      });
    }
    console.log(`sidebar: Trash after the folder tree in ${moves.length} screens${dry ? " (dry)" : ""}`);
    if (!dry) for (const m of moves) await mcp.call("reparent_nodes", { nodeIds: [m.id], parentId: m.parent, index: m.index }, { page: m.page });
    await update(pads, "sidebar: folders 20 px in");
  },
  /**
   * Hugged labels cut short: a box the browser sized to its text (a fractional width) is a hair narrower for the
   * engine's text, and its "…" truncation then cut a word that fits in the app ("Deskt…", "Present in this t…").
   */
  async hugTruncation() {
    const ids = [];
    const widen = new Map();
    const frac = (v) => Math.abs(v - Math.round(v)) > 0.01;
    for (const t of trees)
      walk(t.root, (n, parent) => {
        if (n.type !== "TEXT" || n.id.startsWith("I") || n.textTruncation !== "ENDING") return;
        if (!frac(n.width) && !(parent && frac(parent.width))) return;
        ids.push(n.id);
        // (a first pass turned the truncation off: a word that doesn't fit then wraps — "Deskto / p")
        if (n.layoutSizingHorizontal === "FIXED" && frac(n.width)) widen.set(n.id, { nodeId: n.id, width: Math.ceil(n.width) + 1 });
        else if (n.layoutSizingHorizontal === "FILL" && parent?.layoutSizingHorizontal === "FIXED" && frac(parent.width)) widen.set(parent.id, { nodeId: parent.id, width: Math.ceil(parent.width) + 1 });
      });
    await setProps(ids, { textTruncation: "ENDING" }, "hugged labels: truncation as in the app");
    await update([...widen.values()], "hugged labels: their box 1 px wider than the browser's");
  },
  /** Words split into two text layers lost the space between them. */
  async splitWords() {
    const updates = [];
    for (const t of trees)
      walk(t.root, (n) => {
        const k = n.children ?? [];
        for (let i = 0; i + 1 < k.length; i++) {
          const [a, b] = [k[i], k[i + 1]];
          if (n.layoutMode !== "HORIZONTAL" || (n.itemSpacing ?? 0) !== 0 || a.type !== "TEXT" || b.type !== "TEXT") continue;
          if (/^[A-Za-z]{2,}$/.test(a.characters) && /^[A-Za-z]{2,}/.test(b.characters)) updates.push({ nodeId: a.id, characters: `${a.characters} ` });
        }
      });
    // "Enable libraries" + "for all files…" (Settings › Account): two runs placed side by side
    for (const t of trees.filter((t) => t.id === "dialog-settings"))
      walk(t.root, (n) => {
        const k = n.children ?? [];
        const a = k.find((c) => c.characters === "Enable libraries");
        const b = k.find((c) => /^for all files/.test(c.characters ?? ""));
        if (a && b && b.x < 84) updates.push({ nodeId: b.id, x: 84 });
      });
    await update(updates, "split words: the space back");
  },
  /**
   * Dialogs' and popovers' texts and icons were bound to the "on warning" colours (their dark capture matched that
   * pair): in Dark they would stay black. They are the panel's own text / icon colours.
   */
  async onWarning() {
    const C = manifest.variables.colors;
    const map = (name, type) => {
      const kind = type === "TEXT" ? "text" : "icon";
      if (/^(text|icon)\/(text|icon)-onwarning$/.test(name)) return C[kind === "text" ? "text" : "icon"];
      if (/-onwarning-secondary$/.test(name)) return C[`${kind}-secondary`];
      if (/-onwarning-tertiary$/.test(name)) return C[`${kind}-tertiary`];
      return null;
    };
    const by = new Map();
    for (const t of trees)
      walk(t.root, (n) => {
        for (const [field, v] of Object.entries(n.boundVariables ?? {})) {
          if (!/onwarning/.test(v.name) || !/^(fillPaints|strokePaints)\[0\]\.color$/.test(field)) continue;
          const target = map(v.name, n.type);
          if (!target) continue;
          const f = field.startsWith("fill") ? "fills[0]" : "strokes[0]";
          const k = `${f}|${target}`;
          by.set(k, [...(by.get(k) ?? []), n.id]);
        }
      });
    for (const [k, ids] of by) {
      const [field, variableId] = k.split("|");
      console.log(`on-warning colours: ${field} of ${ids.length} → ${variableId}${dry ? " (dry)" : ""}`);
      if (!dry) for (let i = 0; i < ids.length; i += 40) await mcp.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field, variableId });
    }
  },
  /**
   * Pictures the build left at a placeholder: Home's file cards (their thumbnails) and Draw's layer thumbnails each
   * get the capture's own picture (uploaded once into the hidden seeds frame, kept in manifest.images).
   */
  async pictures() {
    const hash = async (file) => {
      const key = `images/${file}`;
      if (manifest.images[key]) return manifest.images[key];
      const r = await mcp.call("place_image", { data: readFileSync(join(HERE, "out", "images", file)).toString("base64"), name: file, parentId: manifest.seeds, x: 0, y: 0 }, { page: "Components" });
      const res = (Array.isArray(r) ? r : [r]).find((x) => x?.imageHash);
      manifest.images[key] = res.imageHash;
      writeFileSync(join(HERE, "manifest.json"), JSON.stringify(manifest, null, 1));
      return res.imageHash;
    };
    const updates = [];
    for (const t of trees.filter((t) => t.kind === "screen")) {
      const cap = JSON.parse(readFileSync(join(HERE, "out", "screens", `${t.id}.json`), "utf8")).tree;
      const pics = [];
      const cw = (n) => {
        const m = /img\d+\.png/.exec(JSON.stringify({ ...n, children: undefined }));
        if (m && n.w < 400) pics.push({ file: m[0], x: n.x, y: n.y, w: n.w, h: n.h });
        (n.children ?? []).forEach(cw);
      };
      cw(cap);
      if (!pics.length) continue;
      const targets = [];
      walkAbs(t.root, (n, X, Y) => {
        if (!(n.fills ?? []).some((f) => f.type === "IMAGE") || n.width > 400) return;
        targets.push({ n, X, Y });
      }, -t.root.x, -t.root.y);
      for (const { n, X, Y } of targets) {
        const cx = X + n.width / 2, cy = Y + n.height / 2;
        const p = pics.find((q) => Math.abs(q.x + q.w / 2 - cx) < 12 && Math.abs(q.y + q.h / 2 - cy) < 12);
        if (!p) continue;
        if (dry) { console.log(`  ${t.id} ${n.name} ← ${p.file}`); continue; }
        updates.push({ nodeId: n.id, fills: [{ type: "IMAGE", imageRef: await hash(p.file), scaleMode: n.width > 100 ? "FILL" : "FIT" }] });
      }
    }
    await update(updates, "pictures from the capture");
  },
  /**
   * A CSS border drawn as box-shadow: inset 0 0 0 <w> became an inner shadow with only a spread, which the renderer
   * leaves out: an inside stroke of that weight instead (Figma's own way of drawing a border), bound to its colour.
   */
  async insetBorders() {
    const updates = [];
    const binds = [];
    for (const t of trees)
      walk(t.root, (n) => {
        if (n.id.startsWith("I") && !args.includes("--instances")) return;
        const fx = n.effects ?? [];
        const ring = fx.find((e) => e.type === "INNER_SHADOW" && !e.offset?.x && !e.offset?.y && !e.radius && e.spread > 0);
        if (!ring || n.strokes?.length) return;
        updates.push({ nodeId: n.id, strokes: [{ type: "SOLID", color: ring.color }], strokeAlign: "INSIDE", strokeWeight: ring.spread, effects: fx.filter((e) => e !== ring) });
        binds.push({ id: n.id, color: ring.color });
      });
    await update(updates, "inset borders → inside strokes");
    await bindColors(binds, "strokes[0]", "stroke", "inset borders");
  },
};

for (const f of fixes) {
  if (!FIX[f]) throw new Error(`no fix "${f}": ${Object.keys(FIX).join(", ")}`);
  await FIX[f]();
}
if (!dry && fixes.length) await checkAll();
