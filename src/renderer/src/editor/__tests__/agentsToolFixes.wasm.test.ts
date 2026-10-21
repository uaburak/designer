// @vitest-environment happy-dom
// The designer MCP tools' fixes after a 10-screen prototype build (2026-10-20): texts in a missing font measured with
// the fallback they draw with (instance overrides too), creation order and constraints, hug after a stretched text,
// svg at any depth, reorder in the same parent, instances inserted into a frame, fresh reaction ids on duplicates,
// component sets read as COMPONENT_SET, BIND_COMPONENT_PROPERTY's Plugin API fields.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { FigCodecs } from "@shared/fig/compression";
import { decodeCanvas } from "@shared/fig/container";
import { encodeFigmaCanvas } from "@shared/fig/figmaExport";
import { decodeAnySchema } from "@shared/fig/importFig";
import { decodeMessage } from "@shared/schema/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { ToolResult } from "@shared/agents/tools";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const inter = join(process.cwd(), "src/renderer/src/engine/fonts/Inter-3.19.ttf");
const codecs: FigCodecs = {
  inflateRaw: (b) => new Uint8Array(inflateRawSync(b)),
  deflateRaw: (b) => new Uint8Array(deflateRawSync(b)),
  zstdDecompress: (b) => new Uint8Array(zstdDecompressSync(b)),
  zstdCompress: (b) => new Uint8Array(zstdCompressSync(b)),
};

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  // Inter is there; "Proxima Nova" isn't (the owner's file's text styles).
  fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => new Uint8Array(readFileSync(inter)) });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Tool fixes" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  const settle = async () => {
    await fonts.settled();
    engine.pump();
  };
  // The fonts asked for once (Inter arrives, Proxima Nova turns out missing), as in an open file.
  const warm = json(await call("create_nodes", { nodes: [{ type: "TEXT", characters: "Aa", x: -5000, y: -5000 }, { type: "TEXT", characters: "Aa", fontFamily: "Proxima Nova", fontStyle: "Semibold", x: -5000, y: -4000 }] }));
  await settle();
  json(await call("delete_nodes", { nodeIds: warm.created.map((c: { id: string }) => c.id) }));
  return { ed, engine, call, settle };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  const t = text(r);
  return t.startsWith("{") || t.startsWith("[") ? JSON.parse(t) : t;
};
const ids = (r: { created: { id: string }[] }) => r.created.map((c) => c.id);
const kids = (engine: Engine, id: string) => engine.readNode(id, { childIds: true })!.childIds ?? [];

describe("missing fonts: texts are measured with the fallback they draw with", () => {
  it("a Label text property on a hug instance (and characters on the instance's text) grow the instance", async () => {
    const { engine, call } = await editor();
    const made = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Button", x: 0, y: 0, layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG", paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, children: [{ type: "TEXT", name: "Label", characters: "Next", fontSize: 14, fontFamily: "Proxima Nova", fontStyle: "Semibold" }] }] }));
    const frame = ids(made)[0];
    const label = kids(engine, frame)[0];
    expect(engine.textLayout(label)!.missingFont).toBe(true);
    json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [frame] }));
    json(await call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: frame, name: "Label", type: "TEXT", defaultValue: "Next" } }));
    json(await call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [label], field: "characters", prop: "Label" } }));
    const inst = json(await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: frame, x: 400, y: 400 } })).created[0] as string;
    const before = engine.readNode(inst)!.size!.x;
    json(await call("update_nodes", { updates: [{ nodeId: inst, componentProperties: { Label: "Smart animate → B" } }] }));
    const row = kids(engine, inst)[0];
    const w = engine.readNode(row)!.size!.x;
    expect(w).toBeGreaterThan(80);
    expect(engine.readNode(row)!.size!.x).toBeCloseTo(engine.textLayout(row)!.layoutSize.x, 0);
    expect(engine.readNode(inst)!.size!.x).toBeCloseTo(w + 24, 0);
    expect(engine.readNode(inst)!.size!.x).toBeGreaterThan(before);
    // Characters straight on the instance's text: an override, measured the same way.
    json(await call("update_nodes", { updates: [{ nodeId: row, characters: "Smart animate → B, slowly" }] }));
    const w2 = engine.readNode(row)!.size!.x;
    expect(w2).toBeGreaterThan(w);
    expect(engine.readNode(inst)!.size!.x).toBeCloseTo(w2 + 24, 0);
  });
});

