/**
 * A Social file's focus view (docs/social.md §19): when the selection is one post or lies inside one, that post is in
 * focus — the camera glides from the board to it (centred in what the panels leave, 320 ms, ease-out; a jump with
 * Reduce motion on), the other posts dim, the right panel is the post's Design panel. When the selection empties (a
 * click on the board's blank, Esc up to nothing) the camera glides back to where the board was. Two posts or more
 * selected: no focus (the bulk panel). Only the camera moves: nothing is written, no undo step.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Guid } from "@/engine/codec";
import { glideMs } from "@/ds";
import type { EditorController } from "../controller";
import { isSocialFile } from "../devmode/devMode";
import { BOARD } from "./board";
import { socialOf, type PostRow } from "./socialState";

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

/** The selection's focused post id, re-rendering when it changes (none while picking posts with ⇧ / ⌘). */
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
    () => (isSocialFile(ed) && !ed.ui.get().socialPicking ? (focusedPost(ed)?.id ?? null) : null),
  );
}

/**
 * Picking several posts on the board: a click with ⇧ or ⌘ (Ctrl) selects without opening the focus view (the camera
 * stays, so the next ⇧-click lands on the post under it); a plain click opens again. Returns its removal.
 */
export function attachPicking(ed: EditorController, area: HTMLElement): () => void {
  const down = (e: PointerEvent) => {
    if (!isSocialFile(ed) || e.button !== 0) return;
    ed.ui.set({ socialPicking: e.shiftKey || e.metaKey || e.ctrlKey });
  };
  area.addEventListener("pointerdown", down, true);
  return () => area.removeEventListener("pointerdown", down, true);
}

type View = { x: number; y: number; zoom: number };

const ease = (t: number) => 1 - Math.pow(1 - t, 4);

/** The camera from where it is to `to` (the visible part's centre and zoom) over `ms`; returns the stop. */
export function glide(ed: EditorController, to: View, ms = 320): () => void {
  const from = ed.engine.viewCenter();
  const time = glideMs(ms);
  if (time <= 0 || ed.engine.destroyed) {
    ed.engine.centerOn(to.x, to.y, to.zoom);
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
  };
  frame = requestAnimationFrame(step);
  // A page the browser throttles (hidden, in the background) gets no frames: the camera lands where it goes anyway.
  const land = setTimeout(() => {
    cancelAnimationFrame(frame);
    if (!ed.engine.destroyed) ed.engine.centerOn(to.x, to.y, to.zoom);
  }, time + 60);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(land);
  };
}

/** The view that fits a post in what the panels leave (with a margin for the focus bar and the strip). */
export function viewOf(ed: EditorController, post: PostRow): View {
  const view = document.querySelector<HTMLElement>("[data-canvas-view]")?.getBoundingClientRect();
  const w = Math.max(200, (view?.width ?? 1200) - 160);
  const h = Math.max(200, (view?.height ?? 800) - 260);
  const zoom = Math.min(w / Math.max(1, post.width), h / Math.max(1, post.height), 2);
  return { x: post.x + post.width / 2, y: post.y + post.height / 2, zoom };
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
 * Drives the camera of a Social file's focus view: into a post when the selection focuses one (from the board: the
 * board's view kept), from post to post (a glide across), back to the kept view when the focus ends.
 */
export function useFocusCamera(ed: EditorController, focus: Guid | null): void {
  useEffect(() => {
    if (!isSocialFile(ed)) return;
    const state = cameraState.get(ed) ?? { focus: null as Guid | null, board: null as View | null, stop: () => {} };
    cameraState.set(ed, state);
    if (focus === state.focus) return;
    state.stop();
    if (focus) {
      const post = socialOf(ed).post(focus);
      if (!post) return;
      // The board's view to come back to — unless it didn't show the post (a post just made from the empty board):
      // then the whole board.
      if (!state.focus) {
        const now = ed.engine.viewCenter();
        state.board = shows(ed, now, post) ? now : null;
      }
      state.stop = glide(ed, viewOf(ed, post));
    } else {
      const back = state.board ?? boardView(ed);
      if (back) state.stop = glide(ed, back);
      state.board = null;
    }
    state.focus = focus;
  }, [ed, focus]);
}

const cameraState = new WeakMap<EditorController, { focus: Guid | null; board: View | null; stop: () => void }>();
