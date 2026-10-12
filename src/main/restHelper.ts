/**
 * The render helper (docs/multiplayer.md §16.6): when a file's room has nobody who can answer a REST API request,
 * the server puts `{t: "rest-wanted", fileKey}` on the inboxes of its owner and editors; the store says it as a
 * `multiplayer` event (`restWanted`) for this installation's copy. Main then opens that file — only one the person
 * owns, and only while Settings › Account › "Answer API requests for my files while Designer is open" is on (the
 * default) — in a **hidden editor view** (no tab, never shown, `?editor&file=…&restHelper`), whose editor joins the
 * room with `hello {render: true, helper: true}` and answers the jobs. A helper closes after five minutes without a
 * job, and as soon as the file is open in a tab (that editor answers then).
 *
 * The policy lives in `RestHelper` with the window's parts injected, so it is tested without Electron
 * (restHelper.test.ts); `initRestHelper` wires it to the store, the views and the account (index.ts, one line).
 */
import type { MultiplayerEvent } from "../shared/multiplayer/types";

/** A helper with no job for this long is closed */
export const HELPER_IDLE_MS = 5 * 60_000;
/** How often helpers are checked (idle, open in a tab) */
export const HELPER_SWEEP_MS = 30_000;
/** At most this many files at once (each is a renderer process) */
export const MAX_HELPERS = 3;
/** The setting is read again after this long */
export const SETTING_FRESH_MS = 60_000;

export interface RestHelperHost<V> {
  /** A hidden editor view on the file */
  open(fileKey: string): V | null;
  close(view: V): void;
  /** A tab (not a helper) has the file open */
  openElsewhere(fileKey: string): boolean;
  /** Settings › Account's switch (`AccountPrefs.restHelper`, default on); false signed out */
  enabled(): Promise<boolean>;
  now?(): number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(t: unknown): void };
  log?(message: string): void;
}

export class RestHelper<V> {
  private helpers = new Map<string, { view: V; lastJob: number }>();
  private setting: { on: boolean; at: number } | null = null;
  private timer: unknown;
  private readonly now: () => number;
  private readonly timers: NonNullable<RestHelperHost<V>["timers"]>;
  private opening = new Set<string>();

  constructor(private readonly host: RestHelperHost<V>) {
    this.now = host.now ?? Date.now;
    this.timers = host.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>) };
    this.timer = this.timers.setInterval(() => this.sweep(), HELPER_SWEEP_MS);
  }

  /** The files a helper has open (debug, tests) */
  open(): string[] {
    return [...this.helpers.keys()];
  }

  /** A `multiplayer` event from the store */
  async onEvent(e: MultiplayerEvent): Promise<void> {
    const h = this.helpers.get(e.fileKey);
    if (e.restJob && h) h.lastJob = this.now();
    if (!e.restWanted || h || this.opening.has(e.fileKey)) return;
    // Only the files the person owns (the owner's decision, 2026-10-11), not open in a tab, a few at a time
    if (e.state.role !== "owner" || this.host.openElsewhere(e.fileKey) || this.helpers.size >= MAX_HELPERS) return;
    this.opening.add(e.fileKey);
    try {
      if (!(await this.enabled())) return;
      if (this.helpers.has(e.fileKey) || this.host.openElsewhere(e.fileKey)) return;
      const view = this.host.open(e.fileKey);
      if (view) {
        this.helpers.set(e.fileKey, { view, lastJob: this.now() });
        this.host.log?.(`[rest] helper opened for ${e.fileKey}`);
      }
    } finally {
      this.opening.delete(e.fileKey);
    }
  }

  /** Helpers idle too long, or whose file a tab opened, close */
  sweep(): void {
    const now = this.now();
    for (const [fileKey, h] of this.helpers) {
      if (now - h.lastJob < HELPER_IDLE_MS && !this.host.openElsewhere(fileKey)) continue;
      this.helpers.delete(fileKey);
      this.host.close(h.view);
      this.host.log?.(`[rest] helper closed for ${fileKey}`);
    }
  }

  /** The switch changed: off closes the helpers (the switch is otherwise read again a minute on) */
  settingChanged(on?: boolean): void {
    this.setting = on === undefined ? null : { on, at: this.now() };
    if (on !== false) return;
    for (const [fileKey, h] of this.helpers) {
      this.helpers.delete(fileKey);
      this.host.close(h.view);
    }
  }

  dispose(): void {
    this.timers.clearInterval(this.timer);
    for (const h of this.helpers.values()) this.host.close(h.view);
    this.helpers.clear();
  }

  private async enabled(): Promise<boolean> {
    if (this.setting && this.now() - this.setting.at < SETTING_FRESH_MS) return this.setting.on;
    const on = await this.host.enabled().catch(() => false);
    this.setting = { on, at: this.now() };
    return on;
  }
}

/**
 * Electron's side: the store's events (watched again after a store restart), hidden views in the front window's
 * process registry (never added to it), the account's profile for the switch. Loaded lazily, so tests of the policy
 * don't load Electron.
 */
export function initRestHelper(): () => void {
  let stop = false;
  let dispose: (() => void) | null = null;
  void (async () => {
    const [{ createView, destroyView, allViews }, { storeClient }, { controllers }, { accountRequest, sessionToken }] = await Promise.all([import("./views"), import("./storeHost"), import("./window"), import("./account")]);
    if (stop) return;
    type View = ReturnType<typeof createView>;
    const helperIds = new Set<number>();
    const helper = new RestHelper<View>({
      open: (fileKey) => {
        const ctl = [...controllers.values()][0];
        if (!ctl) return null;
        const view = createView("editor", ctl.id, null, { editor: "", file: fileKey, restHelper: "" }, fileKey);
        view.webContents.setBackgroundThrottling(false);
        helperIds.add(view.webContents.id);
        view.webContents.once("destroyed", () => helperIds.delete(view.webContents.id));
        return view;
      },
      close: (view) => destroyView(view),
      openElsewhere: (fileKey) => allViews().some(([id, info]) => info.role === "editor" && info.fileKey === fileKey && !helperIds.has(id)),
      enabled: async () => {
        if (!sessionToken()) return false;
        const r = await accountRequest({ method: "GET", path: "/me/profile" });
        if (r.status !== 200) return false;
        return (r.body as { prefs?: { restHelper?: unknown } } | null)?.prefs?.restHelper !== false;
      },
      log: (m) => console.log(m),
    });
    // The store's client changes when the store restarts: watched again
    let watched: unknown = null;
    let off: (() => void) | null = null;
    const attach = () => {
      const client = storeClient();
      if (client === watched) return;
      off?.();
      off = null;
      watched = client;
      if (client) off = client.multiplayer.watch((e) => void helper.onEvent(e));
    };
    attach();
    const poll = setInterval(attach, 5000);
    dispose = () => {
      clearInterval(poll);
      off?.();
      helper.dispose();
    };
  })().catch((e) => console.warn("[rest] the render helper didn't start:", e));
  return () => {
    stop = true;
    dispose?.();
  };
}
