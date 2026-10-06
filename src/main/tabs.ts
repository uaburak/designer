import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents, type WebContentsView } from "electron";
import type { CommandId } from "../shared/commands";
import type { HomeState, IpcEvents, OpenFile, TabRequest, TabResponse, TabsSnapshot } from "../shared/ipc";
import { HOME, neighbourTab, tabAtShortcut, tabsReducer, type Tab, type TabReport, type TabsAction, type TabsState } from "../shared/tabs";
import { askCrashed, askSaveAll, askSaveTab, askUnresponsive, tellSaveFailed } from "./dialogs";
import { setThemePreference } from "./theme";
import { createView, destroyView, viewOf } from "./views";
import type { WindowController } from "./window";

/**
 * The window's tabs, kept by main (docs/desktop.md §4–6): the state (the
 * pure reducer in src/shared/tabs.ts), and each file tab's own view — made
 * the first time the tab is shown (restored tabs stay "discarded" until
 * then), shown and hidden with setVisible — a hidden page is `hidden` to
 * Chromium: no animation frames, timers throttled (measured in Electron 44,
 * docs/desktop-impl.md) — and never reloaded by a reorder.
 *
 * Home is a view of its own, always loaded; it is also the sign-in gate
 * (legacy): until it says an admin is signed in, no file tab is shown.
 *
 * Unsaved work (legacy, until autosave): main asks the tab (`tab:request`,
 * always with a timeout) and asks the person with a native dialog.
 */

const SITE_URL = "https://burakkoc.net";
const DIRTY_TIMEOUT_MS = 1500;
const SAVE_TIMEOUT_MS = 120_000;
const HUNG_SAVE_TIMEOUT_MS = 10_000;

interface Runtime {
  view: WebContentsView;
  crashed: boolean;
  /** The "isn't responding" box on screen, taken away when the page answers again */
  hung: AbortController | null;
  /** A crash box is on screen */
  asking: boolean;
  /** Its renderer is being killed on purpose (Reload Tab on a hung page): it comes back without asking */
  restarting: boolean;
}

// ── Asking a tab (tab:request → tab:response) ──────────────────────────────

let nextReq = 1;
const pending = new Map<number, { resolve: (r: TabResponse) => void; sender: number }>();

export function settleRequest(sender: WebContents, response: TabResponse) {
  const waiting = pending.get(response.reqId);
  // Only the view that was asked may answer.
  if (!waiting || waiting.sender !== sender.id) return;
  pending.delete(response.reqId);
  waiting.resolve(response);
}

function request(contents: WebContents, op: TabRequest["op"], timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    if (contents.isDestroyed() || contents.isCrashed()) return reject(new Error("The tab is gone."));
    const reqId = nextReq++;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("The tab didn’t answer."));
    }, timeoutMs);
    pending.set(reqId, {
      sender: contents.id,
      resolve: (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value === true);
        else reject(new Error(r.error || "The tab couldn’t answer."));
      },
    });
    emit(contents, "tab:request", { reqId, op });
  });
}

export function emit<C extends keyof IpcEvents>(contents: WebContents, channel: C, ...payload: IpcEvents[C] extends void ? [] : [IpcEvents[C]]) {
  if (!contents.isDestroyed()) contents.send(channel, ...payload);
}

// ── The manager ───────────────────────────────────────────────────────────────

export class TabManager {
  state: TabsState;
  readonly home: WebContentsView;
  private runtime = new Map<string, Runtime>();
  /** Home's gate: null until it says (the active tab loads meanwhile), then whether an admin is signed in */
  signedIn: boolean | null = null;
  /** The view in front (HOME or a tab's id) */
  private shown: string | null = null;
  private savedAt = 0;
  private busy = false;

  constructor(
    private readonly ctl: WindowController,
    restored: TabsState
  ) {
    this.state = restored;
    this.home = this.addView("home", null, { home: "" });
    // Home's renderer gone: it comes back at once (nothing unsaved lives there).
    this.home.webContents.on("render-process-gone", (_e, details) => {
      if (details.reason !== "clean-exit") this.home.webContents.reload();
    });
  }

  /** The first show: Home or the tab that was in front (only its view is made). */
  start() {
    this.show();
    this.push();
  }

  // ── Views ──

