// @vitest-environment happy-dom
// Extended collections at org scale (docs/data.md §16.8, round 3c) on the real engine (headless Wasm), each restriction
// checked: in an extension the Local variables window offers no Create variable or new mode, no rename of variables,
// modes or groups, no Edit variable (description, scoping), no Delete or Duplicate — only Copy and Reset change; values
// are edited as overrides (blue) and Reset change reverts; colour and opacity are one override; Import mode writes
// overrides only, never a mode; Delete mode only for a mode whose parent mode is gone. Chains: C extends B extends A,
// at most 16 deep ("Can't extend further"). The mode cap: past Figma's old 40, refused at 1,000 ("Limited to 1000 modes
// only").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { VARIABLES_DOCUMENT } from "../fixtures";
import { LocalVariables } from "../panels/variables/LocalVariables";
import { addMode, deleteMode, extendCollection, isOverridden, resetOverride, setVariableValue } from "../variables";
import { importIntoMode, modeFiles } from "../variablesIO";
import { extensionDepth, LIMITS, orphanMode } from "../model/variables";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("@/ds", async (orig) => ({ ...(await orig<typeof import("@/ds")>()), showToast: (o: { message: string }) => (toasts.push(o.message), 1) }));

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  document.body.innerHTML = "";
  toasts.length = 0;
});

const THEME = "7:2";
const BRAND = "5:20"; // a Theme colour variable

