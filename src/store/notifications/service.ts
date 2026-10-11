/**
 * The store's `notifications` repository (docs/multiplayer.md §12): Figma's bell. The server keeps them
 * (server/src/notifications.ts); while a session is on, this service holds the person's inbox socket
 * (`/notifications/ws`, a per-user Durable Object) and turns its messages into `notifications` events — Home's bell
 * and main's desktop notifications follow them without polling. No Node or DOM imports: the desktop store and the
 * browser's dev store both run it.
 */
import {
  cleanPrefs,
  DEFAULT_NOTIFICATION_PREFS,
  type InboxMessage,
  type NotificationPage,
  type NotificationPrefs,
  type NotificationQuery,
  type NotificationsEvent,
  type NotificationsRepository,
} from "../../shared/notifications";
import type { MultiplayerSession } from "../../shared/multiplayer/types";
import type { Unsubscribe } from "../../shared/store/repositories";
import type { MultiplayerDeps, MultiplayerService } from "../multiplayer/service";

type Socket = InstanceType<MultiplayerDeps["WebSocket"]>;

export interface NotificationsDeps {
  WebSocket: MultiplayerDeps["WebSocket"];
  /** Milliseconds before reconnect attempt n (1, 2, …) */
  backoff?(attempt: number): number;
  /** Keep-alive period (the inbox answers "ping" without waking); 0 = none */
  pingMs?: number;
}

/**
 * A change in an org the person is in (docs/multiplayer.md §14.6, §14.11): `what` names what changed — "orgs" (their
 * memberships, role or seat), "org", "teams", "team" (+teamId), "projects" (+teamId, parentId), "files" (+projectId,
 * null: drafts) — or is an OrgEvent's own type ("teams.changed", …).
 */
export interface OrgNotice {
  t: "org";
  orgId?: string;
  what?: string;
  teamId?: string;
  parentId?: string | null;
  projectId?: string | null;
}

/**
 * A library's change (docs/data.md §16.7): a new version, or its status (unpublished, trashed, restored, deleted). The
 * org libraries' registry turns it into a LibraryEvent (src/store/libraries/org.ts).
 */
export interface LibraryNotice {
  t: "library";
  libraryKey: string;
  version?: number;
  status?: "published" | "unpublished" | "trashed" | "deleted";
}

/** An org's or team's shared fonts changed (docs/desktop.md §14.3): forwarded on the store's topic `fonts` */
export interface FontsNotice {
  t: "fonts";
  orgId: string;
  version: string;
}

const EMPTY: NotificationPage = { items: [], unread: 0, pending: 0, files: [], next: null };

export class NotificationsService {
  private listeners = new Set<(e: NotificationsEvent) => void>();
  private ws: Socket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private off: Unsubscribe;
  /** Signed out: the choices made here are kept until a session takes them */
  private localPrefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
  /** The last counts heard (a new listener's first event) */
  private counts = { unread: 0, pending: 0 };

  constructor(
    private mp: MultiplayerService,
    private deps: NotificationsDeps,
  ) {
    this.off = mp.onSession((s) => this.follow(s));
    if (mp.signedIn) this.connect();
  }

  close(): void {
    this.off();
    this.disconnect();
  }

