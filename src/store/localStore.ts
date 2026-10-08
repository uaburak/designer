/**
 * The store's composition root: the workspace on disk (docs/data.md §3), its records, files, blobs and libraries,
 * and `LocalAdapter`, the four repositories over them (§8). `LocalAdapter` is always authoritative: the UI reads
 * and writes only through it (over RPC), and sync, when it exists, replicates behind it.
 */
import { closeSync, openSync, promises as fsp, writeSync } from "node:fs";
import { join } from "node:path";
import { newDocumentMessage } from "../shared/schema/codec";
import { codec } from "../shared/schema/document.generated";
import { sessionIdFor } from "../shared/schema/guid";
import { withNewAssetIdentity } from "../shared/store/assetIdentity";
import { StoreError } from "../shared/store/protocol";
import type {
  BlobStore,
  FileChange,
  FileQuery,
  FileRepository,
  LibraryEvent,
  LibraryRegistry,
  OpenedFile,
  StoreAdmin,
  StoreApi,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceRepository,
} from "../shared/store/repositories";
import { isFileKey, type FileKey, type FileMeta, type FolderId, type PreviewRecord, type VersionRecord } from "../shared/store/types";
import { inlineCompactor, type Compactor } from "./compactor";
import { writeLocalCopy } from "./export/fig";
import { prepareFigImport } from "./import/fig";
import { LocalBlobs, pngSize } from "./local/blobs";
import { Emitter } from "./local/emitter";
import { FileStore, type SessionOwner, type Timers } from "./local/fileStore";
import { atomicWrite, ensureDir, readJsonOrNull, writeJsonAtomic } from "./local/fsutil";
import { HlcClock, newFileKey, newFolderId, systemClock, type Clock } from "./local/ids";
import { LocalLibraries } from "./local/libraries";
import { SchemaRegistry, currentMessage, readSnapshotFile } from "./local/snapshot";
import { versionDateLabel } from "./local/versions";
import { LocalWorkspace, newMeta, workspaceDirs, type Log, type WorkspaceDirs } from "./local/workspace";
import { loadSyncConfig, type SyncConfig } from "./sync/config";
import type { StorageDriver } from "./sync/drivers";
import { previewService } from "./preview/previews";
import { SerialQueue } from "./local/queue";

export interface LocalStoreOptions {
  workspaceDir: string;
  /** userData: device.json (the device ordinal) and firebase/config.json live here */
  userDataDir?: string;
  deviceOrdinal?: number;
  clock?: Clock;
  timers?: Timers;
  compactor?: Compactor;
  teamName?: string;
  log?: Log;
  generation?: number;
  /** Blob GC runs this long after start (default 10 min); null disables the timer */
  gcDelayMs?: number | null;
  /** DESIGNER_SEED=demo: .fig files imported into a "Samples" folder when the workspace has no files */
  seedFigs?: string[];
  /** The preview viewer's built page (out/viewer/index.html), for "Export preview as HTML…" (docs/data.md §13) */
  viewerTemplate?: string | null;
}

const defaultLog: Log = (level, message, detail) => {
  if (level === "debug" && process.env.DESIGNER_LOG !== "debug") return;
  const line = `[store] ${level}: ${message}`;
  if (level === "error" || level === "warn") console.error(line, detail ?? "");
  else console.log(line, detail ?? "");
};

/** Workspaces locked by live stores of this process (a stale lock with our own pid is a crashed store). */
const LOCKED_HERE = new Set<string>();

