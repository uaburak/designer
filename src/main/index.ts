import { app, Menu, nativeImage, session } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCommandId } from "../shared/commands";
import { asked, testAnswers } from "./dialogs";
import { registerIpc } from "./ipc";
import { appMenu } from "./menu";
import { DEV_URL, handleScheme, isAppUrl, registerScheme } from "./protocol";
import { flushSession } from "./session";
import { initTheme } from "./theme";
import { controllers, lifecycle, openWindow, type WindowController } from "./window";

/**
 * DesignerV2's desktop side (docs/desktop-impl.md): one window of views —
 * the tab bar, Home, each open file — each its own renderer process; main
 * keeps the tabs, the menu, the questions about unsaved work, and what only
 * the desktop can do (the Google sign-in in the browser, links, the theme).
 */

// The dev server's page can't have the built page's CSP (Vite's hot reload is inline): Electron's warning about it is for the built app only.
if (DEV_URL) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

registerScheme();
app.enableSandbox();

// A run of its own (scripts/drive.mjs): its sign-in, its demo data, its window — not the everyday app's.
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
    app.setAboutPanelOptions({ applicationName: "DesignerV2", applicationVersion: app.getVersion(), copyright: "burakkoc.net" });
    initTheme();
    handleScheme();
    registerIpc();

    // The bucket's files are public, but it sends no CORS header for them: the editor's export couldn't read the pictures it
    // embeds (inline.ts). The app may — a read of a public file, never a write (uploads have Storage's own CORS). Legacy data layer.
    session.defaultSession.webRequest.onHeadersReceived({ urls: ["https://firebasestorage.googleapis.com/*"] }, (details, callback) => {
      const headers = details.responseHeaders ?? {};
      if (details.method === "GET" && !Object.keys(headers).some((h) => h.toLowerCase() === "access-control-allow-origin")) headers["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders: headers });
    });

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

    Menu.setApplicationMenu(appMenu(current, Boolean(DEV_URL)));
    openWindow();

    app.on("activate", () => {
      if (!current()) openWindow();
    });
  });

  app.on("before-quit", () => {
    lifecycle.quitting = true;
  });
  app.on("will-quit", () => flushSession());
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
    },
  });
}
