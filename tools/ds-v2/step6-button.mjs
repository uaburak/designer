// Design system v2, step 6 (docs/design-system-v2.md §d Button): one Button set.
//   Variant: Primary | Secondary | Ghost | Destructive | Destructive secondary
//   Size:    Default | Large
//   State:   Default | Hover | Pressed | Focus | Selected | Disabled            (Loading comes with the Spinner atom)
//   Content: Show start icon (bool) + Start icon (swap) · Label (text) · Show end icon (bool) + End icon (swap)
// Auto layout everywhere, centred. Every number is a variable (height, padding, gap, radius, stroke, icon size), every
// colour a Color token, every icon's Set / Style bound to the Icon set / Icon style switches. Built on the base variant
// (so the bindings copy), then each variant's look. Read back: every variant's bindings and properties.
import { look } from "./button-look.mjs";
import { session } from "./lib.mjs";

const s = await session();
const meta = async (id, depth = 1) => [...String(await s.call("get_metadata", { nodeId: id, depth })).matchAll(/<([\w-]+) id="([^"]+)" name="([^"]*)"/g)].map((m) => ({ type: m[1], id: m[2], name: m[3] })).filter((k) => k.id !== id);

// ── Variables and styles by name ──
const cols = await s.defs();
const V = (col, name) => {
  const v = cols.find((c) => c.name === col)?.variables?.find((x) => x.name === name);
  if (!v) throw new Error(`no variable ${col} › ${name}`);
  return v.id;
};
const styles = (await s.call("get_variable_defs", { all: true })).styles ?? [];
const textStyle = styles.find((x) => x.name === "Body/Medium")?.id;

// The large control's own padding (density-following, like padding/control)
{
  const size = cols.find((c) => c.name === "Size");
  if (!size.variables.some((v) => v.name === "padding/control-large")) {
    const n = (x) => ({ alias: V("Primitives", `number/${x}`) });
    await s.call("create_variable", { collectionId: size.id, name: "padding/control-large", type: "FLOAT", values: { Compact: n(10), Default: n(12), Comfortable: n(16) }, scopes: ["GAP"] });
  }
}
const cols2 = await s.defs();
const SZ = (name) => cols2.find((c) => c.name === "Size").variables.find((v) => v.name === name).id;

