// Figma's REST file JSON from the engine (docs/multiplayer.md §16.6), on the committed wasm and on the owner's sample
// .fig files (docs/research/figma/samples): node types and their fields as developers.figma.com's file endpoints name
// them, instance sublayers under Figma's ids, components / component sets / styles, `depth`, `ids`, `geometry=paths`,
// the nodes endpoint, and the part's wire form (no opening brace, gzipped).
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { prepareFigImport } from "../../../../../store/import/fig";
import { COMPONENTS_DOCUMENT, PAINTS_DOCUMENT, TYPES_DOCUMENT, VARIABLES_DOCUMENT } from "../../fixtures";
import { filePart, fileJson, fontWeight, nodesJson, restType } from "../fileJson";
import { renderImages, exportSettingsFor, MAX_PIXELS } from "../images";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync("src/renderer/src/engine/wasm/engine.wasm");
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const ctx = { name: "File", lastModified: Date.UTC(2026, 9, 11), version: "7" };

async function engineOf(doc: Message | string): Promise<Engine> {
  const engine = await Engine.create(null, { sessionID: 1 });
  if (typeof doc === "string") engine.loadKiwi(prepareFigImport(new Uint8Array(readFileSync(`docs/research/figma/samples/${doc}.fig`)), { name: doc, sessionID: 5 }).message);
  else engine.load(doc);
  return engine;
}

function find(n: Any, pred: (n: Any) => boolean): Any {
  if (pred(n)) return n;
  for (const c of n.children ?? []) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}
const byId = (doc: Any, id: string) => find(doc, (n) => n.id === id);
function all(n: Any, out: Any[] = []): Any[] {
  out.push(n);
  for (const c of n.children ?? []) all(c, out);
  return out;
}

/** Fields every scene node has in Figma's REST JSON (developers.figma.com "Node types": global + layer properties) */
const SCENE = ["id", "name", "type", "scrollBehavior", "blendMode", "absoluteBoundingBox", "absoluteRenderBounds", "constraints", "effects", "layoutAlign", "layoutGrow"];

