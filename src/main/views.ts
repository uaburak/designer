import { themeArg } from "./theme";
import { localeArg } from "./locale";
import { zoomFactor } from "./interfaceScale";
import { backendQuery } from "./troubleshooting";
import { app, BrowserWindow, Menu, nativeTheme, shell, WebContentsView, type MenuItemConstructorOptions, type WebContents } from "electron";
import { join } from "node:path";
import type { Role } from "../shared/ipc";
import { VIEW_BACKGROUND } from "../shared/layout";
import { guardPluginFrames } from "./plugins/protocol";
import { DEV_URL, isAppUrl, pageUrl } from "./protocol";
import { connectStoreView } from "./storeHost";
import { getLocale, t } from "../shared/i18n";

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

/** A tab's view moved to another window (Move to New / Another Window): its IPC is that window's from now on. */
export function moveView(contents: WebContents, windowId: string): void {
  const info = registry.get(contents.id);
  if (info) registry.set(contents.id, { ...info, windowId });
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
      // Prototypes' videos start by themselves, with sound when their Prototype › Video says so (a prototype tab opens
      // without a click in its own page; Figma's desktop app plays them).
      ...(role === "editor" ? { autoplayPolicy: "no-user-gesture-required" as const } : {}),
      // View › Interface Scale (interfaceScale.ts): a new view starts at it.
      zoomFactor: zoomFactor(),
      v8CacheOptions: "bypassHeatCheck",
      // The theme before the first paint (boot.js reads it from the preload): preference and what it resolves to.
      additionalArguments: [`--designer-role=${role}`, `--designer-version=${app.getVersion()}`, `--designer-theme=${themeArg()}`, `--designer-locale=${localeArg()}`],
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
  void contents.loadURL(pageUrl(role === "editor" ? { ...query, ...backendQuery() } : query)).catch(() => {
    /* a load cut short (the view closed while loading) */
  });
  return view;
}

/**
 * The inline preview popped out (InlinePreview.tsx): an editor's own blank window, its page put there by the editor
 * (a React portal — the same document, the same prototype engine, no second load), a window of its own on the desktop.
 */
export const PREVIEW_WINDOW = "wecra-preview";

/** Each editor's preview window (by the editor's webContents id). */
const previewWindows = new Map<number, BrowserWindow>();

/** The preview window keeps the device's proportions as the user resizes it (null: free) — `preview:aspect`. */
export function previewAspect(editor: WebContents, aspect: { ratio: number; extraHeight: number } | null): void {
  const win = previewWindows.get(editor.id);
  if (!win || win.isDestroyed()) return;
  win.setAspectRatio(aspect ? aspect.ratio : 0, aspect ? { width: 0, height: Math.round(aspect.extraHeight) } : undefined);
}

/**
 * Over the app's own windows only: on top while Wecra is the active app, a window like any other once another app is
 * (it doesn't float over Claude Code or a browser).
 */
function onTopOfAppOnly(win: BrowserWindow): void {
  const raise = () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(true, "floating");
  };
  const lower = () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false);
  };
  // Elsewhere than the Mac: a window of the app focused or none.
  const blur = () => setTimeout(() => (BrowserWindow.getFocusedWindow() ? raise() : lower()), 0);
  if (process.platform === "darwin") {
    app.on("did-become-active", raise);
    app.on("did-resign-active", lower);
  } else {
    app.on("browser-window-focus", raise);
    app.on("browser-window-blur", blur);
  }
  win.once("closed", () => {
    app.off("did-become-active", raise);
    app.off("did-resign-active", lower);
    app.off("browser-window-focus", raise);
    app.off("browser-window-blur", blur);
  });
  raise();
}

function harden(contents: WebContents) {
  // Links out of the app open in the browser; the view itself never leaves the app (a file dropped outside the canvas, a stray link).
  contents.setWindowOpenHandler(({ url, frameName }) => {
    // `-device`: the device itself is the window (its frame a picture) — frameless, transparent around the device.
    const device = frameName === `${PREVIEW_WINDOW}-device`;
    if (url === "about:blank" && (frameName === PREVIEW_WINDOW || device) && viewOf(contents)?.role === "editor")
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: t("Preview"),
          minWidth: 160,
          minHeight: 160,
          backgroundColor: device ? "#00000000" : backgroundOf("editor"),
          ...(device ? { frame: false, transparent: true, hasShadow: false } : {}),
          autoHideMenuBar: true,
          // Over the app's windows (a click on the canvas doesn't send it behind) — not over other apps' (onTopOfAppOnly).
          alwaysOnTop: true,
          // It plays while the editor's window is behind it or minimised.
          webPreferences: { backgroundThrottling: false },
        },
      };
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The preview's window is the editor's page only: it opens nothing, goes nowhere, and closes with its editor.
  contents.on("did-create-window", (win) => {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    // A floating panel's level over the app's windows (also in full screen) while Wecra is the active app.
    if (win.isAlwaysOnTop()) onTopOfAppOnly(win);
    previewWindows.get(contents.id)?.close();
    previewWindows.set(contents.id, win);
    const close = () => {
      if (!win.isDestroyed()) win.close();
    };
    contents.once("destroyed", close);
    contents.once("did-navigate", close);
    win.once("closed", () => {
      if (previewWindows.get(contents.id) === win) previewWindows.delete(contents.id);
      contents.off("destroyed", close);
      contents.off("did-navigate", close);
    });
  });
  contents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  contents.on("will-attach-webview", (e) => e.preventDefault());
  // Subframes are plugin UIs only, going where their run's manifest allows (docs/plugins.md §3.2).
  guardPluginFrames(contents);

  // Text fields get the system's menu (spelling, cut, copy, paste); the editor's own right click is the editor's.
  contents.on("context-menu", (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const items: MenuItemConstructorOptions[] = params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }));
    if (params.misspelledWord) items.push({ label: t("Add to Dictionary"), click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
    else if (items.length) items.push({ type: "separator" });
    // Electron's role items are English: another language names them itself.
    const role = (r: "cut" | "copy" | "paste" | "selectAll", label: string, enabled?: boolean): MenuItemConstructorOptions => ({ role: r, ...(getLocale() === "en" ? {} : { label: t(label) }), ...(enabled === undefined ? {} : { enabled }) });
    if (params.isEditable) items.push(role("cut", "Cut", params.editFlags.canCut), role("copy", "Copy", params.editFlags.canCopy), role("paste", "Paste", params.editFlags.canPaste), { type: "separator" }, role("selectAll", "Select All"));
    else items.push(role("copy", "Copy", params.editFlags.canCopy));
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
