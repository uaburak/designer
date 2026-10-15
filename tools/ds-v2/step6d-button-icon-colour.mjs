// Design system v2, step 6d: the Button's icons take its colour on their "Icon" layer (step 5d made every icon one
// filled vector named Icon), so a swapped icon keeps the colour — overrides carry by layer name. Read back: every
// variant's two icons' Icon fill bound to the variant's icon colour; then a swap test on a scratch instance.
import { look } from "./button-look.mjs";
import { session } from "./lib.mjs";

const s = await session();
const kids = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<([\w-]+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] })).filter((k) => k.id !== id);
const color = (await s.defs()).find((c) => c.name === "Color").variables;
const C = (name) => color.find((v) => v.name === name).id;
const page = (await kids("0:0")).find((p) => p.name === "Components");
const atoms = (await kids(page.id)).find((k) => k.name === "Atoms");
const section = (await kids(atoms.id)).find((k) => k.name === "Button");
const set = (await kids(section.id)).find((k) => k.name === "Button" && k.type !== "text");
const variants = (await kids(set.id)).filter((k) => k.type === "component");
const props = (name) => Object.fromEntries(name.split(", ").map((p) => p.split("=")));

const byColour = new Map();
const iconLayers = new Map();
for (const v of variants) {
  const tree = await kids(v.id, 3);
  const icons = tree.filter((k) => k.type === "vector" && k.name === "Icon").map((k) => k.id);
  iconLayers.set(v.id, icons);
  const c = look(props(v.name)).icon;
  byColour.set(c, [...(byColour.get(c) ?? []), ...icons]);
}
for (const [c, ids] of byColour) for (let i = 0; i < ids.length; i += 40) await s.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field: "fills[0]", variableId: C(c) });

let ok = 0;
const bad = [];
for (const v of variants) {
  const want = look(props(v.name)).icon;
  const got = [];
  for (const id of iconLayers.get(v.id)) got.push((await s.call("get_design_context", { nodeId: id })).nodes[0].boundVariables?.["fillPaints[0].color"]?.name);
  if (got.length === 2 && got.every((g) => g === want)) ok++;
  else bad.push(`${v.name}: want ${want}, got ${got.join(", ") || "no Icon layers"}`);
}
console.log(`Button icon colours: ${ok}/${variants.length}`);
if (bad.length) console.log("MISMATCH:\n  " + bad.slice(0, 10).join("\n  "));

// Swap test: a Primary instance, start icon on and swapped to the star — its Icon must stay icon/onbrand
const primary = variants.find((v) => v.name === "Variant=Primary, Size=Default, State=Default").id;
const ins = await s.call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: primary, parent: section.id } });
const test = ins.created?.[0] ?? ins.selection?.[0]?.id;
const iconsPage = (await kids("0:0")).find((p) => p.name === "Icons");
const iconsFrame = (await kids(iconsPage.id)).find((k) => k.name === "Icons");
const starSet = (await kids(iconsFrame.id)).find((k) => k.name === "Icon / 24.star");
const star = (await kids(starSet.id)).find((k) => k.name === "Set=Figma, Style=Default").id;
await s.call("run_command", { engineCommand: "SET_COMPONENT_PROPERTY", args: { ref: test, prop: "Show start icon", value: true } });
await s.call("run_command", { engineCommand: "SET_COMPONENT_PROPERTY", args: { ref: test, prop: "Start icon", value: star } });
const after = await kids(test, 3);
const startIcon = after.find((k) => k.type === "instance" && k.name.includes("star"));
const layer = startIcon && (await kids(startIcon.id, 2)).find((k) => k.name === "Icon");
const bound = layer && (await s.call("get_design_context", { nodeId: layer.id })).nodes[0].boundVariables?.["fillPaints[0].color"]?.name;
console.log(`swap test: start icon → ${startIcon?.name ?? "not swapped"}, its colour ${bound ?? "none"} (want icon/onbrand)`);
await s.call("delete_nodes", { nodeIds: [test] });
process.exit(bad.length || bound !== "icon/onbrand" ? 1 : 0);
