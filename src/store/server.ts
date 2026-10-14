/**
 * The store's side of the port protocol (docs/data.md §8.3): one Connection per MessagePort, with its role, its edit
 * sessions (bound to the port: when the port closes, the store ends them and releases the locks, §7.4) and its file
 * subscriptions. Events go to every port, except `file.changes`, which goes only to ports that subscribed.
 */
import { isKnownMethod, roleMayCall, serializeError, SESSION_METHODS, StoreError, type PortRole, type RpcMessage, type RpcRequest, type RpcTransport } from "../shared/store/protocol";
import type { FileChange, FontsEvent, LibraryEvent, OpenedFile, StoreApi, Unsubscribe, WorkspaceEvent } from "../shared/store/repositories";
import type { FileKey } from "../shared/store/types";
import type { FileShareState, MultiplayerNotice, RestJobRequest, SessionEnded } from "../shared/multiplayer/types";
import type { RoomPolicy } from "../shared/org/identity";
import type { NotificationsEvent } from "../shared/notifications";
import type { OrgEvent } from "../shared/org/repositories";
import type { BranchEvent } from "../shared/merge/branches";
import type { PluginsEvent } from "../shared/plugins/types";
import type { DevModeEvent } from "../shared/devmode/types";
import type { UploadEvent } from "../shared/multiplayer/uploads";
import type { CloudEvent } from "../shared/store/cloud";
import { t as tr } from "../shared/i18n";

/**
 * What the server needs from a store: `LocalStore` (the utility process), or the browser's in-memory dev store
 * (src/renderer/src/store/memory), which serves the very same protocol. This file imports nothing from Node.
 */
export interface ServableStore {
  /** The repositories, bound to one owner of edit sessions (a port) */
  api(owner: object): StoreApi;
  readonly workspaceEvents: { on(listener: (e: WorkspaceEvent) => void): Unsubscribe };
  readonly libraryEvents: { on(listener: (e: LibraryEvent) => void): Unsubscribe };
  readonly fileChanges: { on(listener: (c: FileChange) => void): Unsubscribe };
  /** Shared files' connection and people (docs/multiplayer.md §5) */
  readonly multiplayer?: {
    onFileState(listener: (fileKey: FileKey, state: FileShareState) => void): Unsubscribe;
    onReplaced(listener: (from: FileKey, to: FileKey) => void): Unsubscribe;
    onNotice(listener: (fileKey: FileKey, notice: MultiplayerNotice) => void): Unsubscribe;
    onSignal(listener: (fileKey: FileKey, from: number, data: unknown) => void): Unsubscribe;
    onPolicy(listener: (fileKey: FileKey, policy: RoomPolicy) => void): Unsubscribe;
    /** A REST render job for one of the file's renderers, and a room wanting one (docs/multiplayer.md §16.17) */
    onRestJob(listener: (fileKey: FileKey, req: RestJobRequest) => void): Unsubscribe;
    onRestWanted(listener: (fileKey: FileKey) => void): Unsubscribe;
    onSessionEnded(listener: (e: SessionEnded) => void): Unsubscribe;
    /** Uploads' progress for the upload panel (docs/multiplayer.md §5.1), topic `uploads` */
    onUploads?(listener: (e: UploadEvent) => void): Unsubscribe;
    /** Images that came down after their file opened (docs/cloud.md §4.1), topic `blobs` */
    onBlobsArrived?(listener: (e: { arrived: string[] }) => void): Unsubscribe;
    /** A port closed: the REST renderers it registered end with it */
    releaseRenderersOf?(owner: object): void;
    fileState(fileKey: FileKey): Promise<FileShareState>;
  };
  /** Comments changed (docs/multiplayer.md §10) */
  readonly comments?: { onChange(listener: (fileKey: FileKey) => void): Unsubscribe };
  /** The bell's counts and new notifications (docs/multiplayer.md §12) */
  readonly notifications?: { onChange(listener: (e: NotificationsEvent) => void): Unsubscribe };
  /** The org spaces' changes (docs/multiplayer.md §14.6), topic `org` */
  readonly org?: { onEvent(listener: (e: OrgEvent) => void): Unsubscribe };
  /** Governance+'s refusals (docs/governance.md §2.5, round 14e): `access.blocked` OrgEvents, also on topic `org` */
  readonly governanceEvents?: { onEvent(listener: (e: OrgEvent) => void): Unsubscribe };
  /** Branches' changes (docs/data.md §15.6), topic `branches` */
  readonly branches?: { onEvent(listener: (e: BranchEvent) => void): Unsubscribe };
  /** Shared fonts changed (docs/desktop.md §14.3), topic `fonts` */
  readonly fonts?: { onEvent(listener: (e: FontsEvent) => void): Unsubscribe };
  /** Saved / recents and orgs' private plugins and approvals changed (docs/plugins.md §10), topic `plugins` */
  readonly plugins?: { onEvent(listener: (e: PluginsEvent) => void): Unsubscribe };
  /** A file's dev resources or Code Connect mappings changed (docs/editor.md D-8), topic `devmode` */
  readonly devMode?: { onEvent(listener: (e: DevModeEvent) => void): Unsubscribe };
  /** Personal Drafts' sync and the cache (docs/cloud.md §2), topic `cloud` */
  readonly personal?: { readonly events: { on(listener: (e: CloudEvent) => void): Unsubscribe } };
  /** The brand library changed (docs/studio.md §3.1), topic `brands`: the brand's id */
  readonly brands?: { onEvent(listener: (brandId: string) => void): Unsubscribe };
  readonly files: {
    /** Frames after `fromSeq` for a subscriber catching up */
    backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]>;
    /** A port closed: end the edit sessions it held */
    endSessionsOf(owner: object): Promise<void>;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- arguments arrive as structured clones and are checked by the repositories */

interface Subscription {
  last: number;
  caughtUp: boolean;
  queued: FileChange[];
}

export class Connection {
  readonly owner = {};
  readonly api: StoreApi;
  readonly subscriptions = new Map<FileKey, Subscription>();
  closed = false;

