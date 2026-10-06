/**
 * `window.designer`: what each view's preload hands its page (contextBridge,
 * docs/desktop.md §10.3). The page never sees ipcRenderer; each role gets
 * only its own calls. Absent in a browser (`npm run web`).
 */
import type { HomeState, InitInfo, MenuCommandEvent, NativeMenuItem, OpenFile, Role, TabsSnapshot, ThemeState, WindowState } from "./ipc";
import type { TabReport } from "./tabs";
import type { GoogleCredential, ThemePreference } from "./api";

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
    newFile(): void;
  };
}

export interface HomeApi extends DesktopCommon {
  role: "home";
  tabs: {
    get(): Promise<TabsSnapshot>;
    onState(cb: (s: TabsSnapshot) => void): Unsubscribe;
    activate(id: string): void;
    reopen(): void;
  };
  nav: { openFile(file: OpenFile): Promise<{ tabId: string }> };
  home: { onState(cb: (s: HomeState) => void): Unsubscribe };
  menu: DesktopCommon["menu"] & { onCommand(cb: (c: MenuCommandEvent) => void): Unsubscribe };
  session: {
    /** The sign-in gate's state: tabs are shown only for a signed-in admin */
    auth(signedIn: boolean): void;
    requestSignOut(): void;
    /** Main settled the unsaved tabs and closed them: sign out now */
    onSignOut(cb: () => void): Unsubscribe;
  };
  signInWithGoogle(): Promise<GoogleCredential>;
  cancelSignIn(): void;
  openExternal(url: string): void;
}

export interface EditorApi extends DesktopCommon {
  role: "editor";
  tab: {
    report(r: TabReport): void;
    onVisibility(cb: (v: { visible: boolean }) => void): Unsubscribe;
    /** Main asks whether there is unsaved work, or to save it; the answer goes back as `tab:response` */
    onRequest(cb: (op: "is-dirty" | "save") => boolean | Promise<boolean>): Unsubscribe;
    close(): void;
  };
  nav: { openFile(file: OpenFile): Promise<{ tabId: string }>; goHome(): void; newFile(): void };
  menu: DesktopCommon["menu"] & { onCommand(cb: (c: MenuCommandEvent) => void): Unsubscribe };
  session: { requestSignOut(): void };
  openExternal(url: string): void;
}

export type DesktopApi = TabBarApi | HomeApi | EditorApi;
