import { describe, expect, it } from "vitest";
import { acceleratorFor, comboToAccelerator, DEFAULT_SHORTCUT_SETTINGS, KEYBOARD_LAYOUTS, sanitizeShortcutSettings, sameCombo } from "./shortcuts";
import { registersAccelerator, runsFromMenuBar } from "./commands";

describe("the user's keyboard shortcuts (settings.json)", () => {
  it("lists Figma's keyboard layouts, Generic first (the default)", () => {
    expect(KEYBOARD_LAYOUTS.map((l) => l.label)).toEqual([
      "Generic",
      "Chinese",
      "Danish",
      "Finnish",
      "French AZERTY",
      "German QWERTZ",
      "Italian",
      "Japanese (Kana)",
      "Korean",
      "Norwegian",
      "Portuguese",
      "Spanish",
      "Spanish (Latin America)",
      "Swedish",
      "U.K. (Mac)",
      "U.K. (PC)",
      "U.S. Dvorak",
      "U.S. QWERTY",
    ]);
    expect(DEFAULT_SHORTCUT_SETTINGS.layout).toBe("generic");
  });

  it("keeps only valid bindings, used ids and a known layout (a broken file reads as the defaults)", () => {
    expect(sanitizeShortcutSettings(null)).toEqual(DEFAULT_SHORTCUT_SETTINGS);
    expect(sanitizeShortcutSettings("x")).toEqual(DEFAULT_SHORTCUT_SETTINGS);
    const s = sanitizeShortcutSettings({
      bindings: { "object.group": [{ code: "KeyG", mod: true, alt: "yes", evil: 1 }, { code: "<script>" }], "view.rulers": [], bad: "nope" },
      used: ["view.rulers", "view.rulers", 4, "pan"],
      layout: "klingon",
    });
    expect(s.bindings).toEqual({ "object.group": [{ code: "KeyG", mod: true }], "view.rulers": [] });
    expect(s.used).toEqual(["view.rulers", "pan"]);
    expect(s.layout).toBe("generic");
    expect(sanitizeShortcutSettings({ layout: "de" }).layout).toBe("de");
  });

  it("writes a combo as the menu bar's accelerator", () => {
    expect(comboToAccelerator({ code: "KeyG", mod: true, alt: true })).toBe("Alt+CmdOrCtrl+G");
    expect(comboToAccelerator({ code: "Digit3", alt: true })).toBe("Alt+3");
    expect(comboToAccelerator({ code: "Slash", ctrl: true, shift: true })).toBe("Ctrl+Shift+/");
    expect(comboToAccelerator({ code: "BracketRight" })).toBe("]");
    expect(comboToAccelerator({ code: "Backspace", mod: true })).toBe("CmdOrCtrl+Backspace");
    expect(comboToAccelerator({ code: "ArrowUp", shift: true })).toBe("Shift+Up");
    expect(comboToAccelerator({ code: "Nonsense" })).toBeUndefined();
    expect(sameCombo({ code: "KeyA", mod: true }, { code: "KeyA", mod: true, shift: false })).toBe(true);
    expect(sameCombo({ code: "KeyA", mod: true }, { code: "KeyA" })).toBe(false);
  });

  it("puts the user's key on the menu bar (none when cleared), registered only with ⌘ / ⌃ — a plain key never runs from the bar", () => {
    expect(acceleratorFor("object.group", "CmdOrCtrl+G", {})).toBe("CmdOrCtrl+G");
    expect(acceleratorFor("object.group", "CmdOrCtrl+G", { "object.group": [{ code: "KeyJ", mod: true, shift: true }] })).toBe("Shift+CmdOrCtrl+J");
    expect(acceleratorFor("object.group", "CmdOrCtrl+G", { "object.group": [] })).toBeUndefined();
    // A custom plain key is the page's own, as Figma's plain keys are (docs/desktop.md §8.3).
    const plain = acceleratorFor("view.rulers", "Shift+R", { "view.rulers": [{ code: "KeyQ", alt: true }] });
    expect(plain).toBe("Alt+Q");
    expect(registersAccelerator(plain)).toBe(false);
    expect(runsFromMenuBar(plain, true)).toBe(false);
    expect(runsFromMenuBar(plain, false)).toBe(true);
  });
});