describe("file JSON (GET /v1/files/:key)", () => {
  it("the top level and the document's types as Figma's: GROUP, COMPONENT, INSTANCE with Figma's sublayer ids, TEXT, VECTOR", async () => {
    const engine = await engineOf("structure");
    const j: Any = await fileJson(engine, {}, ctx);
    expect(Object.keys(j)).toEqual(["name", "lastModified", "editorType", "version", "document", "components", "componentSets", "schemaVersion", "styles"]);
    expect(j).toMatchObject({ name: "File", lastModified: "2026-10-11T00:00:00.000Z", editorType: "figma", version: "7", schemaVersion: 0 });
    expect(j.document).toMatchObject({ id: "0:0", type: "DOCUMENT", name: "Document" });
    const page = j.document.children[0];
    expect(page).toMatchObject({ id: "0:1", type: "CANVAS", name: "Page 1", prototypeStartNodeID: null, flowStartingPoints: [] });
    expect(page.backgroundColor).toHaveProperty("r");
    expect(byId(j.document, "1:53").type).toBe("GROUP");
    expect(byId(j.document, "1:37").type).toBe("COMPONENT");
    const inst = byId(j.document, "1:38");
    expect(inst).toMatchObject({ type: "INSTANCE", componentId: "1:37", absoluteBoundingBox: { x: 610, y: 131, width: 106, height: 45 } });
    expect(inst.children.map((c: Any) => c.id)).toEqual(["I1:38;1:35", "I1:38;1:42"]);
    expect(byId(j.document, "I1:38;1:42")).toMatchObject({ type: "TEXT", characters: "XYZ" });
    expect(inst.overrides).toContainEqual({ id: "I1:38;1:42", overriddenFields: ["characters"] });
    expect(j.components["1:37"]).toMatchObject({ name: "Component 1", remote: false, documentationLinks: [] });
    // Children right after the header, as Figma writes them
    expect(Object.keys(inst).slice(0, 5)).toEqual(["id", "name", "type", "scrollBehavior", "children"]);
    for (const n of all(page).slice(1)) for (const k of SCENE) expect(n, `${n.id} ${k}`).toHaveProperty(k);
    // Without geometry=paths: no outlines, no size / relativeTransform (Figma's rule)
    expect(byId(j.document, "1:26").fillGeometry).toBeUndefined();
    expect(byId(j.document, "1:26").size).toBeUndefined();
  });

  it("text: characters, the base style, run overrides, line types", async () => {
    const engine = await engineOf("structure");
    const j: Any = await fileJson(engine, {}, ctx);
    const t = byId(j.document, "1:42");
    expect(t.characters).toBe("ABC");
    expect(t.style).toMatchObject({ fontFamily: "Inter", fontStyle: "Regular", fontWeight: 400, italic: false, fontSize: 12, textAlignHorizontal: "LEFT", textAlignVertical: "TOP", letterSpacing: 0 });
    expect(["INTRINSIC_%", "PIXELS", "FONT_SIZE_%"]).toContain(t.style.lineHeightUnit);
    expect(t.style.lineHeightPx).toBeGreaterThan(0);
    expect(t).toMatchObject({ characterStyleOverrides: [], styleOverrideTable: {}, lineTypes: ["NONE"], lineIndentations: [0] });
    expect([fontWeight("Semi Bold"), fontWeight("ExtraBold Italic"), fontWeight("Light"), fontWeight("Black")]).toEqual([600, 800, 300, 900]);
  });

  it("component sets (Figma's FRAME with isStateGroup) with their property definitions, variants pointing at them", async () => {
    const engine = await engineOf("sections");
    const j: Any = await fileJson(engine, {}, ctx);
    const set = byId(j.document, "1:4");
    expect(set).toMatchObject({ type: "COMPONENT_SET", componentPropertyDefinitions: { property: { type: "VARIANT", defaultValue: "value2" } } });
    expect(set.componentPropertyDefinitions.property.variantOptions.sort()).toEqual(["value1", "value2"]);
    expect(set.strokeDashes).toEqual([10, 5]);
    expect(byId(j.document, "1:5").type).toBe("SECTION");
    expect(j.componentSets["1:4"]).toMatchObject({ name: "Component", remote: false });
    expect(j.components["1:3"]).toMatchObject({ name: "property=value2", componentSetId: "1:4" });
    // a variant has no definitions of its own
    expect(byId(j.document, "1:3").componentPropertyDefinitions).toBeUndefined();
  });

  it("auto layout: the frame's fields and its children's sizing (FIXED / HUG / FILL, absolute)", async () => {
    const engine = await engineOf(TYPES_DOCUMENT);
    const j: Any = await fileJson(engine, {}, ctx);
    const f = byId(j.document, "1:1");
    expect(f).toMatchObject({ type: "FRAME", layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO", itemSpacing: 12, paddingLeft: 16, paddingTop: 16, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG", clipsContent: true });
    expect(byId(j.document, "1:3")).toMatchObject({ layoutGrow: 1, layoutSizingHorizontal: "FILL" });
    expect(byId(j.document, "1:4")).toMatchObject({ layoutPositioning: "ABSOLUTE", constraints: { horizontal: "RIGHT", vertical: "TOP" } });
    expect(byId(j.document, "1:21").type).toBe("BOOLEAN_OPERATION");
    const wrap: Any = await fileJson(await engineOf("stacks_wrap"), {}, ctx);
    expect(byId(wrap.document, "1:2")).toMatchObject({ layoutMode: "HORIZONTAL", layoutWrap: "WRAP", counterAxisSpacing: 0 });
  });

  it("paints and effects in Figma's shapes; render bounds grow by blurs and shadows", async () => {
    const engine = await engineOf(PAINTS_DOCUMENT);
    const j: Any = await fileJson(engine, {}, ctx);
    const linear = byId(j.document, "2:2").fills[0];
    expect(linear.type).toBe("GRADIENT_LINEAR");
    expect(linear.gradientHandlePositions).toHaveLength(3);
    expect(linear.gradientStops[0]).toMatchObject({ position: 0, color: { a: 1 } });
    expect(byId(j.document, "2:10").effects[0]).toMatchObject({ type: "DROP_SHADOW", visible: true, radius: 16, offset: { x: 0, y: 8 }, spread: 0 });
    const blur = byId(j.document, "2:12");
    expect(blur.effects[0]).toMatchObject({ type: "LAYER_BLUR", radius: 8 });
    expect(blur.absoluteRenderBounds.width).toBe(blur.absoluteBoundingBox.width + 16);
    expect(byId(j.document, "2:20")).toMatchObject({ type: "STAR", pointCount: 5 });
    expect(byId(j.document, "2:22").type).toBe("LINE");
    expect(byId(j.document, "2:40").strokeDashes?.length).toBeGreaterThan(0);
  });

  it("instances: component properties by Figma's names (Name#id; variants by name), nested instances", async () => {
    const engine = await engineOf(COMPONENTS_DOCUMENT);
    const j: Any = await fileJson(engine, {}, ctx);
    const button = byId(j.document, "2:2");
    expect(button.componentId).toBe("1:1");
    const props = button.componentProperties;
    expect(Object.values(props).map((p: Any) => p.type).sort()).toEqual(["BOOLEAN", "INSTANCE_SWAP", "TEXT"]);
    expect(Object.keys(props).every((k) => /#/.test(k))).toBe(true);
    expect(byId(j.document, "I2:2;1:2")).toMatchObject({ type: "INSTANCE", componentId: "1:20" });
    expect(byId(j.document, "2:3").componentProperties).toEqual({ State: { type: "VARIANT", value: "Default" }, Size: { type: "VARIANT", value: "Small" } });
    expect(j.components["1:41"].componentSetId).toBe("1:40");
    expect(byId(j.document, "1:1").componentPropertyDefinitions).toBeDefined();
  });

  it("variables and styles: boundVariables with Figma's aliases, paints' own, the styles map", async () => {
    const engine = await engineOf(VARIABLES_DOCUMENT);
    const j: Any = await fileJson(engine, {}, ctx);
    const title = byId(j.document, "2:2");
    expect(title.boundVariables.fills[0]).toEqual({ type: "VARIABLE_ALIAS", id: "VariableID:5:22" });
    expect(title.fills[0].boundVariables).toEqual({ color: { type: "VARIABLE_ALIAS", id: "VariableID:5:22" } });
    expect(title.styles).toEqual({ text: "6:2" });
    expect(byId(j.document, "2:1").boundVariables.rectangleCornerRadii.RECTANGLE_TOP_LEFT_CORNER_RADIUS.id).toBe("VariableID:5:23");
    expect(j.styles).toMatchObject({ "6:2": { name: "Heading/H2", styleType: "TEXT", remote: false }, "6:10": { styleType: "FILL" }, "6:20": { styleType: "EFFECT" } });
  });

  it("depth: 1 is the pages, 2 adds their top-level layers", async () => {
    const engine = await engineOf("structure");
    const one: Any = await fileJson(engine, { depth: 1 }, ctx);
    expect(one.document.children[0].children).toBeUndefined();
    const two: Any = await fileJson(engine, { depth: 2 }, ctx);
    expect(two.document.children[0].children.map((c: Any) => c.id)).toEqual(["1:2", "1:4"]);
    expect(two.document.children[0].children[0].children).toBeUndefined();
  });

  it("ids: only the paths to them and their subtrees", async () => {
    const engine = await engineOf("structure");
    const j: Any = await fileJson(engine, { ids: ["1:52", "9:999"] }, ctx);
    const page = j.document.children[0];
    expect(page.children.map((c: Any) => c.id)).toEqual(["1:2"]);
    expect(page.children[0].children.map((c: Any) => c.id)).toEqual(["1:53"]);
    expect(page.children[0].children[0].children.map((c: Any) => c.id)).toEqual(["1:52"]);
    expect(byId(j.document, "1:52").children.map((c: Any) => c.id)).toEqual(["1:50", "1:51"]);
  });

  it("plugin_data: the listed plugins' pluginData and, with `shared`, every namespace's sharedPluginData", async () => {
    const engine = await engineOf("structure");
    const entries = [
      { pluginID: "1234", key: "a", value: "one" },
      { pluginID: "1234", key: "gone", value: "" },
      { pluginID: "9999", key: "b", value: "other plugin's" },
      { pluginID: "shared:tokens", key: "c", value: "shared" },
    ];
    expect(engine.setProps(["1:53"], { pluginData: entries } as Any)).toBe(0);
    expect(engine.setProps(["0:0"], { pluginData: [{ pluginID: "1234", key: "root", value: "r" }] } as Any)).toBe(0);
    const none: Any = await fileJson(engine, {}, ctx);
    expect(byId(none.document, "1:53")).not.toHaveProperty("pluginData");
    expect(none.document).not.toHaveProperty("pluginData");
    const own: Any = await fileJson(engine, { plugin_data: ["1234"] }, ctx);
    expect(byId(own.document, "1:53").pluginData).toEqual({ "1234": { a: "one" } });
    expect(byId(own.document, "1:53")).not.toHaveProperty("sharedPluginData");
    expect(own.document.pluginData).toEqual({ "1234": { root: "r" } });
    expect(byId(own.document, "1:52")).not.toHaveProperty("pluginData");
    const both: Any = await nodesJson(engine, { ids: ["1:53"], plugin_data: ["shared", "9999"] }, ctx);
    expect(both.nodes["1:53"].document).toMatchObject({ pluginData: { "9999": { b: "other plugin's" } }, sharedPluginData: { tokens: { c: "shared" } } });
  });

  it("geometry=paths: outlines in the node's space, size and relativeTransform", async () => {
    const engine = await engineOf("structure");
    const j: Any = await fileJson(engine, { geometry: "paths" }, ctx);
    const rect = byId(j.document, "I1:38;1:35");
    expect(rect.fillGeometry).toEqual([{ path: "M0 0L45 0L45 45L0 45L0 0Z", windingRule: "NONZERO" }]);
    expect(rect.strokeGeometry).toEqual([]);
    const vector = byId(j.document, "1:26");
    expect(vector.fillGeometry[0].path).toMatch(/^M6\.75 0\.922L15\.469 0/);
    expect(vector.size.x).toBeCloseTo(30.938, 4);
    expect(vector.relativeTransform).toEqual([[1, 0, 0], [0, 1, 0]]);
    // a rotated rectangle keeps its own outline (its box is the rotated bounds)
    const rotated = byId(j.document, "1:50");
    expect(rotated.fillGeometry[0].path).toBe("M0 0L100 0L100 100L0 100L0 0Z");
    expect(rotated.absoluteBoundingBox.width).toBeCloseTo(141.4214, 3);
    const round = await fileJson(await engineOf("sections"), { geometry: "paths", ids: ["1:4"] }, ctx);
    expect(byId((round as Any).document, "1:4").fillGeometry[0].path).toMatch(/^M0 5C0 2\.2386 2\.2386 0 5 0L312 0C/);
  });
});

describe("nodes JSON (GET /v1/files/:key/nodes) and the part", () => {
  it("each id's document with its maps; a missing id is null; depth counts from the node", async () => {
    const engine = await engineOf("structure");
    const j: Any = await nodesJson(engine, { ids: ["1:38", "1:4", "9:999"], depth: 1 }, ctx);
    expect(j).toMatchObject({ name: "File", editorType: "figma", err: null });
    expect(j.nodes["9:999"]).toBeNull();
    expect(j.nodes["1:38"].document).toMatchObject({ id: "1:38", type: "INSTANCE", absoluteBoundingBox: { x: 610, y: 131 } });
    expect(j.nodes["1:38"].components["1:37"]).toBeDefined();
    expect(j.nodes["1:4"].document.children.every((c: Any) => c.children === undefined)).toBe(true);
    expect(j.nodes["1:38"]).toMatchObject({ schemaVersion: 0, styles: {}, componentSets: {} });
  });

  it("the part is the answer without its opening brace, gzipped: the Worker's prefix makes it whole", async () => {
    const answer = { name: "F", document: { id: "0:0" } };
    const part = await filePart(answer);
    const text = gunzipSync(part).toString();
    expect(text.startsWith("{")).toBe(false);
    expect(JSON.parse(`{"role":"owner","thumbnailUrl":"x",${text}`)).toEqual({ role: "owner", thumbnailUrl: "x", ...answer });
  });

  it("types map as Figma's", () => {
    expect([restType({ type: "ROUNDED_RECTANGLE" }), restType({ type: "SYMBOL" }), restType({ type: "FRAME", isStateGroup: true }), restType({ type: "FRAME", resizeToFit: true }), restType({ type: "VARIABLE" })]).toEqual(["RECTANGLE", "COMPONENT", "COMPONENT_SET", "GROUP", null]);
    // Draw (docs/draw.md §7): the plugin API's names [Figma's REST names unverified]
    expect([restType({ type: "TEXT_PATH" }), restType({ type: "TRANSFORM" })]).toEqual(["TEXT_PATH", "TRANSFORM_GROUP"]);
  });
});

describe("file JSON: Figma Draw (docs/draw.md §7)", () => {
  /** The types document with a dynamic stroke, a stretch brush stroke and its BRUSH node on the internal canvas. */
  async function drawEngine(): Promise<Engine> {
    const engine = await engineOf(TYPES_DOCUMENT);
    engine.setProps(["1:2"], { strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }], strokeWeight: 4, dynamicStrokeSettings: { frequency: 3, wiggle: 2, smoothen: 0.5 } } as Any);
    engine.setProps(["1:20"], { strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }], strokeWeight: 6 } as Any);
    return engine;
  }

  it("stroke kinds: a dynamic stroke as complexStrokeProperties; a basic stroke has none", async () => {
    const engine = await drawEngine();
    const json: Any = await fileJson(engine, {}, ctx);
    const doc = json.document;
    expect(byId(doc, "1:2").complexStrokeProperties).toEqual({ type: "DYNAMIC", frequency: 3, wiggle: 2, smoothen: 0.5 });
    expect(byId(doc, "1:20").complexStrokeProperties).toBeUndefined();
    expect(byId(doc, "1:20").strokeWeight).toBe(6);
  });

  // TODO(7b): enable when round 7a / 7b's engine keeps TEXT_PATH and TRANSFORM nodes (docs/roadmap.md "Round 7").
  it.skip("a TEXT_PATH with its text and start, a TRANSFORM_GROUP with its repeats (7b)", async () => {
    const engine = await drawEngine();
    engine.applyChanges(
      {
        type: "NODE_CHANGES",
        sessionID: 1,
        nodeChanges: [
          { guid: "1:30", phase: "CREATED", type: "TRANSFORM" as never, name: "Repeat group 1", parentIndex: { guid: "0:1", position: "z" }, size: { x: 80, y: 80 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 400 }, transformModifiers: [{ type: "REPEAT", repeatType: "LINEAR", axis: "X", count: 3, unitType: "PIXELS", offset: { x: 10, y: 0 }, visible: true }] } as Any,
          { guid: "1:31", phase: "CREATED", type: "ELLIPSE", name: "Dot", parentIndex: { guid: "1:30", position: "!" }, size: { x: 20, y: 20 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } } as Any,
          { guid: "1:32", phase: "CREATED", type: "TEXT_PATH" as never, name: "Around", parentIndex: { guid: "0:1", position: "zz" }, size: { x: 100, y: 100 }, textData: { characters: "Around" }, fontSize: 12, textPathStart: { tValue: 1.5, forward: true } } as Any,
        ],
      },
      "user"
    );
    const json: Any = await fileJson(engine, {}, ctx);
    const doc = json.document;
    expect(byId(doc, "1:30")).toMatchObject({ type: "TRANSFORM_GROUP", transformModifiers: [{ type: "REPEAT", repeatType: "LINEAR", axis: "HORIZONTAL", count: 3, unitType: "PIXELS", offset: 10 }] });
    expect(byId(doc, "1:30").children.map((c: Any) => c.id)).toEqual(["1:31"]);
    expect(byId(doc, "1:32")).toMatchObject({ type: "TEXT_PATH", characters: "Around", textPathStartData: { segment: 1, position: 0.5 } });
  });
});

