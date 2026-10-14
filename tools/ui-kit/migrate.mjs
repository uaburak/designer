#!/usr/bin/env node
// Moves the uses of the old one-off button components onto the Button atom (atoms.mjs), in place:
//   · every instance of Button / IconButton / ToggleIconButton — in the screens and inside other components — is
//     swapped to the Button variant that stands for it (Variant, Size, State, Icon only), then given its content as
//     component properties: Label, Start content + Start icon, End content + End icon, as it showed before;
//   · each occurrence inside a component's instance on a screen (an "I…" layer) gets the same properties, so a
//     screen's own labels survive the swap in the main;
//   · a full-width button keeps its width.
// Reads out/polish/ctx (dump.mjs — run it first). Checks with shots.mjs / diff.mjs after.
//
//   node tools/ui-kit/migrate.mjs buttons [--dry]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { guard } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = join(HERE, "out", "polish", "ctx");
const MANIFEST = join(HERE, "manifest.json");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const cmd = args[0];
const atom = manifest.atoms?.Button;
if (cmd === "buttons" && !atom?.set) throw new Error("build the Button atom first: node tools/ui-kit/atoms.mjs button");
const mcp = dry ? null : await connect();
if (mcp && (await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);

if (cmd === "menus") {
  await menus();
  process.exit(0);
}
const OLD = new Set(["Button", "IconButton", "ToggleIconButton"]);
const iconByName = (name) => manifest.icons[name.replace(/^Icon \/ /, "")];
const variantId = (c) => atom.variants[`Variant=${c.Variant}, Size=${c.Size}, State=${c.State}, Icon only=${c["Icon only"]}`];

/** The Button combination an old variant stands for (null: leave it — a split / group button stays as it is). */
function target(set, variant) {
  const v = /Variant=([^,]+)/.exec(variant)?.[1] ?? "";
  const size = /Size=large|\blarge\b/.test(variant) ? "Large" : "Default";
  const disabled = /State=disabled/.test(variant);
  if (set === "Button") {
    const kind = v.split(" ")[0];
    const map = { primary: "Primary", secondary: "Secondary", destructive: "Destructive", "destructive-secondary": "Destructive secondary", ghost: "Ghost", link: "Link", tinted: "Tinted" };
    if (!map[kind]) return null;
    return { Variant: map[kind], Size: kind === "tinted" ? "Large" : size, State: disabled ? "Disabled" : "Default", "Icon only": "False" };
  }
  if (set === "IconButton") {
    if (/groupButton|splitMain/.test(v)) return null;
    return { Variant: /secondary|toneSecondary/.test(v) ? "Ghost secondary" : "Ghost", Size: size, State: disabled ? "Disabled" : "Default", "Icon only": "True" };
  }
  if (set === "ToggleIconButton") {
    const on = /^on|^mixed/.test(v);
    return { Variant: /toneSecondary/.test(v) ? "Ghost secondary" : "Ghost", Size: size, State: disabled ? "Disabled" : on ? "Selected" : "Default", "Icon only": "True" };
  }
  return null;
}
/** What an old button shows: its label, the icon before it, the icon after it. */
function content(n) {
  const flat = [];
  const walk = (m) => {
    if (m.visible === false) return;
    if (m !== n && m.type === "INSTANCE" && /^Icon \//.test(m.name)) return flat.push({ icon: m.name });
    if (m.type === "TEXT" && m.characters?.trim()) return flat.push({ text: m.characters });
    (m.children ?? []).forEach(walk);
  };
  walk(n);
  const ti = flat.findIndex((x) => x.text);
  return {
    // (a label split into runs — "Export" "Desktop" — is one label)
    label: ti >= 0 ? flat.filter((x) => x.text).map((x) => x.text.trim()).join(" ") : null,
    start: flat.find((x, i) => x.icon && (ti < 0 || i < ti))?.icon ?? null,
    end: ti >= 0 ? (flat.find((x, i) => x.icon && i > ti)?.icon ?? null) : null,
  };
}
const propsFor = (c, k) => {
  const p = {};
  if (k.label != null) p.Label = k.label;
  p["Start content"] = Boolean(k.start);
  if (k.start && iconByName(k.start)) p["Start icon"] = iconByName(k.start).id;
  p["End content"] = Boolean(k.end);
  if (k.end && iconByName(k.end)) p["End icon"] = iconByName(k.end).id;
  if (c["Icon only"] === "True") delete p.Label;
  return p;
};

const trees = readdirSync(CTX).map((f) => ({ f, root: JSON.parse(readFileSync(join(CTX, f), "utf8")), page: f.startsWith("screen.") ? manifest.screens[f.slice(7, -5)].page : "Components" }));
const own = []; // swaps
const occ = []; // occurrences inside instances (screens): properties only
const atomIds = new Set(Object.values(atom.variants));
const inAtom = (path) => path.some((p) => atomIds.has(p));
for (const t of trees) {
  const walk = (n, path) => {
    if (n.type === "INSTANCE" && OLD.has(n.name) && n.component && !inAtom(path)) {
      const c = target(n.name, n.component);
      if (c) {
        const k = content(n);
        const rec = { id: n.id, set: n.name, from: n.component, to: c, props: propsFor(c, k), width: n.width, full: /\bfull\b/.test(n.component), page: t.page, file: t.f };
        (n.id.startsWith("I") ? occ : own).push(rec);
      }
    }
    for (const ch of n.children ?? []) walk(ch, [...path, n.id]);
  };
  walk(t.root, []);
}
// The old sets' own variants hold no buttons; a main's own instances first (its occurrences follow), then the screens'
const byKey = new Map();
for (const r of own) byKey.set(r.id, r);
const swaps = [...byKey.values()];
console.log(`buttons: ${swaps.length} instances to swap (${swaps.filter((r) => r.page === "Components").length} inside components), ${occ.length} occurrences to set`);
const tally = {};
for (const r of swaps) tally[`${r.set} ${r.from} → ${r.to.Variant}/${r.to.Size}/${r.to.State}/${r.to["Icon only"]}`] = (tally[`${r.set} ${r.from} → ${r.to.Variant}/${r.to.Size}/${r.to.State}/${r.to["Icon only"]}`] ?? 0) + 1;
if (dry) {
  for (const [k, v] of Object.entries(tally)) console.log(`  ${v} × ${k}`);
  console.log(JSON.stringify(swaps.slice(0, 3), null, 1));
  process.exit(0);
}

const done = (manifest.migrated ??= {});
let n = 0;
for (const r of swaps) {
  if (done[r.id]) continue;
  const main = variantId(r.to);
  if (!main) throw new Error(`no Button variant for ${JSON.stringify(r.to)}`);
  await mcp.call("run_command", { engineCommand: "SWAP_INSTANCE", args: { main, ref: r.id } });
  const u = { nodeId: r.id, componentProperties: r.props };
  if (r.full) Object.assign(u, { layoutSizingHorizontal: "FIXED", width: r.width });
  const res = await mcp.call("update_nodes", { updates: [u] }, { soft: true });
  if (typeof res === "object" && res.summary && !/everything applied/.test(res.summary)) console.warn(`  ${r.id}: ${res.summary.slice(0, 200)}`);
  done[r.id] = main;
  if (++n % 20 === 0) {
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
    console.log(`swapped ${n}/${swaps.length}`);
  }
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
// Occurrences inside instances: the properties as they showed
const updates = occ.map((r) => ({ nodeId: r.id, componentProperties: r.props, ...(r.full ? { layoutSizingHorizontal: "FIXED", width: r.width } : {}) }));
for (let i = 0; i < updates.length; i += 30) {
  const res = await mcp.call("update_nodes", { updates: updates.slice(i, i + 30) }, { soft: true });
  if (typeof res === "object" && res.summary && !/everything applied/.test(res.summary)) console.warn(`  ${res.summary.slice(0, 300)}`);
}
for (const s of Object.values(manifest.screens)) await guard(mcp, s.id, { exact: { width: 1440, height: 900 }, top: true });
console.log(`buttons: ${n} swapped, ${updates.length} occurrences set; screens read back 1440 × 900`);

/**
 * The menus' rows (plain frames "item" in the screens' menus and in the Menu / Select mains) become instances of
 * Menu item: each in its row's place (same parent, index, x, y, width), its content as properties — Label,
 * Shortcut, Check column / Checked, Start content / Start icon, Submenu — and its State (Highlighted, Disabled).
 */
async function menus() {
  const mi = manifest.atoms?.MenuItem;
  if (!mi?.set) throw new Error("build the Menu item first: node tools/ui-kit/atoms.mjs menuitem");
  const rows = [];
  const isMenu = (p) => p && /menu/i.test(`${p.name} ${(p.fills ?? []).map((x) => x.color).join()}`);
  for (const t of readdirSync(CTX).map((f) => ({ f, root: JSON.parse(readFileSync(join(CTX, f), "utf8")) }))) {
    if (t.f === "set.Menu item.json") continue;
    const page = t.f.startsWith("screen.") ? manifest.screens[t.f.slice(7, -5)].page : "Components";
    const walk = (n, p) => {
      if (n.name === "item" && n.type === "FRAME" && !n.id.startsWith("I") && isMenu(p)) {
        const kids = n.children ?? [];
        const texts = kids.filter((c) => c.type === "TEXT");
        const shortFrame = kids.find((c) => c.name === "shortcut");
        const shortText = shortFrame ? (shortFrame.children ?? []).filter((c) => c.type === "TEXT").map((c) => c.characters).join("") : texts[1]?.characters;
        const label = texts[0];
        if (!label) return;
        const iconFrame = kids.find((c) => c.name === "icon");
        const icon = iconFrame?.children?.find((c) => /^Icon \//.test(c.name))?.name;
        const check = kids.find((c) => c.name === "check");
        const chevron = kids.some((c, i) => c.type === "INSTANCE" && /chevron/.test(c.name) && i > kids.indexOf(label));
        const fill = (label.fills ?? [])[0]?.color ?? "";
        const before = kids.find((c) => c.name === "before");
        const lx = label.x;
        const props = {
          Label: label.characters,
          "Check column": Boolean(check) || (!iconFrame && lx >= 30 && lx <= 34) || (Boolean(iconFrame) && lx >= 58),
          Checked: Boolean(check?.children?.length),
          "Start content": Boolean(iconFrame),
          Shortcut: Boolean(shortText),
          Submenu: chevron,
          State: /66$/.test(fill) ? "Disabled" : before && (before.fills ?? []).length ? "Highlighted" : "Default",
        };
        if (shortText) props["Shortcut text"] = shortText;
        if (icon && manifest.icons[icon.replace(/^Icon \/ /, "")]) props["Start icon"] = manifest.icons[icon.replace(/^Icon \/ /, "")].id;
        rows.push({ id: n.id, parent: p.id, index: (p.children ?? []).indexOf(n), x: n.x, y: n.y, width: n.width, auto: Boolean(p.layoutMode), props, page });
      }
      for (const c of n.children ?? []) walk(c, n);
    };
    walk(t.root, null);
  }
  console.log(`menus: ${rows.length} rows to become Menu item instances${dry ? " (dry)" : ""}`);
  if (dry) return console.log(JSON.stringify(rows.slice(0, 4), null, 1));
  // One instance of the Menu item in the hidden seeds frame, copied into place for every row
  if (!mi.seed) {
    const r = await mcp.call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: mi.variants["State=Default"], parent: manifest.seeds } });
    mi.seed = r.selection?.[0]?.id ?? r.created?.[0]?.id;
    if (!mi.seed) throw new Error(`no seed: ${JSON.stringify(r).slice(0, 200)}`);
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  }
  const done = (manifest.menuRows ??= {});
  let n = 0;
  // Last index first within a parent, so the earlier rows' indices hold
  rows.sort((a, b) => (a.parent === b.parent ? b.index - a.index : a.parent < b.parent ? -1 : 1));
  for (const r of rows) {
    if (done[r.id]) continue;
    const c = await mcp.call("duplicate_nodes", { nodeIds: [mi.seed], parentId: r.parent, index: r.index }, { page: r.page });
    const id = (c.copies ?? c.nodes)[0].nodeId ?? (c.copies ?? c.nodes)[0].id;
    const res = await mcp.call("update_nodes", { updates: [{ nodeId: id, name: "Menu item", visible: true, componentProperties: r.props, layoutSizingHorizontal: "FIXED", width: r.width, ...(r.auto ? {} : { x: r.x, y: r.y }) }] }, { soft: true });
    if (typeof res === "object" && res.summary && !/everything applied/.test(res.summary)) console.warn(`  ${r.id}: ${res.summary.slice(0, 200)}`);
    await mcp.call("delete_nodes", { nodeIds: [r.id] });
    done[r.id] = id;
    if (++n % 20 === 0) {
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
      console.log(`menu rows ${n}/${rows.length}`);
    }
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  for (const s of Object.values(manifest.screens)) await guard(mcp, s.id, { exact: { width: 1440, height: 900 }, top: true });
  console.log(`menus: ${n} rows are Menu item instances; screens read back 1440 × 900`);
}
