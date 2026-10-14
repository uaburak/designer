#!/usr/bin/env node
// Builds the "Wecra UI" design file in the running app through its MCP server (mcp.mjs) from capture.mjs's output:
//   1. variables  — "Wecra colors" (Light / Dark, every --figma-color-* and --ds-color-* token), "Wecra sizes" (radius,
//                   space, size) and the ds text styles;
//   2. components — the Components page: one component per ds icon, one variant per Gallery cell and per distinct
//                   ds component found in the screens, combined into sets; nested ds parts are instances;
//   3. screens    — each captured screen as a 1440×900 frame on its page, ds parts as instances with overrides.
// The ids go to tools/ui-kit/manifest.json (readback.mjs reads the owner's edits back through them).
//
//   node tools/ui-kit/build.mjs [--reset] [--phase variables|components|screens|all] [--only <screen id>…]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import * as C from "./convert.mjs";
import { text as TEXT_STYLES, radius as RADIUS, space as SPACE, size as SIZE } from "../../src/renderer/src/ds/tokens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const MANIFEST = join(HERE, "manifest.json");
const FILE_NAME = "Wecra UI";
const args = process.argv.slice(2);
const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : "all";
const only = args.includes("--only") ? args.slice(args.indexOf("--only") + 1).filter((a) => !a.startsWith("--")) : null;
const reset = args.includes("--reset");
const PAGES = ["Components", "Home", "Editor", "Menus & popovers", "Dialogs", "Welcome"];

const manifest = existsSync(MANIFEST) && !reset ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { file: FILE_NAME, pages: {}, variables: {}, textStyles: {}, images: {}, icons: {}, components: {}, sets: {}, screens: {} };
const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

const mcp = await connect();
const problems = [];
async function call(name, a, { soft = false } = {}) {
  const r = await mcp.call(name, a, { soft: true });
  const text = typeof r === "string" ? r : null;
  if (text && /^(Error|No design file|The file this session)/.test(text)) {
    if (!soft) throw new Error(`${name}: ${text}`);
    problems.push(`${name}: ${text}`);
  }
  if (r && typeof r === "object" && !Array.isArray(r) && typeof r.summary === "string" && !/everything applied|^bound |^applied|^apply_style/.test(r.summary)) {
    problems.push(`${name}: ${r.summary.slice(0, 300)}`);
  }
  return r;
}
const bound = await call("get_selection", {});
if (bound.file !== FILE_NAME) throw new Error(`This session is bound to "${bound.file}", not "${FILE_NAME}": bring "${FILE_NAME}" to the front in Wecra and run again.`);
console.log(`bound to ${bound.file}`);

// ---- pages -------------------------------------------------------------------------------------------------------------
async function pages() {
  return (await call("get_selection", {})).pages;
}
async function ensurePage(name) {
  let list = await pages();
  let p = list.find((x) => x.name === name);
  if (p) return (manifest.pages[name] = p.id);
  await call("run_command", { engineCommand: "CREATE_PAGE" });
  list = await pages();
  const fresh = list[list.length - 1];
  await call("update_nodes", { updates: [{ nodeId: fresh.id, name }] });
  manifest.pages[name] = fresh.id;
  save();
  return fresh.id;
}

if (reset && Object.keys(manifest.screens ?? {}).length === 0 && existsSync(MANIFEST) && !args.includes("--force-reset")) {
  // (manifest was emptied above for --reset; the old one on disk says whether the file has been built)
}
if (reset && JSON.parse(readFileSync(MANIFEST, "utf8")).screens && Object.keys(JSON.parse(readFileSync(MANIFEST, "utf8")).screens).length && !args.includes("--force-reset")) {
  throw new Error("The file is built: revise it with --phase update (in place, instances stay linked). --reset --force-reset deletes and rebuilds everything.");
}
if (reset) {
  // Our pages only (the guard above made sure this is "Wecra UI"): emptied, extra pages removed.
  const list = await pages();
  for (const p of list) {
    if (p.name === "Thumbnail") continue;
    if (PAGES.includes(p.name) || /^Page \d+$|^Test page$/.test(p.name)) {
      const meta = await call("get_metadata", { nodeId: p.id, depth: 1 });
      const ids = [...String(meta).matchAll(/^ {2}<\w+ id="([^"]+)"/gm)].map((x) => x[1]);
      if (ids.length) await call("delete_nodes", { nodeIds: ids });
    }
  }
  const after = await pages();
  const keep = after.find((p) => p.name === "Components") ?? after.find((p) => p.name !== "Thumbnail");
  if (keep.name !== "Components") await call("update_nodes", { updates: [{ nodeId: keep.id, name: "Components" }] });
  for (const p of after) if (p.id !== keep.id && p.name !== "Thumbnail") await call("run_command", { engineCommand: "DELETE_PAGE", args: { page: p.id } }, { soft: true });
  manifest.pages = { Components: keep.id };
  save();
}


// ---- variables & styles --------------------------------------------------------------------------------------------
const anyId = (r) => r?.id ?? r?.variableId ?? r?.collectionId ?? r?.styleId ?? r?.variable?.id ?? r?.collection?.id ?? r?.style?.id ?? r?.created?.id;

