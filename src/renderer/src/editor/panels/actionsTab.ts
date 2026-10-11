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
