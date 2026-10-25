/**
 * A Social file's two views (docs/social.md §19, §23 — Figma Buzz's grid view and asset view). Grid view: the board,
 * a click selects a post (no camera move). Asset view: one post shown — the selection's post, else the last one shown,
 * else the board's first — the camera gliding to it (centred in what the panels and the posts column leave, 320 ms,
 * ease-out; a jump with Reduce motion on) and back to the board's view when the grid view returns. Only the camera
 * moves: nothing is written, no undo step.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Guid } from "@/engine/codec";
import { glideMs } from "@/ds";
import type { EditorController } from "../controller";
import { onBoard } from "../devmode/devMode";
import { BOARD } from "./board";
import { layoutOf } from "./arrange";
import { socialOf, type PostRow } from "./socialState";

/** The asset view's column of posts at the canvas's left (FocusChrome.module.css), CSS px */
export const ASSET_COLUMN = 72;

/** The board's posts in reading order: sections, their grids, each grid's posts (the asset view's column). */
export function postsInOrder(ed: EditorController): Guid[] {
  return layoutOf(ed).sections.flatMap((s) => s.grids.flatMap((g) => g.ids));
}

/** The view of a Social file's board: grid (Buzz's default) or asset. */
export const socialView = (ed: EditorController): "grid" | "asset" => (ed.ui.get().socialView === "asset" ? "asset" : "grid");

/**
 * The post the asset view shows: the selection's post, else the last one shown, else the board's first; null in the
 * grid view, out of Social, or with no posts.
 */
export function shownPost(ed: EditorController): Guid | null {
  if (!onBoard(ed) || socialView(ed) !== "asset") return null;
  const selected = focusedPost(ed)?.id;
  if (selected) return selected;
  const kept = ed.ui.get().socialAsset;
  if (kept && socialOf(ed).post(kept)) return kept;
  return postsInOrder(ed)[0] ?? null;
}

/** The post the selection is (or is inside of): null for none, several posts, or layers outside a post. */
export function focusedPost(ed: EditorController): PostRow | null {
  const sel = ed.store.selection.refs;
  if (!sel.length) return null;
  const board = socialOf(ed).get();
  if (!board.posts.length) return null;
  const posts = new Map(board.posts.map((p) => [p.id, p]));
  let found: PostRow | null = null;
  for (const id of sel) {
    const post = postOf(ed, id, posts);
    if (!post || (found && found.id !== post.id)) return null;
    found = post;
  }
  return found;
}

/** The post a layer is or is in (its top-level ancestor on the page), when that is a post. */
function postOf(ed: EditorController, id: Guid, posts: ReadonlyMap<Guid, PostRow>): PostRow | null {
  let at: Guid | undefined = id;
  for (let depth = 0; at && depth < 64; depth++) {
    const hit = posts.get(at);
    if (hit) return hit;
    at = ed.engine.readNode(at, { fields: ["parentIndex"] })?.parentIndex?.guid as Guid | undefined;
    if (at === ed.store.page) return null;
  }
  return null;
}

/** The asset view's post (shownPost), re-rendering when it changes. */
export function useFocusedPost(ed: EditorController): Guid | null {
  return useSyncExternalStore(
    (on) => {
      const a = ed.store.subscribe("selection", on);
      const b = socialOf(ed).subscribe(on);
      const c = ed.ui.subscribe(on);
      return () => {
        a();
        b();
        c();
      };
    },
    () => shownPost(ed),
  );
}

/**
 * Opens a post (its Design glyph on the grid view, docs/social.md §29): selected, shown alone in the asset view — the
 * post grows from its place to the middle (the others gone at once, the camera gliding).
 */
export function openPost(ed: EditorController, id: Guid): void {
  ed.engine.setSelection([id]);
  ed.ui.set({ socialAsset: id, socialPanelTab: "design" });
  setSocialView(ed, "asset");
}

/** The selection's post (focusedPost), re-rendering when it changes: the right panel's post in either view. */
export function useSelectionPost(ed: EditorController): Guid | null {
  return useSyncExternalStore(
    (on) => {
      const a = ed.store.subscribe("selection", on);
      const b = socialOf(ed).subscribe(on);
      return () => {
        a();
        b();
      };
    },
    () => focusedPost(ed)?.id ?? null,
  );
}

/** Grid view ⇄ asset view (the rail's two buttons, docs/social.md §23). */
export function setSocialView(ed: EditorController, view: "grid" | "asset"): void {
  if (socialView(ed) === view) return;
  ed.ui.set({ socialView: view });
  ed.focusCanvas();
}

type View = { x: number; y: number; zoom: number };

const ease = (t: number) => 1 - Math.pow(1 - t, 4);

