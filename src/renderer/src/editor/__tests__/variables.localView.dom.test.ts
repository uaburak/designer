// @vitest-environment happy-dom
// The Local variables window against Figma (owner's HeroUI comparison, 2026-10-22): the modal (Minimize) is a floating
// window moved by its header, resized by its edges, closed by × or Esc, with "Variables" over the sidebar and no Share;
// every column resizes by its header's right edge, per collection; one mode still named "Mode 1" reads "Value"; group
// headers are breadcrumbs (parents secondary, the group strong); a group's own variables come before its subgroups;
// variables keep the file's order (sortPosition, ties in document order — never A to Z).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $$, click, key, mount, pointer, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { VARIABLES_DOCUMENT } from "../fixtures";
import { LocalVariables, resetLocalVariablesSession } from "../panels/variables/LocalVariables";
import { addMode, createCollection, createVariable, renameVariable } from "../variables";
import { byDocumentOrder, tableOrder, type Variable } from "../model/variables";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let view: Mounted | null = null;
beforeEach(() => resetLocalVariablesSession());
afterEach(() => {
  view?.unmount();
  view = null;
  document.body.innerHTML = "";
});

async function editor() {
  const source = memoryDocumentSource(VARIABLES_DOCUMENT, { fileName: "HeroUI" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  ed.ui.set({ variablesOpen: true });
  return ed;
}
const show = (ed: EditorController) => {
  view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(LocalVariables)), {});
  return document.querySelector<HTMLElement>("[data-local-variables]")!;
};
const pick = (name: string) => act(() => document.querySelector<HTMLElement>(`[data-collection="${CSS.escape(name)}"]`)!.click());
const button = (root: Element, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** happy-dom lays nothing out: the window's box is its inline place and size. */
const boxFromStyle = (el: HTMLElement) => {
  el.getBoundingClientRect = () => new DOMRect(parseFloat(el.style.left), parseFloat(el.style.top), parseFloat(el.style.width), parseFloat(el.style.height));
};
const rectOf = (el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) });

describe("the Local variables modal (Figma's floating Variables window)", () => {
  it("opens centred with Variables, Search, Filter, Expand and × — no Share; moves by its header, resizes by its edges, × closes", async () => {
    const ed = await editor();
    const root = show(ed);
    // The whole-window view: the file's name over the sidebar, Share, Minimize.
    expect(root.textContent).toContain("HeroUI");
    expect($$("button", root).some((b) => b.textContent === "Share")).toBe(true);
    click(button(root, "Minimize")!);
    expect(root.dataset.minimized).toBe("true");
    // The modal: "Variables" over the sidebar, Expand (a plain icon button, not a pressed toggle), × and no Share.
    expect(root.textContent).toContain("Variables");
    expect(root.textContent).not.toContain("HeroUI");
    expect($$("button", root).some((b) => b.textContent === "Share")).toBe(false);
    const expand = button(root, "Expand")!;
    expect(expand.dataset.ds).toBe("IconButton");
    expect(expand.hasAttribute("aria-pressed")).toBe(false);
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button(root, "Close")).not.toBeNull();
    expect(root.querySelector('[role="search"], [data-ds="SearchField"], input[placeholder="Search"]')).not.toBeNull();
    // Centred in the window (happy-dom: 1024 × 768), kept 8 inside it.
    const start = rectOf(root);
    expect(Math.abs(start.x + start.w / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(start.y + start.h / 2 - window.innerHeight / 2)).toBeLessThanOrEqual(1);

    // Moved by the header (its empty part), not by its buttons.
    boxFromStyle(root);
    const header = root.querySelector<HTMLElement>("[data-modal-header]")!;
    pointer(header, "pointerdown", { clientX: start.x + 20, clientY: start.y + 20 });
    pointer(window as unknown as Element, "pointermove", { clientX: start.x - 30, clientY: start.y + 60 });
    pointer(window as unknown as Element, "pointerup", { clientX: start.x - 30, clientY: start.y + 60 });
    const moved = rectOf(root);
    expect(moved).toEqual({ ...start, x: start.x - 50, y: start.y + 40 });
    // Dragged past the window's edge: kept inside (8 in).
    boxFromStyle(root);
    pointer(header, "pointerdown", { clientX: moved.x + 20, clientY: moved.y + 20 });
    pointer(window as unknown as Element, "pointermove", { clientX: -500, clientY: -500 });
    pointer(window as unknown as Element, "pointerup", { clientX: -500, clientY: -500 });
    expect(rectOf(root).x).toBe(8);
    expect(rectOf(root).y).toBe(8);

    // Resized by the bottom-right corner and the left edge (down to 400 wide at most).
    const before = rectOf(root);
    const se = root.querySelector<HTMLElement>('[data-resize-edge="se"]')!;
    pointer(se, "pointerdown", { clientX: 0, clientY: 0 });
    pointer(window as unknown as Element, "pointermove", { clientX: -40, clientY: 30 });
    pointer(window as unknown as Element, "pointerup", { clientX: -40, clientY: 30 });
    expect(rectOf(root)).toEqual({ ...before, w: before.w - 40, h: before.h + 30 });
    const w = root.querySelector<HTMLElement>('[data-resize-edge="w"]')!;
    const mid = rectOf(root);
    pointer(w, "pointerdown", { clientX: 0, clientY: 0 });
    pointer(window as unknown as Element, "pointermove", { clientX: 2000, clientY: 0 });
    pointer(window as unknown as Element, "pointerup", { clientX: 2000, clientY: 0 });
    expect(rectOf(root)).toEqual({ ...mid, x: mid.x + mid.w - 400, w: 400 });

    // The place and size are kept for the session: closed with × and opened again, it comes back there as the modal.
    const kept = rectOf(root);
    click(button(root, "Close")!);
    expect(ed.ui.get().variablesOpen).toBe(false);
    view!.unmount();
    const again = show(ed);
    expect(again.dataset.minimized).toBe("true");
    expect(rectOf(again)).toEqual(kept);

    // The window shrinks: the modal stays inside it.
    act(() => {
      (window as unknown as { innerWidth: number }).innerWidth = 500;
      window.dispatchEvent(new Event("resize"));
    });
    const fitted = rectOf(again);
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(492);
    expect(fitted.x).toBeGreaterThanOrEqual(8);
    act(() => {
      (window as unknown as { innerWidth: number }).innerWidth = 1024;
      window.dispatchEvent(new Event("resize"));
    });

    // Esc closes it too; Expand brings back the whole window.
    click(button(again, "Expand")!);
    expect(again.dataset.minimized).toBeUndefined();
    expect(again.getAttribute("style")).toBeNull();
    ed.ui.set({ variablesOpen: true });
    key(again, "Escape");
    expect(ed.ui.get().variablesOpen).toBe(false);
  });
});

