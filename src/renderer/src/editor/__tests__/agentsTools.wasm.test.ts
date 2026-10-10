// @vitest-environment happy-dom
// The MCP tools' fixes (r13-mcp-tools) on the real engine: GLASS and every effect / paint type round-trip, strict
// per-node results (rejected / notApplied), duplicate into a parent, reparent of fresh copies, get_metadata without a
// selection, styles, variables (a Content collection with TR / EN modes bound to texts, a copy switched to EN),
// run_command, and the panel-field walk.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { NODE_FIELDS } from "@shared/schema/document.generated";
import { MODEL } from "@shared/schema/model";
import { TOOL_BY_NAME, type ToolResult } from "@shared/agents/tools";
import { LAYER_PROP_NAMES, NAMED_PROPS, RAW_FIELDS } from "@shared/agents/layerProps";
import { toolFields } from "@shared/agents/docSchema";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { PROP_NAMES } from "../agents/nodeSpec";
import { AgentTurns } from "../agents/turns";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Tools test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, call };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
/** A result whether or not it is an error (strict refusals are errors when nothing applied). */
const any = (r: ToolResult) => JSON.parse(text(r));
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  const t = text(r);
  return t.startsWith("{") || t.startsWith("[") ? JSON.parse(t) : t;
};

describe("MCP tools: effects, paints, strictness", () => {
  it("writes GLASS with every parameter (and the Plugin API names), reads it back the same; keeps it on unrelated updates", async () => {
    const { engine, call } = await editor();
    const id = json(await call("create_nodes", { nodes: [{ type: "RECTANGLE", name: "G", effects: [{ type: "GLASS", lightAngle: 30, lightIntensity: 0.5, refraction: 0.6, depth: 40, dispersion: 0.2, splay: 10, frost: 8 }] }] })).created[0].id;
    const e = engine.readNode(id)!.effects![0];
    expect(e).toMatchObject({ type: "GLASS", specularAngle: 30, specularIntensity: 0.5, bevelSize: 40, refractionRadius: 10, radius: 8 });
    expect(e.refractionIntensity).toBeCloseTo(0.6, 5);
    expect(e.chromaticAberration).toBeCloseTo(0.2, 5);
    const ctx = json(await call("get_design_context", { nodeId: id }));
    expect(ctx.nodes[0].effects[0]).toMatchObject({ type: "GLASS", specularAngle: 30, specularIntensity: 0.5, refractionIntensity: 0.6, bevelSize: 40, chromaticAberration: 0.2, refractionRadius: 10, radius: 8 });
    // What was read is written back unchanged (one shape).
    const back = json(await call("update_nodes", { updates: [{ nodeId: id, effects: ctx.nodes[0].effects, name: "G2" }] }));
    expect(back.summary).toContain("everything applied");
    expect(engine.readNode(id)!.effects![0]).toMatchObject({ type: "GLASS", bevelSize: 40 });
    // Every type.
    const all = [
      { type: "DROP_SHADOW", color: "#00000040", offset: { x: 0, y: 2 }, radius: 6, spread: 1, showShadowBehindNode: true },
      { type: "INNER_SHADOW", color: "#FF000080", offset: { x: 1, y: 1 }, radius: 2 },
      { type: "LAYER_BLUR", radius: 5, blurOpType: "PROGRESSIVE", startRadius: 1, startOffset: { x: 0.5, y: 0 }, endOffset: { x: 0.5, y: 1 } },
      { type: "BACKGROUND_BLUR", radius: 12 },
      { type: "NOISE", noiseType: "DUOTONE", color: "#000000", secondaryColor: "#FFFFFF", density: 0.5, noiseSize: { x: 1, y: 1 } },
      { type: "TEXTURE", noiseSize: { x: 0.5, y: 0.5 }, radius: 3, clipToShape: true },
    ];
    const r = json(await call("update_nodes", { updates: [{ nodeId: id, effects: all }] }));
    expect(r.summary, JSON.stringify(r)).toContain("everything applied");
    expect(engine.readNode(id)!.effects!.map((x) => x.type)).toEqual(["DROP_SHADOW", "INNER_SHADOW", "FOREGROUND_BLUR", "BACKGROUND_BLUR", "NOISE", "GRAIN"]);
  });

  it("an unknown effect type or field is rejected with the reason — the existing effects stay", async () => {
    const { engine, call } = await editor();
    const id = json(await call("create_nodes", { nodes: [{ type: "RECTANGLE", effects: [{ type: "DROP_SHADOW" }] }] })).created[0].id;
    const res = await call("update_nodes", { updates: [{ nodeId: id, effects: [{ type: "SPARKLE" }], wobble: 3, stackSpacing: 4 }] });
    expect(res.isError).toBe(true);
    const r = any(res);
    expect(r.summary).toContain("NOT applied");
    const rejected = r.nodes[0].rejected.map((x: { property: string }) => x.property);
    expect(rejected).toEqual(expect.arrayContaining(["effects", "wobble", "stackSpacing"]));
    expect(r.nodes[0].rejected.find((x: { property: string }) => x.property === "stackSpacing").reason).toContain("itemSpacing");
    expect(engine.readNode(id)!.effects![0].type).toBe("DROP_SHADOW");
  });

  it("fills: gradients, pattern, noise round-trip", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "RECTANGLE", fills: [
      { type: "GRADIENT_LINEAR", stops: [{ color: "#FF0000", position: 0 }, { color: "#0000FF", position: 1 }] },
      { type: "GRADIENT_RADIAL", stops: [{ color: "#FFFFFF", position: 0 }, { color: "#00000000", position: 1 }], opacity: 0.5 },
      { type: "PATTERN", sourceNodeId: "1:5", scale: 0.5 },
      { type: "NOISE", noiseType: "MONOTONE", color: "#00000040", density: 0.7 },
    ] }] }));
    expect(r.summary, JSON.stringify(r)).toContain("everything applied");
    const id = r.created[0].id;
    expect(engine.readNode(id)!.fillPaints!.map((p) => p.type)).toEqual(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "PATTERN", "NOISE"]);
    const ctx = json(await call("get_design_context", { nodeId: id }));
    const again = json(await call("update_nodes", { updates: [{ nodeId: id, fills: ctx.nodes[0].fills }] }));
    expect(again.summary, JSON.stringify(again)).toContain("everything applied");
  });

  it("set_properties passes document fields straight through and reads them back", async () => {
    const { engine, call } = await editor();
    const id = json(await call("create_nodes", { nodes: [{ type: "FRAME", layoutMode: "VERTICAL" }] })).created[0].id;
    const r = json(await call("set_properties", { nodeId: id, properties: { stackSpacing: 13, effects: [{ type: "GLASS", bevelSize: 30 }], cornerSmoothing: 0.6, nope: 1 } }));
    expect(engine.readNode(id)!.stackSpacing).toBe(13);
    expect(engine.readNode(id)!.effects![0]).toMatchObject({ type: "GLASS", bevelSize: 30, specularAngle: -45 });
    expect(r.nodes[0].rejected[0].property).toBe("nope");
  });
});

