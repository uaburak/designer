/**
 * Safe areas (docs/social.md §6.4): over each post whose format's UI covers part of it (stories, reels, vertical
 * video), the covered bands — warning-tinted at half opacity with a dashed edge — so nothing important is put under
 * the platform's buttons and captions. DOM over the canvas like the agents' image placeholders: placed straight from
 * the camera (no React render per camera change), hidden while the canvas zooms (as the comments' pins are) and a band
 * below 8 px on screen. On by default in Social; the toolbar's Safe areas (`social.toggle-safe-areas`) turns them off.
 * Canvas chrome: never a layer of the document.
 */
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { formatById } from "@shared/social/formats";
import type { Insets } from "@shared/social/types";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { useSocialBoard, type PostRow } from "./socialState";
import { useFocusedPost } from "./focus";
import styles from "./SafeAreaOverlay.module.css";

/** A band thinner than this on screen (px) isn't drawn */
const MIN_BAND = 8;
/** The zoom held still this long (ms) before the bands come back */
const ZOOM_SETTLE_MS = 150;

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Places a layer's children (each `data-post` names its post's row) from the camera now and on every camera change;
 * `zooming` is set on the layer while the zoom moves. `place` positions one child at the camera.
 */
export function useCameraPlacement(ed: EditorController, layer: RefObject<HTMLElement | null>, rows: readonly PostRow[], place: (el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }) => void): void {
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
        const row = rows.find((r) => r.id === child.dataset.post);
        if (row) place(child, row, cam);
      }
    };
    run();
    const off = ed.store.subscribe("camera", run);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [ed, layer, rows, place]);
}

/** The covered bands of a post, in its own px (the format's insets scaled to the frame's size). */
export function bandsOf(row: PostRow): Insets | null {
  const f = formatById(row.data.formatId);
  if (!f) return null;
  const a = f.safeArea;
  if (!a.top && !a.right && !a.bottom && !a.left) return null;
  const sx = row.width / f.width;
  const sy = row.height / f.height;
  return { top: a.top * sy, right: a.right * sx, bottom: a.bottom * sy, left: a.left * sx };
}

function placeBands(el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }): void {
  const z = cam.zoom;
  el.style.transform = `translate(${row.x * z + cam.x}px, ${row.y * z + cam.y}px)`;
  el.style.width = `${row.width * z}px`;
  el.style.height = `${row.height * z}px`;
  const bands = bandsOf(row);
  for (const band of Array.from(el.children) as HTMLElement[]) {
    const side = band.dataset.band as (typeof SIDES)[number];
    const px = (bands?.[side] ?? 0) * z;
    band.hidden = px < MIN_BAND;
    band.style.setProperty(side === "top" || side === "bottom" ? "height" : "width", `${px}px`);
    // The side bands run between the top and bottom ones.
    if (side === "left" || side === "right") {
      band.style.top = `${(bands?.top ?? 0) * z}px`;
      band.style.bottom = `${(bands?.bottom ?? 0) * z}px`;
    }
  }
}

export function SafeAreaOverlay() {
  const ed = useEditor();
  const on = useUI((s) => s.socialSafeAreas !== false);
  const board = useSocialBoard(ed);
  // In focus (a Social file's single post, docs/social.md §20) only that post is drawn: only its bands.
  const focus = useFocusedPost(ed);
  const rows = useMemo(() => (on ? board.posts.filter((p) => bandsOf(p) && (!focus || p.id === focus)) : []), [on, board, focus]);
  const layer = useRef<HTMLDivElement>(null);
  useCameraPlacement(ed, layer, rows, placeBands);
  if (!rows.length) return null;
  return (
    <div ref={layer} className={styles.layer} aria-hidden data-safe-areas="">
      {rows.map((p) => (
        <div key={p.id} className={styles.post} data-post={p.id}>
          {SIDES.map((side) => (
            <div key={side} className={styles.band} data-band={side} />
          ))}
        </div>
      ))}
    </div>
  );
}
