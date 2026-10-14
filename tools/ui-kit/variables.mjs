#!/usr/bin/env node
// The file's variables in tiers (the file leads; tools/ui-kit/token-map.json tells the code how its tokens map):
//   Primitives — the raw values, each once: every distinct colour (gray/…, blue/…, black/a90, white/a40 …) and the
//                number scale (scale/0 … scale/64, border/1, border/2). One mode, hidden from publishing.
//   Semantic   — the former "Wecra colors" (Light / Dark): bg/, text/, icon/, border/ … every value an ALIAS of a
//                primitive; the app's component-level tokens (app/…) alias the semantic token with the same pair
//                when there is one (tabbar-text → text/text-secondary), else primitives.
//   Semantic sizes — the former "Wecra sizes": radius/, space/ alias the scale; size/ (component dimensions) alias
//                the scale where the value is on it.
// In place: the variables bound across the file keep their ids (only their values become aliases), so nothing is
// rebound. Re-running only fills what is missing.
//
//   node tools/ui-kit/variables.mjs [--dry]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { TOKENS, variableName } from "./convert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes("--dry");
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const mcp = await connect();
if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);

const defs = await mcp.call("get_variable_defs", { all: true });
const cols = defs.collections ?? [];
const colors = cols.find((c) => c.id === manifest.variables.collection);
const sizes = cols.find((c) => c.id === manifest.variables.sizes.collection);
if (!colors || !sizes) throw new Error("the colour / size collections aren't where manifest.json says");

