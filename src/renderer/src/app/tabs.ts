import type { TabReport } from "./bridge";

/**
 * The window's tabs: Home, then the files open — each a page of its own in
 * a frame (see Shell). Which are open, in what order, and which one is in
 * front are kept on this computer, so the next launch opens them again.
 */

export const HOME = "home";

export type TabKind = "project" | "preview" | "cv";

export interface Tab {
  id: string;
  kind: TabKind;
  /** The project it shows ("cv" for the CV) */
  slug: string;
  title: string;
  dirty: boolean;
  status: NonNullable<TabReport["status"]>;
}

export interface TabsState {
  tabs: Tab[];
  /** HOME, or a tab's id */
  active: string;
  /** Closed ones, the last first — ⇧⌘T opens them again */
  closed: Pick<Tab, "kind" | "slug" | "title">[];
}

export type TabsAction =
  | { type: "open"; kind: TabKind; slug: string; title?: string; background?: boolean }
  | { type: "activate"; id: string }
  | { type: "close"; ids: string[] }
  | { type: "report"; id: string; report: TabReport }
  | { type: "move"; id: string; to: number }
  | { type: "reopen" }
  | { type: "reset" };

const newId = () => Math.random().toString(36).slice(2, 10);

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const there = state.tabs.find((t) => t.kind === action.kind && t.slug === action.slug);
      if (there) return action.background ? state : { ...state, active: there.id };
      const tab: Tab = { id: newId(), kind: action.kind, slug: action.slug, title: action.title || action.slug, dirty: false, status: "loading" };
      // A file opens next to the one in front (at the end from Home), as a browser's tabs do.
      const at = state.active === HOME ? state.tabs.length : state.tabs.findIndex((t) => t.id === state.active) + 1;
      const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
      return { ...state, tabs, active: action.background ? state.active : tab.id };
    }
    case "activate":
      return action.id === state.active || (action.id !== HOME && !state.tabs.some((t) => t.id === action.id)) ? state : { ...state, active: action.id };
    case "close": {
      const closing = state.tabs.filter((t) => action.ids.includes(t.id));
      if (!closing.length) return state;
      const tabs = state.tabs.filter((t) => !action.ids.includes(t.id));
      let active = state.active;
      if (action.ids.includes(state.active)) {
        // The one in front closed: the tab after it comes forward (before it at the end), Home when none is left.
        const at = state.tabs.findIndex((t) => t.id === state.active);
        const next = state.tabs.slice(at + 1).find((t) => !action.ids.includes(t.id)) ?? [...state.tabs.slice(0, at)].reverse().find((t) => !action.ids.includes(t.id));
        active = next?.id ?? HOME;
      }
      const closed = [...closing.reverse().map(({ kind, slug, title }) => ({ kind, slug, title })), ...state.closed].slice(0, 20);
      return { tabs, active, closed };
    }
    case "report": {
      const at = state.tabs.findIndex((t) => t.id === action.id);
      if (at < 0) return state;
      const tab = state.tabs[at];
      const { title = tab.title, dirty = tab.dirty, status = tab.status } = action.report;
      if (title === tab.title && dirty === tab.dirty && status === tab.status) return state;
      const tabs = [...state.tabs];
      tabs[at] = { ...tab, title, dirty, status };
      return { ...state, tabs };
    }
    case "move": {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      const to = Math.max(0, Math.min(state.tabs.length - 1, action.to));
      if (from < 0 || from === to) return state;
      const tabs = [...state.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return { ...state, tabs };
    }
    case "reopen": {
      const [last, ...rest] = state.closed;
      if (!last) return state;
      return tabsReducer({ ...state, closed: rest }, { type: "open", kind: last.kind, slug: last.slug, title: last.title });
    }
    case "reset":
      return { tabs: [], active: HOME, closed: [] };
  }
}

// ── Kept between launches ─────────────────────────────────────────────────────

const KEY = "designer-tabs";

export function restoredTabs(): TabsState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { tabs?: Pick<Tab, "id" | "kind" | "slug" | "title">[]; active?: string } | null;
    const tabs: Tab[] = (saved?.tabs ?? [])
      .filter((t) => (t.kind === "project" || t.kind === "preview" || t.kind === "cv") && typeof t.slug === "string" && t.slug)
      .map((t) => ({ id: typeof t.id === "string" && t.id ? t.id : newId(), kind: t.kind, slug: t.slug, title: typeof t.title === "string" ? t.title : t.slug, dirty: false, status: "loading" }));
    const active = saved?.active && tabs.some((t) => t.id === saved.active) ? saved.active : HOME;
    return { tabs, active, closed: [] };
  } catch {
    return { tabs: [], active: HOME, closed: [] };
  }
}

export function keepTabs(state: TabsState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: state.tabs.map(({ id, kind, slug, title }) => ({ id, kind, slug, title })), active: state.active }));
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
