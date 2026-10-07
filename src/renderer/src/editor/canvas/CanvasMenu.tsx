/**
 * The context menu over the canvas and the Layers panel (Figma's). On the
 * canvas the engine decides: a right click (or ⌃-click) selects what a left
 * click would pick unless it is already selected, then emits CONTEXT_MENU
 * with every layer under the point (`hits`, topmost first, each path
 * innermost first) — "Select layer ▸" lists them.
 */
import { ContextMenu } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { canvasMenu, runMenuItem } from "../menus";

/** The layers "Select layer ▸" offers: each hit's path, innermost first, without repeats. */
export function layersUnder(hits: readonly (readonly Guid[])[]): Guid[] {
  const out: Guid[] = [];
  for (const path of hits) for (const id of path) if (!out.includes(id)) out.push(id);
  return out;
}

export function attachCanvasMenu(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  return ed.engine.on("CONTEXT_MENU", (e) => {
    const r = canvas.getBoundingClientRect();
    ed.ui.set({ contextMenu: { x: r.left + e.x, y: r.top + e.y, canvas: { x: e.x, y: e.y }, layers: layersUnder(e.hits) } });
  });
}

export function CanvasMenu() {
  const ed = useEditor();
  const at = useUI((s) => s.contextMenu);
  if (!at) return null;
  const layers = (at.layers ?? []).map((id) => ({ id, name: ed.store.readNode(id)?.name ?? "" }));
  return (
    <ContextMenu
      at={{ x: at.x, y: at.y }}
      entries={canvasMenu(ed, layers)}
      label="Canvas"
      onSelect={(id) => void runMenuItem(ed, id)}
      onClose={() => {
        ed.ui.set({ contextMenu: null });
        if (!ed.ui.get().renaming) ed.focusCanvas();
      }}
    />
  );
}
