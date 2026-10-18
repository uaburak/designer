/**
 * The editor's shortcut layer (docs/engine.md §10.6 "Keyboard routing",
 * docs/editor.md §5). A key goes to the engine first — the canvas's
 * CanvasController sends it there itself; anywhere else in the editor (the
 * Layers panel, the body) this layer forwards it — and only a key the engine
 * didn't use runs a command. Fields, menus and dialogs keep their keys; a
 * control that used a key (preventDefault) keeps it too. ⌘C ⌘X ⌘V are left
 * to the browser so the DOM clipboard events fire (clipboardIO.ts).
 */
import { modifiersOf } from "@/engine/CanvasController";
import type { EditorController } from "./controller";
import { commandForKey, isEnabled } from "./commands";
import { opacityForDigit, type OpacityBuffer } from "./opacityKeys";
import { fields } from "./panels/design/shared";
import type { VectorTool } from "./vectorEdit";
import { pref } from "./preferences";
import { modeOf } from "./devmode/devMode";
import { shortcutPrefs } from "./shortcuts/prefs";

const VECTOR_KEYS: Record<string, VectorTool> = { KeyV: "MOVE", KeyQ: "LASSO", KeyP: "PEN", KeyB: "PAINT_BUCKET" };
/** With ⇧ (live's Keyboard shortcuts panel, Shape: "While editing a shape… Paint ⇧B"). */
const VECTOR_SHIFT_KEYS: Record<string, VectorTool> = { KeyB: "PAINT_BUCKET" };
/** The editor as Figma's shortcut table names it (Design and Motion are Figma's Design, Draw its illustration). */
const EDITOR = { design: "design", motion: "design", draw: "illustration", dev: "dev_handoff" } as const;

/**
 * Figma's keys follow the editor (Dev Mode's V and ⇧D, Draw's B) and two preferences: Use number keys for opacity
 * (off: 0 / 1 / 9 / 2 zoom and ⇧0–⇧9 set the opacity) and Use old shortcuts for outlines (Atlas 03 §6.3).
 */
function followEditor(ed: EditorController): () => void {
  const sync = () => {
    const ui = ed.ui.get();
    shortcutPrefs.follow({ editor: EDITOR[modeOf(ed)], numbersForOpacity: pref(ui, "numberKeysOpacity"), oldOutlineShortcuts: pref(ui, "oldOutlineShortcuts") });
  };
  sync();
  return ed.ui.subscribe(sync);
}

/** A text field, a contenteditable (`plaintext-only` too), or something inside one. */
export function isEditable(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return (target instanceof HTMLElement && target.isContentEditable) || !!target.closest(EDITABLE);
}
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Overlays (menus, popovers, dialogs) handle their own keys. A panel's own list (the Pages list, Find's results:
 * `data-keys="panel"`) is no overlay: the editor's shortcuts work with a page row focused (Figma).
 */
export const inOverlay = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  const at = target.closest("#ds-overlays, [role='dialog'], [role='menu'], [role='listbox']");
  return !!at && !(at.getAttribute("role") === "listbox" && at.getAttribute("data-keys") === "panel");
};

/** A focused control whose Enter / Space are its own (a button, a tab, a segment). */
const isControl = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("button, a[href], [role='button'], [role='tab'], [role='radio'], [role='checkbox'], [role='switch'], [role='option']");

/**
 * A key the engine didn't use while a text is being edited (the hidden field has the focus, so the shortcut layer
 * doesn't see it): the Text commands that act on the selected characters through the panel's path — ⇧⌘U Create link.
 */
export function runTextKey(ed: EditorController, e: KeyboardEvent): boolean {
  const c = commandForKey(e);
  if (!c || c.id !== "text.create-link") return false;
  if (isEnabled(ed, c)) c.run(ed);
  return true;
}

export function attachKeyboard(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  let opacityBuffer: OpacityBuffer | null = null;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || isEditable(e.target) || inOverlay(e.target)) return;
    if (e.defaultPrevented) return; // the engine (on the canvas) or a control used it
    if (e.target !== canvas) {
      if ((e.key === "Enter" || e.key === " ") && isControl(e.target)) return;
      // Tab / ⇧Tab from a control in the Design panel go on through the panel in DOM order (live: X → Y → Rotation →
      // Rotate 90˚ right → Flip horizontal …), not to the next layer.
      if (e.key === "Tab" && isControl(e.target) && (e.target as Element).closest("[data-panel='right']")) return;
      if (ed.engineKey("down", e, modifiersOf(e))) {
        e.preventDefault();
        return;
      }
    }
    // Vector edit mode: the tool letters pick the vector-edit tools (V Move, Q Lasso, P Pen, B Paint bucket).
    if (ed.vector.state.get().active && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tool = (e.shiftKey ? VECTOR_SHIFT_KEYS : VECTOR_KEYS)[e.code];
      if (tool) {
        e.preventDefault();
        ed.vector.setTool(tool);
        return;
      }
    }
    // 0–9: the selection's opacity (two digits typed quickly make one value: Figma's opacity keys); with Preferences ›
    // Use number keys for opacity off, ⇧0–⇧9 (the digits alone zoom then: Figma's table, the commands' keys).
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (digit && e.shiftKey === !pref(ed.ui.get(), "numberKeysOpacity") && !e.metaKey && !e.ctrlKey && !e.altKey && ed.selection.length && !ed.vector.state.get().active) {
      e.preventDefault();
      const next = opacityForDigit(opacityBuffer, Number(digit[1]), e.timeStamp || performance.now());
      opacityBuffer = next.buffer;
      ed.setProps(ed.selection, fields({ opacity: next.opacity }), "Opacity");
      return;
    }
    const c = commandForKey(e, ed.vector.state.get().active ? "VECTOR" : undefined);
    if (!c) return;
    if (c.native) {
      c.prepare?.(ed);
      return; // the browser fires copy / cut / paste
    }
    e.preventDefault();
    if (isEnabled(ed, c)) c.run(ed);
    else c.whenDisabled?.(ed);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.target === canvas || isEditable(e.target) || inOverlay(e.target)) return;
    ed.engineKey("up", e, modifiersOf(e));
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const offEditor = followEditor(ed);
  return () => {
    offEditor();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
