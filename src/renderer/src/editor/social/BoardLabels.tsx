/**
 * A Social file's grid view chrome over the canvas (docs/social.md §19, §23, §24 — the owner's capture of Figma Buzz's
 * grid view): each grid is a container — its posts inside it 8 px apart, black between them — with its name over it (the
 * platform's when it is the platform's only grid, else the format's) and, as its last cell, a dashed "+" (a click
 * makes a post of the grid's format). The pointer anywhere over a container or its name puts it on its card (Figma's
 * bg-selected round it, the name blue in the band over it); a click on the container's black or name selects its
 * posts. None of it takes the pointer — the canvas pans, scrolls and zooms through it; the clicks are read off the
 * canvas's own. Placed from the camera like the safe areas (no React render per camera change); gone in the asset view.
 * Canvas chrome: never a layer of the document — the posts are the engine's, drawn inside.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Guid } from "@/engine/codec";
import { formatById, PLATFORM_NAMES } from "@shared/social/formats";
import type { Platform } from "@shared/social/types";
import { t, useT } from "@/i18n";
import { useEditor, type EditorController } from "../controller";
import { applySelection } from "../agents/mcpTools";
import { layoutOf } from "./arrange";
import { BOARD, type GridBox } from "./board";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { useFocusedPost } from "./focus";
import { useSocialBoard } from "./socialState";
import styles from "./BoardLabels.module.css";

/** Screen px: the card's band over a container (its name) and its padding round it (the owner's captures) */
const CARD_BAND = 32;
const CARD_PAD = 8;

/**
 * Places each child from its canvas box (data-x/y/w/h, canvas units) at the camera now and on every camera change; a
 * `data-above` child sits that many screen px over its point, its bottom there; a `data-center` child is centred on it,
 * moved `data-dx` / `data-dy` screen px; `data-grow` widens a child that many screen px.
 */
export function useCanvasBoxes(ed: EditorController, layer: React.RefObject<HTMLElement | null>, deps: unknown): void {
  useLayoutEffect(() => {
    const run = () => {
      const el = layer.current;
      if (!el) return;
      const cam = ed.store.camera;
      for (const child of Array.from(el.children) as HTMLElement[]) {
        if (child.dataset.x === undefined) continue;
        const x = Number(child.dataset.x) * cam.zoom + cam.x + Number(child.dataset.dx ?? 0);
        const y = Number(child.dataset.y) * cam.zoom + cam.y + Number(child.dataset.dy ?? 0);
        const above = child.dataset.above;
        child.style.transform = above ? `translate(${x}px, ${y - Number(above)}px) translateY(-100%)` : child.dataset.center !== undefined ? `translate(${x}px, ${y}px) translate(-50%, -50%)` : `translate(${x}px, ${y}px)`;
        if (child.dataset.w) child.style.width = `${Number(child.dataset.w) * cam.zoom + Number(child.dataset.grow ?? 0)}px`;
        if (child.dataset.h) child.style.height = `${Number(child.dataset.h) * cam.zoom}px`;
      }
    };
    run();
    return ed.store.subscribe("camera", run);
  }, [ed, layer, deps]);
}

type Box = { x: number; y: number; w: number; h: number };

/** A grid's container as the chrome draws it: its frame's four sides and its empty cells past the "+" (canvas units). */
interface Container {
  key: string;
  formatId: string;
  name: string;
  ids: Guid[];
  frame: GridBox["frame"];
  ring: Box[];
  place: Box;
  empty: Box[];
}

function containersOf(layout: ReturnType<typeof layoutOf>, height: (id: Guid) => number): Container[] {
  const out: Container[] = [];
  for (const s of layout.sections)
    for (const g of s.grids) {
      const f = formatById(g.formatId);
      const platform = s.platform in PLATFORM_NAMES ? PLATFORM_NAMES[s.platform as Platform] : t("Other sizes");
      const name = s.grids.length === 1 ? platform : f ? t(f.name) : t("Other size");
      const { x, y, width, height: h } = g.frame;
      const p = BOARD.pad;
      const ring: Box[] = p > 0 ? [
        { x, y, w: width, h: p },
        { x, y: y + h - p, w: width, h: p },
        { x, y: y + p, w: p, h: h - 2 * p },
        { x: x + width - p, y: y + p, w: p, h: h - 2 * p },
      ] : [];
      // The gaps between the posts: between the columns, and between the rows (the "+"'s row included)
      const inner = { x: x + p, y: y + p, w: width - 2 * p, h: h - 2 * p };
      if (BOARD.gap > 0) {
        for (let k = 1; k < BOARD.columns; k++) ring.push({ x: inner.x + k * g.column + (k - 1) * BOARD.gap, y: inner.y, w: BOARD.gap, h: inner.h });
        const tops = [...new Set([...g.ids.map((id) => layout.places.get(id)?.y ?? inner.y), g.next.y].map((v) => Math.round(v)))].sort((a, b) => a - b);
        for (const top of tops.slice(1)) ring.push({ x: inner.x, y: top - BOARD.gap, w: inner.w, h: BOARD.gap });
      }
      const place = { x: g.next.x, y: g.next.y, w: g.column, h: g.nextHeight };
      // The cells of the "+"'s row past it, and the room under a shorter post in its row
      const empty: Box[] = [];
      const cellRight = g.next.x + g.column;
      if (cellRight < g.x + g.width - 0.5) empty.push({ x: cellRight, y: g.next.y, w: g.x + g.width - cellRight, h: g.nextHeight });
      for (const id of g.ids) {
        const at = layout.places.get(id);
        if (!at) continue;
        const rowBottom = at.y + Math.max(...g.ids.filter((o) => Math.abs((layout.places.get(o)?.y ?? NaN) - at.y) < 0.5).map(height));
        const below = rowBottom - (at.y + height(id));
        if (below > 0.5) empty.push({ x: at.x, y: at.y + height(id), w: g.column, h: below });
      }
      out.push({ key: g.formatId, formatId: g.formatId, name, ids: g.ids, frame: g.frame, ring, place, empty });
    }
  return out;
}