async function acquireLock(dirs: WorkspaceDirs, now: number, log: Log): Promise<void> {
  const path = join(dirs.root, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o644);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      closeSync(fd);
      LOCKED_HERE.add(dirs.root);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = await readJsonOrNull<{ pid: number; startedAt: number }>(path);
    let alive = false;
    if (held && held.pid !== process.pid) {
      try {
        process.kill(held.pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
    } else if (held?.pid === process.pid) alive = LOCKED_HERE.has(dirs.root);
    if (alive) throw new StoreError("io", `The workspace is in use by another process (pid ${held?.pid})`);
    log("warn", `taking over a stale workspace lock (pid ${held?.pid ?? "?"})`);
    await fsp.rm(path, { force: true });
  }
  throw new StoreError("io", "Couldn't lock the workspace");
}

export class LocalStore {
  readonly workspaceEvents: Emitter<WorkspaceEvent>;
  readonly libraryEvents: Emitter<LibraryEvent>;
  readonly fileChanges: Emitter<FileChange>;
  private gcTimer: unknown = null;
  private closed = false;
  /** Set while Firebase sync runs (sync/replicator.ts `startSync`) */
  replicator: { stop(): Promise<void> } | null = null;
  /** Firebase Storage while sync runs (`startSync`): where previews are published (docs/data.md §13) */
  previewStorage: StorageDriver | null = null;
  /** The viewer's built page, for previews exported as HTML */
  viewerTemplate: string | null = null;
  /** Serializes previews.json */
  readonly previewQueue = new SerialQueue();

  private constructor(
    readonly dirs: WorkspaceDirs,
    readonly ws: LocalWorkspace,
    readonly files: FileStore,
    readonly blobs: LocalBlobs,
    readonly libraries: LocalLibraries,
    readonly deviceOrdinal: number,
    readonly clock: Clock,
    readonly log: Log,
    readonly generation: number,
    readonly sync: SyncConfig | null,
    private readonly compactor: Compactor,
    readonly timers: Timers,
    /** Stamps journal frames and records; sync moves it past remote stamps it sees */
    readonly hlc: HlcClock,
  ) {
    this.workspaceEvents = ws.events;
    this.libraryEvents = libraries.events;
    this.fileChanges = files.changes;
  }

  static async open(opts: LocalStoreOptions): Promise<LocalStore> {
    const clock = opts.clock ?? systemClock;
    const log = opts.log ?? defaultLog;
    const dirs = workspaceDirs(opts.workspaceDir);
    await ensureDir(dirs.root);
    await acquireLock(dirs, clock.now(), log);
    try {
      // tmp/ holds only staging files of interrupted atomic writes; .trash-pending/ finishes earlier deletions.
      await fsp.rm(dirs.tmp, { recursive: true, force: true });
      await ensureDir(dirs.tmp);
      await ensureDir(dirs.trashPending);
      for (const n of await fsp.readdir(dirs.trashPending)) void fsp.rm(join(dirs.trashPending, n), { recursive: true, force: true });

      const deviceOrdinal = opts.deviceOrdinal ?? (await readDeviceOrdinal(opts.userDataDir, dirs));
      const hlc = new HlcClock(deviceOrdinal, clock);
      const schemas = new SchemaRegistry(dirs.schemas, dirs.tmp);
      await ensureDir(dirs.schemas);
      await schemas.ensureCurrent();
      const ws = await LocalWorkspace.load({ dirs, hlc, clock, log, teamName: opts.teamName, rebuildMeta: (k) => rebuildMeta(dirs, k, clock) });
      const blobs = new LocalBlobs(dirs.blobs, dirs.tmp);
      const timers = opts.timers ?? {
        setTimeout: (fn: () => void, ms: number) => {
          const t = setTimeout(fn, ms);
          t.unref?.();
          return t;
        },
        clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
      const compactor = opts.compactor ?? inlineCompactor;
      const files = new FileStore({ dirs, workspace: ws, schemas, hlc, clock, deviceOrdinal, compactor, log, timers });
      const libraries = new LocalLibraries({ dirs, workspace: ws, files, blobs, hlc, clock, log });
      await libraries.load();
      ws.sizeOf = (k) => files.cachedSize(k);
      const sync = opts.userDataDir ? await loadSyncConfig(opts.userDataDir, log) : null;
      const store = new LocalStore(dirs, ws, files, blobs, libraries, deviceOrdinal, clock, log, opts.generation ?? 1, sync, compactor, timers, hlc);
      store.viewerTemplate = opts.viewerTemplate ?? null;
      // Background start-up work: sizes for the file list, version thinning, the first GC.
      void Promise.all([...ws.files.keys()].map((k) => files.sizeOf(k).catch(() => 0))).catch(() => {});
      void files.thinAll([...ws.files.keys()]).catch((e) => log("warn", "version thinning failed", e));
      const gcDelay = opts.gcDelayMs === undefined ? 10 * 60 * 1000 : opts.gcDelayMs;
      if (gcDelay !== null) store.scheduleGc(gcDelay);
      if (opts.seedFigs?.length && ws.files.size === 0) await store.seed(opts.seedFigs);
      return store;
    } catch (e) {
      await fsp.rm(join(dirs.root, ".lock"), { force: true });
      LOCKED_HERE.delete(dirs.root);
      throw e;
    }
  }

  private scheduleGc(ms: number): void {
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    this.gcTimer = this.timers.setTimeout(() => {
      this.gcTimer = null;
      void this.collectGarbage().catch((e) => this.log("warn", "blob GC failed", e));
    }, ms);
  }

  private async seed(paths: string[]): Promise<void> {
    const folder = await this.ws.queue.run(() => this.ws.createFolder({ name: "Samples", parentId: null }, newFolderId()));
    for (const p of paths) await this.importLocalCopy(p, folder.id).catch((e) => this.log("warn", `seed ${p} failed`, e));
  }

  private guard(): void {
    if (this.closed) throw new StoreError("shutting-down", "The store is shutting down");
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Workspace operations that span records and file data
  // -------------------------------------------------------------------------------------------------------------------

  private checkFolder(folderId: FolderId | null): void {
    if (folderId === null) return;
    this.ws.getFolder(folderId);
    if (this.ws.isFolderTrashed(folderId)) throw new StoreError("trashed", "That folder is in Trash");
  }

  async createFile(input: { name?: string; folderId: FolderId | null }): Promise<FileMeta> {
    this.guard();
    const folderId = input?.folderId ?? null;
    this.checkFolder(folderId);
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : "Untitled";
    const libs = this.ws.workspace.defaultLibraries.filter((k) => this.libraries.getRecord(k)?.status === "published" && this.ws.files.has(k));
    const fileKey = newFileKey();
    const doc = newDocumentMessage({ libraries: libs.map((k) => ({ libraryKey: k, name: this.ws.files.get(k)!.name })) });
    await this.files.createFile(fileKey, codec.encodeMessage(doc), []);
    const meta = newMeta(fileKey, name, folderId, this.clock.now());
    meta.enabledLibraries = libs;
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  async duplicateFile(fileKey: FileKey): Promise<FileMeta> {
    this.guard();
    const src = this.ws.getMeta(fileKey);
    const head = await this.files.compactedHead(fileKey);
    const key = newFileKey();
    await this.createDuplicate(key, head.path, head.blobRefs, head.derivedDataVersion);
    const folderId = src.folderId && !this.ws.isFolderTrashed(src.folderId) ? src.folderId : null;
    const meta = newMeta(key, `${src.name} (Copy)`, folderId, this.clock.now());
    meta.enabledLibraries = [...src.enabledLibraries];
    meta.thumbnail = await this.copyThumbnail(fileKey, key, src.thumbnail);
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  /**
   * A duplicate's first snapshot (Duplicate file, Duplicate version): the snapshot as it is, except that its local
   * assets are new assets — no key, published version or move of the original's (docs/schema.md §8.1).
   */
  private async createDuplicate(key: FileKey, snapshotPath: string, blobRefs: string[], derivedDataVersion = 0): Promise<void> {
    const message = currentMessage(await readSnapshotFile(snapshotPath));
    const fresh = withNewAssetIdentity(message);
    if (fresh === message) await this.files.createFileFromSnapshot(key, snapshotPath, blobRefs, derivedDataVersion || (message.derivedDataVersion ?? 0));
    else await this.files.createFile(key, codec.encodeMessage(fresh), blobRefs, fresh.derivedDataVersion ?? 0);
  }

  private async copyThumbnail(from: FileKey, to: FileKey, thumb: FileMeta["thumbnail"]): Promise<FileMeta["thumbnail"]> {
    if (!thumb) return null;
    try {
      await fsp.copyFile(join(this.dirs.files, from, "thumbnail.png"), join(this.dirs.files, to, "thumbnail.png"));
      return { version: 1, width: thumb.width, height: thumb.height };
    } catch {
      return null;
    }
  }

  async trash(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    const { files } = await this.ws.queue.run(() => this.ws.trash(items ?? {}));
    for (const f of files) await this.libraries.fileTrashed(f.fileKey);
  }

  async restore(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    const { files } = await this.ws.queue.run(() => this.ws.restore(items ?? {}));
    for (const k of files) await this.libraries.fileRestored(k);
  }

  async deleteForever(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    const doomed = this.ws.collectDeletion(items ?? {});
    await this.deleteItems(doomed);
  }

  async emptyTrash(): Promise<void> {
    this.guard();
    await this.deleteItems(this.ws.collectDeletion(this.ws.trashContents()));
  }

  private async deleteItems(doomed: { files: FileKey[]; folders: FolderId[] }): Promise<void> {
    for (const k of doomed.files) {
      await this.files.deleteFileData(k);
      await this.libraries.fileDeleted(k);
      await this.ws.queue.run(() => this.ws.forgetFile(k));
    }
    // Deepest folders first, so a parent never disappears before its children.
    const depth = (id: FolderId) => this.ws.folderDepth(id);
    for (const id of [...doomed.folders].sort((a, b) => depth(b) - depth(a))) await this.ws.queue.run(() => this.ws.forgetFolder(id));
    if (doomed.files.length) this.scheduleGc(0);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Versions, import, export
  // -------------------------------------------------------------------------------------------------------------------

  async createVersion(fileKey: FileKey, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: string }): Promise<VersionRecord> {
    this.guard();
    this.ws.getMeta(fileKey);
    const kind = input?.kind ?? "named";
    if (kind !== "named" && kind !== "restore") throw new StoreError("invalid", `bad version kind ${kind}`);
    if (kind === "restore") {
      if (!input.restoredFrom) throw new StoreError("invalid", "a restore version names the version it restored");
      await this.files.getVersion(fileKey, input.restoredFrom);
    }
    const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : null;
    const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : null;
    await this.files.flush(fileKey);
    return this.files.addVersion(fileKey, { kind, title, description, restoredFrom: kind === "restore" ? input.restoredFrom! : null, libraryVersion: null });
  }

  async duplicateVersion(fileKey: FileKey, id: string): Promise<FileMeta> {
    this.guard();
    const src = this.ws.getMeta(fileKey);
    const { record, path } = await this.files.getVersion(fileKey, id);
    const key = newFileKey();
    await this.createDuplicate(key, path, record.blobRefs, record.derivedDataVersion ?? 0);
    const meta = newMeta(key, `${src.name} (${record.title ?? versionDateLabel(record.createdAt)})`, null, this.clock.now());
    meta.enabledLibraries = [...src.enabledLibraries];
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  async importLocalCopy(path: string, folderId: FolderId | null): Promise<FileMeta> {
    this.guard();
    if (typeof path !== "string" || !path) throw new StoreError("invalid", "importLocalCopy needs a path");
    this.checkFolder(folderId ?? null);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fsp.readFile(path));
    } catch (e) {
      throw new StoreError("not-found", `Couldn't read ${path}: ${(e as Error).message}`);
    }
    return this.importFig(bytes, path, folderId ?? null);
  }

  /** `files.importFigBytes`: a `.fig` the page read itself (Home's Import, a file dropped from Finder). */
  async importFigBytes(bytes: Uint8Array, name: string, folderId: FolderId | null = null): Promise<FileMeta> {
    this.guard();
    if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid", "importFigBytes needs the file's bytes");
    this.checkFolder(folderId ?? null);
    return this.importFig(bytes, typeof name === "string" ? name : "", folderId ?? null);
  }

  private async importFig(bytes: Uint8Array, name: string, folderId: FolderId | null): Promise<FileMeta> {
    // The import keeps GUIDs below 2^20 and moves the rest to the new file's first session.
    const prepared = prepareFigImport(bytes, { name, sessionID: sessionIdFor(this.deviceOrdinal, 1) });
    for (const data of prepared.images.values()) await this.blobs.put(data);
    const key = newFileKey();
    await this.files.createFile(key, prepared.message, prepared.blobRefs, prepared.derivedDataVersion);
    await this.setNextLocal(key, 2);
    const meta = newMeta(key, prepared.name, folderId, this.clock.now());
    meta.importedFrom = { kind: "fig", name: prepared.name };
    if (prepared.thumbnail) {
      const dims = pngSize(prepared.thumbnail);
      if (dims) {
        await atomicWrite(this.dirs.tmp, join(this.dirs.files, key, "thumbnail.png"), prepared.thumbnail);
        meta.thumbnail = { version: 1, width: dims.width, height: dims.height };
      }
    }
    if (prepared.report) this.log("info", `imported ${name}: ${prepared.report.nodesIn} → ${prepared.report.nodesOut} nodes`, prepared.report);
    const created = await this.ws.queue.run(() => this.ws.addFile(meta));
    await this.files.addVersion(key, { kind: "import", title: null, description: null, restoredFrom: null, libraryVersion: null });
    return created;
  }

  private async setNextLocal(fileKey: FileKey, n: number): Promise<void> {
    const p = join(this.dirs.files, fileKey, "store.json");
    const s = await readJsonOrNull<{ sessions: { nextLocal: number } }>(p);
    if (!s) return;
    s.sessions.nextLocal = Math.max(s.sessions.nextLocal, n);
    await writeJsonAtomic(this.dirs.tmp, p, s);
  }

  async exportLocalCopy(fileKey: FileKey, path: string): Promise<void> {
    this.guard();
    if (typeof path !== "string" || !path) throw new StoreError("invalid", "exportLocalCopy needs a path");
    const meta = this.ws.getMeta(fileKey);
    const head = await this.files.compactedHead(fileKey);
    await writeLocalCopy({
      snapshotPath: head.path,
      meta,
      thumbnailPath: join(this.dirs.files, fileKey, "thumbnail.png"),
      blobRefs: head.blobRefs,
      blobs: this.blobs,
      tmpDir: this.dirs.tmp,
      path,
      now: this.clock.now(),
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // GC, previews, admin
  // -------------------------------------------------------------------------------------------------------------------

  private async previewRecords(): Promise<PreviewRecord[]> {
    return (await readJsonOrNull<PreviewRecord[]>(join(this.dirs.root, "previews.json"))) ?? [];
  }

  /** Mark and sweep (§10.3): live = every file's and version's blobRefs, library payloads and thumbnails, previews. */
  async collectGarbage(): Promise<{ live: number; deleted: number; kept: number }> {
    const live = new Set<string>();
    for (const k of this.ws.files.keys()) for (const r of await this.files.blobRefsOf(k)) live.add(r);
    for (const r of await this.libraries.blobRefs()) live.add(r);
    for (const p of await this.previewRecords()) for (const r of p.blobRefs) live.add(r);
    const { deleted, kept } = await this.blobs.sweep(live, this.clock.now());
    if (deleted) this.log("info", `blob GC deleted ${deleted} blobs`);
    return { live: live.size, deleted, kept };
  }

  async flushAll(): Promise<void> {
    await this.files.flushAll();
  }

  /** Resolves when the store has no queued or background work (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.files.idle();
      await this.ws.queue.idle();
      await this.libraries.queue.idle();
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    await this.replicator?.stop().catch((e) => this.log("warn", "stopping sync failed", e));
    await this.files.shutdown();
    await this.ws.queue.idle();
    await this.libraries.queue.idle();
    await this.compactor.close();
    await fsp.rm(join(this.dirs.root, ".lock"), { force: true });
    LOCKED_HERE.delete(this.dirs.root);
  }

  /** Simulates a crash in tests: drops the lock bookkeeping without flushing anything. */
  abandonForTests(): void {
    this.closed = true;
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    LOCKED_HERE.delete(this.dirs.root);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The repositories (LocalAdapter), bound to the session owner (an RPC connection, or one in-process user)
  // -------------------------------------------------------------------------------------------------------------------

  api(owner: SessionOwner = {}): StoreApi {
    return localAdapter(this, owner);
  }
}

/** `LocalAdapter` (docs/data.md §8.2): the four repositories over the local store, for one owner of edit sessions. */
export function localAdapter(s: LocalStore, owner: SessionOwner): StoreApi {
  const ws = s.ws;
  const q = <T>(fn: () => Promise<T>) => ws.queue.run(fn);
  const workspace: WorkspaceRepository = {
    getWorkspace: async () => ({ ...ws.workspace }),
    updateWorkspace: (patch) => q(() => ws.updateWorkspace(patch ?? {})),
    getPrefs: async () => structuredClone(ws.prefs),
    setBrowsePrefs: (patch) => q(() => ws.setBrowsePrefs(patch ?? {})),
    listFolders: async () => ws.listFolders(),
    createFolder: (input) => q(() => ws.createFolder(input, newFolderId())),
    updateFolder: (id, patch) => q(() => ws.updateFolder(id, patch ?? {})),
    listFiles: async (query: FileQuery) => {
      const list = ws.listFiles(query);
      // Sizes are computed lazily; fill in the ones not known yet.
      return Promise.all(list.map(async (f) => (f.sizeBytes ? f : { ...f, sizeBytes: await s.files.sizeOf(f.fileKey).catch(() => 0) })));
    },
    getFile: async (fileKey) => {
      const f = ws.getFile(fileKey);
      return f.sizeBytes ? f : { ...f, sizeBytes: await s.files.sizeOf(fileKey).catch(() => 0) };
    },
    createFile: (input) => s.createFile(input),
    duplicateFile: (fileKey) => s.duplicateFile(fileKey),
    renameFile: (fileKey, name) => q(() => ws.renameFile(fileKey, name)),
    moveFiles: (keys, folderId) => q(() => ws.moveFiles(keys ?? [], folderId ?? null)),
    trash: (items) => s.trash(items),
    restore: (items) => s.restore(items),
    deleteForever: (items) => s.deleteForever(items),
    emptyTrash: () => s.emptyTrash(),
    setStarred: (target, starred) => q(() => ws.setStarred(target, !!starred)),
    recordViewed: (fileKey) => q(() => ws.recordViewed(fileKey)),
    removeFromRecents: (fileKey) => q(() => ws.removeFromRecents(fileKey)),
    watch: (listener) => s.workspaceEvents.on(listener),
  };
  const files: FileRepository = {
    open: (fileKey, opts) => s.files.open(fileKey, { mode: opts?.mode === "edit" ? "edit" : "view", tabId: opts?.tabId }, owner),
    reattach: (fileKey, sessionID, last) => s.files.reattach(fileKey, sessionID, last ?? 0, owner),
    append: (fileKey, batch) => s.files.append(fileKey, batch, owner),
    flush: (fileKey) => s.files.flush(fileKey),
    close: (fileKey, sessionID) => s.files.close(fileKey, sessionID),
    subscribe: (fileKey, fromSeq, listener) => subscribeLocal(s, fileKey, fromSeq, listener),
    saveThumbnail: (fileKey, png, size) => s.files.saveThumbnail(fileKey, png, size ?? { width: 0, height: 0 }),
    setUiState: (fileKey, patch) => s.files.setUiState(fileKey, patch ?? {}),
    saveSnapshot: (fileKey, save) => s.files.saveSnapshot(fileKey, save, owner),
    listVersions: (fileKey) => s.files.listVersions(fileKey),
    createVersion: (fileKey, input) => s.createVersion(fileKey, input ?? {}),
    updateVersion: (fileKey, id, patch) => s.files.updateVersion(fileKey, id, patch ?? {}),
    openVersion: (fileKey, id) => s.files.openVersion(fileKey, id),
    restoreDiff: (fileKey, id) => s.files.restoreDiff(fileKey, id),
    duplicateVersion: (fileKey, id) => s.duplicateVersion(fileKey, id),
    importLocalCopy: (path, folderId) => s.importLocalCopy(path, folderId ?? null),
    importFigBytes: (bytes, name, folderId) => s.importFigBytes(bytes, name, folderId ?? null),
    exportLocalCopy: (fileKey, path) => s.exportLocalCopy(fileKey, path),
  };
  const blobs: BlobStore = {
    put: (bytes, hint) => s.blobs.put(bytes, hint),
    has: (sha1s) => s.blobs.has(sha1s ?? []),
    get: (sha1) => s.blobs.get(sha1),
    url: (sha1) => `app://designer/_blob/${sha1}`,
  };
  const libraries: LibraryRegistry = {
    listAvailable: async (forFileKey) => s.libraries.listAvailable(forFileKey),
    getRecord: async (lib) => s.libraries.getRecord(lib),
    getVersion: (lib, version) => s.libraries.getVersion(lib, version),
    previewPublish: (lib, assets) => s.libraries.previewPublish(lib, assets ?? []),
    publish: (req) => s.libraries.publish(req),
    unpublish: (lib) => s.libraries.unpublish(lib),
    setEnabled: (fileKey, lib, enabled) => s.libraries.setEnabled(fileKey, lib, !!enabled),
    getPayloads: (lib, wants, opts) => s.libraries.getPayloads(lib, wants ?? [], { withDependencies: !!opts?.withDependencies }),
    diff: (lib, have) => s.libraries.diff(lib, have ?? []),
    watch: (listener) => s.libraryEvents.on(listener),
  };
  const previews = previewsOf(s);
  const store: StoreAdmin = {
    shutdown: () => s.shutdown(),
    flushAll: () => s.flushAll(),
    info: async () => ({
      workspaceDir: s.dirs.root,
      wid: ws.workspace.wid,
      deviceOrdinal: s.deviceOrdinal,
      generation: s.generation,
      openFiles: s.files.openFiles(),
      sync: { configured: !!s.sync, enabled: !!s.replicator },
    }),
    collectGarbage: () => s.collectGarbage(),
  };
  return { workspace, files, blobs, libraries, previews, store };
}

/** `previews.*` (docs/data.md §13) over this store, plus main's `exportHtml` and the start's `sweepExpired`. */
export function previewsOf(s: LocalStore): ReturnType<typeof previewService> {
  return previewService({
    root: s.dirs.root,
    tmpDir: s.dirs.tmp,
    now: () => s.clock.now(),
    fileName: (fileKey) => s.ws.getMeta(fileKey).name,
    readBlob: (sha1) => s.blobs.get(sha1),
    sync: s.sync,
    storage: () => s.previewStorage,
    viewerTemplate: s.viewerTemplate,
    run: (fn) => s.previewQueue.run(fn),
  });
}

/** In-process subscription: the backlog after `fromSeq`, then live changes, never a seq twice. */
function subscribeLocal(s: LocalStore, fileKey: FileKey, fromSeq: number, listener: (c: FileChange) => void): Unsubscribe {
  let last = fromSeq;
  let live = true;
  const queued: FileChange[] = [];
  let caughtUp = false;
  const deliver = (c: FileChange) => {
    if (!live || c.seq <= last) return;
    last = c.seq;
    listener(c);
  };
  const off = s.fileChanges.on((c) => {
    if (c.fileKey !== fileKey) return;
    if (caughtUp) deliver(c);
    else queued.push(c);
  });
  void s.files
    .backlog(fileKey, fromSeq)
    .then((frames) => {
      for (const f of frames) deliver(f);
    })
    .catch((e) => s.log("warn", `${fileKey}: backlog failed`, e))
    .finally(() => {
      caughtUp = true;
      for (const c of queued.splice(0)) deliver(c);
    });
  return () => {
    live = false;
    off();
  };
}

async function readDeviceOrdinal(userDataDir: string | undefined, dirs: WorkspaceDirs): Promise<number> {
  if (!userDataDir) return 1;
  const path = join(userDataDir, "device.json");
  const d = await readJsonOrNull<{ ordinal: number }>(path);
  if (d && Number.isInteger(d.ordinal) && d.ordinal >= 1 && d.ordinal <= 4095) return d.ordinal;
  await ensureDir(userDataDir);
  await writeJsonAtomic(dirs.tmp, path, { ordinal: 1, createdAt: Date.now() });
  return 1;
}

/** A corrupt meta.json: name from the snapshot's DOCUMENT node (unless it is the default "Document"), else "Recovered file". */
async function rebuildMeta(dirs: WorkspaceDirs, fileKey: FileKey, clock: Clock): Promise<{ name: string; createdAt: number } | null> {
  if (!isFileKey(fileKey)) return null;
  const dir = join(dirs.files, fileKey);
  const state = await readJsonOrNull<{ head?: { snapshot?: string } }>(join(dir, "store.json"));
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => /^snapshot-\d{12}\.kiwi$/.test(n)).sort();
  const candidates = [state?.head?.snapshot, ...names.reverse()].filter((n): n is string => !!n);
  for (const n of candidates) {
    try {
      const m = currentMessage(await readSnapshotFile(join(dir, n)));
      const doc = m.nodeChanges?.find((x) => x.type === "DOCUMENT");
      const st = await fsp.stat(dir);
      const name = doc?.name && doc.name !== "Document" ? doc.name : "Recovered file";
      return { name, createdAt: Math.min(st.birthtimeMs || clock.now(), clock.now()) };
    } catch {
      /* next */
    }
  }
  return null;
}

export type { OpenedFile };
