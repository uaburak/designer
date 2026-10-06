import { describe, expect, it } from "vitest";
import { keys } from "../util/keys";

describe("keys()", () => {
  it("writes Apple's modifier order ⌃⌥⇧⌘ on a Mac", () => {
    expect(keys(["mod", "shift", "h"], true)).toBe("⇧⌘H");
    expect(keys(["mod", "alt", "g"], true)).toBe("⌥⌘G");
    expect(keys(["shift", "ctrl", "alt", "mod", "k"], true)).toBe("⌃⌥⇧⌘K");
    expect(keys(["backspace"], true)).toBe("⌫");
  });
  it("writes Ctrl+Alt+Shift+X elsewhere", () => {
    expect(keys(["mod", "shift", "h"], false)).toBe("Ctrl+Shift+H");
    expect(keys(["shift", "alt", "mod", "g"], false)).toBe("Ctrl+Alt+Shift+G");
    expect(keys(["enter"], false)).toBe("Enter");
  });
});
