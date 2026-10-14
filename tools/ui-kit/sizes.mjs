#!/usr/bin/env node
// Every size on the main components bound to a Semantic size variable (no raw numbers): padding and gaps to space/,
// corner radii to radius/, stroke weights to border/ (Semantic sizes border/hairline, border/strong — aliases of
// the Primitives' border/1, border/2, made here when missing), fixed heights and widths of 16 / 24 / 32 to
// size/icon-16, size/control, size/control-large. A value off the scale stays as it is and is listed.
// Reads out/polish/ctx (dump.mjs --components); binds by id, in batches; screens follow through their instances.
//
//   node tools/ui-kit/sizes.mjs [--dry]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = join(HERE, "out", "polish", "ctx");
const MANIFEST = join(HERE, "manifest.json");
const dry = process.argv.includes("--dry");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const S = manifest.variables.sizes;
const mcp = await connect();
if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);

// The scales: value → variable (the plainest name when two share a value)
const scale = (group, values) => {
  const m = new Map();
  for (const [k, v] of Object.entries(values)) if (!m.has(v)) m.set(v, S[group][k]);
  return m;
};
const { space, radius } = await import("../../src/renderer/src/ds/tokens.ts");
const SPACE = scale("space", space);
const RADIUS = scale("radius", radius);
// border/ in Semantic sizes, aliasing the primitives
if (!S.border) {
  S.border = {};
  for (const [name, prim] of [["hairline", "border/1"], ["strong", "border/2"]]) {
    if (dry) continue;
    const r = await mcp.call("create_variable", { collectionId: S.collection, name: `border/${name}`, type: "FLOAT", value: { alias: manifest.variables.primitives.ids[prim] }, description: name === "hairline" ? "borders, dividers, focus rings" : "a selected outline" });
    S.border[name] = r.variable?.id ?? r.variableId ?? r.id;
  }
  if (!dry) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
}
// 1 px spaces and radii (a hairline gap, an inset): space/px and radius/hairline, aliases of the scale's 1
for (const [group, name] of [["space", "px"], ["radius", "hairline"]]) {
  if (S[group][name] || dry) continue;
  const r = await mcp.call("create_variable", { collectionId: S.collection, name: `${group}/${name}`, type: "FLOAT", value: { alias: manifest.variables.primitives.ids["scale/1"] } });
  S[group][name] = r.variable?.id ?? r.variableId ?? r.id;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
}
if (S.space.px) SPACE.set(1, S.space.px);
if (S.radius.hairline) RADIUS.set(1, S.radius.hairline);
const BORDER = new Map([[1, S.border.hairline], [2, S.border.strong]]);
const DIM = new Map([[16, S.size["icon-16"]], [24, S.size.control], [32, S.size["control-large"]]]);

const binds = new Map(); // field|variable → ids
const off = new Map(); // what stays raw: field value → count
const add = (field, map, value, id, bound) => {
  if (value == null || bound) return;
  const v = map.get(value);
  if (!v) return off.set(`${field} ${value}`, (off.get(`${field} ${value}`) ?? 0) + 1);
  const k = `${field}|${v}`;
  binds.set(k, [...(binds.get(k) ?? []), id]);
};
for (const f of readdirSync(CTX).filter((f) => f.startsWith("set."))) {
  const walk = (n) => {
    if (!n.id.startsWith("I") && n.type !== "VECTOR" && !/^Icon \//.test(n.name)) {
      const b = n.boundVariables ?? {};
      if (n.layoutMode) {
        const [t, r, bt, l] = n.padding ?? [0, 0, 0, 0];
        add("paddingTop", SPACE, t, n.id, b.STACK_VERTICAL_PADDING);
        add("paddingRight", SPACE, r, n.id, b.STACK_PADDING_RIGHT);
        add("paddingBottom", SPACE, bt, n.id, b.STACK_PADDING_BOTTOM);
        add("paddingLeft", SPACE, l, n.id, b.STACK_HORIZONTAL_PADDING);
        add("itemSpacing", SPACE, n.itemSpacing ?? 0, n.id, b.STACK_SPACING);
      }
      if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) add("cornerRadius", RADIUS, n.cornerRadius, n.id, b.RECTANGLE_TOP_LEFT_CORNER_RADIUS);
      if (n.strokes?.length && n.type !== "TEXT") add("strokeWeight", BORDER, n.strokeWeight ?? 1, n.id, b.STROKE_WEIGHT);
      if (n.type !== "TEXT" && n.layoutSizingVertical === "FIXED") add("height", DIM, n.height, n.id, b.HEIGHT);
      if (n.type !== "TEXT" && n.layoutSizingHorizontal === "FIXED" && n.width === n.height) add("width", DIM, n.width, n.id, b.WIDTH);
    }
    if (n.type === "INSTANCE" && /^Icon \//.test(n.name)) return;
    for (const c of n.children ?? []) walk(c);
  };
  walk(JSON.parse(readFileSync(join(CTX, f), "utf8")));
}
let total = 0;
for (const [k, ids] of binds) {
  const [field, variableId] = k.split("|");
  total += ids.length;
  console.log(`${field} → ${variableId}: ${ids.length}${dry ? " (dry)" : ""}`);
  if (!dry) for (let i = 0; i < ids.length; i += 40) await mcp.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field, variableId }, { soft: true });
}
console.log(`sizes: ${total} bound; off the scale (left raw): ${[...off].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}×${v}`).join(", ")}`);
