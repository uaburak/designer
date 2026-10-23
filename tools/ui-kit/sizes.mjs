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

/** The binding field each tool field writes (what get_design_context's boundVariables and the Design panel read). */
const TARGET = { paddingTop: ["STACK_PADDING_TOP"], paddingRight: ["STACK_PADDING_RIGHT"], paddingBottom: ["STACK_PADDING_BOTTOM"], paddingLeft: ["STACK_PADDING_LEFT"], itemSpacing: ["STACK_SPACING"], counterAxisSpacing: ["STACK_COUNTER_SPACING"], cornerRadius: ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"], strokeWeight: ["STROKE_WEIGHT"], strokeTopWeight: ["BORDER_TOP_WEIGHT"], strokeRightWeight: ["BORDER_RIGHT_WEIGHT"], strokeBottomWeight: ["BORDER_BOTTOM_WEIGHT"], strokeLeftWeight: ["BORDER_LEFT_WEIGHT"], width: ["WIDTH"], height: ["HEIGHT"] };
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
        add("paddingTop", SPACE, t, n.id, b.STACK_PADDING_TOP);
        add("paddingRight", SPACE, r, n.id, b.STACK_PADDING_RIGHT);
        add("paddingBottom", SPACE, bt, n.id, b.STACK_PADDING_BOTTOM);
        add("paddingLeft", SPACE, l, n.id, b.STACK_PADDING_LEFT);
        add("itemSpacing", SPACE, n.itemSpacing ?? 0, n.id, b.STACK_SPACING);
        if (n.layoutWrap === "WRAP") add("counterAxisSpacing", SPACE, n.counterAxisSpacing ?? 0, n.id, b.STACK_COUNTER_SPACING);
      }
      if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) add("cornerRadius", RADIUS, n.cornerRadius, n.id, b.RECTANGLE_TOP_LEFT_CORNER_RADIUS);
      if (n.strokes?.length && n.type !== "TEXT") {
        if ("strokeTopWeight" in n) for (const side of ["Top", "Right", "Bottom", "Left"]) { if (n[`stroke${side}Weight`] > 0) add(`stroke${side}Weight`, BORDER, n[`stroke${side}Weight`], n.id, b[`BORDER_${side.toUpperCase()}_WEIGHT`]); }
        else add("strokeWeight", BORDER, n.strokeWeight ?? 1, n.id, b.STROKE_WEIGHT);
      }
      if (n.type !== "TEXT" && n.layoutSizingVertical === "FIXED") add("height", DIM, n.height, n.id, b.HEIGHT);
      if (n.type !== "TEXT" && n.layoutSizingHorizontal === "FIXED" && n.width === n.height) add("width", DIM, n.width, n.id, b.WIDTH);
    }
    if (n.type === "INSTANCE" && /^Icon \//.test(n.name)) return;
    for (const c of n.children ?? []) walk(c);
  };
  walk(JSON.parse(readFileSync(join(CTX, f), "utf8")));
}
let total = 0;
const failed = [];
let verified = 0;
for (const [k, ids] of binds) {
  const [field, variableId] = k.split("|");
  total += ids.length;
  console.log(`${field} → ${variableId}: ${ids.length}${dry ? " (dry)" : ""}`);
  if (dry) continue;
  // Every node's result is checked: its reported bindings must carry the field's targets with this variable
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    let r;
    try {
      r = await mcp.call("bind_variable", { nodeIds: batch, field, variableId });
    } catch (e) {
      // the whole batch refused: layer by layer, each refusal listed
      for (const id of batch) {
        try {
          const one = await mcp.call("bind_variable", { nodeIds: [id], field, variableId });
          verify(one, [id], field, variableId);
        } catch (e2) {
          failed.push(`${field} ${id}: ${String(e2.message).slice(0, 140)}`);
        }
      }
      continue;
    }
    verify(r, batch, field, variableId);
  }
}
function verify(r, batch, field, variableId) {
  for (const id of batch) {
    const node = (r.nodes ?? []).find((x) => x.nodeId === id);
    const ok = node && TARGET[field].every((t) => (node.bindings ?? []).some((bd) => bd.target === t && bd.variable === variableId));
    if (ok) verified++;
    else failed.push(`${field} ${id}: not in the result's bindings (${JSON.stringify(node?.bindings?.map((bd) => bd.target) ?? r.summary).slice(0, 120)})`);
  }
}
if (failed.length) console.log(`refused (${failed.length}):\n  ${failed.slice(0, 40).join("\n  ")}`);
console.log(`sizes: ${total} asked, ${verified} verified in the results; off the scale (left raw): ${[...off].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}×${v}`).join(", ")}`);