describe("images (GET /v1/images/:key)", () => {
  const params = { ids: ["1:26", "0:1", "9:999"], scale: 2, format: "svg" as const, svg_outline_text: true, svg_include_id: true, svg_include_node_id: false, svg_simplify_stroke: true, contents_only: true, use_absolute_bounds: false };

  it("one part per id that draws (SVG from the engine's writer); pages and missing ids have none", async () => {
    const engine = await engineOf("structure");
    const parts = await renderImages(engine, null, params);
    expect(parts.map((p) => [p.name, p.contentType])).toEqual([["1:26", "image/svg+xml"]]);
    expect(new TextDecoder().decode(parts[0].bytes)).toMatch(/<svg[^>]*viewBox="0 0 30\.938 28"/);
  });

  it("settings: Figma's defaults, vector formats at 1x, the 32-megapixel cap", () => {
    expect(exportSettingsFor({ ...params, format: "png" }, { x: 100, y: 100 })).toMatchObject({ imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 }, contentsOnly: true, svgIDMode: "ALWAYS" });
    expect(exportSettingsFor(params, { x: 100, y: 100 }).constraint?.value).toBe(1);
    const big = exportSettingsFor({ ...params, format: "jpg", scale: 4 }, { x: 8000, y: 8000 });
    expect(big.imageType).toBe("JPEG");
    expect(8000 * 8000 * big.constraint!.value ** 2).toBeLessThanOrEqual(MAX_PIXELS + 1);
  });
});
