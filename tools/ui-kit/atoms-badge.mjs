#!/usr/bin/env node
// Badge, in place (it had a variant per Gallery cell): Tone = Default · Brand · Component · Success · Warning · Danger
// × Kind = Label · Count, a Label text property bound on every variant, the grid read back. The set and its variants
// keep their ids (instances stay linked); the missing Count tones are copies of their Label variant.
//
//   node tools/ui-kit/atoms-badge.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { guard } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const mcp = await connect();
if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);
const P = { page: "Components" };
const set = manifest.sets.Badge.id;
const run = (engineCommand, a) => mcp.call("run_command", { engineCommand, args: a });
const variants = async () => [...String(await mcp.call("get_metadata", { nodeId: set, depth: 2 })).matchAll(/^ {2}<component id="([^"]+)" name="([^"]*)"[^>]*>\n {4}<text id="([^"]+)"/gm)].map((m) => ({ id: m[1], name: m[2], text: m[3] }));
const TONES = ["Default", "Brand", "Component", "Success", "Warning", "Danger"];

let vs = await variants();
if (vs.some((v) => /Variant=/.test(v.name))) {
  await run("ADD_COMPONENT_PROPERTY", { ref: set, name: "Kind", type: "VARIANT", defaultValue: "Label" });
  const count = vs.find((v) => /Variant=count/.test(v.name));
  await run("SET_VARIANT_PROPERTIES", { ref: count.id, values: { Kind: "Count" } });
  await run("EDIT_COMPONENT_PROPERTY", { ref: set, prop: "Variant", name: "Tone" });
  for (const [o, n] of [["default", "Default"], ["brand", "Brand"], ["component", "Component"], ["success", "Success"], ["warning", "Warning"], ["danger", "Danger"]]) await run("EDIT_COMPONENT_PROPERTY", { ref: set, prop: "Tone", oldValue: o, newValue: n });
  await run("SET_VARIANT_PROPERTIES", { ref: count.id, values: { Tone: "Brand" } });
  await run("DELETE_COMPONENT_PROPERTY", { ref: set, prop: "Size" });
  await run("DELETE_COMPONENT_PROPERTY", { ref: set, prop: "State" });
  await run("ADD_COMPONENT_PROPERTY", { ref: set, name: "Label", type: "TEXT", defaultValue: "Badge" });
  vs = await variants();
}
// The Count tones that are missing: copies of the Label variant, the count's small numerals
const has = (tone, kind) => vs.find((v) => v.name === `Tone=${tone}, Kind=${kind}`);
for (const tone of TONES) {
  if (has(tone, "Count")) continue;
  const src = has(tone, "Label");
  const r = await mcp.call("duplicate_nodes", { nodeIds: [src.id], parentId: set }, P);
  const id = (r.copies ?? r.nodes)[0].nodeId ?? (r.copies ?? r.nodes)[0].id;
  await run("SET_VARIANT_PROPERTIES", { ref: id, values: { Tone: tone, Kind: "Count" } });
  vs = await variants();
  const v = vs.find((x) => x.id === id);
  await mcp.call("update_nodes", { updates: [{ nodeId: v.text, characters: "12" }] });
  await mcp.call("apply_style", { nodeIds: [v.text], slot: "text", styleId: manifest.textStyles["body-small"] });
}
vs = await variants();
await run("BIND_COMPONENT_PROPERTY", { refs: vs.map((v) => v.text), field: "TEXT_DATA", prop: "Label" });
// The grid: a row per Kind, a column per Tone
const updates = vs.map((v) => {
  const [, tone, kind] = /Tone=([^,]+), Kind=(\w+)/.exec(v.name);
  return { nodeId: v.id, x: 20 + TONES.indexOf(tone) * 88, y: 20 + (kind === "Count" ? 1 : 0) * 36 };
});
await mcp.call("update_nodes", { updates: [...updates, { nodeId: set, width: 40 + TONES.length * 88, height: 40 + 2 * 36 }] });
await guard(mcp, set, { max: 4000, what: "Badge" });
manifest.atoms.Badge = { set, variants: Object.fromEntries(vs.map((v) => [v.name, v.id])) };
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(`Badge: ${vs.length} variants`, vs.map((v) => v.name).join(" | "));
