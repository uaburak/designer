import { app, BaseWindow, nativeTheme, screen, type WebContentsView } from "electron";
import type { WindowState } from "../shared/ipc";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, TABBAR_HEIGHT, TRAFFIC_LIGHT_POSITION } from "../shared/layout";
import { persistable, restoreTabs } from "../shared/tabs";
import { flushSession, readSession, writeSession, type WindowBounds, type WindowSession } from "./session";
import { emit, TabManager } from "./tabs";
import { backgroundOf, createView, destroyView } from "./views";

/**
 * A window (docs/desktop.md §2): a BaseWindow — no page of its own under the
 * views — with the tab bar's view on top (38px; the traffic lights in its
 * left 80px) and the content views under it (Home, each open file), all the
 * window's width. Its place and its tabs are kept in session.json.
 */

export const lifecycle = { quitting: false };

export const controllers = new Map<string, WindowController>();

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#2c2c2c" : "#ffffff");

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
      title: "DesignerV2",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
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

  /** `shell:ready` from the tab bar, or a content view loaded. */
  markReady(part: "tabbar" | "content") {
    this.ready[part] = true;
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
  }

  /** The theme changed: each view's colour before its page paints. */
  themeChanged() {
    if (this.win.isDestroyed()) return;
    this.win.setBackgroundColor(windowBackground());
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
      if (lifecycle.quitting) app.quit();
      else this.win.close();
    } finally {
      this.closing = false;
    }
  }

  session(): WindowSession {
    const kept = persistable(this.tabs.state);
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

/** The first window of the saved session (v1 opens one). */
export function openWindow(): WindowController {
  const saved = readSession().windows[0];
  return new WindowController(saved);
}
