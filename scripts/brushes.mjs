// The built-in brushes' artwork (docs/draw.md §6, round 7e): runs src/shared/draw/brushes/generate.ts (our own
// procedural recipes, fixed seeds) and writes src/shared/draw/brushes/builtin.generated.json, which is committed.
// Node strips the TS types itself (Node ≥ 22.18 / 23.6); the generator has type-only imports.
//
//   node scripts/brushes.mjs           write the JSON
//   node scripts/brushes.mjs --check   exit 1 when the committed JSON differs from the generator's output
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/shared/draw/brushes");
const { generateBrushes, brushesJson } = await import(join(dir, "generate.ts"));

// Figma's names in Figma's order (src/shared/draw/types.ts STRETCH_BRUSH_NAMES / SCATTER_BRUSH_NAMES), read from the
// source so the script needs no bundler; the unit test checks the JSON's keys against the enum itself.
const types = readFileSync(join(root, "src/shared/draw/types.ts"), "utf8");
const names = (constName) => {
  const m = types.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`));
  if (!m) throw new Error(`${constName} not found in src/shared/draw/types.ts`);
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
};

const json = brushesJson(generateBrushes(names("STRETCH_BRUSH_NAMES"), names("SCATTER_BRUSH_NAMES")));
const out = join(dir, "builtin.generated.json");
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(out, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== json) {
    console.error("builtin.generated.json is stale: run `npm run brushes`");
    process.exit(1);
  }
  console.log("builtin.generated.json is up to date");
} else {
  writeFileSync(out, json);
  console.log(`wrote ${out} (${json.length} bytes)`);
}
