import "./boot";
import { app, nativeImage, powerMonitor, session, systemPreferences } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCommandId } from "../shared/commands";
import { startAgents, stopAgents } from "./agents/host";
import { askStoreGone, asked, testAnswers } from "./dialogs";
import { startFontWatch, warmFontIndex } from "./fonts";
import { initUploadedFonts } from "./uploadedFonts";
import { checkSession, initAccount, initIdle, serverUrl, signIn, signInForTest } from "./account";
import { signInTenant } from "./account/signIn";
import { setMainFetchProxied } from "./net";
import { allowedServer, describePolicy, loadPolicy, proxied, proxySwitches } from "./policy";
import { initNotifications } from "./notifications";
import { keyFromLink } from "../shared/multiplayer/types";
import { registerIpc } from "./ipc";
import { handlePluginScheme } from "./plugins/protocol";
import { handleAimodelScheme } from "./ai/protocol";
import { initRestHelper } from "./restHelper";
import { installAppMenu } from "./menu";
import { DEV_URL, handleScheme, isAppUrl, registerScheme } from "./protocol";
import { flushStore, retryStoreHost, startStoreHost, storeClient, storeDebug } from "./storeHost";
import { initTheme } from "./theme";
import { initLocale } from "./locale";
import { initInterfaceScale } from "./interfaceScale";
import { initTroubleshooting } from "./troubleshooting";
import { initUpdater } from "./updater";
import { PRODUCT_NAME } from "./identity";
import { confirmQuit, controllers, finishQuit, frontWindow, lifecycle, type WindowController } from "./window";
import { initGate, openMain, whenOpen } from "./gate";

/**
 * Wecra's desktop side (docs/desktop-impl.md): one window of views —
 * the tab bar, Home, each open file — each its own renderer process; the
 * store, a utility process, the only writer of the workspace; main keeps
 * the tabs, the menu, the flushes and questions on closing, and what only
 * the desktop can do (native dialogs, links, the theme).
 */

// The dev server's page can't have the built page's CSP (Vite's hot reload is inline): Electron's warning about it is for the built app only.
if (DEV_URL) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

// Help › Troubleshooting › Disable Hardware Acceleration, kept from the last session: before ready.
initTroubleshooting();
registerScheme();
app.enableSandbox();

// The deployment keys (docs/desktop.md §12.5), before ready: ProxyUrl has to be a switch by then — it reaches every
// view and Electron's net, and main's own requests move to net.fetch; the store gets it through its environment.
{
  const policy = loadPolicy();
  for (const [name, value] of proxySwitches(policy)) app.commandLine.appendSwitch(name, value);
  setMainFetchProxied(proxied(policy));
  if (process.env.DESIGNER_LOG === "debug") console.log(describePolicy(policy));
  const { ignored } = allowedServer(process.env.DESIGNER_SERVER, policy);
  if (ignored) console.warn(`[policy] DESIGNER_SERVER ${ignored} isn't in AllowedOriginHosts: using ${serverUrl()}`);
}

/** The window in front (the one last focused). */
const current = (): WindowController | null => frontWindow();

/** designer://open?key=…[&node-id=…&m=dev] — a shared file's link (the server's /f/<key> page hands it over, with the
 *  frame and mode it names; docs/multiplayer.md §3). Signed out, it waits for the next sign-in (docs/desktop.md §18.6). */
