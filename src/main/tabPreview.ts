import type { WebContents, WebContentsView } from "electron";
import type { TabPreview } from "../shared/ipc";
import { tabbarHeight, zoomFactor } from "./interfaceScale";
import { emit } from "./tabs";
import { createView, destroyView } from "./views";
import type { WindowController } from "./window";

/**
 * The card under a hovered tab (atlas 01 §2.2): the tab bar's view can't draw
 * past its 38px, so the card is a view of its own — a transparent tab bar page
 * (`?tabpreview`) under the bar, over the content, made at the window's first
 * hover and kept hidden in between. The bar says which tab the pointer (or the
 * keyboard's focus) is on, main gathers the card (TabManager.previewOf) and
 * places the view under the tab; the page fades the card in after Figma's
 * 600 ms, at once when a card was showing already or the bar has the keyboard.
 * Leaving the bar, a click on it or the window losing the focus hides it.
 */

/** The view's size in CSS px: the card at its widest (its 210px date line and 8px padding a side) and tallest. */
export const PREVIEW_SIZE = { width: 228, height: 220 };

export class TabPreviewView {
  private view: WebContentsView | null = null;
  /** The tab whose card is up */
  private showing: string | null = null;
  /** The last hover: an answer for an older one is dropped */
  private seq = 0;
  /** Its page listens (`shell:ready`); until then the card waits here */
  private listening = false;
  private waiting: TabPreview | null = null;

  constructor(private readonly ctl: WindowController) {}

  async hover(tabId: string | null, x: number, keyboard: boolean): Promise<void> {
    const seq = ++this.seq;
    if (!tabId) return this.hide();
    const preview = await this.ctl.tabs.previewOf(tabId, keyboard || this.showing !== null);
    if (seq !== this.seq || this.ctl.win.isDestroyed()) return;
    if (!preview) return this.hide();
    const view = this.ensure();
    const zoom = zoomFactor();
    const width = Math.round(PREVIEW_SIZE.width * zoom);
    const { width: room } = this.ctl.win.getContentBounds();
    view.setBounds({ x: Math.max(0, Math.min(room - width, Math.round(x * zoom))), y: tabbarHeight(), width, height: Math.round(PREVIEW_SIZE.height * zoom) });
    // Over every view of the window (one added since would cover it).
    this.ctl.win.contentView.addChildView(view);
    this.send(preview);
    view.setVisible(true);
    this.showing = tabId;
  }

  hide(): void {
    this.seq++;
    if (!this.view || this.showing === null) return;
    this.showing = null;
    this.send(null);
    this.view.setVisible(false);
  }

  /** The page has its listener: the card that waited for it. */
  pageReady(sender: WebContents): void {
    if (!this.view || sender !== this.view.webContents) return;
    this.listening = true;
    if (this.waiting) emit(sender, "tabs:preview", this.waiting);
    this.waiting = null;
  }

  private send(preview: TabPreview | null) {
    if (!this.view) return;
    if (this.listening) emit(this.view.webContents, "tabs:preview", preview);
    else this.waiting = preview;
  }

  destroy(): void {
    if (this.view) destroyView(this.view);
    this.view = null;
  }

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = createView("tabbar", this.ctl.id, null, { tabpreview: "" });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    this.listening = false;
    // Loaded again (a crash, a reload): it says when it listens again.
    view.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.listening = false;
    });
    this.ctl.win.contentView.addChildView(view);
    this.view = view;
    return view;
  }
}
