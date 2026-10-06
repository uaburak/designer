/**
 * Every message between main and the views: channel names, who may use
 * them, and their payloads — the single source of truth (docs/desktop.md
 * §10, docs/desktop-impl.md). Main (src/main/ipc.ts) and the preloads
 * (src/preload/*) import these maps, so a channel can't drift.
 *
 * Kinds: `IpcInvoke` request/response from a view; `IpcSend` fire-and-forget
 * from a view; `IpcEvents` from main to a view.
 */
import type { CommandId } from "./commands";
import type { TabKind, TabReport, TabStatus } from "./tabs";
import type { SignInResult, ThemePreference } from "./api";

/** What a view is (each its own WebContentsView, renderer process and preload). */
export type Role = "tabbar" | "home" | "editor";

export interface InitInfo {
  version: string;
  platform: string;
  role: Role;
  /** The file tab this view shows (editor), else null */
  tabId: string | null;
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

/** A tab as the tab bar and Home see it — Home first (`id: "home"`). */
export interface TabInfo {
  id: string;
  kind: TabKind | "home";
  slug: string;
  title: string;
  dirty: boolean;
  status: TabStatus | "ready";
}

export interface TabsSnapshot {
  windowId: string;
  tabs: TabInfo[];
  activeTabId: string;
  canReopen: boolean;
  fullScreen: boolean;
  /** False while Home shows the sign-in: the tab bar shows no tabs */
  signedIn: boolean;
}

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
}

/** Home's side of the tabs: whether it is in front, which projects are open, the last save (its lists are read again). */
export interface HomeState {
  visible: boolean;
  openSlugs: string[];
  savedAt: number;
}

export interface MenuCommandEvent {
  id: CommandId;
  /** A menu click, or an accelerator the page left unhandled (it saw the key already) */
  source: "menu" | "accelerator";
}

/**
 * Main asks a file tab (legacy, until autosave's `tab:flush` handshake,
 * docs/desktop.md §6): whether it holds unsaved work, or to save it. Main
 * always waits with a timeout.
 */
export interface TabRequest {
  reqId: number;
  op: "is-dirty" | "save";
}
export interface TabResponse {
  reqId: number;
  ok: boolean;
  value?: boolean;
  error?: string;
}

export interface OpenFile {
  kind: TabKind;
  slug: string;
  title?: string;
}

export interface IpcInvoke {
  "desktop:init": { args: []; result: InitInfo };
  "tabs:get": { args: []; result: TabsSnapshot };
  "nav:open-file": { args: [OpenFile]; result: { tabId: string } };
  /** The theme preference set: main keeps it, tells every view (`theme:changed`) and answers what it resolves to */
  "theme:set": { args: [ThemePreference]; result: ThemeState };
  /** A native menu at a point of the view (`at` in the view's CSS pixels): the picked item's id, or null */
  "menu:popup": { args: [{ template: NativeMenuItem[]; x: number; y: number }]; result: string | null };
  /** Legacy: Google's sign-in in the system browser (main/signIn.ts) */
  "auth:google": { args: []; result: SignInResult };
}

export interface IpcSend {
  "shell:ready": void;
  "tabs:activate": { tabId: string };
  "tabs:close": { tabId: string };
  "tabs:move": { tabId: string; toIndex: number };
  "tabs:context-menu": { tabId: string; x: number; y: number };
  "tabs:reopen": void;
  /** "+" in the tab bar: Home's New Project dialog (legacy; `nav:new-file` creates a file once the store exists) */
  "nav:new-file": void;
  "nav:go-home": void;
  "tab:report": TabReport;
  "tab:response": TabResponse;
  /** Home's sign-in gate: an admin signed in, or not */
  "session:auth": { signedIn: boolean };
  /** Sign out, asked from anywhere: main settles unsaved tabs, closes them, then tells Home (`session:sign-out`) */
  "session:request-sign-out": void;
  "auth:cancel": void;
  "shell:open-external": { url: string };
}

export interface IpcEvents {
  "tabs:state": TabsSnapshot;
  "window:state": WindowState;
  "menu:command": MenuCommandEvent;
  "tab:visibility": { visible: boolean };
  "tab:request": TabRequest;
  "home:state": HomeState;
  /** To Home: the unsaved tabs are settled and closed — sign out now */
  "session:sign-out": void;
  /** The theme changed (a choice, or the system's appearance while the preference is "system") */
  "theme:changed": ThemeState;
}

/** Which roles may use which channel (main drops anything else). */
export const INVOKE_ROLES: { [C in keyof IpcInvoke]: readonly Role[] } = {
  "desktop:init": ["tabbar", "home", "editor"],
  "tabs:get": ["tabbar", "home"],
  "nav:open-file": ["home", "editor"],
  "theme:set": ["tabbar", "home", "editor"],
  "menu:popup": ["tabbar", "home", "editor"],
  "auth:google": ["home"],
};

export const SEND_ROLES: { [C in keyof IpcSend]: readonly Role[] } = {
  "shell:ready": ["tabbar", "home", "editor"],
  "tabs:activate": ["tabbar", "home"],
  "tabs:close": ["tabbar", "editor"],
  "tabs:move": ["tabbar"],
  "tabs:context-menu": ["tabbar"],
  "tabs:reopen": ["tabbar", "home"],
  "nav:new-file": ["tabbar", "home", "editor"],
  "nav:go-home": ["editor"],
  "tab:report": ["editor"],
  "tab:response": ["editor"],
  "session:auth": ["home"],
  "session:request-sign-out": ["home", "editor"],
  "auth:cancel": ["home"],
  "shell:open-external": ["home", "editor"],
};