// ── The page and its frames ──
const pages = await meta("0:0");
let page = pages.find((p) => p.name === "Components");
if (!page) {
  const r = await s.call("run_command", { engineCommand: "CREATE_PAGE", args: {} });
  const id = r.created?.[0] ?? r.selection?.[0]?.id ?? (await meta("0:0")).find((p) => !pages.some((q) => q.id === p.id))?.id;
  await s.call("update_nodes", { updates: [{ nodeId: id, name: "Components" }] });
  page = { id, name: "Components" };
}
const ensureFrame = async (parent, name, props) => {
  const had = (await meta(parent)).find((k) => k.name === name);
  if (had) return had.id;
  const r = await s.call("create_nodes", { parentId: parent, nodes: [{ type: "FRAME", name, ...props }] });
  return (r.nodes ?? r.created)[0].nodeId ?? (r.nodes ?? r.created)[0].id;
};
const atoms = await ensureFrame(page.id, "Atoms", { x: 0, y: 0, layoutMode: "VERTICAL", itemSpacing: 64, padding: 64, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", fills: ["#FFFFFF"] });
const section = await ensureFrame(atoms, "Button", { layoutMode: "VERTICAL", itemSpacing: 24, padding: 0, counterAxisAlignItems: "MIN", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", fills: [] });
if (!(await meta(section)).some((k) => k.name === "Title")) await s.call("create_nodes", { parentId: section, nodes: [{ type: "TEXT", name: "Title", characters: "Button", fontSize: 24, lineHeight: 32 }] });
const title = (await meta(section)).find((k) => k.name === "Title").id;
const headingStyle = styles.find((x) => x.name === "Heading/Large")?.id;
if (headingStyle) await s.call("apply_style", { nodeIds: [title], slot: "text", styleId: headingStyle });

// ── Icons: a variant of an icon set to instance ──
const iconPage = pages.find((p) => p.name === "Icons");
const iconFrame = (await meta(iconPage.id)).find((k) => k.name === "Icons").id;
const iconSets = (await meta(iconFrame)).filter((k) => k.name.startsWith("Icon / "));
const iconMain = async (name) => {
  const set = iconSets.find((k) => k.name === `Icon / ${name}`);
  return (await meta(set.id)).find((k) => k.name === "Set=Figma, Style=Default").id;
};

// ── The set ──
const PROPS = {
  Variant: ["Primary", "Secondary", "Ghost", "Destructive", "Destructive secondary"],
  Size: ["Default", "Large"],
  State: ["Default", "Hover", "Pressed", "Focus", "Selected", "Disabled"],
};
const combos = Object.entries(PROPS).reduce((acc, [k, vs]) => acc.flatMap((c) => vs.map((v) => ({ ...c, [k]: v }))), [{}]);
const nameOf = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(", ");

let setId = (await meta(section)).find((k) => k.name === "Button" && k.id !== section)?.id;
let base;
if (!setId) {
  const c0 = combos[0];
  const r = await s.call("create_nodes", {
    parentId: section,
    nodes: [{
      type: "FRAME", name: nameOf(c0), layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED", height: 24, padding: [0, 8, 0, 8], itemSpacing: 4, cornerRadius: 5,
      fills: ["#0D99FF"], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", clipsContent: false,
      children: [{ type: "TEXT", name: "Label", characters: "Button", fills: ["#FFFFFF"] }],
    }],
  });
  base = (r.nodes ?? r.created)[0].nodeId ?? (r.nodes ?? r.created)[0].id;
  const label = (await meta(base)).find((k) => k.name === "Label").id;
  // The icons: instances of the 24-grid set, before and after the label
  const startI = await s.call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: await iconMain("24.plus"), parent: base } });
  const endI = await s.call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: await iconMain("24.arrow.right"), parent: base } });
  const startIcon = startI.created?.[0] ?? startI.selection?.[0]?.id;
  const endIcon = endI.created?.[0] ?? endI.selection?.[0]?.id;
  await s.call("update_nodes", { updates: [{ nodeId: startIcon, name: "Start icon" }, { nodeId: endIcon, name: "End icon" }] });
  await s.call("reparent_nodes", { nodeIds: [startIcon], parentId: base, index: 0 });
  await s.call("reparent_nodes", { nodeIds: [endIcon], parentId: base, index: 2 });
  if (textStyle) await s.call("apply_style", { nodeIds: [label], slot: "text", styleId: textStyle });
  await s.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [base] });
  const comb = await s.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [base] });
  setId = comb.selection[0].id;
  await s.call("update_nodes", { updates: [{ nodeId: setId, name: "Button" }] });
  // The variant properties come from the base's name ("Variant=…, Size=…, State=…") when it is combined: adding them
  // again would define each twice (every variant's name then carries both)
  // Content properties
  const sets24 = iconSets.filter((k) => k.name.startsWith("Icon / 24.")).map((k) => k.id);
  const add = (name, type, defaultValue, extra = {}) => s.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: setId, name, type, defaultValue, ...extra } });
  await add("Show start icon", "BOOL", false);
  await add("Start icon", "INSTANCE_SWAP", await iconMain("24.plus"), { preferredValues: sets24 });
  await add("Label", "TEXT", "Button");
  await add("Show end icon", "BOOL", false);
  await add("End icon", "INSTANCE_SWAP", await iconMain("24.arrow.right"), { preferredValues: sets24 });
  const bindProp = (refs, field, prop) => s.call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs, field, prop } });
  await bindProp([startIcon], "VISIBLE", "Show start icon");
  await bindProp([startIcon], "OVERRIDDEN_SYMBOL_ID", "Start icon");
  await bindProp([label], "TEXT_DATA", "Label");
  await bindProp([endIcon], "VISIBLE", "Show end icon");
  await bindProp([endIcon], "OVERRIDDEN_SYMBOL_ID", "End icon");
  // The base's numbers and icon switches (copied to every variant made from it)
  const bind = (nodeIds, field, variableId) => s.call("bind_variable", { nodeIds, field, variableId });
  await bind([base], "height", SZ("size/control"));
  await bind([base], "paddingLeft", SZ("padding/control"));
  await bind([base], "paddingRight", SZ("padding/control"));
  await bind([base], "itemSpacing", SZ("gap/control"));
  await bind([base], "cornerRadius", V("Radius", "radius/medium"));
  await bind([base], "strokeWeight", SZ("stroke/default"));
  await bind([startIcon, endIcon], "width", SZ("size/icon-control"));
  await bind([startIcon, endIcon], "height", SZ("size/icon-control"));
  await bind([startIcon, endIcon], "componentProperties.Set", V("Icon set", "icon/set"));
  await bind([startIcon, endIcon], "componentProperties.Style", V("Icon style", "icon/style"));
} else base = (await meta(setId)).find((k) => k.name === nameOf(combos[0]))?.id;

// ── Every other variant: a copy of the base, its properties set ──
const have = new Map((await meta(setId)).filter((k) => k.type === "component").map((k) => [k.name, k.id]));
for (const c of combos) {
  if (have.has(nameOf(c))) continue;
  const r = await s.call("duplicate_nodes", { nodeIds: [base], parentId: setId });
  const id = (r.copies ?? r.nodes)[0].nodeId ?? (r.copies ?? r.nodes)[0].id;
  await s.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: id, values: c } });
  have.set(nameOf(c), id);
}