/** Idempotent: existing collections, variables and styles (by name) are reused, the missing ones made. */
async function buildVariables() {
  const defs = await call("get_variable_defs", { all: true });
  const cols = defs.collections ?? [];
  const styles = new Map((defs.styles ?? []).map((s) => [s.name, s.id]));
  const collection = async (name, modes) => {
    const c = cols.find((x) => x.name === name);
    if (c) return { id: c.id, vars: new Map((c.variables ?? []).map((v) => [v.name, v.id])) };
    const r = await call("create_variable_collection", { name, modes });
    return { id: anyId(r), vars: new Map() };
  };
  const variable = async (col, spec) => col.vars.get(spec.name) ?? anyId(await call("create_variable", { collectionId: col.id, ...spec }));
  const colors = await collection("Wecra colors", ["Light", "Dark"]);
  manifest.variables.collection = colors.id;
  manifest.variables.colors = {};
  for (const t of C.TOKENS) manifest.variables.colors[t.name] = await variable(colors, { name: C.variableName(t), type: "COLOR", values: { Light: t.light, Dark: t.dark }, codeSyntax: { WEB: `var(${t.css})` }, description: t.css });
  const sizes = await collection("Wecra sizes", ["Value"]);
  manifest.variables.sizes = { collection: sizes.id, radius: {}, space: {}, size: {} };
  for (const [k, v] of Object.entries(RADIUS)) manifest.variables.sizes.radius[k] = await variable(sizes, { name: `radius/${k}`, type: "FLOAT", value: v, codeSyntax: { WEB: `var(--ds-radius-${k})` }, scopes: ["CORNER_RADIUS"] });
  for (const [k, v] of Object.entries(SPACE)) manifest.variables.sizes.space[k] = await variable(sizes, { name: `space/${k}`, type: "FLOAT", value: v, codeSyntax: { WEB: `var(--ds-space-${k})` }, scopes: ["GAP", "WIDTH_HEIGHT"] });
  for (const [k, v] of Object.entries(SIZE)) manifest.variables.sizes.size[k] = await variable(sizes, { name: `size/${k}`, type: "FLOAT", value: v, codeSyntax: { WEB: `var(--ds-size-${k})` }, scopes: ["WIDTH_HEIGHT"] });
  for (const [name, s] of Object.entries(TEXT_STYLES)) {
    if (s.mono) continue;
    manifest.textStyles[name] =
      styles.get(`ds/${name}`) ??
      anyId(
        await call("create_text_style", {
          name: `ds/${name}`,
          fontFamily: "Inter",
          fontStyle: s.weight >= 600 ? "Semi Bold" : s.weight >= 500 ? "Medium" : "Regular",
          fontSize: s.size,
          lineHeight: s.line,
          letterSpacing: parseFloat(s.tracking),
          ...(s.weight % 100 ? { fontVariations: [{ axisTag: 0x77676874, axisName: "Weight", value: s.weight }] } : {}),
          description: `--ds-font-${name}`,
        })
      );
  }
  save();
  const missing = Object.values(manifest.variables.colors).filter((v) => !v).length;
  console.log("variables", Object.keys(manifest.variables.colors).length, "missing", missing, "text styles", Object.keys(manifest.textStyles).length);
}

// ---- images --------------------------------------------------------------------------------------------------------
let uploads = null;
async function imageHash(file, dir = "images") {
  const key = `${dir}/${file}`;
  if (manifest.images[key]) return manifest.images[key];
  if (!uploads) {
    const pid = manifest.pages.Components;
    const r = await call("create_nodes", { parentId: pid, nodes: [{ type: "FRAME", name: "_uploads", x: -6000, y: 0, width: 100, height: 100, fills: [] }] });
    uploads = r.created[0].id;
  }
  const r = await call("place_image", { data: readFileSync(join(OUT, dir, file)).toString("base64"), name: file, parentId: uploads, x: 0, y: 0 });
  const res = Array.isArray(r) ? r.find((x) => x.imageHash) : r;
  manifest.images[key] = res.imageHash;
  return res.imageHash;
}

/** A hidden frame holding one instance of every main: build.mjs duplicates them into place. */
async function seedsFrame() {
  if (manifest.seeds) return manifest.seeds;
  const r = await call("create_nodes", { parentId: manifest.pages.Components, nodes: [{ type: "FRAME", name: "_seeds (build helper, keep hidden)", x: -12000, y: 0, width: 100, height: 100, fills: [], visible: false }] });
  manifest.seeds = r.created[0].id;
  save();
  return manifest.seeds;
}

// ---- shared: create specs, map ids, fill slots, bind --------------------------------------------------------------
/** Pre-order list of specs (the order create_nodes reports its nodes in). */
function flatten(spec, parent = null, index = 0, out = []) {
  out.push({ spec, parent, index });
  (spec.children ?? []).forEach((c, i) => flatten(c, spec, i, out));
  return out;
}
const clean = (spec) => {
  const { _, _id, _inst, children, ...rest } = spec;
  return children ? { ...rest, children: children.map(clean) } : rest;
};

/** Image fills for picture rectangles. */
async function resolveImages(specs) {
  for (const s of specs) {
    for (const { spec } of flatten(s)) {
      if (spec._?.image) spec.fills = [{ type: "IMAGE", imageRef: await imageHash(spec._.image), scaleMode: spec._.src?.fit === "contain" ? "FIT" : "FILL" }];
      else if (spec.type === "RECTANGLE" && spec._ && !spec._.image) spec.fills = [];
    }
  }
}

async function create(parentId, specs) {
  await resolveImages(specs);
  const r = await call("create_nodes", { parentId, nodes: specs.map(clean) });
  const all = specs.flatMap((s) => flatten(s));
  if (!r.nodes || r.nodes.length !== all.length) throw new Error(`create_nodes reported ${r.nodes?.length} layers for ${all.length} specs: ${JSON.stringify(r).slice(0, 500)}`);
  all.forEach((e, i) => (e.spec._id = r.nodes[i].nodeId));
  return all;
}

