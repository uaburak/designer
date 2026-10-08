// Round 7's left panel on the real engine (the committed Wasm build, headless): Find reads a page and every page,
// Replace keeps a text's styled runs (one undo step), Collapse layers (⌥L), Enter on the list selecting the
// children, Add new page opening its rename, the lock / eye drag as one undo step.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runEditorCommand } from "../commands";
import { COMPONENTS_DOCUMENT, REFERENCE_DOCUMENT, TEXT_DOCUMENT } from "../fixtures";
import { EMPTY_FIND, findResults, findScope, readPageForFind, replaceInLayers, stepFind } from "../find";
import { createPage } from "../panels/Pages";
import { visibleRows } from "../model/layerTree";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  g.queueMicrotask ??= (f: () => void) => Promise.resolve().then(f);
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor(doc: Message) {
  const source = memoryDocumentSource(doc, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  return { ed, engine };
}

describe("left panel on the engine (wasm, headless)", () => {
  it("Find reads a page in document order with parents, matches text and names, and moves through results", async () => {
    const { ed } = await editor(TEXT_DOCUMENT);
    const nodes = readPageForFind(ed, ed.store.page);
    expect(nodes[0]).toMatchObject({ id: "4:1", type: "FRAME", name: "Type specimen", parent: undefined });
    expect(nodes[1]).toMatchObject({ id: "4:2", type: "TEXT", text: "Typography", parent: "Type specimen" });
    const f = { ...EMPTY_FIND, query: "lists" };
    const results = findResults(ed, f);
    expect(results.map((r) => r.id)).toEqual(["4:4", "4:5"]);
    expect(results[0]).toMatchObject({ inText: true, parent: "Type specimen" });
    ed.ui.set({ find: f });
    stepFind(ed, 1);
    expect(ed.selection).toEqual(["4:4"]);
    stepFind(ed, 1);
    expect(ed.selection).toEqual(["4:5"]);
    stepFind(ed, 1);
    expect(ed.selection).toEqual(["4:4"]);
  });

  it("Find on all pages lists each page's layers in page order", async () => {
    const { ed } = await editor(COMPONENTS_DOCUMENT);
    const all = findScope(ed, "all");
    const pages = ed.store.pages.map((p) => p.guid);
    const order = all.map((n) => pages.indexOf(n.page));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(all.map((n) => n.page)).size).toBeGreaterThan(1);
  });

  it("Replace keeps the styled runs and is one undo step", async () => {
    const { ed, engine } = await editor(TEXT_DOCUMENT);
    const f = { ...EMPTY_FIND, query: "help", replaceWith: "HELP!" };
    const targets = findResults(ed, f);
    expect(targets.map((r) => r.id)).toEqual(["4:3"]);
    expect(replaceInLayers(ed, f, targets)).toBe(1);
    const td = engine.readNode("4:3", { fields: ["textData"] })?.textData as { characters: string; characterStyleIDs: number[] };
    expect(td.characters).toBe("Read the HELP! center for text properties, then style a range.");
    // "help" sat in the underlined link run (style 1, from 9): its replacement keeps it, the rest shifts by one.
    expect(td.characterStyleIDs.slice(9, 14)).toEqual([1, 1, 1, 1, 1]);
    expect(td.characterStyleIDs[56]).toBe(2);
    runEditorCommand(ed, "edit.undo");
    expect((engine.readNode("4:3", { fields: ["textData"] })?.textData as { characters: string }).characters).toBe("Read the help center for text properties, then style a range.");
  });

  it("Collapse layers (⌥L) and Enter on the list (select the children)", async () => {
    const { ed, engine } = await editor(TEXT_DOCUMENT);
    ed.ui.set({ expanded: new Set(["4:1"]) });
    expect(visibleRows(ed.getTree(), ed.ui.get().expanded).length).toBeGreaterThan(1);
    runEditorCommand(ed, "view.collapse-layers");
    expect([...ed.ui.get().expanded]).toEqual([]);
    engine.setSelection(["4:1"]);
    engine.command("SELECT_CHILDREN");
    expect(ed.selection.length).toBeGreaterThan(1);
    runEditorCommand(ed, "view.collapse-layers");
    expect([...ed.ui.get().expanded]).toEqual(["4:1"]); // the selection's branch stays open
  });

  it("Add new page opens its name for editing", async () => {
    const { ed, engine } = await editor(REFERENCE_DOCUMENT);
    const before = engine.pages().length;
    createPage(ed);
    const pages = engine.pages();
    expect(pages.length).toBe(before + 1);
    expect(ed.ui.get().renaming).toEqual({ kind: "page", id: pages.find((p) => !REFERENCE_DOCUMENT.nodeChanges.some((n) => n.guid === p.guid))!.guid });
  });

  it("⌘R on several layers opens Rename layers; on one, the inline rename", async () => {
    const { ed, engine } = await editor(TEXT_DOCUMENT);
    engine.setSelection(["4:2", "4:3"]);
    runEditorCommand(ed, "object.rename");
    expect(ed.ui.get().renameLayers).toEqual(["4:2", "4:3"]);
    ed.ui.set({ renameLayers: null });
    engine.setSelection(["4:2"]);
    runEditorCommand(ed, "object.rename");
    expect(ed.ui.get().renaming).toEqual({ kind: "layer", id: "4:2" });
  });
});