  constructor(
    readonly server: StoreServer,
    readonly transport: RpcTransport,
    readonly role: PortRole,
  ) {
    this.api = server.store.api(this.owner);
  }

  send(message: RpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(message);
    } catch {
      this.closed = true;
    }
  }

  fileChange(c: FileChange): void {
    const sub = this.subscriptions.get(c.fileKey);
    if (!sub) return;
    if (!sub.caughtUp) {
      sub.queued.push(c);
      return;
    }
    if (c.seq <= sub.last) return;
    sub.last = c.seq;
    this.send({ t: "evt", topic: "file.changes", d: c });
  }

  /** Registers the subscription, returns the backlog after `fromSeq`, then releases what arrived meanwhile. */
  async subscribe(fileKey: FileKey, fromSeq: number): Promise<FileChange[]> {
    const sub: Subscription = { last: fromSeq, caughtUp: false, queued: [] };
    this.subscriptions.set(fileKey, sub);
    let backlog: FileChange[];
    try {
      backlog = await this.server.store.files.backlog(fileKey, fromSeq);
    } catch (e) {
      this.subscriptions.delete(fileKey);
      throw e;
    }
    for (const c of backlog) sub.last = Math.max(sub.last, c.seq);
    return backlog;
  }

  /** After the subscribe reply was sent: the live changes that arrived meanwhile follow it, in order. */
  release(fileKey: FileKey): void {
    const sub = this.subscriptions.get(fileKey);
    if (!sub || sub.caughtUp) return;
    sub.caughtUp = true;
    for (const c of sub.queued.splice(0)) this.fileChange(c);
  }
}

