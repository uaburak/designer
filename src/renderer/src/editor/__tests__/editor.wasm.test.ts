// The editor's controller, commands and menus on the real engine (the committed Wasm build, headless in Node):
// the Layers tree, labelled edits as one undo step, a scrub as one step, Esc cancelling it, the
// DocumentSource receiving every commit, the command registry and the menus built from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PointerType } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runEditorCommand, COMMANDS } from "../commands";
import { canvasMenu, mainMenu } from "../menus";
import { REFERENCE_DOCUMENT, REFERENCE_PAGES } from "../fixtures";
import { visibleRows } from "../model/layerTree";
import { ENGINE_TOOL, toolIdOf } from "../canvas/BottomToolbar";
import { layerIcon } from "../panels/Layers";
import { typeLabel, type PanelNode } from "../panels/design/shared";
import { pageColors, selectionColorsOf, writeSelectionColor } from "../panels/design/SelectionColors";
import { flowAxis, isAutoLayout, limitOf, sizingChanges, sizingOf, withLimit, type SizingNode } from "../model/sizing";
import type { NodeChange } from "@/engine/codec";
import type { MenuEntry, MenuItem } from "@/ds";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor(doc = SAMPLE_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

const items = (entries: MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => typeof e === "object" && "id" in e);

describe("editor on the engine (wasm, headless)", () => {
  it("reads the page's Layers tree, top layer first", async () => {
    const { ed } = await editor();
    const rows = visibleRows(ed.getTree(), new Set());
    expect(rows[0].id).toBe("1:26"); // "Locked", the last child = on top
    expect(rows.map((r) => r.id)).toContain("1:1");
    expect(ed.getTree()).toBe(ed.getTree()); // cached until the structure changes
    const open = visibleRows(ed.getTree(), new Set(["1:1"]));
    expect(open.length).toBe(rows.length + 6);
  });

  it("opens the reference file: eight pages, Frame 1 on the first", async () => {
    const { ed, engine } = await editor(REFERENCE_DOCUMENT);
    expect(engine.pages().map((p) => p.name)).toEqual(REFERENCE_PAGES);
    const frame = engine.readNode("1:1")!;
    expect(frame.size).toEqual({ x: 437, y: 305 });
    expect(ed.getTree().nodes.get("1:1")?.name).toBe("Frame 1");
  });

  it("a labelled edit is one undo step, and the source gets it", async () => {
    const { ed, engine, source } = await editor();
    const before = source.changes.length;
    ed.setProps(["1:5"], { name: "Renamed", opacity: 0.5 }, "Rename");
    expect(source.changes.length).toBe(before + 1);
    expect(engine.readNode("1:5")?.name).toBe("Renamed");
    expect(ed.store.undo.undoLabel).toBe("Rename");
    engine.undo();
    expect(engine.readNode("1:5")?.name).toBe("Card");
    expect(source.snapshot().nodeChanges.find((n) => n.guid === "1:5")?.name).toBe("Card");
  });

  it("a scrub is one step; Esc during it rolls everything back", async () => {
    const { ed, engine, source } = await editor();
    const before = source.changes.length;
    for (const v of [0.9, 0.8, 0.7]) ed.edit("Opacity", { final: false, source: "scrub" }, () => void engine.setProps(["1:5"], { opacity: v }));
    ed.edit("Opacity", { final: true, source: "scrub" }, () => void engine.setProps(["1:5"], { opacity: 0.6 }));
    expect(source.changes.length).toBe(before + 1);
    expect(engine.readNode("1:5")?.opacity).toBeCloseTo(0.6);
    ed.edit("Opacity", { final: false, source: "scrub" }, () => void engine.setProps(["1:5"], { opacity: 0.1 }));
    ed.cancelEdit();
    expect(engine.readNode("1:5")?.opacity).toBeCloseTo(0.6);
    expect(source.changes.length).toBe(before + 1);
  });

  it("runs registry commands: select all, delete, undo", async () => {
    const { ed, engine } = await editor();
    expect(runEditorCommand(ed, "edit.select-all")).toBe(true);
    expect(ed.selection.length).toBeGreaterThan(3);
    engine.setSelection(["1:21"]);
    expect(runEditorCommand(ed, "edit.delete")).toBe(true);
    expect(engine.readNode("1:21")).toBeNull();
    expect(runEditorCommand(ed, "edit.undo")).toBe(true);
    expect(engine.readNode("1:21")).not.toBeNull();
    expect(runEditorCommand(ed, "view.rulers")).toBe(true);
    expect(ed.ui.get().rulers).toBe(false);
    expect(runEditorCommand(ed, "no.such.command")).toBe(false);
  });

  it("flips with the engine's command or the same edit in TS", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["1:5"]);
    const m = engine.readNode("1:5")!.transform!;
    runEditorCommand(ed, "object.flip-horizontal");
    const f = engine.readNode("1:5")!.transform!;
    expect(f.m00).toBeCloseTo(-m.m00);
    expect(f.m02).toBeCloseTo(m.m02 + 280); // mirrored about its own centre: the box stays where it was
  });

  it("builds the main menu and the canvas menu from the registry", async () => {
    const { ed, engine } = await editor();
    const main = items(mainMenu(ed));
    expect(main.map((i) => i.label)).toEqual(expect.arrayContaining(["Back to files", "File", "Edit", "View", "Object", "Text", "Arrange"]));
    const edit = main.find((i) => i.label === "Edit")!;
    expect(items(edit.items!).find((i) => i.id === "edit.undo")?.disabled).toBe(true);
    const view = items(main.find((i) => i.label === "View")!.items!);
    expect(view.find((i) => i.id === "view.rulers")?.checked).toBe(true);
    expect(items(canvasMenu(ed, [])).map((i) => i.id)).toContain("edit.paste-here");
    engine.setSelection(["1:5"]);
    const sel = items(canvasMenu(ed, [{ id: "1:5", name: "Card" }, { id: "1:1", name: "Desktop" }]));
    expect(sel.map((i) => i.id)).toEqual(expect.arrayContaining(["edit.copy", "object.bring-to-front", "object.toggle-visible", "submenu:select-layer"]));
  });

  it("moves layers with the Layers panel's drop target, copies and pastes, adds and deletes pages", async () => {
    const { ed, engine } = await editor();
    const tree = ed.getTree();
    const rows = visibleRows(tree, new Set());
    // Drop "Locked" (top) above "Ring": index counted without the dragged layer.
    const { dropTarget } = await import("../model/layerTree");
    const ring = rows.findIndex((r) => r.id === "1:21");
    const target = dropTarget(tree, rows, ring, 0.1, new Set(["1:26"]))!;
    expect(engine.moveNodes(["1:26"], target.parent, target.index)).toBe(1);
    const after = visibleRows(ed.getTree(), new Set()).map((r) => r.id);
    expect(after.indexOf("1:26")).toBe(after.indexOf("1:21") - 1);

    engine.setSelection(["1:21"]);
    const copied = engine.encodeSelection()!;
    expect(copied.nodeChanges.length).toBeGreaterThan(0);
    expect(engine.paste(copied, { inPlace: true })).toBe(1);
    expect(ed.selection[0]).not.toBe("1:21");

    const pages = engine.pages().length;
    expect(engine.command("CREATE_PAGE")).toBe(0);
    expect(engine.pages().length).toBe(pages + 1);
    const added = engine.pages().at(-1)!.guid;
    expect(engine.command("DELETE_PAGE", { page: added })).toBe(0);
    expect(engine.pages().length).toBe(pages);
  });

  it("reports the menu's state as patches of what changed", async () => {
    const { ed, engine } = await editor();
    const { menuPatch, menuState } = await import("../desktop");
    const first = menuState(ed);
    expect(first.enabled["edit.delete"]).toBe(false);
    expect(first.checked["view.rulers"]).toBe(true);
    expect(menuPatch(first, menuState(ed))).toBeNull();
    engine.setSelection(["1:5"]);
    const patch = menuPatch(first, menuState(ed))!;
    expect((patch.enabled as Record<string, boolean>)["edit.delete"]).toBe(true);
  });

  it("selects inverse, and opens the context menu from the engine's CONTEXT_MENU", async () => {
    const { ed, engine } = await editor();
    engine.setCamera({ x: 0, y: 0, zoom: 1 });
    engine.setSelection(["1:26"]);
    expect(runEditorCommand(ed, "edit.select-inverse")).toBe(true);
    expect(ed.selection).not.toContain("1:26");
    const { attachCanvasMenu, layersUnder } = await import("../canvas/CanvasMenu");
    const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }) } as unknown as HTMLCanvasElement;
    const off = attachCanvasMenu(ed, canvas);
    engine.pointer(PointerType.DOWN, 100, 150, 2, 2, 0);
    engine.pointer(PointerType.UP, 100, 150, 2, 0, 0);
    off();
    const menu = ed.ui.get().contextMenu;
    expect(menu?.x).toBe(110);
    expect(ed.selection).toEqual(["1:5"]); // what a left click picks: the frame's child
    expect(menu?.layers).toEqual(expect.arrayContaining(["1:5", "1:1"]));
    expect(layersUnder([["1:5", "1:1"], ["1:1"]])).toEqual(["1:5", "1:1"]);
  });

  it("every command has a label, and ids are unique", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    for (const c of COMMANDS) expect(c.label.length).toBeGreaterThan(0);
  });
});