let pendingLink: string | null = null;
/** designer://sign-in?tenant=… (docs/desktop.md §18.1): a sign-in through that org's SSO — the welcome page's too */
let pendingTenant: string | null = null;
function openLink(url: string) {
  if (!url.startsWith("designer:")) return;
  // The sign-in sheet's own callback (docs/desktop.md §18.6) is caught by the sheet; one reaching the app is stale.
  if (/^designer:\/\/auth\//.test(url)) return;
  const tenant = signInTenant(url);
  if (tenant) {
    if (!app.isReady()) return void (pendingTenant = tenant);
    openMain();
    return void signIn({ tenant });
  }
  const key = keyFromLink(url);
  if (!key) return;
  if (!app.isReady()) return void (pendingLink = url);
  openMain();
  // A new window's Home is still loading: the tab manager waits for it.
  whenOpen(`link:${key}`, (ctl) => setTimeout(() => ctl.tabs.openSharedLink(key, url), 0));
}

/** A .fig opened from the Finder (or dropped on the Dock icon): imported into Drafts and shown in Home — after the next
 *  sign-in when nobody is signed in (docs/desktop.md §18.6). */
const pendingFiles: string[] = [];
function openFigFile(path: string) {
  if (!/\.fig$/i.test(path)) return;
  if (!app.isReady()) return void pendingFiles.push(path);
  openMain();
  whenOpen(`fig:${path}`, (ctl) => void ctl.tabs.importFiles(null, [path]).then((r) => r.files[0] && ctl.tabs.goHome(r.files[0].fileKey)));
}
app.on("open-file", (e, path) => {
  e.preventDefault();
  openFigFile(path);
});
const linkIn = (argv: string[]) => argv.find((a) => a.startsWith("designer:"));
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient("designer", process.execPath, [join(process.cwd(), process.argv[1])]);
else app.setAsDefaultProtocolClient("designer");
app.on("open-url", (e, url) => {
  e.preventDefault();
  openLink(url);
});
{
  const first = linkIn(process.argv);
  if (first && keyFromLink(first)) pendingLink = first;
  else if (first) pendingTenant = signInTenant(first);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = linkIn(argv);
    if (link) openLink(link);
    else openMain();
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion(), copyright: "Burak Koç" });
    initTheme();
    initLocale();
    initInterfaceScale();
    handleScheme();
    handlePluginScheme();
    handleAimodelScheme();
    registerIpc();
    // A kept session the server no longer accepts is dropped (in the background; offline keeps it).
    void checkSession();
    initAccount();
    // The idle timeout: input in any view is activity (docs/desktop.md §18.2).
    initIdle();
    // What reaches the bell while the app isn't in front shows on the computer; a click opens it (docs/multiplayer.md §12).
    initNotifications((_key, link) => openLink(link));

    // While developing, the dock shows the app's icon (a packaged app has it in its bundle).
    if (DEV_URL && process.platform === "darwin") {
      const icon = join(__dirname, "../../build/icon.png");
      if (existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    }

    // The pages may use the clipboard (copy and paste of layers), go full screen (a video) and lock the pointer (scrubbing a number); nothing else.
    const allowed = (permission: string, url: string) => isAppUrl(url) && (permission === "fullscreen" || permission === "pointerLock" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
    // The microphone, for a shared file's audio conversation (docs/multiplayer.md §11): audio only, asked of macOS first.
    const microphone = (permission: string, url: string, mediaTypes?: string[]) => permission === "media" && isAppUrl(url) && !!mediaTypes?.length && mediaTypes.every((t) => t === "audio");
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const types = (details as { mediaTypes?: string[] }).mediaTypes;
      if (!microphone(permission, details.requestingUrl, types)) return callback(allowed(permission, details.requestingUrl));
      if (process.platform !== "darwin") return callback(true);
      void systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) => allowed(permission, origin) || (permission === "media" && isAppUrl(origin) && (details as { mediaType?: string }).mediaType === "audio"));
    session.defaultSession.setDevicePermissionHandler(() => false);

    // Updates (docs/desktop.md §12.6): before the menu, which shows "Check for Updates…" only when it runs.
    initUpdater();
    installAppMenu(current, Boolean(DEV_URL));
    // The store first: Home and the file tabs get their ports as their pages load.
    startStoreHost(() => {
      void askStoreGone().then((answer) => (answer === "quit" ? app.quit() : retryStoreHost()));
    });
    // The login gate (docs/desktop.md §18.6): the app window when signed in, else the welcome window (its splash
    // while the kept session is read).
    initGate();
    openMain();
    // A shared file's link and .fig files the app was started with: now, or after the sign-in.
    if (pendingLink) openLink(pendingLink);
    for (const path of pendingFiles.splice(0)) openFigFile(path);
    // Started by designer://sign-in?tenant=…
    if (pendingTenant) void signIn({ tenant: pendingTenant });
    // The agents' MCP server (127.0.0.1, a token): MCP clients and the Agents tab reach the open files through it.
    void startAgents().catch((err) => console.warn("[agents] the MCP server didn't start:", err));
    // Settings › Your uploaded fonts: their folder is scanned with the user's fonts (and watched).
    initUploadedFonts();
    // REST API requests for files the person owns, answered by a hidden editor when no one has them open (docs/multiplayer.md §16.6)
    initRestHelper();
    // The font index (a cached JSON after the first launch) is ready before the first file's editor asks for it.
    setTimeout(warmFontIndex, 1500);
    // Fonts installed or removed while the app runs reach every editor (as Figma's font helper's do).
    setTimeout(startFontWatch, 3000);

    // The Mac sleeps or locks: what the files hold goes to disk, without a question.
    const flushAll = () => void Promise.all([...controllers.values()].map((c) => c.tabs.flushQuietly())).then(flushStore);
    powerMonitor.on("suspend", flushAll);
    powerMonitor.on("lock-screen", flushAll);

    app.on("activate", () => {
      if (!current()) openMain();
    });
  });

  app.on("before-quit", () => {
    lifecycle.quitting = true;
    void stopAgents();
  });
  // No window left to settle (macOS keeps running without one): the store flushes and shuts down, then the app exits.
  app.on("will-quit", (e) => {
    e.preventDefault();
    // Uploads in flight: asked first (window.ts confirmQuit; answered once per quit)
    void confirmQuit(null).then((ok) => {
      if (ok) return finishQuit();
      lifecycle.quitting = false;
    });
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
      // Every window, the first one first (Move to New Window, New window).
      windows: () => [...controllers.values()],
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
      signInForTest,
    },
  });
}
