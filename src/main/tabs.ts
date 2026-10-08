import { Menu, shell, type MenuItemConstructorOptions, type WebContents, type WebContentsView } from "electron";
import { command as commandSpec, isCommandId, layoutCommands, type CommandId, type MenuStatePatch } from "../shared/commands";
import type { FlushReason, HomeState, ImportResult, IpcEvents, NewFileResult, OpenFileResult, OpenWorkspaceFile, TabFlushed, TabsSnapshot } from "../shared/ipc";
import { HOME, neighbourTab, tabAtShortcut, tabsReducer, type Tab, type TabReport, type TabsAction, type TabsState } from "../shared/tabs";
import { isStoreError } from "../shared/store/protocol";
import type { WorkspaceEvent } from "../shared/store/repositories";
import { askCrashed, askFlushFailed, askFlushTimeout, askUnresponsive, tellFileError } from "./dialogs";
import { importFiles, saveLocalCopy } from "./files";
import { onWorkspaceEvent, readyStore, storeClient, workspaceDir } from "./storeHost";
import { SpareEditor } from "./spare";
import { setThemePreference } from "./theme";
import { adoptView, createView, destroyView, viewOf } from "./views";
import type { WindowController } from "./window";

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
 */

export const FLUSH_TIMEOUT_MS = 3000;

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
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error || "The file couldn’t be saved." });
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
    void this.dropMissingFiles();
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
  private ensure(tab: Tab): Runtime {
    const there = this.runtime.get(tab.id);
    if (there) return there;
    const adopted = this.spare.adopt({ tabId: tab.id, fileKey: tab.fileKey, mode: "edit" });
    const view = adopted ?? this.addView("editor", tab.id, { editor: "", file: tab.fileKey, tab: tab.id }, tab.fileKey);
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
    const again = () => {
      if (this.runtime.get(id) !== rt) return;
      rt.crashed = false;
      this.dispatch({ type: "status", id, status: "loading" });
      rt.view.webContents.reload();
    };
    if (!rt.crashed) void askFlush(rt.view.webContents, "reload").then(again);
    else again();
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
      const was = before && before !== HOME ? this.runtime.get(before) : undefined;
      if (was) {
        emit(was.view.webContents, "tab:visibility", { visible: false });
        // Hidden: what it holds goes to the store now (nobody waits for the answer).
        if (!was.crashed) void askFlush(was.view.webContents, "hide");
      }
      if (tab) emit(target.webContents, "tab:visibility", { visible: true });
      // Recents (docs/desktop.md §5 step 6).
      if (tab) void storeClient()?.workspace.recordViewed(tab.fileKey).catch(() => {});
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
    };
  }

  homeState(): HomeState {
    return { visible: this.shown === HOME, openFileKeys: this.state.tabs.map((t) => t.fileKey) };
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
    else this.dispatch({ type: "activate", id });
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
  openFile(file: OpenWorkspaceFile, requestedAt = Date.now()): OpenFileResult {
    const find = () => this.state.tabs.find((t) => t.fileKey === file.fileKey);
    const existing = Boolean(find());
    this.openRequest = { at: requestedAt, fileKey: file.fileKey };
    this.dispatch({ type: "open", fileKey: file.fileKey, title: file.title, background: file.background });
    const tab = find();
    if (!tab) return { tabId: HOME, existing };
    // A name to show: the store's (Home usually hands it over), and a file that isn't there any more closes again.
    if (!existing && !file.title) void this.checkFile(file.fileKey);
    return { tabId: tab.id, existing };
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
      return this.dispatch({ type: "reopen" });
    }
  }

  /** A new design file (Drafts unless a folder is given), created by the store and opened ("+", ⌘N, Home's New design file). */
  async newFile(request: { folderId?: string | null; name?: string } = {}): Promise<NewFileResult> {
    const requestedAt = Date.now();
    const store = await readyStore();
    const meta = await store.workspace.createFile({ name: request.name, folderId: request.folderId ?? null });
    const { tabId } = this.openFile({ fileKey: meta.fileKey, title: meta.name }, requestedAt);
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
    const keys = new Set([...this.state.tabs.map((t) => t.fileKey), ...this.state.closed.map((c) => c.fileKey)]);
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
      const names = result.failed.map((f) => `${f.path.split("/").pop() || "The file"}: ${f.error}`).join("\n");
      void tellFileError(this.ctl.win, result.failed.length === 1 ? "The file couldn’t be imported." : `${result.failed.length} files couldn’t be imported.`, names);
    }
    return result;
  }

  /** A file as a .fig (`file:save-local-copy`); its open tab flushes first so the copy has its last changes. */
  async saveLocalCopy(fileKey: string): Promise<{ path: string } | { cancelled: true }> {
    const open = this.state.tabs.find((t) => t.fileKey === fileKey && this.runtime.has(t.id));
    if (open) await askFlush(this.runtime.get(open.id)!.view.webContents, "hide");
    try {
      return await saveLocalCopy(this.ctl.win, fileKey);
    } catch (err) {
      await tellFileError(this.ctl.win, "The local copy couldn’t be saved.", err instanceof Error ? err.message : String(err));
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
      if (!rt || !tab || rt.crashed) return true;
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
    await Promise.all(this.state.tabs.filter((t) => this.runtime.has(t.id) && !this.runtime.get(t.id)!.crashed).map((t) => askFlush(this.runtime.get(t.id)!.view.webContents, "hide")));
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
      const loaded = this.state.tabs.filter((t) => this.runtime.has(t.id));
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

  /** The tab's native context menu, at the tab bar's point. */
  contextMenu(id: string, x: number, y: number) {
    const { tabs, closed } = this.state;
    const at = tabs.findIndex((t) => t.id === id);
    const tab = tabs[at];
    const reopen = { label: "Reopen closed tab", accelerator: "CmdOrCtrl+Shift+T", enabled: closed.length > 0, click: () => void this.reopen() };
    const items: MenuItemConstructorOptions[] = !tab
      ? [reopen]
      : [
          { label: "Close tab", accelerator: "CmdOrCtrl+W", click: () => void this.close([id]) },
          { label: "Close other tabs", enabled: tabs.length > 1, click: () => void this.close(tabs.filter((t) => t.id !== id).map((t) => t.id)) },
          { label: "Close tabs to the right", enabled: at < tabs.length - 1, click: () => void this.close(tabs.slice(at + 1).map((t) => t.id)) },
          { type: "separator" },
          // A file's link needs deep links (docs/desktop.md §15), not built yet.
          { label: "Copy link", enabled: false },
          { label: "Show in file browser", click: () => this.goHome(tab.fileKey) },
          { type: "separator" },
          reopen,
        ];
    Menu.buildFromTemplate(items).popup({ window: this.ctl.win, x: Math.round(x), y: Math.round(y) });
  }

  // ── The menu bar (src/shared/commands.ts; docs/desktop.md §8) ──

  /** A view's `menu:state`, merged into what it said before; applied at once if it is in front. */
  setMenuState(sender: WebContents, patch: MenuStatePatch) {
    const info = viewOf(sender);
    const id = info?.role === "home" ? HOME : info?.tabId;
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
    if (!menu || this.ctl.win.isDestroyed()) return;
    const checked = this.menuStates.get(this.shown ?? HOME)?.checked ?? {};
    for (const id of layoutCommands()) {
      const item = menu.getMenuItemById(id);
      if (!item) continue;
      const enabled = this.menuEnabled(id);
      if (item.enabled !== enabled) item.enabled = enabled;
      if (commandSpec(id).kind === "checkbox") {
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
        ...[...this.runtime.entries()].map(([id, rt]) => ({ id, role: "editor", webContentsId: rt.view.webContents.id, pid: pidOf(rt.view), visible: this.shown === id, url: rt.view.webContents.getURL(), crashed: rt.crashed })),
        ...(spare ? [{ id: "spare", role: "editor", spare: true, webContentsId: spare.webContents.id, pid: pidOf(spare), visible: false, url: spare.webContents.getURL(), loading: spare.webContents.isLoading(), since: this.spare.since() }] : []),
      ],
      spareEnabled: this.spare.enabled,
      opens: this.opens,
      menu: Object.fromEntries(this.menuStates),
    };
  }
}
