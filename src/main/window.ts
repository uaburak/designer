import { app, BaseWindow, nativeTheme, screen, type WebContentsView } from "electron";
import type { WindowState } from "../shared/ipc";
import { CAPTION_OVERLAY, DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, TABBAR_HEIGHT, TRAFFIC_LIGHT_POSITION } from "../shared/layout";
import { emptyTabs, persistable, restoreTabs } from "../shared/tabs";
import { flushSession, readSession, writeSession, type WindowBounds, type WindowSession } from "./session";
import { flushStore, stopStoreHost } from "./storeHost";
import { drainGovernanceReportsWithin } from "./account/governanceReports";
import { emit, TabManager } from "./tabs";
import { exitForUpdate } from "./updater";
import { backgroundOf, createView, destroyView } from "./views";

/**
 * A window (docs/desktop.md §2): a BaseWindow — no page of its own under the
 * views — with the tab bar's view on top (38px; the traffic lights in its
 * left 80px) and the content views under it (Home, each open file), all the
 * window's width. Its place and its tabs are kept in session.json.
 */

export const lifecycle = { quitting: false };

let finishing: Promise<void> | null = null;

/**
 * The end of a quit, once every window's files have flushed (docs/desktop.md
 * §6): the store flushes and shuts down (lock released), session.json is
 * written, and the app exits. Explicit, because a second `app.quit()` after
 * a cancelled one is ignored on some paths (a SIGTERM's).
 */
export function finishQuit(): Promise<void> {
  // Governance+ reports still waiting (MCP calls, AI prompts) go first: they read the store (a file's org); at most 2 s.
  finishing ??= drainGovernanceReportsWithin()
    .then(() => stopStoreHost())
    .finally(() => {
      flushSession();
      // "Restart to update" (docs/desktop.md §12.6): the updater installs and opens the app again instead.
      if (!exitForUpdate()) app.exit(0);
    });
  return finishing;
}

export const controllers = new Map<string, WindowController>();

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#2c2c2c" : "#ffffff");
/** Windows: the system's caption buttons over the tab bar's right end, in its colours (no 1px line under them) */
const captionOverlay = () => ({ ...CAPTION_OVERLAY[nativeTheme.shouldUseDarkColors ? "dark" : "light"], height: TABBAR_HEIGHT - 1 });
/** macOS: the traffic lights inset in the tab bar; Windows: no title bar, the caption buttons drawn over it */
const chrome = () =>
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } }
    : { titleBarStyle: "hidden" as const, titleBarOverlay: captionOverlay() };

/** A saved place still on one of the screens — its top edge on a display, enough of it to grab (a display may be gone since). */
function onScreen({ x, y, width }: WindowBounds) {
  if (x === undefined || y === undefined) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => x < a.x + a.width - 80 && x + width > a.x + 80 && y >= a.y - 8 && y < a.y + a.height - 40);
}

export class WindowController {
  readonly id: string;
  readonly win: BaseWindow;
  readonly tabbar: WebContentsView;
  readonly tabs: TabManager;
  private bounds: WindowBounds;
  private closeAllowed = false;
  private closing = false;
  private shown = false;
  private shownListeners: (() => void)[] = [];
  /** Logged out (docs/desktop.md §18.6): its tabs aren't kept for the next person */
  private signedOut = false;
  private ready = { tabbar: false, content: false };

