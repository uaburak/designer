/**
 * A Social file's posts check themselves (docs/social.md §30, the owner 2026-10-25: "no model needed for these"): a
 * moment after an edit, each post it touched is checked (`checkPost`: safe area, caption, logo, contrast, video) and its
 * pins follow — a finding no longer found leaves. The findings are written as the board's bookkeeping (`applyChanges`
 * "system": saved with the file, never an undo step of their own), so ⌘Z takes back the edit, not its check; the check
 * after the undo puts the pins right again. Only in Social (onBoard), only where the person can edit.
 */
import type { Guid } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { guidString } from "@/engine/guids";
import { withSocial, type PluginDataEntry, type PostProblem } from "@shared/social/types";
import type { EditorController } from "../controller";
import { onBoard } from "../devmode/devMode";
import { canWritePosts, checkPost } from "./actions";
import { readPost } from "./posts";
import { readBoard } from "./socialState";

/** How long after the last edit the touched posts are checked (ms) */
const QUIET_MS = 500;

/** A check's findings onto a post as bookkeeping (not an undo step); false while a step or gesture is open (try again later). */
function writeFindings(ed: EditorController, id: Guid, found: readonly PostProblem[]): boolean {
  const data = readPost(ed, id);
  if (!data) return true;
  const next = [...data.problems.filter((p) => p.source !== "check"), ...found];
  if (JSON.stringify(next) === JSON.stringify(data.problems)) return true;
  const n = ed.engine.readNode(id, { fields: ["pluginData"] }) as { pluginData?: PluginDataEntry[] } | null;
  if (!n) return true;
  const pluginData = withSocial(n.pluginData, "post", { ...data, problems: next });
  return ed.engine.applyChanges({ type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [{ guid: id, pluginData } as never] }, "system") !== Status.E_BUSY;
}

export function attachAutoCheck(ed: EditorController): () => void {
  const touched = new Set<Guid>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, QUIET_MS);
  };
  const run = () => {
    timer = null;
    if (ed.engine.destroyed) return;
    if (!onBoard(ed) || !canWritePosts(ed)) return void touched.clear();
    const posts = new Set(readBoard(ed, ed.store.page).posts.map((p) => p.id));
    // Each touched layer's post: the top-level post it is in
    const hit = new Set<Guid>();
    for (const id of touched) {
      let g: Guid | undefined = id;
      for (let depth = 0; g && depth < 64; depth++) {
        if (posts.has(g)) {
          hit.add(g);
          break;
        }
        g = ed.engine.readNode(g, { fields: ["parentIndex"] })?.parentIndex?.guid;
      }
    }
    touched.clear();
    for (const post of hit) {
      if (writeFindings(ed, post, checkPost(ed, post))) continue;
      // A step is open (a drag, an agent's write): again once it is done
      touched.add(post);
    }
    if (touched.size) later();
  };
  const off = ed.engine.on("DOCUMENT_CHANGED", (e) => {
    // Our own bookkeeping (and the libraries') isn't an edit to check
    if (e.kind === "SYSTEM" || !onBoard(ed)) return;
    // (The stream's guids are the codec's — strings or {sessionID, localID})
    for (const c of e.message.nodeChanges ?? []) {
      const g = guidString(c.guid);
      if (g) touched.add(g);
    }
    if (touched.size) later();
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}
