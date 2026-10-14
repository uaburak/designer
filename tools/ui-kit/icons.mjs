#!/usr/bin/env node
// The chrome's icons as vectors, in two sets:
//   Figma — each ds icon exactly as Icon.tsx draws it (src/renderer/src/ds/icons/registry.ts);
//   Wecra — our own drawing of the same icon: a consistent 1.4 px weight (stroke icons drawn at 1.4, filled
//           outlines given a 0.4 round-joined edge), round ends and joins everywhere, the glyph 8 % tighter
//           around the icon's centre. Same meaning, not Figma's artwork.
//
//   node tools/ui-kit/icons.mjs generate        → tools/ui-kit/icons/{figma,wecra}/<name>.svg (every icon)
//   node tools/ui-kit/icons.mjs apply [names…]  → in "Wecra UI": each icon component becomes a set "Icon / <name>"
//        with Set=Figma | Set=Wecra (vector glyphs), and the "Icons" variable collection (modes Figma, Wecra) drives
//        every icon instance's Set — switch the collection's mode on a frame or page to swap all icons there.
//
// `apply` pastes the SVG into the existing components (the app's MCP tools have no vector creation; its SVG paste
// does): it puts the SVG on the clipboard as public.svg-image and runs "Paste to replace" on the glyph — the clipboard's
// text is restored afterwards. Existing components are changed in place, so every instance stays linked.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const { ICONS } = await import("../../src/renderer/src/ds/icons/registry.ts");

const WEIGHT = 1.4;
const EDGE = 0.4;
const TIGHTEN = 0.92;

/** One icon as SVG: `style` "figma" (1:1) or "wecra"; `bounds` adds a transparent box rect (for pasting at 0,0). */
export function iconSvg(name, style = "figma", { bounds = false } = {}) {
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
  const body = w ? `<g transform="translate(${c} ${cy}) scale(${TIGHTEN}) translate(${-c} ${-cy})">${els.join("")}</g>` : els.join("");
  const rect = bounds ? `<rect x="${vx}" y="${vy}" width="${vw}" height="${vw}" fill="#000" fill-opacity="0" stroke="none"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${view}">${rect}${body}</svg>\n`;
}

const cmd = process.argv[2];
if (cmd === "generate") {
  for (const style of ["figma", "wecra"]) {
    const dir = join(HERE, "icons", style);
    mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(ICONS)) writeFileSync(join(dir, `${name}.svg`), iconSvg(name, style));
  }
  console.log(`${Object.keys(ICONS).length} icons × 2 sets → tools/ui-kit/icons/`);
} else if (cmd === "apply") {
  await apply(process.argv.slice(3));
}

async function apply(names) {
  const { connect } = await import("./mcp.mjs");
  const MANIFEST = join(HERE, "manifest.json");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const mcp = await connect();
  if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);
  const tmp = join(tmpdir(), "wecra-ui-kit-icon.svg");
  const pb = join(HERE, "pasteboard-svg.js");
  const clipboard = execFileSync("pbpaste").toString();
  const kids = async (id) => [...String(await mcp.call("get_metadata", { nodeId: id, depth: 1 })).matchAll(/^ {2}<(\w+) id="([^"]+)" name="([^"]*)"/gm)].map((m) => ({ type: m[1], id: m[2], name: m[3] }));
  /** Replaces a component's glyph layer with the icon's vectors (a group used as the alpha mask). */
  const pasteGlyph = async (mainId, name, style) => {
    const before = await kids(mainId);
    const glyph = before[0];
    writeFileSync(tmp, iconSvg(name, style, { bounds: true }));
    execFileSync("osascript", ["-l", "JavaScript", pb, tmp]);
    await mcp.call("run_command", { command: "edit.paste-to-replace", nodeIds: [glyph.id] });
    let after = [];
    for (let i = 0; i < 20; i++) {
      after = await kids(mainId);
      if (after[0] && after[0].id !== glyph.id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const group = after[0];
    if (!group || group.id === glyph.id) throw new Error(`${name}: the paste didn't replace the glyph`);
    const inner = await kids(group.id);
    await mcp.call("update_nodes", {
      updates: [
        { nodeId: group.id, name: "glyph", isMask: true, maskType: "ALPHA", x: 0, y: 0, constraints: { horizontal: "SCALE", vertical: "SCALE" } },
        ...(inner[0]?.type === "rectangle" ? [{ nodeId: inner[0].id, name: "bounds" }] : []),
        ...inner.slice(1).map((v) => ({ nodeId: v.id, name: style === "wecra" ? "Vector (Wecra)" : "Vector" })),
      ],
    });
    return group.id;
  };
  // The frame the icon components sit in (the Components page's "Icons" section)
  const sections = String(await mcp.call("get_metadata", { nodeId: manifest.sectionsRoot, depth: 2 }));
  const iconsFrame = /<frame id="([^"]+)" name="Icons"/.exec(sections)[1];
  const todo = (names.length ? names : Object.keys(manifest.icons)).filter((n) => manifest.icons[n] && !manifest.icons[n].set);
  let done = 0;
  try {
    for (const name of todo) {
      const ic = manifest.icons[name];
      const box = name.startsWith("16") ? 16 : 24;
      // Figma: the existing component, its picture glyph replaced by the vectors (once)
      if ((await kids(ic.id))[0]?.type === "rectangle") await pasteGlyph(ic.id, name, "figma");
      // Wecra: a new component of the same build beside it (a main duplicated here gives an instance)
      let wecra = ic.wecra;
      if (!wecra) {
        const made = await mcp.call("create_nodes", {
          parentId: iconsFrame,
          nodes: [{ type: "FRAME", name: "Set=Wecra", x: 0, y: 0, width: box, height: box, fills: [], clipsContent: false, children: [
            { type: "RECTANGLE", name: "glyph", x: 0, y: 0, width: box, height: box, isMask: true, maskType: "ALPHA", fills: ["#000000"] },
            { type: "RECTANGLE", name: "color", x: 0, y: 0, width: box, height: box, fills: ["#000000e5"] },
          ] }],
        });
        wecra = made.nodes[0].nodeId;
        const colorW = made.nodes[2].nodeId;
        await mcp.call("update_nodes", { updates: [1, 2].map((k) => ({ nodeId: made.nodes[k].nodeId, constraints: { horizontal: "SCALE", vertical: "SCALE" } })) });
        await mcp.call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [wecra] });
        await mcp.call("bind_variable", { nodeIds: [colorW], field: "fills[0]", variableId: manifest.variables.colors.icon });
        Object.assign(ic, { wecra, colorWecra: colorW });
        save();
      }
      if ((await kids(wecra))[0]?.type === "rectangle") await pasteGlyph(wecra, name, "wecra");
      await mcp.call("update_nodes", { updates: [{ nodeId: ic.id, name: "Set=Figma" }, { nodeId: wecra, name: "Set=Wecra" }] });
      const r = await mcp.call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [ic.id, wecra] });
      const set = r.selection[0].id;
      // The variant property's values, registered on each variant
      await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: ic.id, values: { Set: "Figma" } } });
      await mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref: wecra, values: { Set: "Wecra" } } });
      await mcp.call("update_nodes", { updates: [{ nodeId: set, name: `Icon / ${name}` }] });
      ic.set = set;
      save();
      if (++done % 10 === 0) console.log(`icons ${done}/${todo.length}`);
    }
  } finally {
    execFileSync("pbcopy", { input: clipboard });
  }
  console.log(`icons converted: ${done}`);
}
