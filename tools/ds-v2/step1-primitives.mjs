// Design system v2, step 1 (docs/design-system-v2.md §a, §b, §f): the Primitives collection — the raw palette, each
// distinct colour once (73, plus the Yellow theme's 8), and the number scale every size variable aliases. One mode, hidden from publishing, no
// scopes (they are only aliased, never picked). Idempotent: an existing variable of the same name is updated, not
// duplicated. Every write is checked; at the end everything is read back and compared with this table.
import { connect } from "../ui-kit/mcp.mjs";

const COLORS = {
  white: "#FFFFFF",
  "gray/100": "#F5F5F5", "gray/200": "#E6E6E6", "gray/300": "#D9D9D9", "gray/400": "#CCCCCC", "gray/500": "#B3B3B3",
  "gray/600": "#8C8C8C", "gray/700": "#757575", "gray/750": "#5C5C5C", "gray/800": "#444444", "gray/850": "#383838",
  "gray/900": "#2C2C2C", "gray/950": "#1E1E1E",
  "black/a5": "#0000000D", "black/a10": "#0000001A", "black/a20": "#00000033", "black/a30": "#0000004D",
  "black/a40": "#00000066", "black/a50": "#00000080", "black/a90": "#000000E5",
  "white/a5": "#FFFFFF0D", "white/a10": "#FFFFFF1A", "white/a20": "#FFFFFF33", "white/a30": "#FFFFFF4D",
  "white/a40": "#FFFFFF66", "white/a70": "#FFFFFFB2", "white/a80": "#FFFFFFCC", "white/a90": "#FFFFFFE5",
  "blue/50": "#F2F9FF", "blue/100": "#E5F4FF", "blue/200": "#BDE3FF", "blue/300": "#7CC4F8", "blue/500": "#0D99FF",
  "blue/550": "#0C8CE9", "blue/600": "#007BE5", "blue/700": "#0A6DC2", "blue/800": "#105CAD",
  "blue/a10": "#0D99FF1A", "blue/a40": "#0D99FF66",
  "slate/700": "#4A5878", "slate/800": "#394360", "slate/900": "#32394D",
  "purple/100": "#F1E5FF", "purple/200": "#E4CCFF", "purple/300": "#D1A8FF", "purple/500": "#9747FF",
  "purple/600": "#8638E5", "purple/700": "#7A2ED6", "purple/800": "#652CA8", "purple/900": "#473956",
  "red/100": "#FFE2E0", "red/200": "#FFC7C2", "red/300": "#FCA397", "red/500": "#F24822", "red/600": "#DC3412",
  "red/700": "#C4381C", "red/800": "#963323", "red/900": "#7C2622",
  "green/100": "#CFF7D3", "green/300": "#79D297", "green/500": "#14AE5C", "green/600": "#009951", "green/900": "#0A4C2D",
  "yellow/100": "#FFF1C2", "yellow/200": "#FFE8A3", "yellow/300": "#F7D15F", "yellow/500": "#FFCD29",
  "yellow/700": "#C58011", "yellow/800": "#B86200", "yellow/900": "#925711",
  // The Yellow brand theme's steps the palette lacked (owner, 2026-10-15: a theme whose primary is yellow), and its
  // dark-mode selection tints (the Blue theme's are slate)
  "yellow/50": "#FFFAEB", "yellow/550": "#F5BF0F", "yellow/600": "#E5AC00", "yellow/a10": "#FFCD291A", "yellow/a40": "#FFCD2966",
  "olive/700": "#5E5338", "olive/800": "#4D4430", "olive/900": "#3D3626",
  "orange/500": "#FFA629", "teal/500": "#0FA8A8", "pink/500": "#FF24BD",
};
// Every number a Sizes variable needs (space, radius, stroke, control / icon / surface sizes); full = 9999
const NUMBERS = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 16, 20, 24, 28, 32, 36, 38, 40, 44, 48, 56, 64, 240, 320, 480, 640, 9999];

const mcp = await connect();
const call = async (name, args) => {
  const r = await mcp.rpc("tools/call", { name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("");
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const all = async () => call("get_variable_defs", { all: true });
let defs = await all();
const findCollection = (d, name) => (d.collections ?? d).find?.((c) => c.name === name);
let col = findCollection(defs, "Primitives");
if (!col) {
  await call("create_variable_collection", { name: "Primitives", modes: ["Value"] });
  defs = await all();
  col = findCollection(defs, "Primitives");
}
if (!col) throw new Error("no Primitives collection after creating it: " + JSON.stringify(defs).slice(0, 400));
const existing = new Map((col.variables ?? []).map((v) => [v.name, v]));

const want = [
  ...Object.entries(COLORS).map(([name, value]) => ({ name, type: "COLOR", value })),
  ...NUMBERS.map((n) => ({ name: `number/${n === 9999 ? "full" : n}`, type: "FLOAT", value: n })),
];
for (const v of want) {
  const had = existing.get(v.name);
  if (had) await call("set_variable_value", { variableId: had.id, values: { Value: v.value } });
  else await call("create_variable", { collectionId: col.id, name: v.name, type: v.type, value: v.value, scopes: [], hiddenFromPublishing: true });
}

// Read back and compare
defs = await all();
col = findCollection(defs, "Primitives");
const got = new Map((col.variables ?? []).map((v) => [v.name, v]));
const norm = (x) => (typeof x === "string" ? x.toUpperCase().replace(/^(#[0-9A-F]{6})FF$/, "$1") : x);
let ok = 0;
const bad = [];
for (const v of want) {
  const g = got.get(v.name);
  const value = g ? Object.values(g.values ?? {})[0] ?? g.value : undefined;
  if (g && norm(value) === norm(v.value)) ok++;
  else bad.push(`${v.name}: want ${v.value}, got ${JSON.stringify(value)}`);
}
const extra = [...got.keys()].filter((n) => !want.some((v) => v.name === n));
console.log(`Primitives: ${ok}/${want.length} verified (${Object.keys(COLORS).length} colours, ${NUMBERS.length} numbers); extra: ${extra.length}`);
if (bad.length) console.log("MISMATCH:\n" + bad.join("\n"));
if (extra.length) console.log("EXTRA:\n" + extra.join("\n"));
process.exit(bad.length || extra.length ? 1 : 0);