  constructor(saved?: WindowSession) {
    this.id = saved?.id ?? "main";
    const bounds: WindowBounds = saved?.bounds && typeof saved.bounds.width === "number" ? saved.bounds : { ...DEFAULT_WINDOW_SIZE };
    const placed = onScreen(bounds);
    this.bounds = bounds;
    this.win = new BaseWindow({
      width: Math.max(bounds.width, MIN_WINDOW_SIZE.width),
      height: Math.max(bounds.height, MIN_WINDOW_SIZE.height),
      ...(placed ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height,
      show: false,
      title: "Designer",
      ...chrome(),
      backgroundColor: windowBackground(),
    });
    controllers.set(this.id, this);
    this.bounds = this.win.getBounds();
    if (saved?.maximized) this.win.maximize();

    this.tabbar = createView("tabbar", this.id, null, { tabbar: "" });
    this.win.contentView.addChildView(this.tabbar);
    // Its renderer gone: back at once (it holds nothing of its own).
    this.tabbar.webContents.on("render-process-gone", (_e, details) => {
      if (details.reason !== "clean-exit") this.tabbar.webContents.reload();
    });

    const state = restoreTabs(saved ? { tabs: saved.tabs, active: saved.activeTabId, closed: saved.closed } : null);
    this.tabs = new TabManager(this, state);
    this.layout();

    // Live, as the window is dragged larger (macOS sends resize all along); maximize and full screen send it too.
    this.win.on("resize", () => this.layout());
    const changed = () => {
      this.layout();
      this.sendWindowState();
      this.tabs.push();
      this.persist();
    };
    this.win.on("enter-full-screen", changed);
    this.win.on("leave-full-screen", changed);
    this.win.on("focus", () => this.sendWindowState());
    this.win.on("blur", () => this.sendWindowState());
    const remember = () => {
      if (this.win.isDestroyed() || this.win.isFullScreen() || this.win.isMinimized() || this.win.isMaximized()) return this.persist();
      this.bounds = this.win.getBounds();
      this.persist();
    };
    this.win.on("resized", remember);
    this.win.on("moved", remember);
    this.win.on("maximize", remember);
    this.win.on("unmaximize", remember);

    // Closing: the unsaved tabs first (native questions), then the window.
    this.win.on("close", (e) => {
      if (this.closeAllowed) return;
      e.preventDefault();
      void this.requestClose();
    });
    this.win.on("closed", () => {
      flushSession();
      this.tabs.destroy();
      destroyView(this.tabbar);
      controllers.delete(this.id);
    });

    // Shown once the tab bar and the content in front have painted — or after 1.5s whatever they do.
    setTimeout(() => this.showWindow(), 1500);
    this.tabs.start();
  }

  /** The content views' place: under the tab bar, the window's width. */
  contentBounds() {
    const { width, height } = this.win.getContentBounds();
    return { x: 0, y: TABBAR_HEIGHT, width, height: Math.max(0, height - TABBAR_HEIGHT) };
  }

  /** Every view placed — the hidden ones too, so a switch never resizes (and re-renders) the one coming forward. */
  layout() {
    if (this.win.isDestroyed()) return;
    const { width } = this.win.getContentBounds();
    this.tabbar.setBounds({ x: 0, y: 0, width, height: TABBAR_HEIGHT });
    const content = this.contentBounds();
    for (const view of this.tabs.contentViews()) view.setBounds(content);
  }

  windowState(): WindowState {
    return { fullScreen: this.win.isFullScreen(), focused: this.win.isFocused() };
  }

  /** Every view told (the tab bar drops the traffic lights' room in full screen). */
  private sendWindowState() {
    if (this.win.isDestroyed()) return;
    const state = this.windowState();
    for (const view of [this.tabbar, ...this.tabs.contentViews()]) emit(view.webContents, "window:state", state);
  }

  /** `shell:ready` from the tab bar, or a content view loaded (which also starts the spare editor's clock, docs/desktop.md §3.1). */
  markReady(part: "tabbar" | "content") {
    this.ready[part] = true;
    if (part === "content") this.tabs.contentReady();
    if (this.ready.tabbar && this.ready.content) this.showWindow();
  }

  /** A content view came in front: the window shows once its page is there. */
  contentShown(view: WebContentsView) {
    if (this.ready.content) return;
    const contents = view.webContents;
    if (!contents.isLoading()) return this.markReady("content");
    contents.once("did-finish-load", () => this.markReady("content"));
  }

  private showWindow() {
    if (this.shown || this.win.isDestroyed()) return;
    this.shown = true;
    this.win.show();
    this.tabs.activeView().webContents.focus();
    for (const l of this.shownListeners.splice(0)) l();
  }

  /** Resolves once the window is on screen (the welcome window it replaces closes then, docs/desktop.md §18.6). */
  whenShown(): Promise<void> {
    if (this.shown) return Promise.resolve();
    return new Promise((resolve) => this.shownListeners.push(resolve));
  }

  /** The place it has (or would have) on screen: the welcome window that replaces it takes it */
  placement(): WindowBounds {
    return this.win.isDestroyed() ? this.bounds : this.win.getBounds();
  }

  /**
   * Logged out (docs/desktop.md §18.6): every open file flushed, the store's too, then the window closed without
   * questions — every file tab with it, none kept in session.json (nor the closed tabs), so the next sign-in starts at
   * Home. The local files stay on disk. Log out's own questions came first (`settleAll`, the gate's sign-out guard).
   */
  async closeForSignOut(): Promise<void> {
    if (this.win.isDestroyed() || this.closeAllowed) return;
    this.signedOut = true;
    await this.tabs.flushQuietly().catch(() => {});
    await flushStore();
    this.closeAllowed = true;
    this.persist();
    flushSession();
    if (!this.win.isDestroyed()) this.win.close();
  }

  /**
   * Leaving an account for another (docs/desktop.md §18.7; its own questions came first, `settleAll`): every open file
   * flushed, the store's too, then every file tab closed and the closed tabs forgotten — the files belong to the account
   * being left. The window stays; Home reloads once the next account is in (`accountArrived`).
   */
  async leaveAccount(): Promise<void> {
    if (this.win.isDestroyed()) return;
    await this.tabs.flushQuietly().catch(() => {});
    await flushStore();
    this.tabs.dispatch({ type: "reset" });
    flushSession();
  }

  /** The next account is current (the store has its session): Home starts again for it. */
  accountArrived(): void {
    if (this.win.isDestroyed()) return;
    this.tabs.reloadHome();
  }

  /** The theme changed: each view's colour before its page paints. */
  themeChanged() {
    if (this.win.isDestroyed()) return;
    this.win.setBackgroundColor(windowBackground());
    if (process.platform !== "darwin") this.win.setTitleBarOverlay(captionOverlay());
    this.tabbar.setBackgroundColor(backgroundOf("tabbar"));
    this.tabs.home.setBackgroundColor(backgroundOf("home"));
    for (const view of this.tabs.contentViews()) if (view !== this.tabs.home) view.setBackgroundColor(backgroundOf("editor"));
  }

  /** Closing asked (the red button, ⌘Q): unsaved tabs settled first. */
  async requestClose() {
    if (this.closing) return;
    this.closing = true;
    try {
      const ok = await this.tabs.settleAll(lifecycle.quitting ? "quit" : "close");
      if (!ok) {
        lifecycle.quitting = false;
        return;
      }
      this.closeAllowed = true;
      this.persist();
      flushSession();
      // Quitting: the other windows (v1 has none) close with the app.
      if (lifecycle.quitting) void finishQuit();
      else this.win.close();
    } finally {
      this.closing = false;
    }
  }

  session(): WindowSession {
    const kept = persistable(this.signedOut ? emptyTabs() : this.tabs.state);
    return {
      id: this.id,
      bounds: this.bounds,
      maximized: !this.win.isDestroyed() && this.win.isMaximized(),
      fullScreen: !this.win.isDestroyed() && this.win.isFullScreen(),
      tabs: kept.tabs,
      activeTabId: kept.active,
      closed: kept.closed,
    };
  }

  persist() {
    writeSession({ version: 1, windows: [...controllers.values()].map((c) => c.session()) });
  }
}

/** The first window of the saved session (v1 opens one); `bounds`: where the welcome window it replaces was. */
export function openWindow(bounds?: WindowBounds): WindowController {
  const saved = readSession().windows[0];
  if (!bounds) return new WindowController(saved);
  const tabs = persistable(restoreTabs(saved ? { tabs: saved.tabs, active: saved.activeTabId, closed: saved.closed } : null));
  return new WindowController({ id: saved?.id ?? "main", maximized: saved?.maximized ?? false, fullScreen: false, tabs: tabs.tabs, activeTabId: tabs.active, closed: tabs.closed, bounds });
}

/** Where the saved session's window was (the welcome window opens there) */
export const savedBounds = (): WindowBounds | undefined => readSession().windows[0]?.bounds;