describe("create_nodes: order, constraints, layout", () => {
  it("a Center/Center child keeps the x / y it was given inside a parent sized in the same call", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Stage", x: 0, y: 0, width: 1312, height: 640, children: [{ type: "RECTANGLE", name: "Dot", x: 596, y: 460, width: 100, height: 100, constraints: { horizontal: "CENTER", vertical: "CENTER" } }] }] }));
    const stage = engine.readNode(ids(r)[0])!;
    expect(stage.size).toEqual({ x: 1312, y: 640 });
    const dot = engine.readNode(kids(engine, stage.guid)[0])!;
    expect([dot.transform?.m02, dot.transform?.m12]).toEqual([596, 460]);
    expect(dot.size).toEqual({ x: 100, y: 100 });
  });

  it("an auto-layout parent hugs a stretched HEIGHT text once its width is known — nested, in a missing font too", async () => {
    const { engine, call } = await editor();
    const body = "Short body text that wraps over a couple of lines when the card is narrow enough to make it wrap.";
    for (const font of [{}, { fontFamily: "Proxima Nova", fontStyle: "Semibold" }]) {
      const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Accordion", width: 400, layoutMode: "VERTICAL", layoutSizingVertical: "HUG", itemSpacing: 8, children: [
        { type: "FRAME", name: "Header", layoutMode: "HORIZONTAL", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", children: [{ type: "TEXT", characters: "Title", fontSize: 16, ...font }] },
        { type: "FRAME", name: "Body", layoutMode: "VERTICAL", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, children: [{ type: "TEXT", characters: body, fontSize: 14, textAutoResize: "HEIGHT", layoutSizingHorizontal: "FILL", ...font }] },
      ] }] }));
      const acc = ids(r)[0];
      const [header, bodyFrame] = kids(engine, acc);
      const t = engine.readNode(kids(engine, bodyFrame)[0])!;
      expect(t.size!.x).toBe(376);
      // Two lines at 14 px, not one character a line.
      expect(t.size!.y).toBeGreaterThan(30);
      expect(t.size!.y).toBeLessThan(60);
      expect(t.size!.y).toBeCloseTo(engine.textLayout(t.guid)!.layoutSize.y, 0);
      expect(engine.readNode(bodyFrame)!.size!.y).toBeCloseTo(t.size!.y + 8, 0);
      expect(engine.readNode(acc)!.size!.y).toBeCloseTo(engine.readNode(header)!.size!.y + 8 + t.size!.y + 8, 0);
    }
  });
});

describe("create_nodes: svg", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h4v4H4z" fill="#000"/></svg>';
  it("makes a frame the SVG's size holding its vectors, at its x / y — at the top level and nested", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", svg, name: "Icon", x: 120, y: 80 }, { type: "FRAME", name: "Row", x: 0, y: 300, width: 200, height: 40, children: [{ type: "RECTANGLE", name: "Before" }, { type: "FRAME", svg, name: "Glyph", x: 10, y: 8 }, { type: "RECTANGLE", name: "After" }] }] }));
    expect(r.created.map((c: { name: string }) => c.name)).toEqual(["Icon", "Row"]);
    const icon = engine.readNode(ids(r)[0])!;
    expect(icon.type).toBe("FRAME");
    expect(icon.size).toEqual({ x: 24, y: 24 });
    expect([icon.transform!.m02, icon.transform!.m12]).toEqual([120, 80]);
    const vec = engine.readNode(kids(engine, icon.guid)[0])!;
    expect(vec.type).toBe("VECTOR");
    expect([vec.transform!.m02, vec.transform!.m12]).toEqual([4, 4]);
    const row = kids(engine, ids(r)[1]).map((id) => engine.readNode(id)!);
    expect(row.map((n) => n.name)).toEqual(["Before", "Glyph", "After"]);
    expect(row[1].type).toBe("FRAME");
    expect([row[1].transform!.m02, row[1].transform!.m12]).toEqual([10, 8]);
    expect(kids(engine, row[1].guid).map((id) => engine.readNode(id)!.type)).toEqual(["VECTOR"]);
  });
});

