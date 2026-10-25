// @vitest-environment happy-dom
// An instance's slot as Figma shows it (help "Create and use slots"): one Layers row — the slot, named as the main's,
// with the slot glyph — holding the instance's own layers; drops into it (the panel's and the agents' reparent_nodes)
// go into its content frame and follow the slot's auto layout, an instance in another one's slot content included.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { ToolResult } from "@shared/agents/tools";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { ancestorsOf, visibleRows } from "../model/layerTree";
import { layerIcon } from "../panels/Layers";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Slots" });
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
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  const t = text(r);
  return t.startsWith("{") || t.startsWith("[") ? JSON.parse(t) : t;
};
const ids = (r: { created: { id: string }[] }) => r.created.map((c) => c.id);
const kids = (engine: Engine, id: string) => engine.readNode(id, { childIds: true })!.childIds ?? [];

/** A component with a vertical auto-layout slot (8 apart, 10 in) and an instance of it; the slot's row on the instance. */
async function slotted(call: (n: string, a: Record<string, unknown>) => Promise<ToolResult>, engine: Engine, name: string, x: number) {
  const made = json(
    await call("create_nodes", {
      nodes: [
        {
          type: "FRAME",
          name,
          x,
          y: 0,
          width: 200,
          layoutMode: "VERTICAL",
          layoutSizingVertical: "HUG",
          children: [
            { type: "RECTANGLE", name: "Title", width: 200, height: 20 },
            { type: "FRAME", name: "Body", width: 200, height: 30, layoutMode: "VERTICAL", layoutSizingVertical: "HUG", itemSpacing: 8, paddingLeft: 10, paddingTop: 10, paddingRight: 10, paddingBottom: 10, fills: [] },
          ],
        },
      ],
    }),
  );
  const main = ids(made)[0];
  const body = kids(engine, main)[1];
  json(await call("run_command", { engineCommand: "CREATE_COMPONENT", nodeIds: [main] }));
  json(await call("run_command", { engineCommand: "CONVERT_TO_SLOT", args: { ref: body } }));
  const inst = json(await call("run_command", { engineCommand: "INSERT_INSTANCE", args: { main, x, y: 400 } })).created[0] as string;
  const slot = kids(engine, inst)[1];
  return { main, body, inst, slot };
}

describe("an instance's slot in Layers and for the agents", () => {
  it("one slot row (the content frame in the slot's place, the slot glyph), its layers laid out by the slot's auto layout", async () => {
    const { ed, engine, call } = await editor();
    const { inst, slot } = await slotted(call, engine, "Card", 0);
    const rects = ids(json(await call("create_nodes", { nodes: ["A", "B"].map((name) => ({ type: "RECTANGLE", name, x: 800, y: 0, width: 50, height: 20 })) })));
    // The derived slot row takes layers (the panel's drop target) before the instance has its own content.
    let tree = ed.getTree();
    expect(tree.nodes.get(slot)?.slotHost).toBe(true);
    json(await call("reparent_nodes", { nodeIds: rects, parentId: slot, index: 0 }));
    const content = engine.readNode(rects[0])!.parentIndex!.guid;
    expect(engine.readNode(content)!.parentIndex!.guid).toBe(inst);
    tree = ed.getTree();
    // One row: the content frame where the slot was, not the slot row and the frame side by side.
    expect(tree.nodes.get(inst)!.children).toEqual([kids(engine, inst)[0], content]);
    expect(tree.nodes.has(slot)).toBe(false);
    const node = tree.nodes.get(content)!;
    expect(node.parent).toBe(inst);
    expect(layerIcon(node)).toBe("16.slot");
    expect(node.name).toBe("Body");
    const shown = visibleRows(tree, new Set([...ancestorsOf(tree, inst), inst, content])).map((r) => r.id);
    expect(shown).toEqual(expect.arrayContaining([content, ...rects]));
    expect(shown).not.toContain(slot);
    // In the slot's flow: 10 in, 8 apart.
    const box = (id: string) => engine.readNode(id)!.transform!;
    expect([box(rects[0]).m02, box(rects[0]).m12]).toEqual([10, 10]);
    expect([box(rects[1]).m02, box(rects[1]).m12]).toEqual([10, 38]);
    // Selecting the slot row selects the slot as shown.
    engine.setSelection([slot]);
    expect(engine.getSelection().refs).toEqual([content]);
  });

  it("reparent_nodes into the slot of an instance that sits in another instance's slot content", async () => {
    const { engine, call } = await editor();
    const card = await slotted(call, engine, "Card", 0);
    const chip = await slotted(call, engine, "Chip", 400);
    json(await call("reparent_nodes", { nodeIds: [chip.inst], parentId: card.slot, index: 0 }));
    const cardContent = engine.readNode(chip.inst)!.parentIndex!.guid;
    expect(engine.readNode(cardContent)!.parentIndex!.guid).toBe(card.inst);
    const rect = ids(json(await call("create_nodes", { nodes: [{ type: "RECTANGLE", name: "Inner", x: 900, y: 0, width: 30, height: 30 }] })))[0];
    const innerSlot = kids(engine, chip.inst)[1];
    const moved = json(await call("reparent_nodes", { nodeIds: [rect], parentId: innerSlot, index: 0 }));
    const chipContent = moved.moved[0].parentId as string;
    expect(engine.readNode(chipContent)!.parentIndex!.guid).toBe(chip.inst);
    expect(engine.readNode(rect)!.transform!.m02).toBe(10);
    // And into the content frame itself, at an index.
    const rect2 = ids(json(await call("create_nodes", { nodes: [{ type: "RECTANGLE", name: "Second", x: 900, y: 100, width: 30, height: 30 }] })))[0];
    json(await call("reparent_nodes", { nodeIds: [rect2], parentId: chipContent, index: 0 }));
    expect(kids(engine, chipContent)).toEqual([rect2, rect]);
  });
});
