#!/usr/bin/env node
// Reads the design (get_design_context) of every screen and every main component of the "Wecra UI" file into
// out/polish/ctx/<screen id | set>.json — what polish.mjs checks and fixes. Read-only.
//
//   node tools/ui-kit/dump.mjs [--screens] [--components] [<screen id | set>…]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "out", "polish", "ctx");
mkdirSync(DIR, { recursive: true });
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith("--"));
const all = !args.includes("--screens") && !args.includes("--components");
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const mcp = await connect();
const sel = await mcp.call("get_selection");
if (sel.file !== manifest.file) throw new Error(`Bound to "${sel.file}", not "${manifest.file}"`);

if (all || args.includes("--screens"))
  for (const [id, s] of Object.entries(manifest.screens)) {
    if (names.length && !names.includes(id)) continue;
    const r = await mcp.call("get_design_context", { nodeId: s.id, depth: 60 });
    writeFileSync(join(DIR, `screen.${id}.json`), JSON.stringify(r.nodes[0]));
    console.log(`screen ${id}`);
  }
if (all || args.includes("--components"))
  for (const [set, rec] of [...Object.entries(manifest.sets), ...Object.entries(manifest.atoms ?? {}).filter(([k, v]) => v?.set && !manifest.sets[k]).map(([k, v]) => [`atom ${k}`, { id: v.set }])]) {
    if (names.length && !names.includes(set)) continue;
    const r = await mcp.call("get_design_context", { nodeId: rec.id ?? rec.section, depth: 60 });
    writeFileSync(join(DIR, `set.${set}.json`), JSON.stringify(r.nodes[0]));
    console.log(`set ${set}`);
  }
