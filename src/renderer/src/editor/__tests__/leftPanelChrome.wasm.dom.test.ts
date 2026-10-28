// @vitest-environment happy-dom
// The left panel's chrome on the real engine (the committed Wasm build): Pages reorder by drag as Layers do (the
// insertion line, one undo step, Esc cancels), a hidden layer's row and its layers' rows dimmed (data-hidden), the
// lines under the Layers header and a pinned row while rows scroll under them, and the file name renamed by a
// double-click — no location line under it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, box, key, mount, pointer, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { Pages, createPage } from "../panels/Pages";
import { Layers } from "../panels/Layers";
import { FileHeader } from "../panels/LeftPanel";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const cleanups: (() => void)[] = [];
let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = "";
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  cleanups.push(() => engine.destroy());
  ed.ui.set({ fileName: "Test" });
  return { ed, engine, source };
}

function show(ed: EditorController, panel: ComponentType) {
  const Host = () => createElement(EditorContext.Provider, { value: ed }, createElement(panel));
  m = mount(Host, {});
}

/** A frame or two: the Layers tree refreshes at the next animation frame. */
const frames = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));

/** The page rows laid out as the panel draws them: 24 high, 8 apart, from y 104 in a list from 100. */
function layoutPages() {
  const rows = $$('[data-ds="PageRow"]');
  box(rows[0].parentElement!, { left: 0, top: 100, width: 240, height: 400 });
  rows.forEach((r, i) => box(r, { left: 8, top: 104 + i * 32, width: 224, height: 24 }));
  return rows;
}

const pageNames = (engine: Engine) => engine.pages().map((p) => p.name);

describe("Pages: drag to reorder (as the Layers panel)", () => {
  it("draws the insertion line where the page goes, moves it on drop in one undo step, and doesn't go to it", async () => {
    const { ed, engine } = await editor();
    createPage(ed);
    createPage(ed);
    ed.ui.set({ renaming: null });
    const names = pageNames(engine);
    expect(names).toHaveLength(3);
    engine.setCurrentPage(engine.pages()[2].guid);
    show(ed, Pages);
    const rows = layoutPages();
    pointer(rows[0], "pointerdown", { clientX: 40, clientY: 116 });
    pointer(document.body, "pointermove", { clientX: 40, clientY: 117 }); // under the threshold: no drag yet
    expect($$("[data-drop]")).toHaveLength(0);
    pointer(document.body, "pointermove", { clientX: 40, clientY: 155 }); // past the second row's middle (148)
    expect(rows[2].dataset.drop).toBe("before");
    pointer(document.body, "pointermove", { clientX: 40, clientY: 190 }); // past the last row's middle
    expect(rows[2].dataset.drop).toBe("after");
    expect($$("[data-drop]")).toHaveLength(1);
    const current = $('[aria-current="page"]').dataset.id;
    pointer(document.body, "pointerup", { clientX: 40, clientY: 190 });
    act(() => rows[0].click()); // the release's click: the drag's, not a page change
    expect(pageNames(engine)).toEqual([names[1], names[2], names[0]]);
    expect($('[aria-current="page"]').dataset.id).toBe(current);
    expect($$("[data-drop]")).toHaveLength(0);
    act(() => void engine.command("UNDO"));
    expect(pageNames(engine)).toEqual(names);
  });

  it("Esc cancels the drag: no line, nothing moved", async () => {
    const { ed, engine } = await editor();
    createPage(ed);
    createPage(ed);
    ed.ui.set({ renaming: null });
    const names = pageNames(engine);
    show(ed, Pages);
    const rows = layoutPages();
    pointer(rows[0], "pointerdown", { clientX: 40, clientY: 116 });
    pointer(document.body, "pointermove", { clientX: 40, clientY: 190 });
    expect($$("[data-drop]")).toHaveLength(1);
    key(document.body, "Escape");
    expect($$("[data-drop]")).toHaveLength(0);
    pointer(document.body, "pointerup", { clientX: 40, clientY: 190 });
    expect(pageNames(engine)).toEqual(names);
  });

  it("scrolls the list while the pointer is near or past its edge", async () => {
    const { ed } = await editor();
    for (let i = 0; i < 4; i++) createPage(ed);
    ed.ui.set({ renaming: null });
    show(ed, Pages);
    const rows = layoutPages();
    const list = rows[0].parentElement!;
    let top = 0;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (n: number) => (top = Math.max(0, n)) });
    pointer(rows[0], "pointerdown", { clientX: 40, clientY: 116 });
    pointer(document.body, "pointermove", { clientX: 40, clientY: 300 });
    expect(top).toBe(0);
    pointer(document.body, "pointermove", { clientX: 40, clientY: 520 }); // 20 past the list's bottom (500)
    expect(top).toBeGreaterThan(0);
    pointer(document.body, "pointerup", { clientX: 40, clientY: 520 });
  });
});

