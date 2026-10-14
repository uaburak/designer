#!/usr/bin/env node
// The chrome's icons as vectors, in two sets:
//   Figma — each ds icon exactly as Icon.tsx draws it (src/renderer/src/ds/icons/registry.ts);
//   Wecra — drawn independently from each icon's meaning in tools/ui-kit/icons-wecra/ (our own primitives and
//           coordinates; see icons-wecra/apply.mjs, which also adds the Style=Outline variants). This file only
//           makes the Figma set; its earlier "wecra" style (a transform of the kit's paths) is gone.
//
//   node tools/ui-kit/icons.mjs generate        → tools/ui-kit/icons/figma/<name>.svg (every icon)
//   node tools/ui-kit/icons.mjs apply [names…]  → in "Wecra UI": each icon component becomes a set "Icon / <name>"
//        with Set=Figma | Set=Wecra, each variant one stroke vector and / or one fill vector (a second fill only for
//        a two-tone icon), coloured directly and bound to icon/icon — no mask, no colour layer.
//   node tools/ui-kit/icons.mjs variable          → the "Icons" collection (modes Figma, Wecra) and its "icon-set"
//        variable bound to every icon instance's Set: switch the mode on a frame or page to swap its icons.
//
// `apply` makes the vectors with create_nodes' `svg` (the editor's own SVG import, as Figma's createNodeFromSvg) inside
// the existing components: the components are changed in place (same nodes), so every instance stays
// linked; the set is laid out the same way every run (variants side by side), so nothing can compound.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guard } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { ICONS } = await import("../../src/renderer/src/ds/icons/registry.ts");

const WEIGHT = 1.4;
const EDGE = 0.4;
const TIGHTEN = 0.92;

