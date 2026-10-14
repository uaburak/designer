#!/usr/bin/env node
// Reads the "Wecra UI" file back through the MCP server: every variable's values (mapped to the CSS token it stands
// for), and each component's (and with --screens each screen's) design as get_design_context gives it. Writes
// tools/ui-kit/readback/latest.json; the first run (or --baseline) also saves baseline.json. With --diff it prints
// what changed since the baseline — the owner's edits on the canvas as token / component / layer changes.
//
//   node tools/ui-kit/readback.mjs [--baseline] [--screens] [--diff]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp.mjs";
import { TOKENS, variableName } from "./convert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "readback");
const args = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
mkdirSync(DIR, { recursive: true });

const mcp = await connect();
const sel = await mcp.call("get_selection");
if (sel.file !== manifest.file) throw new Error(`Bound to "${sel.file}": bring "${manifest.file}" to the front in Wecra and run again.`);

const cssOf = new Map(TOKENS.map((t) => [variableName(t), `var(${t.css})`]));
const sizeCss = (name) => {
  const [kind, key] = name.split("/");
  return `var(--ds-${kind}-${key})`;
};

/** Drops what changes without an edit (ids, the CSS hint), keeps names, so diffs read as design changes. */
const strip = (n) => {
  if (Array.isArray(n)) return n.map(strip);
  if (!n || typeof n !== "object") return n;
  const out = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === "css" || k === "id" || k === "arcData" || k === "booleanOperation" || k === "backgroundColor") continue;
    out[k] = strip(v);
  }
  return out;
};

const data = { file: manifest.file, at: new Date().toISOString(), tokens: {}, components: {}, screens: {} };
const defs = await mcp.call("get_variable_defs", { all: true });
for (const col of defs.collections ?? []) {
  for (const v of col.variables ?? []) {
    const css = col.name === "Wecra colors" ? cssOf.get(v.name) : col.name === "Wecra sizes" ? sizeCss(v.name) : null;
    data.tokens[css ?? `${col.name}/${v.name}`] = { variable: `${col.name}/${v.name}`, ...v.values };
  }
}
for (const rec of Object.values(manifest.components)) {
  const r = await mcp.call("get_design_context", { nodeId: rec.id, depth: 12 }, { soft: true });
  const node = r?.nodes?.[0];
  if (!node) continue;
  data.components[`${rec.set} / ${rec.name}`] = strip(node);
}
if (args.includes("--screens")) {
  for (const [id, s] of Object.entries(manifest.screens)) {
    const r = await mcp.call("get_design_context", { nodeId: s.id, depth: 30 }, { soft: true });
    if (r?.nodes?.[0]) data.screens[id] = strip(r.nodes[0]);
  }
}
writeFileSync(join(DIR, "latest.json"), JSON.stringify(data, null, 1));
if (args.includes("--baseline") || !existsSync(join(DIR, "baseline.json"))) {
  writeFileSync(join(DIR, "baseline.json"), JSON.stringify(data, null, 1));
  console.log("baseline saved");
}
console.log(`tokens ${Object.keys(data.tokens).length}, components ${Object.keys(data.components).length}, screens ${Object.keys(data.screens).length} → tools/ui-kit/readback/latest.json`);

if (args.includes("--diff")) {
  const base = JSON.parse(readFileSync(join(DIR, "baseline.json"), "utf8"));
  const changes = [];
  const diff = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => x && typeof x === "object")) {
      a.forEach((x, i) => diff(x, b[i], `${path}[${b[i]?.name ?? i}]`));
      return;
    }
    changes.push({ path, before: a, after: b });
  };
  diff(base.tokens, data.tokens, "tokens");
  diff(base.components, data.components, "components");
  diff(base.screens, data.screens, "screens");
  writeFileSync(join(DIR, "changes.json"), JSON.stringify(changes, null, 1));
  for (const c of changes.slice(0, 200)) console.log(`${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  console.log(`${changes.length} changes → tools/ui-kit/readback/changes.json`);
}