const binds = new Map(); // `${field}|${variableId}` → ids
const styleApps = new Map(); // styleId → ids
function addBind(nodeId, field, light, dark, usage) {
  const t = C.tokenFor(light, dark, usage);
  if (!t) return;
  const v = manifest.variables.colors?.[t.name];
  if (!v) return;
  const k = `${field}|${v}`;
  binds.set(k, [...(binds.get(k) ?? []), nodeId]);
}
function addRadiusBind(nodeId, r) {
  const hit = C.RADII.find(([, v]) => v === r);
  if (!hit) return;
  const v = manifest.variables.sizes?.radius?.[hit[0]];
  if (!v) return;
  const k = `cornerRadius|${v}`;
  binds.set(k, [...(binds.get(k) ?? []), nodeId]);
}
async function flushBinds() {
  for (const [k, ids] of binds) {
    const [field, variableId] = k.split("|");
    for (let i = 0; i < ids.length; i += 400) await call("bind_variable", { nodeIds: ids.slice(i, i + 400), field, variableId }, { soft: true });
  }
  binds.clear();
  for (const [styleId, ids] of styleApps) for (let i = 0; i < ids.length; i += 400) await call("apply_style", { nodeIds: ids.slice(i, i + 400), slot: "text", styleId }, { soft: true });
  styleApps.clear();
}
function collectBinds(all) {
  for (const { spec } of all) {
    if (!spec._ || spec.name === "__slot") continue;
    for (const b of spec._.binds ?? []) addBind(spec._id, b.field, b.light, b.dark, b.usage);
    if (typeof spec.cornerRadius === "number") addRadiusBind(spec._id, spec.cornerRadius);
    const ts = spec._.textStyle && manifest.textStyles[spec._.textStyle];
    if (ts) styleApps.set(ts, [...(styleApps.get(ts) ?? []), spec._id]);
  }
}

/** Fills every slot of freshly created specs with an instance; returns the source node → id map additions. */
async function fillSlots(all, ids) {
  const slots = all.filter((e) => e.spec.name === "__slot" && e.spec._?.slot);
  // Per parent, last index first: an insert never shifts the slots still to fill.
  slots.sort((a, b) => (a.parent?._id === b.parent?._id ? b.index - a.index : 0));
  const updates = [];
  const swaps = [];
  const del = [];
  for (const e of slots) {
    const slot = e.spec._.slot;
    const occ = e.spec._.src;
    const seed = slot.icon ? manifest.icons[slot.icon]?.seed : manifest.components[slot.key]?.seed;
    if (!seed) continue;
    const parentId = e.parent._id;
    const d = await call("duplicate_nodes", { nodeIds: [seed], parentId, index: e.index, ...(e.spec.x != null ? { x: e.spec.x, y: e.spec.y } : {}) }, { soft: true });
    const inst = d?.copies?.[0]?.id;
    if (!inst) continue;
    del.push(e.spec._id);
    ids?.set(occ, inst);
    e.spec._inst = inst;
    const s = e.spec._.sizing;
    const u = { nodeId: inst };
    if (e.spec.layoutPositioning) Object.assign(u, { layoutPositioning: "ABSOLUTE", x: e.spec.x, y: e.spec.y });
    if (e.parent.layoutMode && e.parent.layoutMode !== "NONE" && !e.spec.layoutPositioning) {
      u.layoutSizingHorizontal = s.w;
      u.layoutSizingVertical = s.h;
      if (s.w === "FIXED") u.width = e.spec.width;
      if (s.h === "FIXED") u.height = e.spec.height;
    } else {
      if (s.w !== "HUG") u.width = e.spec.width;
      if (s.h !== "HUG") u.height = e.spec.height;
    }
    updates.push(u);
    if (slot.icon && occ.rot) {
      u.rotation = -occ.rot;
      if (!(e.parent.layoutMode && e.parent.layoutMode !== "NONE") || e.spec.layoutPositioning) {
        // Figma turns about the layer's corner, CSS about its centre: the corner moves so the box stays put.
        const r = ((-occ.rot % 360) + 360) % 360;
        if (r === 270) u.x = e.spec.x + e.spec.width;
        if (r === 180) Object.assign(u, { x: e.spec.x + e.spec.width, y: e.spec.y + e.spec.height });
        if (r === 90) u.y = e.spec.y + e.spec.height;
      }
    }
    if (slot.icon) {
      const ic = manifest.icons[slot.icon];
      updates.push({ nodeId: `I${inst};${ic.color}`, fills: [occ.c.fg ?? "#000000e5"] });
      addBind(`I${inst};${ic.color}`, "fills[0]", occ.c.fg, occ.cd?.fg, "icon");
    } else {
      overrides(occ, manifest.components[slot.key], inst, updates, swaps);
    }
  }
  for (const s of swaps) await call("run_command", { engineCommand: "SWAP_INSTANCE", args: { main: s.main, ref: s.ref } }, { soft: true });
  for (let i = 0; i < updates.length; i += 300) await call("update_nodes", { updates: updates.slice(i, i + 300) }, { soft: true });
  // Icon colours after swaps (a swapped icon's colour layer is its new main's)
  if (del.length) await call("delete_nodes", { nodeIds: del }, { soft: true });
}

/** Source-node maps of built mains, kept in memory for overrides (the manifest stores ids by path). */
const mainSrc = new Map(); // key → { src, ids: Map(srcNode → main node id), slots: Map(srcNode → instance id) }

