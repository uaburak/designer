// Design system v2, step 5 (docs/design-system-v2.md §e): the icons. One component set per icon, "Icon / <name>",
// with two variant properties — Set (Figma | Wecra) and Style (Default | Outline) — four light vector drawings from
// tools/ui-kit/icons/{figma,wecra,figma-outline,wecra-outline}; every vector's paint bound to Color › icon/default.
// The sets live on the "Icons" page in one wrapping auto-layout frame. Idempotent: an icon whose set exists is
// skipped. Read back after each icon: the set's four variants, their size, and every vector's binding.
//
//   node tools/ds-v2/step5-icons.mjs [name …] [--limit N]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { session } from "./lib.mjs";

const ICONS = join(import.meta.dirname, "../ui-kit/icons");
const SETS = [
  ["Figma", "Default", "figma"],
  ["Wecra", "Default", "wecra"],
  ["Figma", "Outline", "figma-outline"],
  ["Wecra", "Outline", "wecra-outline"],
];
const s = await session();
const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
const names = readdirSync(join(ICONS, "wecra")).map((f) => f.replace(/\.svg$/, "")).filter((n) => !only.length || only.includes(n));

// Where things are
// The document's pages, read from the document node (never the user's selection)
const pagesXml = String(await s.call("get_metadata", { nodeId: "0:0", depth: 1 }));
const pages = [...pagesXml.matchAll(/<(?:page|canvas|page-ref) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ id: m[1], name: m[2] }));
let page = pages.find((p) => p.name === "Icons");
if (!page) {
  const first = pages.find((p) => p.name === "Page 1");
  if (!first) throw new Error("no Icons page and no Page 1 to rename");
  await s.call("update_nodes", { updates: [{ nodeId: first.id, name: "Icons" }] });
  page = { ...first, name: "Icons" };
}
const kids = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<(\w+) id="([^"]+)" name="([^"]*)"(?: x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)")?/g)].map((m) => ({ type: m[1], id: m[2], name: m[3], w: Number(m[6]), h: Number(m[7]) }));
let frame = (await kids(page.id)).find((k) => k.name === "Icons" && k.type === "frame");
if (!frame) {
  const made = await s.call("create_nodes", { parentId: page.id, nodes: [{ type: "FRAME", name: "Icons", x: 0, y: 0, width: 1600, layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 24, counterAxisSpacing: 24, padding: 40, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG", fills: ["#FFFFFF"] }] });
  frame = { id: (made.nodes ?? made.created)[0].nodeId ?? (made.nodes ?? made.created)[0].id };
}
const colors = (await s.defs()).find((c) => c.name === "Color");
const iconVar = colors.variables.find((v) => v.name === "icon/default").id;
const have = new Set((await kids(frame.id)).map((k) => k.name));

let done = 0;
for (const name of names) {
  if (done >= limit) break;
  if (have.has(`Icon / ${name}`)) continue;
  const box = name.startsWith("16") ? 16 : 24;
  // The four drawings, each its own frame of vectors, made into the set
  const nodes = SETS.map(([set, style, dir]) => ({ type: "FRAME", name: `Set=${set}, Style=${style}`, svg: readFileSync(join(ICONS, dir, `${name}.svg`), "utf8") }));
  const made = await s.call("create_nodes", { parentId: frame.id, nodes });
  const ids = (made.nodes ?? made.created).map((n) => n.nodeId ?? n.id);
  if (ids.length !== 4) throw new Error(`${name}: made ${ids.length} drawings: ${JSON.stringify(made).slice(0, 300)}`);
  const comps = [];
  for (const id of ids) {
    const r = await s.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [id] });
    comps.push(r.selection?.[0]?.id ?? r.created?.[0] ?? id);
  }
  const combined = await s.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: comps });
  const setId = combined.selection?.[0]?.id;
  if (!setId) throw new Error(`${name}: no set: ${JSON.stringify(combined).slice(0, 300)}`);
  for (const [i, [set, style]] of SETS.entries()) await s.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: comps[i], values: { Set: set, Style: style } } });
  // The set: a 2 × 2 grid of the drawings, 20 px around
  await s.call("update_nodes", {
    updates: [
      { nodeId: setId, name: `Icon / ${name}`, width: box * 2 + 60, height: box * 2 + 60, clipsContent: false },
      ...comps.map((c, i) => ({ nodeId: c, x: 20 + (i % 2) * (box + 20), y: 20 + Math.floor(i / 2) * (box + 20), width: box, height: box })),
    ],
  });
  // Paint: every vector's stroke or fill bound to icon/default (what the SVG painted it with)
  const strokes = [];
  const fills = [];
  for (const c of comps) {
    const ctx = await s.call("get_design_context", { nodeId: c });
    const walk = (n) => {
      if (n.type === "VECTOR") {
        if ((n.strokes ?? []).length && (n.strokeWeight ?? 1) > 0) strokes.push(n.id);
        if ((n.fills ?? []).length) fills.push(n.id);
      }
      for (const k of n.children ?? []) walk(k);
    };
    for (const n of ctx.nodes ?? []) walk(n);
  }
  if (strokes.length) await s.call("bind_variable", { nodeIds: strokes, field: "strokes[0]", variableId: iconVar });
  if (fills.length) await s.call("bind_variable", { nodeIds: fills, field: "fills[0]", variableId: iconVar });

  // Read back
  const set = (await kids(frame.id)).find((k) => k.id === setId);
  const variants = (await kids(setId)).filter((k) => k.type === "component").map((k) => k.name).sort();
  const want = SETS.map(([a, b]) => `Set=${a}, Style=${b}`).sort();
  let bound = 0;
  for (const c of comps) {
    const ctx = await s.call("get_design_context", { nodeId: c });
    const walk = (n) => {
      if (n.type === "VECTOR") for (const v of Object.values(n.boundVariables ?? {})) if (v.id === iconVar) bound++;
      for (const k of n.children ?? []) walk(k);
    };
    for (const n of ctx.nodes ?? []) walk(n);
  }
  const problems = [];
  if (!set || set.w !== box * 2 + 60 || set.h !== box * 2 + 60) problems.push(`size ${set?.w}×${set?.h}`);
  if (JSON.stringify(variants) !== JSON.stringify(want)) problems.push(`variants ${variants.join(" | ")}`);
  if (bound < strokes.length + fills.length) problems.push(`bound ${bound}/${strokes.length + fills.length}`);
  if (problems.length) throw new Error(`${name}: ${problems.join("; ")}`);
  done++;
  console.log(`✓ Icon / ${name}: 4 variants, ${bound} paints bound`);
}
const total = (await kids(frame.id)).filter((k) => k.name.startsWith("Icon / ")).length;
console.log(`icons on the page: ${total}/${readdirSync(join(ICONS, "wecra")).length}`);

