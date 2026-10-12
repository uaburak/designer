import { BaseWindow, nativeTheme, type WebContentsView } from "electron";
import { CAPTION_OVERLAY, DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, TABBAR_HEIGHT, TRAFFIC_LIGHT_POSITION } from "../shared/layout";
import type { WindowBounds } from "./session";
import { backgroundOf, createView, destroyView } from "./views";

/**
 * The signed-out window (docs/desktop.md §18.6): a BaseWindow with one view, `?welcome` — the splash while the kept
 * session loads, then the welcome page (Log in with Google, Log in with SSO). No tab bar, no Home, no store port: while
 * nobody is signed in nothing else of the app is reachable. It takes the app window's place on screen (and gives it
 * back): the gate (src/main/gate.ts) opens one before closing the other, so the app never has no window mid-swap.
 */
export class WelcomeWindow {
  readonly win: BaseWindow;
  readonly view: WebContentsView;
  private shown = false;
  private readonly onTheme = () => {
    if (this.win.isDestroyed()) return;
    this.win.setBackgroundColor(backgroundOf("welcome"));
    this.view.setBackgroundColor(backgroundOf("welcome"));
    if (process.platform !== "darwin") this.win.setTitleBarOverlay(overlay());
  };

  constructor(bounds: WindowBounds | undefined, onClosed: () => void) {
    const b = bounds && typeof bounds.width === "number" ? bounds : { ...DEFAULT_WINDOW_SIZE };
    this.win = new BaseWindow({
      width: Math.max(b.width, MIN_WINDOW_SIZE.width),
      height: Math.max(b.height, MIN_WINDOW_SIZE.height),
      ...(b.x !== undefined && b.y !== undefined ? { x: b.x, y: b.y } : {}),
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height,
      show: false,
      title: "Designer",
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } } : { titleBarStyle: "hidden" as const, titleBarOverlay: overlay() }),
      backgroundColor: backgroundOf("welcome"),
    });
    this.view = createView("welcome", "welcome", null, { welcome: "" });
    this.win.contentView.addChildView(this.view);
    this.layout();
    this.win.on("resize", () => this.layout());
    this.view.webContents.on("render-process-gone", (_e, details) => {
      if (details.reason !== "clean-exit") this.view.webContents.reload();
    });
    nativeTheme.on("updated", this.onTheme);
    this.win.on("closed", () => {
      nativeTheme.removeListener("updated", this.onTheme);
      destroyView(this.view);
      onClosed();
    });
    // Shown once its page has painted (`shell:ready`), or after 1.5 s whatever it does.
    setTimeout(() => this.show(), 1500);
  }

  private layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    this.view.setBounds({ x: 0, y: 0, width, height });
  }

  show() {
    if (this.shown || this.win.isDestroyed()) return;
    this.shown = true;
    this.win.show();
    this.view.webContents.focus();
  }

  focus() {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.show();
    this.win.focus();
  }

  placement(): WindowBounds {
    return this.win.getBounds();
  }

  close() {
    if (!this.win.isDestroyed()) this.win.close();
  }
}

/** Windows: the caption buttons over the page, in the window's colours */
const overlay = () => ({ ...CAPTION_OVERLAY[nativeTheme.shouldUseDarkColors ? "dark" : "light"], color: backgroundOf("welcome"), height: TABBAR_HEIGHT - 1 });
