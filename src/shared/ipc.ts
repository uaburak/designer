/**
 * Every message between main and the views: channel names, who may use
 * them, and their payloads — the single source of truth (docs/desktop.md
 * §10, docs/desktop-impl.md). Main (src/main/ipc.ts) and the preloads
 * (src/preload/*) import these maps, so a channel can't drift.
 *
 * Kinds: `IpcInvoke` request/response from a view; `IpcSend` fire-and-forget
 * from a view; `IpcEvents` from main to a view.
 */
import type { CommandId, MenuStatePatch } from "./commands";
import type { TabKind, TabReport, TabStatus } from "./tabs";

/** What a view is (each its own WebContentsView, renderer process and preload). */
export type Role = "tabbar" | "home" | "editor";

export type ThemePreference = "system" | "light" | "dark";

export interface InitInfo {
  version: string;
  platform: string;
  role: Role;
  /** The file tab this view shows (editor), else null */
  tabId: string | null;
  /** The workspace file this view shows (editor), else null */
  fileKey: string | null;
  windowId: string;
  theme: ThemeState;
}

/** The theme: the preference main keeps (settings.json) and what it resolves to now (nativeTheme). */
export interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
}

/** A native menu's item, as a view asks for it (`menu:popup`): plain data, built into an Electron menu by main. */
export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

/** A tab as the tab bar and Home see it — Home first (`id: "home"`, no fileKey). */
export interface TabInfo {
  id: string;
  kind: TabKind | "home";
  fileKey?: string;
  title: string;
  status: TabStatus;
}

export interface TabsSnapshot {
  windowId: string;
  tabs: TabInfo[];
  activeTabId: string;
  canReopen: boolean;
  fullScreen: boolean;
}

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
}

/** Home's side of the tabs: whether it is in front, which files are open. */
export interface HomeState {
  visible: boolean;
  openFileKeys: string[];
}

export interface MenuCommandEvent {
  id: CommandId;
  /** A menu click, or an accelerator the page left unhandled (it saw the key already) */
  source: "menu" | "accelerator";
}

export type { MenuStatePatch };

/**
 * Why main asks a file tab to flush (docs/desktop.md §6): the tab or window
 * closes, the app quits, the view is dropped or reloaded — or it was hidden
 * (another tab came in front, the Mac sleeps or locks), when nothing waits
 * for the answer.
 */
export type FlushReason = "close" | "quit" | "discard" | "reload" | "hide";

/** `tab:flush`: every change handed to the store, and the store's flush (fsync) awaited. */
export interface TabFlush {
  reqId: number;
  reason: FlushReason;
}
export interface TabFlushed {
  reqId: number;
  ok: boolean;
  error?: string;
}

/** A workspace file in a tab (`nav:open-file`). */
export interface OpenWorkspaceFile {
  fileKey: string;
  /** The file's name, shown at once (main reads it from the store otherwise) */
  title?: string;
  /** Open without bringing it in front (Home's "Open in new tab") */
  background?: boolean;
  /** Where to land in the file (deep links; passed on as `tab:navigate` later) */
  pageId?: string;
  nodeId?: string;
}

/** A file's presentation view in a tab of its own (`nav:open-prototype`, Present). */
export interface OpenPrototype {
  fileKey: string;
  /** The page presented */
  pageId: string;
  /** The frame it starts at (none: the page's first flow) */
  startNodeId?: string;
  /** The file's name, for the tab */
  title?: string;
}

/** `nav:open-file`'s answer: the tab, and whether the file already had one (it was brought in front instead). */
export interface OpenFileResult {
  tabId: string;
  existing: boolean;
}

/**
 * `tab:attach` (docs/desktop.md §3.1, §10.2): an editor view told which tab
 * and file it is. A view made for a tab has them in its URL already; the
 * spare editor — pre-warmed with no file — learns them from this message
 * when a file opens and main adopts it.
 */
export interface TabAttach {
  tabId: string;
  fileKey: string;
  mode: "edit" | "prototype";
  pageId?: string;
  nodeId?: string;
  startNodeId?: string;
}

/** `nav:new-file`: a new design file in a folder (null: Drafts), opened in a tab. */
export interface NewFileRequest {
  folderId?: string | null;
  name?: string;
}
export interface NewFileResult {
  fileKey: string;
  tabId: string;
}

/** `file:import`: .fig files read into the workspace. */
export interface ImportResult {
  files: { fileKey: string; name: string }[];
  failed: { path: string; error: string }[];
}

