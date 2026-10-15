// Design system v2, step 5b (owner, 2026-10-15): icons that resize by variables, and auto layout wherever it fits.
// - Every icon variant's vectors scale with it (constraints SCALE), so an instance bound to a size variable draws its
//   glyph at that size; the variant itself stays a plain frame (constraints need a non-auto-layout parent).
// - Every icon set is an auto-layout grid (wrap, 20 px gap and padding, centred); the Icons page frame is centred.
// - Sizes: an "Icon size" collection (modes 16 | 20 | 24 | 32, default 16) for standalone icons — a page's mode sizes
//   them — and, in the Size collection, the icon sizes components use inside themselves, which follow the density and
//   never the page's icon size (a button's icon stays the button's).
import { session, upsert } from "./lib.mjs";

const s = await session();
const kids = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<(\w+) id="([^"]+)" name="([^"]*)"(?: x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)")?/g)].map((m) => ({ type: m[1], id: m[2], name: m[3], w: Number(m[6]), h: Number(m[7]) })).filter((k) => k.id !== id);
const doc = await kids("0:0");
const page = doc.find((p) => p.name === "Icons");
const frame = (await kids(page.id)).find((k) => k.name === "Icons");
await s.call("update_nodes", { updates: [{ nodeId: frame.id, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" }] });

const sets = (await kids(frame.id)).filter((k) => k.name.startsWith("Icon / "));
let n = 0;
let vectorsScaled = 0;
for (const set of sets) {
  const box = set.name.includes(" 16.") ? 16 : 24;
  await s.call("update_nodes", { updates: [{ nodeId: set.id, layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 20, counterAxisSpacing: 20, padding: 20, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", width: box * 2 + 60, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG" }] });
  const tree = await kids(set.id, 4);
  const vectors = tree.filter((k) => k.type === "vector");
  if (vectors.length) await s.call("update_nodes", { updates: vectors.map((v) => ({ nodeId: v.id, constraints: { horizontal: "SCALE", vertical: "SCALE" } })) });
  vectorsScaled += vectors.length;
  if (++n % 25 === 0) console.log(`sets ${n}/${sets.length}`);
}

// Read back: every set a 2-column auto-layout grid of its box size; every vector scaling
let bad = 0;
for (const set of (await kids(frame.id)).filter((k) => k.name.startsWith("Icon / "))) {
  const box = set.name.includes(" 16.") ? 16 : 24;
  if (set.w !== box * 2 + 60 || set.h !== box * 2 + 60) {
    bad++;
    console.log(`${set.name}: ${set.w}×${set.h}`);
  }
}
const sample = sets.slice(0, 5);
for (const set of sample) {
  const ctx = await s.call("get_design_context", { nodeId: set.id });
  const walk = (x) => {
    if (x.type === "VECTOR" && !(x.constraints?.horizontal === "SCALE" && x.constraints?.vertical === "SCALE")) {
      bad++;
      console.log(`${set.name}: a vector not scaling ${JSON.stringify(x.constraints)}`);
    }
    for (const k of x.children ?? []) walk(k);
  };
  for (const x of ctx.nodes ?? []) walk(x);
}
console.log(`icon sets laid out: ${sets.length - bad}/${sets.length}; vectors set to scale: ${vectorsScaled}`);

// The sizes
const ICON_MODES = ["16", "20", "24", "32"];
const okIcon = await upsert(s, "Icon size", ICON_MODES, [{ name: "icon/size", type: "FLOAT", values: Object.fromEntries(ICON_MODES.map((m) => [m, `number/${m}`])), scopes: ["WIDTH_HEIGHT"] }], ["Primitives"]);
await s.call("edit_variable_collection", { collectionId: "Icon size", action: "set_default_mode", mode: "16" });
const D = ["Compact", "Default", "Comfortable"];
const inComponents = [
  // A control's icon (Button, Icon button, Field, Select …): the 24-grid icons carry their own padding, so a 24 px
  // control holds a 24 px icon whose glyph reads 16
  ["size/icon-control", [20, 24, 28]],
  ["size/icon-control-large", [28, 32, 36]],
  // A row's leading icon (menu items, list and layer rows, sidebar items): the 16-grid icons
  ["size/icon-row", [16, 16, 20]],
].map(([name, v]) => ({ name, type: "FLOAT", values: Object.fromEntries(D.map((m, i) => [m, `number/${v[i]}`])), scopes: ["WIDTH_HEIGHT"] }));
// Merge into Size without disturbing its other variables (upsert checks only what it's given; extras are reported)
const okSize = await upsert(s, "Size", D, inComponents, ["Primitives"]);
process.exit(bad === 0 && okIcon ? 0 : 1);
void okSize;