describe("the Local variables table", () => {
  it("resizes every column by its header's right edge, per collection, the + column kept", async () => {
    const ed = await editor();
    const root = show(ed);
    pick("Theme");
    const grid = () => root.querySelector<HTMLElement>('[role="grid"]')!.style.gridTemplateColumns;
    expect(grid()).toBe("200px 280px 280px minmax(0, 1fr) 40px");
    // The second mode's (Dark) edge: a column that isn't the first.
    const dark = root.querySelector<HTMLElement>('[data-mode-resize="Dark"]')!;
    pointer(dark, "pointerdown", { clientX: 1000 });
    pointer(dark, "pointermove", { clientX: 1100 });
    pointer(dark, "pointerup", { clientX: 1100 });
    expect(grid()).toBe("200px 280px 380px minmax(0, 1fr) 40px");
    // Light's edge, down past its minimum (120).
    const light = root.querySelector<HTMLElement>('[data-mode-resize="Light"]')!;
    pointer(light, "pointerdown", { clientX: 500 });
    pointer(light, "pointermove", { clientX: 100 });
    pointer(light, "pointerup", { clientX: 100 });
    expect(grid()).toBe("200px 120px 380px minmax(0, 1fr) 40px");
    // Each header is over the next one so its edge's outer half takes the pointer.
    const heads = $$('[role="columnheader"]', root).slice(0, 3).map((h) => Number((h as HTMLElement).style.zIndex));
    expect(heads[0]).toBeGreaterThan(heads[1]);
    expect(heads[1]).toBeGreaterThan(heads[2]);
    // Per collection: Primitives keeps its own; back on Theme, the widths are still there.
    pick("Primitives");
    expect(grid()).toBe("200px 280px minmax(0, 1fr) 40px");
    pick("Theme");
    expect(grid()).toBe("200px 120px 380px minmax(0, 1fr) 40px");
    expect(root.querySelector('[aria-label="New variable mode"]')).not.toBeNull();
  });

  it("one mode named Mode 1 reads Value; a renamed one or two modes show their names", async () => {
    const ed = await editor();
    const c = createCollection(ed, "Primitives 2")!;
    createVariable(ed, c, "COLOR", "");
    const root = show(ed);
    pick("Primitives 2");
    const headers = () => $$("[data-mode]", root).map((h) => h.textContent);
    expect(headers()).toEqual(["Value"]);
    expect($$("[data-mode]", root)[0].getAttribute("data-mode")).toBe("Mode 1");
    await act(async () => {
      addMode(ed, c);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(headers()).toEqual(["Mode 1", "Mode 2"]);
    // The fixture's Theme (Light / Dark).
    pick("Theme");
    expect(headers()).toEqual(["Light", "Dark"]);
  });

  it("draws group headers as breadcrumbs and lists a group's own variables before its subgroups", async () => {
    const ed = await editor();
    const root = show(ed);
    // Primitives: color/blue/500, color/blue/100, color/gray/900, color/gray/50, color/white (in that order), spacing, radius.
    const rows = () =>
      $$("[data-group-row], [data-name-cell]", root).map((el) => (el.hasAttribute("data-group-row") ? `# ${el.textContent}` : el.getAttribute("data-name-cell")));
    expect(rows()).toEqual([
      "# color",
      "color/white",
      "# color / blue",
      "color/blue/500",
      "color/blue/100",
      "# color / gray",
      "color/gray/900",
      "color/gray/50",
      "# spacing",
      "spacing/sm",
      "spacing/md",
      "spacing/lg",
      "# radius",
      "radius/md",
      "radius/lg",
    ]);
    const blue = root.querySelector('[data-group-row="color/blue"]')!;
    expect($$("[data-group-parent]", blue).map((s) => s.textContent)).toEqual(["color / "]);
    expect(blue.querySelector("[data-group-leaf]")?.textContent).toBe("blue");
    // Inside a group: its own variables first under no header, the subgroups relative to it.
    act(() => root.querySelector<HTMLElement>('[data-group="color"]')!.click());
    expect(rows().slice(0, 3)).toEqual(["color/white", "# blue", "color/blue/500"]);
  });

  it("keeps the file's order of groups and variables (never A to Z), in the table and the Groups tree", async () => {
    const ed = await editor();
    const c = createCollection(ed, "Order")!;
    for (const name of ["colors/common/blue/50", "colors/common/purple/50", "colors/common/white", "colors/common/red/50", "colors/common/green/50", "colors/common/cyan/50", "units/unit"]) {
      const id = createVariable(ed, c, "COLOR", "")!;
      renameVariable(ed, id, name);
    }
    const root = show(ed);
    pick("Order");
    expect($$("[data-group-row]", root).map((g) => g.getAttribute("data-group-row"))).toEqual([
      "colors/common",
      "colors/common/blue",
      "colors/common/purple",
      "colors/common/red",
      "colors/common/green",
      "colors/common/cyan",
      "units",
    ]);
    expect(root.querySelector('[data-group-row="colors/common"]')?.textContent).toBe("colors / common");
    expect($$("[data-group]", root).map((g) => g.getAttribute("data-group"))).toEqual([
      "",
      "colors",
      "colors/common",
      "colors/common/blue",
      "colors/common/purple",
      "colors/common/red",
      "colors/common/green",
      "colors/common/cyan",
      "units",
    ]);
  });
});

describe("variables' order (model)", () => {
  const v = (name: string, sortPosition: string, position: string, id = name): Variable =>
    ({ id, name, sortPosition, node: { guid: id, parentIndex: { guid: "0:2", position } } }) as unknown as Variable;

  it("ties in sortPosition (a .fig's) fall back to document order, not the name", () => {
    // HeroUI: green, red, yellow … all at "p"; their places among the internal canvas's children differ.
    const list = [v("c/red/50", "p", "|"), v("c/cyan/50", "p", "~3"), v("c/green/50", "p", "p"), v("c/purple/50", "d", "d")];
    expect([...list].sort(byDocumentOrder).map((x) => x.name)).toEqual(["c/purple/50", "c/green/50", "c/red/50", "c/cyan/50"]);
  });

  it("the table order: the tree depth first, a group's own variables before its subgroups", () => {
    const names = ["a/b/x", "a/y", "c", "a/b/z", "d/e/f", "a/w"];
    expect(tableOrder(names.map((name) => ({ name }))).map((x) => x.name)).toEqual(["c", "a/y", "a/w", "a/b/x", "a/b/z", "d/e/f"]);
  });
});
