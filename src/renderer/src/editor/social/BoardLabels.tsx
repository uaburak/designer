/**
 * A Social file's grid view chrome over the canvas (docs/social.md §19, §23 — Figma Buzz's grid view): no titles over
 * the grids (each post's name is the engine's, on its card); a small blue dot beside each grid's last post and one under
 * the first post of its last row. The pointer on a dot turns it into a "+" and shows where the new post would go — a
 * dashed place of its size; a click makes it: beside, a post of the grid's format (it is selected); under, the format
 * picked from the New post menu (its own grid). Placed from the camera like the safe areas (no React render per camera
 * change); gone in the asset view. Canvas chrome: never a layer of the document.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, Icon } from "@/ds";
import { formatById } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { useBrands } from "../studio/forms";
import { layoutOf } from "./arrange";
import { BOARD } from "./board";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { useFocusedPost } from "./focus";
import { boardBrand, newPostEntries, pickNewPost } from "./NewPostMenu";
import { useSocialBoard } from "./socialState";
import styles from "./BoardLabels.module.css";

/** Screen px from a grid's last post to its dot beside it, and from its last row to the dot under it (the owner's Buzz captures) */
const DOT_BESIDE = 20;
const DOT_UNDER = 25;

/**
 * Places each child from its canvas box (data-x/y/w/h, canvas units) at the camera now and on every camera change; a
 * `data-above` child sits that many screen px over its point, its bottom there; a `data-center` child is centred on it,
 * moved `data-dx` / `data-dy` screen px.
 */
export function useCanvasBoxes(ed: EditorController, layer: React.RefObject<HTMLElement | null>, deps: unknown): void {
  useLayoutEffect(() => {
    const run = () => {
      const el = layer.current;
      if (!el) return;
      const cam = ed.store.camera;
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const x = Number(child.dataset.x) * cam.zoom + cam.x + Number(child.dataset.dx ?? 0);
        const y = Number(child.dataset.y) * cam.zoom + cam.y + Number(child.dataset.dy ?? 0);
        const above = child.dataset.above;
        child.style.transform = above ? `translate(${x}px, ${y - Number(above)}px) translateY(-100%)` : child.dataset.center !== undefined ? `translate(${x}px, ${y}px) translate(-50%, -50%)` : `translate(${x}px, ${y}px)`;
        if (child.dataset.w) child.style.width = `${Number(child.dataset.w) * cam.zoom}px`;
        if (child.dataset.h) child.style.height = `${Number(child.dataset.h) * cam.zoom}px`;
      }
    };
    run();
    return ed.store.subscribe("camera", run);
  }, [ed, layer, deps]);
}

/** A dot's new post: where it would go (canvas units) and what a click makes. */
interface Dot {
  key: string;
  /** The dot's point */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** The dashed place */
  place: { x: number; y: number; w: number; h: number };
  label: string;
  /** Beside: the grid's format; under: the menu */
  formatId: string | null;
}

export function BoardLabels() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  const { brands } = useBrands();
  const layout = useMemo(() => (board.posts.length ? layoutOf(ed, board.page) : null), [ed, board]);
  const layer = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dots = useMemo(() => {
    if (!layout) return [];
    const out: Dot[] = [];
    for (const s of layout.sections)
      for (const g of s.grids) {
        const rows = (id: string) => board.posts.find((p) => p.id === id);
        const last = rows(g.ids[g.ids.length - 1]);
        const at = layout.places.get(g.ids[g.ids.length - 1]);
        if (!last || !at) continue;
        const f = formatById(g.formatId);
        const name = f ? t(f.name) : t("Other size");
        // The last row: its first post and its bottom
        const firstOfRow = g.ids[Math.floor((g.ids.length - 1) / BOARD.columns) * BOARD.columns];
        const rowAt = layout.places.get(firstOfRow) ?? at;
        const rowPost = rows(firstOfRow) ?? last;
        const rowBottom = Math.max(...g.ids.slice(Math.floor((g.ids.length - 1) / BOARD.columns) * BOARD.columns).map((id) => (layout.places.get(id)?.y ?? 0) + (rows(id)?.height ?? 0)));
        out.push({ key: `beside:${g.formatId}`, x: at.x + last.width, y: at.y + last.height / 2, dx: DOT_BESIDE, dy: 0, place: { x: g.next.x, y: g.next.y, w: g.column, h: last.height }, label: t("New {format}", { format: name }), formatId: g.formatId });
        out.push({ key: `under:${g.formatId}`, x: rowAt.x + rowPost.width / 2, y: rowBottom, dx: 0, dy: DOT_UNDER, place: { x: rowAt.x, y: rowBottom + BOARD.gap, w: rowPost.width, h: rowPost.height }, label: t("New post…"), formatId: null });
      }
    return out;
  }, [layout, board]);
  useCanvasBoxes(ed, layer, [dots, hot]);
  if (!layout || focus) return null;
  const write = canWritePosts(ed);
  const make = (d: Dot, at: { x: number; y: number }) => {
    if (!d.formatId) return setMenu(at);
    const id = newPost(ed, editorWriter(ed), { formatId: d.formatId, brandId: ed.ui.get().socialBrandId ?? null });
    applySelection(ed, [id], false);
    setHot(null);
  };
  const shown = dots.find((d) => d.key === hot);
  return (
    <div ref={layer} className={styles.layer} data-board-labels="">
      {shown && <div key={`place:${shown.key}`} className={styles.place} data-x={shown.place.x} data-y={shown.place.y} data-w={shown.place.w} data-h={shown.place.h} data-board-place={shown.key} />}
      {write &&
        dots.map((d) => (
          <button
            key={d.key}
            type="button"
            className={styles.dot}
            data-x={d.x}
            data-y={d.y}
            data-dx={d.dx}
            data-dy={d.dy}
            data-center=""
            data-hot={hot === d.key || undefined}
            aria-label={d.label}
            title={d.label}
            onPointerEnter={() => setHot(d.key)}
            onPointerLeave={() => setHot((h) => (h === d.key && !menu ? null : h))}
            onClick={(e) => make(d, { x: e.clientX, y: e.clientY })}
            data-board-add={d.formatId ?? "menu"}
          >
            <Icon name="24.plus.small" />
          </button>
        ))}
      {menu && (
        <ContextMenu
          at={menu}
          entries={newPostEntries(boardBrand(ed, brands))}
          label={t("New post")}
          onSelect={(id) => pickNewPost(ed, id, brands)}
          onClose={() => {
            setMenu(null);
            setHot(null);
          }}
        />
      )}
    </div>
  );
}
