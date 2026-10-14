#!/usr/bin/env node
// The atoms of the atomic restructure (tools/ui-kit/atomic-plan.md): each ONE component set covering every
// condition as variant properties, its content as component properties — startContent / Label / endContent:
// "Start content" and "End content" (booleans, show / hide), "Start icon" and "End icon" (instance swaps, the Icon
// sets as preferred values), "Label" (text). Every colour bound to a Semantic variable, every size to a Semantic
// size variable (bindSizes). Built once, laid out as a grid, read back; a re-run with the set present only
// re-styles its variants in place.
//
//   node tools/ui-kit/atoms.mjs button|badge [--dry]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { guard } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");
const args = process.argv.slice(2);
const which = args[0];
const dry = args.includes("--dry");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
const mcp = await connect();
if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);
const P = { page: "Components" };
const C = manifest.variables.colors;
manifest.atoms ??= {};

/** Every combination of the variant properties, in order. */
const combos = (props) => Object.entries(props).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const nameOf = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ");
const kids = async (id) => [...String(await mcp.call("get_metadata", { nodeId: id, depth: 1 })).matchAll(/^ {2}<(\w+) id="([^"]+)" name="([^"]*)"/gm)].map((m) => ({ type: m[1], id: m[2], name: m[3] }));
const deep = async (id) => [...String(await mcp.call("get_metadata", { nodeId: id, depth: 6 })).matchAll(/<(\w+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] }));
async function bind(ids, field, variableId) {
  if (!ids.length || !variableId) return;
  for (let i = 0; i < ids.length; i += 40) await mcp.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field, variableId });
}
/** A frame "Atoms" beside the old sections (the page is reorganised by level in the last step). */
async function atomsFrame() {
  if (manifest.atoms.frame) return manifest.atoms.frame;
  const r = await mcp.call("create_nodes", { parentId: manifest.pages.Components, nodes: [{ type: "FRAME", name: "Atoms", x: 2800, y: 0, width: 400, height: 400, fills: [], layoutMode: "VERTICAL", itemSpacing: 120, padding: [80, 80, 80, 80], layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" }] }, P);
  manifest.atoms.frame = r.created[0].id;
  save();
  return manifest.atoms.frame;
}
/** An icon instance (a copy of the icon's seed instance) at (x, y) in `parent`, its Set following the Icons mode. */
async function iconIn(parent, icon, x, y) {
  const r = await mcp.call("duplicate_nodes", { nodeIds: [manifest.icons[icon].seed], parentId: parent }, P);
  const id = (r.copies ?? r.nodes)[0].nodeId ?? (r.copies ?? r.nodes)[0].id;
  await mcp.call("update_nodes", { updates: [{ nodeId: id, x, y, visible: true }] });
  await mcp.call("bind_variable", { nodeIds: [id], field: "componentProperties.Set", variableId: manifest.variables.icons.iconSet });
  return id;
}

// ---- Button ---------------------------------------------------------------------------------------------------------------
// The app's Button / IconButton / ToggleIconButton (ds/components/Button.module.css) as one set.
const BUTTON = {
  props: {
    Variant: ["Primary", "Secondary", "Destructive", "Destructive secondary", "Ghost", "Ghost secondary", "Link", "Tinted"],
    Size: ["Default", "Large"],
    State: ["Default", "Hover", "Pressed", "Focused", "Selected", "Disabled"],
    "Icon only": ["False", "True"],
  },
  /** Colours of a combination: bg (fill), stroke (inside 1 px), fg (text), icon. Semantic variable names. */
  look({ Variant: v, State: s }) {
    const st = s === "Selected" ? "Pressed" : s;
    const off = s === "Disabled";
    switch (v) {
      case "Primary":
        return off ? { bg: "bg-disabled", fg: "text-ondisabled", icon: "icon-ondisabled" } : { bg: st === "Hover" ? "bg-brand-hover" : st === "Pressed" ? "bg-brand-pressed" : "bg-brand", fg: st === "Pressed" ? "text-onbrand-secondary" : "text-onbrand", icon: st === "Pressed" ? "icon-onbrand-secondary" : "icon-onbrand" };
      case "Destructive":
        return off ? { bg: "bg-disabled", fg: "text-ondisabled", icon: "icon-ondisabled" } : { bg: st === "Hover" ? "bg-danger-hover" : st === "Pressed" ? "bg-danger-pressed" : "bg-danger", fg: st === "Pressed" ? "text-ondanger-secondary" : "text-ondanger", icon: st === "Pressed" ? "icon-ondanger-secondary" : "icon-ondanger" };
      case "Secondary":
        return off ? { fg: "text-disabled", icon: "icon-disabled" } : { bg: st === "Hover" ? "bg-secondary" : st === "Pressed" ? "bg-transparent-pressed" : null, stroke: "border-translucent", fg: "text", icon: "icon" };
      case "Destructive secondary":
        return off ? { fg: "text-disabled", icon: "icon-disabled" } : { bg: st === "Hover" || st === "Pressed" ? "bg-danger-tertiary" : null, stroke: st === "Pressed" ? "border-danger-strong" : "border-danger", fg: "text-danger", icon: "icon-danger" };
      case "Ghost":
      case "Ghost secondary": {
        const sec = v === "Ghost secondary";
        if (off) return { fg: "text-disabled", icon: "icon-disabled" };
        if (s === "Selected") return { bg: "bg-selected", fg: "text-selected", icon: "icon-selected" };
        return { bg: st === "Hover" ? "bg-hover" : st === "Pressed" ? "bg-pressed" : null, fg: sec && st === "Default" ? "text-secondary" : "text", icon: sec && st === "Default" ? "icon-secondary" : st === "Hover" ? "icon-hover" : "icon" };
      }
      case "Link":
        return off ? { fg: "text-disabled", icon: "icon-disabled" } : { bg: st === "Pressed" ? "bg-selected" : null, fg: "text-brand", icon: "icon-brand", underline: st === "Hover" };
      case "Tinted":
        return { bg: off ? "bg-secondary" : st === "Default" ? "bg-secondary" : "bg-tertiary", fg: off ? "text-disabled" : "text", icon: off ? "icon-disabled" : "icon" };
    }
    throw new Error(v);
  },
};
const varOf = (name) => {
  const id = C[name] ?? C[name.replace(/^app\//, "")];
  if (!id) throw new Error(`no colour variable ${name}`);
  return id;
};

async function buildButton() {
  const rec = (manifest.atoms.Button ??= { variants: {} });
  const all = combos(BUTTON.props);
  if (dry) return console.log(`Button: ${all.length} variants`);
  const parent = await atomsFrame();
  // 1. The base variant: [startContent (20 wide, its 24 icon 4 px into the padding)] [Label] [endContent (4 + 16)]
  if (!rec.base) {
    const base = all[0];
    const r = await mcp.call("create_nodes", {
      parentId: parent,
      nodes: [{
        type: "FRAME", name: nameOf(base), layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", itemSpacing: 0, padding: [0, 8, 0, 8],
        height: 24, layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED", cornerRadius: 5, fills: ["#0D99FF"], clipsContent: false,
        children: [
          { type: "FRAME", name: "startContent", width: 20, height: 24, fills: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
          { type: "TEXT", name: "Label", characters: "Button", fontSize: 11, lineHeight: 16, fills: ["#FFFFFF"] },
          { type: "FRAME", name: "endContent", width: 20, height: 24, fills: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
        ],
      }],
    }, P);
    const frame = r.created[0].id;
    const [start, label, end] = (await kids(frame)).map((k) => k.id);
    const si = await iconIn(start, "24.plus", -4, 0);
    const ei = await iconIn(end, "16.chevron.down", 4, 4);
    await mcp.call("apply_style", { nodeIds: [label], slot: "text", styleId: manifest.textStyles["body-medium"] });
    await mcp.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [frame] });
    const comb = await mcp.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [frame] });
    rec.set = comb.selection[0].id;
    rec.base = frame;
    rec.parts = { start, label, end, startIcon: si, endIcon: ei };
    rec.variants[nameOf(base)] = frame;
    await mcp.call("update_nodes", { updates: [{ nodeId: rec.set, name: "Button" }] });
    save();
    // Its variant properties (the name's pairs) and content properties, bound on the base's layers
    const defsNow = String(await mcp.call("get_metadata", { nodeId: rec.set, depth: 1 }));
    for (const k of Object.keys(BUTTON.props)) if (!new RegExp(`${k}=`).test(defsNow)) await mcp.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: rec.set, name: k, type: "VARIANT", defaultValue: base[k] } });
    await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: frame, values: base } });
    const iconSets24 = Object.entries(manifest.icons).filter(([n]) => n.startsWith("24")).map(([, i]) => i.set);
    const iconSets16 = Object.entries(manifest.icons).filter(([n]) => n.startsWith("16")).map(([, i]) => i.set);
    const add = (name, type, defaultValue, extra = {}) => mcp.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: rec.set, name, type, defaultValue, ...extra } });
    await add("Start content", "BOOL", false);
    await add("Start icon", "INSTANCE_SWAP", manifest.icons["24.plus"].id, { preferredValues: iconSets24 });
    await add("Label", "TEXT", "Button");
    await add("End content", "BOOL", false);
    await add("End icon", "INSTANCE_SWAP", manifest.icons["16.chevron.down"].id, { preferredValues: iconSets16 });
    const bindProp = (refs, field, prop) => mcp.call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs, field, prop } });
    await bindProp([start], "VISIBLE", "Start content");
    await bindProp([si], "OVERRIDDEN_SYMBOL_ID", "Start icon");
    await bindProp([label], "TEXT_DATA", "Label");
    await bindProp([end], "VISIBLE", "End content");
    await bindProp([ei], "OVERRIDDEN_SYMBOL_ID", "End icon");
    save();
  }
  if (args.includes("--base-only")) return;
  // 2. Every other combination: a copy of the base, its properties set
  for (const c of all) {
    const n = nameOf(c);
    if (rec.variants[n]) continue;
    const r = await mcp.call("duplicate_nodes", { nodeIds: [rec.base], parentId: rec.set }, P);
    const id = (r.copies ?? r.nodes)[0].nodeId ?? (r.copies ?? r.nodes)[0].id;
    await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: id, values: c } });
    rec.variants[n] = id;
    if (Object.keys(rec.variants).length % 24 === 0) {
      save();
      console.log(`Button variants ${Object.keys(rec.variants).length}/${all.length}`);
    }
  }
  save();
  // 3. Each variant's look and size, in place (the same every run)
  await styleButton(rec, all);
  // 4. The grid: rows Variant × Size, columns State × Icon only
  await layoutGrid(rec, all, BUTTON.props, ["Variant", "Size"], ["Icon only", "State"], 112, 48);
}

