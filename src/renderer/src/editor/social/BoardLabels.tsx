/**
 * A Social file's board chrome over the canvas (docs/social.md §19, §21 — Buzz's grid view, kept quiet): one small
 * title over each grid (its format and how many; the engine draws each post's name as a frame's), and Buzz's blue "+"
 * beside each grid's last post — a new post of that format, which opens in focus. Placed from the camera like the safe
 * areas (no React render per camera change); the titles go when the board is zoomed too far out to hold them, and
 * everything while a post is in focus. Canvas chrome: never a layer of the document.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { Icon } from "@/ds";
import { formatById } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { layoutOf } from "./arrange";
import { BOARD } from "./board";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { useFocusedPost } from "./focus";
import { useSocialBoard } from "./socialState";
import styles from "./BoardLabels.module.css";

/** Screen px between a grid's posts and its title's bottom: the engine draws each post's name in it */
const GRID_TITLE_GAP = 32;
/** Under this many screen px between two sections the titles would crowd the posts: the layer is dense, titles hidden */
const DENSE_BELOW = 64;

/**
 * Places each child from its canvas box (data-x/y/w/h, canvas units) at the camera now and on every camera change; a
 * `data-above` child sits that many screen px over its point, its bottom there; a `data-center` child is centred on it.
 */
export function useCanvasBoxes(ed: EditorController, layer: React.RefObject<HTMLElement | null>, deps: unknown): void {
  useLayoutEffect(() => {
    const run = () => {
      const el = layer.current;
      if (!el) return;
      const cam = ed.store.camera;
      el.toggleAttribute("data-dense", (BOARD.sectionGap + BOARD.sectionHead) * cam.zoom < DENSE_BELOW);
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const x = Number(child.dataset.x) * cam.zoom + cam.x;
        const y = Number(child.dataset.y) * cam.zoom + cam.y;
        const above = child.dataset.above;
        child.style.transform = above ? `translate(${x}px, ${y - Number(above)}px) translateY(-100%)` : child.dataset.center !== undefined ? `translate(${x}px, ${y}px) translate(-50%, -50%)` : `translate(${x}px, ${y}px)`;
        if (child.dataset.w) child.style.width = `${Number(child.dataset.w) * cam.zoom}px`;
        if (child.dataset.h) child.style.height = `${Number(child.dataset.h) * cam.zoom}px`;
      }
    };
    run();
    const off = ed.store.subscribe("camera", run);
    return off;
  }, [ed, layer, deps]);
}

export function BoardLabels() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  const layout = useMemo(() => (board.posts.length ? layoutOf(ed, board.page) : null), [ed, board]);
  const layer = useRef<HTMLDivElement>(null);
  useCanvasBoxes(ed, layer, layout);
  if (!layout || focus) return null;
  const write = canWritePosts(ed);
  const add = (formatId: string) => {
    const id = newPost(ed, editorWriter(ed), { formatId, brandId: ed.ui.get().socialBrandId ?? null });
    applySelection(ed, [id], false);
  };
  return (
    <div ref={layer} className={styles.layer} data-board-labels="">
      {layout.sections.flatMap((s) =>
        s.grids.flatMap((g) => {
          const f = formatById(g.formatId);
          const name = f ? t(f.name) : t("Other size");
          const last = g.ids[g.ids.length - 1];
          const at = layout.places.get(last);
          const post = board.posts.find((p) => p.id === last);
          return [
            <div key={`g:${g.formatId}`} className={styles.grid} data-x={g.x} data-y={g.y} data-above={GRID_TITLE_GAP} data-grid={g.formatId}>
              <span className={styles.gridName}>{name}</span>
              <span className={styles.count}>{g.ids.length}</span>
            </div>,
            write && at && post ? (
              <button key={`a:${g.formatId}`} type="button" className={styles.add} data-x={at.x + post.width + BOARD.gap / 2} data-y={at.y + post.height / 2} data-center="" aria-label={t("New {format}", { format: name })} title={t("New {format}", { format: name })} onClick={() => add(g.formatId)} data-board-add={g.formatId}>
                <Icon name="24.plus.small" />
              </button>
            ) : null,
          ];
        })
      )}
    </div>
  );
}
