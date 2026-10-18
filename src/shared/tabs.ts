/**
 * The window's tabs: Home, then the open files (docs/desktop.md §4.1). A
 * pure reducer, so main's TabManager (src/main/tabs.ts) runs the rules and
 * tests run them in Node.
 *
 * A tab shows a workspace file (`fileKey`), saved continuously by its
 * editor: no unsaved dot, no Save — or, `kind: "prototype"`, a file's
 * presentation view (Present: R8 §9), one per (file, starting frame) — or,
 * `kind: "new-tab"`, Figma's desktop new-tab page (⌘T, "+"; atlas 01 §3), as
 * many as are opened, never in the closed history.
 *
 * Figma's tab rules (atlas 01 §2.3–2.7): pinned tabs come first, are never
 * discarded and never join a group; a group's tabs stay together and a group
 * with no tab left goes; 100 closed tabs are kept (the menu shows 8).
 */

export const HOME = "home";

export type TabKind = "file" | "prototype" | "new-tab";

/** What a tab's page says about itself (`tab:report`). */
export interface TabReport {
  title?: string;
  status?: "loading" | "ready" | "error";
  error?: string;
}

/** Where a tab is: its page's own status, or main's ("discarded": no view — restored and never shown, or offloaded). */
export type TabStatus = NonNullable<TabReport["status"]> | "discarded" | "crashed" | "unresponsive";

