/**
 * The window's tabs: Home, then the open files (docs/desktop.md §4.1). A
 * pure reducer, so main's TabManager (src/main/tabs.ts) runs the rules and
 * tests run them in Node.
 *
 * A tab shows a workspace file (`fileKey`), saved continuously by its
 * editor: no unsaved dot, no Save. (Prototype tabs come with Present.)
 */

export const HOME = "home";

export type TabKind = "file";

/** What a tab's page says about itself (`tab:report`). */
export interface TabReport {
  title?: string;
  status?: "loading" | "ready" | "error";
  error?: string;
}

/** Where a tab is: its page's own status, or main's ("discarded": no view yet — restored, never shown). */
export type TabStatus = NonNullable<TabReport["status"]> | "discarded" | "crashed" | "unresponsive";

export interface Tab {
  id: string;
  kind: TabKind;
  /** The workspace file it shows */
  fileKey: string;
  title: string;
  status: TabStatus;
}

/** A tab as it is kept between launches. */
export type TabRecord = Pick<Tab, "id" | "kind" | "fileKey" | "title">;
export type ClosedTab = Pick<Tab, "kind" | "fileKey" | "title">;

export interface TabsState {
  tabs: Tab[];
  /** HOME, or a tab's id */
  active: string;
  /** Closed ones, the last first — ⇧⌘T opens them again */
  closed: ClosedTab[];
}

export type TabsAction =
  | { type: "open"; fileKey: string; title?: string; background?: boolean; id?: string }
  | { type: "activate"; id: string }
  | { type: "close"; ids: string[] }
  | { type: "report"; id: string; report: TabReport }
  | { type: "status"; id: string; status: TabStatus }
  | { type: "move"; id: string; to: number }
  | { type: "reopen"; id?: string }
  /** A file renamed (the store's `file.renamed`): its tabs and closed entries take the name */
  | { type: "retitle-file"; fileKey: string; title: string }
  /** A file trashed or deleted: its tabs close without going into the closed history, and it leaves that history */
  | { type: "drop-file"; fileKey: string };

export const MAX_CLOSED = 20;
export const UNTITLED = "Untitled";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A 10-character base62 id. */
export const newTabId = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

/** A workspace file's key as the store makes them (base62); anything else is refused. */
export const isFileKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(k);

export const emptyTabs = (): TabsState => ({ tabs: [], active: HOME, closed: [] });

const closedOf = ({ kind, fileKey, title }: Tab): ClosedTab => ({ kind, fileKey, title });

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      if (!action.fileKey) return state;
      const there = state.tabs.find((t) => t.fileKey === action.fileKey);
      if (there) return action.background || there.id === state.active ? state : { ...state, active: there.id };
      const tab: Tab = { id: action.id ?? newTabId(), kind: "file", fileKey: action.fileKey, title: action.title || UNTITLED, status: "loading" };
      // A file opens next to the one in front (at the end from Home), as a browser's tabs do.
      const at = state.active === HOME ? state.tabs.length : state.tabs.findIndex((t) => t.id === state.active) + 1;
      const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
      // Opened again: it isn't "closed" any more.
      const closed = state.closed.filter((c) => c.fileKey !== action.fileKey);
      return { ...state, tabs, closed, active: action.background ? state.active : tab.id };
    }
    case "activate":
      return action.id === state.active || (action.id !== HOME && !state.tabs.some((t) => t.id === action.id)) ? state : { ...state, active: action.id };
    case "close": {
      const closing = state.tabs.filter((t) => action.ids.includes(t.id));
      if (!closing.length) return state;
      const tabs = state.tabs.filter((t) => !action.ids.includes(t.id));
      const active = action.ids.includes(state.active) ? nextActive(state, action.ids) : state.active;
      const added = closing.reverse().map(closedOf);
      const keys = new Set(added.map((c) => c.fileKey));
      const closed = [...added, ...state.closed.filter((c) => !keys.has(c.fileKey))].slice(0, MAX_CLOSED);
      return { tabs, active, closed };
    }
    case "report": {
      const at = state.tabs.findIndex((t) => t.id === action.id);
      if (at < 0) return state;
      const tab = state.tabs[at];
      const { title = tab.title, status = tab.status } = action.report;
      if (title === tab.title && status === tab.status) return state;
      const tabs = [...state.tabs];
      tabs[at] = { ...tab, title, status };
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
      return tabsReducer({ ...state, closed: rest }, { type: "open", fileKey: last.fileKey, title: last.title, id: action.id });
    }
    case "retitle-file": {
      const title = action.title || UNTITLED;
      const mine = (t: { fileKey: string; title: string }) => t.fileKey === action.fileKey;
      if (!state.tabs.some((t) => mine(t) && t.title !== title) && !state.closed.some((c) => mine(c) && c.title !== title)) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) => (mine(t) ? { ...t, title } : t)),
        closed: state.closed.map((c) => (mine(c) ? { ...c, title } : c)),
      };
    }
    case "drop-file": {
      const ids = state.tabs.filter((t) => t.fileKey === action.fileKey).map((t) => t.id);
      const closed = state.closed.filter((c) => c.fileKey !== action.fileKey);
      if (!ids.length && closed.length === state.closed.length) return state;
      const tabs = state.tabs.filter((t) => !ids.includes(t.id));
      const active = ids.includes(state.active) ? nextActive(state, ids) : state.active;
      return { tabs, active, closed };
    }
  }
}

