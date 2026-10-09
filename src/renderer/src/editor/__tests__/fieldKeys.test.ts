// Keys typed into a text field are never the canvas's shortcuts (the owner's report: N typed into the Agents composer
// zoomed to the next frame). macOS hands the menu bar every key a page leaves unhandled, letters a field inserts among
// them, so main drops plain-key accelerators (src/shared/commands.ts runsFromMenuBar) — which is right only if the page
// runs every plain-key shortcut of the menu bar itself (keyboard.ts); and the editor drops one that still comes while a
// field has the focus (desktop.ts menuCommandInField). editor-shot (EDITOR_ONLY=input) checks it in the page.
import { beforeAll, describe, expect, it } from "vitest";
import { COMMANDS as MENU_BAR, registersAccelerator } from "@shared/commands";
import { COMMAND_BY_ID, matchesCombo } from "../commands";

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
});

const CODES: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", "'": "Quote", "/": "Slash", "\\": "Backslash", ",": "Comma", ".": "Period", "-": "Minus", "=": "Equal", "`": "Backquote", ";": "Semicolon" };

/** The key press an Electron accelerator stands for ("Shift+N" → KeyN with ⇧), as a Mac's KeyboardEvent. */
function pressOf(accelerator: string) {
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  const code = /^[A-Z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : (CODES[key] ?? key);
  return { code, shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), ctrlKey: false, metaKey: false };
}

describe("keys typed into text fields", () => {
  it("every plain-key shortcut of the menu bar is the page's own: the editor's keyboard layer runs it", () => {
    const plain = MENU_BAR.filter((c: { accelerator?: string; scope: string }) => c.accelerator && !registersAccelerator(c.accelerator) && (c.scope === "editor" || c.scope === "view"));
    expect(plain.map((c) => c.id)).toContain("view.zoom-next-frame");
    for (const c of plain as readonly { id: string; accelerator?: string }[]) {
      const cmd = COMMAND_BY_ID.get(c.id);
      expect(cmd, c.id).toBeDefined();
      const press = pressOf(c.accelerator!);
      expect(cmd!.keys?.some((k) => matchesCombo(k, press, true)), `${c.id} (${c.accelerator})`).toBe(true);
    }
  });

  it("no menu-bar accelerator of a view runs an editor command while a DOM text field has the focus (every one, ⇧A and N among them)", async () => {
    const { runsFromMenuBar } = await import("@shared/commands");
    const { menuCommandInField } = await import("../desktop");
    const ran: string[] = [];
    for (const c of MENU_BAR as readonly { id: string; accelerator?: string; scope: string }[]) {
      if (!c.accelerator || (c.scope !== "editor" && c.scope !== "view")) continue;
      // Main: a plain key never leaves the menu bar; the view: a ⌘ / ⌃ one is ignored in a field, or the field's own edit.
      if (runsFromMenuBar(c.accelerator, true) && menuCommandInField(c.id, "accelerator") === "run") ran.push(`${c.id} ${c.accelerator}`);
    }
    expect(ran).toEqual([]);
    for (const id of ["object.add-auto-layout", "view.zoom-next-frame"]) expect(runsFromMenuBar((MENU_BAR as readonly { id: string; accelerator?: string }[]).find((c) => c.id === id)!.accelerator, true), id).toBe(false);
    // Every editor command, should one come as a key with a field focused.
    for (const c of [...COMMAND_BY_ID.values()]) expect(["drop", "native"], c.id).toContain(menuCommandInField(c.id, "accelerator"));
  });

  it("a shortcut that reaches the editor from the menu bar while a text field has the focus doesn't run (docs/desktop.md §8.3)", async () => {
    const { menuCommandInField } = await import("../desktop");
    const plain = ["view.zoom-next-frame", "view.zoom-previous-frame", "object.bring-to-front", "object.flip-vertical", "arrange.align-left", "view.zoom-fit", "edit.select-none"];
    for (const id of [...plain, "edit.duplicate", "object.group"]) expect(menuCommandInField(id, "accelerator"), id).toBe("drop");
    // Undo / Redo / Select all / Delete act on the field.
    for (const id of ["edit.undo", "edit.redo", "edit.select-all", "edit.delete"]) expect(menuCommandInField(id, "accelerator"), id).toBe("native");
    // Clicked in the menu: runs.
    expect(menuCommandInField("view.zoom-next-frame", "menu")).toBe("run");
    // Text edited on the canvas keeps its ⌘ shortcuts; a plain key is typing there too.
    expect(menuCommandInField("edit.duplicate", "accelerator", "canvas-text")).toBe("run");
    for (const id of plain) expect(menuCommandInField(id, "accelerator", "canvas-text"), id).toBe("drop");
  });
});