/** Figma's tab group colours, in its menu's order (atlas 01 §2.3). */
export const GROUP_COLORS = ["blue", "red", "yellow", "green", "purple", "pink", "persimmon", "grey"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** A tab group: "Group {number}" until it is named. */
export interface TabGroup {
  id: string;
  /** Its default name's number */
  number: number;
  /** "" until Edit group name */
  name: string;
  color: GroupColor;
}

export interface Tab {
  id: string;
  kind: TabKind;
  /** The workspace file it shows ("" on the new-tab page) */
  fileKey: string;
  title: string;
  status: TabStatus;
  /** A prototype tab: the page presented and the frame it starts at (none: the page's first flow) */
  pageId?: string;
  startNodeId?: string;
  /** Pinned: first in the bar, never discarded, never in a group */
  pinned?: boolean;
  /** The group it is in */
  groupId?: string;
  /** When it was last in front (or opened), ms — what the discard sweep and the launch's live tabs go by */
  viewedAt?: number;
}

/** A tab as it is kept between launches. */
export type TabRecord = Pick<Tab, "id" | "kind" | "fileKey" | "title" | "pageId" | "startNodeId" | "pinned" | "groupId" | "viewedAt">;
export type ClosedTab = Pick<Tab, "kind" | "fileKey" | "title" | "pageId" | "startNodeId">;

export interface TabsState {
  tabs: Tab[];
  /** HOME, or a tab's id */
  active: string;
  /** Closed ones, the last first — ⇧⌘T opens them again */
  closed: ClosedTab[];
  /** The tab groups, each with at least one tab */
  groups?: TabGroup[];
}

export type TabsAction =
  /** `replace`: the new-tab page a file was picked on — the file takes its place; `at`: now (the tab's `viewedAt`) */
  | { type: "open"; fileKey: string; title?: string; background?: boolean; id?: string; kind?: TabKind; pageId?: string; startNodeId?: string; replace?: string; at?: number }
  | { type: "activate"; id: string; at?: number }
  | { type: "close"; ids: string[] }
  | { type: "report"; id: string; report: TabReport }
  | { type: "status"; id: string; status: TabStatus }
  | { type: "move"; id: string; to: number }
  | { type: "reopen"; id?: string; at?: number }
  /** A file renamed (the store's `file.renamed`): its tabs and closed entries take the name */
  | { type: "retitle-file"; fileKey: string; title: string }
  /** A file trashed or deleted: its tabs close without going into the closed history, and it leaves that history */
  | { type: "drop-file"; fileKey: string }
  /** Another account (docs/desktop.md §18.7): every file tab closed and the closed history emptied — Home in front */
  | { type: "reset" }
  /** Pin / Unpin: to the end of the pinned tabs, or the first of the others */
  | { type: "pin"; id: string; pinned: boolean }
  /** Add to Tab Group — a new group (Group {number}, the next colour) when `groupId` names none */
  | { type: "group-add"; ids: string[]; groupId: string }
  /** Remove from Tab Group: just after the group */
  | { type: "group-remove"; ids: string[] }
  /** Edit group name, Group color */
  | { type: "group-set"; groupId: string; name?: string; color?: GroupColor }
  /** Ungroup: the tabs stay, the group goes */
  | { type: "ungroup"; groupId: string };

/** Closed tabs kept (Figma's `MAX_RECENTLY_CLOSED_TABS_RETAINED`); File › Recently Closed Tabs shows the last `MENU_CLOSED`. */
export const MAX_CLOSED = 100;
export const MENU_CLOSED = 8;
export const UNTITLED = "Untitled";
/** The new-tab page's title (Figma's tab says "New tab" until a file is picked) */
export const NEW_TAB = "New tab";
/** A group name's longest — ours: Figma's input sets none we found, this keeps the bar sane */
export const MAX_GROUP_NAME = 64;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A 10-character base62 id. */
export const newTabId = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

/** A workspace file's key as the store makes them (base62); anything else is refused. */
export const isFileKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(k);

export const emptyTabs = (): TabsState => ({ tabs: [], active: HOME, closed: [] });

export const groupsOf = (state: TabsState): TabGroup[] => state.groups ?? [];

const closedOf = ({ kind, fileKey, title, pageId, startNodeId }: Tab): ClosedTab =>
  kind === "prototype" ? { kind, fileKey, title, ...(pageId ? { pageId } : {}), ...(startNodeId ? { startNodeId } : {}) } : { kind, fileKey, title };

/** Tabs (and closed entries) that are the same: one file tab per file, one prototype tab per (file, starting frame); new-tab pages never. */
const sameTab = (a: { kind: TabKind; fileKey: string; startNodeId?: string }, b: { kind?: TabKind; fileKey: string; startNodeId?: string }) =>
  a.kind !== "new-tab" && a.kind === (b.kind ?? "file") && a.fileKey === b.fileKey && (a.kind === "file" || (a.startNodeId ?? "") === (b.startNodeId ?? ""));

/** The tab's `viewedAt`, when `at` is given. */
const viewed = (tabs: Tab[], id: string, at?: number) => (at ? tabs.map((t) => (t.id === id ? { ...t, viewedAt: at } : t)) : tabs);

const withoutGroup = ({ groupId: _gone, ...tab }: Tab): Tab => tab;

/**
 * Figma's order: the pinned tabs first, then the others with each group's tabs together where its first one is; a
 * pinned tab is in no group and a group with no tab left goes. The same state when nothing changes.
 */
export function arrange(state: TabsState): TabsState {
  const known = new Set(groupsOf(state).map((g) => g.id));
  const tabs = state.tabs.map((t) => (t.groupId && (t.pinned || !known.has(t.groupId)) ? withoutGroup(t) : t));
  const ordered = tabs.filter((t) => t.pinned);
  const placed = new Set<string>();
  for (const t of tabs) {
    if (t.pinned || placed.has(t.id)) continue;
    const members = t.groupId ? tabs.filter((o) => !o.pinned && o.groupId === t.groupId) : [t];
    for (const m of members) placed.add(m.id);
    ordered.push(...members);
  }
  const groups = groupsOf(state).filter((g) => ordered.some((t) => t.groupId === g.id));
  const sameTabs = ordered.length === state.tabs.length && ordered.every((t, i) => t === state.tabs[i]);
  if (sameTabs && groups.length === groupsOf(state).length) return state;
  const next: TabsState = { ...state, tabs: sameTabs ? state.tabs : ordered };
  if (groups.length) next.groups = groups;
  else delete next.groups;
  return next;
}

/** A new group: the lowest number not in use, its colour Figma's next in order. */
function newGroup(state: TabsState, id: string): TabGroup {
  const groups = groupsOf(state);
  let number = 1;
  while (groups.some((g) => g.number === number)) number++;
  return { id, number, name: "", color: GROUP_COLORS[(number - 1) % GROUP_COLORS.length] };
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      const kind = action.kind ?? "file";
      if (!action.fileKey && kind !== "new-tab") return state;
      const like = { kind, fileKey: action.fileKey, startNodeId: action.startNodeId };
      const replacing = action.replace ? state.tabs.find((t) => t.id === action.replace && t.kind === "new-tab") : undefined;
      const there = state.tabs.find((t) => sameTab(t, like));
      if (there) {
        // Picked on a new-tab page while it is open elsewhere: the page closes, its tab comes forward.
        if (replacing) return tabsReducer(tabsReducer(state, { type: "close", ids: [replacing.id] }), { type: "activate", id: there.id, at: action.at });
        if (action.background || there.id === state.active) return state;
        return { ...state, tabs: viewed(state.tabs, there.id, action.at), active: there.id };
      }
      const tab: Tab = { id: action.id ?? newTabId(), kind, fileKey: action.fileKey, title: action.title || (kind === "new-tab" ? NEW_TAB : UNTITLED), status: "loading" };
      if (kind === "prototype") {
        if (action.pageId) tab.pageId = action.pageId;
        if (action.startNodeId) tab.startNodeId = action.startNodeId;
      }
      if (action.at) tab.viewedAt = action.at;
      let tabs: Tab[];
      if (replacing) {
        // In the new-tab page's place (and group).
        if (replacing.groupId) tab.groupId = replacing.groupId;
        tabs = state.tabs.map((t) => (t.id === replacing.id ? tab : t));
      } else {
        // A file opens next to the one in front (at the end from Home), as a browser's tabs do — in its group.
        const front = state.tabs.find((t) => t.id === state.active);
        if (front?.groupId) tab.groupId = front.groupId;
        const at = front ? state.tabs.indexOf(front) + 1 : state.tabs.length;
        tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
      }
      // Opened again: it isn't "closed" any more.
      const closed = state.closed.filter((c) => !sameTab(c, like));
      const active = action.background && replacing?.id !== state.active ? state.active : tab.id;
      return arrange({ ...state, tabs, closed, active });
    }
    case "activate":
      if (action.id === state.active || (action.id !== HOME && !state.tabs.some((t) => t.id === action.id))) return state;
      return { ...state, tabs: viewed(state.tabs, action.id, action.at), active: action.id };
    case "close": {
      const closing = state.tabs.filter((t) => action.ids.includes(t.id));
      if (!closing.length) return state;
      const tabs = state.tabs.filter((t) => !action.ids.includes(t.id));
      const active = action.ids.includes(state.active) ? nextActive(state, action.ids) : state.active;
      const added = closing.reverse().filter((t) => t.kind !== "new-tab").map(closedOf);
      const closed = [...added, ...state.closed.filter((c) => !added.some((a) => sameTab(a, c)))].slice(0, MAX_CLOSED);
      return arrange({ ...state, tabs, active, closed });
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
      if (from < 0) return state;
      // Pinned tabs move among the pinned ones, the others after them.
      const pinned = state.tabs.filter((t) => t.pinned).length;
      const [lo, hi] = state.tabs[from].pinned ? [0, pinned - 1] : [pinned, state.tabs.length - 1];
      const to = Math.max(lo, Math.min(hi, action.to));
      if (from === to) return state;
      const tabs = [...state.tabs];
      let [tab] = tabs.splice(from, 1);
      if (!tab.pinned) {
        // Dropped between two tabs of a group: in it; dropped away from its own group: out of it.
        const before = tabs[to - 1], after = tabs[to];
        const inside = before?.groupId && before.groupId === after?.groupId ? before.groupId : undefined;
        if (inside) tab = { ...tab, groupId: inside };
        else if (tab.groupId && before?.groupId !== tab.groupId && after?.groupId !== tab.groupId) tab = withoutGroup(tab);
      }
      tabs.splice(to, 0, tab);
      return arrange({ ...state, tabs });
    }
    case "reopen": {
      const [last, ...rest] = state.closed;
      if (!last) return state;
      return tabsReducer({ ...state, closed: rest }, { type: "open", fileKey: last.fileKey, title: last.title, id: action.id, kind: last.kind, pageId: last.pageId, startNodeId: last.startNodeId, at: action.at });
    }
    case "retitle-file": {
      const title = action.title || UNTITLED;
      const mine = (t: { fileKey: string; title: string }) => Boolean(action.fileKey) && t.fileKey === action.fileKey;
      if (!state.tabs.some((t) => mine(t) && t.title !== title) && !state.closed.some((c) => mine(c) && c.title !== title)) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) => (mine(t) ? { ...t, title } : t)),
        closed: state.closed.map((c) => (mine(c) ? { ...c, title } : c)),
      };
    }
    case "drop-file": {
      if (!action.fileKey) return state;
      const ids = state.tabs.filter((t) => t.fileKey === action.fileKey).map((t) => t.id);
      const closed = state.closed.filter((c) => c.fileKey !== action.fileKey);
      if (!ids.length && closed.length === state.closed.length) return state;
      const tabs = state.tabs.filter((t) => !ids.includes(t.id));
      const active = ids.includes(state.active) ? nextActive(state, ids) : state.active;
      return arrange({ ...state, tabs, active, closed });
    }
    case "reset":
      return state.tabs.length || state.closed.length || state.active !== HOME ? emptyTabs() : state;
    case "pin": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || Boolean(tab.pinned) === action.pinned) return state;
      const others = state.tabs.filter((t) => t.id !== action.id);
      const { pinned: _was, ...plain } = withoutGroup(tab);
      // Pinned: after the pinned ones; unpinned: the first of the others.
      const at = others.filter((t) => t.pinned).length;
      return arrange({ ...state, tabs: [...others.slice(0, at), action.pinned ? { ...plain, pinned: true } : plain, ...others.slice(at)] });
    }
    case "group-add": {
      if (!action.groupId || action.groupId === HOME) return state;
      const ids = action.ids.filter((id) => state.tabs.some((t) => t.id === id && !t.pinned && t.groupId !== action.groupId));
      if (!ids.length) return state;
      const groups = groupsOf(state);
      const group = groups.find((g) => g.id === action.groupId) ?? newGroup(state, action.groupId);
      // They join at the group's end; a new group stands where the first of them was.
      const joining = state.tabs.filter((t) => ids.includes(t.id)).map((t) => ({ ...t, groupId: group.id }));
      const rest = state.tabs.filter((t) => !ids.includes(t.id));
      const last = rest.map((t) => t.groupId).lastIndexOf(group.id);
      const first = state.tabs.findIndex((t) => ids.includes(t.id));
      const at = last >= 0 ? last + 1 : rest.filter((t) => state.tabs.indexOf(t) < first).length;
      return arrange({ ...state, tabs: [...rest.slice(0, at), ...joining, ...rest.slice(at)], groups: groups.includes(group) ? groups : [...groups, group] });
    }
    case "group-remove": {
      const leaving = state.tabs.filter((t) => action.ids.includes(t.id) && t.groupId);
      if (!leaving.length) return state;
      // Out of the group: just after what is left of it.
      const groupId = leaving[0].groupId;
      const rest = state.tabs.filter((t) => !leaving.includes(t));
      const end = rest.map((t) => t.groupId).lastIndexOf(groupId);
      const at = end >= 0 ? end + 1 : rest.filter((t) => state.tabs.indexOf(t) < state.tabs.indexOf(leaving[0])).length;
      return arrange({ ...state, tabs: [...rest.slice(0, at), ...leaving.map(withoutGroup), ...rest.slice(at)] });
    }
    case "group-set": {
      const groups = groupsOf(state);
      const group = groups.find((g) => g.id === action.groupId);
      if (!group) return state;
      const name = action.name === undefined ? group.name : action.name.trim().slice(0, MAX_GROUP_NAME);
      const color = action.color && GROUP_COLORS.includes(action.color) ? action.color : group.color;
      if (name === group.name && color === group.color) return state;
      return { ...state, groups: groups.map((g) => (g === group ? { ...g, name, color } : g)) };
    }
    case "ungroup": {
      if (!groupsOf(state).some((g) => g.id === action.groupId)) return state;
      return arrange({ ...state, tabs: state.tabs.map((t) => (t.groupId === action.groupId ? withoutGroup(t) : t)), groups: groupsOf(state).filter((g) => g.id !== action.groupId) });
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

/** A kept tab or closed entry that still names a file (a new-tab page names none). */
const wellFormed = <T extends { kind?: unknown; fileKey?: unknown }>(t: T | null | undefined): t is T & { kind: TabKind; fileKey: string } =>
  !!t && (((t.kind === "file" || t.kind === "prototype") && isFileKey(t.fileKey)) || t.kind === "new-tab");
/** A kept GUID ("s:l") or nothing. */
const guidOr = (v: unknown): string | undefined => (typeof v === "string" && /^\d+:\d+$/.test(v) ? v : undefined);
const placeOf = (t: { kind: TabKind; pageId?: unknown; startNodeId?: unknown }) => {
  if (t.kind !== "prototype") return {};
  const pageId = guidOr(t.pageId), startNodeId = guidOr(t.startNodeId);
  return { ...(pageId ? { pageId } : {}), ...(startNodeId ? { startNodeId } : {}) };
};
const idOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{1,32}$/.test(v) && v !== HOME;

const titleOf = (t: { title?: unknown }) => (typeof t.title === "string" && t.title ? t.title : UNTITLED);

/** What is kept of the tabs: no status (a launch starts with every tab not loaded yet). */
export function persistable(state: TabsState): { tabs: TabRecord[]; active: string; closed: ClosedTab[]; groups: TabGroup[] } {
  return {
    tabs: state.tabs.map(({ id, kind, fileKey, title, pageId, startNodeId, pinned, groupId, viewedAt }) => ({
      id,
      kind,
      fileKey,
      title,
      ...placeOf({ kind, pageId, startNodeId }),
      ...(pinned ? { pinned } : {}),
      ...(groupId ? { groupId } : {}),
      ...(viewedAt ? { viewedAt } : {}),
    })),
    active: state.active,
    closed: state.closed,
    groups: groupsOf(state),
  };
}

/** The tabs as kept — anything malformed (or a legacy tab of the old site admin) dropped; every tab "discarded" (it loads when shown). */
export function restoreTabs(saved: unknown): TabsState {
  if (!saved || typeof saved !== "object") return emptyTabs();
  const s = saved as { tabs?: unknown; active?: unknown; closed?: unknown; groups?: unknown };
  const groups: TabGroup[] = [];
  for (const g of Array.isArray(s.groups) ? (s.groups as Partial<TabGroup>[]) : []) {
    if (!g || !idOk(g.id) || groups.some((o) => o.id === g.id)) continue;
    const number = typeof g.number === "number" && Number.isInteger(g.number) && g.number > 0 ? g.number : groups.length + 1;
    const color = GROUP_COLORS.includes(g.color as GroupColor) ? (g.color as GroupColor) : GROUP_COLORS[(number - 1) % GROUP_COLORS.length];
    groups.push({ id: g.id, number, name: typeof g.name === "string" ? g.name.slice(0, MAX_GROUP_NAME) : "", color });
  }
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of Array.isArray(s.tabs) ? (s.tabs as Partial<TabRecord>[]) : []) {
    if (!wellFormed(t)) continue;
    // One tab per file (and per prototype start), as the reducer keeps it.
    const place = placeOf(t);
    const fileKey = t.kind === "new-tab" ? "" : t.fileKey;
    if (tabs.some((o) => sameTab(o, { kind: t.kind, fileKey, ...place }))) continue;
    const id = idOk(t.id) && !seen.has(t.id) ? t.id : newTabId();
    seen.add(id);
    const tab: Tab = { id, kind: t.kind, fileKey, title: t.kind === "new-tab" ? NEW_TAB : titleOf(t), status: "discarded", ...place };
    if (t.pinned === true) tab.pinned = true;
    if (typeof t.groupId === "string" && groups.some((g) => g.id === t.groupId)) tab.groupId = t.groupId;
    if (typeof t.viewedAt === "number" && Number.isFinite(t.viewedAt) && t.viewedAt > 0) tab.viewedAt = t.viewedAt;
    tabs.push(tab);
  }
  const active = typeof s.active === "string" && tabs.some((t) => t.id === s.active) ? s.active : HOME;
  const closed: ClosedTab[] = (Array.isArray(s.closed) ? (s.closed as Partial<ClosedTab>[]) : [])
    .filter((c): c is ClosedTab => wellFormed(c) && c.kind !== "new-tab")
    .slice(0, MAX_CLOSED)
    .map((c) => ({ kind: c.kind, fileKey: c.fileKey, title: titleOf(c), ...placeOf(c) }));
  return arrange({ tabs, active, closed, ...(groups.length ? { groups } : {}) });
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

// ── Offloading (atlas 01 §2.7) ────────────────────────────────────────────────

/**
 * Tabs loaded live at launch: the most recently viewed. Figma loads 15 (6 behind a proxy); ours is 3 until the
 * memory check before launch loading is built — one large file takes 3.2–3.6 GB here (the owner's B2C copy, 16 GB Mac).
 */
export const LIVE_AT_START = 3;
/** The discard sweep: hourly, for tabs not viewed in 48 h, only with 5 tabs or more, keeping 3 live. */
export const DISCARD_SWEEP_MS = 60 * 60_000;
export const DISCARD_AFTER_MS = 48 * 60 * 60_000;
export const DISCARD_MIN_TABS = 5;
export const DISCARD_KEEP_LIVE = 3;
/** Back after this long away (the app not focused): a sweep when it is focused again, none while it is away. */
export const DISCARD_IDLE_MS = 4 * 60 * 60_000;

/**
 * The tabs a sweep offloads, oldest first (atlas 01 §2.7): not in front, not pinned, loaded, a file (Design) tab, last
 * viewed (or opened) over 48 h ago — none with fewer than 5 tabs, and at least 3 loaded tabs left.
 */
export function discardable(state: TabsState, loaded: ReadonlySet<string>, now: number): string[] {
  if (state.tabs.length < DISCARD_MIN_TABS) return [];
  const candidates = state.tabs
    .filter((t) => t.id !== state.active && !t.pinned && t.kind === "file" && loaded.has(t.id) && now - (t.viewedAt ?? 0) > DISCARD_AFTER_MS)
    .sort((a, b) => (a.viewedAt ?? 0) - (b.viewedAt ?? 0));
  const live = state.tabs.filter((t) => loaded.has(t.id)).length;
  return candidates.slice(0, Math.max(0, live - DISCARD_KEEP_LIVE)).map((t) => t.id);
}

/** The tabs loaded at launch besides the one in front: the most recently viewed file tabs, up to `LIVE_AT_START` in all. */
export function liveAtStart(state: TabsState, limit = LIVE_AT_START): string[] {
  return state.tabs
    .filter((t) => t.id !== state.active && t.kind === "file")
    .sort((a, b) => (b.viewedAt ?? 0) - (a.viewedAt ?? 0))
    .slice(0, Math.max(0, limit - (state.active === HOME ? 0 : 1)))
    .map((t) => t.id);
}