// ---- the primitives' names ----------------------------------------------------------------------------------------------
const hex8 = (v) => {
  const s = String(v).toLowerCase();
  if (/^#[0-9a-f]{8}$/.test(s)) return s;
  if (/^#[0-9a-f]{6}$/.test(s)) return `${s}ff`;
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(",").map((x) => Number(x.trim()));
    return `#${[r, g, b, Math.round(a * 255)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error(`not a colour: ${v}`);
};
function colourName(h) {
  const [r, g, b, a] = [1, 3, 5, 7].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), L = (max + min) / 2;
  const S = max === min ? 0 : (max - min) / (1 - Math.abs(2 * L - 1));
  let H = 0;
  if (max !== min) H = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  H = (H * 60 + 360) % 360;
  const alpha = a < 0.999 ? `a${Math.round(a * 100)}` : "";
  if (S < 0.08 || max === min) {
    if (L > 0.995) return alpha ? `white/${alpha}` : "white/100";
    if (L < 0.005) return alpha ? `black/${alpha}` : "black/100";
    return `gray/${Math.max(50, Math.min(950, Math.round(((1 - L) * 1000) / 25) * 25))}${alpha ? `-${alpha}` : ""}`;
  }
  const fam = H < 12 || H >= 345 ? "red" : H < 40 ? "orange" : H < 62 ? "yellow" : H < 165 ? "green" : H < 190 ? "teal" : H < 250 ? "blue" : H < 290 ? "violet" : "pink";
  return `${fam}/${Math.max(50, Math.min(950, Math.round(((1 - L) * 1000) / 25) * 25))}${alpha ? `-${alpha}` : ""}`;
}

// Every distinct colour the semantic collection uses (its values as they are in the file, the owner's edits included)
const valueOf = (v, mode) => v.values?.[mode]?.alias ? null : v.values?.[mode];
const distinct = new Set();
for (const v of colors.variables) for (const m of ["Light", "Dark"]) {
  const x = valueOf(v, m);
  if (x != null) distinct.add(hex8(x));
}
const prim = new Map();
const used = new Map();
for (const h of [...distinct].sort()) {
  let n = colourName(h);
  if (used.has(n)) {
    let k = 2;
    while (used.has(`${n}-${k}`)) k++;
    n = `${n}-${k}`;
  }
  used.set(n, h);
  prim.set(h, n);
}
// The number scale: every radius / space value, the border widths
const numbers = new Set([1, 2]);
for (const v of sizes.variables) if (/^(radius|space)\//.test(v.name)) numbers.add(Number(Object.values(v.values)[0]));
console.log(`primitives: ${prim.size} colours, ${numbers.size} numbers (${[...numbers].sort((a, b) => a - b).join(", ")})`);

// ---- Primitives collection --------------------------------------------------------------------------------------------
let pcol = cols.find((c) => c.name === "Primitives");
const existing = new Map((pcol?.variables ?? []).map((v) => [v.name, v.id]));
if (!pcol && !dry) {
  const r = await mcp.call("create_variable_collection", { name: "Primitives", modes: ["Value"] });
  pcol = { id: r.collectionId ?? r.collection?.id ?? r.id };
}
const primId = new Map(); // name → id
const make = async (name, type, value, description) => {
  if (existing.has(name)) return primId.set(name, existing.get(name));
  if (dry) return primId.set(name, `(new ${name})`);
  const r = await mcp.call("create_variable", { collectionId: pcol.id, name, type, value, hiddenFromPublishing: true, ...(description ? { description } : {}), scopes: type === "COLOR" ? ["ALL_SCOPES"] : ["ALL_SCOPES"] });
  primId.set(name, r.variable?.id ?? r.variableId ?? r.id);
};
for (const [h, n] of prim) await make(`color/${n}`, "COLOR", h.toUpperCase());
const scaleName = (x) => (x >= 9999 ? "scale/full" : `scale/${String(x).replace(".", "-")}`);
for (const x of [...numbers].sort((a, b) => a - b)) await make(scaleName(x), "FLOAT", x);
await make("border/1", "FLOAT", 1, "a hairline: borders, dividers, focus rings");
await make("border/2", "FLOAT", 2, "a strong border: the selected outline");

// ---- Semantic colours: aliases ------------------------------------------------------------------------------------------
const byName = new Map(colors.variables.map((v) => [v.name, v]));
const pairOf = (v) => `${hex8(valueOf(v, "Light") ?? "#00000000")}|${hex8(valueOf(v, "Dark") ?? "#00000000")}`;
const semanticByPair = new Map();
for (const v of colors.variables) if (!v.name.startsWith("app/") && valueOf(v, "Light") != null) if (!semanticByPair.has(pairOf(v))) semanticByPair.set(pairOf(v), v);
const map = { colors: {}, sizes: {} };
let aliased = 0;
for (const t of TOKENS) {
  const v = byName.get(variableName(t));
  if (!v) continue;
  const light = valueOf(v, "Light"), dark = valueOf(v, "Dark");
  const entry = { variable: `Semantic/${v.name}` };
  if (light == null || dark == null) {
    map.colors[t.css] = { ...entry, note: "already an alias" };
    continue;
  }
  const same = v.name.startsWith("app/") ? semanticByPair.get(pairOf(v)) : null;
  const target = same
    ? { Light: { alias: same.id }, Dark: { alias: same.id } }
    : { Light: { alias: primId.get(`color/${prim.get(hex8(light))}`) }, Dark: { alias: primId.get(`color/${prim.get(hex8(dark))}`) } };
  map.colors[t.css] = { ...entry, ...(same ? { aliasOf: `Semantic/${same.name}` } : {}), light: `Primitives/color/${prim.get(hex8(light))}`, dark: `Primitives/color/${prim.get(hex8(dark))}` };
  if (!dry) await mcp.call("set_variable_value", { variableId: v.id, values: target });
  aliased++;
}
console.log(`semantic colours: ${aliased} now aliases${dry ? " (dry)" : ""}`);

// ---- Semantic sizes: aliases of the scale ---------------------------------------------------------------------------------
let sized = 0;
for (const v of sizes.variables) {
  const raw = Object.values(v.values)[0];
  if (typeof raw !== "number") continue;
  const css = `--ds-${v.name.replace("/", "-")}`;
  if (!numbers.has(raw) || (!/^(radius|space)\//.test(v.name) && raw > 64)) {
    map.sizes[css] = { variable: `Semantic sizes/${v.name}`, value: raw };
    continue;
  }
  const alias = primId.get(scaleName(raw));
  map.sizes[css] = { variable: `Semantic sizes/${v.name}`, primitive: `Primitives/${scaleName(raw)}` };
  if (!dry) await mcp.call("set_variable_value", { variableId: v.id, values: { Value: { alias } } });
  sized++;
}
console.log(`semantic sizes: ${sized} now aliases of the scale${dry ? " (dry)" : ""}`);

if (!dry) {
  if (colors.name !== "Semantic") await mcp.call("edit_variable_collection", { collectionId: colors.id, action: "rename", name: "Semantic" });
  if (sizes.name !== "Semantic sizes") await mcp.call("edit_variable_collection", { collectionId: sizes.id, action: "rename", name: "Semantic sizes" });
  manifest.variables.primitives = { collection: pcol.id, ids: Object.fromEntries(primId) };
  writeFileSync(join(HERE, "manifest.json"), JSON.stringify(manifest, null, 1));
}
writeFileSync(join(HERE, "token-map.json"), JSON.stringify({ about: "The code's CSS tokens → the Wecra UI file's variables (Primitives → Semantic → app/ component tokens). The file leads.", primitives: Object.fromEntries([...prim].map(([h, n]) => [`color/${n}`, h])), ...map }, null, 1));
console.log("→ tools/ui-kit/token-map.json");