  /** A content view in the window, hidden until it is shown, at the content's place. */
  private addView(role: "home" | "editor", tabId: string | null, query: Record<string, string>) {
    const view = createView(role, this.ctl.id, tabId, query);
    view.setVisible(false);
    view.setBounds(this.ctl.contentBounds());
    this.ctl.win.contentView.addChildView(view);
    return view;
  }

  /** A tab's view gone for good: out of the window, its webContents (and process) closed. */
  private drop(rt: Runtime) {
    rt.hung?.abort();
    this.ctl.win.contentView.removeChildView(rt.view);
    destroyView(rt.view);
  }

  /** The tab's view, made now if it has none. */
  private ensure(tab: Tab): Runtime {
    const there = this.runtime.get(tab.id);
    if (there) return there;
    const view = this.addView("editor", tab.id, { tab: tab.id, kind: tab.kind, slug: tab.slug });
    const rt: Runtime = { view, crashed: false, hung: null, asking: false, restarting: false };
    this.runtime.set(tab.id, rt);
    this.wire(tab.id, rt);
    // Quietly: the caller (show) tells the tab bar.
    if (tab.status === "discarded") this.state = tabsReducer(this.state, { type: "status", id: tab.id, status: "loading" });
    return rt;
  }

  private wire(id: string, rt: Runtime) {
    const contents = rt.view.webContents;
    contents.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit" || this.runtime.get(id) !== rt) return;
      if (rt.restarting) {
        // Killed on purpose: a new process, the page again.
        rt.restarting = false;
        return this.reload(id);
      }
      rt.crashed = true;
      rt.hung?.abort();
      rt.hung = null;
      this.dispatch({ type: "status", id, status: "crashed" });
      if (this.shown === id) void this.promptCrashed(id);
    });
    contents.on("unresponsive", () => {
      if (this.runtime.get(id) !== rt) return;
      this.dispatch({ type: "status", id, status: "unresponsive" });
      if (this.shown === id) void this.promptHung(id);
    });
    contents.on("responsive", () => {
      rt.hung?.abort();
      rt.hung = null;
      if (this.tab(id)?.status === "unresponsive") this.dispatch({ type: "status", id, status: "ready" });
    });
    // A hung page can't pass the keys on to the menu: the shell's own keys still leave or close it.
    contents.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown" || this.tab(id)?.status !== "unresponsive") return;
      const mod = process.platform === "darwin" ? input.meta : input.control;
      const key = input.key.toLowerCase();
      let cmd: CommandId | null = null;
      if (mod && !input.shift && key === "w") cmd = "file.close-tab";
      else if (input.control && key === "tab") cmd = input.shift ? "window.previous-tab" : "window.next-tab";
      else if (mod && /^[1-9]$/.test(key)) cmd = `window.tab-${key}` as CommandId;
      if (!cmd) return;
      e.preventDefault();
      this.command(cmd, "accelerator");
    });
  }

  private async promptCrashed(id: string) {
    const rt = this.runtime.get(id);
    const tab = this.tab(id);
    if (!rt || !tab || rt.asking) return;
    rt.asking = true;
    const answer = await askCrashed(this.ctl.win, tab.title);
    rt.asking = false;
    if (this.runtime.get(id) !== rt) return;
    if (answer === "close") return void this.forceClose([id]);
    this.reload(id);
  }

  private async promptHung(id: string) {
    const rt = this.runtime.get(id);
    const tab = this.tab(id);
    if (!rt || !tab || rt.hung) return;
    rt.hung = new AbortController();
    const answer = await askUnresponsive(this.ctl.win, tab.title, rt.hung.signal).catch(() => "wait" as const);
    rt.hung = null;
    if (answer === "reload" && this.runtime.get(id) === rt) {
      // The hung process is killed; once it is gone (render-process-gone) the page loads again in a new one.
      rt.restarting = true;
      this.dispatch({ type: "status", id, status: "loading" });
      rt.view.webContents.forcefullyCrashRenderer();
    }
  }

  /** A tab's page again (after a crash, a hang, Reload Tab). */
  reload(id: string) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.crashed = false;
    this.dispatch({ type: "status", id, status: "loading" });
    rt.view.webContents.reload();
  }

  /** The view of a tab, or Home's. */
  viewOf(id: string): WebContentsView | undefined {
    return id === HOME ? this.home : this.runtime.get(id)?.view;
  }

  /** Every loaded content view (Home first). */
  contentViews(): WebContentsView[] {
    return [this.home, ...[...this.runtime.values()].map((r) => r.view)];
  }

  /** The content view in front. */
  activeView(): WebContentsView {
    return (this.shown && this.viewOf(this.shown)) || this.home;
  }

  private tab(id: string) {
    return this.state.tabs.find((t) => t.id === id);
  }

  // ── State ──

  dispatch(action: TabsAction) {
    const prev = this.state;
    const next = tabsReducer(prev, action);
    if (next === prev) return;
    this.state = next;
    // Tabs gone: their views and processes too.
    for (const [id, rt] of this.runtime) {
      if (next.tabs.some((t) => t.id === id)) continue;
      this.runtime.delete(id);
      this.drop(rt);
    }
    if (prev.active !== next.active || (this.shown !== null && this.shown !== HOME && !this.runtime.has(this.shown))) this.show();
    this.push();
    this.ctl.persist();
  }

  /** The one in front shown, the others hidden (kept: their process, their state); the one in front takes the keys. */
  private show() {
    const id = this.signedIn === false ? HOME : this.state.active;
    const tab = id === HOME ? undefined : this.tab(id);
    const target = tab ? this.ensure(tab).view : this.home;
    target.setVisible(true);
    for (const view of this.contentViews()) if (view !== target) view.setVisible(false);
    const before = this.shown;
    this.shown = tab ? tab.id : HOME;
    if (before !== this.shown) {
      const was = before && before !== HOME ? this.runtime.get(before) : undefined;
      if (was) emit(was.view.webContents, "tab:visibility", { visible: false });
      if (tab) emit(target.webContents, "tab:visibility", { visible: true });
    }
    target.webContents.focus();
    this.ctl.contentShown(target);
    if (tab && this.runtime.get(tab.id)?.crashed) void this.promptCrashed(tab.id);
    else if (tab && this.tab(tab.id)?.status === "unresponsive") void this.promptHung(tab.id);
  }

  snapshot(): TabsSnapshot {
    const signedIn = this.signedIn !== false;
    return {
      windowId: this.ctl.id,
      tabs: [{ id: HOME, kind: "home", slug: "", title: "Home", dirty: false, status: "ready" }, ...(signedIn ? this.state.tabs : [])],
      activeTabId: signedIn ? this.state.active : HOME,
      canReopen: signedIn && this.state.closed.length > 0,
      fullScreen: this.ctl.win.isFullScreen(),
      signedIn,
    };
  }

  homeState(): HomeState {
    return { visible: this.shown === HOME, openSlugs: this.state.tabs.filter((t) => t.kind === "project").map((t) => t.slug), savedAt: this.savedAt };
  }

  /** The tab bar and Home told. */
  push() {
    const snapshot = this.snapshot();
    emit(this.ctl.tabbar.webContents, "tabs:state", snapshot);
    emit(this.home.webContents, "tabs:state", snapshot);
    emit(this.home.webContents, "home:state", this.homeState());
  }

  // ── What views and the menu ask ──

  activate(id: string) {
    if (this.signedIn === false && id !== HOME) return;
    if (id === this.state.active) this.viewOf(id)?.webContents.focus();
    else this.dispatch({ type: "activate", id });
  }

  open(file: OpenFile): string {
    if (this.signedIn === false) return HOME;
    this.dispatch({ type: "open", kind: file.kind, slug: file.slug, title: file.title });
    return this.state.tabs.find((t) => t.kind === file.kind && t.slug === file.slug)?.id ?? HOME;
  }

  move(id: string, toIndex: number) {
    // The tab bar counts Home as 0.
    if (Number.isFinite(toIndex)) this.dispatch({ type: "move", id, to: Math.round(toIndex) - 1 });
  }

  reopen() {
    if (this.signedIn !== false) this.dispatch({ type: "reopen" });
  }

  /** "+", ⌘N: Home's New Project dialog. */
  newFile() {
    this.activate(HOME);
    emit(this.home.webContents, "menu:command", { id: "file.new", source: "menu" });
  }

  report(sender: WebContents, report: TabReport) {
    const id = viewOf(sender)?.tabId;
    const rt = id ? this.runtime.get(id) : undefined;
    if (!id || !rt || rt.view.webContents !== sender) return;
    this.dispatch({ type: "report", id, report: { title: report.title, dirty: report.dirty, status: report.status } });
    if (typeof report.savedAt === "number" && report.savedAt > this.savedAt) {
      this.savedAt = report.savedAt;
      emit(this.home.webContents, "home:state", this.homeState());
    }
  }

  setSignedIn(signedIn: boolean) {
    if (this.signedIn === signedIn) return;
    this.signedIn = signedIn;
    if (!signedIn) {
      // Signed out (here or elsewhere): no file is shown — their views go; the tabs stay for the next sign-in.
      for (const [id, rt] of this.runtime) {
        this.runtime.delete(id);
        this.drop(rt);
      }
      this.state = { ...this.state, tabs: this.state.tabs.map((t) => ({ ...t, status: "discarded", dirty: false })) };
    }
    this.show();
    this.push();
  }

  // ── Unsaved work ──

  /** Does the tab hold unsaved work? Its own answer, else (no answer in time) what it last reported. */
  private async isDirty(id: string): Promise<boolean> {
    const rt = this.runtime.get(id);
    const tab = this.tab(id);
    if (!rt || !tab || rt.crashed) return false;
    if (tab.status === "unresponsive") return tab.dirty;
    return request(rt.view.webContents, "is-dirty", DIRTY_TIMEOUT_MS).catch(() => tab.dirty);
  }

  private async save(id: string): Promise<boolean> {
    const rt = this.runtime.get(id);
    const tab = this.tab(id);
    if (!rt || !tab) return true;
    try {
      // A hung page gets a short wait: it can't answer while it is stuck.
      return await request(rt.view.webContents, "save", tab.status === "unresponsive" ? HUNG_SAVE_TIMEOUT_MS : SAVE_TIMEOUT_MS);
    } catch (err) {
      await tellSaveFailed(this.ctl.win, tab.title, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** Tabs closed — an unsaved one asks first (Save, Don't Save, Cancel): false when the person kept it. */
  async close(ids: string[]): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      for (const id of ids) {
        const tab = this.tab(id);
        if (!tab) continue;
        if (await this.isDirty(id)) {
          this.activate(id);
          const answer = await askSaveTab(this.ctl.win, tab.title);
          if (answer === "cancel") return false;
          if (answer === "save" && !(await this.save(id))) return false;
        }
        this.dispatch({ type: "close", ids: [id] });
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Closed without asking (a crashed tab). */
  private forceClose(ids: string[]) {
    this.dispatch({ type: "close", ids });
  }

  /** Before the window closes, the app quits or the account signs out: every unsaved tab saved, or let go — false when the person stayed. */
  async settleAll(action: "close" | "quit" | "sign-out"): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const loaded = this.state.tabs.filter((t) => this.runtime.has(t.id));
      const dirty = (await Promise.all(loaded.map(async (t) => ((await this.isDirty(t.id)) ? t : null)))).filter((t): t is Tab => t !== null);
      if (!dirty.length) return true;
      const answer = await askSaveAll(this.ctl.win, dirty.map((t) => t.title), action);
      if (answer === "cancel") return false;
      if (answer === "save") {
        for (const tab of dirty) {
          // Each in front while it saves: a hidden page's timers are throttled (a save could crawl), and the person sees which one is saving.
          this.activate(tab.id);
          if (!(await this.save(tab.id))) return false;
        }
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  async signOut() {
    if (!(await this.settleAll("sign-out"))) return;
    this.signedIn = null;
    this.dispatch({ type: "reset" });
    this.setSignedIn(false);
    emit(this.home.webContents, "session:sign-out");
  }

  /** The tab's native context menu, at the tab bar's point. */
  contextMenu(id: string, x: number, y: number) {
    const { tabs, closed } = this.state;
    const at = tabs.findIndex((t) => t.id === id);
    const tab = tabs[at];
    const reopen = { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", enabled: closed.length > 0, click: () => this.reopen() };
    const items: MenuItemConstructorOptions[] = !tab
      ? [reopen]
      : [
          { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => void this.close([id]) },
          { label: "Close Other Tabs", enabled: tabs.length > 1, click: () => void this.close(tabs.filter((t) => t.id !== id).map((t) => t.id)) },
          { label: "Close Tabs to the Right", enabled: at < tabs.length - 1, click: () => void this.close(tabs.slice(at + 1).map((t) => t.id)) },
          { type: "separator" },
          { label: "Copy Link", click: () => clipboard.writeText(tab.kind === "cv" ? `${SITE_URL}/cv` : `${SITE_URL}/projects/${tab.slug}`) },
          { label: "Show in File Browser", click: () => this.activate(HOME) },
          { type: "separator" },
          reopen,
        ];
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, x: Math.round(x), y: Math.round(y) });
  }

  // ── The menu's commands (src/shared/commands.ts) ──

  command(id: CommandId, source: "menu" | "accelerator", focused?: WebContents | null) {
    const { active } = this.state;
    const gated = this.signedIn === false;
    switch (id) {
      case "file.new":
        return this.newFile();
      case "file.close-tab":
        if (!gated && active !== HOME) void this.close([active]);
        return;
      case "file.reopen-closed-tab":
        return this.reopen();
      case "file.close-window":
        // Through the window's own closing: unsaved tabs asked about first.
        return this.ctl.win.close();
      case "file.save": {
        const rt = this.shown && this.shown !== HOME ? this.runtime.get(this.shown) : undefined;
        if (rt) emit(rt.view.webContents, "menu:command", { id, source });
        return;
      }
      case "app.theme-light":
      case "app.theme-dark":
      case "app.theme-system":
        setThemePreference(id === "app.theme-light" ? "light" : id === "app.theme-dark" ? "dark" : "system");
        return;
      case "app.sign-out":
        return void this.signOut();
      case "window.next-tab":
        return this.activate(neighbourTab(this.state, 1));
      case "window.previous-tab":
        return this.activate(neighbourTab(this.state, -1));
      case "view.reload-tab": {
        const target = this.target(focused);
        const tabId = viewOf(target.webContents)?.tabId;
        if (tabId) this.reload(tabId);
        else target.webContents.reload();
        return;
      }
      case "view.toggle-devtools":
        return this.target(focused).webContents.toggleDevTools();
      case "view.toggle-tabbar-devtools":
        return this.ctl.tabbar.webContents.toggleDevTools();
      case "edit.undo":
      case "edit.redo":
      case "edit.select-all":
      case "edit.delete": {
        // The view with the focus: an editor gets it as a command (its own model, not the DOM's); Home and the tab bar are DOM — native.
        const contents = focused && viewOf(focused)?.windowId === this.ctl.id ? focused : this.activeView().webContents;
        if (viewOf(contents)?.role === "editor") return emit(contents, "menu:command", { id, source });
        if (id === "edit.undo") contents.undo();
        else if (id === "edit.redo") contents.redo();
        else if (id === "edit.select-all") contents.selectAll();
        else contents.delete();
        return;
      }
      default: {
        const n = Number(/^window\.tab-(\d)$/.exec(id)?.[1]);
        const target = n ? tabAtShortcut(this.state, n) : undefined;
        if (target) this.activate(target);
      }
    }
  }

  /** The content view a command is for: the focused one if it is this window's content, else the one in front. */
  private target(focused?: WebContents | null): WebContentsView {
    const info = focused ? viewOf(focused) : undefined;
    if (focused && info?.windowId === this.ctl.id && info.role !== "tabbar") {
      const view = this.contentViews().find((v) => v.webContents === focused);
      if (view) return view;
    }
    return this.activeView();
  }

  /** Every view's webContents closed (the window is gone). */
  destroy() {
    for (const rt of this.runtime.values()) destroyView(rt.view);
    this.runtime.clear();
    destroyView(this.home);
  }

  /** For tests (scripts/drive.mjs): which tab has which view and process. */
  debug() {
    return {
      shown: this.shown,
      signedIn: this.signedIn,
      state: this.state,
      views: [
        { id: HOME, role: "home", webContentsId: this.home.webContents.id, pid: this.home.webContents.getOSProcessId(), visible: this.shown === HOME, url: this.home.webContents.getURL() },
        ...[...this.runtime.entries()].map(([id, rt]) => ({ id, role: "editor", webContentsId: rt.view.webContents.id, pid: rt.view.webContents.isDestroyed() ? 0 : rt.view.webContents.getOSProcessId(), visible: this.shown === id, url: rt.view.webContents.getURL(), crashed: rt.crashed })),
      ],
    };
  }
}