describe("MCP tools: structure", () => {
  it("duplicate_nodes honours parentId and index; reparent_nodes moves fresh copies; a hugging parent's child made absolute keeps its new size", async () => {
    const { engine, call } = await editor();
    const made = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Buttons", layoutMode: "HORIZONTAL", children: [{ type: "RECTANGLE", name: "B1" }, { type: "RECTANGLE", name: "B2" }] }, { type: "FRAME", name: "Target", width: 400, height: 400 }] }));
    const [buttons, target] = made.created.map((c: { id: string }) => c.id);
    const [b1, b2] = engine.readNode(buttons, { childIds: true })!.childIds!;
    const d = json(await call("duplicate_nodes", { nodeIds: [b1, b2], parentId: target, index: 0 }));
    expect(d.copies.map((c: { parentId: string }) => c.parentId)).toEqual([target, target]);
    expect(engine.readNode(target, { childIds: true })!.childIds).toEqual(d.copies.map((c: { id: string }) => c.id));
    const copy = d.copies[0].id;
    json(await call("reparent_nodes", { nodeIds: [copy], parentId: buttons }));
    expect(engine.readNode(copy)!.parentIndex!.guid).toBe(buttons);
    const into = await call("reparent_nodes", { nodeIds: [buttons], parentId: copy });
    expect(into.isError).toBe(true);
    const u = json(await call("update_nodes", { updates: [{ nodeId: copy, width: 222, layoutPositioning: "ABSOLUTE" }] }));
    expect(u.summary, JSON.stringify(u)).toContain("everything applied");
    expect(engine.readNode(copy)!.size!.x).toBe(222);
    expect(u.nodes[0].values).toMatchObject({ width: 222, layoutPositioning: "ABSOLUTE" });
  });

  it("update_nodes reports what didn't take: a width on a hugging frame", async () => {
    const { call } = await editor();
    const id = json(await call("create_nodes", { nodes: [{ type: "FRAME", layoutMode: "HORIZONTAL", children: [{ type: "RECTANGLE" }] }] })).created[0].id;
    const r = any(await call("update_nodes", { updates: [{ nodeId: id, width: 300, characters: "x" }] }));
    expect(r.summary).toContain("NOT applied");
    expect(r.nodes[0].rejected[0]).toMatchObject({ property: "characters", reason: "only for TEXT layers" });
    expect(r.nodes[0].notApplied[0]).toMatchObject({ property: "width", requested: 300, actual: 100 });
    expect(r.nodes[0].notApplied[0].reason).toContain("hugging");
  });

  it("get_metadata without a selection lists the pages and the current page's top-level layers", async () => {
    const { ed, call } = await editor();
    ed.engine.setSelection([]);
    const xml = json(await call("get_metadata", { depth: 1 })) as string;
    expect(xml).toContain('<page-ref id="0:1" name="Page 1" current="true"');
    expect(xml).toMatch(/<page id="0:1"[^>]*>\n\s+<frame id="1:1"/);
  });

  it("run_command runs editor and engine commands (a page, a component)", async () => {
    const { engine, call } = await editor();
    const before = engine.pages().length;
    json(await call("run_command", { engineCommand: "CREATE_PAGE" }));
    expect(engine.pages().length).toBe(before + 1);
    const list = json(await call("list_commands", { query: "component" }));
    expect(list.engineCommands.some((c: { name: string }) => c.name === "CREATE_COMPONENT")).toBe(true);
    const page = engine.pages()[0].guid;
    json(await call("set_current_page", { pageId: page }));
    const r = json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: ["1:5"] }));
    expect(r.ran).toBe("CREATE_COMPONENT");
  });
});

