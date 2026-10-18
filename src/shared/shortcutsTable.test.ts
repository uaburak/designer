import { describe, expect, it } from "vitest";
import { allTableBindings, holds, parseTableKeys, TABLE_ACTIONS, tableBindings, type TableContext } from "./shortcutsTable";

const MAC: TableContext = { mac: true, editor: "design", layout: "unknown", desktop: true, numbersForOpacity: true, oldOutlineShortcuts: false, flags: [] };
const keysOf = (action: string, ctx: Partial<TableContext> = {}) => tableBindings(action, { ...MAC, ...ctx });

describe("Figma's keyboard shortcut table (Atlas 03 §6)", () => {
  it("is the table its editor carries: 260 actions, 1 183 bindings, bindings for 16 of its 18 layouts (none for Finnish and Chinese)", () => {
    expect(TABLE_ACTIONS).toHaveLength(260);
    const all = allTableBindings();
    expect(all).toHaveLength(1183);
    const layouts = new Set(all.flatMap((b) => b.conditions).filter((c) => c.startsWith("layout:")));
    expect(layouts.size).toBe(16);
    expect(layouts.has("layout:finnish")).toBe(false);
    expect(layouts.has("layout:chinese")).toBe(false);
  });

  it("reads keys as Figma writes them: modifiers, then a character or a named key", () => {
    expect(parseTableKeys("Meta+Shift+=")).toEqual({ key: "=", meta: true, shift: true });
    expect(parseTableKeys("Meta++")).toEqual({ key: "+", meta: true });
    expect(parseTableKeys("Control+Num +")).toEqual({ key: "Num +", control: true });
    expect(parseTableKeys("+")).toEqual({ key: "+" });
    expect(parseTableKeys("Page Up")).toEqual({ key: "Page Up" });
  });

  it("holds a binding's conditions: platform, editor, layout, preference, flag; other hosts never", () => {
    expect(holds("mac", MAC)).toBe(true);
    expect(holds("!mac", MAC)).toBe(false);
    expect(holds("design", MAC)).toBe(true);
    expect(holds("!figjam", MAC)).toBe(true);
    expect(holds("dev_handoff", MAC)).toBe(false);
    expect(holds("layout:unknown", MAC)).toBe(true);
    expect(holds("layout:german", MAC)).toBe(false);
    expect(holds("pref:use-numbers-for-opacity", MAC)).toBe(true);
    expect(holds("flag:metronome", MAC)).toBe(false);
    expect(holds("flag:metronome", { ...MAC, flags: ["metronome"] })).toBe(true);
    expect(holds("safari", MAC)).toBe(false);
    expect(holds("!safari", MAC)).toBe(true);
  });

  it("gives an action's bindings that hold, in the table's order, with what menus show", () => {
    // Actions… ⌘K ⌘/ ⌘P (the main menu shows the first).
    expect(keysOf("toggle-menu").map((b) => b.key)).toEqual(["K", "/", "P"]);
    // Zoom in: ⇧⌘= shown ⌘+ first.
    const zoom = keysOf("zoom-in");
    expect(zoom[0]).toMatchObject({ key: "=", meta: true, shift: true, display: { key: "+", meta: true } });
    // The number keys move with the preference.
    expect(keysOf("zoom-to-fit").map((b) => `${b.shift ? "⇧" : ""}${b.key}`)).toEqual(["⇧1", "⇧9"]);
    expect(keysOf("zoom-to-fit", { numbersForOpacity: false }).map((b) => `${b.shift ? "⇧" : ""}${b.key}`)).toEqual(["1", "9"]);
    // Edit modes: inert while typing, or out of vector edit mode.
    expect(keysOf("bring-forward")[0].except).toEqual(["TEXT", "VECTOR"]);
    // German: ⌘Ä bring forward, ⌘, Actions.
    expect(keysOf("bring-forward", { layout: "german" })[0]).toMatchObject({ key: "Ä", meta: true });
    expect(keysOf("toggle-menu", { layout: "german" }).map((b) => b.key)).toEqual([",", "P"]);
    // Windows: Ctrl, and Ctrl+Y for Redo first.
    expect(keysOf("redo", { mac: false }).map((b) => `${b.control ? "Ctrl+" : ""}${b.shift ? "Shift+" : ""}${b.key}`)).toEqual(["Ctrl+Y", "Ctrl+Shift+Z"]);
  });
});
