import { app, Menu, nativeTheme, shell, WebContentsView, type MenuItemConstructorOptions, type WebContents } from "electron";
import { join } from "node:path";
import type { Role } from "../shared/ipc";
import { VIEW_BACKGROUND } from "../shared/layout";
import { DEV_URL, isAppUrl, pageUrl } from "./protocol";
import { connectStoreView } from "./storeHost";

/**
 * Every view of a window is made here (docs/desktop.md §3): its own
 * WebContentsView — its own renderer process — sandboxed, isolated, no Node,
 * the role's own preload; links out go to the browser, the view never leaves
 * the app; text fields get the system's menu.
 *
 * The registry says, for any webContents, which view it is: IPC is checked
 * against it (src/main/ipc.ts).
 */

export interface ViewInfo {
  role: Role;
  windowId: string;
  /** The file tab it shows (editor) */
  tabId: string | null;
  /** The workspace file it shows (a `file` tab's editor) */
  fileKey: string | null;
}

const registry = new Map<number, ViewInfo>();

export const viewOf = (contents: WebContents): ViewInfo | undefined => registry.get(contents.id);
export const allViews = () => [...registry.entries()];

/**
 * The spare editor adopted for a tab (docs/desktop.md §3.1): from now on IPC
 * from this view is the tab's, and `desktop:init` answers the tab and file —
 * before `tab:attach` is sent, so a page that initialises after the adoption
 * learns its file either way.
 */
export function adoptView(contents: WebContents, tabId: string, fileKey: string): void {
  const info = registry.get(contents.id);
  if (!info) return;
  registry.set(contents.id, { ...info, tabId, fileKey });
}

export const backgroundOf = (role: Role) => VIEW_BACKGROUND[role][nativeTheme.shouldUseDarkColors ? "dark" : "light"];

export function createView(role: Role, windowId: string, tabId: string | null, query: Record<string, string>, fileKey: string | null = null): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, `../preload/${role}.js`),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: role !== "tabbar",
      backgroundThrottling: true,
      v8CacheOptions: "bypassHeatCheck",
      // The theme before the first paint (boot.js reads it from the preload): preference and what it resolves to.
      additionalArguments: [`--designer-role=${role}`, `--designer-version=${app.getVersion()}`, `--designer-theme=${nativeTheme.themeSource}:${nativeTheme.shouldUseDarkColors ? "dark" : "light"}`],
    },
  });
  view.setBackgroundColor(backgroundOf(role));
  const contents = view.webContents;
  const id = contents.id;
  registry.set(id, { role, windowId, tabId, fileKey });
  contents.once("destroyed", () => registry.delete(id));
  harden(contents);
  // Home and editors talk to the store over a port of their own, a new one on every load.
  if (role === "home" || role === "editor") connectStoreView(contents, role);
  void contents.loadURL(pageUrl(query)).catch(() => {
    /* a load cut short (the view closed while loading) */
  });
  return view;
}

function harden(contents: WebContents) {
  // Links out of the app open in the browser; the view itself never leaves the app (a file dropped outside the canvas, a stray link).
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());

  // Text fields get the system's menu (spelling, cut, copy, paste); the editor's own right click is the editor's.
  contents.on("context-menu", (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const items: MenuItemConstructorOptions[] = params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }));
    if (params.misspelledWord) items.push({ label: "Add to Dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
    else if (items.length) items.push({ type: "separator" });
    if (params.isEditable) items.push({ role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy }, { role: "paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
    else items.push({ role: "copy", enabled: params.editFlags.canCopy });
    Menu.buildFromTemplate(items).popup();
  });

  // While developing (and under test), the page's warnings and errors come out in the terminal.
  if (DEV_URL || process.env.DESIGNER_TEST === "1") {
    contents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error") console.log(`[${viewOf(contents)?.role ?? "view"} ${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
  }
}

/** A view's renderer gone for good: its webContents closed (a WebContentsView doesn't close it by itself). */
export function destroyView(view: WebContentsView) {
  const contents = view.webContents;
  if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
}
