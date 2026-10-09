// Round 9 — menus, toolbar and left side (docs/editor.md "Round 9 — Menus, toolbar and left side"): the Figma menu,
// Preferences, the page row's and the canvas's menus, the Actions palette's list, the row glyphs' names — as plain
// data — and on the real engine (the committed Wasm build, headless in Node).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { keys, placeMenu, type MenuEntry, type MenuItem } from "@/ds";
import { shortcutKeys } from "@/ds/util/menu";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { PointerType } from "@/engine/abi";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMMAND_BY_ID, comboText, runEditorCommand } from "../commands";
import { MAIN_MENU, MAIN_MENU_WIDTH, actionItems, canvasMenu, mainMenu, pageMenu, runPageMenuItem, type ActionItem } from "../menus";
import { PREFERENCES, loadPreferences, pref } from "../preferences";
import { viewOptionsOf } from "../canvasTools";
import { actionRows } from "../panels/ActionsPanel";
import { layerKind } from "../panels/Layers";
import type { TreeNode } from "../model/layerTree";
import type { UIState } from "../uiStore";

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
  return { ed, engine };
}

const items = (entries: readonly MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => typeof e === "object" && "id" in e);
const labels = (entries: readonly MenuEntry[]) => items(entries).map((i) => i.label);
const subOf = (entries: readonly MenuEntry[], label: string) => items(entries).find((i) => i.label === label)!.items!;

describe("round 9: Preferences (live main-preferences.txt)", () => {
  it("lists live Figma's 23 checks in its order, with its defaults", () => {
    expect(PREFERENCES.map((p) => p.label)).toEqual([
      "Snap to geometry",
      "Snap to objects",
      "Snap to pixel grid",
      "Keep tool selected after use",
      "Highlight layers on hover",
      "Rename duplicated layers",
      "Show dimensions on objects",
      "Hide canvas UI during changes",
      "Use smart quotes/symbols",
      "Flip objects while resizing",
      "Keyboard zooms into selection",
      "Invert zoom direction",
      "Ctrl+click opens right click menus",
      "Use number keys for opacity",
      "Use old shortcuts for outlines",
      "Use ⌘⌥↑/↓ to rotate layers",
      "Play audio notifications in AI chat",
      "Open links in desktop app",
      "Show text suggestions",
      "Show tool suggestions",
      "Show Agents on canvas",
      "Use scroll wheel zoom",
      "Right-click and drag to pan",
    ]);
    const off = PREFERENCES.filter((p) => !p.on).map((p) => p.label);
    expect(off).toEqual(["Keep tool selected after use", "Keyboard zooms into selection", "Invert zoom direction", "Ctrl+click opens right click menus", "Use old shortcuts for outlines", "Use ⌘⌥↑/↓ to rotate layers", "Use scroll wheel zoom"]);
    for (const p of PREFERENCES) expect(COMMAND_BY_ID.has(p.id), p.id).toBe(true);
  });

  it("the submenu: the checks, lines where live has them, then Theme … Nudge amount…", () => {
    const prefs = (MAIN_MENU.find((s) => typeof s === "object" && "label" in s && s.label === "Preferences") as { items: unknown[] }).items;
    const ids = prefs.map((s) => (typeof s === "string" ? s : typeof s === "object" && s && "label" in s ? (s as { label: string }).label : "?"));
    expect(ids.indexOf("-")).toBe(3); // after Snap to pixel grid
    expect(ids.slice(-6)).toEqual(["Theme", "prefs.color-profile", "prefs.keyboard-layout", "prefs.accessibility", "prefs.permissions", "prefs.nudge-amount"]);
    expect(ids.filter((i) => i === "-")).toHaveLength(3);
  });

  it("kept per machine: only valid booleans load; the view flags follow (live defaults when unset)", () => {
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    g.localStorage = { getItem: () => JSON.stringify({ invertZoom: true, snapToObjects: false, bogus: true, keepToolSelected: "yes" }), setItem: () => {} };
    try {
      expect(loadPreferences()).toEqual({ invertZoom: true, snapToObjects: false });
    } finally {
      g.localStorage = saved;
    }
    const ui = { rulers: true } as UIState;
    expect(viewOptionsOf(ui)).toMatchObject({ snapToGeometry: true, snapToObjects: true, showDimensions: true, flipWhileResizing: true, rightDragPan: true, keepToolSelected: false, invertZoom: false, scrollWheelZoom: false, keyboardZoomsIntoSelection: false });
    expect(viewOptionsOf({ ...ui, invertZoom: true, rightDragPan: false } as UIState)).toMatchObject({ invertZoom: true, rightDragPan: false });
    expect(pref(ui, "numberKeysOpacity")).toBe(true);
  });
});

