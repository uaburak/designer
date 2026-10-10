// @vitest-environment happy-dom
// The Keyboard shortcuts panel (shortcuts/): every row's keys are live Figma's (the owner's screenshots, 2026-10-10 —
// docs/research/shortcuts-panel/) and press the row's command; the user's own keys (bindings, conflicts, Replace,
// reset), the shortcuts used (lit rows and tabs), and the keyboard layouts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Mac (⌘ keys, ⌃ as Control), before the registry reads it.
vi.hoisted(() => Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true }));

import { COMMAND_BY_ID, commandForKey, comboText, type KeyCombo } from "../commands";
import { comboCaps, fixedCaps, rowCaps, type Cap } from "../shortcuts/caps";
import { applyBindings, comboOfPress, conflictsOf, defaultKeys, isCustom, keysOf, withBinding, withoutBinding } from "../shortcuts/keymap";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { characters, detectLayout, drawnKeyboard, layoutMap, legends } from "../shortcuts/layouts";
import { allRows, ESSENTIALS, SHORTCUT_TABS, tabUsageIds, usageIds } from "../shortcuts/panelData";
import { shortcutPrefs } from "../shortcuts/prefs";
import { canvasKeyUsage, opacityUsage } from "../shortcuts/usage";

const text = (caps: Cap[]) => caps.map((c) => (c.icon === "24.globe" ? "🌐" : c.text)).join(" ");

/** A row's caps as live's panel draws them (a Mac): "⇧ ⌘ 7 and 8". */
function rowText(label: string, bindings = {}): string {
  const row = allRows().find((r) => r.label === label);
  if (!row) throw new Error(`no row ${label}`);
  if (row.kind === "fixed") return text(fixedCaps(row.caps, true));
  return rowCaps(row, bindings, true)
    .map((g) => text(g.caps))
    .join(" and ");
}