/** One icon as SVG: `style` "figma" (1:1) or "wecra"; `bounds` adds a transparent box rect (for pasting at 0,0). */
export function iconSvg(name, style = "figma", { bounds = false } = {}) {
  if (style !== "figma") throw new Error("the Wecra set is drawn in tools/ui-kit/icons-wecra");
  const [box, mode, ...paths] = ICONS[name];
  const w = style === "wecra";
  const els = [];
  let view = `0 0 ${box} ${box}`;
  if (typeof mode === "string") {
    const v = Number(mode.slice(1));
    const inset = (box - v) / 2;
    view = `${-inset} ${-inset} ${box} ${box}`;
    for (const p of paths) {
      if (p.startsWith("f|")) els.push(`<path d="${p.slice(2)}" fill="#000" stroke="${w ? "#000" : "none"}"${w ? ` stroke-width="${EDGE}" stroke-linejoin="round"` : ""}/>`);
      else els.push(`<path d="${p}" fill="none" stroke="#000" stroke-width="${w ? WEIGHT : 1}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  } else {
    for (const p of paths) {
      const at = p.indexOf("|");
      const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
      const d = at > 0 ? p.slice(at + 1) : p;
      const op = tone >= 0.9 ? "" : ` fill-opacity="${(tone / 0.9).toFixed(3)}"${w ? ` stroke-opacity="${(tone / 0.9).toFixed(3)}"` : ""}`;
      const rule = mode === 1 ? ' fill-rule="evenodd" clip-rule="evenodd"' : "";
      els.push(`<path d="${d}" fill="#000"${rule}${op} stroke="${w ? "#000" : "none"}"${w ? ` stroke-width="${EDGE}" stroke-linejoin="round" stroke-linecap="round"` : ""}/>`);
    }
  }
  const [vx, vy, vw] = view.split(" ").map(Number);
  const c = vx + vw / 2;
  const cy = vy + vw / 2;
  // The tightening on each path (no group: the import makes the paths the frame's own children)
  const tf = `translate(${c} ${cy}) scale(${TIGHTEN}) translate(${-c} ${-cy})`;
  const body = w ? els.map((e) => e.replace("<path ", `<path transform="${tf}" `)).join("") : els.join("");
  const rect = bounds ? `<rect x="${vx}" y="${vy}" width="${vw}" height="${vw}" fill="#000" fill-opacity="0" stroke="none"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${view}">${rect}${body}</svg>\n`;
}


/** The light drawing: the stroke paths as one path, the fill paths as one per tone; `bounds` as iconSvg. */
export function lightSvg(name, style = "figma", { bounds = false } = {}) {
  if (style !== "figma") throw new Error("the Wecra set is drawn in tools/ui-kit/icons-wecra");
  const [box, mode, ...paths] = ICONS[name];
  const w = style === "wecra";
  let view = `0 0 ${box} ${box}`;
  const strokes = [];
  const fills = new Map(); // tone → d[]
  if (typeof mode === "string") {
    const v = Number(mode.slice(1));
    const inset = (box - v) / 2;
    view = `${-inset} ${-inset} ${box} ${box}`;
    for (const p of paths) {
      if (p.startsWith("f|")) fills.set(0.9, [...(fills.get(0.9) ?? []), p.slice(2)]);
      else strokes.push(p);
    }
  } else {
    for (const p of paths) {
      const at = p.indexOf("|");
      const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
      fills.set(tone, [...(fills.get(tone) ?? []), at > 0 ? p.slice(at + 1) : p]);
    }
  }
  const els = [];
  if (strokes.length) els.push(`<path d="${strokes.join(" ")}" fill="none" stroke="#000" stroke-width="${w ? WEIGHT : 1}" stroke-linecap="round" stroke-linejoin="round"/>`);
  for (const [tone, ds] of [...fills].sort((a, b) => b[0] - a[0])) {
    const op = tone >= 0.9 ? "" : ` fill-opacity="${(tone / 0.9).toFixed(3)}"`;
    const rule = mode === 1 ? ' fill-rule="evenodd"' : "";
    const edge = w ? ` stroke="#000" stroke-width="${EDGE}" stroke-linejoin="round" stroke-linecap="round"${tone >= 0.9 ? "" : ` stroke-opacity="${(tone / 0.9).toFixed(3)}"`}` : "";
    els.push(`<path d="${ds.join(" ")}" fill="#000"${rule}${op}${edge}/>`);
  }
  const [vx, vy, vw] = view.split(" ").map(Number);
  const c = vx + vw / 2, cy = vy + vw / 2;
  // The tightening on each path (no group: the import makes the paths the frame's own children)
  const tf = `translate(${c} ${cy}) scale(${TIGHTEN}) translate(${-c} ${-cy})`;
  const body = w ? els.map((e) => e.replace("<path ", `<path transform="${tf}" `)).join("") : els.join("");
  const rect = bounds ? `<rect x="${vx}" y="${vy}" width="${vw}" height="${vw}" fill="#000" fill-opacity="0"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${view}">${rect}${body}</svg>\n`;
}

/** The light drawing's layer names (a variant made of only these is done). */
const LIGHT = new Set(["Stroke", "Fill", "Fill 2"]);

const cmd = process.argv[2];
if (cmd === "generate") {
  for (const style of ["figma"]) {
    const dir = join(HERE, "icons", style);
    mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(ICONS)) writeFileSync(join(dir, `${name}.svg`), iconSvg(name, style));
  }
  console.log(`${Object.keys(ICONS).length} icons × 2 sets → tools/ui-kit/icons/`);
} else if (cmd === "apply") {
  await apply(process.argv.slice(3).filter((a) => !a.startsWith("--")));
} else if (cmd === "variable") {
  await variable();
}

async function session() {
  const { connect } = await import("./mcp.mjs");
  const MANIFEST = join(HERE, "manifest.json");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const mcp = await connect();
  if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);
  const kids = async (id) => [...String(await mcp.call("get_metadata", { nodeId: id, depth: 1 })).matchAll(/^ {2}<(\w+) id="([^"]+)" name="([^"]*)"/gm)].map((m) => ({ type: m[1], id: m[2], name: m[3] }));
  return { mcp, manifest, save, kids };
}