/** "w", "h", "wh": the axes a layer has a set size on (an override can change those without breaking its layout). */
function fixedAxes(spec) {
  if (spec.name === "__slot") return null;
  const w = spec.layoutSizingHorizontal ? spec.layoutSizingHorizontal === "FIXED" : spec.width != null && spec.textAutoResize !== "WIDTH_AND_HEIGHT";
  const h = spec.layoutSizingVertical ? spec.layoutSizingVertical === "FIXED" : spec.height != null && !["WIDTH_AND_HEIGHT", "HEIGHT"].includes(spec.textAutoResize);
  return (w ? "w" : "") + (h ? "h" : "") || null;
}
const I = (base) => (base.startsWith("I") ? base : `I${base}`);
/** The overrides that turn an instance of `main` into the occurrence `occ` (same shape): texts, icons, colours. */
function overrides(occ, mainRec, inst, updates, swaps) {
  const info = mainSrc.get(mainRec?.key);
  if (!info) return;
  // An instance's layer id is the instance's id and the main's ids from below its root down to the layer
  // ("I<instance>;<frame>;<nested instance>;<layer>").
  const walk = (o, s, base, info, path) => {
    if (!s || !o) return;
    const own = (n) => info.slots.get(n) ?? info.ids.get(n);
    const idOf = (n) => (n === info.src ? base : `${I(base)};${[...path, own(n)].join(";")}`);
    const below = s === info.src ? [] : [...path, own(s)];
    if (s !== info.src && info.slots.has(s)) {
      const nb = idOf(s);
      if (s.kind === "icon") {
        if (o.icon !== s.icon && manifest.icons[o.icon]) swaps.push({ ref: nb, main: manifest.icons[o.icon].id });
        const ic = manifest.icons[o.icon] ?? manifest.icons[s.icon];
        if (ic && (o.icon !== s.icon || (o.c?.fg ?? "") !== (s.c?.fg ?? ""))) {
          updates.push({ nodeId: `${I(nb)};${ic.color}`, fills: [o.c?.fg ?? "#000000e5"] });
          addBind(`${I(nb)};${ic.color}`, "fills[0]", o.c?.fg, o.cd?.fg, "icon");
        }
        if (Math.abs(o.w - s.w) > 0.5 || Math.abs(o.h - s.h) > 0.5) updates.push({ nodeId: nb, width: o.w, height: o.h });
        if ((o.rot ?? 0) !== (s.rot ?? 0)) updates.push({ nodeId: nb, rotation: -(o.rot ?? 0) });
        return;
      }
      const nested = [...mainSrc.values()].find((m) => m.sig === C.sig(s));
      if (nested) walk(o, nested.src, nb, nested, []);
      return;
    }
    const id = idOf(s);
    const f = s !== info.src && info.fixed?.get(s);
    if (f) {
      const u = {};
      if (f.includes("w") && Math.abs(o.w - s.w) > 0.5) u.width = Math.round(o.w * 100) / 100;
      if (f.includes("h") && Math.abs(o.h - s.h) > 0.5) u.height = Math.round(o.h * 100) / 100;
      if (Object.keys(u).length) updates.push({ nodeId: id, ...u });
    }
    if (o.kind === "text" && s.kind === "text") {
      if (o.chars !== s.chars) updates.push({ nodeId: id, characters: o.chars });
      const of = o.useph ? o.c?.ph : o.c?.fg;
      const sf = s.useph ? s.c?.ph : s.c?.fg;
      if (of && of !== sf) {
        updates.push({ nodeId: id, fills: [of] });
        addBind(id, "fills[0]", of, o.useph ? o.cd?.ph : o.cd?.fg, "text");
      }
      return;
    }
    if (o.kind === "box" && s.kind === "box") {
      const oal = C.autoLayout(o);
      const sal = C.autoLayout(s);
      if (oal && sal && oal.mode === sal.mode) {
        if (oal.pad.some((v, i) => Math.abs(v - sal.pad[i]) > 0.5)) updates.push({ nodeId: id, padding: oal.pad.map((v) => Math.round(v * 100) / 100) });
        if (Math.abs(oal.gap - sal.gap) > 0.5) updates.push({ nodeId: id, itemSpacing: Math.round(oal.gap * 100) / 100 });
      }
      if ((o.c.bg ?? null) !== (s.c.bg ?? null)) {
        updates.push({ nodeId: id, fills: o.c.bg ? [o.c.bg] : [] });
        if (o.c.bg) addBind(id, "fills[0]", o.c.bg, o.cd?.bg, "fill");
      }
      if (!C.autoLayout(s)) {
        // Absolutely placed children (an indent, a margin): their place within the box is the occurrence's
        o.children.forEach((oc, i) => {
          const sc = s.children[i];
          if (!sc) return;
          const dx = oc.x - o.x - (sc.x - s.x), dy = oc.y - o.y - (sc.y - s.y);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            const cid = info.slots.has(sc) ? `${I(base)};${[...below, info.slots.get(sc)].join(";")}` : `${I(base)};${[...below, info.ids.get(sc)].join(";")}`;
            updates.push({ nodeId: cid, x: Math.round((oc.x - o.x) * 100) / 100, y: Math.round((oc.y - o.y) * 100) / 100 });
          }
        });
      }
      o.children.forEach((oc, i) => walk(oc, s.children[i], base, info, below));
    }
  };
  walk(occ, info.src, inst, info, []);
}

// ---- components ----------------------------------------------------------------------------------------------------
const load = (f) => JSON.parse(readFileSync(join(OUT, f), "utf8"));
const prepTree = (n) => C.foldText(C.prep(n));

