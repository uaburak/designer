// Design system v2, step 5d (owner, 2026-10-15: "when I swap the button's icon, its colour doesn't follow"): every icon
// variant becomes ONE filled vector named "Icon" — strokes outlined, the shapes flattened — its fill bound to
// icon/default, scaling with the variant. A component that colours its icon overrides "Icon"'s fill; a swapped icon has
// an "Icon" too, so the override carries (instance overrides are matched by layer name), as in Figma's icon libraries.
// Read back per variant: exactly one vector, named Icon, a fill bound to icon/default, no stroke.
//
//   node tools/ds-v2/step5d-icon-flatten.mjs [icon-name …]
import { session } from "./lib.mjs";

const s = await session();
const kids = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<([\w-]+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] })).filter((k) => k.id !== id);
const page = (await kids("0:0")).find((p) => p.name === "Icons");
const frame = (await kids(page.id)).find((k) => k.name === "Icons");
const only = process.argv.slice(2);
const sets = (await kids(frame.id)).filter((k) => k.name.startsWith("Icon / ") && (!only.length || only.includes(k.name.slice(7))));
const iconVar = (await s.defs()).find((c) => c.name === "Color").variables.find((v) => v.name === "icon/default").id;

const vectorsOf = async (id) => (await kids(id, 5)).filter((k) => k.type === "vector");
let done = 0;
const bad = [];
for (const set of sets) {
  for (const variant of (await kids(set.id)).filter((k) => k.type === "component")) {
    let vectors = await vectorsOf(variant.id);
    const already = vectors.length === 1 && vectors[0].name === "Icon";
    if (!already) {
      // Strokes → shapes (a vector with a stroke paint and weight)
      for (const v of vectors) {
        const n = (await s.call("get_design_context", { nodeId: v.id })).nodes[0];
        if ((n.strokes ?? []).length && (n.strokeWeight ?? 0) > 0) await s.call("run_command", { command: "vector.outline-stroke", nodeIds: [v.id] });
      }
      vectors = await vectorsOf(variant.id);
      if (vectors.length > 1) await s.call("run_command", { engineCommand: "FLATTEN", nodeIds: vectors.map((v) => v.id) });
      vectors = await vectorsOf(variant.id);
      // Any group / frame the SVG left around it goes: the vector straight in the variant
      const inner = (await kids(variant.id)).filter((k) => k.type !== "vector");
      if (vectors.length === 1 && inner.length) {
        await s.call("reparent_nodes", { nodeIds: [vectors[0].id], parentId: variant.id, index: 0 });
        await s.call("delete_nodes", { nodeIds: inner.map((k) => k.id) });
      }
      vectors = await vectorsOf(variant.id);
      if (vectors.length === 1) {
        await s.call("update_nodes", { updates: [{ nodeId: vectors[0].id, name: "Icon", strokes: [], constraints: { horizontal: "SCALE", vertical: "SCALE" } }] });
        await s.call("bind_variable", { nodeIds: [vectors[0].id], field: "fills[0]", variableId: iconVar });
      }
    }
    // Read back
    const after = await vectorsOf(variant.id);
    const n = after.length === 1 ? (await s.call("get_design_context", { nodeId: after[0].id })).nodes[0] : null;
    const ok = n && n.name === "Icon" && !(n.strokes ?? []).length && (n.fills ?? []).length === 1 && n.boundVariables?.["fillPaints[0].color"]?.id === iconVar && n.constraints?.horizontal === "SCALE";
    if (!ok) bad.push(`${set.name} › ${variant.name}: ${after.length} vectors${n ? `, ${JSON.stringify({ name: n.name, strokes: n.strokes?.length, fills: n.fills?.length, bound: n.boundVariables?.["fillPaints[0].color"]?.name, c: n.constraints })}` : ""}`);
    else done++;
  }
}
console.log(`icon variants as one "Icon" fill: ${done}/${done + bad.length}`);
if (bad.length) console.log("NOT DONE:\n  " + bad.slice(0, 20).join("\n  "));
process.exit(bad.length ? 1 : 0);
