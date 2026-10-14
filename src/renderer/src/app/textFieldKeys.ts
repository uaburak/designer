/**
 * The editing keys of a focused text field (an input, a textarea, a contenteditable): ⌘A / Ctrl+A selects its text,
 * ⌘Z / Ctrl+Z undoes, ⇧⌘Z / Ctrl+Y redoes — in the field, whatever the menu bar's Select all / Undo can do for the
 * view at that moment (macOS swallows the key of a disabled menu item, so these did nothing in Home's search while no
 * file was there to select). Taken here, the key never reaches the menu bar or a view's own shortcuts. The canvas's
 * text field (`[data-canvas-text]`, text edited on the canvas) keeps its own handling.
 */

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

function textField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!(target instanceof HTMLElement) || target.closest("[data-canvas-text]")) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type) ? target : null;
  return target.isContentEditable ? target : null;
}

/** What a key does in a text field, or null (not one of its editing keys). */
export function textFieldCommand(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): "selectAll" | "undo" | "redo" | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "a" && !e.shiftKey) return "selectAll";
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !mac && !e.shiftKey) return "redo";
  return null;
}

export function installTextFieldKeys(win: Window = window): () => void {
  const mac = /Mac|iPhone|iPad/.test(win.navigator.platform);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const field = textField(e.target);
    if (!field) return;
    const command = textFieldCommand(e, mac);
    if (!command) return;
    e.preventDefault();
    if (command === "selectAll" && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) field.select();
    else win.document.execCommand(command);
  };
  win.addEventListener("keydown", onKeyDown, true);
  return () => win.removeEventListener("keydown", onKeyDown, true);
}