function variantsFromCaptures() {
  const gallery = load("gallery.json");
  const index = load("index.json");
  const variants = new Map(); // sig → variant
  const order = [];
  const add = (v) => {
    if (variants.has(v.sig)) return variants.get(v.sig);
    variants.set(v.sig, v);
    order.push(v);
    return v;
  };
  const perSet = new Map();
  const nextState = (set) => {
    const n = (perSet.get(set) ?? 0) + 1;
    perSet.set(set, n);
    return n;
  };
  const leaves = (n, out = []) => {
    for (const c of n.children ?? []) {
      if (C.isLeaf(c)) out.push(c);
      leaves(c, out);
    }
    return out;
  };
  const fromOccurrence = (n, origin) => {
    const s = C.sig(n);
    if (variants.has(s)) return;
    const mods = (n.cls ?? []).slice(1).join(" ") || "default";
    add({ sig: s, set: n.ds, src: n, name: `Variant=${mods}, Size=${Math.round(n.w)}×${Math.round(n.h)}, State=${origin} ${nextState(n.ds)}` });
  };
  for (const cell of gallery) {
    const nodes = cell.nodes.map(prepTree).filter(Boolean);
    if (!nodes.length) continue;
    let root = nodes.length === 1 ? nodes[0] : null;
    if (!root) {
      const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y));
      const w = Math.max(...nodes.map((n) => n.x + n.w)) - x, h = Math.max(...nodes.map((n) => n.y + n.h)) - y;
      root = { kind: "box", tag: "div", ds: null, cls: ["cell"], x, y, w, h, c: {}, bw: [0, 0, 0, 0], pad: [0, 0, 0, 0], rad: [0, 0, 0, 0], sh: [], mar: [0, 0, 0, 0], gap: [0, 0], children: nodes, d: "block" };
    }
    if (root.kind !== "box") continue;
    const [comp, ...parts] = cell.gid.split("/");
    const [variant, size, state] = parts;
    const s = C.sig(root);
    for (const l of leaves(root)) fromOccurrence(l, "nested");
    if (variants.has(s)) continue;
    add({ sig: s, set: comp, src: root, name: `Variant=${variant}, Size=${size}, State=${state}`, gid: cell.gid });
  }
  const screens = index.screens.map((sc) => ({ ...sc, data: load(`screens/${sc.id}.json`) }));
  for (const sc of screens) {
    sc.data.tree = prepTree(sc.data.tree);
    const visit = (n) => {
      if (C.isLeaf(n)) fromOccurrence(n, "screen");
      for (const c of n.children ?? []) visit(c);
    };
    visit(sc.data.tree);
  }
  // Depth: a main is built after the mains of the ds parts inside it.
  const depth = new Map();
  const d = (v) => {
    if (depth.has(v.sig)) return depth.get(v.sig);
    depth.set(v.sig, 0);
    let m = 0;
    for (const l of leaves(v.src)) {
      const lv = variants.get(C.sig(l));
      if (lv && lv !== v) m = Math.max(m, d(lv) + 1);
    }
    depth.set(v.sig, m);
    return m;
  };
  order.forEach((v, i) => {
    v.key = `${v.set}#${i}`;
    d(v);
  });
  return { variants, order, depth, screens };
}

async function buildIcons(names, pageId) {
  const todo = names.filter((n) => !manifest.icons[n]);
  const cols = 24;
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const specs = [];
    for (const [j, name] of batch.entries()) {
      const box = name.startsWith("16") ? 16 : 24;
      const k = i + j + Object.keys(manifest.icons).length;
      specs.push({
        type: "FRAME", name: `Icon / ${name}`, x: (k % cols) * 48, y: 80 + Math.floor(k / cols) * 48, width: box, height: box, fills: [], clipsContent: false,
        children: [
          { type: "RECTANGLE", name: "glyph", x: 0, y: 0, width: box, height: box, isMask: true, maskType: "ALPHA", fills: [{ type: "IMAGE", imageRef: await imageHash(`${name}.png`, "icons"), scaleMode: "FILL" }] },
          { type: "RECTANGLE", name: "color", x: 0, y: 0, width: box, height: box, fills: ["#000000e5"] },
        ],
      });
    }
    const r = await call("create_nodes", { parentId: pageId, nodes: specs }); // ≤ 40 icons × 3 layers
    const created = r.nodes;
    // Constraints after the size (a frame is made at 100 × 100 first: SCALE children would shrink with it)
    await call("update_nodes", { updates: batch.flatMap((_, j) => [1, 2].map((k) => ({ nodeId: created[j * 3 + k].nodeId, constraints: { horizontal: "SCALE", vertical: "SCALE" } }))) });
    for (let j = 0; j < batch.length; j++) {
      const id = created[j * 3].nodeId;
      const color = created[j * 3 + 2].nodeId;
      await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [id] });
      const seed = (await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: id, parent: await seedsFrame() } })).selection[0].id;
      await call("reparent_nodes", { nodeIds: [seed], parentId: await seedsFrame(), index: 0 }, { soft: true });
      manifest.icons[batch[j]] = { id, color, seed };
      addBind(color, "fills[0]", "#000000e5", "#ffffff", "icon");
    }
    save();
  }
  await flushBinds();
}

