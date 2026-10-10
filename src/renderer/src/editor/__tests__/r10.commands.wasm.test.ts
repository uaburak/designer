// Round 10 — menus, commands, left side and toolbar (docs/editor.md "Round 10 — Menus, commands, left side and
// toolbar"; live menus/*.txt, toolbar/vector-edit-*.txt): the Figma menu's commands live has enabled are no longer
// stubs, the context menus' rows are live's, and the editor's own commands do what they say — on the real engine (the
// committed Wasm build, headless in Node) and the capture fixture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MenuEntry, MenuItem } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMMAND_BY_ID, isEnabled, runEditorCommand } from "../commands";
import { canvasMenu } from "../menus";
import { CAPTURE_DOCUMENT } from "../fixtures";
import { textSummary } from "../model/text";
import { misspelledRanges, wordsOf } from "../spellcheck";
import { vectorMoreTools } from "../canvas/BottomToolbar";
import { actionRows } from "../panels/ActionsPanel";
import type { FileOps } from "../objectCommands";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

afterEach(() => {
  delete (globalThis as { designer?: unknown }).designer;
});

async function editor(doc: Message = CAPTURE_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Capture" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  // The capture opens on its "Capture" page (CAPTURE_UI_STATE; "Page 1" first and empty, as live).
  if (doc === CAPTURE_DOCUMENT) engine.setCurrentPage("0:1");
  return { ed, engine, source };
}

const items = (entries: readonly MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => typeof e === "object" && "id" in e);
const labels = (entries: readonly MenuEntry[]) => items(entries).map((i) => i.label);
const enabled = (ed: EditorController, id: string) => isEnabled(ed, COMMAND_BY_ID.get(id)!);
const pos = (engine: Engine, id: string) => {
  const n = engine.readNode(id, { fields: ["transform"] }) as { transform: { m02: number; m12: number } };
  return [n.transform.m02, n.transform.m12];
};

describe("round 10: the stubs live has enabled (live menus/main-*.txt)", () => {
  it("View's toggles, Find previous / next frame and Cursor chat run with nothing selected", async () => {
    const { ed } = await editor();
    for (const id of ["view.comments", "view.mask-outlines", "view.frame-outlines", "view.memory-usage", "view.minimize-left-nav", "view.multiplayer-cursors", "view.switch-to-draw", "view.find-previous-frame", "view.find-next-frame", "canvas.cursor-chat"])
      expect(enabled(ed, id), id).toBe(true);
    runEditorCommand(ed, "view.frame-outlines");
    expect(ed.ui.get().frameOutlines).toBe(true);
    runEditorCommand(ed, "view.minimize-left-nav");
    expect(ed.ui.get().navMinimized).toBe(true);
    runEditorCommand(ed, "view.switch-to-draw");
    expect(ed.ui.get().mode).toBe("draw");
    expect(ed.store.tool).toBe("PENCIL");
    runEditorCommand(ed, "view.switch-to-draw");
    expect(ed.ui.get().mode).toBe("design");
  });

  it("Object, Arrange, Vector and Edit commands with a selection", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:60"]);
    for (const id of ["edit.copy-properties", "edit.set-default-properties", "arrange.round-to-pixel", "object.hide-other-layers", "vector.simplify", "vector.offset"]) expect(enabled(ed, id), id).toBe(true);
    // Live keeps these disabled without their state: Distribute needs three layers, Pack two, Join points in edit mode.
    expect(enabled(ed, "arrange.distribute-left")).toBe(false);
    expect(enabled(ed, "vector.join")).toBe(false);
    engine.setSelection(["7:60", "7:61", "7:62"]);
    for (const id of ["arrange.distribute-left", "arrange.distribute-horizontal-centers", "arrange.distribute-right", "arrange.distribute-top", "arrange.distribute-vertical-centers", "arrange.distribute-bottom", "arrange.pack-horizontal", "arrange.pack-vertical"])
      expect(enabled(ed, id), id).toBe(true);
    engine.setSelection(["7:10"]);
    for (const id of ["object.convert-to-section", "object.set-as-thumbnail", "object.add-layout-horizontal"]) expect(enabled(ed, id), id).toBe(true);
    engine.setSelection(["7:90"]);
    for (const id of ["text.direction-auto", "text.direction-ltr", "text.direction-rtl"]) expect(enabled(ed, id), id).toBe(true);
  });

  it("File › Duplicate, Move to project…, Create branch… where the document source has file operations", async () => {
    const { ed, source } = await editor();
    expect(enabled(ed, "file.duplicate")).toBe(false);
    const made: string[] = [];
    const ops: FileOps = {
      fileKey: "f1",
      duplicate: async () => ({ fileKey: "f2", name: "Capture (copy)" }),
      folders: async () => [{ id: null, name: "Drafts" }],
      moveTo: async () => {},
      branch: async (name) => {
        made.push(name);
        return { fileKey: "f3", name: `Capture / ${name}` };
      },
    };
    (source as unknown as { fileOps: FileOps }).fileOps = ops;
    for (const id of ["file.duplicate", "file.move", "file.create-branch"]) expect(enabled(ed, id), id).toBe(true);
    runEditorCommand(ed, "file.create-branch");
    expect(ed.ui.get().branchDialog).toBe(true);
  });

  it("Spell check: on the desktop's spell checker only; the words and the misspelled ranges", async () => {
    const { ed } = await editor();
    expect(enabled(ed, "text.spell-check")).toBe(false);
    (globalThis as { designer?: unknown }).designer = { spelling: { misspelled: (w: string[]) => w.map((x) => x === "Helo") } };
    expect(enabled(ed, "text.spell-check")).toBe(true);
    expect(wordsOf("Helo, wörld — it's 3 a.m.").map((w) => w.word)).toEqual(["Helo", "wörld", "it's", "a", "m"]);
    expect(misspelledRanges("Say Helo there", (w) => w.map((x) => x === "Helo"))).toEqual([[4, 8]]);
  });

  it("the intended exclusions stay disabled", async () => {
    const { ed } = await editor();
    for (const id of ["file.open-in-desktop", "canvas.send-to-make", "canvas.find-similar", "canvas.add-motion", "plugins.manage", "widgets.manage", "widgets.select-all", "prefs.color-profile", "prefs.accessibility", "prefs.permissions", "help.font-settings", "help.account", "help.log-out", "canvas.rename-layers-ai"])
      expect(enabled(ed, id), id).toBe(false);
  });
});

