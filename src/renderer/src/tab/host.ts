import { TEXT_FIELD_COMMANDS, type CommandId } from "@shared/commands";
import type { MenuCommandEvent } from "@shared/ipc";
import { desktopAs } from "@/app/native";

/**
 * A file tab's side of main (desktop only): main's questions answered from
 * the page's `window.designerTab` (unsaved? save!), and the menu's commands
 * run in the page.
 *
 * The Edit commands main hands over (Undo, Redo, Select All, Delete):
 * - a text field has the focus: the field's own (document.execCommand);
 * - a menu click: the page's own command if it has one, else the key the
 *   command stands for, sent to the page — its own key handler runs it
 *   against its model (the editor's history and selection, not the DOM's);
 * - an accelerator: the page saw the key already and left it (a menu was
 *   open, say) — nothing more is done.
 */

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** The key each Edit command stands for (KeyboardEvent init). */
const KEYS: Partial<Record<CommandId, KeyboardEventInit>> = {
  "edit.undo": { key: "z", code: "KeyZ" },
  "edit.redo": { key: "z", code: "KeyZ", shiftKey: true },
  "edit.select-all": { key: "a", code: "KeyA" },
  "edit.delete": { key: "Backspace", code: "Backspace" },
};

const MOD_KEYS = new Set<CommandId>(["edit.undo", "edit.redo", "edit.select-all"]);

function typingTarget(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  if (el.isContentEditable) return el;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(el.type)) return el;
  return null;
}

function pressKey(id: CommandId) {
  const init = KEYS[id];
  if (!init) return;
  const mod = MOD_KEYS.has(id);
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { ...init, metaKey: mod && IS_MAC, ctrlKey: mod && !IS_MAC, bubbles: true, cancelable: true, composed: true }));
}

export function runCommand({ id, source }: MenuCommandEvent) {
  if (id === "file.save") {
    void window.designerTab?.save();
    return;
  }
  const native = TEXT_FIELD_COMMANDS[id];
  if (!native) {
    window.designerTab?.command(id);
    return;
  }
  if (typingTarget()) {
    document.execCommand(native);
    return;
  }
  if (source === "accelerator") return;
  if (window.designerTab?.command(id) === true) return;
  pressKey(id);
}

let installed = false;

/** Once per page, in a desktop file tab. */
export function installTabHost() {
  const api = desktopAs.editor();
  if (!api || installed) return;
  installed = true;
  api.tab.onRequest(async (op) => {
    const tab = window.designerTab;
    if (op === "is-dirty") return tab?.isDirty() ?? false;
    return tab ? tab.save() : true;
  });
  api.menu.onCommand(runCommand);
  // Painted once: main may show the window (when this tab is the one in front at launch).
  requestAnimationFrame(() => api.ready());
}