async function apply(names) {
  const { mcp, manifest, save, kids } = await session();
  const iconVar = manifest.variables.colors.icon;
  const sections = String(await mcp.call("get_metadata", { nodeId: manifest.sectionsRoot, depth: 2 }));
  const iconsFrame = /<frame id="([^"]+)" name="Icons"/.exec(sections)[1];
  /** A variant component's drawing made light, in place: its old layers out, the SVG's vectors in (create_nodes svg). */
  const makeLight = async (compId, name, style) => {
    const before = await kids(compId);
    if (!process.argv.includes("--redo") && before.length && before.every((k) => LIGHT.has(k.name) && k.type === "vector")) return null; // done
    // The SVG with its box (a transparent rect) so the vectors keep their place in it; unwrapped below
    const made = await mcp.call("create_nodes", { parentId: compId, nodes: [{ type: "FRAME", name: "svg", x: 0, y: 0, svg: lightSvg(name, style, { bounds: true }) }] }, { page: "Components" });
    const frame = made.created?.[0]?.id;
    if (!frame) throw new Error(`${name} (${style}): the SVG wasn't made: ${JSON.stringify(made).slice(0, 300)}`);
    const inner = [...String(await mcp.call("get_metadata", { nodeId: frame, depth: 1 })).matchAll(/^ {2}<(\w+) id="([^"]+)" name="([^"]*)" x="([-\d.]+)" y="([-\d.]+)"/gm)].map((m) => ({ type: m[1], id: m[2], x: Number(m[4]), y: Number(m[5]) }));
    const vectors = inner.filter((k) => k.type === "vector");
    if (!vectors.length) throw new Error(`${name} (${style}): the SVG made no vectors directly in its frame`);
    await mcp.call("reparent_nodes", { nodeIds: vectors.map((v) => v.id), parentId: compId, index: 0 }, { page: "Components" });
    await mcp.call("delete_nodes", { nodeIds: [frame, ...before.map((b) => b.id)] });
    // What each vector paints (the light SVG's order: the strokes' path, then the fills by tone, darkest first)
    const [, mode, ...paths] = ICONS[name];
    const hasStroke = typeof mode === "string" && paths.some((p) => !p.startsWith("f|"));
    const tones = typeof mode === "string" ? (paths.some((p) => p.startsWith("f|")) ? [0.9] : []) : [...new Set(paths.map((p) => (p.indexOf("|") > 0 ? Number(p.slice(0, p.indexOf("|"))) : 0.9)))].sort((a, b) => b - a);
    const out = [];
    const updates = [];
    vectors.forEach((v, i) => {
      const stroke = hasStroke && i === 0;
      const tone = stroke ? null : tones[i - (hasStroke ? 1 : 0)];
      const fill = !stroke;
      const label = stroke ? "Stroke" : i - (hasStroke ? 1 : 0) === 0 ? "Fill" : "Fill 2";
      // Every vector has a stroke paint (a filled one's is 0 wide in the Figma set, the 0.4 edge in Wecra's): an
      // instance's colour overrides fill and stroke alike and carries across the Set swap (layers matched by name).
      const rec = { id: v.id, stroke: true, fill };
      if (fill && tone != null && tone < 0.9) rec.toneOpacity = Number((tone / 0.9).toFixed(3));
      out.push(rec);
      updates.push({ nodeId: v.id, name: label, x: v.x, y: v.y, ...(fill && style === "figma" ? { strokes: ["#000000e5"], strokeWeight: 0 } : {}) });
    });
    await mcp.call("update_nodes", { updates });
    await mcp.call("update_nodes", { updates: vectors.map((v) => ({ nodeId: v.id, constraints: { horizontal: "SCALE", vertical: "SCALE" } })) });
    const strokeIds = out.filter((v) => v.stroke).map((v) => v.id);
    const fillIds = out.filter((v) => v.fill).map((v) => v.id);
    if (strokeIds.length) await mcp.call("bind_variable", { nodeIds: strokeIds, field: "strokes[0]", variableId: iconVar });
    if (fillIds.length) await mcp.call("bind_variable", { nodeIds: fillIds, field: "fills[0]", variableId: iconVar });
    return out;
  };
  const todo = (names.length ? names : Object.keys(manifest.icons)).filter((n) => manifest.icons[n]);
  const layoutSet = async (name) => {
    const ic = manifest.icons[name];
    const box = name.startsWith("16") ? 16 : 24;
    await mcp.call("update_nodes", {
      updates: [
        { nodeId: ic.set, name: `Icon / ${name}`, layoutPositioning: "AUTO", width: box * 2 + 60, height: box + 40, clipsContent: false },
        { nodeId: ic.id, x: 20, y: 20 },
        { nodeId: ic.wecra, x: box + 40, y: 20 },
      ],
    });
    await guard(mcp, ic.set, { exact: { width: box * 2 + 60, height: box + 40 }, what: `Icon / ${name}` });
  };
  // First the sets already made: back to their two boxes (a run that stopped half way left them as they were)
  for (const name of todo) if (manifest.icons[name].set && manifest.icons[name].wecra) await layoutSet(name);
  if (todo.length > 1) await guard(mcp, manifest.sectionsRoot, { max: 60000, top: true, what: "Wecra components" });
  if (process.argv.includes("--layout-only")) return;
  let done = 0;
  try {
    for (const name of todo) {
      const ic = manifest.icons[name];
      const box = name.startsWith("16") ? 16 : 24;
      const fv = await makeLight(ic.id, name, "figma");
      if (!ic.wecra) {
        // Beside the Figma component, out of the flow (absolute), so the set made from both is just their two boxes
        const made = await mcp.call("create_nodes", { parentId: iconsFrame, nodes: [{ type: "FRAME", name: "Set=Wecra", width: box, height: box, fills: [], clipsContent: false, layoutPositioning: "ABSOLUTE", x: 0, y: 0 }] }, { page: "Components" });
        ic.wecra = made.nodes[0].nodeId;
        await mcp.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [ic.wecra] });
        save();
      }
      const wv = null; // Set=Wecra's drawing: icons-wecra/apply.mjs
      ic.vectors = { figma: fv ?? ic.vectors?.figma, wecra: wv ?? ic.vectors?.wecra };
      delete ic.color;
      delete ic.colorWecra;
      if (!ic.set) {
        await mcp.call("update_nodes", { updates: [{ nodeId: ic.id, name: "Set=Figma" }, { nodeId: ic.wecra, name: "Set=Wecra" }] });
        const r = await mcp.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [ic.id, ic.wecra] });
        ic.set = r.selection[0].id;
        await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: ic.id, values: { Set: "Figma" } } });
        await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: ic.wecra, values: { Set: "Wecra" } } });
      }
      // The set's layout, the same every run: the two variants side by side, 20 px around (read back)
      save();
      await layoutSet(name);
      if (++done % 10 === 0) console.log(`icons ${done}/${todo.length}`);
    }
  } finally {
    save();
  }
  await guard(mcp, manifest.sectionsRoot, { max: 60000, top: true, what: "Wecra components" });
  console.log(`icons light: ${done}`);
}