async function styleButton(rec, all) {
  const binds = new Map(); // field|variable → ids
  const B = (field, variable, id) => {
    if (!variable) return;
    const k = `${field}|${variable}`;
    binds.set(k, [...(binds.get(k) ?? []), id]);
  };
  const updates = [];
  const props = [];
  for (const c of all) {
    const id = rec.variants[nameOf(c)];
    const parts = await deep(id);
    const part = (name) => parts.find((p) => p.name === name)?.id;
    const [start, label, end] = ["startContent", "Label", "endContent"].map(part);
    const startIcon = parts[parts.findIndex((p) => p.id === start) + 1]?.type === "instance" ? parts[parts.findIndex((p) => p.id === start) + 1].id : null;
    const endIcon = parts[parts.findIndex((p) => p.id === end) + 1]?.type === "instance" ? parts[parts.findIndex((p) => p.id === end) + 1].id : null;
    const iconVectors = parts.filter((p) => p.type === "vector").map((p) => p.id);
    const look = BUTTON.look(c);
    const large = c.Size === "Large" || c.Variant === "Tinted";
    const h = large ? 32 : 24;
    const only = c["Icon only"] === "True";
    const pad = c.Variant === "Tinted" || large ? 12 : 8;
    const u = { nodeId: id, height: h, layoutSizingVertical: "FIXED", cornerRadius: c.Variant === "Tinted" ? 9999 : 5, fills: look.bg ? ["#000000"] : [], strokes: look.stroke ? ["#000000"] : [], strokeAlign: "INSIDE", strokeWeight: 1, effects: [] };
    if (only) Object.assign(u, { padding: [0, 0, 0, 0], width: h, layoutSizingHorizontal: "FIXED" });
    else Object.assign(u, { padding: [0, pad, 0, pad], layoutSizingHorizontal: "HUG" });
    updates.push(u);
    // Icon only: the icon fills the box (24 or 32), no label, no end; else the start icon 4 px into the padding
    // (the app: padding-left 4 when there is an icon, the 24 icon box then the label)
    // (Tinted keeps its 12 both sides: its rule comes after the icon's in the app's CSS)
    const tint = c.Variant === "Tinted";
    updates.push({ nodeId: start, width: only ? h : tint ? 24 : 28 - pad });
    if (startIcon) updates.push({ nodeId: startIcon, x: only ? (h - 24) / 2 : tint ? 0 : 4 - pad, y: (h - 24) / 2 });
    if (endIcon) updates.push({ nodeId: endIcon, x: 4, y: (h - 16) / 2 });
    updates.push({ nodeId: end, height: h });
    updates.push({ nodeId: start, height: h });
    updates.push({ nodeId: label, visible: !only, textDecoration: look.underline ? "UNDERLINE" : "NONE" });
    if (only) props.push({ start, end });
    if (look.bg) B("fills[0]", look.bg, id);
    if (look.stroke) B("strokes[0]", look.stroke, id);
    B("fills[0]", look.fg, label);
    for (const v of iconVectors) {
      B("fills[0]", look.icon, v);
      B("strokes[0]", look.icon, v);
    }
  }
  console.log(`Button: ${updates.length} updates`);
  for (let i = 0; i < updates.length; i += 40) await mcp.call("update_nodes", { updates: updates.slice(i, i + 40) });
  // Icon only: the start content always shows (unbound), its icon centred; the end hidden
  for (const { start, end } of props) {
    await mcp.call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [start, end], field: "VISIBLE", prop: "" } });
    await mcp.call("update_nodes", { updates: [{ nodeId: start, visible: true }, { nodeId: end, visible: false }] });
  }
  for (const [k, ids] of binds) {
    const [field, name] = k.split("|");
    await bind(ids, field, varOf(name));
  }
  // Focused: the app's 1-px outline 1 px off the button — a ring layer (absolute, stretching with the button);
  // an effect would be a spread-only shadow, which the renderer leaves out
  const rings = [];
  for (const c of all.filter((c) => c.State === "Focused")) {
    const id = rec.variants[nameOf(c)];
    if ((await kids(id)).some((k) => k.name === "focusRing")) continue;
    const b = (await mcp.call("get_design_context", { nodeId: id, depth: 0 })).nodes[0];
    const r = await mcp.call("create_nodes", { parentId: id, nodes: [{ type: "FRAME", name: "focusRing", fills: [], strokes: ["#0D99FF"], strokeAlign: "INSIDE", strokeWeight: 1, cornerRadius: c.Variant === "Tinted" ? 9999 : 7, layoutPositioning: "ABSOLUTE", x: -2, y: -2, width: b.width + 4, height: b.height + 4, constraints: { horizontal: "STRETCH", vertical: "STRETCH" } }] }, P);
    rings.push(r.created[0].id);
  }
  await bind(rings, "strokes[0]", varOf("border-selected"));
}