describe("panel helpers", () => {
  it("maps toolbar tools to the engine's and back", () => {
    expect(ENGINE_TOOL.rectangle).toBe("RECTANGLE");
    expect(toolIdOf("FRAME")).toBe("frame");
    expect(toolIdOf("SOMETHING")).toBe("move");
  });

  it("picks a layer's glyph and the selection's type", () => {
    const node = { id: "1:1", parent: "0:1", type: "FRAME", name: "F", visible: true, locked: false, group: false, children: [] };
    expect(layerIcon(node)).toBe("16.frame");
    expect(layerIcon({ ...node, stackMode: "VERTICAL" })).toBe("16.autolayout.vertical");
    expect(layerIcon({ ...node, stackMode: "HORIZONTAL", stackWrap: "WRAP" })).toBe("16.autolayout.wrap");
    expect(layerIcon({ ...node, group: true })).toBe("16.group");
    expect(layerIcon({ ...node, type: "ELLIPSE" })).toBe("16.ellipse");
    expect(typeLabel([{ guid: "1", type: "FRAME" }])).toBe("Frame");
    expect(typeLabel([{ guid: "1", type: "FRAME", resizeToFit: true }])).toBe("Group");
    expect(typeLabel([{ guid: "1", type: "ELLIPSE" }, { guid: "2", type: "ROUNDED_RECTANGLE" }])).toBe("Mixed");
  });
});

