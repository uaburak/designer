// Design system v2, step 6b: the Button's mode check — a "Modes" frame beside the set with four rows of instances
// (Primary / Secondary / Ghost / Destructive, start and end icons on), each row in its own modes: the defaults;
// Yellow + Dark; Round + Compact; Yellow + Comfortable + Wecra icons. Rebuilt every run (it's documentation, not a
// component). Read back: each row's explicit modes.
import { session } from "./lib.mjs";

const s = await session();
const meta = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<([\w-]+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] })).filter((k) => k.id !== id);
const page = (await meta("0:0")).find((p) => p.name === "Components");
const atoms = (await meta(page.id)).find((k) => k.name === "Atoms");
const section = (await meta(atoms.id)).find((k) => k.name === "Button");
const set = (await meta(section.id)).find((k) => k.name === "Button" && k.type !== "text");
const variants = await meta(set.id);
const variant = (v) => variants.find((k) => k.name === `Variant=${v}, Size=Default, State=Default`).id;

const old = (await meta(section.id)).find((k) => k.name === "Modes");
if (old) await s.call("delete_nodes", { nodeIds: [old.id] });
const made = await s.call("create_nodes", { parentId: section.id, nodes: [{ type: "FRAME", name: "Modes", layoutMode: "VERTICAL", itemSpacing: 0, padding: 0, layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", fills: [] }] });
const modes = (made.nodes ?? made.created)[0].nodeId ?? (made.nodes ?? made.created)[0].id;

const ROWS = [
  ["Default", {}],
  ["Yellow · Dark", { Brand: "Yellow", Color: "Dark" }],
  ["Round · Compact", { Radius: "Round", Size: "Compact" }],
  ["Yellow · Comfortable · Wecra icons", { Brand: "Yellow", Size: "Comfortable", "Icon set": "Wecra" }],
];
const bg = (await s.defs()).find((c) => c.name === "Color").variables.find((v) => v.name === "bg/default").id;
for (const [label, m] of ROWS) {
  const r = await s.call("create_nodes", { parentId: modes, nodes: [{ type: "FRAME", name: label, layoutMode: "HORIZONTAL", itemSpacing: 16, padding: 24, counterAxisAlignItems: "CENTER", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", fills: ["#FFFFFF"], children: [{ type: "TEXT", name: "Mode", characters: label, fontSize: 11, width: 200, layoutSizingHorizontal: "FIXED" }] }] });
  const row = (r.nodes ?? r.created)[0].nodeId ?? (r.nodes ?? r.created)[0].id;
  await s.call("bind_variable", { nodeIds: [row], field: "fills[0]", variableId: bg });
  const modeText = (await meta(row)).find((k) => k.name === "Mode").id;
  const fg = (await s.defs()).find((c) => c.name === "Color").variables.find((v) => v.name === "text/secondary").id;
  await s.call("bind_variable", { nodeIds: [modeText], field: "fills[0]", variableId: fg });
  for (const v of ["Primary", "Secondary", "Ghost", "Destructive"]) {
    const ins = await s.call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: variant(v), parent: row } });
    const id = ins.created?.[0] ?? ins.selection?.[0]?.id;
    for (const [prop, value] of [["Show start icon", true], ["Show end icon", true], ["Label", v]]) await s.call("run_command", { engineCommand: "SET_COMPONENT_PROPERTY", args: { ref: id, prop, value } });
  }
  for (const [collectionId, mode] of Object.entries(m)) await s.call("set_variable_mode", { nodeIds: [row], collectionId, mode });
}
console.log("Modes frame:", modes);