describe("round 9: the Figma menu (live menus/main-*.txt)", () => {
  it("keys as live writes them: ⎋, 🌐↑ / 🌐↓ (fn), ⌘0 for Zoom to 100%, ⇧/ for Remove stroke", () => {
    expect(keys(["escape"], true)).toBe("⎋");
    expect(keys(["pageup"], true)).toBe("🌐↑");
    expect(keys(["pagedown"], true)).toBe("🌐↓");
    expect(keys(["pageup"], false)).toBe("PgUp");
    expect(COMMAND_BY_ID.get("view.zoom-100")!.keys![0]).toEqual({ code: "Digit0", mod: true });
    expect(comboText(COMMAND_BY_ID.get("object.remove-stroke")!.keys![0])).toMatch(/\/$/);
    expect(comboText(COMMAND_BY_ID.get("help.shortcuts")!.keys![0])).toMatch(/\?$/);
  });

  it("a context menu's keys: one glyph per key", () => {
    expect(shortcutKeys("⇧⌘R")).toEqual(["⇧", "⌘", "R"]);
    expect(shortcutKeys("⌘⌫")).toEqual(["⌘", "⌫"]);
    expect(shortcutKeys("]")).toEqual(["]"]);
    expect(shortcutKeys("Ctrl+Shift+R")).toEqual(["Ctrl+Shift+R"]);
  });

  it("a submenu: 4 past the menu, live's 6 / 5 margins", () => {
    const view = { width: 1440, height: 900 };
    expect(placeMenu(210, 359, { width: 235, height: 763 }, view, 8, { top: 6, bottom: 5 })).toEqual({ x: 210, y: 132 });
    expect(placeMenu(210, 154, { width: 185, height: 1050 }, view, 8, { top: 6, bottom: 5 })).toEqual({ x: 210, y: 6 });
  });

  it("its entries: Actions… with its glyph and ⌘K, Open in desktop app, every submenu open with a layer selected", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["1:2"]);
    const main = mainMenu(ed);
    expect(labels(main)).toEqual(["Back to files", "Actions…", "File", "Edit", "View", "Object", "Text", "Arrange", "Vector", "Plugins", "Widgets", "Preferences", "Libraries", "Open in desktop app", "Help and account"]);
    expect(MAIN_MENU_WIDTH).toBe(194);
    const actions = items(main).find((i) => i.id === "tool.actions")!;
    expect(actions.disabled).toBe(false);
    expect(actions.icon).toBe("24.actions");
    expect(actions.shortcut).toMatch(/K$/);
    expect(actions.checked).toBeUndefined();
    for (const l of ["Text", "Arrange", "Vector", "Plugins", "Widgets", "Libraries"]) expect(items(main).find((i) => i.label === l)!.disabled, l).toBeFalsy();
    // File: New Design, New ▸ (no Share preview); View: Additional labels once, Switch to Dev Mode.
    expect(labels(subOf(main, "File")).slice(0, 2)).toEqual(["New Design", "New"]);
    expect(labels(subOf(main, "File"))).not.toContain("Share preview…");
    const view = labels(subOf(main, "View"));
    expect(view.filter((l) => l === "Additional labels")).toHaveLength(1);
    expect(view).toContain("Switch to Dev Mode");
    // Object: Reset instance and Delete contents, no Rename.
    const object = labels(subOf(main, "Object"));
    expect(object).toContain("Reset instance");
    expect(object.at(-1)).toBe("Delete contents");
    expect(object).not.toContain("Rename");
    // Text: Case, Text direction, Spell check, Show text suggestions (checked).
    const text = subOf(main, "Text");
    expect(labels(text).slice(-6)).toEqual(["Alignment", "Adjust", "Case", "Text direction", "Spell check", "Show text suggestions"]);
    expect(items(text).at(-1)!.checked).toBe(true);
    expect(labels(subOf(main, "Vector"))).toEqual(["Join selection", "Smooth join selection", "Delete and heal selection", "Split vector", "Simplify vector", "Offset vector"]);
    expect(labels(subOf(main, "Help and account"))).toEqual(["Help page", "Keyboard shortcuts", "Support forum", "Video tutorials", "Release notes", "Open font settings", "Legal summary", "Account settings", "Log out"]);
    expect(labels(subOf(main, "Plugins"))).toEqual(["Run last plugin", "Saved plugins", "Manage plugins…"]);
    expect(labels(subOf(main, "Widgets"))).toEqual(["Manage widgets…", "Select all widgets"]);
    // Preferences: checks drawn (live labels at 32); Edit / Object without.
    expect(items(subOf(main, "Preferences")).find((i) => i.label === "Snap to geometry")!.checked).toBe(true);
    expect(items(subOf(main, "Preferences")).find((i) => i.label === "Keep tool selected after use")!.checked).toBe(false);
    expect(items(subOf(main, "Object")).some((i) => i.checked !== undefined)).toBe(false);
  });

  it("Preferences › Keep tool selected after use: a shape tool stays after a draw (engine flag)", async () => {
    const { ed, engine } = await editor();
    const draw = (x: number) => {
      runEditorCommand(ed, "tool.rectangle");
      engine.pointer(PointerType.DOWN, x, 500, 0, 1, 0);
      engine.pointer(PointerType.MOVE, x + 60, 560, 0, 1, 0);
      engine.pointer(PointerType.UP, x + 60, 560, 0, 0, 0);
    };
    draw(700);
    expect(ed.store.tool).toBe("MOVE");
    expect(runEditorCommand(ed, "prefs.keep-tool-selected")).toBe(true);
    expect(pref(ed.ui.get(), "keepToolSelected")).toBe(true);
    draw(900);
    expect(ed.store.tool).toBe("RECTANGLE");
  });

  it("the canvas menu: no check column, no Create multiple components", async () => {
    const { ed, engine } = await editor();
    expect(items(canvasMenu(ed, [])).some((i) => i.checked !== undefined)).toBe(false);
    engine.setSelection(["1:2", "1:3"]);
    const multi = labels(canvasMenu(ed, []));
    expect(multi).toContain("Create component");
    expect(multi).not.toContain("Create multiple components");
    expect(items(canvasMenu(ed, [])).some((i) => i.checked !== undefined)).toBe(false);
  });

  it("a page row's menu: Copy link to page │ Rename page, Duplicate page │ Move up / down │ Delete page", async () => {
    const { ed, engine } = await editor();
    expect(engine.command("CREATE_PAGE")).toBe(0);
    const pages = ed.store.pages.map((p) => p.guid);
    expect(pages.length).toBe(2);
    expect(labels(pageMenu(ed, pages[0]))).toEqual(["Copy link to page", "Rename page", "Duplicate page", "Move down", "Delete page"]);
    expect(labels(pageMenu(ed, pages[1]))).toEqual(["Copy link to page", "Rename page", "Duplicate page", "Move up", "Delete page"]);
    expect(pageMenu(ed, pages[1]).filter((e) => e === "-")).toHaveLength(3);
    expect(runPageMenuItem(ed, pages[1], "page:move-up")).toBe(true);
    expect(ed.store.pages.map((p) => p.guid)).toEqual([pages[1], pages[0]]);
  });
});

