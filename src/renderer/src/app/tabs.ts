import { emptyTabs, persistable, restoreTabs, type TabsState } from "@shared/tabs";

/**
 * The tabs' rules live in src/shared/tabs.ts (main's TabManager runs them in
 * the desktop app). This is the browser's side (`npm run web`, app/Shell.tsx):
 * the same reducer, kept in this browser's localStorage.
 */
export { HOME, tabsReducer, type Tab, type TabKind, type TabsState, type TabsAction } from "@shared/tabs";

const KEY = "designer-tabs";

export function restoredTabs(): TabsState {
  try {
    const state = restoreTabs(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    return { ...state, tabs: state.tabs.map((t) => ({ ...t, status: "loading" })) };
  } catch {
    return emptyTabs();
  }
}

export function keepTabs(state: TabsState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(persistable(state)));
  } catch {
    /* this launch only */
  }
}

export function forgetTabs() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}