/** One face of an installed font file (docs/desktop.md §14). Paths never reach a view. */
export interface FontFaceInfo {
  /** First 16 hex of sha1(path + "#" + collectionIndex) */
  id: string;
  /** Typographic family (name 16, else 1) */
  family: string;
  /** Typographic subfamily (name 17, else 2), e.g. "Semi Bold Italic" */
  style: string;
  postscriptName: string;
  /** 100–900 */
  weight: number;
  italic: boolean;
  /** 1–9 */
  stretch: number;
  source: "system" | "user";
  collectionIndex: number;
}
export interface FontIndex {
  version: number;
  faces: FontFaceInfo[];
}

export interface IpcInvoke {
  "desktop:init": { args: []; result: InitInfo };
  "tabs:get": { args: []; result: TabsSnapshot };
  "nav:open-file": { args: [OpenWorkspaceFile]; result: OpenFileResult };
  "nav:open-prototype": { args: [OpenPrototype]; result: OpenFileResult };
  "nav:new-file": { args: [NewFileRequest]; result: NewFileResult };
  /** .fig files into a folder (null: Drafts): the given paths, or the ones picked in the system's Open dialog */
  "file:import": { args: [{ folderId: string | null; paths?: string[] }]; result: ImportResult };
  /** A file written out as a .fig where the system's Save dialog says */
  "file:save-local-copy": { args: [{ fileKey: string }]; result: { path: string } | { cancelled: true } };
  /** The theme preference set: main keeps it, tells every view (`theme:changed`) and answers what it resolves to */
  "theme:set": { args: [ThemePreference]; result: ThemeState };
  /** A native menu at a point of the view (`at` in the view's CSS pixels): the picked item's id, or null */
  "menu:popup": { args: [{ template: NativeMenuItem[]; x: number; y: number }]; result: string | null };
  /** The system's and the user's fonts (scanned once, cached in userData/cache/fonts-v1.json) */
  "fonts:list": { args: []; result: FontIndex };
  /** A face's whole font file (the engine parses it), by its index id */
  "fonts:read": { args: [{ id: string }]; result: Uint8Array };
}

export interface IpcSend {
  "shell:ready": void;
  "tabs:activate": { tabId: string };
  "tabs:close": { tabId: string };
  "tabs:move": { tabId: string; toIndex: number };
  "tabs:context-menu": { tabId: string; x: number; y: number };
  "tabs:reopen": void;
  /** Home in front ("Back to files"), the file shown there when given */
  "nav:go-home": { revealFileKey?: string } | undefined;
  "tab:report": TabReport;
  "tab:flushed": TabFlushed;
  /** What the view says about the menu bar's items (enabled, checked): only what changed */
  "menu:state": MenuStatePatch;
  /** The workspace folder in Finder */
  "file:reveal-data-folder": void;
  "shell:open-external": { url: string };
}

export interface IpcEvents {
  "tabs:state": TabsSnapshot;
  "window:state": WindowState;
  "menu:command": MenuCommandEvent;
  /** An editor view's tab and file (the spare editor adopted for a file that opens) */
  "tab:attach": TabAttach;
  "tab:visibility": { visible: boolean };
  /** A file tab: send every change to the store and flush it, then answer `tab:flushed` */
  "tab:flush": TabFlush;
  "home:state": HomeState;
  /** To Home: show this file (Show in File Browser, Back to files from it) */
  "home:reveal": { fileKey: string };
  /** A new store port is on its way (with the event, as a transferred MessagePort): one per page load and per store start */
  "store:port": { generation: number };
  /** The theme changed (a choice, or the system's appearance while the preference is "system") */
  "theme:changed": ThemeState;
}

/** Which roles may use which channel (main drops anything else). */
export const INVOKE_ROLES: { [C in keyof IpcInvoke]: readonly Role[] } = {
  "desktop:init": ["tabbar", "home", "editor"],
  "tabs:get": ["tabbar", "home"],
  "nav:open-file": ["home", "editor"],
  "nav:open-prototype": ["editor"],
  "nav:new-file": ["tabbar", "home", "editor"],
  "file:import": ["home", "editor"],
  "file:save-local-copy": ["home", "editor"],
  "theme:set": ["tabbar", "home", "editor"],
  "menu:popup": ["tabbar", "home", "editor"],
  "fonts:list": ["editor"],
  "fonts:read": ["editor"],
};

export const SEND_ROLES: { [C in keyof IpcSend]: readonly Role[] } = {
  "shell:ready": ["tabbar", "home", "editor"],
  "tabs:activate": ["tabbar", "home"],
  "tabs:close": ["tabbar", "editor"],
  "tabs:move": ["tabbar"],
  "tabs:context-menu": ["tabbar"],
  "tabs:reopen": ["tabbar", "home"],
  "nav:go-home": ["editor"],
  "tab:report": ["editor"],
  "tab:flushed": ["editor"],
  "menu:state": ["home", "editor"],
  "file:reveal-data-folder": ["home", "editor"],
  "shell:open-external": ["home", "editor"],
};