describe("Design panel, Phase 2 (wasm, headless)", () => {
  it("keeps the file's own types (vectors, booleans, text) through the engine", async () => {
    const doc = structuredClone(REFERENCE_DOCUMENT);
    doc.nodeChanges.push(
      { guid: "1:2", phase: "CREATED", type: "VECTOR" as never, name: "Vector", parentIndex: { guid: "1:1", position: "!" }, size: { x: 10, y: 10 } },
      { guid: "1:3", phase: "CREATED", type: "BOOLEAN_OPERATION" as never, booleanOperation: "INTERSECT", name: "B", parentIndex: { guid: "1:1", position: "#" } } as never
    );
    const { ed, engine } = await editor(doc);
    expect(engine.readNode("1:2")?.type).toBe("VECTOR");
    ed.noteSourceTypes(doc);
    const tree = ed.getTree();
    expect(tree.nodes.get("1:2")?.type).toBe("VECTOR");
    expect(layerIcon(tree.nodes.get("1:2")!)).toBe("16.vector");
    expect(layerIcon(tree.nodes.get("1:3")!)).toBe("16.boolean.intersect");
    expect(typeLabel([ed.withRealType(engine.readNode("1:2")!)])).toBe("Vector path");
    expect(ed.withRealType(engine.readNode("1:1")!).type).toBe("FRAME");
  });

  it("Hug / Fill / Fixed and min / max reach the engine's layout", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["1:7"]);
    expect(runEditorCommand(ed, "object.add-auto-layout")).toBe(true);
    const frame = () => ed.withRealType(engine.readNode("1:7")!) as SizingNode & { guid: string };
    const child = () => engine.readNode("1:8")! as SizingNode & { guid: string };
    expect(isAutoLayout(frame())).toBe(true);
    // The child fills the frame across its flow, as one undo step.
    const axis = flowAxis(frame()) === "x" ? "y" : "x";
    const { node, parent } = sizingChanges(child(), frame(), axis, "FILL");
    ed.batch("Fill container", () => {
      if (parent) engine.setProps(["1:7"], parent);
      engine.setProps(["1:8"], node);
    });
    expect(sizingOf(child(), frame(), axis)).toBe("FILL");
    const f = frame();
    const pad = axis === "x" ? (f as NodeChange).stackHorizontalPadding! + (f as NodeChange).stackPaddingRight! : (f as NodeChange).stackVerticalPadding! + (f as NodeChange).stackPaddingBottom!;
    expect(child().size![axis]).toBeCloseTo(f.size![axis] - pad, 3);
    // Hug the frame's flow axis; a max width caps the frame.
    ed.batch("Hug contents", () => engine.setProps(["1:7"], sizingChanges(frame(), null, flowAxis(frame()), "HUG").node));
    expect(sizingOf(frame(), null, flowAxis(frame()))).toBe("HUG");
    ed.setProps(["1:7"], withLimit(frame(), "max", "x", 120), "Max width");
    expect(frame().size!.x).toBeLessThanOrEqual(120.001);
    expect(limitOf(frame(), "max", "x")).toBe(120);
    engine.undo();
    expect(limitOf(frame(), "max", "x")).toBeNull();
  });

  it("Ignore auto layout and constraints write the schema's fields", async () => {
    const { ed, engine } = await editor();
    ed.setProps(["1:4"], { horizontalConstraint: "MAX" }, "Constraints");
    const before = engine.readNode("1:4")!.transform!.m02;
    ed.setProps(["1:1"], { size: { x: 740, y: 420 } }, "Resize");
    expect(engine.readNode("1:4")!.transform!.m02).toBeCloseTo(before + 100, 3);
    engine.setSelection(["1:7"]);
    runEditorCommand(ed, "object.add-auto-layout");
    ed.setProps(["1:9"], { stackPositioning: "ABSOLUTE" }, "Ignore auto layout");
    expect(engine.readNode("1:9")!.stackPositioning).toBe("ABSOLUTE");
  });

  it("Selection colors: a frame lists its own and its children's colours; editing one recolours every use", async () => {
    const { ed, engine, source } = await editor();
    const frame = engine.readNode("1:1")! as PanelNode;
    const { show, colors } = selectionColorsOf(engine, [frame]);
    expect(show).toBe(true);
    const keys = colors.map((c) => c.key);
    expect(keys[0]).toBe("#ffffff/100");
    expect(keys).toContain("#ffc700/100"); // Card 2's stroke and the Sun inside Clip
    const yellow = colors.find((c) => c.key === "#ffc700/100")!;
    expect(new Set(yellow.uses.map((u) => u.guid))).toEqual(new Set(["1:6", "1:8"]));
    const before = source.changes.length;
    writeSelectionColor(ed, yellow.uses, { color: { r: 1, g: 0, b: 0, a: 1 } }, { final: true, source: "type" });
    expect(source.changes.length).toBe(before + 1);
    expect(engine.readNode("1:6")!.strokePaints![0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(engine.readNode("1:8")!.fillPaints![0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    // The picker's "On this page" swatches.
    expect(pageColors(ed)).toContain("#0d99ff");
    // A single rectangle without children: no section.
    expect(selectionColorsOf(engine, [engine.readNode("1:2")! as PanelNode]).show).toBe(false);
  });
});