/** The keys of every row in live Figma's panel (the screenshots), tab by tab. */
const LIVE: Record<string, Record<string, string>> = {
  tools: { "Move tool": "V", "Frame tool": "F", "Pen tool": "P", "Pencil tool": "⇧ P", "Text tool": "T", "Rectangle tool": "R", "Ellipse tool": "O", "Line tool": "L", "Arrow tool": "⇧ L", "View comments": "C", "Annotation tool": "Y", "Pick color": "⌃ C", "Slice tool": "S" },
  view: {
    "Show/Hide UI": "⌘ \\",
    "Multiplayer cursors": "⌥ ⌘ \\",
    Rulers: "⇧ R",
    "Show outlines": "⇧ ⌘ O",
    "Pixel preview": "⇧ ⌘ P",
    "Layout guides": "⇧ G",
    "Pixel grid": "⇧ ′",
    "Open layers panel": "⌥ 1",
    "Show assets": "⌥ 2",
    "Team library": "⌥ 3",
    "Open design panel": "⌥ 8",
    "Open prototype panel": "⌥ 9",
  },
  zoom: {
    Pan: "Space drag",
    "Zoom in": "⌘ +",
    "Zoom out": "⌘ –",
    "Zoom to 100%": "⌘ 0",
    "Zoom to fit": "⇧ 1",
    "Zoom to selection": "⇧ 2",
    "Zoom to next frame": "N",
    "Zoom to previous frame": "⇧ N",
    "Previous page": "🌐 ↑",
    "Next page": "🌐 ↓",
    "Find previous frame": "Home",
    "Find next frame": "End",
  },
  text: {
    "Bold/Italic": "⌘ B and I",
    Underline: "⌘ U",
    "Create link": "⇧ ⌘ U",
    Strikethrough: "⇧ ⌘ X",
    "Turn into a list": "⇧ ⌘ 7 and 8",
    "Text align left": "⌥ ⌘ L",
    "Text align center": "⌥ ⌘ T",
    "Text align right": "⌥ ⌘ R",
    "Text align justified": "⌥ ⌘ J",
    "Adjust font size": "⇧ ⌘ < and >",
    "Adjust font weight": "⌥ ⌘ < and >",
    "Adjust letter spacing": "⌥ < and >",
    "Adjust line height": "⌥ ⇧ < and >",
  },
  shape: {
    Pen: "P",
    Pencil: "⇧ P",
    Paint: "⇧ B",
    "Bend tool": "⌘",
    "Remove fill": "⌥ /",
    "Remove stroke": "⇧ /",
    "Swap fill and stroke": "⇧ X",
    "Outline stroke": "⌥ ⌘ O",
    Flatten: "⌥ ⇧ F",
    "Join selection": "⌘ J",
    "Smooth join selection": "⇧ ⌘ J",
    "Delete and heal selection": "⇧ ⌫",
  },
  selection: {
    "Select all": "⌘ A",
    "Select inverse": "⇧ ⌘ A",
    "Select none": "⎋ Esc",
    "Deep select": "⌘ click",
    "Select children": "↩ Enter",
    "Select parent": "\\",
    "Select next sibling": "⇥ Tab",
    "Select previous sibling": "⇧ ⇥ Tab",
    "Select matching layers": "⌥ ⌘ A",
    "Group selection": "⌘ G",
    "Ungroup selection": "⌘ ⌫",
    "Frame selection": "⌥ ⌘ G",
    "Show/Hide selection": "⇧ ⌘ H",
    "Lock/Unlock selection": "⇧ ⌘ L",
  },
  cursor: {
    "Measure to selection": "⌥",
    "Duplicate selection": "⌥",
    "Deep select": "⌘ click",
    "Deep select within rectangle": "⌘ drag",
    "Resize from center": "⌥",
    "Resize proportionally": "⇧",
    "Crop (images)/Ignore constraints (frames)": "⌘",
  },
  edit: {
    Copy: "⌘ C",
    Cut: "⌘ X",
    Paste: "⌘ V",
    "Paste to replace": "⇧ ⌘ R",
    "Paste over selection": "⇧ ⌘ V",
    Duplicate: "⌘ D",
    "Rename selection": "⌘ R",
    Export: "⇧ ⌘ E",
    Find: "⌘ F",
    "Copy as PNG": "⇧ ⌘ C",
    "Copy properties": "⌥ ⌘ C",
    "Paste properties": "⌥ ⌘ V",
  },
  transform: {
    "Flip horizontal": "⇧ H",
    "Flip vertical": "⇧ V",
    "Use as mask": "⌃ ⌘ M",
    "Edit shape or image": "↩ Enter",
    "Place image/video…": "⇧ ⌘ K",
    "Set opacity to 0%": "0 0",
    "Set opacity to 10%": "1",
    "Set opacity to 50%": "5",
    "Set opacity to 100%": "0",
  },
  arrange: {
    "Bring forward": "⌘ ]",
    "Send backward": "⌘ [",
    "Bring to front": "]",
    "Send to back": "[",
    "Align left/right": "⌥ A and D",
    "Align top/bottom": "⌥ W and S",
    "Align centers": "⌥ H and V",
    "Distribute spacing": "⌃ ⌥ H and V",
    "Tidy up": "⌃ ⌥ T",
    "Add auto layout": "⇧ A",
    "Remove auto layout": "⌥ ⇧ A",
    "Suggest auto layout": "⌃ ⇧ A",
  },
  components: { "Show assets": "⌥ 2", "Team library": "⌥ 3", "Create component": "⌥ ⌘ K", "Detach instance": "⌥ ⌘ B", "Convert to slot": "⇧ ⌘ S", "Component search": "⇧ I", "Swap component instance": "⌥" },
};

/** A Mac's key press of a combo (the code the bindings name). */
const press = (c: KeyCombo) => ({ code: c.code, metaKey: !!c.mod, shiftKey: !!c.shift, altKey: !!c.alt, ctrlKey: !!c.ctrl });

