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
  LibraryEvent,
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
  private readonly syncEvents = new Listeners<unknown>();
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
        else if (msg.topic === "sync") this.syncEvents.emit(msg.d);
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
    importFigBytes: (bytes, name, folderId) => this.call("files.importFigBytes", [bytes, name, folderId ?? null]),
    exportLocalCopy: (fileKey, path) => this.call("files.exportLocalCopy", [fileKey, path]),
  };

  readonly blobs: BlobStore = {
    put: (bytes, hint) => this.call("blobs.put", [bytes, hint]),
    has: (sha1s) => this.call("blobs.has", [sha1s]),
    get: (sha1) => this.call("blobs.get", [sha1]),
    url: (sha1) => (this.opts.blobUrl ? this.opts.blobUrl(sha1) : `app://designer/_blob/${sha1}`),
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

  /** `sync` events (Replicator status), once sync exists. */
  onSync(listener: (e: unknown) => void): Unsubscribe {
    return this.syncEvents.add(listener);
  }
}