describe("Layers: hidden rows and the lines over scrolled rows", () => {
  it("dims a hidden layer's row and the rows inside it (its own eye kept closed, theirs open)", async () => {
    const { ed, engine } = await editor();
    engine.setProps(["1:1"], { visible: false });
    ed.ui.set({ expanded: new Set(["1:1"]) });
    show(ed, Layers);
    await frames();
    const row = (id: string) => $(`[data-ds="LayerRow"][data-id="${id}"]`);
    expect(row("1:1").dataset.hidden).toBe("");
    expect(row("1:2").dataset.hidden).toBe("inherited");
    expect(row("1:10").dataset.hidden).toBeUndefined();
    expect(row("1:2").className).toMatch(/hiddenLayer/); // the hidden row's dimming: name and glyph
    expect(row("1:10").className).not.toMatch(/hiddenLayer/);
    expect($('[data-cell="visible"]', row("1:1")).getAttribute("aria-pressed")).toBe("true");
    expect($('[data-cell="visible"]', row("1:2")).getAttribute("aria-pressed")).toBe("false");
  });

  it("draws the header's line and the pinned row's only while rows are scrolled under them", async () => {
    const { ed } = await editor();
    ed.ui.set({ expanded: new Set(["1:1"]) });
    show(ed, Layers);
    await frames();
    const list = $("[data-layer-list]");
    const viewport = $('[data-layer-list] [data-ds="VirtualList"]').parentElement as HTMLElement;
    const scrollTo = (y: number) =>
      act(() => {
        Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => y });
        viewport.dispatchEvent(new Event("scroll", { bubbles: false }));
      });
    expect(list.dataset.scrolled).toBeUndefined();
    expect($("[data-sticky-row]").dataset.stuck).toBeUndefined();
    expect($("[data-sticky-row] [data-ds=LayerRow]").dataset.id).toBe("1:1");
    scrollTo(100); // rows under the header, none yet under Desktop's row (the seventh, at 192)
    expect(list.dataset.scrolled).toBe("");
    expect($("[data-sticky-row]").dataset.stuck).toBeUndefined();
    scrollTo(250); // past Desktop's row: its layers under it
    expect(list.dataset.scrolled).toBe("");
    expect($("[data-sticky-row]").dataset.stuck).toBe("");
    scrollTo(0);
    expect(list.dataset.scrolled).toBeUndefined();
    expect($("[data-sticky-row]").dataset.stuck).toBeUndefined();
  });
});

describe("File header: the name, no location; a double-click renames, the chevron opens the menu", () => {
  it("shows no location line, the chevron opens Edit file menu, a double-click on the name renames (Enter commits, Esc cancels)", async () => {
    const { ed, source } = await editor();
    show(ed, FileHeader);
    expect(m!.host.textContent).not.toContain("Drafts");
    const button = $('[data-file-name] [data-ds="MenuButton"]');
    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    act(() => button.click());
    expect(button.getAttribute("aria-label")).toBe("Edit file menu");
    act(() => $("[data-file-name] > button:first-child").click());
    expect($("input")).toBeNull();
    act(() => void $("[data-file-name] > button:first-child").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = $("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Test");
    key(input, "Escape");
    expect($("input")).toBeNull();
    expect(ed.ui.get().fileName).toBe("Test");

    act(() => void $("[data-file-name] > button:first-child").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const field = $("input") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "Renamed");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(field, "Enter");
    expect(ed.ui.get().fileName).toBe("Renamed");
    expect(source.fileName).toBe("Renamed");
    expect($("input")).toBeNull();
  });
});