async function buildComponents(model) {
  const pageId = manifest.pages.Components;
  // Icons first: every icon any capture uses.
  const index = load("index.json");
  const names = Object.keys(index.icons).sort();
  await buildIcons(names, pageId);
  console.log("icons", Object.keys(manifest.icons).length);

  // Layout: sets in alphabetical order, each a block of rows below the icons.
  const sets = new Map();
  for (const v of model.order) sets.set(v.set, [...(sets.get(v.set) ?? []), v]);
  const iconRows = Math.ceil(names.length / 24);
  let y = 80 + iconRows * 48 + 160;
  const slotFor = (n) => {
    const v = model.variants.get(C.sig(n));
    const rec = v && manifest.components[v.key];
    if (!rec) return null;
    return { key: v.key, hugW: rec.hugW, hugH: rec.hugH };
  };
  const place = new Map();
  for (const [set, vs] of [...sets].sort((a, b) => a[0].localeCompare(b[0]))) {
    let x = 0, rowH = 0;
    const top = y;
    for (const v of vs) {
      if (x > 0 && x + v.src.w > 2400) {
        x = 0;
        y += rowH + 32;
        rowH = 0;
      }
      place.set(v.key, { x, y });
      x += Math.ceil(v.src.w) + 32;
      rowH = Math.max(rowH, v.src.h);
    }
    y += rowH + 160;
    manifest.sets[set] = { ...(manifest.sets[set] ?? {}), top };
  }
  // Mains by depth.
  const byDepth = [...model.order].sort((a, b) => model.depth.get(a.sig) - model.depth.get(b.sig));
  let done = 0;
  for (let i = 0; i < byDepth.length; ) {
    const dep = model.depth.get(byDepth[i].sig);
    const batch = [];
    while (i < byDepth.length && batch.length < 8 && model.depth.get(byDepth[i].sig) === dep) batch.push(byDepth[i++]);
    const todo = batch.filter((v) => !manifest.components[v.key]);
    if (!todo.length) continue;
    const specs = todo.map((v) => {
      const at = place.get(v.key);
      const spec = C.toSpec(v.src, { parentAL: "NONE", px: v.src.x - at.x, py: v.src.y - at.y, depth: 0 }, { slotFor });
      spec.name = vs1(v) ? v.set : v.name;
      return spec;
    });
    const all = await create(pageId, specs);
    for (const [j, v] of todo.entries()) {
      const spec = specs[j];
      const id = spec._id;
      await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [id] });
      const ids = new Map();
      const slots = new Map();
      const fixed = new Map();
      for (const e of flatten(spec)) {
        if (!e.spec._?.src) continue;
        const f = fixedAxes(e.spec);
        if (f) fixed.set(e.spec._.src, f);
        if (e.spec.name !== "__slot") ids.set(e.spec._.src, e.spec._id);
      }
      const hugW = spec.layoutMode && (spec.layoutMode === "HORIZONTAL" ? spec.primaryAxisSizingMode : spec.counterAxisSizingMode) === "AUTO";
      const hugH = spec.layoutMode && (spec.layoutMode === "HORIZONTAL" ? spec.counterAxisSizingMode : spec.primaryAxisSizingMode) === "AUTO";
      manifest.components[v.key] = { key: v.key, id, set: v.set, name: spec.name, gid: v.gid ?? null, hugW: !!hugW, hugH: !!hugH };
      mainSrc.set(v.key, { key: v.key, src: v.src, sig: v.sig, ids, slots, fixed });
    }
    collectBinds(all);
    const slotIds = new Map();
    await fillSlots(all, slotIds);
    for (const v of todo) {
      const info = mainSrc.get(v.key);
      for (const [n, inst] of slotIds) if (isInside(v.src, n)) info.slots.set(n, inst);
      const paths = pathsOf(v.src);
      const rec = manifest.components[v.key];
      rec.fixedPaths = Object.fromEntries([...info.fixed].filter(([n]) => paths.has(n) && n !== v.src).map(([n, f]) => [paths.get(n), f]));
      rec.paths = Object.fromEntries([...info.ids].filter(([n]) => paths.has(n)).map(([n, id]) => [paths.get(n), id]));
      rec.slotPaths = Object.fromEntries([...info.slots].filter(([n]) => paths.has(n)).map(([n, id]) => [paths.get(n), id]));
    }
    const seeds = [];
    for (const v of todo) {
      const rec = manifest.components[v.key];
      rec.seed = (await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: rec.id, parent: await seedsFrame() } })).selection[0].id;
      seeds.push(rec.seed);
    }
    await call("reparent_nodes", { nodeIds: seeds, parentId: await seedsFrame(), index: 0 }, { soft: true });
    await flushBinds();
    done += todo.length;
    save();
    console.log(`components ${done} (depth ${dep})`);
  }
  // Variant sets.
  for (const [set, vs] of sets) {
    if (vs.length < 2 || manifest.sets[set]?.id) continue;
    const ids = vs.map((v) => manifest.components[v.key]?.id).filter(Boolean);
    const r = await call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: ids }, { soft: true });
    const setId = r?.selection?.[0]?.id;
    if (setId) {
      await call("update_nodes", { updates: [{ nodeId: setId, name: set }] }, { soft: true });
      manifest.sets[set] = { ...(manifest.sets[set] ?? {}), id: setId };
    }
  }
  await layoutSections(sets, pageId);
  save();
  function vs1(v) {
    return sets.get(v.set).length === 1;
  }
}
function pathsOf(root, p = "", out = new Map()) {
  out.set(root, p);
  (root.children ?? []).forEach((c, i) => pathsOf(c, p ? `${p}.${i}` : `${i}`, out));
  return out;
}
/**
 * The page's order: one frame "Wecra components" (vertical auto layout) holding a section per set — its title, then
 * the set — Icons first. Made once; a rebuild finds it by the manifest (or by name) and leaves it.
 */