  onChange(listener: (e: NotificationsEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private orgListeners = new Set<(n: OrgNotice) => void>();
  /** `{t: "org", …}` notices from the inbox (the org spaces' cache follows them: src/store/org/service.ts) */
  onOrg(listener: (n: OrgNotice) => void): Unsubscribe {
    this.orgListeners.add(listener);
    return () => this.orgListeners.delete(listener);
  }

  private libraryListeners = new Set<(n: LibraryNotice) => void>();
  /** `{t: "library", …}` notices from the inbox (org libraries' updates, docs/data.md §16.7) */
  onLibrary(listener: (n: LibraryNotice) => void): Unsubscribe {
    this.libraryListeners.add(listener);
    return () => this.libraryListeners.delete(listener);
  }

  private fontsListeners = new Set<(n: FontsNotice) => void>();
  /** `{t: "fonts", …}` notices from the inbox (shared fonts, docs/desktop.md §14.3) */
  onFonts(listener: (n: FontsNotice) => void): Unsubscribe {
    this.fontsListeners.add(listener);
    return () => this.fontsListeners.delete(listener);
  }

  private pluginsListeners = new Set<(n: { t: "plugins"; orgId: string }) => void>();
  /** `{t: "plugins", orgId}` notices from the inbox (an org's private plugins, approvals or requests, docs/plugins.md §10) */
  onPlugins(listener: (n: { t: "plugins"; orgId: string }) => void): Unsubscribe {
    this.pluginsListeners.add(listener);
    return () => this.pluginsListeners.delete(listener);
  }

  /** The inbox socket opened again: what changed while it was closed is unknown */
  private reconnectListeners = new Set<() => void>();
  onReconnect(listener: () => void): Unsubscribe {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** The counts as last heard */
  get unread(): { unread: number; pending: number } {
    return { ...this.counts };
  }

  async list(query: NotificationQuery = {}): Promise<NotificationPage> {
    if (!this.mp.signedIn) return EMPTY;
    const q = new URLSearchParams();
    if (query.filter === "requests" || query.filter === "unread") q.set("filter", query.filter);
    if (typeof query.fileKey === "string" && query.fileKey) q.set("file", query.fileKey);
    if (typeof query.before === "string" && query.before) q.set("before", query.before);
    if (Number.isInteger(query.limit) && query.limit! > 0) q.set("limit", String(query.limit));
    const s = q.toString();
    const page = await this.mp.call<NotificationPage>("GET", `/notifications${s ? `?${s}` : ""}`);
    this.heard(page.unread, page.pending);
    return page;
  }

  async markRead(input: { ids?: string[]; all?: boolean; read?: boolean }): Promise<{ unread: number }> {
    if (!this.mp.signedIn) return { unread: 0 };
    const ids = Array.isArray(input?.ids) ? input.ids.filter((s) => typeof s === "string") : undefined;
    const r = await this.mp.call<{ unread: number; pending: number }>("POST", "/notifications/read", { ...(input?.all === true ? { all: true } : { ids: ids ?? [] }), read: input?.read !== false });
    this.heard(r.unread, r.pending);
    return { unread: r.unread };
  }

  async prefs(): Promise<NotificationPrefs> {
    if (!this.mp.signedIn) return this.localPrefs;
    return cleanPrefs(await this.mp.call("GET", "/notifications/prefs"));
  }

  async setPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs> {
    const clean = cleanPrefs(prefs);
    if (!this.mp.signedIn) return (this.localPrefs = clean);
    return cleanPrefs(await this.mp.call("PUT", "/notifications/prefs", clean));
  }

  async answer(id: string, approve: boolean): Promise<NotificationPage> {
    const page = await this.mp.call<NotificationPage>("POST", `/notifications/${encodeURIComponent(id)}/answer?filter=requests`, { approve: approve === true });
    this.heard(page.unread, page.pending);
    return page;
  }

  // --- the inbox socket ---

  private follow(session: MultiplayerSession | null): void {
    this.disconnect();
    this.attempt = 0;
    if (!session) {
      this.heard(0, 0);
      return;
    }
    this.connect();
  }

  private disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.timer = this.ping = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000, "closing");
      } catch {
        // not open yet
      }
    }
  }

  private connect(): void {
    const url = this.mp.wsUrl("/notifications/ws");
    if (!url) return;
    let ws: Socket;
    try {
      ws = new this.deps.WebSocket(url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      const every = this.deps.pingMs ?? 60_000;
      if (every > 0) this.ping = setInterval(() => this.ws === ws && ws.readyState === 1 && ws.send("ping"), every);
      // What came while away: the counts now.
      void this.list({ limit: 1 }).catch(() => {});
      for (const l of this.reconnectListeners) l();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string" || e.data === "pong") return;
      let msg: InboxMessage;
      try {
        msg = JSON.parse(e.data) as InboxMessage;
      } catch {
        return;
      }
      // The org spaces' cache notices (docs/multiplayer.md §14.6, §14.11) ride the same socket: handed on as they are.
      if ((msg as { t: string }).t === "org") {
        for (const l of this.orgListeners) l(msg as unknown as OrgNotice);
        return;
      }
      // Libraries' and shared fonts' notices (docs/data.md §16.7, docs/desktop.md §14.3): handed on as they are.
      const raw = msg as unknown as { t: string; libraryKey?: unknown; orgId?: unknown; version?: unknown };
      if (raw.t === "library") {
        if (typeof raw.libraryKey === "string") for (const l of [...this.libraryListeners]) l(raw as LibraryNotice);
        return;
      }
      if (raw.t === "fonts") {
        if (typeof raw.orgId === "string") for (const l of [...this.fontsListeners]) l({ t: "fonts", orgId: raw.orgId, version: String(raw.version ?? "") });
        return;
      }
      if (raw.t === "plugins") {
        if (typeof raw.orgId === "string") for (const l of [...this.pluginsListeners]) l({ t: "plugins", orgId: raw.orgId });
        return;
      }
      if (msg.t !== "notifications") return;
      this.counts = { unread: msg.unread, pending: msg.pending };
      this.emit({ unread: msg.unread, pending: msg.pending, ...(msg.item ? { item: msg.item, desktop: msg.desktop === true } : {}) });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.retry();
    };
    ws.onerror = () => {};
  }

  private retry(): void {
    if (!this.mp.signedIn) return;
    this.attempt++;
    const ms = this.deps.backoff?.(this.attempt) ?? Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, ms);
  }

  private heard(unread: number, pending: number): void {
    if (unread === this.counts.unread && pending === this.counts.pending) return;
    this.counts = { unread, pending };
    this.emit({ unread, pending });
  }

  private emit(e: NotificationsEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** The `notifications` repository over a store's service (validated as it comes over the port) */
export function notificationsApi(s: NotificationsService): NotificationsRepository {
  return {
    list: (query) => s.list(query && typeof query === "object" ? query : {}),
    markRead: (input) => s.markRead(input && typeof input === "object" ? input : {}),
    prefs: () => s.prefs(),
    setPrefs: (prefs) => s.setPrefs(prefs),
    answer: (id, approve) => s.answer(String(id), approve === true),
    watch: (listener) => s.onChange(listener),
  };
}
