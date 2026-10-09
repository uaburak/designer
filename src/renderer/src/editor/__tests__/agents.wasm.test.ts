// @vitest-environment happy-dom
// The MCP tools on the real engine (the committed Wasm build, headless): reads (get_selection, get_metadata,
// get_design_context, get_screenshot, get_variable_defs), writes as NODE_CHANGES (create / update / delete /
// duplicate / auto layout / reparent), one undo step per agent turn (turns.ts), and the flagship flow — a desktop
// frame's mobile version (create_responsive_variant).
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

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Agents test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  const turns = new AgentTurns(ed);
  const env = (turnId: string | null = "t1"): ToolEnv => ({ ed, write: (_label, fn) => turns.write(turnId, "Claude Code", fn) });
  return { ed, engine, turns, env };
}

const json = (r: ToolResult) => {
  expect(r.isError, r.content.map((c) => (c.type === "text" ? c.text : c.type)).join("\n")).toBeFalsy();
  const t = r.content.find((c) => c.type === "text");
  return t && t.type === "text" ? (t.text.startsWith("{") || t.text.startsWith("[") ? JSON.parse(t.text) : t.text) : null;
};

/** A desktop landing page: a nav row, a hero (title, text, button), three cards in a row, an image. */
const DESKTOP = {
  type: "FRAME", name: "Desktop", width: 1440, height: 1024, fills: "#FFFFFF",
  children: [
    { type: "FRAME", name: "Nav", x: 0, y: 0, width: 1440, height: 80, layoutMode: "HORIZONTAL", itemSpacing: 40, padding: [24, 80, 24, 80], primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisSizingMode: "FIXED", primaryAxisSizingMode: "FIXED", fills: "#111111",
      children: [{ type: "TEXT", characters: "Brand", fontSize: 24, fills: "#FFFFFF" }, { type: "TEXT", characters: "Products   Pricing   About", fontSize: 16, fills: "#FFFFFF" }] },
    { type: "TEXT", name: "Title", x: 80, y: 160, characters: "Design at the speed of thought", fontSize: 72, fontStyle: "Bold" },
    { type: "TEXT", name: "Lead", x: 80, y: 260, width: 720, characters: "A short paragraph under the headline that explains the product in one or two sentences.", fontSize: 20, textAutoResize: "HEIGHT" },
    { type: "RECTANGLE", name: "Button", x: 80, y: 340, width: 200, height: 56, cornerRadius: 8, fills: "#0D99FF" },
    { type: "FRAME", name: "Cards", x: 80, y: 460, width: 1280, height: 320, layoutMode: "HORIZONTAL", itemSpacing: 32, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", fills: [],
      children: [1, 2, 3].map((i) => ({ type: "FRAME", name: `Card ${i}`, width: 405, height: 320, fills: "#F5F5F5", cornerRadius: 12, layoutMode: "VERTICAL", padding: 24, itemSpacing: 12,
        children: [{ type: "TEXT", characters: `Feature ${i}`, fontSize: 28 }, { type: "TEXT", characters: "Body copy", fontSize: 16 }] })) },
    { type: "RECTANGLE", name: "Image", x: 80, y: 820, width: 1280, height: 160, fills: "#CCCCCC" },
  ],
};