describe("reparent_nodes, INSERT_INSTANCE, duplicate_nodes", () => {
  it("reparent_nodes to the same parent with an index reorders (Figma's insertChild: the index after removal)", async () => {
    const { engine, call } = await editor();
    // On the page (its top-level frames) too.
    const page = engine.getSelection().pageId;
    const top = json(await call("create_nodes", { nodes: ["P1", "P2", "P3", "P4"].map((name) => ({ type: "FRAME", name, width: 50, height: 50 })) }));
    const onPage = () => kids(engine, page).map((id) => engine.readNode(id)!.name);
    const p4 = ids(top)[3];
    const at = onPage().indexOf("P1");
    json(await call("reparent_nodes", { nodeIds: [p4], parentId: page, index: at }));
    expect(onPage().slice(at, at + 4)).toEqual(["P4", "P1", "P2", "P3"]);
    for (const layout of [{}, { layoutMode: "VERTICAL", itemSpacing: 4 }]) {
      const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "List", width: 300, height: 300, ...layout, children: ["A", "B", "C", "D"].map((name) => ({ type: "RECTANGLE", name, width: 40, height: 20 })) }] }));
      const list = ids(r)[0];
      const names = () => kids(engine, list).map((id) => engine.readNode(id)!.name);
      const byName = (n: string) => kids(engine, list).find((id) => engine.readNode(id)!.name === n)!;
      const moved = json(await call("reparent_nodes", { nodeIds: [byName("D")], parentId: list, index: 0 }));
      expect(moved.moved[0].index).toBe(0);
      expect(names()).toEqual(["D", "A", "B", "C"]);
      json(await call("reparent_nodes", { nodeIds: [byName("D")], parentId: list, index: 2 }));
      expect(names()).toEqual(["A", "B", "D", "C"]);
      json(await call("reparent_nodes", { nodeIds: [byName("A")], parentId: list, index: 3 }));
      expect(names()).toEqual(["B", "D", "C", "A"]);
      json(await call("reparent_nodes", { nodeIds: [byName("C"), byName("A")], parentId: list, index: 0 }));
      expect(names()).toEqual(["C", "A", "B", "D"]);
      // Every layer to every index: the list with it taken out, it put back at the index.
      for (const who of ["A", "B", "C", "D"])
        for (const index of [0, 1, 2, 3, 4, 99]) {
          // (Past the end — children.length, as Figma's insertChild takes it — is the end.)
          const expected = names().filter((n) => n !== who);
          expected.splice(Math.min(index, 3), 0, who);
          json(await call("reparent_nodes", { nodeIds: [byName(who)], parentId: list, index }));
          expect(names(), `${who} → ${index}`).toEqual(expected);
        }
    }
  });

  it("INSERT_INSTANCE into a frame without auto layout and without x / y lands at the frame's origin", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Chip", width: 80, height: 32 }, { type: "FRAME", name: "Screen", x: 3000, y: 2000, width: 390, height: 844 }] }));
    const [chip, screen] = ids(r);
    json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [chip] }));
    const inst = json(await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: chip, parent: screen } })).created[0] as string;
    const n = engine.readNode(inst)!;
    expect(n.parentIndex!.guid).toBe(screen);
    expect([n.transform!.m02, n.transform!.m12]).toEqual([0, 0]);
  });

  it("duplicate_nodes gives the copies' reactions fresh ids", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "A", width: 100, height: 100 }, { type: "FRAME", name: "B", width: 100, height: 100 }] }));
    const [a, b] = ids(r);
    json(await call("add_interaction", { nodeId: a, trigger: { type: "ON_CLICK" }, actions: [{ type: "NAVIGATE", destinationId: b }] }));
    const idOf = (node: string) => JSON.stringify((engine.readNode(node) as { prototypeInteractions?: { id?: unknown }[] }).prototypeInteractions![0].id);
    const copy = json(await call("duplicate_nodes", { nodeIds: [a] })).copies[0].id as string;
    expect(idOf(copy)).not.toBe("undefined");
    expect(idOf(copy)).not.toBe(idOf(a));
    const proto = json(await call("get_prototype", {}));
    const reactionIds = JSON.stringify(proto).match(/"id":"[^"]+"/g) ?? [];
    expect(new Set(reactionIds).size).toBe(reactionIds.length);
  });
});