describe("round 9: the Actions palette (live toolbar/actions-panel.txt)", () => {
  it("⌘K, the toolbar's Actions and Actions… open it", async () => {
    const { ed } = await editor();
    expect(runEditorCommand(ed, "tool.actions")).toBe(true);
    expect(ed.ui.get().actionsOpen).toBe(true);
    expect(runEditorCommand(ed, "tool.actions")).toBe(true);
    expect(ed.ui.get().actionsOpen).toBe(false);
  });

  it("lists the Figma menu's commands by submenu, then the tools; Recents first; a query finds the best first", async () => {
    const { ed } = await editor();
    const list = actionItems(ed);
    expect(list.some((a) => a.id === "tool.actions")).toBe(false);
    expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
    expect(list.find((a) => a.id === "vector.flatten")!.section).toBe("Object");
    expect(list.find((a) => a.id === "view.dev-mode")!.label).toBe("Switch to Dev Mode");
    expect(list.at(-1)!.section).toBe("Tools");
    const run = () => true;
    const rows = actionRows(list, "", ["view.zoom-fit"], run);
    expect(rows[0]).toMatchObject({ section: "Recents", label: "Zoom to fit" });
    expect(rows[1].section).toBe("File");
    const found = actionRows(list, "flat", [], run);
    expect(found[0].label).toBe("Flatten");
    const some: ActionItem[] = [
      { id: "a", label: "Paste over selection", section: "Edit", disabled: false },
      { id: "b", label: "Select all", section: "Edit", disabled: false },
      { id: "c", label: "Selection colors", section: "View", disabled: false },
    ];
    expect(actionRows(some, "sel", [], run).map((r) => r.label)).toEqual(["Select all", "Paste over selection", "Selection colors"]);
  });
});

describe("round 9: the row glyphs' names (live left/layers-row-hover.txt)", () => {
  const row = (n: Partial<TreeNode>) => ({ type: "RECTANGLE", group: false, stateGroup: false, ...n }) as TreeNode;
  it("reads Frame, Auto layout, Component, Variant, Instance, Text, Section, Group, Rectangle, Union, Line…", () => {
    expect(layerKind(row({ type: "FRAME" }))).toBe("Frame");
    expect(layerKind(row({ type: "FRAME", stackMode: "GRID" }))).toBe("Auto layout");
    expect(layerKind(row({ type: "FRAME", stateGroup: true }))).toBe("Component");
    expect(layerKind(row({ type: "SYMBOL" }), row({ type: "FRAME", stateGroup: true }))).toBe("Variant");
    expect(layerKind(row({ type: "SYMBOL" }), row({ type: "FRAME" }))).toBe("Component");
    expect(layerKind(row({ type: "INSTANCE" }))).toBe("Instance");
    expect(layerKind(row({ type: "FRAME", group: true }))).toBe("Group");
    expect(layerKind(row({ type: "BOOLEAN_OPERATION", booleanOperation: "UNION" }))).toBe("Union");
    expect(layerKind(row({ type: "LINE" }))).toBe("Line");
    expect(layerKind(row({ type: "ROUNDED_RECTANGLE" }))).toBe("Rectangle");
    expect(layerKind(row({ type: "REGULAR_POLYGON" }))).toBe("Polygon");
  });
});
