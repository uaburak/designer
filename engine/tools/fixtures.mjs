// Turns the decoded Figma samples (docs/research/figma/samples/*.fig.json) into
// the engine's test fixtures (engine/tests/data/figma/*.json): a NODE_CHANGES
// Message with only the fields the engine keeps, GUIDs as "s:l". Figma's own
// layout results (size / transform) are what layout.figma_golden compares with.
//
//   node engine/tools/fixtures.mjs [--check]
import console from "node:console";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samples = path.resolve(engine, "../docs/research/figma/samples");
const out = path.join(engine, "tests/data/figma");
const check = process.argv.includes("--check");

const KEEP = new Set([
  "guid", "phase", "type", "name", "visible", "locked", "opacity", "transform", "size", "parentIndex",
  "fillPaints", "strokePaints", "strokeWeight", "strokeAlign", "cornerRadius", "rectangleCornerRadiiIndependent",
  "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius",
  "frameMaskDisabled", "resizeToFit", "backgroundColor", "backgroundEnabled", "internalOnly",
  "stackMode", "stackSpacing", "stackHorizontalPadding", "stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom",
  "stackPrimarySizing", "stackCounterSizing", "stackPrimaryAlignItems", "stackCounterAlignItems", "stackCounterAlignContent",
  "stackWrap", "stackCounterSpacing", "stackReverseZIndex", "bordersTakeSpace", "stackChildPrimaryGrow", "stackChildAlignSelf",
  "stackPositioning", "minSize", "maxSize", "horizontalConstraint", "verticalConstraint", "proportionsConstrained",
]);
const guid = (g) => (typeof g === "string" ? g : `${g.sessionID}:${g.localID}`);
const paints = (list) =>
  list.filter((p) => p.type === "SOLID").map((p) => ({ type: "SOLID", color: p.color, opacity: p.opacity ?? 1, visible: p.visible ?? true }));

let stale = 0;
mkdirSync(out, { recursive: true });
for (const file of readdirSync(samples).filter((f) => f.endsWith(".fig.json")).sort()) {
  const message = JSON.parse(readFileSync(path.join(samples, file), "utf8"));
  const nodeChanges = message.nodeChanges.map((n) => {
    const o = {};
    for (const [k, v] of Object.entries(n)) {
      if (!KEEP.has(k)) continue;
      if (k === "guid") o.guid = guid(v);
      else if (k === "parentIndex") o.parentIndex = { guid: guid(v.guid), position: v.position };
      else if (k === "fillPaints" || k === "strokePaints") o[k] = paints(v);
      else o[k] = v;
    }
    return o;
  });
  const text = `${JSON.stringify({ type: "NODE_CHANGES", sessionID: 0, nodeChanges }, null, 1)}\n`;
  const target = path.join(out, file.replace(/\.fig\.json$/, ".json"));
  if (check) {
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) {
      console.error(`stale: ${path.relative(engine, target)}`);
      stale++;
    }
  } else {
    writeFileSync(target, text);
    console.log(`${path.relative(engine, target)}: ${nodeChanges.length} nodes`);
  }
}
if (stale) process.exit(1);
