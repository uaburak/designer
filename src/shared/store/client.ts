/**
 * StoreClient (docs/data.md §8.2): the four repositories as RPC proxies over the store port. Transport-agnostic, so
 * the renderers (DOM MessagePort, src/renderer/src/store/client.ts) and main (MessagePortMain, src/store/host.ts)
 * share it.
 *
 * Reconnect (§7.4): after a store restart, `attach()` takes the new port (a higher generation). The client waits for
 * the store's hello, reattaches every edit session it holds (`files.reattach(fileKey, sessionID, lastAckedBatchSeq)`),
 * resends every batch not yet acknowledged (the store dedupes by batchSeq), resubscribes its file subscriptions from
 * the last seq it saw, and only then lets other calls through. Appends never fail because of a restart; other calls
 * in flight are resent when they are safe to repeat (RETRY_SAFE) and fail with `offline` otherwise.
 */
import { RETRY_SAFE, StoreError, type PortRole, type RpcMessage, type RpcTransport, type StoreErrorCode, type StoreMethod } from "./protocol";
import type {
  BlobStore,
  FileChange,
  FileQuery,
  FileRepository,
  FontsEvent,
  LibraryEvent,
  BlobsEvent,
  LibraryRegistry,
  OpenedFile,
  PreviewService,
  StoreAdmin,
  StoreApi,
  StoreInfo,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceRepository,
} from "./repositories";
import type { AppendAck, ChangeBatch, FileKey } from "./types";
import type { MultiplayerEvent, MultiplayerRepository, SessionEnded } from "../multiplayer/types";
import type { CommentsEvent, CommentsRepository } from "../comments";
import type { NotificationsEvent, NotificationsRepository } from "../notifications";
import type { AdminRepository, GovernanceRepository, IdentityRepository, OrgEvent, OrgsRepository, ProjectsRepository, TeamsRepository } from "../org/repositories";
import type { BranchEvent, BranchesRepository } from "../merge/branches";
import type { PluginsEvent, PluginsRepository } from "../plugins/types";
import type { DevModeEvent, DevModeRepository } from "../devmode/types";
import type { UploadEvent } from "../multiplayer/uploads";
import type { AiRepository, SearchRepository } from "../ai/types";
import type { BrandsRepository } from "../studio/types";
import type { CloudEvent, CloudRepository } from "./cloud";
import type { LibraryAnalyticsRepository, OrgLibrariesRepository } from "../libraries/orgTypes";

interface Pending {
  m: StoreMethod;
  a: unknown[];
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

interface Unacked {
  batch: ChangeBatch;
  resolve(a: AppendAck): void;
  reject(e: unknown): void;
}

interface EditSession {
  sessionID: number;
  lastAcked: number;
  unacked: Map<number, Unacked>;
}

interface FileSub {
  last: number;
  listeners: Set<(c: FileChange) => void>;
}

export interface StoreClientOptions {
  /** blobs.url(): app://designer/_blob/<sha1> by default (add the protocol token when there is one) */
  blobUrl?: (sha1: string) => string;
  /** Problems the client cannot hand to a caller (a reattach refused after a restart) */
  onError?: (e: unknown) => void;
}

class Listeners<T> {
  private readonly set = new Set<(e: T) => void>();
  add(l: (e: T) => void): Unsubscribe {
    this.set.add(l);
    return () => this.set.delete(l);
  }
  emit(e: T): void {
    for (const l of [...this.set]) {
      try {
        l(e);
      } catch (err) {
        console.error("store client: listener failed", err);
      }
    }
  }
}

export class StoreClient implements StoreApi {
  /** Generation of the store behind the current port (from its hello) */
  generation = 0;
  role: PortRole | null = null;
  private transport: RpcTransport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<FileKey, EditSession>();
  private readonly subs = new Map<FileKey, FileSub>();
  private readonly workspaceEvents = new Listeners<WorkspaceEvent>();
  private readonly libraryEvents = new Listeners<LibraryEvent>();
  private readonly multiplayerEvents = new Listeners<MultiplayerEvent>();
  private readonly sessionEvents = new Listeners<SessionEnded>();
  private readonly uploadEvents = new Listeners<UploadEvent>();
  private readonly blobsEvents = new Listeners<BlobsEvent>();
  private readonly commentsEvents = new Listeners<CommentsEvent>();
  private readonly notificationsEvents = new Listeners<NotificationsEvent>();
  private readonly orgEvents = new Listeners<OrgEvent>();
  private readonly branchEvents = new Listeners<BranchEvent>();
  private readonly fontsEvents = new Listeners<FontsEvent>();
  private readonly pluginsEvents = new Listeners<PluginsEvent>();
  private readonly devModeEvents = new Listeners<DevModeEvent>();
  private readonly cloudEvents = new Listeners<CloudEvent>();
  private readonly brandsEvents = new Listeners<string>();
  private readonly connected = new Listeners<{ generation: number }>();
  /** Calls wait for this: the hello and the resync of a new port */
  private gate!: Promise<void>;
  private openGate!: () => void;
  private gateOpen = false;
  private closed = false;

  constructor(private readonly opts: StoreClientOptions = {}) {
    this.closeGate();
  }

