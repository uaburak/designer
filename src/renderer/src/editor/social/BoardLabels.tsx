/**
 * A Social file's board chrome over the canvas (docs/social.md §19): each section's platform title and each grid's
 * title (the format, its size, how many), and a "+" cell at the end of every grid — a new post of that format, which
 * opens in focus. Placed from the camera like the safe areas (no React render per camera change); hidden while a post
 * is in focus and while the canvas zooms. Canvas chrome: never a layer of the document.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { Icon } from "@/ds";
import { formatById, PLATFORM_NAMES } from "@shared/social/formats";
import type { Platform } from "@shared/social/types";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { layoutOf } from "./arrange";
import { BOARD } from "./board";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { useFocusedPost } from "./focus";
import { useSocialBoard } from "./socialState";
import styles from "./BoardLabels.module.css";

/** Zoom held still this long (ms) before the labels come back */
const ZOOM_SETTLE_MS = 150;

/** Screen px between a grid's posts and its title's bottom (the engine draws each post's name in it), and the section's title over the grids' */
const GRID_TITLE_GAP = 22;
const SECTION_TITLE_GAP = 48;

/**
 * Places each child from its canvas box (data-x/y/w/h, canvas units) at the camera now and on every camera change; a
 * `data-above` child sits that many screen px over its point, its bottom there.
 */
export function useCanvasBoxes(ed: EditorController, layer: React.RefObject<HTMLElement | null>, deps: unknown): void {
  useLayoutEffect(() => {
    let zoom = ed.store.camera.zoom;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const el = layer.current;
      if (!el) return;
      const cam = ed.store.camera;
      if (cam.zoom !== zoom) {
        zoom = cam.zoom;
        el.toggleAttribute("data-zooming", true);
        clearTimeout(timer);
        timer = setTimeout(() => layer.current?.toggleAttribute("data-zooming", false), ZOOM_SETTLE_MS);
      }
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const x = Number(child.dataset.x) * cam.zoom + cam.x;
        const y = Number(child.dataset.y) * cam.zoom + cam.y;
        const above = child.dataset.above;
        child.style.transform = above ? `translate(${x}px, ${y - Number(above)}px) translateY(-100%)` : `translate(${x}px, ${y}px)`;
        if (child.dataset.w) child.style.width = `${Number(child.dataset.w) * cam.zoom}px`;
        if (child.dataset.h) child.style.height = `${Number(child.dataset.h) * cam.zoom}px`;
      }
    };
    run();
    const off = ed.store.subscribe("camera", run);
    return () => {
      off();
      clearTimeout(timer);
    };
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
      {layout.sections.flatMap((s) => {
        const count = s.grids.reduce((n, g) => n + g.ids.length, 0);
        const name = s.platform in PLATFORM_NAMES ? PLATFORM_NAMES[s.platform as Platform] : t("Other sizes");
        return [
          <div key={`s:${s.platform}`} className={styles.section} data-x={s.x} data-y={s.y + BOARD.sectionHead} data-above={SECTION_TITLE_GAP} data-section={s.platform}>
            <span className={styles.sectionName}>{name}</span>
            <span className={styles.count}>{t("{n} designs", { n: String(count) })}</span>
          </div>,
          ...s.grids.flatMap((g) => {
            const f = formatById(g.formatId);
            const tallest = Math.max(...g.ids.map((id) => board.posts.find((p) => p.id === id)?.height ?? 0));
            return [
              <div key={`g:${g.formatId}`} className={styles.grid} data-x={g.x} data-y={g.y} data-above={GRID_TITLE_GAP} data-grid={g.formatId}>
                <span className={styles.gridName}>{f ? t(f.name) : t("Other size")}</span>
                {f && <span className={styles.meta}>{`${f.aspect} · ${f.width} × ${f.height}`}</span>}
                <span className={styles.count}>{g.ids.length}</span>
              </div>,
              write ? (
                <button key={`a:${g.formatId}`} type="button" className={styles.add} data-x={g.next.x} data-y={g.next.y} data-w={g.column} data-h={tallest} aria-label={t("New {format}", { format: f ? t(f.name) : t("post") })} onClick={() => add(g.formatId)} data-board-add={g.formatId}>
                  <Icon name="24.plus.small" />
                </button>
              ) : null,
            ];
          }),
        ];
      })}
    </div>
  );
}
