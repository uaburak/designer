/**
 * `window.designer`: what each view's preload hands its page (contextBridge,
 * docs/desktop.md §10.3). The page never sees ipcRenderer; each role gets
 * only its own calls. Absent in a browser (`npm run web`).
 *
 * The store is not here: Home and editors talk to it over their own
 * MessagePort (`@/store/client`), which the preload forwards to the page as
 * `window.postMessage({type: "designer:store-port", generation}, origin, [port])`
 * on every page load and every store restart (and again when the page posts
 * `designer:store-port-wanted`, for a client made after the port arrived).
 */
import type {
  ExportAsset,
  ExportPreviewRequest,
  FlushReason,
  FontIndex,
  IdleNotice,
  HomeState,
  ImportResult,
  InitInfo,
  IpcInvoke,
  MenuCommandEvent,
  MenuStatePatch,
  NativeMenuItem,
  NewFileResult,
  OpenFileResult,
  OpenWorkspaceFile,
  Role,
  TabAttach,
  TabsSnapshot,
  ThemePreference,
  ThemeState,
  UploadedFont,
  VectorClipboard,
  WindowState,
} from "./ipc";
import type { AccountMethod, AccountResponse, AccountState, SignInResult } from "./account";
import type { AgentSetupApi, AgentsApi } from "./agents/types";
import type { AiApi, AiSetupApi } from "./ai/api";
import type { SharedFontScope } from "./fonts/sharedTypes";
import type { ShortcutSettings } from "./shortcuts";
import type { TabReport } from "./tabs";

export type Unsubscribe = () => void;

