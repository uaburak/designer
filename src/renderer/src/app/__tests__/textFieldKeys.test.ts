import { describe, expect, it } from "vitest";
import { textFieldCommand } from "../textFieldKeys";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe("a text field's editing keys", () => {
  it("macOS: ⌘A selects all, ⌘Z undoes, ⇧⌘Z redoes; Ctrl does nothing", () => {
    expect(textFieldCommand(key("a", { metaKey: true }), true)).toBe("selectAll");
    expect(textFieldCommand(key("z", { metaKey: true }), true)).toBe("undo");
    expect(textFieldCommand(key("Z", { metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(textFieldCommand(key("a", { ctrlKey: true }), true)).toBeNull();
  });
  it("Windows / Linux: Ctrl+A, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z", () => {
    expect(textFieldCommand(key("a", { ctrlKey: true }), false)).toBe("selectAll");
    expect(textFieldCommand(key("y", { ctrlKey: true }), false)).toBe("redo");
    expect(textFieldCommand(key("z", { ctrlKey: true, shiftKey: true }), false)).toBe("redo");
  });
  it("other keys stay the page's: copy, paste, ⌥⌘A, plain letters", () => {
    expect(textFieldCommand(key("c", { metaKey: true }), true)).toBeNull();
    expect(textFieldCommand(key("a", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(textFieldCommand(key("a"), true)).toBeNull();
  });
});