beforeEach(() => {
  shortcutPrefs.reset();
  localStorage.clear();
});
afterEach(() => shortcutPrefs.reset());

describe("the Keyboard shortcuts panel: live Figma's tabs, rows and keys", () => {
  it("has live's tabs in order", () => {
    expect(SHORTCUT_TABS.map((t) => t.label)).toEqual(["Essential", "Tools", "View", "Zoom", "Text", "Shape", "Selection", "Cursor", "Edit", "Transform", "Arrange", "Components", "Layout"]);
    expect(ESSENTIALS.map((e) => e.title)).toEqual(["Show/Hide UI", "Component search", "Actions…"]);
  });

  it("every row shows live's keys, and live's rows only", () => {
    for (const tab of SHORTCUT_TABS) {
      const live = LIVE[tab.id];
      if (!live) continue;
      const rows = (tab.columns ?? []).flat().filter((r) => r.kind !== "heading");
      expect(rows.map((r) => r.label).sort(), tab.id).toEqual(Object.keys(live).sort());
      for (const [label, keys] of Object.entries(live)) {
        const row = rows.find((r) => r.label === label)!;
        const got = row.kind === "fixed" ? text(fixedCaps(row.caps, true)) : rowCaps(row, {}, true).map((g) => text(g.caps)).join(" and ");
        expect(got, `${tab.label} › ${label}`).toBe(keys);
      }
    }
    expect(ESSENTIALS.map((e) => text(comboCaps(defaultKeys(e.command)[0], true)))).toEqual(["⌘ \\", "⇧ I", "⌘ K"]);
  });

  it("each row's keys run its command (no other command takes them first)", () => {
    for (const row of allRows())
      if (row.kind === "keys")
        for (const part of row.parts) {
          const combo = keysOf(part.command, {})[0];
          expect(combo, `${row.label}: ${part.command}`).toBeDefined();
          const got = commandForKey(press(combo))?.id;
          expect([part.command, part.command === "tool.image" ? "file.place-image" : ""], `${row.label} ${comboText(combo)} → ${got}`).toContain(got);
        }
    for (const e of ESSENTIALS) expect(commandForKey(press(defaultKeys(e.command)[0]))?.id).toBe(e.command);
  });

  it("the commands the panel added exist with live's keys: Text align justified ⌥⌘J, Component search ⇧I, Team library ⌥3, Suggest auto layout ⌃⇧A", () => {
    expect(COMMAND_BY_ID.get("text.align-justified")?.keys?.[0]).toEqual({ code: "KeyJ", mod: true, alt: true });
    expect(COMMAND_BY_ID.get("view.component-search")?.keys?.[0]).toEqual({ code: "KeyI", shift: true });
    expect(COMMAND_BY_ID.get("view.team-library")?.keys?.[0]).toEqual({ code: "Digit3", alt: true });
    expect(COMMAND_BY_ID.get("object.suggest-auto-layout")?.keys?.[0]).toEqual({ code: "KeyA", ctrl: true, shift: true });
  });
});

