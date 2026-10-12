/** Opening Actions (⌘K) on a tab: "Manage plugins…" opens it on "Plugins & widgets" (docs/plugins.md §6). */
import type { EditorController } from "../controller";

export type ActionsTab = "all" | "assets" | "plugins";

let requested: ActionsTab | null = null;

export function openActions(ed: EditorController, tab: ActionsTab): void {
  requested = tab;
  ed.ui.set({ actionsOpen: true, uiHidden: false });
}

/** The tab asked for since the palette last opened (once). */
export function takeRequestedTab(): ActionsTab | null {
  const t = requested;
  requested = null;
  return t;
}

/**
 * What the "All" tab shows when it has no rows: "No results for …" for a search, "Recents" before one — and nothing
 * while a plugin asks for a parameter (the prompt's header names it with its error or loading message; a freeform
 * parameter without suggestions isn't "no results").
 */
export function allTabEmptyNote(query: string, rows: number, prompting: boolean): { kind: "none" } | { kind: "no-results"; query: string } | { kind: "recents" } {
  if (prompting || rows > 0) return { kind: "none" };
  const q = query.trim();
  return q ? { kind: "no-results", query: q } : { kind: "recents" };
}