  private closeGate(): void {
    this.gateOpen = false;
    this.gate = new Promise((r) => {
      this.openGate = () => {
        this.gateOpen = true;
        r();
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------------------------------

  /** Takes a port: the first one, or a new one after the store restarted. */
  attach(transport: RpcTransport): void {
    if (this.closed) return;
    const old = this.transport;
    this.transport = transport;
    if (old) {
      // Calls already waiting keep waiting on the same gate if it never opened.
      if (this.gateOpen) this.closeGate();
      try {
        old.close();
      } catch {
        /* gone */
      }
      this.dropPending();
    }
    transport.listen(
      (data) => this.onMessage(transport, data),
      () => {
        if (this.transport === transport) this.dropPending();
      },
    );
  }

  /** Resolves once a port is attached and the store said hello (and the client has resynced). */
  whenReady(): Promise<void> {
    return this.gate;
  }

  /** Fires after each (re)connection, with the store's generation. */
  onConnected(listener: (e: { generation: number }) => void): Unsubscribe {
    return this.connected.add(listener);
  }

  close(): void {
    this.closed = true;
    try {
      this.transport?.close();
    } catch {
      /* gone */
    }
    this.transport = null;
    for (const p of this.pending.values()) p.reject(new StoreError("offline", "The store connection is closed"));
    this.pending.clear();
    for (const s of this.sessions.values()) for (const u of s.unacked.values()) u.reject(new StoreError("offline", "The store connection is closed"));
    this.sessions.clear();
  }

  /** The port died: retry-safe calls wait for the next port, the rest fail; appends stay queued. */
  private dropPending(): void {
    for (const [id, p] of [...this.pending]) {
      if (p.m === "files.append") continue; // resent from `unacked` after reattach
      if (RETRY_SAFE.has(p.m)) continue; // resent by resync
      this.pending.delete(id);
      p.reject(new StoreError("offline", "The store restarted while this was running"));
    }
  }

  private onMessage(transport: RpcTransport, data: unknown): void {
    if (transport !== this.transport) return;
    const msg = data as RpcMessage;
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "hello":
        this.generation = msg.generation;
        this.role = msg.role;
        void this.resync(transport);
        return;
      case "res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.v);
        else p.reject(new StoreError(msg.e.code as StoreErrorCode, msg.e.message, msg.e.detail));
        return;
      }
      case "evt":
        if (msg.topic === "workspace") this.workspaceEvents.emit(msg.d as WorkspaceEvent);
        else if (msg.topic === "library") this.libraryEvents.emit(msg.d as LibraryEvent);
        else if (msg.topic === "file.changes") this.deliver(msg.d as FileChange);
        else if (msg.topic === "multiplayer") this.multiplayerEvents.emit(msg.d as MultiplayerEvent);
        else if (msg.topic === "comments") this.commentsEvents.emit(msg.d as CommentsEvent);
        else if (msg.topic === "notifications") this.notificationsEvents.emit(msg.d as NotificationsEvent);
        else if (msg.topic === "org") this.orgEvents.emit(msg.d as OrgEvent);
        else if (msg.topic === "branches") this.branchEvents.emit(msg.d as BranchEvent);
        else if (msg.topic === "fonts") this.fontsEvents.emit(msg.d as FontsEvent);
        else if (msg.topic === "session") this.sessionEvents.emit(msg.d as SessionEnded);
        else if (msg.topic === "plugins") this.pluginsEvents.emit(msg.d as PluginsEvent);
        else if (msg.topic === "devmode") this.devModeEvents.emit(msg.d as DevModeEvent);
        else if (msg.topic === "uploads") this.uploadEvents.emit(msg.d as UploadEvent);
        else if (msg.topic === "blobs") this.blobsEvents.emit(msg.d as BlobsEvent);
        else if (msg.topic === "cloud") this.cloudEvents.emit(msg.d as CloudEvent);
        else if (msg.topic === "brands") this.brandsEvents.emit(msg.d as string);
        return;
    }
  }

  private deliver(c: FileChange): void {
    const sub = this.subs.get(c.fileKey);
    if (!sub || c.seq <= sub.last) return;
    sub.last = c.seq;
    for (const l of [...sub.listeners]) {
      try {
        l(c);
      } catch (err) {
        console.error("store client: file listener failed", err);
      }
    }
  }

  /** Sends now, on the current port (no gate). */
  private send(m: StoreMethod, a: unknown[], p: Omit<Pending, "m" | "a">): void {
    const id = this.nextId++;
    this.pending.set(id, { m, a, ...p });
    try {
      if (!this.transport) throw new Error("no port");
      this.transport.send({ t: "req", id, m, a });
    } catch {
      // No port: retry-safe calls and appends wait for the next one, the rest fail now.
      if (m !== "files.append" && !RETRY_SAFE.has(m)) {
        this.pending.delete(id);
        p.reject(new StoreError("offline", "The store isn't connected"));
      }
    }
  }

  private raw<T>(m: StoreMethod, a: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => this.send(m, a, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** A call from the app: waits for the port to be ready. */
  private async call<T>(m: StoreMethod, a: unknown[]): Promise<T> {
    if (this.closed) throw new StoreError("offline", "The store connection is closed");
    await this.gate;
    return this.raw<T>(m, a);
  }

  /** After a hello: reattach sessions, resend unacked batches, resubscribe, resend retry-safe calls, open the gate. */
  private async resync(transport: RpcTransport): Promise<void> {
    const stale = [...this.pending].filter(([, p]) => p.m !== "files.append");
    for (const [id] of stale) this.pending.delete(id);
    for (const [id, p] of [...this.pending]) if (p.m === "files.append") this.pending.delete(id); // resent below
    for (const [fileKey, s] of this.sessions) {
      try {
        await this.raw("files.reattach", [fileKey, s.sessionID, s.lastAcked]);
      } catch (e) {
        this.sessions.delete(fileKey);
        for (const u of s.unacked.values()) u.reject(e);
        this.opts.onError?.(e);
        continue;
      }
      for (const seq of [...s.unacked.keys()].sort((x, y) => x - y)) this.sendAppend(fileKey, s, s.unacked.get(seq)!);
    }
    for (const [fileKey, sub] of this.subs) {
      try {
        const backlog = await this.raw<FileChange[]>("files.subscribe", [fileKey, sub.last]);
        for (const c of backlog) this.deliver(c);
      } catch (e) {
        this.opts.onError?.(e);
      }
    }
    for (const [, p] of stale) this.send(p.m, p.a, p);
    if (transport !== this.transport) return;
    this.openGate();
    this.connected.emit({ generation: this.generation });
  }

  private sendAppend(fileKey: FileKey, s: EditSession, u: Unacked): void {
    this.send("files.append", [fileKey, u.batch], {
      resolve: (v) => {
        const ack = v as AppendAck;
        if (s.unacked.get(u.batch.batchSeq) === u) s.unacked.delete(u.batch.batchSeq);
        s.lastAcked = Math.max(s.lastAcked, u.batch.batchSeq);
        u.resolve(ack);
      },
      reject: (e) => {
        if ((e as StoreError).code === "offline" || (e as StoreError).code === "shutting-down") return; // resent after the next hello
        s.unacked.delete(u.batch.batchSeq);
        u.reject(e);
      },
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The repositories
  // -------------------------------------------------------------------------------------------------------------------

  readonly workspace: WorkspaceRepository = {
    getWorkspace: () => this.call("workspace.getWorkspace", []),
    updateWorkspace: (patch) => this.call("workspace.updateWorkspace", [patch]),
    setTeamName: (name) => this.call("workspace.setTeamName", [name]),
    getPrefs: () => this.call("workspace.getPrefs", []),
    setBrowsePrefs: (patch) => this.call("workspace.setBrowsePrefs", [patch]),
    listFolders: () => this.call("workspace.listFolders", []),
    createFolder: (input) => this.call("workspace.createFolder", [input]),
    updateFolder: (id, patch) => this.call("workspace.updateFolder", [id, patch]),
    listFiles: (query: FileQuery) => this.call("workspace.listFiles", [query]),
    getFile: (fileKey) => this.call("workspace.getFile", [fileKey]),
    createFile: (input) => this.call("workspace.createFile", [input]),
    duplicateFile: (fileKey) => this.call("workspace.duplicateFile", [fileKey]),
    renameFile: (fileKey, name) => this.call("workspace.renameFile", [fileKey, name]),
    moveFiles: (fileKeys, folderId) => this.call("workspace.moveFiles", [fileKeys, folderId]),
    trash: (items) => this.call("workspace.trash", [items]),
    restore: (items) => this.call("workspace.restore", [items]),
    deleteForever: (items) => this.call("workspace.deleteForever", [items]),
    emptyTrash: () => this.call("workspace.emptyTrash", []),
    setStarred: (target, starred) => this.call("workspace.setStarred", [target, starred]),
    recordViewed: (fileKey) => this.call("workspace.recordViewed", [fileKey]),
    removeFromRecents: (fileKey) => this.call("workspace.removeFromRecents", [fileKey]),
    watch: (listener) => this.workspaceEvents.add(listener),
  };

  readonly files: FileRepository = {
    open: async (fileKey, opts) => {
      const opened = await this.call<OpenedFile>("files.open", [fileKey, opts]);
      if (opened.mode === "edit") this.sessions.set(fileKey, { sessionID: opened.sessionID, lastAcked: 0, unacked: new Map() });
      return opened;
    },
    reattach: (fileKey, sessionID, lastAckedBatchSeq) => this.call("files.reattach", [fileKey, sessionID, lastAckedBatchSeq]),
    append: async (fileKey, batch) => {
      if (this.closed) throw new StoreError("offline", "The store connection is closed");
      const s = this.sessions.get(fileKey);
      await this.gate;
      if (!s || s.sessionID !== batch.sessionID) return this.raw<AppendAck>("files.append", [fileKey, batch]);
      return new Promise<AppendAck>((resolve, reject) => {
        const u: Unacked = { batch, resolve, reject };
        s.unacked.set(batch.batchSeq, u);
        this.sendAppend(fileKey, s, u);
      });
    },
    flush: (fileKey) => this.call("files.flush", [fileKey]),
    close: async (fileKey, sessionID) => {
      await this.call("files.close", [fileKey, sessionID]);
      if (this.sessions.get(fileKey)?.sessionID === sessionID) this.sessions.delete(fileKey);
    },
    subscribe: (fileKey, fromSeq, listener) => {
      let sub = this.subs.get(fileKey);
      const fresh = !sub;
      if (!sub) this.subs.set(fileKey, (sub = { last: fromSeq, listeners: new Set() }));
      sub.listeners.add(listener);
      if (fresh) {
        void this.call<FileChange[]>("files.subscribe", [fileKey, fromSeq])
          .then((backlog) => backlog.forEach((c) => this.deliver(c)))
          .catch((e) => this.opts.onError?.(e));
      }
      return () => {
        const cur = this.subs.get(fileKey);
        if (!cur) return;
        cur.listeners.delete(listener);
        if (!cur.listeners.size) {
          this.subs.delete(fileKey);
          void this.call("files.unsubscribe", [fileKey]).catch(() => {});
        }
      };
    },
    saveThumbnail: (fileKey, png, size) => this.call("files.saveThumbnail", [fileKey, png, size]),
    setUiState: (fileKey, patch) => this.call("files.setUiState", [fileKey, patch]),
    saveSnapshot: (fileKey, save) => this.call("files.saveSnapshot", [fileKey, save]),
    listVersions: (fileKey) => this.call("files.listVersions", [fileKey]),
    createVersion: (fileKey, input) => this.call("files.createVersion", [fileKey, input]),
    updateVersion: (fileKey, id, patch) => this.call("files.updateVersion", [fileKey, id, patch]),
    openVersion: (fileKey, id) => this.call("files.openVersion", [fileKey, id]),
    restoreDiff: (fileKey, id) => this.call("files.restoreDiff", [fileKey, id]),
    duplicateVersion: (fileKey, id) => this.call("files.duplicateVersion", [fileKey, id]),
    importLocalCopy: (path, folderId) => this.call("files.importLocalCopy", [path, folderId]),
    importFigBytes: (bytes, name, folderId, org) => this.call("files.importFigBytes", [bytes, name, folderId ?? null, org ?? null]),
    exportLocalCopy: (fileKey, path) => this.call("files.exportLocalCopy", [fileKey, path]),
    exportFigBytes: (fileKey) => this.call("files.exportFigBytes", [fileKey]),
  };

  readonly blobs: BlobStore = {
    put: (bytes, hint) => this.call("blobs.put", [bytes, hint]),
    has: (sha1s) => this.call("blobs.has", [sha1s]),
    get: (sha1) => this.call("blobs.get", [sha1]),
    url: (sha1) => (this.opts.blobUrl ? this.opts.blobUrl(sha1) : `app://designer/_blob/${sha1}`),
    watch: (listener) => this.blobsEvents.add(listener),
  };

  readonly libraries: LibraryRegistry = {
    listAvailable: (forFileKey) => this.call("libraries.listAvailable", [forFileKey]),
    getRecord: (lib) => this.call("libraries.getRecord", [lib]),
    getVersion: (lib, version) => this.call("libraries.getVersion", [lib, version]),
    previewPublish: (lib, assets) => this.call("libraries.previewPublish", [lib, assets]),
    publish: (req) => this.call("libraries.publish", [req]),
    unpublish: (lib) => this.call("libraries.unpublish", [lib]),
    setEnabled: (fileKey, lib, enabled) => this.call("libraries.setEnabled", [fileKey, lib, enabled]),
    getPayloads: (lib, wants, opts) => this.call("libraries.getPayloads", [lib, wants, opts]),
    diff: (lib, have) => this.call("libraries.diff", [lib, have]),
    watch: (listener) => this.libraryEvents.add(listener),
  };

  readonly previews: PreviewService = {
    status: () => this.call("previews.status", []),
    list: (fileKey) => this.call("previews.list", [fileKey]),
    publish: (fileKey, input) => this.call("previews.publish", [fileKey, input]),
    stop: (previewId) => this.call("previews.stop", [previewId]),
    exportHtml: (fileKey, input, path) => this.call("previews.exportHtml", [fileKey, input, path]),
  };

  readonly store: StoreAdmin = {
    shutdown: () => this.call("store.shutdown", []),
    flushAll: () => this.call("store.flushAll", []),
    info: () => this.call<StoreInfo>("store.info", []),
    collectGarbage: () => this.call("store.collectGarbage", []),
  };

  readonly comments: CommentsRepository = {
    list: (fileKey) => this.call("comments.list", [fileKey]),
    add: (fileKey, input) => this.call("comments.add", [fileKey, input]),
    edit: (fileKey, id, message, mentions) => this.call("comments.edit", [fileKey, id, message, mentions]),
    remove: (fileKey, id) => this.call("comments.remove", [fileKey, id]),
    setResolved: (fileKey, id, resolved) => this.call("comments.setResolved", [fileKey, id, resolved]),
    setRead: (fileKey, ids, read) => this.call("comments.setRead", [fileKey, ids, read]),
    react: (fileKey, id, emoji, on) => this.call("comments.react", [fileKey, id, emoji, on]),
    move: (fileKey, id, anchor) => this.call("comments.move", [fileKey, id, anchor]),
    mentionable: (fileKey) => this.call("comments.mentionable", [fileKey]),
    watch: (listener) => this.commentsEvents.add(listener),
  };

  readonly notifications: NotificationsRepository = {
    list: (query) => this.call("notifications.list", [query]),
    markRead: (input) => this.call("notifications.markRead", [input]),
    prefs: () => this.call("notifications.prefs", []),
    setPrefs: (prefs) => this.call("notifications.setPrefs", [prefs]),
    answer: (id, approve) => this.call("notifications.answer", [id, approve]),
    watch: (listener) => this.notificationsEvents.add(listener),
  };

  readonly multiplayer: MultiplayerRepository = {
    setSession: (session) => this.call("multiplayer.setSession", [session]),
    status: () => this.call("multiplayer.status", []),
    fileState: (fileKey) => this.call("multiplayer.fileState", [fileKey]),
    share: (fileKey, input) => this.call("multiplayer.share", [fileKey, input]),
    listRemote: () => this.call("multiplayer.listRemote", []),
    openShared: (key, password, intent) => this.call("multiplayer.openShared", [key, password, intent]),
    takeOpenIntent: (fileKey) => this.call("multiplayer.takeOpenIntent", [fileKey]),
    unlockFile: (fileKey, password) => this.call("multiplayer.unlockFile", [fileKey, password]),
    setLinkPassword: (fileKey, password) => this.call("multiplayer.setLinkPassword", [fileKey, password]),
    updateLink: (fileKey, patch) => this.call("multiplayer.updateLink", [fileKey, patch]),
    transferOwnership: (fileKey, email) => this.call("multiplayer.transferOwnership", [fileKey, email]),
    signal: (fileKey, to, data) => this.call("multiplayer.signal", [fileKey, to, data]),
    members: (fileKey) => this.call("multiplayer.members", [fileKey]),
    fileInfo: (fileKey) => this.call("multiplayer.fileInfo", [fileKey]),
    setLinkAccess: (fileKey, access) => this.call("multiplayer.setLinkAccess", [fileKey, access]),
    setViewersCanCopy: (fileKey, on) => this.call("multiplayer.setViewersCanCopy", [fileKey, on]),
    requestEdit: (fileKey) => this.call("multiplayer.requestEdit", [fileKey]),
    requests: (fileKey) => this.call("multiplayer.requests", [fileKey]),
    answerRequest: (fileKey, userId, approve) => this.call("multiplayer.answerRequest", [fileKey, userId, approve]),
    invite: (fileKey, email, role) => this.call("multiplayer.invite", [fileKey, email, role]),
    removeMember: (fileKey, email) => this.call("multiplayer.removeMember", [fileKey, email]),
    exclusions: (fileKey) => this.call("multiplayer.exclusions", [fileKey]),
    exclude: (fileKey, userId) => this.call("multiplayer.exclude", [fileKey, userId]),
    include: (fileKey, userId) => this.call("multiplayer.include", [fileKey, userId]),
    presence: (fileKey, data) => this.call("multiplayer.presence", [fileKey, data]),
    restRender: (fileKey, on, opts, token) => this.call("multiplayer.restRender", [fileKey, on, opts, token]),
    restAnswer: (fileKey, id, answer) => this.call("multiplayer.restAnswer", [fileKey, id, answer]),
    watch: (listener) => this.multiplayerEvents.add(listener),
    watchSession: (listener) => this.sessionEvents.add(listener),
    uploads: () => this.call("multiplayer.uploads", []),
    retryUpload: (id) => this.call("multiplayer.retryUpload", [id]),
    cancelUpload: (id) => this.call("multiplayer.cancelUpload", [id]),
    watchUploads: (listener) => this.uploadEvents.add(listener),
  };

  readonly orgs: OrgsRepository = {
    list: () => this.call("orgs.list", []),
    get: (orgId) => this.call("orgs.get", [orgId]),
    create: (input) => this.call("orgs.create", [input]),
    people: (orgId, query) => this.call("orgs.people", [orgId, query]),
    drafts: (orgId) => this.call("orgs.drafts", [orgId]),
    createDraft: (orgId, input) => this.call("orgs.createDraft", [orgId, input]),
    search: (orgId, text) => this.call("orgs.search", [orgId, text]),
    files: (orgId) => this.call("orgs.files", [orgId]),
    requestSeat: (orgId, seat, note) => this.call("orgs.requestSeat", [orgId, seat, note]),
    groups: (orgId) => this.call("orgs.groups", [orgId]),
    createGroup: (orgId, input) => this.call("orgs.createGroup", [orgId, input]),
    updateGroup: (groupId, patch) => this.call("orgs.updateGroup", [groupId, patch]),
    setGroupMembers: (groupId, change) => this.call("orgs.setGroupMembers", [groupId, change]),
    deleteGroup: (groupId) => this.call("orgs.deleteGroup", [groupId]),
    leave: (orgId) => this.call("orgs.leave", [orgId]),
    remove: (orgId, confirmName) => this.call("orgs.remove", [orgId, confirmName]),
    restore: (orgId) => this.call("orgs.restore", [orgId]),
    trashedDrafts: (orgId) => this.call("orgs.trashedDrafts", [orgId]),
    update: (orgId, patch) => this.call("orgs.update", [orgId, patch]),
    setIcon: (orgId, image) => this.call("orgs.setIcon", [orgId, image]),
    removeIcon: (orgId) => this.call("orgs.removeIcon", [orgId]),
    iconData: (iconUrl) => this.call("orgs.iconData", [iconUrl]),
    watch: (listener) => this.orgEvents.add(listener),
  };

  readonly teams: TeamsRepository = {
    list: (orgId, filter) => this.call("teams.list", [orgId, filter]),
    get: (teamId) => this.call("teams.get", [teamId]),
    page: (teamId) => this.call("teams.page", [teamId]),
    create: (orgId, input) => this.call("teams.create", [orgId, input]),
    update: (teamId, patch) => this.call("teams.update", [teamId, patch]),
    setIcon: (teamId, image) => this.call("teams.setIcon", [teamId, image]),
    removeIcon: (teamId) => this.call("teams.removeIcon", [teamId]),
    remove: (teamId) => this.call("teams.remove", [teamId]),
    restore: (teamId) => this.call("teams.restore", [teamId]),
    transfer: (teamId, userId) => this.call("teams.transfer", [teamId, userId]),
    members: (teamId) => this.call("teams.members", [teamId]),
    invite: (teamId, input) => this.call("teams.invite", [teamId, input]),
    setMember: (teamId, principal, patch) => this.call("teams.setMember", [teamId, principal, patch]),
    removeMember: (teamId, principal) => this.call("teams.removeMember", [teamId, principal]),
    join: (teamId) => this.call("teams.join", [teamId]),
    leave: (teamId) => this.call("teams.leave", [teamId]),
    requests: (teamId) => this.call("teams.requests", [teamId]),
    answerRequest: (teamId, userId, approve) => this.call("teams.answerRequest", [teamId, userId, approve]),
  };

  readonly projects: ProjectsRepository = {
    list: (teamId, parentId) => this.call("projects.list", [teamId, parentId ?? null]),
    get: (projectId) => this.call("projects.get", [projectId]),
    page: (projectId) => this.call("projects.page", [projectId]),
    create: (teamId, input) => this.call("projects.create", [teamId, input]),
    update: (projectId, patch) => this.call("projects.update", [projectId, patch]),
    move: (projectId, to) => this.call("projects.move", [projectId, to]),
    trash: (projectId) => this.call("projects.trash", [projectId]),
    restore: (projectId) => this.call("projects.restore", [projectId]),
    deleteForever: (projectId) => this.call("projects.deleteForever", [projectId]),
    members: (projectId) => this.call("projects.members", [projectId]),
    invite: (projectId, input) => this.call("projects.invite", [projectId, input]),
    setMember: (projectId, principal, role) => this.call("projects.setMember", [projectId, principal, role]),
    removeMember: (projectId, principal) => this.call("projects.removeMember", [projectId, principal]),
    files: (projectId) => this.call("projects.files", [projectId]),
    createFile: (projectId, input) => this.call("projects.createFile", [projectId, input]),
    moveFiles: (keys, to) => this.call("projects.moveFiles", [keys, to]),
    moveLocalFile: (fileKey, projectId, input) => this.call("projects.moveLocalFile", [fileKey, projectId, input]),
    trashFiles: (keys) => this.call("projects.trashFiles", [keys]),
    deleteFilesForever: (keys) => this.call("projects.deleteFilesForever", [keys]),
    restoreFiles: (keys) => this.call("projects.restoreFiles", [keys]),
    trashed: (teamId) => this.call("projects.trashed", [teamId]),
  };

  readonly admin: AdminRepository = {
    dashboard: (orgId) => this.call("admin.dashboard", [orgId]),
    people: (orgId, query) => this.call("admin.people", [orgId, query]),
    addPeople: (orgId, input) => this.call("admin.addPeople", [orgId, input]),
    updatePeople: (orgId, input) => this.call("admin.updatePeople", [orgId, input]),
    removePeople: (orgId, userIds) => this.call("admin.removePeople", [orgId, userIds]),
    seatRequests: (orgId, state) => this.call("admin.seatRequests", [orgId, state]),
    answerSeatRequest: (orgId, id, approve) => this.call("admin.answerSeatRequest", [orgId, id, approve]),
    guestRequests: (orgId) => this.call("admin.guestRequests", [orgId]),
    answerGuestRequest: (orgId, id, approve) => this.call("admin.answerGuestRequest", [orgId, id, approve]),
    teams: (orgId, query) => this.call("admin.teams", [orgId, query]),
    workspaces: (orgId) => this.call("admin.workspaces", [orgId]),
    createWorkspace: (orgId, input) => this.call("admin.createWorkspace", [orgId, input]),
    updateWorkspace: (workspaceId, patch) => this.call("admin.updateWorkspace", [workspaceId, patch]),
    deleteWorkspace: (workspaceId) => this.call("admin.deleteWorkspace", [workspaceId]),
    billingGroups: (orgId) => this.call("admin.billingGroups", [orgId]),
    createBillingGroup: (orgId, input) => this.call("admin.createBillingGroup", [orgId, input]),
    updateBillingGroup: (id, patch) => this.call("admin.updateBillingGroup", [id, patch]),
    deleteBillingGroup: (id) => this.call("admin.deleteBillingGroup", [id]),
    activity: (orgId, query) => this.call("admin.activity", [orgId, query]),
    settings: (orgId) => this.call("admin.settings", [orgId]),
    updateSettings: (orgId, patch) => this.call("admin.updateSettings", [orgId, patch]),
    unassignedDrafts: (orgId) => this.call("admin.unassignedDrafts", [orgId]),
    moveUnassigned: (orgId, input) => this.call("admin.moveUnassigned", [orgId, input]),
    deleteUnassigned: (orgId, fileKeys) => this.call("admin.deleteUnassigned", [orgId, fileKeys]),
    exportCsv: (orgId, what, query) => this.call("admin.exportCsv", [orgId, what, query]),
    planTokens: (orgId) => this.call("admin.planTokens", [orgId]),
    createPlanToken: (orgId, input) => this.call("admin.createPlanToken", [orgId, input]),
    revokePlanToken: (orgId, tokenId) => this.call("admin.revokePlanToken", [orgId, tokenId]),
  };

  readonly branches: BranchesRepository = {
    create: (mainFileKey, name) => this.call("branches.create", [mainFileKey, name]),
    list: (mainFileKey, tab) => this.call("branches.list", [mainFileKey, tab]),
    get: (branchFileKey) => this.call("branches.get", [branchFileKey]),
    rename: (branchFileKey, name) => this.call("branches.rename", [branchFileKey, name]),
    archive: (branchFileKey) => this.call("branches.archive", [branchFileKey]),
    restore: (branchFileKey) => this.call("branches.restore", [branchFileKey]),
    mainStatus: (branchFileKey) => this.call("branches.mainStatus", [branchFileKey]),
    preview: (branchFileKey, direction, resolutions) => this.call("branches.preview", [branchFileKey, direction, resolutions]),
    openSide: (previewId, side) => this.call("branches.openSide", [previewId, side]),
    applyUpdate: (branchFileKey, input) => this.call("branches.applyUpdate", [branchFileKey, input]),
    merge: (branchFileKey, input) => this.call("branches.merge", [branchFileKey, input]),
    requestReview: (branchFileKey, input) => this.call("branches.requestReview", [branchFileKey, input]),
    answerReview: (branchFileKey, input) => this.call("branches.answerReview", [branchFileKey, input]),
    undoMerge: (branchFileKey) => this.call("branches.undoMerge", [branchFileKey]),
    watch: (listener) => this.branchEvents.add(listener),
  };

  readonly orgLibraries: OrgLibrariesRepository = {
    list: (orgId, query) => this.call("orgLibraries.list", [orgId, query]),
    get: (orgId, key) => this.call("orgLibraries.get", [orgId, key]),
    updateSettings: (orgId, key, input) => this.call("orgLibraries.updateSettings", [orgId, key, input]),
    setScope: (key, scope) => this.call("orgLibraries.setScope", [key, scope]),
    teamLibraries: (teamId) => this.call("orgLibraries.teamLibraries", [teamId]),
  };

  readonly analytics: LibraryAnalyticsRepository = {
    record: (events) => this.call("analytics.record", [events]),
    orgOverview: (orgId, query) => this.call("analytics.orgOverview", [orgId, query]),
    overview: (key) => this.call("analytics.overview", [key]),
    actions: (key, query) => this.call("analytics.actions", [key, query]),
    usage: (key, assetKey) => this.call("analytics.usage", [key, assetKey]),
    modes: (key, collectionKey) => this.call("analytics.modes", [key, collectionKey]),
    csv: (key, query) => this.call("analytics.csv", [key, query]),
  };

  readonly plugins: PluginsRepository = {
    local: () => this.call("plugins.local", []),
    setSaved: (ref, saved) => this.call("plugins.setSaved", [ref, saved]),
    ranRecently: (ref) => this.call("plugins.ranRecently", [ref]),
    listPrivate: (orgId) => this.call("plugins.listPrivate", [orgId]),
    bundle: (pluginId, version) => this.call("plugins.bundle", [pluginId, version]),
    publish: (orgId, bundle, meta) => this.call("plugins.publish", [orgId, bundle, meta]),
    removePrivate: (pluginId) => this.call("plugins.removePrivate", [pluginId]),
    allowed: (fileKey, ref) => this.call("plugins.allowed", [fileKey, ref]),
    request: (orgId, input) => this.call("plugins.request", [orgId, input]),
    admin: (orgId, kind) => this.call("plugins.admin", [orgId, kind]),
    approve: (orgId, input) => this.call("plugins.approve", [orgId, input]),
    unapprove: (orgId, pluginId, workspaceId) => this.call("plugins.unapprove", [orgId, pluginId, workspaceId]),
    answer: (orgId, requestId, input) => this.call("plugins.answer", [orgId, requestId, input]),
    watch: (listener) => this.pluginsEvents.add(listener),
  };

  readonly devMode: DevModeRepository = {
    devResources: (fileKey, nodeIds) => this.call("devMode.devResources", [fileKey, nodeIds]),
    addDevResource: (fileKey, input) => this.call("devMode.addDevResource", [fileKey, input]),
    editDevResource: (fileKey, id, patch) => this.call("devMode.editDevResource", [fileKey, id, patch]),
    removeDevResource: (fileKey, id) => this.call("devMode.removeDevResource", [fileKey, id]),
    codeConnect: (fileKey) => this.call("devMode.codeConnect", [fileKey]),
    setCodeConnect: (fileKey, mapping) => this.call("devMode.setCodeConnect", [fileKey, mapping]),
    removeCodeConnect: (fileKey, nodeId, label) => this.call("devMode.removeCodeConnect", [fileKey, nodeId, label]),
    reportStatus: (fileKey, report) => this.call("devMode.reportStatus", [fileKey, report]),
    viewed: (fileKey) => this.call("devMode.viewed", [fileKey]),
    setStatusNotifications: (fileKey, notify) => this.call("devMode.setStatusNotifications", [fileKey, notify]),
    prototypeMembers: (fileKey) => this.call("devMode.prototypeMembers", [fileKey]),
    invitePrototype: (fileKey, email) => this.call("devMode.invitePrototype", [fileKey, email]),
    removePrototype: (fileKey, email) => this.call("devMode.removePrototype", [fileKey, email]),
    watch: (listener) => this.devModeEvents.add(listener),
  };

  readonly ai: AiRepository = {
    record: (e) => this.call("ai.record", [e]),
    balance: (allowance, now) => this.call("ai.balance", [allowance, now]),
    history: (q) => this.call("ai.history", [q]),
    skills: () => this.call("ai.skills", []),
    saveSkill: (s) => this.call("ai.saveSkill", [s]),
    removeSkill: (id) => this.call("ai.removeSkill", [id]),
  };

  readonly brands: BrandsRepository = {
    list: () => this.call("brands.list", []),
    get: (id) => this.call("brands.get", [id]),
    find: (query) => this.call("brands.find", [query]),
    saveBrand: (b) => this.call("brands.saveBrand", [b]),
    removeBrand: (id) => this.call("brands.removeBrand", [id]),
    saveProduct: (p) => this.call("brands.saveProduct", [p]),
    removeProduct: (brandId, productId) => this.call("brands.removeProduct", [brandId, productId]),
    addImage: (a) => this.call("brands.addImage", [a]),
    removeImage: (brandId, imageId) => this.call("brands.removeImage", [brandId, imageId]),
    image: (brandId, imageId) => this.call("brands.image", [brandId, imageId]),
    watch: (listener) => this.brandsEvents.add(listener),
  };

  readonly cloud: CloudRepository = {
    status: () => this.call("cloud.status", []),
    refresh: () => this.call("cloud.refresh", []),
    cacheInfo: () => this.call("cloud.cacheInfo", []),
    setCacheLimit: (bytes) => this.call("cloud.setCacheLimit", [bytes]),
    clearCache: () => this.call("cloud.clearCache", []),
    watch: (listener) => this.cloudEvents.add(listener),
  };

  readonly search: SearchRepository = {
    upsert: (entries) => this.call("search.upsert", [entries]),
    remove: (fileKey, nodeIds) => this.call("search.remove", [fileKey, nodeIds]),
    versions: (fileKey) => this.call("search.versions", [fileKey]),
    query: (q) => this.call("search.query", [q]),
    thumb: (fileKey, nodeId) => this.call("search.thumb", [fileKey, nodeId]),
    stats: () => this.call("search.stats", []),
    clear: () => this.call("search.clear", []),
  };

  readonly identity: IdentityRepository = {
    overview: (orgId) => this.call("identity.overview", [orgId]),
    saveIdp: (orgId, input) => this.call("identity.saveIdp", [orgId, input]),
    refreshIdpMetadata: (orgId) => this.call("identity.refreshIdpMetadata", [orgId]),
    deleteIdp: (orgId) => this.call("identity.deleteIdp", [orgId]),
    generateScimToken: (orgId) => this.call("identity.generateScimToken", [orgId]),
    revokeScimToken: (orgId) => this.call("identity.revokeScimToken", [orgId]),
    addDomain: (orgId, domain) => this.call("identity.addDomain", [orgId, domain]),
    verifyDomain: (orgId, domain) => this.call("identity.verifyDomain", [orgId, domain]),
    removeDomain: (orgId, domain) => this.call("identity.removeDomain", [orgId, domain]),
    domainAccounts: (orgId, domain) => this.call("identity.domainAccounts", [orgId, domain]),
    dataRegion: (orgId) => this.call("identity.dataRegion", [orgId]),
    setDataRegion: (orgId, region) => this.call("identity.setDataRegion", [orgId, region]),
    moveNext: (orgId) => this.call("identity.moveNext", [orgId]),
  };

  readonly governance: GovernanceRepository = {
    overview: (orgId) => this.call("governance.overview", [orgId]),
    setGovernancePlus: (orgId, on) => this.call("governance.setGovernancePlus", [orgId, on]),
    setIpAllowlist: (orgId, input) => this.call("governance.setIpAllowlist", [orgId, input]),
    addNetworkRange: (orgId, cidr) => this.call("governance.addNetworkRange", [orgId, cidr]),
    setNetworkRange: (orgId, rangeId, state) => this.call("governance.setNetworkRange", [orgId, rangeId, state]),
    removeNetworkRange: (orgId, rangeId) => this.call("governance.removeNetworkRange", [orgId, rangeId]),
    policies: (orgId) => this.call("governance.policies", [orgId]),
    createPolicy: (orgId, input) => this.call("governance.createPolicy", [orgId, input]),
    setPolicyEnabled: (orgId, policyId, enabled) => this.call("governance.setPolicyEnabled", [orgId, policyId, enabled]),
    setGuestExpiration: (orgId, userIds, expiresAt) => this.call("governance.setGuestExpiration", [orgId, userIds, expiresAt]),
    ekm: (orgId) => this.call("governance.ekm", [orgId]),
    enableEkm: (orgId, input) => this.call("governance.enableEkm", [orgId, input]),
    encryptNext: (orgId) => this.call("governance.encryptNext", [orgId]),
    developerLogs: (orgId, query) => this.call("governance.developerLogs", [orgId, query]),
    idps: (orgId) => this.call("governance.idps", [orgId]),
    saveIdp: (orgId, tenantId, input) => this.call("governance.saveIdp", [orgId, tenantId, input]),
    refreshIdp: (orgId, tenantId) => this.call("governance.refreshIdp", [orgId, tenantId]),
    removeIdp: (orgId, tenantId) => this.call("governance.removeIdp", [orgId, tenantId]),
    generateIdpScimToken: (orgId, tenantId) => this.call("governance.generateIdpScimToken", [orgId, tenantId]),
    revokeIdpScimToken: (orgId, tenantId) => this.call("governance.revokeIdpScimToken", [orgId, tenantId]),
    mapDomain: (orgId, domain, tenantId) => this.call("governance.mapDomain", [orgId, domain, tenantId]),
    pendingPolicies: (orgId) => this.call("governance.pendingPolicies", [orgId]),
    acknowledgePolicy: (orgId, policyId) => this.call("governance.acknowledgePolicy", [orgId, policyId]),
    twoFactor: () => this.call("governance.twoFactor", []),
    setupTwoFactor: () => this.call("governance.setupTwoFactor", []),
    enableTwoFactor: (code) => this.call("governance.enableTwoFactor", [code]),
    regenerateRecoveryCodes: (code) => this.call("governance.regenerateRecoveryCodes", [code]),
    disableTwoFactor: (code) => this.call("governance.disableTwoFactor", [code]),
  };

  /** Topic `fonts` (docs/desktop.md §14.3): main refreshes its shared fonts on it */
  watchFonts(listener: (e: FontsEvent) => void): Unsubscribe {
    return this.fontsEvents.add(listener);
  }
}