describe("the user's own keys", () => {
  const G = { code: "KeyG", mod: true };
  const J = { code: "KeyJ", mod: true, alt: true, shift: true };

  it("a binding replaces a command's keys, in the registry the keyboard layer, menus and tooltips read", () => {
    const b = withBinding({}, "object.group", J);
    expect(b).toEqual({ "object.group": [J] });
    expect(isCustom("object.group", b)).toBe(true);
    applyBindings(b);
    expect(commandForKey(press(J))?.id).toBe("object.group");
    expect(commandForKey(press(G))).toBeNull();
    expect(rowText("Group selection", b)).toBe("⌥ ⇧ ⌘ J");
    applyBindings({});
    expect(commandForKey(press(G))?.id).toBe("object.group");
  });

  it("a key another command has is a conflict naming it; Replace takes it from that command (its other keys stay)", () => {
    expect(conflictsOf(G, "object.frame-selection", {})).toEqual([{ id: "object.group", label: "Group selection" }]);
    expect(conflictsOf(G, "object.group", {})).toEqual([]);
    const b = withBinding({}, "object.frame-selection", G, true);
    expect(keysOf("object.frame-selection", b)).toEqual([G]);
    expect(keysOf("object.group", b)).toEqual([]);
    // Ungroup had ⌘⌫ and ⇧⌘G: taking ⌘⌫ leaves ⇧⌘G.
    const u = withBinding({}, "object.group", { code: "Backspace", mod: true }, true);
    expect(keysOf("object.ungroup", u)).toEqual([{ code: "KeyG", mod: true, shift: true }]);
    applyBindings(b);
    expect(commandForKey(press(G))?.id).toBe("object.frame-selection");
  });

  it("keys the canvas or the app keep are refused (Enter, Tab, \\, Space, digits, ⌘W, ⌘1…)", () => {
    for (const c of [{ code: "Enter" }, { code: "Tab" }, { code: "Backslash" }, { code: "Space" }, { code: "Digit5" }, { code: "KeyW", mod: true }, { code: "Digit1", mod: true }]) {
      expect(conflictsOf(c, "object.group", {})[0].id, c.code).toBeNull();
      expect(() => withBinding({}, "object.group", c, true)).toThrow();
    }
  });

  it("⌫ while recording clears a command's keys; Reset to default and Reset all bring Figma's back", () => {
    let b = withBinding({}, "view.rulers", null);
    expect(keysOf("view.rulers", b)).toEqual([]);
    applyBindings(b);
    expect(commandForKey(press({ code: "KeyR", shift: true }))).toBeNull();
    expect(rowText("Rulers", b)).toBe("");
    b = withoutBinding(b, "view.rulers");
    expect(b).toEqual({});
    applyBindings(b);
    expect(commandForKey(press({ code: "KeyR", shift: true }))?.id).toBe("view.rulers");
    // A binding set back to the default is no binding.
    expect(withBinding(withBinding({}, "view.rulers", J), "view.rulers", { code: "KeyR", shift: true })).toEqual({});
  });

  it("Place image/video… and File › Place image… are one action: a key set on one is the other's", () => {
    const k = { code: "KeyI", mod: true, alt: true };
    const b = withBinding({}, "tool.image", k);
    expect(keysOf("file.place-image", b)).toEqual([k]);
    expect(conflictsOf({ code: "KeyK", mod: true, shift: true }, "tool.image", {})).toEqual([]);
    expect(withoutBinding(b, "tool.image")).toEqual({});
  });

  it("a recorded press is a combo; a modifier alone isn't", () => {
    expect(comboOfPress({ code: "KeyG", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, "KeyG", true)).toEqual({ code: "KeyG", mod: true, alt: true });
    expect(comboOfPress({ code: "KeyG", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "KeyG", true)).toEqual({ code: "KeyG", ctrl: true });
    expect(comboOfPress({ code: "KeyG", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, "KeyG", false)).toEqual({ code: "KeyG", mod: true });
    expect(comboOfPress({ code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "MetaLeft", true)).toBeNull();
    expect(comboOfPress({ code: "ShiftRight", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, "ShiftRight", true)).toBeNull();
  });

  it("the settings keep them (a browser: localStorage) and apply them at once", () => {
    shortcutPrefs.update({ bindings: withBinding({}, "object.group", J) });
    expect(commandForKey(press(J))?.id).toBe("object.group");
    expect(JSON.parse(localStorage.getItem("designer.shortcuts")!).bindings).toEqual({ "object.group": [J] });
    shortcutPrefs.reset();
    expect(commandForKey(press(G))?.id).toBe("object.group");
    shortcutPrefs.start();
    expect(commandForKey(press(J))?.id).toBe("object.group");
    expect(shortcutPrefs.get().bindings).toEqual({ "object.group": [J] });
  });
});

describe("shortcuts used (lit in the panel)", () => {
  it("a row is lit by its commands (any of a pair) or its own id; a tab when all of its are used", () => {
    const row = allRows().find((r) => r.label === "Bold/Italic")!;
    expect(usageIds(row)).toEqual(["text.bold", "text.italic"]);
    expect(usageIds(allRows().find((r) => r.label === "Pan")!)).toEqual(["pan"]);
    const cursor = SHORTCUT_TABS.find((t) => t.id === "cursor")!;
    expect(tabUsageIds(cursor).sort()).toEqual(["deep-select", "deep-select-rect", "duplicate-drag", "measure", "resize-center", "resize-crop", "resize-proportional"]);
    expect(tabUsageIds(SHORTCUT_TABS[0])).toEqual(["view.toggle-ui", "view.component-search", "tool.actions"]);
    expect(tabUsageIds(SHORTCUT_TABS.find((t) => t.id === "layout")!)).toEqual([]);
  });

  it("marks a shortcut once and keeps it", async () => {
    shortcutPrefs.markUsed("view.rulers");
    shortcutPrefs.markUsed("view.rulers");
    expect(shortcutPrefs.get().used).toEqual(["view.rulers"]);
    await new Promise((r) => setTimeout(r, 600));
    expect(JSON.parse(localStorage.getItem("designer.shortcuts")!).used).toEqual(["view.rulers"]);
  });

  it("the canvas's own keys and the opacity digits are their rows", () => {
    const k = (code: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({ code, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
    expect(canvasKeyUsage(k("Tab"), { selection: 1, vector: false })).toBe("select-next-sibling");
    expect(canvasKeyUsage(k("Tab", { shiftKey: true }), { selection: 1, vector: false })).toBe("select-previous-sibling");
    expect(canvasKeyUsage(k("Backslash"), { selection: 1, vector: false })).toBe("select-parent");
    expect(canvasKeyUsage(k("Escape"), { selection: 1, vector: false })).toBe("select-none");
    expect(canvasKeyUsage(k("Escape"), { selection: 0, vector: false })).toBeNull();
    expect(canvasKeyUsage(k("KeyB", { shiftKey: true }), { selection: 0, vector: true })).toBe("paint");
    expect(opacityUsage(1, null, 0)).toBe("opacity-10");
    expect(opacityUsage(5, null, 0)).toBe("opacity-50");
    expect(opacityUsage(0, null, 0)).toBe("opacity-100");
    expect(opacityUsage(0, { digit: 0, at: 0 }, 100)).toBe("opacity-0");
    expect(opacityUsage(5, { digit: 4, at: 0 }, 100)).toBeNull();
  });
});

describe("keyboard layouts", () => {
  it("Generic is a U.S. keyboard (live's drawing)", () => {
    const rows = drawnKeyboard("generic").map((r) => r.map((k) => k.legend).join(" "));
    expect(rows).toEqual(["` 1 2 3 4 5 6 7 8 9 0 - = ⌫", "⇥ Q W E R T Y U I O P [ ] \\", "⇪ A S D F G H J K L ; ' ↩", "⇧ Z X C V B N M , . / ⇧", "⌃ ⌥ ⌘  ⌘ ⌥"]);
    // Every row is as wide as live's (471 ± 3).
    for (const r of drawnKeyboard("generic")) expect(Math.abs(r.reduce((s, k) => s + k.width, 0) + (r.length - 1) * 6 - 471), r[0].code).toBeLessThanOrEqual(3);
    const m = layoutMap("generic");
    expect(m.toBinding("KeyZ")).toBe("KeyZ");
    expect(m.toPhysical("BracketLeft")).toBe("BracketLeft");
  });

  it("German QWERTZ: ⌘Z is the key labelled Z (the U.S. Y), [ stays at its place (Ü)", () => {
    const m = layoutMap("de");
    expect(m.toBinding("KeyY")).toBe("KeyZ");
    expect(m.toBinding("KeyZ")).toBe("KeyY");
    expect(m.toPhysical("KeyZ")).toBe("KeyY");
    expect(m.toBinding("BracketLeft")).toBe("BracketLeft");
    expect(m.label("KeyZ")).toBe("Z");
    expect(m.label("BracketLeft")).toBe("Ü");
    // The minus is at the U.S. slash; / (on ⇧7 here) took ß's place, the first key left without a shortcut.
    expect(m.toBinding("Slash")).toBe("Minus");
    expect(m.toBinding("Minus")).toBe("Slash");
    expect(m.label("Slash")).toBe("ß");
    expect(legends("de").get("KeyY")).toBe("Z");
  });

  it("French AZERTY and Dvorak follow the characters; Korean and Japanese keep the U.S. places", () => {
    const fr = layoutMap("fr");
    expect(fr.toBinding("KeyQ")).toBe("KeyA");
    expect(fr.toBinding("KeyA")).toBe("KeyQ");
    expect(fr.toBinding("Semicolon")).toBe("KeyM");
    const dv = layoutMap("dvorak");
    expect(dv.toBinding("Slash")).toBe("KeyZ");
    expect(dv.label("KeyV")).toBe("V");
    for (const id of ["ko", "ja"] as const) {
      expect(layoutMap(id).toBinding("KeyQ")).toBe("KeyQ");
      expect(layoutMap(id).label("KeyQ")).toBe("Q");
    }
    expect(drawnKeyboard("ko")[1][1].legend).toBe("ㅂ");
  });

  // macOS's own characters (docs/research/shortcuts-panel/keylayouts.swift on a Turkish MacBook): code → [alone, ⇧, ⌘].
  const macos = JSON.parse(readFileSync(join(process.cwd(), "docs/research/shortcuts-panel/keylayouts-tr.json"), "utf8")) as Record<string, Record<string, [string, string, string]>>;
  const TURKISH = { "tr-q-mac": "com.apple.keylayout.Turkish-QWERTY-PC", "tr-f": "com.apple.keylayout.Turkish-Standard" } as const;
  /** A keyboard map as navigator.keyboard.getLayoutMap() gives it: code → the character the key types. */
  const systemMap = (source: string) => new Map(Object.entries(macos[source]).map(([code, [alone]]) => [code, alone]));

  it("the Turkish layouts are macOS's: every key's legend is what ⇧ types for a letter, else what it types alone", () => {
    expect(macos.iso).toBe(true);
    for (const [id, source] of Object.entries(TURKISH)) {
      const own = legends(id as keyof typeof TURKISH);
      const keys = macos[source];
      expect([...own.keys()].sort(), id).toEqual(Object.keys(keys).sort());
      for (const [code, [alone, shifted]] of Object.entries(keys)) expect(own.get(code), `${id} ${code}`).toBe(alone.toLocaleUpperCase("tr") === shifted && alone !== shifted ? shifted : alone);
      // ⌘ types what the key types alone (macOS matches ⌘ shortcuts by it).
      for (const [code, [alone, , cmd]] of Object.entries(keys)) expect(cmd, `${id} ${code}`).toBe(alone);
    }
  });

  it("Turkish Q (Mac): ç ş ğ ü ö ı i in a Turkish MacBook's places, < right of the left ⇧, \" left of 1", () => {
    const own = legends("tr-q-mac");
    const typed = characters("tr-q-mac");
    expect(Object.fromEntries(["BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "KeyI", "Backslash", "Slash", "IntlBackslash", "Backquote", "Minus", "Equal"].map((c) => [c, own.get(c)]))).toEqual({
      BracketLeft: "Ğ",
      BracketRight: "Ü",
      Semicolon: "Ş",
      Quote: "İ",
      Comma: "Ö",
      Period: "Ç",
      KeyI: "I",
      Backslash: ",",
      Slash: ".",
      IntlBackslash: "<",
      Backquote: '"',
      Minus: "*",
      Equal: "-",
    });
    expect(typed.get("KeyI")).toBe("ı");
    expect(typed.get("Quote")).toBe("i");
    expect(typed.get("Period")).toBe("ç");
  });

  it("Turkish Q (Mac): shortcuts follow the characters — ⌘I is İ's key (types i, as on macOS), ⌘- the key that types -, every U.S. key keeps one", () => {
    const m = layoutMap("tr-q-mac");
    expect(m.toPhysical("KeyZ")).toBe("KeyZ");
    expect(m.label("KeyZ")).toBe("Z");
    expect(m.toPhysical("KeyI")).toBe("Quote");
    expect(m.toBinding("Quote")).toBe("KeyI");
    expect(m.label("KeyI")).toBe("İ");
    expect(m.toPhysical("Minus")).toBe("Equal");
    expect(m.toPhysical("Comma")).toBe("Backslash");
    expect(m.toPhysical("Period")).toBe("Slash");
    expect(m.label("Comma")).toBe(",");
    // Ğ and Ü keep [ and ]'s shortcuts; Ş keeps ;'s.
    expect(m.toBinding("BracketLeft")).toBe("BracketLeft");
    expect(m.label("BracketLeft")).toBe("Ğ");
    expect(m.toBinding("Semicolon")).toBe("Semicolon");
    // =, \, ' and / have no key of their own here: the keys left without a shortcut (*, ı, Ö, Ç), in order.
    expect(["Equal", "Backslash", "Quote", "Slash"].map((c) => m.toPhysical(c))).toEqual(["Minus", "KeyI", "Comma", "Period"]);
    expect(m.label("Slash")).toBe("Ç");
    // One key per U.S. key, and back.
    const physical = [...legends("us").keys()].map((c) => m.toPhysical(c));
    expect(new Set(physical).size).toBe(physical.length);
    for (const code of legends("us").keys()) expect(m.toBinding(m.toPhysical(code))).toBe(code);
    expect(m.toBinding("IntlBackslash")).toBe("IntlBackslash");
  });

  it("Turkish F: ⌘Z is the key labelled Z (the U.S. N), ⌘I İ's (the U.S. S)", () => {
    const m = layoutMap("tr-f");
    expect(m.toPhysical("KeyZ")).toBe("KeyN");
    expect(m.toPhysical("KeyI")).toBe("KeyS");
    expect(m.toPhysical("KeyF")).toBe("KeyQ");
    expect(m.toBinding("BracketLeft")).toBe("KeyQ");
    expect(m.label("KeyQ")).toBe("Q");
    expect(legends("tr-f").get("KeyR")).toBe("I");
    expect(legends("tr-f").get("KeyE")).toBe("Ğ");
    const physical = [...legends("us").keys()].map((c) => m.toPhysical(c));
    expect(new Set(physical).size).toBe(physical.length);
  });

  it("the Turkish keyboards are drawn ISO: a tall Return over two rows, \\'s key left of it, < right of the left ⇧", () => {
    const rows = drawnKeyboard("tr-q-mac");
    expect(rows.map((r) => r.map((k) => k.legend).join(" "))).toEqual([
      '" 1 2 3 4 5 6 7 8 9 0 * - ⌫',
      "⇥ Q W E R T Y U I O P Ğ Ü ↩",
      "⇪ A S D F G H J K L Ş İ , ",
      "⇧ < Z X C V B N M Ö Ç . ⇧",
      "⌃ ⌥ ⌘  ⌘ ⌥",
    ]);
    // The character rows as wide as live's U.S. keyboard's, the Return's two parts right-aligned.
    for (const r of rows.slice(0, 4)) expect(r.reduce((s, k) => s + k.width, 0) + (r.length - 1) * 6, r[0].code).toBe(471);
    const enter = rows[1].at(-1)!;
    expect(enter.tall).toEqual({ part: "top", lower: rows[2].at(-1)!.width });
    expect(rows[2].at(-1)!.tall).toEqual({ part: "below" });
    expect(rows[2].at(-2)!.code).toBe("Backslash");
    expect(rows[3][1].code).toBe("IntlBackslash");
    expect(drawnKeyboard("tr-f")[1].map((k) => k.legend).join(" ")).toBe("⇥ F G Ğ I O D R N H P Q W ↩");
    expect(drawnKeyboard("generic")[3].some((k) => k.code === "IntlBackslash")).toBe(false);
  });

  it("the system's layout is detected from its keyboard map: Turkish Q and F, German; a U.S. one is Generic", () => {
    expect(detectLayout(systemMap(TURKISH["tr-q-mac"]))).toBe("tr-q-mac");
    expect(detectLayout(systemMap(TURKISH["tr-f"]))).toBe("tr-f");
    // Electron's own map on the owner's Turkish MacBook (getLayoutMap(), 2026-10-10): the ISO key left of 1 and the one
    // by ⇧ the other way round, and two more names for them.
    const electron = systemMap(TURKISH["tr-q-mac"]);
    electron.set("Backquote", "<").set("IntlBackslash", '"').set("IntlYen", '"').set("IntlRo", "<");
    expect(detectLayout(electron)).toBe("tr-q-mac");
    // A U.S. layout on an ISO keyboard (§ left of 1) is Generic, not U.K. (Mac).
    expect(detectLayout(new Map([...legends("us")].map(([c, l]) => [c, c === "Backquote" ? "§" : l.toLowerCase()])))).toBeNull();
    const us = new Map([...legends("us")].map(([c, l]) => [c, l.toLowerCase()]));
    expect(detectLayout(us)).toBeNull();
    expect(detectLayout(new Map([...legends("de")].map(([c, l]) => [c, l.toLowerCase()])))).toBe("de");
    expect(detectLayout(new Map())).toBeNull();
  });

  it("until the user picks one, the system's layout is in force (preselected, not written); a pick wins", async () => {
    const map = systemMap(TURKISH["tr-q-mac"]);
    const keyboard = { getLayoutMap: async () => map };
    Object.defineProperty(globalThis.navigator, "keyboard", { value: keyboard, configurable: true });
    try {
      localStorage.removeItem("designer.shortcuts");
      shortcutPrefs.start();
      await shortcutPrefs.detect();
      expect(shortcutPrefs.get().layout).toBe("tr-q-mac");
      expect(shortcutPrefs.get().layoutPicked).toBe(false);
      // ⌘ and İ's key: Italic; ⌘ and the U.S. Z key: Undo.
      expect(commandForKey({ code: "Quote", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })?.id).toBe("text.italic");
      expect(commandForKey({ code: "KeyZ", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })?.id).toBe("edit.undo");
      expect(comboText({ code: "KeyI", mod: true })).toMatch(/İ$/);
      // Kept as Generic, not picked: a binding written keeps no layout.
      shortcutPrefs.update({ bindings: {} });
      expect(JSON.parse(localStorage.getItem("designer.shortcuts")!)).toMatchObject({ layout: "generic", layoutPicked: false });
      shortcutPrefs.update({ layout: "generic" });
      await shortcutPrefs.detect();
      expect(shortcutPrefs.get().layout).toBe("generic");
      expect(JSON.parse(localStorage.getItem("designer.shortcuts")!)).toMatchObject({ layout: "generic", layoutPicked: true });
    } finally {
      delete (globalThis.navigator as { keyboard?: unknown }).keyboard;
      localStorage.removeItem("designer.shortcuts");
    }
  });

  it("a layout picked moves the shortcuts: on German QWERTZ the U.S. Y key undoes", () => {
    shortcutPrefs.update({ layout: "de" });
    expect(commandForKey({ code: "KeyY", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })?.id).toBe("edit.undo");
    expect(comboText({ code: "KeyZ", mod: true })).toMatch(/Z$/);
    shortcutPrefs.update({ layout: "generic" });
    expect(commandForKey({ code: "KeyZ", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })?.id).toBe("edit.undo");
  });
});