describe("component sets and component properties", () => {
  async function variants(call: (n: string, a: Record<string, unknown>) => Promise<ToolResult>, names: string[]) {
    const r = json(await call("create_nodes", { nodes: names.map((name, i) => ({ type: "FRAME", name, x: i * 120, y: 2000, width: 100, height: 40 })) }));
    for (const id of ids(r)) json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [id] }));
    return json(await call("run_command", { engineCommand: "COMBINE_AS_VARIANTS", nodeIds: ids(r) }));
  }

  it("COMBINE_AS_VARIANTS, get_metadata and get_design_context read COMPONENT_SET with its property definitions", async () => {
    const { call } = await editor();
    const r = await variants(call, ["State=Closed", "State=Open"]);
    expect(r.selection[0].type).toBe("COMPONENT_SET");
    const set = r.selection[0].id as string;
    expect(await call("get_metadata", { nodeId: set }).then(text)).toContain("<component-set ");
    const ctx = json(await call("get_design_context", { nodeId: set }));
    expect(ctx.nodes[0].type).toBe("COMPONENT_SET");
    expect(ctx.nodes[0].componentPropertyDefinitions).toEqual({ State: { type: "VARIANT", defaultValue: "Closed", variantOptions: ["Closed", "Open"] } });
    expect(ctx.nodes[0].variantGroupProperties).toEqual({ State: { values: ["Closed", "Open"] } });
    expect(ctx.nodes[0].children.map((c: { type: string }) => c.type)).toEqual(["COMPONENT", "COMPONENT"]);
  });

  it("a new set is named after the components' shared base name, else Component N continuing through the file", async () => {
    const { call } = await editor();
    const a = await variants(call, ["Accordion/State=Closed", "Accordion/State=Open"]);
    expect(a.selection[0].name).toBe("Accordion");
    const ctx = json(await call("get_design_context", { nodeId: a.selection[0].id }));
    expect(Object.keys(ctx.nodes[0].componentPropertyDefinitions)).toEqual(["State"]);
    const b = await variants(call, ["Size=S", "Size=L"]);
    const c = await variants(call, ["Tone=Light", "Tone=Dark"]);
    const nb = Number(/^Component (\d+)$/.exec(b.selection[0].name)?.[1]);
    expect(nb).toBeGreaterThan(0);
    expect(c.selection[0].name).toBe(`Component ${nb + 1}`);
    // Renamed, the numbering still continues.
    json(await call("update_nodes", { updates: [{ nodeId: b.selection[0].id, name: "Size" }, { nodeId: c.selection[0].id, name: "Tone" }] }));
    const d = await variants(call, ["Kind=A", "Kind=B"]);
    expect(d.selection[0].name).toBe(`Component ${nb + 2}`);
  });

  it("BIND_COMPONENT_PROPERTY takes Figma's componentPropertyReferences keys and the enum names; others are refused by name", async () => {
    const { engine, call } = await editor();
    const made = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Tag", width: 100, height: 40, children: [{ type: "TEXT", name: "Label", characters: "Tag" }, { type: "RECTANGLE", name: "Dot" }] }] }));
    const tag = ids(made)[0];
    const [label, dot] = kids(engine, tag);
    json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [tag] }));
    json(await call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: tag, name: "Text", type: "TEXT", defaultValue: "Tag" } }));
    json(await call("run_command", { engineCommand: "ADD_COMPONENT_PROPERTY", args: { ref: tag, name: "Show dot", type: "BOOLEAN", defaultValue: true } }));
    json(await call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [label], field: "characters", prop: "Text" } }));
    json(await call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [dot], field: "visible", prop: "Show dot" } }));
    json(await call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [dot], field: "VISIBLE", prop: "Show dot" } }));
    const info = engine.componentInfo(tag)!;
    expect(info.properties.find((p) => p.name === "Text")!.boundLayers).toEqual([label]);
    expect(info.properties.find((p) => p.name === "Show dot")!.boundLayers).toEqual([dot]);
    const bad = await call("run_command", { engineCommand: "BIND_COMPONENT_PROPERTY", args: { refs: [dot], field: "fills", prop: "Show dot" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("characters");
    expect(text(bad)).toContain("mainComponent");
    const listed = json(await call("list_commands", { query: "BIND_COMPONENT" }));
    expect(listed.engineCommands[0].args).toContain("characters");
  });
});

