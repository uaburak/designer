// Turns the decoded Figma samples (docs/research/figma/samples/*.fig.json) into
// the engine's test fixtures (engine/tests/data/figma/*.json): a NODE_CHANGES
// Message with only the fields the engine keeps, GUIDs as "s:l". Figma's own
// layout results (size / transform) are what layout.figma_golden compares with.
// Also, from the .fig files themselves: <name>.full.json, the whole Message as
// the engine reads it (every field, blobs as base64 — vector networks, Figma's
// own fillGeometry) and images/<sha1> (the image files the documents use).
//
//   node engine/tools/fixtures.mjs [--check]
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFig } from "./fig.mjs";

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
// The whole documents, straight from the .fig files.
mkdirSync(path.join(out, "images"), { recursive: true });
for (const file of readdirSync(samples).filter((f) => f.endsWith(".fig")).sort()) {
  const { message, images } = readFig(path.join(samples, file));
  const outputs = [[path.join(out, file.replace(/\.fig$/, ".full.json")), Buffer.from(`${JSON.stringify(message)}\n`)]];
  for (const [hash, data] of Object.entries(images)) outputs.push([path.join(out, "images", hash), data]);
  for (const [target, data] of outputs) {
    if (check) {
      if (!existsSync(target) || !readFileSync(target).equals(data)) {
        console.error(`stale: ${path.relative(engine, target)}`);
        stale++;
      }
    } else {
      writeFileSync(target, data);
    }
  }
  if (!check) console.log(`${file}: ${message.nodeChanges.length} nodes, ${message.blobs.length} blobs, ${Object.keys(images).length} images`);
}
if (stale) process.exit(1);