export interface StoreServerOptions {
  generation: number;
  /** Called after `store.shutdown` has been answered (the entry exits the process) */
  onShutdown?: () => void;
  /**
   * The login gate (docs/desktop.md §18.6): SESSION_METHODS are refused (`forbidden`, "Log in to …") unless a session
   * is on. `known` resolves when main has said once whether there is one (`multiplayer.setSession`); calls before that
   * wait for it (at most `waitMs`). Absent: no gate (development, tests, the browser's dev store).
   */
  session?: { signedIn(): boolean; known: Promise<void>; waitMs?: number };
}

/** The gate's refusal */
export const LOG_IN_FIRST = "Log in to Wecra to create or open files.";

export class StoreServer {
  private readonly connections = new Set<Connection>();
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly store: ServableStore,
    readonly opts: StoreServerOptions,
  ) {
    this.offs.push(store.workspaceEvents.on((d) => this.broadcast({ t: "evt", topic: "workspace", d })));
    this.offs.push(store.libraryEvents.on((d) => this.broadcast({ t: "evt", topic: "library", d })));
    this.offs.push(store.fileChanges.on((c) => this.connections.forEach((conn) => conn.fileChange(c))));
    if (store.multiplayer) {
      const mp = store.multiplayer;
      this.offs.push(mp.onFileState((fileKey, state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state } })));
      this.offs.push(mp.onReplaced((from, to) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey: from, state: { shared: false, key: null, role: null, connection: "offline", peers: [], requests: 0 }, replacedBy: to } })));
      this.offs.push(mp.onNotice((fileKey, notice) => void mp.fileState(fileKey).then((state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state, notice } }))));
      this.offs.push(mp.onSignal((fileKey, from, data) => void mp.fileState(fileKey).then((state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state, signal: { from, data } } }))));
      // The org changed cursor chat or audio (docs/multiplayer.md §15.9); the server ended the session (§15.8)
      this.offs.push(mp.onPolicy((fileKey, policy) => void mp.fileState(fileKey).then((state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state, policy } }))));
      // REST render jobs reach the editors (runner.ts) and main's render helper (restHelper.ts) as multiplayer events
      this.offs.push(mp.onRestJob((fileKey, restJob) => void mp.fileState(fileKey).then((state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state, restJob } }))));
      this.offs.push(mp.onRestWanted((fileKey) => void mp.fileState(fileKey).then((state) => this.broadcast({ t: "evt", topic: "multiplayer", d: { fileKey, state, restWanted: true } }))));
      this.offs.push(mp.onSessionEnded((d) => this.broadcast({ t: "evt", topic: "session", d })));
      if (mp.onUploads) this.offs.push(mp.onUploads((d) => this.broadcast({ t: "evt", topic: "uploads", d })));
      if (mp.onBlobsArrived) this.offs.push(mp.onBlobsArrived((d) => this.broadcast({ t: "evt", topic: "blobs", d })));
    }
    if (store.comments) this.offs.push(store.comments.onChange((fileKey) => this.broadcast({ t: "evt", topic: "comments", d: { fileKey } })));
    if (store.notifications) this.offs.push(store.notifications.onChange((d) => this.broadcast({ t: "evt", topic: "notifications", d })));
    if (store.org) this.offs.push(store.org.onEvent((d) => this.broadcast({ t: "evt", topic: "org", d })));
    if (store.governanceEvents) this.offs.push(store.governanceEvents.onEvent((d) => this.broadcast({ t: "evt", topic: "org", d })));
    if (store.branches) this.offs.push(store.branches.onEvent((d) => this.broadcast({ t: "evt", topic: "branches", d })));
    if (store.fonts) this.offs.push(store.fonts.onEvent((d) => this.broadcast({ t: "evt", topic: "fonts", d })));
    if (store.plugins) this.offs.push(store.plugins.onEvent((d) => this.broadcast({ t: "evt", topic: "plugins", d })));
    if (store.devMode) this.offs.push(store.devMode.onEvent((d) => this.broadcast({ t: "evt", topic: "devmode", d })));
    if (store.personal) this.offs.push(store.personal.events.on((d) => this.broadcast({ t: "evt", topic: "cloud", d })));
    if (store.brands) this.offs.push(store.brands.onEvent((d) => this.broadcast({ t: "evt", topic: "brands", d })));
  }

  get size(): number {
    return this.connections.size;
  }

  /** Takes a new port: says hello, then serves it until it closes. */
  connect(transport: RpcTransport, role: PortRole): Connection {
    const conn = new Connection(this, transport, role);
    this.connections.add(conn);
    transport.listen(
      (data) => void this.handle(conn, data),
      () => void this.disconnect(conn),
    );
    conn.send({ t: "hello", role, generation: this.opts.generation });
    return conn;
  }

  private async disconnect(conn: Connection): Promise<void> {
    if (!this.connections.delete(conn)) return;
    conn.closed = true;
    conn.subscriptions.clear();
    this.store.multiplayer?.releaseRenderersOf?.(conn.owner);
    await this.store.files.endSessionsOf(conn.owner).catch((e) => this.store.log("warn", "ending a closed port's sessions failed", e));
  }

  private broadcast(message: RpcMessage): void {
    for (const c of this.connections) c.send(message);
  }

  private async handle(conn: Connection, data: unknown): Promise<void> {
    const msg = data as Partial<RpcRequest>;
    if (!msg || msg.t !== "req" || typeof msg.id !== "number") return;
    const id = msg.id;
    try {
      if (typeof msg.m !== "string" || !isKnownMethod(msg.m)) throw new StoreError("invalid", `unknown method ${String(msg.m)}`);
      if (!roleMayCall(conn.role, msg.m)) throw new StoreError("forbidden", `${conn.role} may not call ${msg.m}`);
      if (this.opts.session && SESSION_METHODS.has(msg.m)) await this.requireSession(this.opts.session);
      const args = Array.isArray(msg.a) ? msg.a : [];
      const v = await this.dispatch(conn, msg.m, args);
      conn.send({ t: "res", id, ok: true, v });
      const opts = args[1] as { subscribe?: boolean } | undefined;
      if (msg.m === "files.subscribe" || (msg.m === "files.open" && opts?.subscribe)) conn.release(String(args[0]));
      if (msg.m === "store.shutdown") {
        for (const c of this.connections) c.closed = true;
        this.opts.onShutdown?.();
      }
    } catch (e) {
      conn.send({ t: "res", id, ok: false, e: serializeError(e) });
    }
  }

  /** Signed in, or `forbidden`: waits (bounded) for main's first word on the session. */
  private async requireSession(gate: NonNullable<StoreServerOptions["session"]>): Promise<void> {
    if (!gate.signedIn()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([gate.known, new Promise<void>((r) => (timer = setTimeout(r, gate.waitMs ?? 15_000)))]);
      clearTimeout(timer);
    }
    if (!gate.signedIn()) throw new StoreError("forbidden", tr(LOG_IN_FIRST));
  }

  private async dispatch(conn: Connection, m: string, a: any[]): Promise<unknown> {
    switch (m) {
      case "files.open": {
        const opened: OpenedFile = await conn.api.files.open(a[0], a[1] ?? { mode: "view" });
        if (a[1]?.subscribe) await conn.subscribe(a[0], opened.headSeq);
        return opened;
      }
      case "files.subscribe":
        return conn.subscribe(a[0], Number(a[1]) || 0);
      case "files.unsubscribe":
        conn.subscriptions.delete(a[0]);
        return undefined;
      case "files.close": {
        await conn.api.files.close(a[0], a[1]);
        return undefined;
      }
    }
    const dot = m.indexOf(".");
    const repo = (conn.api as unknown as Record<string, Record<string, (...args: any[]) => unknown>>)[m.slice(0, dot)];
    const fn = repo?.[m.slice(dot + 1)];
    if (typeof fn !== "function") throw new StoreError("invalid", `unknown method ${m}`);
    return fn(...a);
  }

  /** Stops serving (the process is going away). */
  close(): void {
    for (const off of this.offs) off();
    for (const c of this.connections) {
      c.closed = true;
      try {
        c.transport.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
  }
}