export function BoardLabels() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const focus = useFocusedPost(ed);
  const layer = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<string | null>(null);
  const containers = useMemo(() => {
    if (!board.posts.length) return [];
    const heights = new Map(board.posts.map((p) => [p.id, p.height]));
    return containersOf(layoutOf(ed, board.page), (id) => heights.get(id) ?? 0);
  }, [ed, board]);
  useCanvasBoxes(ed, layer, [containers, hot]);
  // The pointer over a container, its name or its card's padding: that container is hot (the canvas or our chrome).
  useEffect(() => {
    if (focus || !containers.length) return;
    const move = (e: PointerEvent) => {
      const c = ed.canvas?.getBoundingClientRect();
      if (!c) return;
      const cam = ed.store.camera;
      const sx = e.clientX - c.left;
      const sy = e.clientY - c.top;
      const over = containers.find((k) => {
        const x0 = k.frame.x * cam.zoom + cam.x;
        const y0 = k.frame.y * cam.zoom + cam.y;
        const x1 = x0 + k.frame.width * cam.zoom;
        const y1 = y0 + k.frame.height * cam.zoom;
        return sx >= x0 - CARD_PAD && sx <= x1 + CARD_PAD && sy >= y0 - CARD_BAND && sy <= y1 + CARD_PAD;
      });
      setHot(over?.key ?? null);
      // A post dragged in its grid (docs/social.md §25) is drawn over the others: the container's black between the
      // posts (ours, over the canvas) would cross it — gone while a button is down.
      layer.current?.toggleAttribute("data-dragging", (e.buttons & 1) === 1 && !!over);
    };
    // Our pieces take no pointer (the canvas pans, scrolls and zooms through them, the owner 2026-10-25): a click on
    // the canvas over the "+" makes a post; over the container's black or its name, selects its posts.
    let press: { x: number; y: number } | null = null;
    const add = (k: Container) => {
      const id = newPost(ed, editorWriter(ed), { formatId: k.formatId, brandId: ed.ui.get().socialBrandId ?? null });
      applySelection(ed, [id], false);
    };
    const down = (e: PointerEvent) => {
      press = e.button === 0 && e.target === ed.canvas && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? { x: e.clientX, y: e.clientY } : null;
    };
    const up = (e: PointerEvent) => {
      layer.current?.toggleAttribute("data-dragging", false);
      const at = press;
      press = null;
      const c = ed.canvas?.getBoundingClientRect();
      if (!at || !c || Math.hypot(e.clientX - at.x, e.clientY - at.y) > 4 || ed.store.tool !== "MOVE") return;
      const cam = ed.store.camera;
      const sx = e.clientX - c.left;
      const sy = e.clientY - c.top;
      const wx = (sx - cam.x) / cam.zoom;
      const wy = (sy - cam.y) / cam.zoom;
      const inBox = (r: Box) => wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
      for (const k of containers) {
        if (canWritePosts(ed) && inBox(k.place)) return void queueMicrotask(() => add(k));
        const y0 = k.frame.y * cam.zoom + cam.y;
        const x0 = k.frame.x * cam.zoom + cam.x;
        const band = sy >= y0 - CARD_BAND && sy < y0 && sx >= x0 - CARD_PAD && sx <= x0 + k.frame.width * cam.zoom + CARD_PAD;
        if (band || k.ring.some(inBox) || k.empty.some(inBox)) return void queueMicrotask(() => applySelection(ed, k.ids, false));
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, [ed, containers, focus]);
  if (!containers.length || focus) return null;
  const write = canWritePosts(ed);
  return (
    <div ref={layer} className={styles.layer} data-board-labels="">
      {containers.flatMap((k) => {
        const on = hot === k.key;
        return [
          on ? <div key={`card:${k.key}`} className={styles.card} data-x={k.frame.x} data-y={k.frame.y} data-w={k.frame.width} data-h={k.frame.height} /> : null,
          <div
            key={`name:${k.key}`}
            className={styles.band}
            data-on={on || undefined}
            data-x={k.frame.x}
            data-y={k.frame.y}
            data-w={k.frame.width}
            data-grow={2 * CARD_PAD}
            data-dx={-CARD_PAD}
            data-above={0}
            data-grid-name={k.formatId}
          >
            <span className={styles.name}>{k.name}</span>
          </div>,
          ...k.ring.map((r, i) => <div key={`ring:${k.key}:${i}`} className={styles.ground} data-x={r.x} data-y={r.y} data-w={r.w} data-h={r.h} />),
          ...k.empty.map((r, i) => <div key={`empty:${k.key}:${i}`} className={styles.ground} data-x={r.x} data-y={r.y} data-w={r.w} data-h={r.h} />),
          write ? (
            <div key={`add:${k.key}`} className={styles.place} data-x={k.place.x} data-y={k.place.y} data-w={k.place.w} data-h={k.place.h} data-on={on || undefined} aria-label={t("New {format}", { format: k.name })} data-board-add={k.formatId}>
              <svg viewBox="0 0 100 100" className={styles.plus} aria-hidden="true">
                <path d="M50 30v40M30 50h40" />
              </svg>
            </div>
          ) : null,
        ];
      })}
    </div>
  );
}