async function layoutSections(sets, pageId) {
  if (manifest.sectionsRoot) return;
  const meta = String(await call("get_metadata", { nodeId: pageId, depth: 1 }));
  const old = [...meta.matchAll(/^ {2}<\w+ id="([^"]+)" name="(Wecra components|Section \/ [^"]*)"/gm)].map((x) => x[1]);
  if (old.length) await call("delete_nodes", { nodeIds: old }, { soft: true });
  const title = (t) => ({ type: "TEXT", name: "Title", characters: t, fontFamily: "Inter", fontStyle: "Semi Bold", fontSize: 24, lineHeight: 32, fills: ["#000000e5"] });
  const names = [...sets.keys()].sort((a, b) => a.localeCompare(b));
  const section = (name, extra = []) => ({ type: "FRAME", name: `Section / ${name}`, fills: [], clipsContent: false, layoutMode: "VERTICAL", itemSpacing: 24, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", children: [title(name), ...extra] });
  const r = await call("create_nodes", {
    parentId: pageId,
    nodes: [
      {
        type: "FRAME", name: "Wecra components", x: 0, y: 0, fills: ["#f5f5f5"], clipsContent: false, layoutMode: "VERTICAL", itemSpacing: 120, padding: 80, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO",
        children: [
          section("Icons", [{ type: "FRAME", name: "Icons", fills: [], clipsContent: false, layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 32, counterAxisSpacing: 32, width: 1600, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO" }]),
          ...names.map((n) => section(n)),
        ],
      },
    ],
  });
  const ids = r.nodes.map((n) => n.nodeId);
  manifest.sectionsRoot = ids[0];
  // ids: root, Icons section, its title, the icons frame, then per set: section, title
  const iconsFrame = ids[3];
  await call("reparent_nodes", { nodeIds: Object.values(manifest.icons).map((i) => i.id), parentId: iconsFrame, index: 0 }, { soft: true });
  names.forEach((n, i) => {
    manifest.sets[n] = { ...(manifest.sets[n] ?? {}), section: ids[4 + i * 2] };
  });
  for (const n of names) {
    const target = manifest.sets[n].id ?? Object.values(manifest.components).find((c) => c.set === n)?.id;
    if (target) await call("reparent_nodes", { nodeIds: [target], parentId: manifest.sets[n].section, index: 1 }, { soft: true });
  }
  save();
}
const isInside = (root, n) => {
  if (root === n) return true;
  return (root.children ?? []).some((c) => isInside(c, n));
};

// ---- screens -------------------------------------------------------------------------------------------------------
async function buildScreens(model) {
  const slotFor = (n) => {
    const v = model.variants.get(C.sig(n));
    const rec = v && manifest.components[v.key];
    if (!rec) return null;
    return { key: v.key, hugW: rec.hugW, hugH: rec.hugH };
  };
  const perPage = {};
  mkdirSync(join(OUT, "compare"), { recursive: true });
  for (const sc of model.screens) {
    if (only && !only.includes(sc.id)) continue;
    const pageId = manifest.pages[sc.page];
    const k = (perPage[sc.page] = (perPage[sc.page] ?? -1) + 1);
    if (manifest.screens[sc.id]?.id) {
      if (!only) continue;
      await call("delete_nodes", { nodeIds: [manifest.screens[sc.id].id] }, { soft: true });
    }
    const tree = sc.data.tree;
    const spec = C.toSpec(tree, { parentAL: "NONE", px: 0, py: 0, depth: 0 }, { slotFor });
    Object.assign(spec, { name: sc.title, x: (k % 3) * 1640, y: Math.floor(k / 3) * 1100, width: 1440, height: 900, clipsContent: true });
    if (!spec.fills?.length) spec.fills = ["#ffffff"];
    if (spec.layoutMode) Object.assign(spec, { primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
    const all = await create(pageId, [spec]);
    collectBinds(all);
    await fillSlots(all, null);
    await flushBinds();
    manifest.screens[sc.id] = { id: spec._id, title: sc.title, page: sc.page };
    save();
    const shot = await mcp.call("get_screenshot", { nodeId: spec._id, maxSize: 1440 }, { soft: true });
    const img = Array.isArray(shot) ? shot.find((x) => x.image) : shot;
    if (img?.image) writeFileSync(join(OUT, "compare", `${sc.id}.png`), Buffer.from(img.image, "base64"));
    console.log("screen", sc.id, all.length, "layers");
  }
}

// ---- update in place ------------------------------------------------------------------------------------------------
/** get_metadata's outline as a tree of {type, id, name, children}. */
function parseMeta(xml) {
  const root = { children: [] };
  const stack = [root];
  for (const line of String(xml).split("\n")) {
    const open = /^\s*<(\w+) id="([^"]+)" name="([^"]*)"/.exec(line);
    if (open) {
      const n = { type: open[1], id: open[2], name: open[3], children: [] };
      stack[stack.length - 1].children.push(n);
      if (!/\/>\s*$/.test(line)) stack.push(n);
    } else if (/^\s*<\/\w+>/.test(line)) stack.pop();
  }
  return root.children[0];
}
const PLACE = new Set(["x", "y"]);
/** The update that brings an existing layer to its spec (no children, no type; the root keeps its name and place). */
function specUpdate(spec, id, isRoot) {
  const { _: _n, _id: _i, _inst: _s, children: _c, type: _t, ...props } = spec;
  if (isRoot) {
    delete props.name;
    for (const k of PLACE) delete props[k];
  }
  return { nodeId: id, ...props };
}

/**
 * Revisions go into the layers already there: every main and screen is converted again and its existing layers
 * (found by the manifest's paths, or by walking the screen's outline next to the spec) get the new properties;
 * instances get their overrides again. Nothing is created or deleted, so instances stay linked to their mains.
 */
async function updateInPlace(model) {
  const slotFor = (n) => {
    const v = model.variants.get(C.sig(n));
    const rec = v && manifest.components[v.key];
    return rec ? { key: v.key, hugW: rec.hugW, hugH: rec.hugH } : null;
  };
  const updates = [];
  const swaps = [];
  let mains = 0, screens = 0, skipped = 0;
  for (const v of model.order) {
    const rec = manifest.components[v.key];
    if (!rec) continue;
    const spec = C.toSpec(v.src, { parentAL: "NONE", px: v.src.x, py: v.src.y, depth: 0 }, { slotFor });
    const paths = pathsOf(v.src);
    const entries = flatten(spec);
    await resolveImages([spec]);
    for (const e of entries) {
      const src = e.spec._?.src;
      const path = paths.get(src);
      if (e.spec.name === "__slot") {
        const inst = rec.slotPaths?.[path];
        if (!inst) continue;
        if (e.spec._.slot.icon) {
          const ic = manifest.icons[e.spec._.slot.icon];
          updates.push({ nodeId: `I${inst};${ic.color}`, fills: [src.c?.fg ?? "#000000e5"] });
          addBind(`I${inst};${ic.color}`, "fills[0]", src.c?.fg, src.cd?.fg, "icon");
        } else overrides(src, manifest.components[e.spec._.slot.key], inst, updates, swaps);
        continue;
      }
      const id = e.spec === spec ? rec.id : rec.paths?.[path];
      if (!id) {
        skipped++;
        continue;
      }
      e.spec._id = id;
      updates.push(specUpdate(e.spec, id, e.spec === spec));
    }
    collectBinds(entries.filter((e) => e.spec._id));
    mains++;
  }
  for (const sc of model.screens) {
    if (only && !only.includes(sc.id)) continue;
    const rec = manifest.screens[sc.id];
    if (!rec?.id) continue;
    const meta = parseMeta(await call("get_metadata", { nodeId: rec.id, depth: 60 }));
    const spec = C.toSpec(sc.data.tree, { parentAL: "NONE", px: 0, py: 0, depth: 0 }, { slotFor });
    await resolveImages([spec]);
    const done = [];
    const align = (sp, mn, isRoot) => {
      if (!mn) return void skipped++;
      if (sp.name === "__slot") {
        if (mn.type !== "instance") return void skipped++;
        const slot = sp._.slot;
        const occ = sp._.src;
        if (slot.icon) {
          const ic = manifest.icons[slot.icon];
          updates.push({ nodeId: `I${mn.id};${ic.color}`, fills: [occ.c?.fg ?? "#000000e5"] });
          addBind(`I${mn.id};${ic.color}`, "fills[0]", occ.c?.fg, occ.cd?.fg, "icon");
        } else overrides(occ, manifest.components[slot.key], mn.id, updates, swaps);
        return;
      }
      sp._id = mn.id;
      done.push({ spec: sp });
      updates.push(specUpdate(sp, mn.id, isRoot));
      const kids = sp.children ?? [];
      if (kids.length !== mn.children.length) return void skipped++;
      kids.forEach((k, i) => align(k, mn.children[i], false));
    };
    align(spec, meta, true);
    collectBinds(done);
    screens++;
  }
  for (const sw of swaps) await call("run_command", { engineCommand: "SWAP_INSTANCE", args: { main: sw.main, ref: sw.ref } }, { soft: true });
  for (let i = 0; i < updates.length; i += 300) await call("update_nodes", { updates: updates.slice(i, i + 300) }, { soft: true });
  await flushBinds();
  console.log(`updated in place: ${mains} mains, ${screens} screens, ${updates.length} layer updates, ${skipped} not matched`);
}

// ---- run -------------------------------------------------------------------------------------------------------------
if (args.includes("--dry")) {
  const model = variantsFromCaptures();
  const count = (s) => 1 + (s.children ?? []).reduce((a, c) => a + count(c), 0);
  const sets = {};
  for (const v of model.order) sets[v.set] = (sets[v.set] ?? 0) + 1;
  console.log("variants", model.order.length, JSON.stringify(sets));
  for (const sc of model.screens) {
    const spec = C.toSpec(sc.data.tree, { parentAL: "NONE", px: 0, py: 0, depth: 1 }, { slotFor: () => ({ key: "x" }) });
    let al = 0, slots = 0;
    const walk = (s) => { if (s.layoutMode) al++; if (s.name === "__slot") slots++; (s.children ?? []).forEach(walk); };
    walk(spec);
    console.log(sc.id, "layers", count(spec), "autolayout", al, "slots", slots, "bytes", JSON.stringify(clean(spec)).length);
  }
  process.exit(0);
}
for (const p of PAGES) await ensurePage(p);
if (phase === "all" || phase === "variables") await buildVariables();
if (phase === "update") {
  const model = variantsFromCaptures();
  for (const v of model.order) if (manifest.components[v.key]) mainSrc.set(v.key, rebuildInfo(v));
  await updateInPlace(model);
} else if (phase !== "variables") {
  const model = variantsFromCaptures();
  console.log("variants", model.order.length, "sets", new Set(model.order.map((v) => v.set)).size);
  if (phase === "all" || phase === "components") await buildComponents(model);
  else {
    // Screens alone: the mains' source maps from this run's captures (the ids from the manifest).
    for (const v of model.order) if (manifest.components[v.key]) mainSrc.set(v.key, rebuildInfo(v));
  }
  if (phase === "all" || phase === "screens") await buildScreens(model);
}
if (uploads) await call("delete_nodes", { nodeIds: [uploads] }, { soft: true });
save();
console.log(problems.length ? `${problems.length} problems:\n` + [...new Set(problems)].slice(0, 60).join("\n") : "no problems");

/** A main's source map from the manifest's ids (screens phase run alone). */
function rebuildInfo(v) {
  const rec = manifest.components[v.key];
  const ids = new Map(Object.entries(rec.paths ?? {}).map(([p, id]) => [nodeAt(v.src, p), id]));
  const slots = new Map(Object.entries(rec.slotPaths ?? {}).map(([p, id]) => [nodeAt(v.src, p), id]));
  const fixed = new Map(Object.entries(rec.fixedPaths ?? {}).map(([p, f]) => [nodeAt(v.src, p), f]));
  return { key: v.key, src: v.src, sig: v.sig, ids, slots, fixed };
}
function nodeAt(root, path) {
  let n = root;
  for (const i of path.split(".").filter(Boolean)) n = n.children[Number(i)];
  return n;
}