// ── Each variant's look ──
const C = (name) => V("Color", name);
const binds = new Map();
const B = (field, variable, id) => {
  const k = `${field}|${variable}`;
  binds.set(k, [...(binds.get(k) ?? []), id]);
};
const updates = [];
const parts = new Map();
for (const c of combos) {
  const id = have.get(nameOf(c));
  const tree = await meta(id, 4);
  const label = tree.find((k) => k.name === "Label").id;
  const icons = tree.filter((k) => k.type === "instance").map((k) => k.id);
  const vectors = tree.filter((k) => k.type === "vector").map((k) => k.id);
  parts.set(id, { label, icons, vectors });
  const l = look(c);
  const focus = c.State === "Focus";
  updates.push({ nodeId: id, fills: l.bg ? ["#000000"] : [], strokes: l.stroke || focus ? ["#000000"] : [], opacity: 1 });
  if (l.bg) B("fills[0]", l.bg, id);
  if (focus) B("strokes[0]", "border/selected", id);
  else if (l.stroke) B("strokes[0]", l.stroke, id);
  B("fills[0]", l.fg, label);
  for (const v of vectors) {
    B("fills[0]", l.icon, v);
    B("strokes[0]", l.icon, v);
  }
  // Large: the large control's height, padding and icon size
  if (c.Size === "Large") {
    B("height", "@size/control-large", id);
    B("paddingLeft", "@padding/control-large", id);
    B("paddingRight", "@padding/control-large", id);
    for (const i of icons) {
      B("width", "@size/icon-control-large", i);
      B("height", "@size/icon-control-large", i);
    }
  }
}
for (let i = 0; i < updates.length; i += 30) await s.call("update_nodes", { updates: updates.slice(i, i + 30) });
let soft = 0;
for (const [k, ids] of binds) {
  const [field, name] = k.split("|");
  const variableId = name.startsWith("@") ? SZ(name.slice(1)) : C(name);
  for (let i = 0; i < ids.length; i += 40) {
    try {
      await s.call("bind_variable", { nodeIds: ids.slice(i, i + 40), field, variableId });
    } catch {
      // A vector without a stroke (or a fill) can't take that paint's binding: bind one by one, count the ones that
      // have no such paint (expected), stop on anything else
      for (const one of ids.slice(i, i + 40)) {
        try {
          await s.call("bind_variable", { nodeIds: [one], field, variableId });
        } catch (e) {
          if (!/vector|stroke|fill|paint/i.test(String(e)) || !/^(fills|strokes)\[0\]$/.test(field)) throw e;
          soft++;
        }
      }
    }
  }
}

// ── The set's layout: a wrapping grid, centred ──
await s.call("update_nodes", { updates: [{ nodeId: setId, layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 16, counterAxisSpacing: 16, padding: 24, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", width: 6 * 96 + 5 * 16 + 48, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG" }] });

// ── Read back ──
const want = (c) => {
  const l = look(c);
  const large = c.Size === "Large";
  return {
    HEIGHT: large ? "size/control-large" : "size/control",
    STACK_PADDING_LEFT: large ? "padding/control-large" : "padding/control",
    STACK_SPACING: "gap/control",
    RECTANGLE_TOP_LEFT_CORNER_RADIUS: "radius/medium",
    ...(l.bg ? { "fillPaints[0].color": l.bg } : {}),
  };
};
let ok = 0;
const bad = [];
for (const c of combos) {
  const id = have.get(nameOf(c));
  const ctx = await s.call("get_design_context", { nodeId: id });
  const n = ctx.nodes[0];
  const bv = Object.fromEntries(Object.entries(n.boundVariables ?? {}).map(([k, v]) => [k, v.name]));
  const miss = Object.entries(want(c)).filter(([k, v]) => bv[k] !== v).map(([k, v]) => `${k}: want ${v}, got ${bv[k]}`);
  const label = n.children?.find((k) => k.name === "Label");
  if (label?.boundVariables?.["fillPaints[0].color"]?.name !== look(c).fg) miss.push(`label colour: got ${label?.boundVariables?.["fillPaints[0].color"]?.name}`);
  if (miss.length) bad.push(`${nameOf(c)} → ${miss.join("; ")}`);
  else ok++;
}
const finalNames = (await meta(setId)).filter((k) => k.type === "component").map((k) => k.name);
const doubled = finalNames.filter((n) => n.split("Variant=").length > 2);
if (finalNames.length !== combos.length || doubled.length) bad.push(`variants ${finalNames.length} (want ${combos.length}), doubled names ${doubled.length}`);
console.log(`Button: ${have.size} variants; ${ok}/${combos.length} verified (height, padding, gap, radius, fill, label colour); soft binding notes: ${soft}`);
if (bad.length) console.log("MISMATCH:\n  " + bad.slice(0, 20).join("\n  "));
process.exit(bad.length ? 1 : 0);