describe("round 10: the commands do what they say", () => {
  it("Distribute left / Pack horizontal / Convert to section, one undo step each", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:60", "7:61", "7:62"]);
    // Rect 0, Ellipse 160, Polygon 300 (x): Pack puts them side by side from the Rect's right edge.
    runEditorCommand(ed, "arrange.pack-horizontal");
    expect(pos(engine, "7:61")[0]).toBe(120);
    expect(pos(engine, "7:62")[0]).toBe(220);
    engine.undo();
    expect(pos(engine, "7:61")[0]).toBe(160);
    engine.setSelection(["7:10"]);
    runEditorCommand(ed, "object.convert-to-section");
    expect((engine.readNode("7:10", { fields: ["type"] }) as { type: string }).type).toBe("SECTION");
  });

  it("Copy / Paste properties: the look onto another layer; Hide other layers", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:61"]);
    runEditorCommand(ed, "edit.copy-properties");
    engine.setSelection(["7:60"]);
    expect(enabled(ed, "edit.paste-properties")).toBe(true);
    ed.setProps(["7:61"], { opacity: 0.5 }, "Opacity");
    engine.setSelection(["7:61"]);
    runEditorCommand(ed, "edit.copy-properties");
    engine.setSelection(["7:60"]);
    runEditorCommand(ed, "edit.paste-properties");
    expect((engine.readNode("7:60", { fields: ["opacity"] }) as { opacity: number }).opacity).toBeCloseTo(0.5);
    runEditorCommand(ed, "object.hide-other-layers");
    expect((engine.readNode("7:61", { fields: ["visible"] }) as { visible?: boolean }).visible).toBe(false);
    expect((engine.readNode("7:60", { fields: ["visible"] }) as { visible?: boolean }).visible).not.toBe(false);
  });

  it("Find next frame (End): a top-level frame selected; Text direction: the paragraphs' direction, checked", async () => {
    const { ed, engine } = await editor();
    runEditorCommand(ed, "view.find-next-frame");
    expect(ed.selection.length).toBe(1);
    const first = ed.selection[0];
    runEditorCommand(ed, "view.find-next-frame");
    expect(ed.selection[0]).not.toBe(first);
    engine.setSelection(["7:90"]);
    expect(COMMAND_BY_ID.get("text.direction-auto")!.checked!(ed)).toBe(true);
    runEditorCommand(ed, "text.direction-rtl");
    expect((textSummary(engine, ["7:90"])!.values as { sourceDirectionality?: string }).sourceDirectionality).toBe("RTL");
    expect(COMMAND_BY_ID.get("text.direction-rtl")!.checked!(ed)).toBe(true);
    expect(COMMAND_BY_ID.get("text.direction-auto")!.checked!(ed)).toBe(false);
  });
});