describe("MCP tools: variables and styles", () => {
  it("a Content collection with TR / EN modes bound to texts; a duplicate set to EN shows the English", async () => {
    const { engine, call } = await editor();
    const frame = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Portfolio", layoutMode: "VERTICAL", children: [{ type: "TEXT", name: "Title", characters: "Merhaba" }, { type: "TEXT", name: "Body", characters: "Tasarımcıyım" }] }] })).created[0].id;
    const [title, body] = engine.readNode(frame, { childIds: true })!.childIds!;
    const c = json(await call("create_variable_collection", { name: "Content", modes: ["TR", "EN"] })).collection;
    expect(c.modes.map((m: { name: string }) => m.name)).toEqual(["TR", "EN"]);
    const vt = json(await call("create_variable", { collectionId: "Content", name: "title", type: "STRING", values: { TR: "Merhaba", EN: "Hello" } })).variable;
    const vb = json(await call("create_variable", { collectionId: c.id, name: "body", type: "STRING", values: { TR: "Tasarımcıyım", EN: "I am a designer" } })).variable;
    expect(vt.values).toEqual({ TR: "Merhaba", EN: "Hello" });
    json(await call("bind_variable", { nodeId: title, field: "characters", variableId: vt.id }));
    json(await call("bind_variable", { nodeId: body, field: "characters", variableId: vb.id }));
    const copy = json(await call("duplicate_nodes", { nodeIds: [frame] })).copies[0].id;
    json(await call("set_variable_mode", { nodeId: copy, collectionId: "Content", mode: "EN" }));
    const kids = engine.readNode(copy, { childIds: true })!.childIds!.map((k) => engine.readNode(k)!.textData?.characters);
    expect(kids).toEqual(["Hello", "I am a designer"]);
    expect(engine.readNode(title)!.textData?.characters).toBe("Merhaba");
    json(await call("set_variable_value", { variableId: vt.id, values: { EN: "Hi" } }));
    expect(engine.readNode(engine.readNode(copy, { childIds: true })!.childIds![0])!.textData?.characters).toBe("Hi");
    const color = json(await call("create_variable", { collectionId: c.id, name: "brand", type: "COLOR", value: "#0D99FF" })).variable;
    json(await call("bind_variable", { nodeId: frame, field: "fills[0]", variableId: color.id }));
    expect(engine.readNode(frame)!.fillPaints![0].color!.r).toBeCloseTo(13 / 255, 3);
  });

  it("creates paint, text, effect and grid styles and applies them", async () => {
    const { engine, call } = await editor();
    const s1 = json(await call("create_effect_style", { name: "Glass", effects: [{ type: "GLASS", depth: 50 }], applyTo: ["1:5"] }));
    expect(engine.readNode("1:5")!.effects![0]).toMatchObject({ type: "GLASS", bevelSize: 50 });
    const s2 = json(await call("create_paint_style", { name: "Brand", fills: "#0D99FF" }));
    json(await call("apply_style", { nodeIds: ["1:6"], slot: "fill", styleId: s2.style.id }));
    expect(engine.readNode("1:6")!.fillPaints![0].color).toMatchObject({ b: 1 });
    const s3 = json(await call("create_text_style", { name: "H1", fontSize: 40, fontStyle: "Bold" }));
    const s4 = json(await call("create_grid_style", { name: "12 col", layoutGrids: [{ pattern: "STRIPES", numSections: 12 }] }));
    const ids = engine.styles(undefined, {}).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([s1.style.id, s2.style.id, s3.style.id, s4.style.id]));
  });
});

