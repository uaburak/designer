import { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, screen, session, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GoogleCredential, SignInResult, ThemePreference } from "../shared/api";
import { appMenu } from "./menu";
import { cancelSignIn, signInWithGoogle } from "./signIn";

/**
 * DesignerV2's desktop side: one window — its tab bar, the home, the open
 * files are all the page's (the renderer) — and what only the desktop can do:
 * the menu, closing with unsaved work, the Google sign-in in the browser,
 * links in the browser, the theme of the window's chrome.
 */

/** The built app is served from app://designer (a secure origin of its own: storage, the sign-in, fetch work as on the web). */
const SCHEME = "app";
const APP_ORIGIN = `${SCHEME}://designer`;
/** electron-vite's dev server, while developing */
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
// The dev server's page can't have the built page's CSP (Vite's hot reload is inline): Electron's warning about it is for the built app only.
if (DEV_URL) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
const RENDERER_DIR = join(__dirname, "../renderer");

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// A run of its own (scripts/drive.mjs): its sign-in, its demo data, its window — not the everyday app's.
if (process.env.DESIGNER_USER_DATA) app.setPath("userData", process.env.DESIGNER_USER_DATA);

/**
 * What the built page may load (it has no CSP of its own): its own files;
 * pictures, video, embeds and Firebase from the web; inline styles (React's
 * and the editor's). Nothing evaluated, no plugins.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/** The window's background before the page paints: the home's. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#2c2c2c" : "#ffffff");

const isAppUrl = (url: string) => {
  try {
    const { origin, protocol: scheme } = new URL(url);
    return DEV_URL ? origin === new URL(DEV_URL).origin : scheme === `${SCHEME}:`;
  } catch {
    return false;
  }
};

// ── Where the window was ──────────────────────────────────────────────────────

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  theme?: ThemePreference;
}

const statePath = () => join(app.getPath("userData"), "window.json");

function readState(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(statePath(), "utf8")) as WindowState;
    if (typeof saved.width === "number" && typeof saved.height === "number") return saved;
  } catch {
    /* the first launch */
  }
  return { width: 1440, height: 900 };
}

function writeState(next: WindowState) {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(next));
  } catch (err) {
    console.warn("The window's place couldn't be kept:", err);
  }
}

/** A saved place still on one of the screens — its top edge on a display, enough of it to grab (a display may be gone since). */
function onScreen({ x, y, width }: WindowState) {
  if (x === undefined || y === undefined) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => x < a.x + a.width - 80 && x + width > a.x + 80 && y >= a.y - 8 && y < a.y + a.height - 40);
}

// ── The window ────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;
/** The page asks before the window closes (it has tabs open) */
let closeGuard = false;
/** The page said the window may close */
let closeAllowed = false;
/** ⌘Q is under way: once the page lets the window close, the app quits */
let quitting = false;