/** The one in front closed: the tab after it comes forward (before it at the end), Home when none is left. */
function nextActive(state: TabsState, ids: string[]): string {
  const at = state.tabs.findIndex((t) => t.id === state.active);
  const next = state.tabs.slice(at + 1).find((t) => !ids.includes(t.id)) ?? [...state.tabs.slice(0, at)].reverse().find((t) => !ids.includes(t.id));
  return next?.id ?? HOME;
}

// ── Kept between launches ─────────────────────────────────────────────────────

/** A kept tab or closed entry that still names a file. */
const wellFormed = <T extends { kind?: unknown; fileKey?: unknown }>(t: T | null | undefined): t is T & { kind: TabKind; fileKey: string } => !!t && t.kind === "file" && isFileKey(t.fileKey);

const titleOf = (t: { title?: unknown }) => (typeof t.title === "string" && t.title ? t.title : UNTITLED);

/** What is kept of the tabs: no status (a launch starts with every tab not loaded yet). */
export function persistable(state: TabsState): { tabs: TabRecord[]; active: string; closed: ClosedTab[] } {
  return { tabs: state.tabs.map(({ id, kind, fileKey, title }) => ({ id, kind, fileKey, title })), active: state.active, closed: state.closed };
}

/** The tabs as kept — anything malformed (or a legacy tab of the old site admin) dropped; every tab "discarded" (it loads when shown). */
export function restoreTabs(saved: unknown): TabsState {
  if (!saved || typeof saved !== "object") return emptyTabs();
  const s = saved as { tabs?: unknown; active?: unknown; closed?: unknown };
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of Array.isArray(s.tabs) ? (s.tabs as Partial<TabRecord>[]) : []) {
    if (!wellFormed(t)) continue;
    // One tab per file, as the reducer keeps it.
    if (tabs.some((o) => o.fileKey === t.fileKey)) continue;
    const id = typeof t.id === "string" && /^[A-Za-z0-9]{1,32}$/.test(t.id) && !seen.has(t.id) && t.id !== HOME ? t.id : newTabId();
    seen.add(id);
    tabs.push({ id, kind: "file", fileKey: t.fileKey, title: titleOf(t), status: "discarded" });
  }
  const active = typeof s.active === "string" && tabs.some((t) => t.id === s.active) ? s.active : HOME;
  const closed: ClosedTab[] = (Array.isArray(s.closed) ? (s.closed as Partial<ClosedTab>[]) : [])
    .filter(wellFormed)
    .slice(0, MAX_CLOSED)
    .map((c) => ({ kind: "file", fileKey: c.fileKey, title: titleOf(c) }));
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
