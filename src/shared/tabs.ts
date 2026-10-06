/**
 * The window's tabs: Home, then the open files. A pure reducer, so main's
 * TabManager (src/main/tabs.ts) and the browser-only shell (app/Shell.tsx,
 * `npm run web`) run the same rules — and tests run it in Node.
 *
 * Today's kinds are the site admin's (a project's editor, its saved draft's
 * preview, the CV); docs/desktop.md §4.1 has the file/prototype kinds that
 * replace them with the new data layer.
 */

export const HOME = "home";

export type TabKind = "project" | "preview" | "cv";

/** What a tab's page says about itself (`tab:report`). */
export interface TabReport {
  title?: string;
  dirty?: boolean;
  status?: "loading" | "ready" | "missing" | "error";
  /** A save went through (ms): Home's lists are out of date */
  savedAt?: number;
}

/** Where a tab is: its page's own status, or main's ("discarded": no view yet — restored, never shown). */
export type TabStatus = NonNullable<TabReport["status"]> | "discarded" | "crashed" | "unresponsive";

export interface Tab {
  id: string;
  kind: TabKind;
  /** The project it shows ("cv" for the CV) */
  slug: string;
  title: string;
  dirty: boolean;
  status: TabStatus;
}

/** A tab as it is kept between launches. */
export type TabRecord = Pick<Tab, "id" | "kind" | "slug" | "title">;
export type ClosedTab = Pick<Tab, "kind" | "slug" | "title">;

export interface TabsState {
  tabs: Tab[];
  /** HOME, or a tab's id */
  active: string;
  /** Closed ones, the last first — ⇧⌘T opens them again */
  closed: ClosedTab[];
}

export type TabsAction =
  | { type: "open"; kind: TabKind; slug: string; title?: string; background?: boolean; id?: string }
  | { type: "activate"; id: string }
  | { type: "close"; ids: string[] }
  | { type: "report"; id: string; report: TabReport }
  | { type: "status"; id: string; status: TabStatus }
  | { type: "move"; id: string; to: number }
  | { type: "reopen"; id?: string }
  | { type: "reset" };

export const MAX_CLOSED = 20;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A 10-character base62 id. */
export const newTabId = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

export const emptyTabs = (): TabsState => ({ tabs: [], active: HOME, closed: [] });

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const there = state.tabs.find((t) => t.kind === action.kind && t.slug === action.slug);
      if (there) return action.background || there.id === state.active ? state : { ...state, active: there.id };
      const tab: Tab = { id: action.id ?? newTabId(), kind: action.kind, slug: action.slug, title: action.title || action.slug, dirty: false, status: "loading" };
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
      const closed = [...closing.reverse().map(({ kind, slug, title }) => ({ kind, slug, title })), ...state.closed].slice(0, MAX_CLOSED);
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
    case "status": {
      const at = state.tabs.findIndex((t) => t.id === action.id);
      if (at < 0 || state.tabs[at].status === action.status) return state;
      const tabs = [...state.tabs];
      tabs[at] = { ...tabs[at], status: action.status };
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
      return tabsReducer({ ...state, closed: rest }, { type: "open", kind: last.kind, slug: last.slug, title: last.title, id: action.id });
    }
    case "reset":
      return emptyTabs();
  }
}

// ── Kept between launches ─────────────────────────────────────────────────────

const KINDS: readonly TabKind[] = ["project", "preview", "cv"];
const isKind = (k: unknown): k is TabKind => KINDS.includes(k as TabKind);

/** What is kept of the tabs: no status, no unsaved flag (a launch starts with every tab not loaded yet). */
export function persistable(state: TabsState): { tabs: TabRecord[]; active: string; closed: ClosedTab[] } {
  return { tabs: state.tabs.map(({ id, kind, slug, title }) => ({ id, kind, slug, title })), active: state.active, closed: state.closed };
}

/** The tabs as kept — anything malformed dropped; every tab "discarded" (it loads when shown). */
export function restoreTabs(saved: unknown): TabsState {
  if (!saved || typeof saved !== "object") return emptyTabs();
  const s = saved as { tabs?: unknown; active?: unknown; closed?: unknown };
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of Array.isArray(s.tabs) ? (s.tabs as Partial<TabRecord>[]) : []) {
    if (!t || !isKind(t.kind) || typeof t.slug !== "string" || !t.slug) continue;
    // One tab per file, as the reducer keeps it.
    if (tabs.some((o) => o.kind === t.kind && o.slug === t.slug)) continue;
    const id = typeof t.id === "string" && /^[A-Za-z0-9]{1,32}$/.test(t.id) && !seen.has(t.id) && t.id !== HOME ? t.id : newTabId();
    seen.add(id);
    tabs.push({ id, kind: t.kind, slug: t.slug, title: typeof t.title === "string" && t.title ? t.title : t.slug, dirty: false, status: "discarded" });
  }
  const active = typeof s.active === "string" && tabs.some((t) => t.id === s.active) ? s.active : HOME;
  const closed: ClosedTab[] = (Array.isArray(s.closed) ? (s.closed as Partial<ClosedTab>[]) : [])
    .filter((c) => c && isKind(c.kind) && typeof c.slug === "string" && c.slug)
    .slice(0, MAX_CLOSED)
    .map((c) => ({ kind: c.kind as TabKind, slug: c.slug as string, title: typeof c.title === "string" && c.title ? c.title : (c.slug as string) }));
  return { tabs, active, closed };
}

/** The tab ⌘n shows: ⌘1 Home, ⌘2…⌘8 the tabs after it, ⌘9 the last. */
export function tabAtShortcut(state: TabsState, n: number): string | undefined {
  const order = [HOME, ...state.tabs.map((t) => t.id)];
  return n === 9 ? order[order.length - 1] : order[n - 1];
}

/** The tab beside the one in front (⌃Tab: +1, ⌃⇧Tab: -1), Home included, round. */
export function neighbourTab(state: TabsState, step: 1 | -1): string {
  const order = [HOME, ...state.tabs.map((t) => t.id)];
  const at = Math.max(0, order.indexOf(state.active));
  return order[(at + step + order.length) % order.length];
}
