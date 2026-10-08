/**
 * Find and replace's engine side (help "Find and replace in Figma"): the layers of the current page or of every
 * page as Find reads them (one subtree read per page, in the Layers panel's order), opening the panel (⌘F, the
 * Pages header's Find), Find next / previous (⇧⌘F / ⇧⌘D, the live Edit menu) moving to a result — its page shown,
 * it selected and zoomed to — and Replace on text layers as one undo step. The matching is model/find.ts.
 */
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "./controller";
import type { FindState } from "./uiStore";
import { findLayers, remapStyleIds, replaceText, stepIndex, type FindNode, type FindResult } from "./model/find";

export const EMPTY_FIND: FindState = { query: "", scope: "page", types: [], matchCase: false, wholeWords: false, other: false, replace: false, replaceWith: "", at: -1 };

/** Opens Find in the left panel (the File tab), keeping the last query; `replace` opens the Replace row too. */
export function openFind(ed: EditorController, o: { replace?: boolean } = {}): void {
  ed.ui.set((s) => ({
    railTab: "file",
    uiHidden: false,
    uiMinimized: false,
    renaming: null,
    find: { ...(s.find ?? EMPTY_FIND), ...(o.replace ? { replace: true } : {}) },
  }));
  // The panel focuses its field when it mounts; an open one is focused again.
  queueMicrotask(() => document.querySelector<HTMLInputElement>("[data-find-query] input")?.focus());
}

export function closeFind(ed: EditorController): void {
  ed.ui.set({ find: null });
  ed.focusCanvas();
}

const FIELDS = ["name", "type", "parentIndex", "textData", "fillPaints", "resizeToFit", "isStateGroup", "visible"] as const;

const hasMedia = (fills: unknown) => Array.isArray(fills) && fills.some((p: { type?: string; visible?: boolean }) => p?.visible !== false && (p?.type === "IMAGE" || p?.type === "VIDEO"));

/** One page's layers as Find reads them, top layer first (the Layers panel's order), each with its top-level layer's name. */
export function readPageForFind(ed: EditorController, page: Guid): FindNode[] {
  const rows = ed.engine.readNodes([page], { subtree: true, fields: FIELDS as unknown as string[] });
  const byId = new Map<Guid, NodeChange>();
  const kids = new Map<Guid, Guid[]>();
  for (const r of rows) {
    byId.set(r.guid, r);
    const parent = r.parentIndex?.guid;
    if (!parent || r.guid === page) continue;
    let list = kids.get(parent);
    if (!list) kids.set(parent, (list = []));
    list.push(r.guid); // back to front, as the engine lists them
  }
  const out: FindNode[] = [];
  const walk = (id: Guid, top: string | undefined) => {
    const list = kids.get(id);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const n = byId.get(list[i]);
      if (!n) continue;
      const x = n as NodeChange & { isStateGroup?: boolean; textData?: { characters?: string } };
      const type = n.type ?? "NONE";
      out.push({
        id: n.guid,
        page,
        type,
        name: n.name ?? "",
        text: type === "TEXT" ? (x.textData?.characters ?? "") : undefined,
        group: type === "GROUP" || (type === "FRAME" && n.resizeToFit === true),
        stateGroup: x.isStateGroup === true,
        media: hasMedia(n.fillPaints),
        top,
      });
      walk(n.guid, top ?? n.name ?? "");
    }
  };
  walk(page, undefined);
  return out;
}

/** The results for the panel's state: the current page's, or every page's in page order. */
export function findResults(ed: EditorController, f: FindState): FindResult[] {
  if (!f.query) return [];
  const pages = f.scope === "all" ? ed.store.pages.map((p) => p.guid) : [ed.store.page];
  const nodes = pages.flatMap((p) => readPageForFind(ed, p));
  return findLayers(nodes, f.query, { matchCase: f.matchCase, wholeWords: f.wholeWords, other: f.other, types: f.types });
}

/** Shows a result: its page, it selected, the view on it. */
export function showResult(ed: EditorController, r: Pick<FindResult, "id" | "page">, zoom = true): void {
  if (r.page !== ed.store.page) ed.engine.setCurrentPage(r.page);
  ed.engine.setSelection([r.id]);
  if (zoom) ed.engine.command("ZOOM_TO_SELECTION");
}

/** ↑ / ↓ (Find previous / next): the result before or after the current one, shown. */
export function stepFind(ed: EditorController, dir: 1 | -1): void {
  const f = ed.ui.get().find;
  if (!f) return;
  const results = findResults(ed, f);
  const at = stepIndex(f.at, results.length, dir);
  ed.ui.set({ find: { ...f, at } });
  if (at >= 0) showResult(ed, results[at]);
}

/**
 * Replace (help: "Only text layers display as options to be replaced"): the query replaced in the characters of
 * `targets` (text results), as one undo step; how many layers changed.
 */
export function replaceInLayers(ed: EditorController, f: FindState, targets: readonly FindResult[]): number {
  const texts = targets.filter((r) => r.inText);
  if (!texts.length || !f.query) return 0;
  let changed = 0;
  ed.batch(texts.length > 1 ? "Replace all" : "Replace", () => {
    for (const r of texts) {
      const node = ed.engine.readNode(r.id, { fields: ["textData"] }) as (NodeChange & { textData?: { characters: string; characterStyleIDs?: number[] } & Record<string, unknown> }) | null;
      const td = node?.textData;
      if (!td) continue;
      const { text, edits } = replaceText(td.characters, f.query, f.replaceWith, { matchCase: f.matchCase, wholeWords: f.wholeWords });
      if (!edits.length) continue;
      const next: Record<string, unknown> = { ...td, characters: text };
      const ids = remapStyleIds(td.characterStyleIDs, edits);
      if (ids !== undefined) next.characterStyleIDs = ids;
      ed.engine.setProps([r.id], { textData: next } as never);
      changed++;
    }
  });
  return changed;
}