function createWindow() {
  const state = readState();
  if (state.theme) nativeTheme.themeSource = state.theme;
  const placed = onScreen(state);
  win = new BrowserWindow({
    width: Math.max(state.width, 800),
    height: Math.max(state.height, 520),
    ...(placed ? { x: state.x, y: state.y } : {}),
    minWidth: 800,
    minHeight: 520,
    show: false,
    title: "DesignerV2",
    titleBarStyle: "hiddenInset",
    // The traffic lights in the middle of the 40px tab bar.
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: background(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--designer-version=${app.getVersion()}`],
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());

  const remember = () => {
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? readState() : { ...readState(), ...win.getBounds() };
    writeState({ ...bounds, maximized });
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("maximize", remember);
  win.on("unmaximize", remember);

  win.on("enter-full-screen", () => win?.webContents.send("window:fullscreen", true));
  win.on("leave-full-screen", () => win?.webContents.send("window:fullscreen", false));

  // Closing with tabs open: the page decides (it asks about unsaved files), then calls window:close.
  win.on("close", (e) => {
    if (!win || !closeGuard || closeAllowed) return;
    e.preventDefault();
    win.webContents.send("window:close-requested");
  });
  win.on("closed", () => {
    win = null;
    closeGuard = false;
    closeAllowed = false;
  });

  const contents = win.webContents;
  // A page loading again (a reload) says again whether it guards the closing.
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeGuard = false;
  });
  contents.on("render-process-gone", () => {
    closeGuard = false;
  });
  // Links out of the app open in the browser; the window itself never leaves the app (a file dropped outside the canvas, a stray link).
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // Text fields get the system's menu (spelling, cut, copy, paste); the editor's own right click is the editor's.
  contents.on("context-menu", (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const items: MenuItemConstructorOptions[] = params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }));
    if (params.misspelledWord) items.push({ label: "Add to Dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
    else if (items.length) items.push({ type: "separator" });
    if (params.isEditable) items.push({ role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy }, { role: "paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
    else items.push({ role: "copy", enabled: params.editFlags.canCopy });
    Menu.buildFromTemplate(items).popup({ window: win ?? undefined });
  });

  // While developing, the page's warnings and errors (its tabs' too) come out in the terminal.
  if (DEV_URL) {
    contents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error") console.log(`[page ${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
  }

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
}

// ── What the page asks ────────────────────────────────────────────────────────

ipcMain.handle("auth:google", async (): Promise<SignInResult> => {
  let credential: GoogleCredential;
  try {
    credential = await signInWithGoogle();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === "cancelled" ? { cancelled: true } : { error: message };
  }
  // Back to the app from the browser.
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (process.platform === "darwin") app.focus({ steal: true });
  return { credential };
});
ipcMain.on("auth:cancel", () => cancelSignIn());

ipcMain.on("shell:open-external", (_e, url: unknown) => {
  if (typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
});

ipcMain.on("theme:set", (_e, theme: unknown) => {
  if (theme !== "system" && theme !== "light" && theme !== "dark") return;
  nativeTheme.themeSource = theme;
  writeState({ ...readState(), theme });
  win?.setBackgroundColor(background());
});

ipcMain.on("window:guard", (e, on: unknown) => {
  if (win && e.sender === win.webContents) closeGuard = on === true;
});
ipcMain.on("window:close", (e) => {
  if (!win || e.sender !== win.webContents) return;
  closeAllowed = true;
  if (quitting) app.quit();
  else win.close();
});
ipcMain.on("window:close-cancel", () => {
  quitting = false;
});
ipcMain.handle("window:is-fullscreen", () => Boolean(win?.isFullScreen()));

// ── The app ───────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "DesignerV2", applicationVersion: app.getVersion(), copyright: "burakkoc.net" });

    // The built page, from the app's own files only — its pages with the CSP.
    protocol.handle(SCHEME, async (request) => {
      const { pathname } = new URL(request.url);
      const file = normalize(join(RENDERER_DIR, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
      if (!file.startsWith(RENDERER_DIR + sep)) return new Response("Not found", { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      if (!file.endsWith(".html")) return res;
      const headers = new Headers(res.headers);
      headers.set("Content-Security-Policy", CSP);
      return new Response(res.body, { status: res.status, headers });
    });

    // The bucket's files are public, but it sends no CORS header for them: the editor's export couldn't read the pictures it
    // embeds (inline.ts). The app may — a read of a public file, never a write (uploads have Storage's own CORS).
    session.defaultSession.webRequest.onHeadersReceived({ urls: ["https://firebasestorage.googleapis.com/*"] }, (details, callback) => {
      const headers = details.responseHeaders ?? {};
      if (details.method === "GET" && !Object.keys(headers).some((h) => h.toLowerCase() === "access-control-allow-origin")) headers["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders: headers });
    });

    // While developing, the dock shows the app's icon (a packaged app has it in its bundle).
    if (DEV_URL && process.platform === "darwin") {
      const icon = join(__dirname, "../../build/icon.png");
      if (existsSync(icon)) app.dock?.setIcon(icon);
    }

    // The page may use the clipboard (copy and paste of layers) and go full screen (a video); nothing else.
    const allowed = (permission: string, url: string) => permission === "fullscreen" || ((permission === "clipboard-read" || permission === "clipboard-sanitized-write") && isAppUrl(url));
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin));

    Menu.setApplicationMenu(appMenu(() => win, Boolean(DEV_URL)));
    nativeTheme.on("updated", () => win?.setBackgroundColor(background()));
    createWindow();

    app.on("activate", () => {
      if (!win) createWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || quitting) app.quit();
  });
}