interface DesktopCommon {
  role: Role;
  platform: string;
  version: string;
  init(): Promise<InitInfo>;
  /** After the first paint (`shell:ready`): the window shows once the tab bar and the content in front are ready */
  ready(): void;
  /** The theme when the view was made (`--designer-theme`), for boot.js before the first paint; onThemeChanged after */
  theme: ThemeState;
  setTheme(preference: ThemePreference): Promise<ThemeState>;
  /** Settings › Account › Enhance contrast (Home and editors) */
  setContrast(on: boolean): Promise<ThemeState>;
  onThemeChanged(cb: (t: ThemeState) => void): Unsubscribe;
  onWindowState(cb: (s: WindowState) => void): Unsubscribe;
  onFullScreen(cb: (fullScreen: boolean) => void): Unsubscribe;
  /** The trackpad's haptic tick (a scrub's step; macOS, throttled by main — docs/desktop.md §10.2 "Haptics") */
  haptics: { tick(): void };
  /** The account on the multiplayer server (docs/multiplayer.md §2); sign-in/out only from Home and editors */
  account: {
    get(): Promise<AccountState>;
    /** `tenant`: an org's SAML SSO (18 digits) — straight to its IdP (docs/desktop.md §18.1) */
    signIn(opts?: { tenant?: string }): Promise<SignInResult>;
    cancelSignIn(): Promise<AccountState>;
    signOut(): Promise<AccountState>;
    onChanged(cb: (s: AccountState) => void): Unsubscribe;
    /** The idle prompt's Stay logged in: activity posted, the prompt cleared in every view (docs/desktop.md §18.2) */
    staySignedIn(): Promise<AccountState>;
    /** The idle timeout: "warning" (to the view in front; logoutAt in ms), "cleared", "logged-out" (every Home / editor) */
    onIdle(cb: (n: IdleNotice) => void): Unsubscribe;
    /** Settings: the caller's own account on the server (`/me…`), main adding the session (Home and editors) */
    request(r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse>;
  };
  menu: {
    /** A native menu at a point of this view: the picked item's id, or null when dismissed */
    popup(template: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null>;
  };
}

export interface TabBarApi extends DesktopCommon {
  role: "tabbar";
  tabs: {
    get(): Promise<TabsSnapshot>;
    onState(cb: (s: TabsSnapshot) => void): Unsubscribe;
    activate(id: string): void;
    close(id: string): void;
    /** toIndex counts Home as 0 */
    move(id: string, toIndex: number): void;
    contextMenu(id: string, x: number, y: number): void;
    /** Windows: the main menu button (the app's menu, as Figma's Windows app has no menu bar) */
    mainMenu(x: number, y: number): void;
    reopen(): void;
    /** "+": a new design file in Drafts, opened */
    newFile(): void;
  };
}

/** Opening files, for Home and editors. */
export interface NavApi {
  /**
   * A workspace file in a tab: its tab brought in front if it has one
   * (`existing: true`), else a new tab at the end.
   */
  openFile(fileKey: string, options?: Omit<OpenWorkspaceFile, "fileKey">): Promise<OpenFileResult>;
  openFile(file: OpenWorkspaceFile): Promise<OpenFileResult>;
  /** A new design file (Drafts when folderId is null), created by main through the store and opened. */
  newFile(folderId?: string | null, name?: string): Promise<NewFileResult>;
  /** Present (R8 §9): the file's presentation view in a new tab (one per file and starting frame; editors only). */
  openPrototype?(fileKey: string, pageId: string, startNodeId?: string, title?: string): Promise<OpenFileResult>;
}

/** Native file dialogs and paths (docs/desktop.md §10.2 "Files and native dialogs"). */
export interface FilesApi {
  /** .fig files into a folder (null: Drafts): `paths` (dropped files, see pathFor), or the ones picked in the Open dialog */
  import(folderId: string | null, paths?: string[]): Promise<ImportResult>;
  /** The file as a .fig, where the Save dialog says */
  saveLocalCopy(fileKey: string): Promise<{ path: string } | { cancelled: true }>;
  /** Exported files: one where the Save dialog says, more into the folder the Open dialog picks (editors only) */
  exportAssets(files: ExportAsset[]): Promise<{ paths: string[] } | { cancelled: true }>;
  /** A developer preview as one HTML file, where the Save dialog says (editors; docs/data.md §13) */
  exportPreview(request: ExportPreviewRequest): Promise<{ path: string; bytes: number } | { cancelled: true }>;
  /** The path of a File dropped on the page (webUtils.getPathForFile), for import */
  pathFor(file: File): string;
  /** The workspace folder in Finder */
  revealDataFolder(): void;
}

/** The menu bar, as a content view sees it. */
export interface ViewMenuApi {
  popup(template: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null>;
  /** A menu command for this view (a click, or an accelerator the page left unhandled) */
  onCommand(cb: (c: MenuCommandEvent) => void): Unsubscribe;
  /** Which of its commands are enabled / checked now — only what changed, at most once a frame (docs/desktop.md §8.4) */
  setState(patch: MenuStatePatch): void;
}

export interface HomeApi extends DesktopCommon {
  role: "home";
  tabs: {
    get(): Promise<TabsSnapshot>;
    onState(cb: (s: TabsSnapshot) => void): Unsubscribe;
    activate(id: string): void;
    reopen(): void;
  };
  nav: NavApi;
  files: FilesApi;
  home: {
    onState(cb: (s: HomeState) => void): Unsubscribe;
    /** Show this file (a tab's "Show in File Browser", an editor's "Back to files") */
    onReveal(cb: (r: { fileKey: string }) => void): Unsubscribe;
    /** A shared file's link opened from the system (designer://open?key=…) */
    onOpenShared(cb: (r: { key: string; link?: string }) => void): Unsubscribe;
  };
  menu: ViewMenuApi;
  openExternal(url: string): void;
  /** Settings › Account › Your uploaded fonts: the faces, a face's bytes (its sample), upload, remove */
  fonts: { read(id: string): Promise<Uint8Array> } & UploadedFontsApi & SharedFontsApi;
  /** Settings › Agents: the agents' setup (no turns) */
  agents: AgentSetupApi;
  /** Settings › AI (src/main/ai, docs/ai.md §7): the settings, image keys, local models (no runs) */
  ai: AiSetupApi;
}

/** "Your uploaded fonts" (docs/desktop.md §14.2) */
export interface UploadedFontsApi {
  uploaded(): Promise<UploadedFont[]>;
  /** Main's Open dialog; the files checked and copied into userData/fonts/uploaded */
  upload(): Promise<{ fonts: UploadedFont[]; failed: string[] } | { cancelled: true }>;
  removeUploaded(id: string): Promise<UploadedFont[]>;
}

/**
 * Organization and team fonts (docs/desktop.md §14.3; Admin › Resources › Fonts, a team's View team's fonts): the
 * scope's list, main's Open dialog with each file parsed and the conflicts asked, the upload once the licence is
 * confirmed and Skip / Replace chosen per family, removal.
 */
export interface SharedFontsApi {
  sharedList(scope: SharedFontScope): Promise<IpcInvoke["fonts:shared-list"]["result"]>;
  sharedPick(scope: SharedFontScope): Promise<IpcInvoke["fonts:shared-pick"]["result"]>;
  sharedUpload(req: IpcInvoke["fonts:shared-upload"]["args"][0]): Promise<IpcInvoke["fonts:shared-upload"]["result"]>;
  sharedRemove(req: IpcInvoke["fonts:shared-remove"]["args"][0]): Promise<IpcInvoke["fonts:shared-remove"]["result"]>;
}

export interface EditorApi extends DesktopCommon {
  role: "editor";
  tab: {
    /**
     * Which tab and file this view is (`tab:attach`, docs/desktop.md §3.1):
     * sent when main adopts the spare editor for a file that opens. An
     * attach that arrived before the handler was registered is handed over
     * as soon as it is. A view made for a tab has them in its URL and in
     * `init()` instead.
     */
    onAttach(cb: (a: TabAttach) => void): Unsubscribe;
    /** title, status */
    report(r: TabReport): void;
    onVisibility(cb: (v: { visible: boolean }) => void): Unsubscribe;
    /**
     * Main's flush (docs/desktop.md §6): send every change to the store and
     * await its flush. Resolve when done; a rejection is reported as a failed
     * save (main asks Try Again / Close Anyway). Main waits 3 s at most; with
     * no handler the preload answers ok at once.
     */
    onFlush(cb: (reason: FlushReason) => void | Promise<void>): Unsubscribe;
    close(): void;
  };
  nav: NavApi & {
    /** Home in front — "Back to files"; Home shows `revealFileKey` (default: this tab's file) */
    goHome(revealFileKey?: string): void;
  };
  files: FilesApi;
  menu: ViewMenuApi;
  openExternal(url: string): void;
  /** Installed fonts and the Google Fonts catalog for the engine and the font picker (src/renderer/src/engine/fonts.ts). */
  fonts: {
    list(): Promise<FontIndex>;
    /** A face's file (a Google face is downloaded on first use) */
    read(id: string): Promise<Uint8Array>;
    /** A Google family's Regular subset to `text`, for the picker's row in its own face */
    preview(family: string, text: string): Promise<Uint8Array>;
    /** Fonts were installed or removed, or the Google catalog changed */
    onChanged(cb: () => void): () => void;
  } & UploadedFontsApi &
    SharedFontsApi;
  /**
   * Text › Spell check (round 10; src/renderer/src/editor/spellcheck.ts): the view's spell checker (Chromium's, the
   * system's dictionaries) — which of `words` it doesn't know. In the preload, no IPC.
   */
  spelling: {
    misspelled(words: string[]): boolean[];
  };
  /** Agents and the MCP server (src/main/agents; docs/research/figma/R12-agents-mcp.md) */
  agents: AgentsApi;
  /** AI (src/main/ai, docs/ai.md §2.2, §8): one-shot runs and their events, image runs, settings, local models */
  ai: AiApi;
  /** The system clipboard's flavours a paste event can't see (docs/desktop.md §13 "Vector paste") */
  clipboard: {
    /** Vector artwork as SVG (Illustrator's SVG or PDF, any SVG), or null */
    readVector(): Promise<VectorClipboard | null>;
  };
  /** The user's keyboard shortcuts, kept by main (settings.json): the Keyboard shortcuts panel's (src/shared/shortcuts.ts) */
  shortcuts: {
    get(): Promise<ShortcutSettings>;
    set(patch: Partial<ShortcutSettings>): Promise<ShortcutSettings>;
    onChanged(cb: (s: ShortcutSettings) => void): Unsubscribe;
  };
  /** Main's side of plugins (docs/plugins.md §3.3, src/main/plugins): the `plugins:*` channels, one call each */
  plugins: PluginsDesktopApi;
  /** Dev Mode (docs/editor.md D-3): a dev resource link's page title, or null */
  devMode: {
    linkTitle(url: string): Promise<string | null>;
  };
}

type Args<C extends keyof IpcInvoke> = IpcInvoke[C]["args"][0];
type Result<C extends keyof IpcInvoke> = Promise<IpcInvoke[C]["result"]>;

/** `window.designer.plugins` in an editor view (docs/plugins.md §3.3 "As built — main") */
export interface PluginsDesktopApi {
  listDevelopment(): Result<"plugins:list-development">;
  importManifest(): Result<"plugins:import-manifest">;
  removeDevelopment(id: string): Result<"plugins:remove-development">;
  read(id: string): Result<"plugins:read">;
  newPlugin(input: Args<"plugins:new-plugin">): Result<"plugins:new-plugin">;
  beginRun(input: Args<"plugins:begin-run">): Result<"plugins:begin-run">;
  endRun(runId: string): Result<"plugins:end-run">;
  openUi(input: Args<"plugins:open-ui">): Result<"plugins:open-ui">;
  closeUi(runId: string): Result<"plugins:close-ui">;
  fetch(input: Args<"plugins:fetch">): Result<"plugins:fetch">;
  storage(call: Args<"plugins:storage">): Result<"plugins:storage">;
  openConsole(): Result<"plugins:open-console">;
  /** A development plugin's files changed (Hot reload plugin) */
  onChanged(cb: (e: { id: string }) => void): Unsubscribe;
}

export type DesktopApi = TabBarApi | HomeApi | EditorApi;
