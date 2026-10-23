/**
 * Each page opens where it was left (Figma: every page keeps its own viewport). The editor remembers the camera of
 * every page shown since the file was opened in this tab; showing a page again puts its camera back. A page shown for
 * the first time in the session is zoomed to fit its content (View › Zoom to fit), an empty one shows its origin at
 * the visible part's top left at 100 %.
 *
 * One rule for every way a page becomes current — the Pages list, ⌘↑ / ⌘↓ (Previous / Next page), Go to page, Find,
 * comments, links, agents and plugins — because it runs on the engine's CURRENT_PAGE_CHANGED. A caller that places
 * the camera itself right after switching (Find's zoom to the match, a comment's pin, following a collaborator) still
 * wins: it moves the camera after this rule, or — when the switch happened inside an engine event — before it, and a
 * camera already moved for the new page is kept.
 *
 * The cameras live in memory for the tab's life; the store keeps each page's last camera too (persistence.ts,
 * ui.json), which puts the file's last page back where it was on the next open.
 */
import type { Camera } from "@/engine/codec";
import type { EditorController } from "./controller";
import { insetsOf, viewRect } from "./canvas/viewInsets";

const same = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** Puts a page shown for the first time at its fitted view (empty: its origin at the visible top left, 100 %). */
export function showPageFirstTime(ed: EditorController): void {
  const canvas = ed.canvas;
  const view = viewRect(canvas);
  const inset = canvas && view ? insetsOf(canvas.getBoundingClientRect(), view) : { left: 0, top: 0 };
  ed.engine.setCamera({ x: inset.left, y: inset.top, zoom: 1 });
  ed.engine.command("ZOOM_TO_FIT");
}

/** Remembers each page's camera and restores it when the page is shown again (see above). Call after the first view. */
export function attachPageCameras(ed: EditorController): () => void {
  const cameras = new Map<string, Camera>();
  let page = ed.store.page;
  let last: Camera = { ...ed.engine.getCamera() };
  cameras.set(page, last);

  const offCamera = ed.store.subscribe("camera", () => {
    if (ed.engine.destroyed) return;
    last = { ...ed.store.camera };
    cameras.set(ed.store.page, last);
  });
  const offPage = ed.store.subscribe("page", () => {
    if (ed.engine.destroyed || ed.store.page === page) return;
    page = ed.store.page;
    const now = ed.engine.getCamera();
    // Moved already for the new page (the switch came inside an engine event and its caller placed the camera).
    if (!same(now, last)) return;
    const kept = cameras.get(page);
    if (kept) ed.engine.setCamera(kept);
    else showPageFirstTime(ed);
    // The page counts as shown even if the camera did not move (an empty page already at its origin).
    cameras.set(page, (last = { ...ed.engine.getCamera() }));
  });
  return () => {
    offCamera();
    offPage();
  };
}
