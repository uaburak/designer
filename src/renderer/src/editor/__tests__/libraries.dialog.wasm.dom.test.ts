// @vitest-environment happy-dom
/**
 * Manage libraries laid out as live Figma's (docs/research/figma/live/2026-10-18/menus.txt "MANAGE LIBRARIES"), on the
 * real engine (headless Wasm) and the MemoryStore: the draggable 591 × 641 modal with its small header; the nav's
 * "Search all libraries", This file / Updates, Browse libraries (no UI kits); the publish banner for an unpublished
 * file, the current file's row once published; "Libraries added to this file" with thumbnails and Remove. And Dev
 * Mode's eyedropper: a pick copies the colour (in the colour format) instead of filling the selection.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message } from "@/engine/codec";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { encodeMessage } from "@shared/schema/codec";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { EditorContext, EditorController } from "../controller";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { draftPublish, publishLibrary, setLibraryEnabled } from "../libraries";
import { applyPickedColor } from "../canvasTools";
import { LibrariesDialog } from "../panels/libraries/LibrariesDialog";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 30)));
};

const EMPTY: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: COMPONENTS_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1") };

async function workspace() {
  const store = await MemoryStore.open({ storage: memoryStorage() });
  const api = store.api({});
  const team = await api.workspace.createFolder({ name: "Team", parentId: null });
  const file = async (name: string, doc: Message) => (await store.addFile({ name, folderId: team.id, snapshot: encodeMessage(messageToKiwi(doc)) })).fileKey;
  const open = async (fileKey: string) => {
    const source = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
    const engine = await Engine.create(null, { sessionID: source.sessionID });
    engine.load(await source.load());
    engine.setViewport(1280, 800, 1, 1280, 800);
    const ed = new EditorController(engine, new EngineStore(engine), source);
    engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
    await ed.libraries.refresh();
    return { ed, engine, source };
  };
  return { file, open };
}

const show = (ed: EditorController) => {
  ed.ui.set({ librariesDialog: { tab: "libraries" } });
  view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(LibrariesDialog)), {});
};

describe("Manage libraries as live Figma's", () => {
  it("the shell, the nav, the publish banner, the added libraries with Remove, the published file's row", async () => {
    const w = await workspace();
    const kitKey = await w.file("Kit", COMPONENTS_DOCUMENT);
    const kit = await w.open(kitKey);
    const d = await draftPublish(kit.ed);
    await publishLibrary(kit.ed, d, { description: "", selected: new Set(d.items.map((i) => i.key)), moveModes: new Map() });
    const app = await w.open(await w.file("App", EMPTY));
    await setLibraryEnabled(app.ed, kitKey, true);

    show(app.ed);
    await settle();
    const dialog = $('[data-ds="Dialog"]');
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect($("h2", dialog).textContent).toBe("Manage libraries");
    // Draggable by its header (the shared drag: ds/__tests__/drag.dom.test.ts)
    expect($("h2", dialog).parentElement!.className).toMatch(/draggable/);
    expect($("[data-libraries-search] input").getAttribute("placeholder")).toBe("Search all libraries");
    expect($$('[role="tab"]').map((b) => b.textContent)).toEqual(["This file", "Updates", "Teams"]);
    expect($("[data-libraries-dialog] nav").textContent).toContain("Browse libraries");
    expect($("[data-libraries-dialog] nav").textContent).not.toContain("UI kits");

    // Not published: the banner and Publish this file
    const banner = $("[data-publish-banner]");
    expect(banner.textContent).toContain("Publish your components as a library");
    expect([...banner.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Publish this file"]);
    expect(banner.querySelector("a")?.textContent).toBe("Learn more");

    // Libraries added to this file: a 102 × 58 thumbnail, the name, Remove
    const added = $('section[aria-label="Libraries added to this file"]');
    expect(added.textContent).toContain("Libraries added to this file");
    const row = $("[data-library-row='Kit']", added);
    expect(row.querySelector("[data-library-thumb]")).toBeTruthy();
    const remove = [...row.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
    expect(remove).toBeTruthy();
    await act(async () => remove.click());
    await settle();
    expect(app.ed.libraries.get().enabled).toEqual([]);
    expect($('section[aria-label="Libraries added to this file"]').textContent).toContain("No libraries added to this file");
    view!.unmount();
    view = null;

    // The published library itself: its row (Publish changes…), no banner
    show(kit.ed);
    await settle();
    expect($("[data-publish-banner]")).toBeNull();
    const current = $("[data-library-row='current']");
    expect([...current.querySelectorAll("button")].map((b) => b.textContent)).toContain("Publish changes…");
  });
});

describe("Dev Mode's eyedropper", () => {
  it("copies the picked colour (in the colour format) and leaves the selection's fill; Design mode fills it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const w = await workspace();
    const { ed, engine } = await w.open(await w.file("Kit", COMPONENTS_DOCUMENT));
    const layer = COMPONENTS_DOCUMENT.nodeChanges.find((n) => n.parentIndex?.guid === "0:1")!.guid;
    engine.setSelection([layer]);
    const fills = () => JSON.stringify((engine.readNode(layer) as { fillPaints?: unknown }).fillPaints ?? null);
    const before = fills();
    ed.ui.set({ mode: "dev" });
    applyPickedColor(ed, { r: 1, g: 0, b: 0 });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0]).toUpperCase()).toContain("FF0000");
    expect(fills()).toBe(before);
    expect(ed.store.undo.canUndo).toBe(false);
    ed.ui.set({ mode: "design" });
    applyPickedColor(ed, { r: 1, g: 0, b: 0 });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(fills()).not.toBe(before);
  });
});