describe("MCP tools: one schema", () => {
  it("tools/list and the implementation name the same layer properties", () => {
    // `image` (a picture by path or bytes, imported before the write) is the tools' own, not a document field.
    const schema = (TOOL_BY_NAME.get("update_nodes")!.inputSchema as { properties: { updates: { items: { properties: Record<string, unknown> } } } }).properties.updates.items.properties;
    expect(new Set(Object.keys(schema))).toEqual(new Set(["nodeId", "image", ...LAYER_PROP_NAMES]));
    expect(new Set(PROP_NAMES)).toEqual(new Set(LAYER_PROP_NAMES));
  });

  it("every live Effect and Paint field of the schema is in the tools' effect / paint shape", () => {
    const effect = (TOOL_BY_NAME.get("update_nodes")!.inputSchema as never as { properties: { updates: { items: { properties: { effects: { items: { properties: Record<string, unknown> } } } } } } }).properties.updates.items.properties.effects.items.properties;
    for (const f of toolFields("Effect")) expect(effect, f.name).toHaveProperty(f.name);
    for (const def of ["Effect", "Paint"]) for (const f of MODEL.def(def).fields) if (!f.name.endsWith("Var") && !["imageThumbnail", "thumbHash"].includes(f.name)) expect(toolFields(def).some((t) => t.field.name === f.name), `${def}.${f.name}`).toBe(true);
  });

  it("walks the fields the Design panel edits: each is a tool property (or a named exception), and round-trips on the engine", async () => {
    const dir = join(process.cwd(), "src/renderer/src/editor/panels/design/");
    const src = readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(dir + f, "utf8")).join("\n");
    const panel = NODE_FIELDS.map((f) => f.name).filter((n) => new RegExp(`\\b${n}\\b`).test(src));
    // Not layer properties: identity and structure, versions, keys, styles' references (apply_style), component definitions (run_command).
    const NOT_PROPS = new Set(["guid", "parentIndex", "type", "version", "key", "styleIdForFill", "styleIdForStrokeFill", "componentPropDefs", "count"]);
    const covered = new Set<string>([...RAW_FIELDS, ...Object.values(NAMED_PROPS).flatMap((p) => p.fields)]);
    const missing = panel.filter((f) => !NOT_PROPS.has(f) && !covered.has(f));
    expect(missing).toEqual([]);
    // Round trip of a sample value for each named property on a layer it applies to.
    const { call } = await editor();
    const made = json(await call("create_nodes", { nodes: [
      { type: "FRAME", name: "AL", layoutMode: "HORIZONTAL", width: 300, height: 200, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", children: [{ type: "RECTANGLE", name: "R" }, { type: "TEXT", name: "T", characters: "Hi" }] },
      { type: "STAR", name: "S" },
    ] }));
    const al = made.created[0].id;
    const ctx = json(await call("get_design_context", { nodeId: al, depth: 1 }));
    const [rect, txt] = ctx.nodes[0].children.map((c: { id: string }) => c.id);
    const star = made.created[1].id;
    const samples: [string, string, unknown][] = [
      [al, "opacity", 0.5], [al, "blendMode", "MULTIPLY"], [al, "locked", true], [al, "itemSpacing", 12], [al, "padding", [1, 2, 3, 4]], [al, "primaryAxisAlignItems", "CENTER"],
      [al, "counterAxisAlignItems", "MAX"], [al, "layoutWrap", "WRAP"], [al, "counterAxisSpacing", 6], [al, "counterAxisAlignContent", "SPACE_BETWEEN"], [al, "itemReverseZIndex", true], [al, "strokesIncludedInLayout", true],
      [al, "clipsContent", false], [al, "strokes", "#FF0000"], [al, "strokeWeight", 3], [al, "strokeAlign", "OUTSIDE"], [al, "strokeTopWeight", 5], [al, "cornerRadius", [1, 2, 3, 4]], [al, "cornerSmoothing", 0.6], [al, "invertedCorners", 5],
      [al, "layoutGrids", [{ pattern: "GRID", sectionSize: 8 }]], [al, "dashPattern", [4, 2]], [al, "exportSettings", [{ imageType: "PNG", suffix: "@2x" }]],
      [rect, "layoutSizingHorizontal", "FILL"], [rect, "layoutSizingVertical", "FILL"], [rect, "minWidth", 20], [rect, "maxWidth", 200], [rect, "isMask", true],
      [txt, "fontSize", 22], [txt, "lineHeight", "150%"], [txt, "letterSpacing", "2%"], [txt, "textAlignHorizontal", "CENTER"], [txt, "textCase", "UPPER"], [txt, "textDecoration", "UNDERLINE"],
      [txt, "paragraphSpacing", 8], [txt, "textAutoResize", "HEIGHT"], [txt, "textAlignVertical", "BOTTOM"],
      [star, "pointCount", 7], [star, "innerRadius", 0.5], [star, "rotation", 30], [star, "constraints", { horizontal: "STRETCH", vertical: "CENTER" }], [star, "constrainProportions", true],
    ];
    const failures: string[] = [];
    for (const [id, prop, value] of samples) {
      const r = json(await call("update_nodes", { updates: [{ nodeId: id, [prop]: value }] }));
      if (!r.summary.includes("everything applied")) failures.push(`${prop}: ${JSON.stringify(r.nodes[0])}`);
    }
    expect(failures).toEqual([]);
  });
});
