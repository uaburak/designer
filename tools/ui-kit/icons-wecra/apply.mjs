#!/usr/bin/env node
// Writes the icon sets out and into "Wecra UI".
//
//   node tools/ui-kit/icons-wecra/apply.mjs generate
//        → tools/ui-kit/icons/wecra/<name>.svg (our drawing), icons/wecra-outline/, icons/figma-outline/
//   node tools/ui-kit/icons-wecra/apply.mjs apply [names…] [--dry]
//        in the file, per icon set "Icon / <name>", in place:
//        · Set=Wecra gets our drawing (its old vectors out, the new ones in — create_nodes svg into the variant);
//        · a second variant property Style: the existing variants become Style=Default (so every instance stays as
//          it is), and Set=Figma, Style=Outline and Set=Wecra, Style=Outline are added (duplicates of the Default
//          variants with the outline drawing);
//        · the set laid out 2 × 2 (columns Figma | Wecra, rows Default | Outline), read back.
//        Every vector is bound to icon/icon (strokes and fills); layer names Stroke / Stroke 2 / Fill / Fill 2.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WECRA } from "./icons.mjs";
import { wecraSvg, wecraVectors, figmaOutlineSvg, figmaOutlineVectors } from "./render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..");
const MANIFEST = join(KIT, "manifest.json");
const args = process.argv.slice(2);
const cmd = args[0];
const dry = args.includes("--dry");

if (cmd === "generate") {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const names = Object.keys(manifest.icons);
  const missing = names.filter((n) => !WECRA[n]);
  if (missing.length) throw new Error(`not drawn yet: ${missing.join(", ")}`);
  for (const [dir, svg] of [["wecra", (n) => wecraSvg(n)], ["wecra-outline", (n) => wecraSvg(n, "outline")], ["figma-outline", (n) => figmaOutlineSvg(n)]]) {
    const at = join(KIT, "icons", dir);
    mkdirSync(at, { recursive: true });
    // Only our own drawings stay (the earlier Wecra set was a transform of the kit's paths: removed)
    for (const f of readdirSync(at)) rmSync(join(at, f));
    for (const n of names) writeFileSync(join(at, `${n}.svg`), svg(n));
  }
  console.log(`${names.length} icons → tools/ui-kit/icons/{wecra,wecra-outline,figma-outline}`);
} else if (cmd === "apply") {
  await apply(args.slice(1).filter((a) => !a.startsWith("--")));
}