// The demo-page build on prototype-web (2026-10-21): an instance's Text input / Cursor overrides, CREATE_PAGE's id,
// duplicate_nodes with an id listed twice.
describe("instance overrides of the website behaviours, CREATE_PAGE, duplicates", () => {
  it("prototypeTextInput and prototypeCursor on a text inside an instance are its overrides: read back, per instance, never in a .fig", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Input", width: 200, height: 40, children: [{ type: "TEXT", name: "Value", characters: "Value" }] }, { type: "FRAME", name: "Screen", x: 3000, y: 0, width: 600, height: 400 }] }));
    const [input, screen] = ids(r);
    const value = kids(engine, input)[0];
    json(await call("set_properties", { nodeId: value, properties: { prototypeTextInput: { type: "TEXT" } } }));
    json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [input] }));
    const insert = async () => json(await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main: input, parent: screen } })).created[0] as string;
    const [a, b] = [await insert(), await insert()];
    const [va, vb] = [kids(engine, a)[0], kids(engine, b)[0]];
    expect(va.startsWith("I")).toBe(true);
    const set = json(await call("set_properties", { nodeId: va, properties: { prototypeTextInput: { type: "EMAIL" }, prototypeCursor: "CROSSHAIR" } }));
    expect(set.summary).toBe("set_properties: everything applied.");
    const read = (id: string) => engine.readNode(id) as { prototypeTextInput?: { type?: string }; prototypeCursor?: string };
    expect(read(va).prototypeTextInput?.type).toBe("EMAIL");
    expect(read(va).prototypeCursor).toBe("CROSSHAIR");
    expect(read(vb).prototypeTextInput?.type).toBe("TEXT");
    expect(read(vb).prototypeCursor).toBeUndefined();
    expect(read(value).prototypeTextInput?.type).toBe("TEXT");
    // Stored as an override entry on A (Figma's symbolOverrides), not on the main.
    const overrides = (engine.readNode(a) as { symbolData?: { symbolOverrides?: Record<string, unknown>[] } }).symbolData?.symbolOverrides ?? [];
    expect(overrides.some((o) => (o.prototypeTextInput as { type?: string } | undefined)?.type === "EMAIL" && o.prototypeCursor === "CROSSHAIR")).toBe(true);
    // get_design_context reads it back on the instance's layer.
    const ctx = json(await call("get_design_context", { nodeId: a }));
    const child = (ctx.nodes[0].children as Record<string, unknown>[])[0];
    expect(child.prototypeTextInput).toEqual({ type: "EMAIL" });
    expect(child.prototypeCursor).toBe("CROSSHAIR");
    // Save local copy: the .fig carries neither the fields nor their override entry.
    const canvas = decodeCanvas(encodeFigmaCanvas(decodeMessage(engine.encodeDocumentKiwi()), codecs), codecs);
    const { message } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    expect(JSON.stringify(message)).not.toContain("prototypeTextInput");
    expect(JSON.stringify(message)).not.toContain("prototypeCursor");
  });

  it("run_command CREATE_PAGE and DUPLICATE_PAGE return the new page's id in created", async () => {
    const { engine, call } = await editor();
    const r = json(await call("run_command", { engineCommand: "CREATE_PAGE" }));
    expect(r.created).toHaveLength(1);
    expect(engine.pages().at(-1)!.guid).toBe(r.created[0]);
    expect(engine.readNode(r.created[0])!.type).toBe("CANVAS");
    const d = json(await call("run_command", { engineCommand: "DUPLICATE_PAGE", args: { page: r.created[0] } }));
    expect(d.created).toHaveLength(1);
    expect(engine.pages().some((p) => p.guid === d.created[0])).toBe(true);
    expect(d.created[0]).not.toBe(r.created[0]);
  });

  it("duplicate_nodes makes one copy per entry: an id listed twice is duplicated twice (clone() per node)", async () => {
    const { engine, call } = await editor();
    const r = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Holder", width: 400, height: 200, children: [{ type: "RECTANGLE", name: "Tab", width: 40, height: 20 }, { type: "RECTANGLE", name: "Pill", width: 40, height: 20 }] }] }));
    const holder = ids(r)[0];
    const [tab, pill] = kids(engine, holder);
    const d = json(await call("duplicate_nodes", { nodeIds: [tab, tab, pill, tab] }));
    expect(d.copies).toHaveLength(4);
    const names = kids(engine, holder).map((id) => engine.readNode(id)!.name);
    expect(names.filter((n) => n === "Tab")).toHaveLength(4);
    expect(names.filter((n) => n === "Pill")).toHaveLength(2);
    expect(new Set(d.copies.map((c: { id: string }) => c.id)).size).toBe(4);
    for (const c of d.copies) expect([tab, pill]).not.toContain(c.id);
    // Without repeats: one DUPLICATE as before.
    const once = json(await call("duplicate_nodes", { nodeIds: [pill] }));
    expect(once.copies).toHaveLength(1);
  });
});
