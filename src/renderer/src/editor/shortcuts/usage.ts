/**
 * Which shortcuts the user has used (Figma lights them in the Keyboard shortcuts panel: the label blue, the keys
 * filled). Watched where they happen, ahead of whoever handles them (the engine on the canvas, the keyboard layer):
 * a key press that is a command's key, the canvas's own keys (Enter, Tab, \, Esc, the opacity digits) and the
 * pointer's modifiers on the canvas (Space-drag, ⌘ click / drag, ⌥ while moving, ⌥ ⇧ ⌘ while resizing). Keys typed
 * into a text field or handled by a menu or dialog are no shortcut.
 */
import { IS_MAC } from "@/ds";
import type { CursorKind } from "@/engine/codec";
import type { EditorController } from "../controller";
import { bindingCode, commandForKey } from "../commands";
import { inOverlay, isEditable } from "../keyboard";
import { OPACITY_KEY_WINDOW_MS } from "../opacityKeys";
import { shortcutPrefs } from "./prefs";

/** The usage id a key press on the canvas means, besides a command's (the panel's fixed rows). */
export function canvasKeyUsage(e: Pick<KeyboardEvent, "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">, state: { selection: number; vector: boolean }): string | null {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (!plain) return null;
  if (state.vector && e.code === "KeyB" && e.shiftKey) return "paint";
  if (!state.selection) return null;
  if (e.code === "Escape" && !e.shiftKey) return "select-none";
  if (e.code === "Tab") return e.shiftKey ? "select-previous-sibling" : "select-next-sibling";
  if (e.code === "Backslash" && !e.shiftKey) return "select-parent";
  return null;
}

/** The opacity rows: "0","0" 0 %, "1" 10 %, "5" 50 %, "0" 100 % (a second digit within the window makes two). */
export function opacityUsage(digit: number, previous: { digit: number; at: number } | null, now: number): string | null {
  if (digit === 0 && previous?.digit === 0 && now - previous.at < OPACITY_KEY_WINDOW_MS) return "opacity-0";
  if (previous && now - previous.at < OPACITY_KEY_WINDOW_MS) return null;
  return digit === 0 ? "opacity-100" : digit === 1 ? "opacity-10" : digit === 5 ? "opacity-50" : null;
}

/** A key being recorded in the panel is no shortcut. */
const recording = () => typeof document !== "undefined" && !!document.querySelector("[data-shortcut-recording]");

const primary = (e: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

export function attachUsageTracking(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  const mark = (id: string | null) => {
    if (id) shortcutPrefs.markUsed(id);
  };
  let lastDigit: { digit: number; at: number } | null = null;
  let space = false;
  let overCanvas = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || isEditable(e.target) || inOverlay(e.target) || recording()) return;
    if (e.code === "Space") space = true;
    const vector = !!ed.vector.state.get().active;
    const c = commandForKey(e);
    if (c) mark(c.id);
    mark(canvasKeyUsage(e, { selection: ed.selection.length, vector }));
    // Enter: the selected shape or image edited (vector edit mode) or its children selected — whichever it did.
    if ((e.code === "Enter" || e.code === "NumpadEnter") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && ed.selection.length && !vector) {
      const before = ed.selection.join(",");
      setTimeout(() => {
        if (ed.vector.state.get().active) mark("edit-shape");
        else if (ed.selection.join(",") !== before) mark("select-children");
      }, 0);
    }
    if (e.code === "Enter" && e.shiftKey && ed.selection.length) mark("select-parent");
    // ⌥ over the canvas with a selection: the distances to what the pointer is over.
    if ((e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") && overCanvas && ed.selection.length && !dragging) mark("measure");
    const digit = /^Digit(\d)$/.exec(bindingCode(e.code) ?? "");
    if (digit && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && ed.selection.length && !vector) {
      const now = e.timeStamp || performance.now();
      mark(opacityUsage(Number(digit[1]), lastDigit, now));
      lastDigit = { digit: Number(digit[1]), at: now };
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") space = false;
  };

  // The pointer on the canvas: what it was pressed on (the engine's cursor then), the modifiers while it moved.
  let cursor: CursorKind = "DEFAULT";
  let down: { x: number; y: number; cursor: CursorKind; space: boolean; mod: boolean; changed: boolean; mods: Set<string> } | null = null;
  let dragging = false;
  const offCursor = ed.engine.onCursor((kind) => {
    cursor = kind;
  });
  const offChanged = ed.engine.on("DOCUMENT_CHANGED", () => {
    if (down) down.changed = true;
  });
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, cursor, space: space || ed.store.tool === "HAND", mod: primary(e), changed: false, mods: new Set() };
    dragging = false;
  };
  const onCanvasMove = () => {
    overCanvas = true;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!down) return;
    if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) dragging = true;
    if (!dragging) return;
    if (e.altKey) down.mods.add("alt");
    if (e.shiftKey) down.mods.add("shift");
    if (primary(e)) down.mods.add("mod");
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    const vector = !!ed.vector.state.get().active;
    if (!dragging) {
      if (d.mod && !vector) mark("deep-select");
      return;
    }
    dragging = false;
    if (d.space) mark("pan");
    else if (d.cursor === "RESIZE") {
      if (d.mods.has("alt")) mark("resize-center");
      if (d.mods.has("shift")) mark("resize-proportional");
      if (d.mods.has("mod")) mark("resize-crop");
    } else if (vector) {
      if (d.mods.has("mod")) mark("bend");
    } else if (d.mod && !d.changed) mark("deep-select-rect");
    else if (d.mods.has("alt") && d.changed) mark("duplicate-drag");
  };
  const onLeave = () => {
    overCanvas = false;
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointermove", onCanvasMove);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  return () => {
    offCursor();
    offChanged();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("pointermove", onCanvasMove);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
  };
}