describe("round 10: context menus (live menus/context-*.txt)", () => {
  it("a Layers row: Copy first, no Paste here, Rename ⌘R and Rename layers (AI) after Frame selection", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:60"]);
    const row = canvasMenu(ed, [], { row: true });
    const l = labels(row);
    expect(l[0]).toBe("Copy");
    expect(l).not.toContain("Paste here");
    expect(l.slice(l.indexOf("Frame selection"), l.indexOf("Frame selection") + 3)).toEqual(["Frame selection", "Rename", "Rename layers"]);
    expect(items(row).find((i) => i.label === "Rename layers")!.badge).toBe("AI");
    expect(labels(canvasMenu(ed, []))).toContain("Paste here");
  });

  it("an instance: Select layer when layers are under the pointer, no Convert to section or Set as thumbnail", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["8:60"]);
    const l = labels(canvasMenu(ed, [{ id: "8:60", name: "Button" }, { id: "I8:60;8:3", name: "Label" }]));
    expect(l).toContain("Select layer");
    expect(l).not.toContain("Convert to section");
    expect(l).not.toContain("Set as thumbnail");
    expect(l.slice(-11, -4)).toEqual(["Add auto layout", "Create component", "Reset instance", "Detach instance", "Go to main component", "Plugins", "Widgets"]);
  });

  it("a main component: Set as thumbnail, More layout options, no Convert to section; a frame: Convert to section", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["8:1"]);
    const c = labels(canvasMenu(ed, []));
    expect(c).not.toContain("Convert to section");
    expect(c).toContain("Set as thumbnail");
    expect(c).toContain("More layout options");
    engine.setSelection(["7:10"]);
    const f = labels(canvasMenu(ed, []));
    expect(f.slice(f.indexOf("Send to back") + 1, f.indexOf("Send to back") + 2)).toEqual(["Convert to section"]);
  });
});

describe("round 10: toolbar", () => {
  it("vector edit's More: Vector editing tools — Shape builder M, Variable width ⇧W (round 12: built, a radio menu)", () => {
    const row = (e: ReturnType<typeof vectorMoreTools>[number]) => (typeof e === "object" && "label" in e ? [e.label, e.shortcut, !!e.disabled, !!e.checked] : e);
    expect(vectorMoreTools("MOVE", true).map(row)).toEqual([
      ["Shape builder", "M", false, false],
      ["Variable width", "⇧W", false, false],
    ]);
    expect(vectorMoreTools("SHAPE_BUILDER", true).map(row)).toEqual([
      ["Shape builder", "M", false, true],
      ["Variable width", "⇧W", false, false],
    ]);
    // Where Variable width doesn't apply (dashes, a dynamic stroke, branching paths): disabled.
    expect(vectorMoreTools("VARIABLE_WIDTH", false).map(row)).toEqual([
      ["Shape builder", "M", false, false],
      ["Variable width", "⇧W", true, true],
    ]);
  });

  it("Actions opens on Recents (live); round 11: nothing run yet lists no commands", () => {
    const list = [
      { id: "a", label: "Zoom to fit", section: "View", disabled: false },
      { id: "b", label: "Flatten", section: "Object", disabled: false },
    ];
    expect(actionRows(list, "", ["b"], () => true).map((r) => [r.section, r.label])).toEqual([["Recents", "Flatten"]]);
    expect(actionRows(list, "", [], () => true)).toEqual([]);
  });
});
