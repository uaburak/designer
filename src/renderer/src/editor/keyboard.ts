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

/** A text field, a contenteditable, or something inside one. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** Overlays (menus, popovers, dialogs) handle their own keys. */
const inOverlay = (target: EventTarget | null) => target instanceof Element && !!target.closest("#ds-overlays, [role='dialog'], [role='menu'], [role='listbox']");

/** A focused control whose Enter / Space are its own (a button, a tab, a segment). */
const isControl = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("button, a[href], [role='button'], [role='tab'], [role='radio'], [role='checkbox'], [role='switch'], [role='option']");

export function attachKeyboard(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || isEditable(e.target) || inOverlay(e.target)) return;
    if (e.defaultPrevented) return; // the engine (on the canvas) or a control used it
    if (e.target !== canvas) {
      if ((e.key === "Enter" || e.key === " ") && isControl(e.target)) return;
      if (ed.engineKey("down", e, modifiersOf(e))) {
        e.preventDefault();
        return;
      }
    }
    const c = commandForKey(e);
    if (!c) return;
    if (c.native) {
      c.prepare?.(ed);
      return; // the browser fires copy / cut / paste
    }
    e.preventDefault();
    if (isEnabled(ed, c)) c.run(ed);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.target === canvas || isEditable(e.target) || inOverlay(e.target)) return;
    ed.engineKey("up", e, modifiersOf(e));
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