// The two switches: an "Icon set" collection (Figma | Wecra) and an "Icon style" collection (Default | Outline), each a
// STRING variable whose value per mode is the variant value; icon instances inside the components bind their Set /
// Style properties to them (step 6 on), so a page's mode picks every icon's drawing.
for (const [colName, varName, modes] of [["Icon set", "icon/set", ["Figma", "Wecra"]], ["Icon style", "icon/style", ["Default", "Outline"]]]) {
  let col = (await s.defs()).find((c) => c.name === colName);
  if (!col) {
    await s.call("create_variable_collection", { name: colName, modes });
    col = (await s.defs()).find((c) => c.name === colName);
  }
  const values = Object.fromEntries(modes.map((m) => [m, m]));
  const had = (col.variables ?? []).find((v) => v.name === varName);
  if (had) await s.call("set_variable_value", { variableId: had.id, values });
  else await s.call("create_variable", { collectionId: col.id, name: varName, type: "STRING", values, scopes: [] });
  const back = (await s.defs()).find((c) => c.name === colName).variables.find((v) => v.name === varName);
  const ok = modes.every((m) => back?.values?.[m] === m);
  console.log(`${colName}: ${varName} ${ok ? "verified" : "MISMATCH " + JSON.stringify(back)}`);
  if (!ok) process.exitCode = 1;
}