async function editor() {
  const source = memoryDocumentSource(VARIABLES_DOCUMENT, { fileName: "Tokens" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine };
}
const collection = (ed: EditorController, id: string) => ed.variables.get().lookup.collection(id)!;
const contextMenu = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
const menu = () => $$('#ds-overlays [role^="menuitem"]').map((el) => ({ label: el.textContent?.replace(/⌘.*|⇧.*/, "").trim(), disabled: el.getAttribute("aria-disabled") === "true" }));
const escape = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

describe("extended collections (docs/data.md §16.8)", () => {
  it("the Local variables window in an extension: values only — no create, rename, edit, delete or duplicate", async () => {
    const { ed, engine } = await editor();
    const ext = extendCollection(ed, THEME)!;
    const name = collection(ed, ext).name;
    view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(LocalVariables)), {});
    act(() => (document.querySelector(`[data-collection="${CSS.escape(name)}"]`) as HTMLElement).click());
    const root = document.querySelector("[data-local-variables]")!;
    expect(root.querySelector("[data-extended-from]")?.textContent).toBe("Extended from Theme");
    // No Create variable, no New variable mode, no Edit variable
    expect($$("button", root).some((b) => b.textContent?.includes("Create variable"))).toBe(false);
    expect(root.querySelector('[aria-label="New variable mode"]')).toBeNull();
    expect(root.querySelector('[aria-label="Edit variable"]')).toBeNull();
    // A variable's menu: Copy and Reset change only (no Edit, Rename, Duplicate, Delete)
    const row = root.querySelector(`[data-variable-row="${BRAND}"]`)!;
    contextMenu(row);
    expect(menu().map((e) => e.label)).toEqual(["Copy", "Reset change"]);
    expect(menu().find((e) => e.label === "Reset change")?.disabled).toBe(true);
    escape();
    // Double-click on a name doesn't rename
    act(() => row.querySelector("[data-name-cell]")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(row.querySelector("input")).toBeNull();
    // A mode's menu: rename, duplicate, default, move and delete disabled; Import / Export mode offered
    contextMenu(root.querySelector('[data-mode="Dark"]')!);
    const modes = Object.fromEntries(menu().map((e) => [e.label, e.disabled]));
    expect(modes).toMatchObject({ "Rename mode": true, "Duplicate mode": true, "Set as default": true, "Move column left": true, "Move column right": true, "Import mode": false, "Export mode": false, "Delete mode": true });
    escape();
    // A group's menu: rename, ungroup, duplicate, delete disabled
    const group = root.querySelector('[data-group]:not([data-group=""])');
    if (group) {
      contextMenu(group);
      const g = Object.fromEntries(menu().map((e) => [e.label, e.disabled]));
      expect(g).toMatchObject({ "Rename group": true, Ungroup: true, "Duplicate group": true, "Delete group": true });
      escape();
    }
    // The collection's menu: no Duplicate collection for an extension
    contextMenu(root.querySelector(`[data-collection="${CSS.escape(name)}"]`)!);
    expect(menu().find((e) => e.label === "Duplicate collection")?.disabled).toBe(true);
    escape();
    // Values: an edit is an override (blue); Reset change reverts it
    const dark = collection(ed, ext).modes[1].id;
    expect(setVariableValue(ed, BRAND, dark, { kind: "literal", value: { r: 1, g: 0, b: 0, a: 0.5 } })).toBe(true);
    expect(isOverridden(collection(ed, ext), BRAND, dark)).toBe(true);
    // Colour and opacity are one override: the alpha is in the same value
    expect(collection(ed, ext).overrides.get(BRAND)?.size).toBe(1);
    expect(collection(ed, ext).overrides.get(BRAND)?.get(dark)).toMatchObject({ kind: "literal", value: { r: 1, g: 0, b: 0, a: 0.5 } });
    expect(collection(ed, THEME).overrides.size).toBe(0);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    contextMenu(document.querySelector(`[data-variable-row="${BRAND}"]`)!);
    expect(menu().find((e) => e.label === "Reset change")?.disabled).toBe(false);
    escape();
    expect(resetOverride(ed, ext, BRAND, dark)).toBe(true);
    expect(isOverridden(collection(ed, ext), BRAND, dark)).toBe(false);
    engine.destroy();
  });

  it("Import mode into an extension writes overrides only, never a mode", async () => {
    const { ed, engine } = await editor();
    const ext = extendCollection(ed, THEME)!;
    const [light, dark] = collection(ed, ext).modes.map((m) => m.id);
    const themeModes = collection(ed, THEME).modes.length;
    // Theme's Light values, imported into the extension's Dark
    const file = modeFiles(ed, THEME, [collection(ed, THEME).modes[0].id])[0];
    const updated = importIntoMode(ed, ext, dark, file);
    expect(updated).toBeGreaterThan(0);
    const c = collection(ed, ext);
    expect(c.modes.map((m) => m.id)).toEqual([light, dark]);
    expect(collection(ed, THEME).modes).toHaveLength(themeModes);
    expect([...c.overrides.values()].some((m) => m.has(dark))).toBe(true);
    expect(collection(ed, THEME).overrides.size).toBe(0);
    engine.destroy();
  });

  it("Delete mode in an extension only for a mode whose parent mode was deleted", async () => {
    const { ed, engine } = await editor();
    const ext = extendCollection(ed, THEME)!;
    const parentDark = collection(ed, THEME).modes[1].id;
    const extDark = collection(ed, ext).modes[1].id;
    expect(orphanMode(collection(ed, ext), extDark)).toBe(false);
    deleteMode(ed, THEME, parentDark);
    // The extension keeps its mode (the parent's gone): now it may be removed
    const c = collection(ed, ext);
    expect(c.modes.some((m) => m.id === extDark)).toBe(true);
    expect(orphanMode(c, extDark)).toBe(true);
    expect(orphanMode(c, c.modes[0].id)).toBe(false);
    deleteMode(ed, ext, extDark);
    expect(collection(ed, ext).modes.some((m) => m.id === extDark)).toBe(false);
    engine.destroy();
  });

  it("chains: an extension may be extended, at most 16 deep (\"Can't extend further\")", async () => {
    const { ed, engine } = await editor();
    let top = THEME;
    for (let i = 1; i <= LIMITS.extensionDepth; i++) {
      const next = extendCollection(ed, top);
      expect(next, `level ${i}`).toBeTruthy();
      top = next!;
      expect(extensionDepth(collection(ed, top))).toBe(i);
    }
    expect(collection(ed, top).modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    expect(extendCollection(ed, top)).toBeNull();
    expect(toasts).toContain("Can't extend further");
    engine.destroy();
  });

  it("the mode cap: past 40 modes, refused at 1,000 with Figma's wording", async () => {
    const { ed, engine } = await editor();
    expect(LIMITS.modes).toBe(1000);
    for (let i = collection(ed, THEME).modes.length; i < 41; i++) expect(addMode(ed, THEME)).toBeTruthy();
    expect(collection(ed, THEME).modes).toHaveLength(41);
    // A collection at the cap (written as one change): the next is refused
    const c = collection(ed, THEME);
    const modes = Array.from({ length: 1000 }, (_, i) => ({ id: { sessionID: 9, localID: i + 1 }, name: `Mode ${i + 1}`, sortPosition: `a${String(i).padStart(4, "0")}` }));
    ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: c.id, variableSetModes: modes } as never] }, "user");
    ed.variables.invalidate();
    expect(collection(ed, THEME).modes).toHaveLength(1000);
    expect(addMode(ed, THEME)).toBeNull();
    expect(toasts).toContain("Limited to 1000 modes only");
    engine.destroy();
  });
});