describe("MCP tools on the engine", () => {
  it("get_selection, get_metadata and get_design_context read the file", async () => {
    const { ed, env } = await editor();
    ed.engine.setSelection(["1:5"]);
    const sel = json(await runTool(env(), "get_selection", {}));
    expect(sel.file).toBe("Agents test");
    expect(sel.selection.map((s: { id: string }) => s.id)).toEqual(["1:5"]);
    const xml = json(await runTool(env(), "get_metadata", {})) as string;
    expect(xml).toMatch(/^<[a-z-]+ id="1:5" name="Card" x="\d+" y="\d+" width="280" height="160"/);
    const page = json(await runTool(env(), "get_metadata", { nodeId: "0-1", depth: 1 })) as string;
    expect(page).toContain('<page id="0:1"');
    const ctx = json(await runTool(env(), "get_design_context", { nodeId: "1:5" }));
    expect(ctx.nodes[0]).toMatchObject({ id: "1:5", name: "Card", width: 280, height: 160 });
    expect(ctx.nodes[0].css).toContain("width: 280px");
    const missing = await runTool(env(), "get_design_context", { nodeId: "9:9999" });
    expect(missing.isError).toBe(true);
  });

  it("get_screenshot returns a PNG of the layer", async () => {
    const { env } = await editor();
    const r = await runTool(env(), "get_screenshot", { nodeId: "1:5", maxSize: 140 });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === "image");
    expect(img && img.type === "image" && img.mimeType).toBe("image/png");
    const bytes = Uint8Array.from(atob((img as { data: string }).data), (c) => c.charCodeAt(0));
    expect([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(140); // 280 wide at 0.5
  });

  it("create_nodes makes a nested auto layout frame from a description; update and delete change it", async () => {
    const { ed, env } = await editor();
    const made = json(await runTool(env(), "create_nodes", {
      nodes: [{ type: "FRAME", name: "Card", layoutMode: "VERTICAL", itemSpacing: 8, padding: 16, fills: "#FFFFFF", cornerRadius: 12, children: [{ type: "TEXT", characters: "Hello", fontSize: 20, fontStyle: "Bold" }, { type: "RECTANGLE", width: 120, height: 40, fills: "#0D99FF", layoutSizingHorizontal: "FILL" }] }],
    }));
    const id = made.created[0].id;
    const frame = ed.engine.readNode(id, { childIds: true })!;
    expect(frame.stackMode).toBe("VERTICAL");
    expect(frame.stackSpacing).toBe(8);
    // No size given: it hugs its content both ways.
    expect(frame.size).toEqual({ x: 16 + 120 + 16, y: 16 + 20 + 8 + 40 + 16 });
    expect(frame.childIds?.length).toBe(2);
    const [text, rect] = frame.childIds!.map((c) => ed.engine.readNode(c)!);
    expect(text.textData?.characters).toBe("Hello");
    expect(text.fontName?.style).toBe("Bold");
    expect(rect.stackChildAlignSelf).toBe("STRETCH");
    // A new top-level frame lands right of what's on the page.
    expect(frame.transform!.m02).toBeGreaterThan(0);
    json(await runTool(env(), "update_nodes", { updates: [{ nodeId: id, name: "Renamed", fills: "#FF0000", padding: [4, 8, 4, 8] }] }));
    const after = ed.engine.readNode(id)!;
    expect(after.name).toBe("Renamed");
    expect(after.stackHorizontalPadding).toBe(8);
    expect(after.fillPaints?.[0].color).toMatchObject({ r: 1, g: 0, b: 0 });
    json(await runTool(env(), "delete_nodes", { nodeIds: [rect.guid] }));
    expect(ed.engine.readNode(rect.guid)).toBeNull();
  });

  it("a turn's writes are one undo step; an outside client's write is its own", async () => {
    const { ed, engine, turns, env } = await editor();
    turns.start("t1", "Claude Code");
    const a = json(await runTool(env("t1"), "create_nodes", { nodes: [{ type: "RECTANGLE", name: "A" }] })).created[0].id;
    const b = json(await runTool(env("t1"), "create_nodes", { nodes: [{ type: "ELLIPSE", name: "B" }] })).created[0].id;
    json(await runTool(env("t1"), "update_nodes", { updates: [{ nodeId: a, width: 300 }] }));
    const t = turns.finish("t1")!;
    expect(t.state).toBe("applied");
    expect(engine.readNode(a)?.size?.x).toBe(300);
    expect(ed.store.undo.undoLabel).toBe("Claude Code edit");
    expect(turns.undo("t1")).toBe(true);
    expect(engine.readNode(a)).toBeNull();
    expect(engine.readNode(b)).toBeNull();
    expect(turns.get("t1")!.state).toBe("undone");
    expect(turns.redo("t1")).toBe(true);
    expect(engine.readNode(a)?.size?.x).toBe(300);
    expect(engine.readNode(b)).not.toBeNull();
    // An outside client's call: a step of its own.
    json(await runTool(env(null), "update_nodes", { updates: [{ nodeId: a, name: "Outside" }] }));
    expect(turns.get("t1")!.state).toBe("stale");
    engine.undo();
    expect(engine.readNode(a)?.name).toBe("A");
    expect(engine.readNode(a)?.size?.x).toBe(300);
  });

  it("the user's edit during a turn is never folded into it", async () => {
    const { ed, engine, turns, env } = await editor();
    turns.start("t2", "Claude Code");
    const a = json(await runTool(env("t2"), "create_nodes", { nodes: [{ type: "RECTANGLE", name: "A" }] })).created[0].id;
    ed.setProps(["1:5"], { name: "User edit" }, "Rename");
    json(await runTool(env("t2"), "update_nodes", { updates: [{ nodeId: a, name: "A2" }] }));
    expect(turns.finish("t2")!.state).toBe("stale");
    engine.undo();
    expect(engine.readNode(a)?.name).toBe("A");
    engine.undo();
    expect(engine.readNode("1:5")?.name).toBe("Card");
  });

  it("make the mobile version: a 390 frame next to the desktop one, re-laid out, one undo step", async () => {
    const { ed, engine, turns, env } = await editor();
    turns.start("m", "Claude Code");
    const desk = json(await runTool(env("m"), "create_nodes", { nodes: [DESKTOP] })).created[0];
    turns.finish("m");
    turns.start("m2", "Claude Code");
    const r = json(await runTool(env("m2"), "create_responsive_variant", { nodeId: desk.id }));
    const mobile = engine.readNode(r.created.id, { childIds: true })!;
    expect(mobile.name).toBe("Desktop — Mobile");
    expect(mobile.size?.x).toBe(390);
    expect(mobile.stackMode).toBe("VERTICAL");
    expect(mobile.transform!.m02).toBeGreaterThanOrEqual(desk.x + 1440 + 100);
    const kids = mobile.childIds!.map((id) => engine.readNode(id, { childIds: true })!);
    expect(kids.map((k) => k.name)).toEqual(["Nav", "Title", "Lead", "Button", "Cards", "Image"]);
    const byName = Object.fromEntries(kids.map((k) => [k.name, k]));
    if (process.env.AGENTS_DEBUG) console.log(JSON.stringify(kids.map((k) => [k.name, k.transform?.m02, k.transform?.m12, k.size, k.fontSize, k.stackMode, k.childIds?.length]), null, 0), mobile.size);
    expect(byName.Title.fontSize).toBeLessThanOrEqual(44);
    expect(byName.Title.textAutoResize).toBe("HEIGHT");
    expect(byName.Cards.stackMode).toBe("VERTICAL");
    for (const k of kids) expect((k.transform?.m02 ?? 0) + (k.size?.x ?? 0)).toBeLessThanOrEqual(390 + 0.5);
    expect(byName.Image.size!.x).toBeLessThanOrEqual(390);
    expect(byName.Image.size!.y / byName.Image.size!.x).toBeCloseTo(160 / 1280, 1);
    // The desktop frame is untouched.
    expect(engine.readNode(desk.id)!.size!.x).toBe(1440);
    json(await runTool(env("m2"), "update_nodes", { updates: [{ nodeId: r.created.id, fills: "#FAFAFA" }] }));
    expect(turns.finish("m2")!.state).toBe("applied");
    expect(ed.store.undo.undoLabel).toBe("Claude Code edit");
    engine.undo();
    expect(engine.readNode(r.created.id)).toBeNull();
    expect(engine.readNode(desk.id)).not.toBeNull();
  });
});
