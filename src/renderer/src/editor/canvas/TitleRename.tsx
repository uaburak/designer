/**
 * Renaming a frame (or a section) from its title on the canvas: a double-click on the title makes the engine emit
 * REQUEST_RENAME with the title's box (canvas CSS px); the name is edited in place over it, Figma's way — Enter, Tab
 * or leaving keeps it, Esc puts it back.
 */
import { InlineEdit } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import styles from "./TitleRename.module.css";

export function attachTitleRename(ed: EditorController, canvas: HTMLCanvasElement): () => void {
  const offRename = ed.engine.on("REQUEST_RENAME", (e) => {
    const r = canvas.getBoundingClientRect();
    const name = ed.store.readNode(e.ref)?.name ?? "";
    ed.ui.set({ titleRename: { ref: e.ref, name, x: r.left + e.x, y: r.top + e.y, width: Math.max(60, e.width), height: Math.max(16, e.height) } });
  });
  // The canvas moved under the field: it goes, keeping what was typed (as leaving it does).
  const offCamera = ed.engine.on("CAMERA_CHANGED", () => {
    if (ed.ui.get().titleRename) ed.ui.set({ titleRename: null });
  });
  return () => {
    offRename();
    offCamera();
  };
}

export function renameNode(ed: EditorController, ref: Guid, name: string) {
  const next = name.trim();
  if (next && next !== ed.store.readNode(ref)?.name) ed.setProps([ref], { name: next }, "Rename");
}

export function TitleRename() {
  const ed = useEditor();
  const at = useUI((s) => s.titleRename);
  if (!at) return null;
  const close = () => {
    ed.ui.set({ titleRename: null });
    ed.focusCanvas();
  };
  return (
    <div className={styles.root} style={{ left: at.x, top: at.y, width: at.width, height: at.height }} data-title-rename={at.ref}>
      <InlineEdit
        label="Rename"
        value={at.name}
        editing
        onCommit={(v) => renameNode(ed, at.ref, v)}
        onExit={close}
        onCancel={() => undefined}
        className={styles.edit}
      />
    </div>
  );
}
