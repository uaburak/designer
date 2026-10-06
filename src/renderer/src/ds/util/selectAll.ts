/**
 * As Figma's fields: a click on an unfocused field selects everything in it,
 * so what is typed replaces the value (the browser would otherwise drop the
 * selection on mouseup and leave the caret where the click landed).
 */
export const selectAllOnClick = {
  onPointerDown: (e: React.PointerEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.dataset.selecting = "";
  },
  onMouseUp: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ("selecting" in el.dataset) {
      delete el.dataset.selecting;
      e.preventDefault();
      el.select();
    }
  },
};

/** The key that left a field, as an ExitReason (null: it stays). */
export function exitKey(e: { key: string; shiftKey: boolean }): "enter" | "escape" | "tab" | "shift-tab" | null {
  if (e.key === "Enter") return "enter";
  if (e.key === "Escape") return "escape";
  if (e.key === "Tab") return e.shiftKey ? "shift-tab" : "tab";
  return null;
}