async function apply(names) {
  const { connect } = await import("../mcp.mjs");
  const { guard } = await import("../guard.mjs");
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const mcp = await connect();
  if ((await mcp.call("get_selection")).file !== manifest.file) throw new Error(`bring "${manifest.file}" to the front`);
  const iconVar = manifest.variables.colors.icon;
  const toneVar = manifest.variables.colors["icon-tertiary"];
  const P = { page: "Components" };
  const kids = async (id) => [...String(await mcp.call("get_metadata", { nodeId: id, depth: 1 })).matchAll(/^ {2}<(\w+) id="([^"]+)" name="([^"]*)" x="([-\d.e]+)" y="([-\d.e]+)"/gm)].map((m) => ({ type: m[1], id: m[2], name: m[3], x: Number(m[4]), y: Number(m[5]) }));

  /** A variant's drawing replaced in place by `vectors` (from render.mjs): new vectors in, old layers out. */
  const draw = async (compId, box, vectors, view) => {
    const before = await kids(compId);
    const rect = `<rect x="${view[0]}" y="${view[1]}" width="${box}" height="${box}" fill="#000" fill-opacity="0"/>`;
    const els = vectors.map((v) => (v.stroke ? `<path d="${v.d}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"${v.opacity < 1 ? ` stroke-opacity="${v.opacity}"` : ""}/>` : `<path d="${v.d}" fill="#000"${v.evenodd ? ' fill-rule="evenodd"' : ""}${v.opacity < 1 ? ` fill-opacity="${v.opacity}"` : ""}/>`));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${view.join(" ")} ${box} ${box}">${rect}${els.join("")}</svg>`;
    const made = await mcp.call("create_nodes", { parentId: compId, nodes: [{ type: "FRAME", name: "svg", x: 0, y: 0, svg }] }, P);
    const frame = made.created?.[0]?.id;
    if (!frame) throw new Error(`${compId}: the SVG wasn't made`);
    const inner = (await kids(frame)).filter((k) => k.type === "vector");
    if (inner.length !== vectors.length) throw new Error(`${compId}: ${inner.length} vectors made, ${vectors.length} drawn`);
    await mcp.call("reparent_nodes", { nodeIds: inner.map((v) => v.id), parentId: compId, index: 0 }, P);
    await mcp.call("delete_nodes", { nodeIds: [frame, ...before.map((b) => b.id)] });
    // Names, places, scaling; every vector also gets the other paint at 0 width / none so an instance's colour
    // override (fill and stroke alike) carries across Set and Style swaps (layers matched by name)
    await mcp.call("update_nodes", {
      updates: inner.map((v, i) => ({ nodeId: v.id, name: vectors[i].name, x: v.x, y: v.y, constraints: { horizontal: "SCALE", vertical: "SCALE" }, ...(vectors[i].stroke ? {} : { strokes: ["#000000e5"], strokeWeight: 0 }),
 })),
    });
    // The colour: icon/icon, the secondary tone icon/icon-tertiary (the kit's 0.3 black — a bound paint takes the
    // variable's colour, so a tone can't be a paint opacity)
    for (const tone of [false, true]) {
      const v = tone ? toneVar : iconVar;
      const of = (stroke) => inner.filter((_, i) => vectors[i].stroke === stroke && vectors[i].opacity < 1 === tone).map((x) => x.id);
      const strokes = of(true), fills = of(false);
      if (strokes.length) await mcp.call("bind_variable", { nodeIds: strokes, field: "strokes[0]", variableId: v });
      if (fills.length) {
        await mcp.call("bind_variable", { nodeIds: fills, field: "fills[0]", variableId: v });
        await mcp.call("bind_variable", { nodeIds: fills, field: "strokes[0]", variableId: v });
      }
    }
    return inner.map((v, i) => ({ id: v.id, name: vectors[i].name, stroke: vectors[i].stroke }));
  };
  const props = (ref, values) => mcp.call("run_command", { engineCommand: "SET_VARIANT_PROPERTIES", args: { ref, values } });
  /** A copy of a variant in the set (Style=Outline), its drawing replaced. */
  const outlineOf = async (ic, srcId, set) => {
    const r = await mcp.call("duplicate_nodes", { nodeIds: [srcId], parentId: ic.set }, P);
    const id = (r.copies ?? r.nodes ?? [])[0]?.nodeId ?? (r.copies ?? r.nodes ?? [])[0]?.id;
    if (!id) throw new Error(`${srcId}: no copy: ${JSON.stringify(r).slice(0, 200)}`);
    await props(id, { Set: set, Style: "Outline" });
    if (!new RegExp(`id="${id}" name="Set=${set}, Style=Outline"`).test(String(await mcp.call("get_metadata", { nodeId: ic.set, depth: 1 })))) throw new Error(`${id}: not Set=${set}, Style=Outline`);
    return id;
  };

  const todo = (names.length ? names : Object.keys(manifest.icons)).filter((n) => manifest.icons[n]?.set && manifest.icons[n].wecra);
  let done = 0;
  try {
    for (const name of todo) {
      const ic = manifest.icons[name];
      const box = name.startsWith("16") ? 16 : 24;
      const figView = (() => {
        const m = /viewBox="([-\d.]+) ([-\d.]+)/.exec(figmaOutlineSvg(name));
        return [Number(m[1]), Number(m[2])];
      })();
      if (dry) {
        console.log(`${name}: Wecra ${wecraVectors(name).map((v) => v.name).join("+")}, outline ${wecraVectors(name, "outline").map((v) => v.name).join("+")}, Figma outline ${figmaOutlineVectors(name).map((v) => v.name).join("+")}`);
        continue;
      }
      // 0. The Figma drawing's secondary tone (its "Fill 2" had lost it to the bound colour)
      const tone2 = (await kids(ic.id)).filter((k) => k.name === "Fill 2").map((k) => k.id);
      if (tone2.length) for (const field of ["fills[0]", "strokes[0]"]) await mcp.call("bind_variable", { nodeIds: tone2, field, variableId: toneVar });
      // 1. Our drawing in Set=Wecra (Style=Default)
      ic.vectors = { ...(ic.vectors ?? {}), wecra: await draw(ic.wecra, box, wecraVectors(name), [0, 0]) };
      // 2. The Style property (a variant property of the set, default Default: today's variants take it)
      if (!/Style=/.test(String(await mcp.call("get_metadata", { nodeId: ic.set, depth: 1 }))))
        await mcp.call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: ic.set, name: "Style", type: "VARIANT", defaultValue: "Default" } });
      // 3. The Outline variants
      if (!ic.figmaOutline) {
        ic.figmaOutline = await outlineOf(ic, ic.id, "Figma");
        save();
      }
      ic.vectors.figmaOutline = await draw(ic.figmaOutline, box, figmaOutlineVectors(name), figView);
      if (!ic.wecraOutline) {
        ic.wecraOutline = await outlineOf(ic, ic.wecra, "Wecra");
        save();
      }
      ic.vectors.wecraOutline = await draw(ic.wecraOutline, box, wecraVectors(name, "outline"), [0, 0]);
      // 4. The set 2 × 2, the same every run, read back
      const W = box * 2 + 60;
      await mcp.call("update_nodes", {
        updates: [
          { nodeId: ic.set, width: W, height: W, clipsContent: false },
          { nodeId: ic.id, x: 20, y: 20 },
          { nodeId: ic.wecra, x: box + 40, y: 20 },
          { nodeId: ic.figmaOutline, x: 20, y: box + 40 },
          { nodeId: ic.wecraOutline, x: box + 40, y: box + 40 },
        ],
      });
      await guard(mcp, ic.set, { exact: { width: W, height: W }, what: `Icon / ${name}` });
      save();
      if (++done % 10 === 0) console.log(`icons ${done}/${todo.length}`);
    }
  } finally {
    save();
  }
  if (!dry) await guard(mcp, manifest.sectionsRoot, { max: 60000, top: true, what: "Wecra components" });
  console.log(`icons: ${done} sets with Set × Style`);
}
