/**
 * A shared file's links, Figma's way (R13 §2.7, live README "Share dialog, card 2"): "Copy link" names the selection's
 * top-level frame (or the page) as `node-id=1-2`; "Copy Dev Mode link" adds `m=dev`, "Copy prototype link" `m=proto`.
 * Opened, a link lands there: its page, the frame selected and in view, Dev Mode or the presentation.
 */
import type { Guid } from "@/engine/codec";
import { getStoreClient } from "@/store";
import { intentFromLink, type OpenIntent } from "@shared/multiplayer/types";
import type { EditorController } from "../controller";
import { commentsOf } from "../comments/commentsController";
import { setMode } from "../devmode/devMode";
import { setRound5 } from "../devmode/round5";
import { present, presentStart } from "../present";

/** The node a link names: the selection's top-level frame, else the current page. */
export function linkNode(ed: EditorController): Guid {
  return presentStart(ed) ?? ed.store.page;
}

/** The page a node is on (a page is its own), or null when it isn't in the document. */
function pageOf(ed: EditorController, node: Guid): Guid | null {
  const pages = new Set(ed.store.pages.map((p) => p.guid));
  let cur: Guid | undefined = node;
  for (let guard = 0; cur && guard < 256; guard++) {
    if (pages.has(cur)) return cur;
    cur = ed.engine.readNode(cur, { fields: ["parentIndex"] })?.parentIndex?.guid;
  }
  return null;
}

/** Lands where a link asked: the node's page, the node selected and zoomed to, then the mode. */
export function applyIntent(ed: EditorController, intent: OpenIntent): void {
  if (ed.engine.destroyed) return;
  const node = intent.nodeId;
  const page = node ? pageOf(ed, node) : null;
  if (node && page) {
    if (page !== ed.store.page) ed.engine.setCurrentPage(page);
    if (node !== page) {
      ed.engine.setSelection([node]);
      ed.engine.command("ZOOM_TO_SELECTION");
    }
  }
  if (intent.mode === "dev" || intent.devMode === "ready") setMode(ed, "dev");
  // A Dev Mode notification (docs/editor.md D-4): the Ready for dev view.
  if (intent.devMode === "ready") setRound5(ed, { ready: true });
  else if (intent.mode === "proto") present(ed, node && node !== page ? { node } : {});
  const thread = intent.commentId;
  const comments = thread ? commentsOf(ed) : null;
  if (thread && comments) {
    // A notification about a comment (docs/multiplayer.md §12): comment mode, the thread open on its page, in view.
    ed.engine.setTool("COMMENT");
    comments.start();
    void comments.reload().then(() => !ed.engine.destroyed && comments.openThread(thread, true));
  }
}

/**
 * The intent this editor was opened with: the browser's URL (`node-id`, `m`, `dev=ready`, `#comment-<id>` — what
 * files/desktop.ts `editorUrl` writes), else what the store kept for it.
 */
export async function openIntent(fileKey: string): Promise<OpenIntent | null> {
  if (typeof location !== "undefined") {
    const fromUrl = urlIntent(location.search, location.hash);
    if (fromUrl) return fromUrl;
  }
  return getStoreClient()
    .multiplayer.takeOpenIntent(fileKey)
    .catch(() => null);
}

/** The intent in an editor page's address (`?editor&file=…&node-id=1-2&m=dev&dev=ready#comment-…`), or null. */
export function urlIntent(search: string, hash = ""): OpenIntent | null {
  const intent = intentFromLink(`${search}${hash}`);
  return Object.keys(intent).length ? intent : null;
}
