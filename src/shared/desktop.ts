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
  ExportPreviewRequest,
  FlushReason,
  FontIndex,
  HomeState,
  ImportResult,
  InitInfo,
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
  WindowState,
} from "./ipc";
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
  onThemeChanged(cb: (t: ThemeState) => void): Unsubscribe;
  onWindowState(cb: (s: WindowState) => void): Unsubscribe;
  onFullScreen(cb: (fullScreen: boolean) => void): Unsubscribe;
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
}

/** Native file dialogs and paths (docs/desktop.md §10.2 "Files and native dialogs"). */
export interface FilesApi {
  /** .fig files into a folder (null: Drafts): `paths` (dropped files, see pathFor), or the ones picked in the Open dialog */
  import(folderId: string | null, paths?: string[]): Promise<ImportResult>;
  /** The file as a .fig, where the Save dialog says */
  saveLocalCopy(fileKey: string): Promise<{ path: string } | { cancelled: true }>;
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
  };
  menu: ViewMenuApi;
  openExternal(url: string): void;
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
  /** Installed fonts for the engine (src/renderer/src/engine/fonts.ts reads this). */
  fonts: {
    list(): Promise<FontIndex>;
    read(id: string): Promise<Uint8Array>;
  };
}

export type DesktopApi = TabBarApi | HomeApi | EditorApi;
