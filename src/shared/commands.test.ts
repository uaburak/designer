import { describe, expect, it } from "vitest";
import { COMMANDS, isCommandId, layoutCommands, MENU_LAYOUT, registersAccelerator } from "./commands";

describe("the command registry", () => {
  it("has unique ids, each placed once in the menu bar", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const placed = layoutCommands();
    expect(new Set(placed).size).toBe(placed.length);
    for (const id of placed) expect(isCommandId(id)).toBe(true);
    // Everything but the app menu's theme (main's own menu) is in the bar.
    const unplaced = ids.filter((id) => !placed.includes(id));
    expect(unplaced.sort()).toEqual(["app.theme-dark", "app.theme-light", "app.theme-system"]);
  });

  it("is Figma's menu bar without Plugins and Widgets", () => {
    expect(Object.keys(MENU_LAYOUT)).toEqual(["File", "Edit", "View", "Object", "Text", "Arrange", "Vector", "Window", "Help"]);
  });

  it("registers only accelerators with ⌘ or ⌃ (the page keeps plain keys)", () => {
    expect(registersAccelerator("CmdOrCtrl+G")).toBe(true);
    expect(registersAccelerator("Ctrl+Alt+H")).toBe(true);
    expect(registersAccelerator("Ctrl+Tab")).toBe(true);
    expect(registersAccelerator("Shift+R")).toBe(false);
    expect(registersAccelerator("Alt+A")).toBe(false);
    expect(registersAccelerator("Backspace")).toBe(false);
    expect(registersAccelerator(undefined)).toBe(false);
  });
});
