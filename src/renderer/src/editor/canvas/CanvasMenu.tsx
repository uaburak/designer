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
import { canvasMenu, commandItem, runMenuItem } from "../menus";
import { layerIcon } from "../panels/Layers";
import { detailsOf, DETAIL_FIELDS, type TreeNode } from "../model/layerTree";

/** The layers "Select layer ▸" offers: each hit's path, innermost first, without repeats. */
export function layersUnder(hits: readonly (readonly Guid[])[]): Guid[] {
  const out: Guid[] = [];
  for (const path of hits) for (const id of path) if (!out.includes(id)) out.push(id);
  return out;
}

export function attachCanvasMenu(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  return ed.engine.on("CONTEXT_MENU", (e) => {
    const r = canvas.getBoundingClientRect();
    ed.ui.set({ contextMenu: { x: r.left + e.x, y: r.top + e.y, canvas: { x: e.x, y: e.y }, layers: layersUnder(e.hits), guide: e.targetKind === "GUIDE" } });
  });
}

/**
 * Grid tracks selected on the canvas (the engine's GRID_TRACKS, round 6): kept in the UI state (the Auto layout
 * section highlights them); a click on a pill's label (or Enter) opens the track label editor over it.
 */
export function attachGridTracks(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  const offSel = ed.engine.on("SELECTION_CHANGED", () => {
    if (ed.ui.get().gridTracks || ed.ui.get().gridTrackEditor) ed.ui.set({ gridTracks: null, gridTrackEditor: null });
  });
  const off = ed.engine.on("GRID_TRACKS", (e) => {
    if (!e.frame || !e.tracks.length) {
      ed.ui.set({ gridTracks: null, gridTrackEditor: null });
      return;
    }
    const r = canvas.getBoundingClientRect();
    ed.ui.set({
      gridTracks: { frame: e.frame, axis: e.axis, tracks: e.tracks },
      ...(e.edit ? { gridTrackEditor: { x: r.left + e.x, y: r.top + e.y, width: Math.max(1, e.width), height: Math.max(1, e.height) } } : {}),
    });
  });
  return () => {
    off();
    offSel();
  };
}

export function CanvasMenu() {
  const ed = useEditor();
  const at = useUI((s) => s.contextMenu);
  if (!at) return null;
  // "Select layer ▸" rows: each layer's type icon (as its Layers row shows it) and its padlock when locked.
  const layers = (at.layers ?? []).map((id) => {
    const n = ed.engine.readNode(id, { fields: [...DETAIL_FIELDS] }) as (NonNullable<ReturnType<typeof ed.store.readNode>> & { isStateGroup?: boolean }) | null;
    const row: TreeNode = {
      id,
      parent: null,
      type: String(n?.type ?? "RECTANGLE"),
      children: [],
      group: n?.type === "GROUP" || (n?.type === "FRAME" && n.resizeToFit === true),
      stateGroup: n?.isStateGroup === true,
      ...detailsOf(n ?? undefined),
    };
    return { id, name: n?.name ?? "", locked: !!n?.locked, icon: layerIcon(row) };
  });
  return (
    <ContextMenu
      at={{ x: at.x, y: at.y }}
      entries={at.guide ? [commandItem(ed, "canvas.remove-guide")] : canvasMenu(ed, layers)}
      label="Canvas"
      onSelect={(id) => void runMenuItem(ed, id)}
      onClose={() => {
        ed.ui.set({ contextMenu: null });
        if (!ed.ui.get().renaming) ed.focusCanvas();
      }}
    />
  );
}
