/**
 * Every message between main and the views: channel names, who may use
 * them, and their payloads — the single source of truth (docs/desktop.md
 * §10, docs/desktop-impl.md). Main (src/main/ipc.ts) and the preloads
 * (src/preload/*) import these maps, so a channel can't drift.
 *
 * Kinds: `IpcInvoke` request/response from a view; `IpcSend` fire-and-forget
 * from a view; `IpcEvents` from main to a view.
 */
import type { AgentSettings, AuthState, ConnectResult, McpClientId, McpClientInfo, McpState, ProviderInfo, ToolCall, ToolCallResult, TurnEvent, TurnRequest } from "./agents/types";
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
  /** A variable font (`fvar`): its styles are named instances */
  variable?: boolean;
}

/** One style of a Google Fonts family (docs/desktop.md §14.1): its id is what `fonts:read` downloads. */
export interface GoogleFontStyle {
  /** Google's name: "Regular", "SemiBold Italic" … (the variable font's named instance) */
  style: string;
  weight: number;
  italic: boolean;
  id: string;
}
/** A family of the Google Fonts catalog (fonts.google.com/metadata/fonts, reduced). */
export interface GoogleFontFamily {
  family: string;
  /** "Sans Serif", "Serif", "Display", "Handwriting", "Monospace" */
  category: string;
  /** Google's popularity rank (1 = most used) */
  popularity: number;
  /** Variable axes (none: static files) */
  axes: { tag: string; min: number; max: number; default: number }[];
  styles: GoogleFontStyle[];
}

export interface FontIndex {
  version: number;
  /** The installed fonts (system and user) */
  faces: FontFaceInfo[];
  /** The Google Fonts catalog (empty offline before it was first fetched) */
  google?: GoogleFontFamily[];
}

/** One exported file: its name (relative, "/" for folders) and bytes. */
export interface ExportAsset {
  name: string;
  bytes: Uint8Array;
}

/** `file:export-preview`'s request (the options as the Share dialog chose them). */
export interface ExportPreviewRequest {
  fileKey: string;
  snapshot: Uint8Array;
  options: { pageIds: string[] | "all"; inspect: boolean; export: boolean };
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
  /**
   * Exported files (File › Export…, the Design panel's Export section, Export frames to PDF): one through the system's
   * Save dialog, more into a folder picked in its Open dialog; names with "/" make folders, a name already taken
   * becomes "name 2.png" (shared/exportFiles.ts)
   */
  "file:export-assets": { args: [{ files: ExportAsset[] }]; result: { paths: string[] } | { cancelled: true } };
  /**
   * A developer preview as one self-contained HTML file where the system's Save dialog says (docs/data.md §13):
   * `snapshot` is the editor's derived kiwi Message; the store adds the images and the viewer and writes the file
   */
  "file:export-preview": { args: [ExportPreviewRequest]; result: { path: string; bytes: number } | { cancelled: true } };
  /** The theme preference set: main keeps it, tells every view (`theme:changed`) and answers what it resolves to */
  "theme:set": { args: [ThemePreference]; result: ThemeState };
  /** A native menu at a point of the view (`at` in the view's CSS pixels): the picked item's id, or null */
  "menu:popup": { args: [{ template: NativeMenuItem[]; x: number; y: number }]; result: string | null };
  /** The system's and the user's fonts (scanned once, cached in userData/cache/fonts-v1.json) */
  "fonts:list": { args: []; result: FontIndex };
  /** A face's whole font file (the engine parses it), by its index id; a Google face is downloaded on first use */
  "fonts:read": { args: [{ id: string }]; result: Uint8Array };
  /** A Google family's Regular subset to `text` (its name), for the font picker's row in its own face */
  "fonts:preview": { args: [{ family: string; text: string }]; result: Uint8Array };
  // ── Agents (src/main/agents; docs/research/figma/R12-agents-mcp.md) ──
  /** The AI tools on this computer (CLIs found, local model servers that answer) */
  "agents:providers": { args: []; result: ProviderInfo[] };
  "agents:settings": { args: []; result: AgentSettings };
  "agents:set-settings": { args: [Partial<Pick<AgentSettings, "providerId" | "models">>]; result: AgentSettings };
  /** An OpenAI-compatible server by base URL; its key (if any) goes to the OS keychain (safeStorage), never to disk in clear */
  "agents:add-server": { args: [{ label: string; baseUrl: string; apiKey?: string }]; result: AgentSettings };
  "agents:remove-server": { args: [{ id: string }]; result: AgentSettings };
  /** Test connection: the provider's models, or why it can't be reached */
  "agents:test": { args: [{ providerId: string }]; result: { ok: boolean; models: string[]; error?: string } };
  /** A CLI agent's sign-in state; Sign in / Sign out with its own commands (the browser does the sign-in) */
  "agents:auth": { args: [{ providerId: string }]; result: AuthState };
  "agents:sign-in": { args: [{ providerId: string }]; result: AuthState };
  "agents:sign-out": { args: [{ providerId: string }]; result: AuthState };
  /** A chat turn on this view's file: its events come as `agents:event` */
  "agents:turn": { args: [TurnRequest]; result: { turnId: string } };
  "agents:stop": { args: [{ turnId: string }]; result: void };
  /** The MCP server: its URL and connections */
  "agents:mcp": { args: []; result: McpState };
  /** MCP clients on this computer and whether they are connected */
  "agents:clients": { args: []; result: McpClientInfo[] };
  /** Connect: our server written into the client's config after main's confirmation (cancelled: ok false, no error) */
  "agents:connect": { args: [{ client: McpClientId }]; result: ConnectResult };
  "agents:disconnect": { args: [{ client: McpClientId }]; result: ConnectResult };
  /** Copy config: the client's entry as text (HTTP with the token), and the stdio command form */
  "agents:client-config": { args: [{ client: McpClientId }]; result: { path: string; text: string; stdio: string } };
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
  /** A tool call's answer from the view that ran it */
  "agents:tool-result": ToolCallResult;
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
  /** Fonts were installed or removed (or the Google Fonts catalog changed): read `fonts:list` again */
  "fonts:changed": { version: number };
  /** A chat turn's stream */
  "agents:event": TurnEvent;
  /** A tool to run on this view's file (answer `agents:tool-result`) */
  "agents:tool-call": ToolCall;
  /** The MCP server's connections changed */
  "agents:mcp-state": McpState;
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
  "file:export-assets": ["editor"],
  "file:export-preview": ["editor"],
  "theme:set": ["tabbar", "home", "editor"],
  "menu:popup": ["tabbar", "home", "editor"],
  "fonts:list": ["editor"],
  "fonts:read": ["editor"],
  "fonts:preview": ["editor"],
  "agents:providers": ["editor"],
  "agents:settings": ["editor"],
  "agents:set-settings": ["editor"],
  "agents:add-server": ["editor"],
  "agents:remove-server": ["editor"],
  "agents:test": ["editor"],
  "agents:auth": ["editor"],
  "agents:sign-in": ["editor"],
  "agents:sign-out": ["editor"],
  "agents:turn": ["editor"],
  "agents:stop": ["editor"],
  "agents:mcp": ["editor"],
  "agents:clients": ["editor"],
  "agents:connect": ["editor"],
  "agents:disconnect": ["editor"],
  "agents:client-config": ["editor"],
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
  "agents:tool-result": ["editor"],
};