/** The "Icons" collection: modes Figma and Wecra, a string "icon-set" per mode, bound to every icon instance's Set. */
async function variable() {
  const { mcp, manifest, save } = await session();
  const defs = await mcp.call("get_variable_defs", { all: true });
  let col = (defs.collections ?? []).find((c) => c.name === "Icons");
  let colId = col?.id;
  if (!colId) {
    const r = await mcp.call("create_variable_collection", { name: "Icons", modes: ["Figma", "Wecra"] });
    colId = r.collectionId ?? r.collection?.id ?? r.id;
  }
  let v = col?.variables?.find((x) => x.name === "icon-set")?.id;
  if (!v) {
    const r = await mcp.call("create_variable", { collectionId: colId, name: "icon-set", type: "STRING", values: { Figma: "Figma", Wecra: "Wecra" }, description: "The icon set every icon instance shows (its Set variant)" });
    v = r.variable?.id ?? r.variableId ?? r.id;
  }
  manifest.variables.icons = { collection: colId, iconSet: v };
  save();
  // Every icon instance that isn't inside another instance (those follow their main's)
  const pages = (await mcp.call("get_selection")).pages.filter((p) => p.name !== "Thumbnail");
  const ids = new Set();
  // The outline in pieces (get_metadata trims a large answer and says so)
  const walk = async (id, depth = 0) => {
    const meta = String(await mcp.call("get_metadata", { nodeId: id, depth: 40 }));
    for (const m of meta.matchAll(/<instance id="([^"]+)" name="Icon \/ [^"]*"/g)) if (!m[1].startsWith("I")) ids.add(m[1]);
    if (!/left out/.test(meta) || depth > 8) return;
    const kids = [...String(await mcp.call("get_metadata", { nodeId: id, depth: 1 })).matchAll(/^ {2}<\w+ id="([^"]+)"/gm)].map((m) => m[1]).filter((k) => !k.startsWith("I"));
    for (const k of kids) await walk(k, depth + 1);
  };
  for (const p of pages) await walk(p.id);
  const list = [...ids];
  let bound = 0;
  for (let i = 0; i < list.length; i += 100) {
    const r = await mcp.call("bind_variable", { nodeIds: list.slice(i, i + 100), field: "componentProperties.Set", variableId: v }, { soft: true });
    if (i === 0) console.log(JSON.stringify(r).slice(0, 300));
    bound += list.slice(i, i + 100).length;
  }
  console.log(`Icons collection ${colId}, icon-set ${v}, bound on ${bound} icon instances`);
}
