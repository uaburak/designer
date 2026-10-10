import { app, nativeImage, powerMonitor, session } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCommandId } from "../shared/commands";
import { startAgents, stopAgents } from "./agents/host";
import { askStoreGone, asked, testAnswers } from "./dialogs";
import { startFontWatch, warmFontIndex } from "./fonts";
import { registerIpc } from "./ipc";
import { installAppMenu } from "./menu";
import { DEV_URL, handleScheme, isAppUrl, registerScheme } from "./protocol";
import { flushStore, retryStoreHost, startStoreHost, storeClient, storeDebug } from "./storeHost";
import { initTheme } from "./theme";
import { controllers, finishQuit, lifecycle, openWindow, type WindowController } from "./window";

/**
 * DesignerV2's desktop side (docs/desktop-impl.md): one window of views —
 * the tab bar, Home, each open file — each its own renderer process; the
 * store, a utility process, the only writer of the workspace; main keeps
 * the tabs, the menu, the flushes and questions on closing, and what only
 * the desktop can do (native dialogs, links, the theme).
 */

// The dev server's page can't have the built page's CSP (Vite's hot reload is inline): Electron's warning about it is for the built app only.
if (DEV_URL) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

registerScheme();
app.enableSandbox();

// A run of its own (scripts/drive.mjs): its workspace, its windows — not the everyday app's.
if (process.env.DESIGNER_USER_DATA) app.setPath("userData", process.env.DESIGNER_USER_DATA);

/** The window in front (v1 has one). */
const current = (): WindowController | null => [...controllers.values()][0] ?? null;

function windowOrNew() {
  const ctl = current();
  if (!ctl) return openWindow();
  if (ctl.win.isMinimized()) ctl.win.restore();
  ctl.win.focus();
  return ctl;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void windowOrNew());

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "DesignerV2", applicationVersion: app.getVersion(), copyright: "Burak Koç" });
    initTheme();
    handleScheme();
    registerIpc();


    // While developing, the dock shows the app's icon (a packaged app has it in its bundle).
    if (DEV_URL && process.platform === "darwin") {
      const icon = join(__dirname, "../../build/icon.png");
      if (existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    }

    // The pages may use the clipboard (copy and paste of layers), go full screen (a video) and lock the pointer (scrubbing a number); nothing else.
    const allowed = (permission: string, url: string) => isAppUrl(url) && (permission === "fullscreen" || permission === "pointerLock" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin));
    session.defaultSession.setDevicePermissionHandler(() => false);

    installAppMenu(current, Boolean(DEV_URL));
    // The store first: Home and the file tabs get their ports as their pages load.
    startStoreHost(() => {
      void askStoreGone().then((answer) => (answer === "quit" ? app.quit() : retryStoreHost()));
    });
    openWindow();
    // The agents' MCP server (127.0.0.1, a token): MCP clients and the Agents tab reach the open files through it.
    void startAgents().catch((err) => console.warn("[agents] the MCP server didn't start:", err));
    // The font index (a cached JSON after the first launch) is ready before the first file's editor asks for it.
    setTimeout(warmFontIndex, 1500);
    // Fonts installed or removed while the app runs reach every editor (as Figma's font helper's do).
    setTimeout(startFontWatch, 3000);

    // The Mac sleeps or locks: what the files hold goes to disk, without a question.
    const flushAll = () => void Promise.all([...controllers.values()].map((c) => c.tabs.flushQuietly())).then(flushStore);
    powerMonitor.on("suspend", flushAll);
    powerMonitor.on("lock-screen", flushAll);

    app.on("activate", () => {
      if (!current()) openWindow();
    });
  });

  app.on("before-quit", () => {
    lifecycle.quitting = true;
    void stopAgents();
  });
  // No window left to settle (macOS keeps running without one): the store flushes and shuts down, then the app exits.
  app.on("will-quit", (e) => {
    e.preventDefault();
    void finishQuit();
  });
  // macOS: closing the window doesn't quit (the Dock brings it back).
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || lifecycle.quitting) app.quit();
  });
}

// Under test (scripts/drive.mjs, DESIGNER_TEST=1): the window's tabs, views and processes, and the menu's click path, for app.evaluate().
if (process.env.DESIGNER_TEST === "1") {
  Object.assign(globalThis, {
    __designer: {
      current,
      debug: () => current()?.tabs.debug() ?? null,
      command: (id: string) => {
        if (!isCommandId(id)) return `unknown command ${id}`;
        current()?.tabs.command(id, "menu", null);
        return "ok";
      },
      answers: testAnswers,
      asked,
      store: storeDebug,
      storeClient,
    },
  });
}
