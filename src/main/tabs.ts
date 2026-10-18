import { Menu, shell, type MenuItemConstructorOptions, type WebContents, type WebContentsView } from "electron";
import { command as commandSpec, isCommandId, layoutCommands, type CommandId, type MenuStatePatch } from "../shared/commands";
import type { FlushReason, HomeState, ImportResult, IpcEvents, NewFileResult, OpenFileResult, OpenWorkspaceFile, TabFlushed, TabsSnapshot } from "../shared/ipc";
import { DISCARD_AFTER_MS, DISCARD_IDLE_MS, DISCARD_SWEEP_MS, discardable, GROUP_COLORS, groupsOf, HOME, liveAtStart, neighbourTab, newTabId, tabAtShortcut, tabsReducer, type GroupColor, type Tab, type TabGroup, type TabReport, type TabsAction, type TabsState } from "../shared/tabs";
import { isStoreError } from "../shared/store/protocol";
import type { WorkspaceEvent } from "../shared/store/repositories";
import { askCrashed, askFlushFailed, askFlushTimeout, askUnresponsive, tellFileError } from "./dialogs";
import { exportPreview, importFiles, saveLocalCopy } from "./files";
import { onWorkspaceEvent, readyStore, storeClient, workspaceDir } from "./storeHost";
import { SpareEditor } from "./spare";
import { menuSignedOut, refreshAppMenu } from "./menu";
import { reloadAllTabs, setGraphicsBackend, toggleHardwareAcceleration } from "./troubleshooting";
import { setThemePreference } from "./theme";
import { setInterfaceScale, stepInterfaceScale, zoomFactor } from "./interfaceScale";
import { DEFAULT_ZOOM_STOP } from "../shared/interfaceScale";
import { adoptView, createView, destroyView, viewOf } from "./views";
import type { WindowController } from "./window";
import { t, tp } from "../shared/i18n";

/**
 * The window's tabs, kept by main (docs/desktop.md §4–6): the state (the
 * pure reducer in src/shared/tabs.ts), and each file tab's own view — made
 * the first time the tab is shown (restored tabs stay "discarded" until
 * then), or adopted from the spare editor (§3.1: a hidden view whose page
 * and Wasm are already loaded, told its file with `tab:attach`) — shown and
 * hidden with setVisible — a hidden page is `hidden` to Chromium: no
 * animation frames, timers throttled (measured in Electron 44,
 * docs/desktop-impl.md) — and never reloaded by a reorder.
 *
 * Files save as they go: closing, quitting and hiding run the flush
 * handshake (`tab:flush` → `tab:flushed`, 3 s), and a native question comes
 * only when a flush fails or times out. The store's events retitle their
 * tabs (`file.renamed`) and close them (`file.trashed`, `file.deleted`).
 *
 * Figma's offloading (atlas 01 §2.7): at launch the most recently viewed
 * file tabs load in the background, one after another (LIVE_AT_START in all); every
 * hour — and on coming back after 4 h away — loaded file tabs not viewed for
 * 48 h are offloaded, oldest first, 3 kept. An offloaded tab is flushed
 * first and stays loaded unless the flush succeeded: nothing unsaved goes.
 * A new-tab page (⌘T, "+") is a Home view of its own; a file picked there
 * takes its tab's place.
 */

export const FLUSH_TIMEOUT_MS = 3000;

/** Figma's group colour names (its Group color menu) */
const GROUP_COLOR_NAMES: Record<GroupColor, string> = { blue: "Blue", red: "Red", yellow: "Yellow", green: "Green", purple: "Purple", pink: "Pink", persimmon: "Persimmon", grey: "Grey" };

/** A group's name as the bar and the menus show it: its own, or "Group {number}". */
export const groupName = (g: TabGroup) => g.name || t("Group {number}", { number: g.number });

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

/** What a view says about its menu items (`menu:state`), merged. */
interface MenuState {
  enabled: Partial<Record<CommandId, boolean>>;
  checked: Partial<Record<CommandId, boolean>>;
}

/** The Edit commands that act on a DOM text field (Home's, the tab bar's) natively. */
const NATIVE_EDIT = new Set<CommandId>(["edit.undo", "edit.redo", "edit.select-all", "edit.delete"]);
/** Of those, the ones Home runs on its own selection when chosen from the menu (Select all files, Move to trash) */
const HOME_EDIT = new Set<CommandId>(["edit.select-all", "edit.delete"]);

// ── The flush handshake (tab:flush → tab:flushed) ────────────────────────────

type FlushOutcome = { ok: true } | { ok: false; error: string } | { timeout: true };

let nextFlush = 1;
const flushing = new Map<number, { resolve: (r: TabFlushed) => void; sender: number }>();

export function settleFlush(sender: WebContents, response: TabFlushed) {
  const waiting = flushing.get(response.reqId);
  // Only the view that was asked may answer.
  if (!waiting || waiting.sender !== sender.id) return;
  flushing.delete(response.reqId);
  waiting.resolve(response);
}

