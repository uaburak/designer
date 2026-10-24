/**
 * A Social file's board keeps itself laid out (docs/social.md §19): every post at its place in its platform › format
 * grid (board.ts `boardLayout`), as auto layout reflows its children. Two ways in, both inside the step that changed
 * the board, so ⌘Z takes an edit and its reflow back together:
 * - a write of the chrome (`ed.batch`) or of an agent (its actor's write) arranges before it commits
 *   (`EditorController.beforeCommit`, `arrangeNow`);
 * - an edit made on the canvas (a drag among the posts, ⌘D, Delete, paste) is followed by an arrange folded into it
 *   (`Engine.txnBeginAmend`) — dragging a post among the others reorders it.
 * Only the current page's top-level posts move; a Design file is never arranged.
 */
import type { Guid } from "@/engine/codec";
import { formatById, PLATFORMS, SOCIAL_FORMATS } from "@shared/social/formats";
import type { EditorController } from "../controller";
import { onBoard } from "../devmode/devMode";
import { boardLayout, type BoardItem, type BoardLayout } from "./board";
import { readBoard, socialOf } from "./socialState";

const RANK = new Map(SOCIAL_FORMATS.map((f, i) => [f.id, i]));
const ORDER = {
  platformOf: (formatId: string) => formatById(formatId)?.platform ?? "other",
  rank: (formatId: string) => RANK.get(formatId) ?? Number.MAX_SAFE_INTEGER,
  platforms: PLATFORMS,
};

/** The current page's board as laid out (its posts' places, its sections and grids for the titles). */
export function layoutOf(ed: EditorController, page: Guid = ed.store.page): BoardLayout {
  const items: BoardItem[] = readBoard(ed, page).posts.map((p) => ({ id: p.id, formatId: p.data.formatId, width: p.width, height: p.height, x: p.x, y: p.y }));
  return boardLayout(items, ORDER);
}

/** Moves the current page's posts to their places, inside the write that is open; true when something moved. */
export function arrangeNow(ed: EditorController): boolean {
  if (!onBoard(ed) || ed.engine.destroyed) return false;
  const page = ed.store.page;
  const posts = readBoard(ed, page).posts;
  if (!posts.length) return false;
  const places = layoutOf(ed, page).places;
  let moved = false;
  for (const p of posts) {
    const at = places.get(p.id);
    if (!at || (Math.abs(at.x - p.x) < 0.5 && Math.abs(at.y - p.y) < 0.5)) continue;
    const t = ed.engine.readNode(p.id, { fields: ["transform"] })?.transform;
    if (!t) continue;
    ed.engine.setProps([p.id], { transform: { ...t, m02: at.x, m12: at.y } });
    moved = true;
  }
  return moved;
}

/** Each grid's posts in order and the cells the layout gives them (page coordinates), for the engine's board drag. */
export function boardGrids(ed: EditorController): { ids: Guid[]; cells: { x: number; y: number; width: number; height: number }[] }[] {
  const posts = new Map(readBoard(ed, ed.store.page).posts.map((p) => [p.id, p]));
  const layout = layoutOf(ed);
  return layout.sections.flatMap((s) =>
    s.grids.map((g) => ({
      ids: g.ids,
      cells: g.ids.map((id) => {
        const at = layout.places.get(id) ?? { x: 0, y: 0 };
        const p = posts.get(id);
        return { x: at.x, y: at.y, width: p?.width ?? g.column, height: p?.height ?? 0 };
      }),
    })),
  );
}

/** Whether the board is laid out now (nothing to move). */
export function arranged(ed: EditorController): boolean {
  const places = layoutOf(ed).places;
  return readBoard(ed, ed.store.page).posts.every((p) => {
    const at = places.get(p.id);
    return !at || (Math.abs(at.x - p.x) < 0.5 && Math.abs(at.y - p.y) < 0.5);
  });
}

/**
 * Keeps a Social file's board arranged (in Social; Design and Motion leave the posts where they are, §23): writes arrange before they commit; a canvas edit by the user is followed by an
 * arrange folded into its step; opening a page arranges it as a step of its own (when something is out of place).
 */
export function attachArranger(ed: EditorController): () => void {
  // Every editor: a file can become a Social file while open (Convert this file, docs/social.md §18.1).
  const offCommit = ed.beforeCommit(() => void arrangeNow(ed));
  let queued = false;
  const amend = () => {
    queued = false;
    if (ed.engine.destroyed || !onBoard(ed) || arranged(ed)) return;
    if (ed.engine.txnBeginAmend("Arrange posts") !== 0) return;
    try {
      arrangeNow(ed);
    } finally {
      ed.engine.txnCommit();
    }
  };
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(amend);
  };
  const offDoc = ed.engine.on("DOCUMENT_CHANGED", (e) => {
    // The user's own edits on the canvas (the chrome's and the agents' writes arranged before committing); undo, redo,
    // other sessions and loads put back what was.
    if (e.kind === "USER" && e.actor === undefined && e.label !== "Arrange posts" && onBoard(ed)) later();
  });
  const offPage = ed.store.subscribe("page", () => onBoard(ed) && later());
  // Back in Social from Design or Motion (docs/social.md §23), where the posts moved freely: the board again.
  let wasOn = onBoard(ed);
  const offMode = ed.ui.subscribe(() => {
    const on = onBoard(ed);
    if (on && !wasOn) later();
    wasOn = on;
  });
  later();
  // The engine's copy of the grids (docs/social.md §25): a post dragged in its grid moves through its cells.
  let sent = "";
  const syncBoard = () => {
    if (ed.engine.destroyed) return;
    const grids = onBoard(ed) ? boardGrids(ed) : [];
    const key = JSON.stringify(grids);
    if (key === sent) return;
    sent = key;
    ed.engine.setBoard(grids);
  };
  const offBoard = socialOf(ed).subscribe(syncBoard);
  const offBoardMode = ed.ui.subscribe(syncBoard);
  syncBoard();
  return () => {
    offCommit();
    offDoc();
    offPage();
    offMode();
    offBoard();
    offBoardMode();
  };
}