/** The camera from where it is to `to` (the visible part's centre and zoom) over `ms`; returns the stop. */
export function glide(ed: EditorController, to: View, ms = 320, done?: () => void): () => void {
  const from = ed.engine.viewCenter();
  const time = glideMs(ms);
  if (time <= 0 || ed.engine.destroyed) {
    ed.engine.centerOn(to.x, to.y, to.zoom);
    done?.();
    return () => {};
  }
  const start = performance.now();
  let frame = 0;
  const step = (now: number) => {
    if (ed.engine.destroyed) return;
    const k = ease(Math.min(1, (now - start) / time));
    // The zoom in log space: a glide feels even whether it zooms in or out.
    const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
    ed.engine.centerOn(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, zoom);
    if (k < 1) frame = requestAnimationFrame(step);
    else finish();
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(land);
    done?.();
  };
  frame = requestAnimationFrame(step);
  // A page the browser throttles (hidden, in the background) gets no frames: the camera lands where it goes anyway.
  const land = setTimeout(() => {
    cancelAnimationFrame(frame);
    if (!ed.engine.destroyed) ed.engine.centerOn(to.x, to.y, to.zoom);
    finish();
  }, time + 60);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(land);
  };
}

/** The view that fits a post in what the panels and the asset view's column leave (a margin for its toolbar). */
export function viewOf(ed: EditorController, post: PostRow): View {
  const view = document.querySelector<HTMLElement>("[data-canvas-view]")?.getBoundingClientRect();
  const w = Math.max(200, (view?.width ?? 1200) - ASSET_COLUMN - 120);
  const h = Math.max(200, (view?.height ?? 800) - 200);
  const zoom = Math.min(w / Math.max(1, post.width), h / Math.max(1, post.height), 2);
  // Centred right of the column: the view's centre half a column left of the post's
  return { x: post.x + post.width / 2 - ASSET_COLUMN / 2 / zoom, y: post.y + post.height / 2, zoom };
}

/** The view that fits the whole board (every section) in what the panels leave, at most 1. */
export function boardView(ed: EditorController): View | null {
  const posts = socialOf(ed).get().posts;
  if (!posts.length) return null;
  const left = Math.min(...posts.map((p) => p.x));
  const top = Math.min(...posts.map((p) => p.y)) - BOARD.sectionHead;
  const right = Math.max(...posts.map((p) => p.x + p.width));
  const bottom = Math.max(...posts.map((p) => p.y + p.height));
  const view = document.querySelector<HTMLElement>("[data-canvas-view]")?.getBoundingClientRect();
  const w = Math.max(200, (view?.width ?? 1200) - 120);
  const h = Math.max(200, (view?.height ?? 800) - 160);
  const zoom = Math.min(w / Math.max(1, right - left), h / Math.max(1, bottom - top), 1);
  return { x: (left + right) / 2, y: (top + bottom) / 2, zoom };
}

/** Whether a view (centre and zoom) showed the post: its middle inside the visible part. */
function shows(ed: EditorController, v: View, post: PostRow): boolean {
  const view = document.querySelector<HTMLElement>("[data-canvas-view]")?.getBoundingClientRect();
  const hw = (view?.width ?? 1200) / 2 / v.zoom;
  const hh = (view?.height ?? 800) / 2 / v.zoom;
  const cx = post.x + post.width / 2;
  const cy = post.y + post.height / 2;
  return Math.abs(cx - v.x) <= hw && Math.abs(cy - v.y) <= hh;
}

/**
 * Drives the camera of a Social file's asset view: into its post (from the board: the board's view kept), from post to
 * post (a glide across), back to the kept view when the grid view returns. Unmounted (out of Social), the engine shows
 * every design again.
 */
export function useFocusCamera(ed: EditorController, focus: Guid | null): void {
  useEffect(
    () => () => {
      cameraState.get(ed)?.stop();
      cameraState.delete(ed);
      if (!ed.engine.destroyed) ed.engine.setFocus(null);
    },
    [ed],
  );
  useEffect(() => {
    if (!onBoard(ed)) return;
    if (focus && ed.ui.get().socialAsset !== focus) ed.ui.set({ socialAsset: focus });
    const state = cameraState.get(ed) ?? { focus: null as Guid | null, board: null as View | null, stop: () => {} };
    cameraState.set(ed, state);
    if (focus === state.focus) return;
    state.stop();
    // The single post shown, as Figma Buzz's asset view (docs/social.md §20): the engine draws and picks only it, and
    // layers dragged or drawn outside it stay in it — no drop into another post, no fall onto the canvas. Entering, the
    // board fades to the post once the camera is there; leaving, the board is back before the camera moves.
    const isolate = () => !ed.engine.destroyed && ed.engine.setFocus(focus);
    // Entering, the post alone at once: it grows from its place to the middle (§29), not the whole board zooming.
    isolate();
    if (focus) {
      const post = socialOf(ed).post(focus);
      if (!post) return;
      // The board's view to come back to — unless it didn't show the post (a post just made from the empty board):
      // then the whole board.
      if (!state.focus) {
        const now = ed.engine.viewCenter();
        state.board = shows(ed, now, post) ? now : null;
      }
      state.stop = glide(ed, viewOf(ed, post), 420);
    } else {
      const back = state.board ?? boardView(ed);
      if (back) state.stop = glide(ed, back);
      state.board = null;
    }
    state.focus = focus;
  }, [ed, focus]);
}

const cameraState = new WeakMap<EditorController, { focus: Guid | null; board: View | null; stop: () => void }>();