/** Asks a file tab's page to flush; a gone page has nothing unsent that could still be sent. */
function askFlush(contents: WebContents, reason: FlushReason, timeoutMs = FLUSH_TIMEOUT_MS): Promise<FlushOutcome> {
  return new Promise((resolve) => {
    if (contents.isDestroyed() || contents.isCrashed()) return resolve({ ok: true });
    const reqId = nextFlush++;
    const timer = setTimeout(() => {
      flushing.delete(reqId);
      resolve({ timeout: true });
    }, timeoutMs);
    flushing.set(reqId, {
      sender: contents.id,
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error || t("The file couldn’t be saved.") });
      },
    });
    emit(contents, "tab:flush", { reqId, reason });
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
  /** The view in front (HOME or a tab's id) */
  private shown: string | null = null;
  private busy = false;
  /** Each content view's menu state (HOME or a tab's id) */
  private menuStates = new Map<string, MenuState>();
  private offWorkspace: () => void;
  /** The pre-warmed editor view a file opens into (docs/desktop.md §3.1); never a tab until adopted. */
  private readonly spare: SpareEditor<WebContentsView>;
  /** The open under way (openFile → show → ensure), for the timing record. */
  private openRequest: { at: number; fileKey: string } | null = null;
  /** The last file opens: when main was asked, which view the tab got (scripts/drive.mjs `open-timing`). */
  private opens: { at: number; fileKey: string; tabId: string; adopted: boolean; webContentsId: number }[] = [];
  /** The hourly discard sweep */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** When the window last lost the focus (null: it has it) — 4 h away, a sweep when it comes back */
  private awaySince: number | null = null;
  private offFocus: () => void = () => {};
  /** The launch's background loads are going on */
  private warming = false;

  constructor(
    private readonly ctl: WindowController,
    restored: TabsState
  ) {
    this.state = restored;
    // Home: the file browser on the store.
    this.home = this.addView("home", null, { files: "" });
    // Home's renderer gone: it comes back at once (nothing unsaved lives there).
    this.home.webContents.on("render-process-gone", (_e, details) => {
      if (details.reason !== "clean-exit") this.home.webContents.reload();
    });
    this.offWorkspace = onWorkspaceEvent((e) => this.onWorkspaceEvent(e));
    this.spare = new SpareEditor<WebContentsView>({
      // `?editor` with no file and no tab: the page pre-warms and waits for `tab:attach`.
      create: () => this.addView("editor", null, { editor: "" }),
      destroy: (view) => {
        if (!this.ctl.win.isDestroyed()) this.ctl.win.contentView.removeChildView(view);
        destroyView(view);
      },
      // The registry first, so an `init()` racing the attach already answers the tab.
      attach: (view, attach) => {
        adoptView(view.webContents, attach.tabId, attach.fileKey);
        emit(view.webContents, "tab:attach", attach);
      },
      onGone: (view, cb) => {
        const contents = view.webContents;
        const handler = (_e: unknown, details: { reason: string }) => {
          if (details.reason !== "clean-exit") cb();
        };
        contents.on("render-process-gone", handler);
        return () => {
          if (!contents.isDestroyed()) contents.removeListener("render-process-gone", handler);
        };
      },
    });
  }

  /** The content in front has painted (Home at launch): the spare editor comes 3 s on. */
  contentReady() {
    this.spare.ready();
  }

  /** The first show: Home or the tab that was in front (only its view is made); kept files checked against the store. */
  start() {
    this.show();
    this.push();
    void this.dropMissingFiles().then(() => this.warmUp());
    this.sweepTimer = setInterval(() => {
      // Away for 4 h: the sweep waits for the window to come back.
      if (this.awaySince === null || Date.now() - this.awaySince < DISCARD_IDLE_MS) void this.sweep();
    }, DISCARD_SWEEP_MS);
    this.sweepTimer.unref?.();
    const blur = () => (this.awaySince ??= Date.now());
    const focus = () => {
      const away = this.awaySince;
      this.awaySince = null;
      if (away !== null && Date.now() - away >= DISCARD_IDLE_MS) void this.sweep();
    };
    this.ctl.win.on("blur", blur);
    this.ctl.win.on("focus", focus);
    this.offFocus = () => {
      this.ctl.win.removeListener("blur", blur);
      this.ctl.win.removeListener("focus", focus);
    };
  }

  /**
   * The launch's live tabs (atlas 01 §2.7): besides the one in front, the most recently viewed file tabs load hidden,
   * one after another as each finishes loading — LIVE_AT_START in all; ours leaves out those not viewed for 48 h, which the
   * sweep would offload at once.
   */
  private async warmUp() {
    if (this.warming) return;
    this.warming = true;
    try {
      const now = Date.now();
      for (const id of liveAtStart(this.state)) {
        const tab = this.tab(id);
        if (this.ctl.win.isDestroyed() || !tab || this.runtime.has(id) || now - (tab.viewedAt ?? 0) > DISCARD_AFTER_MS) continue;
        const rt = this.ensure(tab, { background: true });
        this.push();
        await new Promise<void>((resolve) => {
          const contents = rt.view.webContents;
          if (contents.isDestroyed() || !contents.isLoading()) return resolve();
          const done = () => resolve();
          contents.once("did-finish-load", done);
          contents.once("did-fail-load", done);
          contents.once("destroyed", done);
        });
      }
    } finally {
      this.warming = false;
    }
  }

  // ── Offloading (atlas 01 §2.7) ──

  /** The hourly sweep: loaded file tabs not viewed for 48 h offloaded, oldest first, 3 kept. */
  async sweep(now = Date.now()) {
    for (const id of discardable(this.state, new Set(this.runtime.keys()), now)) await this.discard(id);
  }

  /**
   * A tab offloaded: its page flushed, then its view and process closed, the tab "discarded" (it loads again when
   * shown). Never the one in front or a pinned one; kept loaded when the flush fails or times out — nothing unsaved is
   * lost. True when it was offloaded.
   */
  async discard(id: string): Promise<boolean> {
    const rt = this.runtime.get(id);
    const tab = this.tab(id);
    if (!rt || !tab || tab.pinned || tab.kind === "new-tab" || id === this.state.active || rt.crashed || tab.status === "unresponsive") return false;
    const viewedAt = tab.viewedAt;
    const outcome = await askFlush(rt.view.webContents, "discard");
    if (!("ok" in outcome) || !outcome.ok) return false;
    // Brought forward, pinned or closed meanwhile: it stays.
    const after = this.tab(id);
    if (this.runtime.get(id) !== rt || !after || id === this.state.active || after.viewedAt !== viewedAt || after.pinned) return false;
    this.runtime.delete(id);
    this.menuStates.delete(id);
    this.drop(rt);
    this.dispatch({ type: "status", id, status: "discarded" });
    return true;
  }

  // ── Views ──

  /** A content view in the window, hidden until it is shown, at the content's place. */
  private addView(role: "home" | "editor", tabId: string | null, query: Record<string, string>, fileKey: string | null = null) {
    const view = createView(role, this.ctl.id, tabId, query, fileKey);
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

  /**
   * The tab's view, made now if it has none: the spare editor when there is one (told its file: `tab:attach`), else
   * a new view with the file in its URL, `?editor&file=<fileKey>&tab=<id>`.
   */
  private ensure(tab: Tab, { background = false } = {}): Runtime {
    const there = this.runtime.get(tab.id);
    if (there) return there;
    // A prototype tab: the presentation view (`?present&file=…`), a view of its own (never the spare editor); a
    // launch's background load leaves the spare for the next open.
    const adopted = tab.kind !== "file" || background ? null : this.spare.adopt({ tabId: tab.id, fileKey: tab.fileKey, mode: "edit" });
    const query: Record<string, string> =
      tab.kind === "prototype"
        ? { present: "", file: tab.fileKey, tab: tab.id, ...(tab.pageId ? { page: tab.pageId } : {}), ...(tab.startNodeId ? { node: tab.startNodeId } : {}) }
        : { editor: "", file: tab.fileKey, tab: tab.id };
    // The new-tab page: Home's page in a view of its own, for this tab.
    const view = adopted ?? (tab.kind === "new-tab" ? this.addView("home", tab.id, { newtab: "" }) : this.addView("editor", tab.id, query, tab.fileKey));
    const request = this.openRequest;
    this.openRequest = null;
    this.opens = [...this.opens.slice(-9), { at: request?.fileKey === tab.fileKey ? request.at : Date.now(), fileKey: tab.fileKey, tabId: tab.id, adopted: Boolean(adopted), webContentsId: view.webContents.id }];
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
    // A reload starts its menu state over.
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.menuStates.delete(id);
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

  /** A tab's page again (after a crash, a hang, Reload Tab); a live file tab flushes first. */
  reload(id: string) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (this.tab(id)?.kind === "new-tab") return void rt.view.webContents.reload();
    const again = () => {
      if (this.runtime.get(id) !== rt) return;
      rt.crashed = false;
      this.dispatch({ type: "status", id, status: "loading" });
      rt.view.webContents.reload();
    };
    if (!rt.crashed) void askFlush(rt.view.webContents, "reload").then(again);
    else again();
  }

  /**
   * Help › Troubleshooting › Reload All Tabs (atlas 21 §7), and Graphics Backend's reload: every loaded tab again — each
   * file's changes flushed first, as `reload` does — its page's address rewritten by `rewrite` when given (the backend's
   * `?force-…` switch, troubleshooting.ts).
   */
  reloadAll(rewrite?: (url: string) => string) {
    for (const [id, rt] of this.runtime) {
      const go = () => {
        if (this.runtime.get(id) !== rt || rt.view.webContents.isDestroyed()) return;
        rt.crashed = false;
        if (this.tab(id)?.kind !== "new-tab") this.dispatch({ type: "status", id, status: "loading" });
        const url = rt.view.webContents.getURL();
        if (rewrite && url && rewrite(url) !== url) void rt.view.webContents.loadURL(rewrite(url)).catch(() => {});
        else rt.view.webContents.reload();
      };
      if (!rt.crashed && this.tab(id)?.kind !== "new-tab") void askFlush(rt.view.webContents, "reload").then(go);
      else go();
    }
  }

  /** Home's page again (another account is current, docs/desktop.md §18.7): its lists, spaces and orgs are the new account's. */
  reloadHome() {
    if (!this.home.webContents.isDestroyed()) this.home.webContents.reload();
  }

  /** The view of a tab, or Home's. */
  viewOf(id: string): WebContentsView | undefined {
    return id === HOME ? this.home : this.runtime.get(id)?.view;
  }

  /** Every loaded content view (Home first; the spare editor last — placed, themed and hidden with the rest, never a tab). */
  contentViews(): WebContentsView[] {
    const spare = this.spare.view();
    return [this.home, ...[...this.runtime.values()].map((r) => r.view), ...(spare ? [spare] : [])];
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
      this.menuStates.delete(id);
      this.drop(rt);
    }
    if (prev.active !== next.active || (this.shown !== null && this.shown !== HOME && !this.runtime.has(this.shown))) this.show();
    this.push();
    this.ctl.persist();
  }

  /** The one in front shown, the others hidden (kept: their process, their state); the one in front takes the keys. */
  private show() {
    const id = this.state.active;
    const tab = id === HOME ? undefined : this.tab(id);
    const target = tab ? this.ensure(tab).view : this.home;
    target.setVisible(true);
    for (const view of this.contentViews()) if (view !== target) view.setVisible(false);
    const before = this.shown;
    this.shown = tab ? tab.id : HOME;
    if (before !== this.shown) {
      const was = before && before !== HOME && this.tab(before)?.kind !== "new-tab" ? this.runtime.get(before) : undefined;
      if (was) {
        emit(was.view.webContents, "tab:visibility", { visible: false });
        // Hidden: what it holds goes to the store now (nobody waits for the answer).
        if (!was.crashed) void askFlush(was.view.webContents, "hide");
      }
      if (tab && tab.kind !== "new-tab") emit(target.webContents, "tab:visibility", { visible: true });
      // Recents (docs/desktop.md §5 step 6).
      if (tab?.fileKey) void storeClient()?.workspace.recordViewed(tab.fileKey).catch(() => {});
    }
    target.webContents.focus();
    this.ctl.contentShown(target);
    this.applyMenu();
    if (tab && this.runtime.get(tab.id)?.crashed) void this.promptCrashed(tab.id);
    else if (tab && this.tab(tab.id)?.status === "unresponsive") void this.promptHung(tab.id);
  }

  snapshot(): TabsSnapshot {
    return {
      windowId: this.ctl.id,
      tabs: [{ id: HOME, kind: "home", title: "Home", status: "ready" }, ...this.state.tabs],
      activeTabId: this.state.active,
      canReopen: this.state.closed.length > 0,
      fullScreen: this.ctl.win.isFullScreen(),
      groups: groupsOf(this.state),
    };
  }

  homeState(): HomeState {
    return { visible: this.shown === HOME, openFileKeys: this.state.tabs.filter((t) => t.fileKey).map((t) => t.fileKey) };
  }

  /** The tab bar and Home told; the menu's shell items follow. */
  push() {
    const snapshot = this.snapshot();
    emit(this.ctl.tabbar.webContents, "tabs:state", snapshot);
    emit(this.home.webContents, "tabs:state", snapshot);
    emit(this.home.webContents, "home:state", this.homeState());
    this.applyMenu();
  }

  // ── What views and the menu ask ──

  activate(id: string) {
    if (id === this.state.active) this.viewOf(id)?.webContents.focus();
    else this.dispatch({ type: "activate", id, at: Date.now() });
  }

  /** "+" and ⌘T: the new-tab page in a new tab, beside the one in front (atlas 01 §3). */
  newTab() {
    this.dispatch({ type: "open", kind: "new-tab", fileKey: "", at: Date.now() });
  }

  /** A shared file's link opened from the system: Home in front, which opens it (docs/multiplayer.md §3). */
  openSharedLink(key: string, link?: string) {
    this.activate(HOME);
    const send = () => emit(this.home.webContents, "home:open-shared", { key, ...(link ? { link: link.slice(0, 2000) } : {}) });
    if (this.home.webContents.isLoading()) this.home.webContents.once("did-finish-load", () => setTimeout(send, 300));
    else send();
  }

  /** Home in front; it shows the file when one is given. */
  goHome(revealFileKey?: string) {
    this.activate(HOME);
    if (revealFileKey) emit(this.home.webContents, "home:reveal", { fileKey: revealFileKey });
  }

  /**
   * A workspace file in a tab: its tab in front if it has one, else a new one at the end (from Home) or after the one
   * in front. `requestedAt`: when the open was asked for (a new file's creation came first), for the timing record.
   */
  openFile(file: OpenWorkspaceFile, requestedAt = Date.now(), replace?: string): OpenFileResult {
    const find = () => this.state.tabs.find((t) => t.kind === "file" && t.fileKey === file.fileKey);
    const existing = Boolean(find());
    this.openRequest = { at: requestedAt, fileKey: file.fileKey };
    // Picked on a new-tab page (`replace`): the file takes that tab's place — opened in the background, it leaves it.
    this.dispatch({ type: "open", fileKey: file.fileKey, title: file.title, background: file.background, replace: file.background ? undefined : replace, at: Date.now() });
    const tab = find();
    if (!tab) return { tabId: HOME, existing };
    // A name to show: the store's (Home usually hands it over), and a file that isn't there any more closes again.
    if (!existing && !file.title) void this.checkFile(file.fileKey);
    return { tabId: tab.id, existing };
  }

  /** Present: the file's presentation view in a tab — its tab in front if it has one (same file and start). */
  openPrototype(p: { fileKey: string; pageId: string; startNodeId?: string; title?: string }): OpenFileResult {
    const find = () => this.state.tabs.find((t) => t.kind === "prototype" && t.fileKey === p.fileKey && (t.startNodeId ?? "") === (p.startNodeId ?? ""));
    const existing = Boolean(find());
    const fileTitle = p.title ?? this.state.tabs.find((t) => t.kind === "file" && t.fileKey === p.fileKey)?.title;
    this.dispatch({ type: "open", kind: "prototype", fileKey: p.fileKey, pageId: p.pageId, startNodeId: p.startNodeId, title: fileTitle, at: Date.now() });
    const tab = find();
    return { tabId: tab?.id ?? HOME, existing };
  }

  move(id: string, toIndex: number) {
    // The tab bar counts Home as 0.
    if (Number.isFinite(toIndex)) this.dispatch({ type: "move", id, to: Math.round(toIndex) - 1 });
  }

  /** ⇧⌘T: the last closed tab again — a file only if it is still there (not in the trash). */
  async reopen() {
    for (let i = 0; i < 20; i++) {
      const last = this.state.closed[0];
      if (!last) return;
      if ((await this.fileState(last.fileKey)) === "gone") {
        this.dispatch({ type: "drop-file", fileKey: last.fileKey });
        continue;
      }
      return this.dispatch({ type: "reopen", at: Date.now() });
    }
  }

  /** A closed tab picked in the tabs menu: opened again (it leaves the history if its file is gone). */
  private async reopenClosed(entry: TabsState["closed"][number]) {
    if ((await this.fileState(entry.fileKey)) === "gone") return this.dispatch({ type: "drop-file", fileKey: entry.fileKey });
    this.dispatch({ type: "open", kind: entry.kind, fileKey: entry.fileKey, title: entry.title, pageId: entry.pageId, startNodeId: entry.startNodeId, at: Date.now() });
  }

  /** A new design file (Drafts unless a folder is given), created by the store and opened (⌘N, Home's New design file, the new-tab page's Design). */
  async newFile(request: { folderId?: string | null; name?: string; replace?: string } = {}): Promise<NewFileResult> {
    const requestedAt = Date.now();
    const store = await readyStore();
    const meta = await store.workspace.createFile({ name: request.name, folderId: request.folderId ?? null });
    const { tabId } = this.openFile({ fileKey: meta.fileKey, title: meta.name }, requestedAt, request.replace);
    return { fileKey: meta.fileKey, tabId };
  }

  report(sender: WebContents, report: TabReport) {
    const id = viewOf(sender)?.tabId;
    const rt = id ? this.runtime.get(id) : undefined;
    if (!id || !rt || rt.view.webContents !== sender) return;
    this.dispatch({ type: "report", id, report: { title: report.title, status: report.status } });
  }

  // ── The store's word on files ──

  private onWorkspaceEvent(e: WorkspaceEvent) {
    if (e.type === "file.renamed") this.dispatch({ type: "retitle-file", fileKey: e.fileKey, title: e.name });
    else if (e.type === "file.updated" || e.type === "file.created" || e.type === "file.restored") this.dispatch({ type: "retitle-file", fileKey: e.file.fileKey, title: e.file.name });
    else if (e.type === "file.trashed" || e.type === "file.deleted") void this.dropFile(e.fileKey);
  }

  /** A file trashed or deleted: its tabs flush and close without asking, and it leaves the closed history. */
  private async dropFile(fileKey: string) {
    if (!fileKey) return;
    const loaded = this.state.tabs.filter((t) => t.fileKey === fileKey && this.runtime.has(t.id));
    await Promise.all(loaded.map((t) => askFlush(this.runtime.get(t.id)!.view.webContents, "close")));
    this.dispatch({ type: "drop-file", fileKey });
  }

  /** Whether the store still has a file outside the trash ("unknown" without a store); its name when it has. */
  private async fileState(fileKey: string): Promise<"gone" | "unknown" | { name: string }> {
    let store;
    try {
      store = await readyStore();
    } catch {
      return "unknown";
    }
    try {
      const file = await store.workspace.getFile(fileKey);
      return file.trashedAt ? "gone" : { name: file.name };
    } catch (err) {
      return isStoreError(err) && (err.code === "not-found" || err.code === "trashed") ? "gone" : "unknown";
    }
  }

  /** A file just opened without a name: the store's name, or the tab closes if the file isn't there. */
  private async checkFile(fileKey: string) {
    const state = await this.fileState(fileKey);
    if (state === "gone") this.dispatch({ type: "drop-file", fileKey });
    else if (state !== "unknown") this.dispatch({ type: "retitle-file", fileKey, title: state.name });
  }

  /** At launch (docs/desktop.md §4.4): kept file tabs and closed entries whose file is gone or in the trash are dropped; names refreshed. */
  private async dropMissingFiles() {
    const keys = new Set([...this.state.tabs.map((t) => t.fileKey), ...this.state.closed.map((c) => c.fileKey)].filter(Boolean));
    await Promise.all([...keys].map((k) => this.checkFile(k)));
  }

  // ── Native file dialogs ──

  /** .fig files into a folder (docs/desktop.md `file:import`); failures told in one box. */
  async importFiles(folderId: string | null, paths?: string[]): Promise<ImportResult> {
    let result: ImportResult;
    try {
      result = await importFiles(this.ctl.win, folderId, paths);
    } catch (err) {
      result = { files: [], failed: [{ path: "", error: err instanceof Error ? err.message : String(err) }] };
    }
    if (result.failed.length) {
      const names = result.failed.map((f) => `${f.path.split("/").pop() || t("The file")}: ${f.error}`).join("\n");
      void tellFileError(this.ctl.win, tp(result.failed.length, "The file couldn’t be imported.", "{n} files couldn’t be imported."), names);
    }
    return result;
  }

  /** A developer preview as an HTML file (`file:export-preview`); the editor made the snapshot itself. */
  exportPreview(fileKey: string, snapshot: Uint8Array, options: { pageIds: string[] | "all"; inspect: boolean; export: boolean }): Promise<{ path: string; bytes: number } | { cancelled: true }> {
    return exportPreview(this.ctl.win, fileKey, snapshot, options);
  }

  /** A file as a .fig (`file:save-local-copy`); its open tab flushes first so the copy has its last changes. */
  async saveLocalCopy(fileKey: string, opts: { partial?: boolean } = {}): Promise<{ path: string } | { cancelled: true }> {
    const open = this.state.tabs.find((t) => t.kind === "file" && t.fileKey === fileKey && this.runtime.has(t.id));
    if (open) await askFlush(this.runtime.get(open.id)!.view.webContents, "hide");
    try {
      return await saveLocalCopy(this.ctl.win, fileKey, opts);
    } catch (err) {
      await tellFileError(this.ctl.win, t("The local copy couldn’t be saved."), err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ── Saving ──

  /**
   * A file tab's flush, with the native questions when it fails or times out
   * (docs/desktop.md §6): true once it is saved or let go, false when the
   * person stayed.
   */
  private async settleFile(id: string, action: "close" | "quit"): Promise<boolean> {
    for (;;) {
      const rt = this.runtime.get(id);
      const tab = this.tab(id);
      if (!rt || !tab || rt.crashed || tab.kind === "new-tab") return true;
      const outcome = await askFlush(rt.view.webContents, action === "quit" ? "quit" : "close");
      if ("ok" in outcome && outcome.ok) return true;
      if ("timeout" in outcome) {
        if ((await askFlushTimeout(this.ctl.win, tab.title, action)) === "go") return true;
        continue;
      }
      const answer = await askFlushFailed(this.ctl.win, tab.title, outcome.error, action);
      if (answer === "go") return true;
      if (answer === "cancel") return false;
    }
  }

  /** Every loaded file tab flushed together, without questions (the Mac sleeps or locks). */
  async flushQuietly() {
    await Promise.all(this.state.tabs.filter((t) => t.kind !== "new-tab" && this.runtime.has(t.id) && !this.runtime.get(t.id)!.crashed).map((t) => askFlush(this.runtime.get(t.id)!.view.webContents, "hide")));
  }

  /** Tabs closed, each flushed first: false when the person kept one (a failed flush, Cancel). */
  async close(ids: string[]): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      for (const id of ids) {
        if (!this.tab(id)) continue;
        if (!(await this.settleFile(id, "close"))) return false;
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

  /** Before the window closes or the app quits: every file flushed — false when the person stayed. */
  async settleAll(action: "close" | "quit"): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const loaded = this.state.tabs.filter((t) => t.kind !== "new-tab" && this.runtime.has(t.id));
      // All at once; a question only for one that failed or timed out.
      const flushAction = action;
      const outcomes = await Promise.all(loaded.map(async (t) => ({ t, outcome: this.runtime.get(t.id)!.crashed ? ({ ok: true } as const) : await askFlush(this.runtime.get(t.id)!.view.webContents, flushAction) })));
      for (const { t, outcome } of outcomes) {
        if ("ok" in outcome && outcome.ok) continue;
        if ("timeout" in outcome) {
          if ((await askFlushTimeout(this.ctl.win, t.title, flushAction)) === "go") continue;
          if (!(await this.settleFile(t.id, flushAction))) return false;
          continue;
        }
        const answer = await askFlushFailed(this.ctl.win, t.title, outcome.error, flushAction);
        if (answer === "cancel") return false;
        if (answer === "retry" && !(await this.settleFile(t.id, flushAction))) return false;
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * The tab's native context menu, at the tab bar's point — Figma's (atlas 01 §2.4): Pin / Unpin, Copy Link, Rename
   * File, Reload, —, Add to / Remove from Tab Group, —, Close, Close Other Tabs, Close All Tabs. The new-tab page's:
   * Reload, —, Close; Home's: Copy Link, —, Reload. Not here yet: Move to (Another / New) Window (one window), Open in
   * Split Tab, Open in Browser (a local file has no web address).
   */
  contextMenu(id: string, x: number, y: number) {
    const { tabs } = this.state;
    const tab = tabs.find((o) => o.id === id);
    const loaded = this.runtime.has(id);
    const reload: MenuItemConstructorOptions = { label: t("Reload"), enabled: id === HOME || loaded, click: () => (id === HOME ? this.reloadHome() : this.reload(id)) };
    // A file's link needs deep links (docs/desktop.md §15), not built yet.
    const copyLink: MenuItemConstructorOptions = { label: t("Copy Link"), accelerator: "CmdOrCtrl+L", enabled: false };
    const close: MenuItemConstructorOptions = { label: t("Close"), click: () => void this.close([id]) };
    let items: MenuItemConstructorOptions[];
    if (id === HOME) items = [copyLink, { type: "separator" }, reload];
    else if (!tab) return;
    else if (tab.kind === "new-tab") items = [reload, { type: "separator" }, close];
    else {
      const groups = groupsOf(this.state);
      const group: MenuItemConstructorOptions[] = tab.pinned
        ? []
        : tab.groupId
          ? [{ label: t("Remove from Tab Group"), click: () => this.dispatch({ type: "group-remove", ids: [id] }) }]
          : [
              {
                label: t("Add to Tab Group"),
                submenu: [
                  { label: t("New Tab Group"), click: () => this.dispatch({ type: "group-add", ids: [id], groupId: newTabId() }) },
                  ...(groups.length ? [{ type: "separator" as const }, ...groups.map((g) => ({ label: groupName(g), click: () => this.dispatch({ type: "group-add", ids: [id], groupId: g.id }) }))] : []),
                ],
              },
            ];
      items = [
        { label: tab.pinned ? t("Unpin") : t("Pin"), click: () => this.dispatch({ type: "pin", id, pinned: !tab.pinned }) },
        copyLink,
        // The editor renames in place (its title field), once it is there.
        ...(tab.kind === "file" ? [{ label: t("Rename File"), enabled: loaded && tab.status === "ready", click: () => this.renameInPlace(id) }] : []),
        reload,
        { type: "separator" },
        ...group,
        ...(group.length ? [{ type: "separator" as const }] : []),
        close,
        { label: t("Close Other Tabs"), enabled: tabs.length > 1, click: () => void this.close(tabs.filter((o) => o.id !== id).map((o) => o.id)) },
        { label: t("Close All Tabs"), click: () => void this.close(tabs.map((o) => o.id)) },
      ];
    }
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, x: Math.round(x * zoomFactor()), y: Math.round(y * zoomFactor()) });
  }

  /** Rename File: the tab in front, then its editor's own rename (the title field). */
  private renameInPlace(id: string) {
    this.activate(id);
    const rt = this.runtime.get(id);
    if (rt) emit(rt.view.webContents, "menu:command", { id: "file.rename", source: "menu" });
  }

  /** A tab group's native menu (atlas 01 §2.3): Edit group name, Group color, Ungroup, Delete group. */
  groupMenu(groupId: string, x: number, y: number) {
    const group = groupsOf(this.state).find((g) => g.id === groupId);
    if (!group) return;
    const items: MenuItemConstructorOptions[] = [
      { label: t("Edit group name"), click: () => emit(this.ctl.tabbar.webContents, "tabs:edit-group", { groupId }) },
      {
        label: t("Group color"),
        submenu: GROUP_COLORS.map((color) => ({ label: t(GROUP_COLOR_NAMES[color]), type: "radio" as const, checked: group.color === color, click: () => this.dispatch({ type: "group-set", groupId, color }) })),
      },
      { type: "separator" },
      { label: t("Ungroup"), click: () => this.dispatch({ type: "ungroup", groupId }) },
      // Its tabs closed, each flushed first as any close.
      { label: t("Delete group"), click: () => void this.close(this.state.tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id)) },
    ];
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, x: Math.round(x * zoomFactor()), y: Math.round(y * zoomFactor()) });
  }

  /**
   * "Open and recently closed tabs" at the bar's right end (atlas 01 §2.5): the window's tabs, then the recently closed
   * ones, newest first. Ours is a native menu — the tab bar's view can't draw past its 38px — so it has no search field.
   */
  listMenu(x: number, y: number) {
    const { tabs, closed, active } = this.state;
    const items: MenuItemConstructorOptions[] = [];
    if (!tabs.length && !closed.length) items.push({ label: t("Your open tabs and recently closed tabs will appear here"), enabled: false });
    if (tabs.length) {
      items.push({ label: t("Tabs in this window"), enabled: false });
      for (const tab of tabs) items.push({ label: tab.kind === "new-tab" ? t("New tab") : tab.title, type: "checkbox", checked: tab.id === active, click: () => this.activate(tab.id) });
    }
    if (closed.length) {
      if (tabs.length) items.push({ type: "separator" });
      items.push({ label: t("Recently closed tabs"), enabled: false });
      for (const entry of closed) items.push({ label: entry.title, click: () => void this.reopenClosed(entry) });
    }
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, x: Math.round(x * zoomFactor()), y: Math.round(y * zoomFactor()) });
  }

  // ── The menu bar (src/shared/commands.ts; docs/desktop.md §8) ──

  /** A view's `menu:state`, merged into what it said before; applied at once if it is in front. */
  setMenuState(sender: WebContents, patch: MenuStatePatch) {
    const info = viewOf(sender);
    // A new-tab page is a Home view of its tab's own.
    const id = info?.role === "home" ? (info.tabId ?? HOME) : info?.tabId;
    if (!id || (id !== HOME && !this.runtime.has(id))) return;
    const state = this.menuStates.get(id) ?? { enabled: {}, checked: {} };
    for (const [key, value] of Object.entries(patch?.enabled ?? {})) if (isCommandId(key) && typeof value === "boolean") state.enabled[key] = value;
    for (const [key, value] of Object.entries(patch?.checked ?? {})) if (isCommandId(key) && typeof value === "boolean") state.checked[key] = value;
    this.menuStates.set(id, state);
    if (id === (this.shown ?? HOME)) this.applyMenu();
  }

  /** Whether a menu item is enabled now, for the view in front (§8.4's defaults). */
  private menuEnabled(id: CommandId): boolean {
    const spec = commandSpec(id);
    const front = this.shown ?? HOME;
    const tab = front === HOME ? undefined : this.tab(front);
    const reported = this.menuStates.get(front)?.enabled[id];
    switch (spec.scope) {
      case "app":
        return true;
      case "shell":
        if (id === "file.close-tab") return Boolean(tab);
        if (id === "file.reopen-closed-tab") return this.snapshot().canReopen;
        return true;
      case "view":
        // Home: Undo and Redo act on its text fields; the rest as it says (Select all, Move to trash follow its selection).
        if (!tab) return id === "edit.undo" || id === "edit.redo" || reported === true;
        // Main writes a file's local copy itself.
        if (id === "file.save-local-copy") return true;
        return reported === true;
      case "editor":
        return Boolean(tab) && reported === true;
    }
  }

  /** The menu bar's items set for the view in front: enabled and checked (mutated in place, never rebuilt). */
  applyMenu() {
    const menu = Menu.getApplicationMenu();
    // Signed out (the window closing for Log out): the menu stays as the gate set it (docs/desktop.md §18.6).
    if (!menu || this.ctl.win.isDestroyed() || menuSignedOut()) return;
    const checked = this.menuStates.get(this.shown ?? HOME)?.checked ?? {};
    for (const id of layoutCommands()) {
      const item = menu.getMenuItemById(id);
      if (!item) continue;
      const enabled = this.menuEnabled(id);
      if (item.enabled !== enabled) item.enabled = enabled;
      // An app item's check is main's own (Disable Hardware Acceleration, menu.ts); the rest are the view's.
      if (commandSpec(id).kind === "checkbox" && commandSpec(id).scope !== "app") {
        const on = checked[id] === true;
        if (item.checked !== on) item.checked = on;
      }
    }
  }

  command(id: CommandId, source: "menu" | "accelerator", focused?: WebContents | null) {
    const { active } = this.state;
    switch (id) {
      case "file.new":
        return void this.newFile({}).catch((err) => console.warn("[tabs] new file:", err));
      case "file.new-tab":
        return this.newTab();
      case "file.open-file-browser":
        return this.goHome();
      case "file.import":
        return void this.importFiles(null).then((r) => {
          // From the menu: Home shows the first one.
          if (r.files[0]) this.goHome(r.files[0].fileKey);
        });
      case "file.close-tab":
        if (active !== HOME) void this.close([active]);
        return;
      case "file.reopen-closed-tab":
        return void this.reopen();
      case "file.close-window":
        // Through the window's own closing: files flushed, unsaved tabs asked about first.
        return this.ctl.win.close();
      case "file.save-local-copy": {
        const tab = this.tab(this.shown ?? HOME);
        if (tab) return void this.saveLocalCopy(tab.fileKey).catch(() => {});
        return emit(this.home.webContents, "menu:command", { id, source });
      }
      case "app.theme-light":
      case "app.theme-dark":
      case "app.theme-system":
        setThemePreference(id === "app.theme-light" ? "light" : id === "app.theme-dark" ? "dark" : "system");
        return;
      case "help.open-data-folder":
        return void shell.openPath(workspaceDir());
      case "app.interface-scale-reset":
        return void setInterfaceScale(DEFAULT_ZOOM_STOP);
      case "app.interface-scale-larger":
        return void stepInterfaceScale(1);
      case "app.interface-scale-smaller":
        return void stepInterfaceScale(-1);
      case "app.disable-hardware-acceleration":
        // Cancelled, the check goes back to what is kept.
        return void toggleHardwareAcceleration(this.ctl.win).then(() => refreshAppMenu());
      case "app.graphics-backend-default":
      case "app.graphics-backend-webgl2":
      case "app.graphics-backend-webgpu":
        return setGraphicsBackend(id === "app.graphics-backend-webgl2" ? "webgl2" : id === "app.graphics-backend-webgpu" ? "webgpu" : "default");
      case "app.reload-all-tabs":
        return reloadAllTabs();
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
    }
    const n = Number(/^window\.tab-(\d)$/.exec(id)?.[1]);
    if (n) {
      const target = tabAtShortcut(this.state, n);
      if (target) this.activate(target);
      return;
    }
    const scope = commandSpec(id).scope;
    if (scope === "view" && NATIVE_EDIT.has(id)) {
      // The view with the focus: an editor gets it as a command (its own model, not the DOM's). Home gets Select all and
      // Move to trash chosen from the menu (its file selection); a key it left unhandled, and Undo/Redo, act on its text field.
      const contents = focused && viewOf(focused)?.windowId === this.ctl.id ? focused : this.activeView().webContents;
      const role = viewOf(contents)?.role;
      if (role === "editor" || (role === "home" && source === "menu" && HOME_EDIT.has(id))) return emit(contents, "menu:command", { id, source });
      if (id === "edit.undo") contents.undo();
      else if (id === "edit.redo") contents.redo();
      else if (id === "edit.select-all") contents.selectAll();
      else contents.delete();
      return;
    }
    // The rest is the view in front's: Home takes `view` commands, a file tab `view` and `editor` ones.
    const front = this.shown ?? HOME;
    if (front === HOME) {
      if (scope === "view") emit(this.home.webContents, "menu:command", { id, source });
      return;
    }
    const rt = this.runtime.get(front);
    if (rt && (scope === "view" || scope === "editor")) emit(rt.view.webContents, "menu:command", { id, source });
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
    this.offWorkspace();
    this.offFocus();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.spare.destroy();
    for (const rt of this.runtime.values()) destroyView(rt.view);
    this.runtime.clear();
    destroyView(this.home);
  }

  /** For tests (scripts/drive.mjs): which tab has which view and process, the spare editor, the last opens. */
  debug() {
    const spare = this.spare.view();
    const pidOf = (view: WebContentsView) => (view.webContents.isDestroyed() ? 0 : view.webContents.getOSProcessId());
    return {
      shown: this.shown,
      state: this.state,
      views: [
        { id: HOME, role: "home", webContentsId: this.home.webContents.id, pid: pidOf(this.home), visible: this.shown === HOME, url: this.home.webContents.getURL() },
        ...[...this.runtime.entries()].map(([id, rt]) => ({ id, role: this.tab(id)?.kind === "new-tab" ? "new-tab" : "editor", webContentsId: rt.view.webContents.id, pid: pidOf(rt.view), visible: this.shown === id, url: rt.view.webContents.getURL(), crashed: rt.crashed })),
        ...(spare ? [{ id: "spare", role: "editor", spare: true, webContentsId: spare.webContents.id, pid: pidOf(spare), visible: false, url: spare.webContents.getURL(), loading: spare.webContents.isLoading(), since: this.spare.since() }] : []),
      ],
      spareEnabled: this.spare.enabled,
      opens: this.opens,
      menu: Object.fromEntries(this.menuStates),
    };
  }
}