/** Lays the variants out as a grid (rows by `rowKeys`, columns by `colKeys`), the set hugging it; read back. */
async function layoutGrid(rec, all, props, rowKeys, colKeys, cw, ch) {
  const key = (c, ks) => ks.map((k) => c[k]).join("|");
  const rows = [...new Set(all.map((c) => key(c, rowKeys)))];
  const cols = [...new Set(all.map((c) => key(c, colKeys)))];
  const updates = all.map((c) => ({ nodeId: rec.variants[nameOf(c)], x: 20 + cols.indexOf(key(c, colKeys)) * cw, y: 20 + rows.indexOf(key(c, rowKeys)) * ch }));
  for (let i = 0; i < updates.length; i += 60) await mcp.call("update_nodes", { updates: updates.slice(i, i + 60) });
  const W = 40 + cols.length * cw, H = 40 + rows.length * ch;
  await mcp.call("update_nodes", { updates: [{ nodeId: rec.set, width: W, height: H }] });
  await guard(mcp, rec.set, { max: 4000, what: "Button" });
  console.log(`grid ${rows.length} × ${cols.length}, ${W} × ${H}`);
}

// ---- Menu item --------------------------------------------------------------------------------------------------------------
// The app's MenuItem (ds/components/Menu.module.css): [check column 16 − 8] [glyph column 24 − 4] [Label] [Shortcut]
// [submenu chevron], 8 apart, 16 in from the menu's edge; the highlight 8 in, as the app's ::before.
async function buildMenuItem() {
  const rec = (manifest.atoms.MenuItem ??= { variants: {} });
  const STATES = ["Default", "Highlighted", "Disabled"];
  const parent = await atomsFrame();
  if (!rec.base) {
    const r = await mcp.call("create_nodes", {
      parentId: parent,
      nodes: [{
        type: "FRAME", name: "State=Default", layoutMode: "HORIZONTAL", counterAxisAlignItems: "CENTER", itemSpacing: 8, padding: [0, 16, 0, 16],
        width: 200, height: 24, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", fills: [], clipsContent: false,
        children: [
          { type: "FRAME", name: "highlight", layoutPositioning: "ABSOLUTE", x: 8, y: 0, width: 184, height: 24, cornerRadius: 5, fills: ["#0C8CE9"], constraints: { horizontal: "STRETCH", vertical: "STRETCH" }, visible: false },
          { type: "FRAME", name: "checkColumn", width: 8, height: 16, fills: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
          { type: "FRAME", name: "startContent", width: 20, height: 24, fills: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
          { type: "TEXT", name: "Label", characters: "Menu item", fontSize: 11, lineHeight: 16, fills: ["#FFFFFF"], layoutSizingHorizontal: "FILL", textAutoResize: "HEIGHT" },
          { type: "TEXT", name: "Shortcut", characters: "⌘K", fontSize: 11, lineHeight: 16, fills: ["#FFFFFFB2"] },
          { type: "FRAME", name: "submenu", width: 16, height: 16, fills: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
        ],
      }],
    }, P);
    const frame = r.created[0].id;
    const [highlight, check, start, label, shortcut, sub] = (await kids(frame)).map((k) => k.id);
    const ci = await iconIn(check, "16.check", 0, 0);
    const si = await iconIn(start, "24.plus", 0, 0);
    await iconIn(sub, "16.chevron.right", 0, 0);
    await mcp.call("apply_style", { nodeIds: [label, shortcut], slot: "text", styleId: manifest.textStyles["body-medium"] });
    await mcp.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [frame] });
    const comb = await mcp.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [frame] });
    rec.set = comb.selection[0].id;
    rec.base = frame;
    rec.variants["State=Default"] = frame;
    await mcp.call("update_nodes", { updates: [{ nodeId: rec.set, name: "Menu item" }] });
    if (!/State=/.test(String(await mcp.call("get_metadata", { nodeId: rec.set, depth: 1 })))) await mcp.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: rec.set, name: "State", type: "VARIANT", defaultValue: "Default" } });
    const add = (name, type, defaultValue, extra = {}) => mcp.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: rec.set, name, type, defaultValue, ...extra } });
    const bindProp = (refs, field, prop) => mcp.call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs, field, prop } });
    await add("Check column", "BOOL", false);
    await add("Checked", "BOOL", false);
    await add("Start content", "BOOL", false);
    await add("Start icon", "INSTANCE_SWAP", manifest.icons["24.plus"].id, { preferredValues: Object.values(manifest.icons).map((i) => i.set) });
    await add("Label", "TEXT", "Menu item");
    await add("Shortcut", "BOOL", false);
    await add("Shortcut text", "TEXT", "⌘K");
    await add("Submenu", "BOOL", false);
    await bindProp([check], "VISIBLE", "Check column");
    await bindProp([ci], "VISIBLE", "Checked");
    await bindProp([start], "VISIBLE", "Start content");
    await bindProp([si], "OVERRIDDEN_SYMBOL_ID", "Start icon");
    await bindProp([label], "TEXT_DATA", "Label");
    await bindProp([shortcut], "VISIBLE", "Shortcut");
    await bindProp([shortcut], "TEXT_DATA", "Shortcut text");
    await bindProp([sub], "VISIBLE", "Submenu");
    rec.parts = { highlight, check, start, label, shortcut, sub };
    save();
  }
  for (const st of STATES) {
    if (rec.variants[`State=${st}`]) continue;
    const r = await mcp.call("duplicate_nodes", { nodeIds: [rec.base], parentId: rec.set }, P);
    const id = (r.copies ?? r.nodes)[0].nodeId ?? (r.copies ?? r.nodes)[0].id;
    await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: id, values: { State: st } } });
    rec.variants[`State=${st}`] = id;
    save();
  }
  // Colours (app/menu-*), the highlight, the grid
  for (const [i, st] of STATES.entries()) {
    const id = rec.variants[`State=${st}`];
    const parts = await deep(id);
    const part = (n) => parts.find((p) => p.name === n)?.id;
    const vectors = parts.filter((p) => p.type === "vector").map((p) => p.id);
    await mcp.call("update_nodes", { updates: [{ nodeId: id, width: 200, height: 24 }, { nodeId: part("highlight"), visible: st === "Highlighted", x: 8, y: 0, width: 184, height: 24 }, { nodeId: id, x: 20, y: 20 + i * 40 }] });
    await bind([part("highlight")], "fills[0]", varOf("menu-highlight"));
    await bind([part("Label")], "fills[0]", varOf(st === "Disabled" ? "menu-text-disabled" : "menu-text"));
    await bind([part("Shortcut")], "fills[0]", varOf(st === "Disabled" ? "menu-text-disabled" : st === "Highlighted" ? "menu-text-on-highlight-secondary" : "menu-text-secondary"));
    await bind(vectors, "fills[0]", varOf(st === "Disabled" ? "menu-text-disabled" : "menu-text"));
    await bind(vectors, "strokes[0]", varOf(st === "Disabled" ? "menu-text-disabled" : "menu-text"));
  }
  await mcp.call("update_nodes", { updates: [{ nodeId: rec.set, width: 240, height: 40 + STATES.length * 40, fills: ["#1E1E1E"] }] });
  await bind([rec.set], "fills[0]", varOf("menu-bg"));
  await guard(mcp, rec.set, { max: 4000, what: "Menu item" });
  save();
  console.log("Menu item: 3 variants");
}

if (which === "button") await buildButton();
else if (which === "menuitem") await buildMenuItem();
else throw new Error("node tools/ui-kit/atoms.mjs button|menuitem");
