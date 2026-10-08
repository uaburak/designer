/**
 * The store in a browser page (`npm run web:demo`, no Electron): the four repositories with the local store's
 * semantics, kept in memory and mirrored to localStorage one record per key (kv.ts), served over a MessagePort by the
 * very same `StoreServer` as the utility process, so a page's `StoreClient` can't tell the difference.
 *
 * Faithful where Home and the editor look: the workspace rules are the store's own `WorkspaceModel` (Drafts, nested
 * folders, Trash with restore-to-Drafts, Recents, Starred, search); files have a snapshot + journal with sessions,
 * the edit lock, batch dedupe, subscriptions, versions, restore diffs, thumbnails and UI state; libraries with the
 * store's own rules (memoryLibraries.ts). Not here: previews (they answer empty / `offline`), `.fig` import/export
 * (main-only paths), crash recovery, fsync.
 */
import { prepareFigImportAsync } from "../../../../shared/fig/importFig";
import { decodeMessage, encodeMessage, newDocumentMessage, SCHEMA_BINARY } from "../../../../shared/schema/codec";
import { RESERVED_SESSION_LIMIT, sessionIdFor, splitSessionId } from "../../../../shared/schema/guid";
import { messageImageHashes, NodeTable } from "../../../../shared/schema/patch";
import { restoreDiff, withNewAssetIdentity } from "../../../../shared/store/assetIdentity";
import { snapshotLosses } from "../../../../shared/store/snapshotCheck";
import { Emitter } from "../../../../shared/store/emitter";
import { StoreError } from "../../../../shared/store/protocol";
import type { BlobStore, FileChange, FileRepository, LibraryEvent, LibraryRegistry, OpenedFile, PreviewService, StoreAdmin, StoreApi, WorkspaceEvent, WorkspaceRepository } from "../../../../shared/store/repositories";
import {
  isSha1,
  MAX_BATCH_BYTES,
  MAX_SNAPSHOT_BYTES,
  type AppendAck,
  type BatchKind,
  type ChangeBatch,
  type FileKey,
  type FileMeta,
  type FileUiState,
  type Folder,
  type FolderId,
  type Hlc,
  type Prefs,
  type SnapshotSave,
  type SnapshotSaved,
  type VersionId,
  type VersionRecord,
  type Workspace,
} from "../../../../shared/store/types";
import { defaultPrefs, newMeta, WorkspaceModel } from "../../../../shared/store/workspaceModel";
import { KV_PREFIX, memoryStorage, parseWithBytes, stringifyWithBytes, type KeyValueStorage } from "./kv";
import { MemoryLibraries } from "./memoryLibraries";

// ---------------------------------------------------------------------------------------------------------------------
// Ids and clocks (docs/data.md §1)
// ---------------------------------------------------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 248) out += ALPHABET[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

/** Previews cannot be published without Firebase (docs/data.md §13); a browser has no desktop to export them either. */
const NOT_SET_UP = "Sharing previews needs Firebase sync, which isn't set up";

export const newFileKey = () => base62(22);
export const newFolderId = () => base62(16);
const newVersionId = () => base62(16);
const newWid = () => base62(16);

class HlcClock {
  private lastMs = 0;
  private counter = 0;
  constructor(
    private readonly deviceOrdinal: number,
    private readonly clock: { now(): number },
  ) {}
  now(): Hlc {
    const ms = this.clock.now();
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.counter = 0;
    } else if (++this.counter >= 36 ** 3) {
      this.lastMs++;
      this.counter = 0;
    }
    return `${this.lastMs.toString(36).padStart(9, "0")}.${this.counter.toString(36).padStart(3, "0")}.${this.deviceOrdinal.toString(36).padStart(2, "0")}`;
  }
}

function sniffMime(b: Uint8Array, hint?: string): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return hint ?? "application/octet-stream";
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || sniffMime(b) !== "image/png") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes.slice().buffer as ArrayBuffer));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A duplicate's snapshot (Duplicate file, Duplicate version): its local assets are new assets (docs/schema.md §8.1). */
function duplicateSnapshot(snapshot: Uint8Array): Uint8Array {
  const message = decodeMessage(snapshot);
  const fresh = withNewAssetIdentity(message);
  return fresh === message ? snapshot : encodeMessage(fresh);
}

export function versionDateLabel(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------------------------------------
// File data
// ---------------------------------------------------------------------------------------------------------------------

interface Frame {
  seq: number;
  sessionID: number;
  batchSeq: number;
  kind: BatchKind;
  label: string;
  hlc: Hlc;
  wallClock: number;
  message: Uint8Array;
}

/** One file's data, stored under `file.<key>` (the meta is the workspace's, under `meta.<key>`). */
export interface FileData {
  /** kiwi Message, uncompressed (what `OpenedFile.snapshot` carries) */
  snapshot: Uint8Array;
  snapshotSeq: number;
  /** `Message.derivedDataVersion` of the snapshot (absent / 0: none) */
  derivedDataVersion?: number;
  frames: Frame[];
  nextLocal: number;
  lastBatchSeq: Record<string, number>;
  versions: { record: VersionRecord; snapshot: Uint8Array }[];
  /** PNG from the editor; the seeded demo files carry an SVG */
  thumbnail: { bytes: Uint8Array; mime: string } | null;
  ui: FileUiState | null;
  blobRefs: string[];
}

interface Runtime {
  sessions: Map<number, { owner: object; tabId?: string }>;
  acks: Map<string, AppendAck>;
  updatedAtTimer: ReturnType<typeof setTimeout> | null;
}

/** Fold the journal into the snapshot past this many frames (keeps each file's key small). */
const COMPACT_FRAMES = 200;
const UPDATED_AT_DEBOUNCE_MS = 1000;

const K = {
  workspace: `${KV_PREFIX}workspace`,
  prefs: `${KV_PREFIX}prefs`,
  folder: (id: FolderId) => `${KV_PREFIX}folder.${id}`,
  meta: (key: FileKey) => `${KV_PREFIX}meta.${key}`,
  file: (key: FileKey) => `${KV_PREFIX}file.${key}`,
  blob: (sha1: string) => `${KV_PREFIX}blob.${sha1}`,
};

export interface MemoryStoreOptions {
  /** Default: memory only (nothing survives the page) */
  storage?: KeyValueStorage;
  clock?: { now(): number };
  teamName?: string;
  /** Called once when the storage holds no workspace yet */
  seed?: (store: MemoryStore) => Promise<void>;
  log?: (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => void;
  /**
   * A zstd decoder for `.fig` imports (most of Figma's newer files compress their data with zstd, which browsers
   * can't decode natively); without one those files are refused as `unsupported-format`.
   */
  zstdDecompress?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

/** deflate-raw through the browser's DecompressionStream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class MemoryStore {
  readonly ws: WorkspaceModel;
  readonly workspaceEvents: Emitter<WorkspaceEvent>;
  readonly libraryEvents: Emitter<LibraryEvent>;
  /** The library registry (docs/data.md §9) on the same storage */
  readonly libraries: MemoryLibraries;
  readonly fileChanges = new Emitter<FileChange>();
  readonly deviceOrdinal = 1;
  readonly clock: { now(): number };
  private readonly hlc: HlcClock;
  private readonly data = new Map<FileKey, FileData>();
  private readonly runtime = new Map<FileKey, Runtime>();
  private readonly offWatch: (() => void) | null;
  /** Bumped whenever a file's thumbnail changes (devStore turns it into object URLs) */
  readonly thumbnails = new Emitter<FileKey>();
  readonly files: { backlog(fileKey: FileKey, fromSeq: number): Promise<FileChange[]>; endSessionsOf(owner: object): Promise<void> };

  private constructor(
    readonly storage: KeyValueStorage,
    workspace: Workspace,
    prefs: Prefs,
    private readonly opts: MemoryStoreOptions,
  ) {
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.hlc = new HlcClock(this.deviceOrdinal, this.clock);
    const kv = storage;
    const put = (key: string, value: unknown) => {
      if (!kv.set(key, JSON.stringify(value))) this.log("warn", `the browser's storage is full; ${key} wasn't kept`);
      return Promise.resolve();
    };
    this.ws = new WorkspaceModel(workspace, prefs, {
      hlc: this.hlc,
      clock: this.clock,
      persist: {
        workspace: (w) => put(K.workspace, w),
        prefs: (p) => put(K.prefs, p),
        folder: (f) => put(K.folder(f.id), f),
        removeFolder: async (id) => kv.remove(K.folder(id)),
        meta: (m) => put(K.meta(m.fileKey), m),
      },
    });
    this.workspaceEvents = this.ws.events;
    this.ws.sizeOf = (k) => this.sizeOf(k);
    this.files = {
      backlog: async (fileKey, fromSeq) => this.backlog(fileKey, fromSeq),
      endSessionsOf: async (owner) => {
        for (const [key, rt] of this.runtime) for (const [sid, s] of [...rt.sessions]) if (s.owner === owner) this.close(key, sid);
      },
    };
    this.libraries = new MemoryLibraries({
      storage: kv,
      ws: this.ws,
      clock: this.clock,
      hlc: this.hlc,
      putBlob: (bytes, hint) => this.putBlob(bytes, hint),
      pngSize,
      addVersion: (fileKey, input) => void this.addVersion(fileKey, input),
      log: (level, message, detail) => this.log(level, message, detail),
    });
    this.libraryEvents = this.libraries.events;
    this.offWatch = kv.watch?.((key, value) => this.onExternalWrite(key, value)) ?? null;
  }

  static async open(opts: MemoryStoreOptions = {}): Promise<MemoryStore> {
    const kv = opts.storage ?? memoryStorage();
    const read = <T>(key: string): T | null => {
      const v = kv.get(key);
      if (v === null) return null;
      try {
        return JSON.parse(v) as T;
      } catch {
        return null;
      }
    };
    const now = (opts.clock ?? { now: () => Date.now() }).now();
    const existing = read<Workspace>(K.workspace);
    const workspace: Workspace = existing ?? { wid: newWid(), formatVersion: 1, teamName: opts.teamName ?? "My team", createdAt: now, defaultLibraries: [], ownerUid: null, _clk: {} };
    const prefs: Prefs = { ...defaultPrefs(), ...(read<Prefs>(K.prefs) ?? {}) };
    const store = new MemoryStore(kv, workspace, prefs, opts);
    for (const key of kv.keys(`${KV_PREFIX}folder.`)) {
      const f = read<Folder>(key);
      if (f?.id) store.ws.folders.set(f.id, f);
    }
    for (const key of kv.keys(`${KV_PREFIX}meta.`)) {
      const m = read<FileMeta>(key);
      if (m?.fileKey && kv.get(K.file(m.fileKey)) !== null) store.ws.files.set(m.fileKey, m);
    }
    if (!existing) {
      await store.ws.saveWorkspace();
      await store.ws.savePrefs();
      if (opts.seed) await opts.seed(store);
    }
    return store;
  }

  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void {
    if (this.opts.log) this.opts.log(level, message, detail);
    else if (level === "warn" || level === "error") console.warn(`[dev store] ${message}`, detail ?? "");
  }

  /** Stops following other pages' writes. */
  dispose(): void {
    this.offWatch?.();
    for (const rt of this.runtime.values()) if (rt.updatedAtTimer) clearTimeout(rt.updatedAtTimer);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Other pages (another browser tab of the demo wrote a record)
  // -------------------------------------------------------------------------------------------------------------------

  private onExternalWrite(key: string, value: string | null): void {
    const parse = <T>(): T | null => {
      try {
        return value === null ? null : (JSON.parse(value) as T);
      } catch {
        return null;
      }
    };
    const rest = key.slice(KV_PREFIX.length);
    const ws = this.ws;
    if (rest.startsWith("lib.")) return this.libraries.noteExternalWrite(key, value);
    const kept = { persist: false }; // already in the storage
    if (rest === "workspace") {
      const w = parse<Workspace>();
      if (w) void ws.adoptWorkspace(w, kept);
    } else if (rest === "prefs") {
      const p = parse<Prefs>();
      if (p) void ws.adoptPrefs(p, kept);
    } else if (rest.startsWith("folder.")) {
      const f = parse<Folder>();
      if (f) void ws.adoptFolder(f, kept);
      else ws.dropFolder(rest.slice("folder.".length));
    } else if (rest.startsWith("meta.")) {
      const k = rest.slice("meta.".length);
      const m = parse<FileMeta>();
      if (!m) ws.dropFile(k);
      else {
        const thumbChanged = ws.files.get(k)?.thumbnail?.version !== m.thumbnail?.version;
        void ws.adoptMeta(m, kept);
        if (thumbChanged) this.thumbnails.emit(k);
      }
    } else if (rest.startsWith("file.")) {
      const k = rest.slice("file.".length);
      // Reread on next use, unless this page edits the file (then this page's copy is the one that counts).
      if (!this.runtime.get(k)?.sessions.size) this.data.delete(k);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // File data
  // -------------------------------------------------------------------------------------------------------------------

  private rt(fileKey: FileKey): Runtime {
    let r = this.runtime.get(fileKey);
    if (!r) this.runtime.set(fileKey, (r = { sessions: new Map(), acks: new Map(), updatedAtTimer: null }));
    return r;
  }

  /** The file's data (loaded from storage on first use). */
  fileData(fileKey: FileKey): FileData {
    this.ws.getMeta(fileKey);
    let d = this.data.get(fileKey);
    if (!d) {
      const raw = this.storage.get(K.file(fileKey));
      if (raw === null) throw new StoreError("corrupt", "This file's data is missing");
      d = parseWithBytes<FileData>(raw);
      this.data.set(fileKey, d);
    }
    return d;
  }

  private saveData(fileKey: FileKey, d: FileData): void {
    this.data.set(fileKey, d);
    if (!this.storage.set(K.file(fileKey), stringifyWithBytes(d))) this.log("warn", `the browser's storage is full; changes to ${fileKey} live only in this page`);
  }

  private headSeq(d: FileData): number {
    return d.frames.length ? d.frames[d.frames.length - 1].seq : d.snapshotSeq;
  }

  private headTable(d: FileData): NodeTable {
    const table = NodeTable.fromMessage(decodeMessage(d.snapshot));
    for (const f of d.frames) table.apply(decodeMessage(f.message));
    return table;
  }

  private compact(d: FileData): void {
    if (!d.frames.length) return;
    const table = this.headTable(d);
    d.snapshotSeq = this.headSeq(d);
    d.snapshot = encodeMessage(table.toMessage({ keepDerived: true }));
    d.derivedDataVersion = table.derivedDataVersion || undefined;
    d.frames = [];
    d.blobRefs = [...table.imageHashes()];
  }

  sizeOf(fileKey: FileKey): number {
    const d = this.data.get(fileKey);
    if (d) return d.snapshot.length + d.frames.reduce((n, f) => n + f.message.length + 48, 0);
    return Math.round(((this.storage.get(K.file(fileKey))?.length ?? 0) * 3) / 4);
  }

  /** Creates a file's data and record (the dev store's createFile, import and seed path). */
  async addFile(input: {
    name: string;
    folderId: FolderId | null;
    snapshot: Uint8Array;
    nextLocal?: number;
    thumbnail?: FileData["thumbnail"];
    thumbSize?: { width: number; height: number };
    importedFrom?: FileMeta["importedFrom"];
  }): Promise<FileMeta> {
    const key = newFileKey();
    const table = NodeTable.fromMessage(decodeMessage(input.snapshot));
    this.saveData(key, {
      snapshot: input.snapshot,
      snapshotSeq: 0,
      ...(table.derivedDataVersion ? { derivedDataVersion: table.derivedDataVersion } : {}),
      frames: [],
      nextLocal: input.nextLocal ?? 1,
      lastBatchSeq: {},
      versions: [],
      thumbnail: input.thumbnail ?? null,
      ui: null,
      blobRefs: [...table.imageHashes()],
    });
    const meta = newMeta(key, input.name, input.folderId, this.clock.now());
    if (input.thumbnail) meta.thumbnail = { version: 1, ...(input.thumbSize ?? { width: 0, height: 0 }) };
    if (input.importedFrom) meta.importedFrom = input.importedFrom;
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  /** `files.importFigBytes` (docs/data.md §11.1): the shared import with the browser's codecs. */
  async importFigBytes(bytes: Uint8Array, name: string, folderId: FolderId | null = null): Promise<FileMeta> {
    if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid", "importFigBytes needs the file's bytes");
    this.checkFolder(folderId ?? null);
    const prepared = await prepareFigImportAsync(bytes, { name: typeof name === "string" ? name : "", sessionID: sessionIdFor(this.deviceOrdinal, 1) }, { inflateRaw, zstdDecompress: this.opts.zstdDecompress, sha1: sha1Hex });
    for (const data of prepared.images.values()) await this.putBlob(data);
    const dims = prepared.thumbnail ? pngSize(prepared.thumbnail) : null;
    const meta = await this.addFile({
      name: prepared.name,
      folderId: folderId ?? null,
      snapshot: prepared.message,
      nextLocal: 2,
      thumbnail: dims ? { bytes: prepared.thumbnail!, mime: "image/png" } : null,
      thumbSize: dims ?? undefined,
      importedFrom: { kind: "fig", name: prepared.name },
    });
    this.addVersion(meta.fileKey, { kind: "import", title: null, description: null, restoredFrom: null });
    return meta;
  }

  private checkFolder(folderId: FolderId | null): void {
    if (folderId === null) return;
    this.ws.getFolder(folderId);
    if (this.ws.isFolderTrashed(folderId)) throw new StoreError("trashed", "That folder is in Trash");
  }

  async createFile(input: { name?: string; folderId: FolderId | null }): Promise<FileMeta> {
    const folderId = input?.folderId ?? null;
    this.checkFolder(folderId);
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : "Untitled";
    return this.addFile({ name, folderId, snapshot: encodeMessage(newDocumentMessage()) });
  }

  async duplicateFile(fileKey: FileKey): Promise<FileMeta> {
    const src = this.ws.getMeta(fileKey);
    const d = this.fileData(fileKey);
    this.compact(d);
    this.saveData(fileKey, d);
    const folderId = src.folderId && !this.ws.isFolderTrashed(src.folderId) ? src.folderId : null;
    return this.addFile({
      name: `${src.name} (Copy)`,
      folderId,
      snapshot: duplicateSnapshot(d.snapshot),
      nextLocal: d.nextLocal,
      thumbnail: d.thumbnail,
      thumbSize: src.thumbnail ? { width: src.thumbnail.width, height: src.thumbnail.height } : undefined,
    });
  }

  private async deleteItems(doomed: { files: FileKey[]; folders: FolderId[] }): Promise<void> {
    for (const k of doomed.files) {
      if (this.storage.get(`${KV_PREFIX}lib.${k}`) !== null) this.libraries.forget(k);
      this.data.delete(k);
      this.runtime.delete(k);
      this.storage.remove(K.file(k));
      this.storage.remove(K.meta(k));
      await this.ws.queue.run(() => this.ws.forgetFile(k));
    }
    const depth = (id: FolderId) => this.ws.folderDepth(id);
    for (const id of [...doomed.folders].sort((a, b) => depth(b) - depth(a))) await this.ws.queue.run(() => this.ws.forgetFolder(id));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Sessions and the journal
  // -------------------------------------------------------------------------------------------------------------------

  private opened(fileKey: FileKey, d: FileData, mode: "edit" | "view", sessionID: number): OpenedFile {
    return {
      meta: { ...this.ws.getMeta(fileKey) },
      mode,
      sessionID,
      schema: SCHEMA_BINARY.slice(),
      snapshot: d.snapshot,
      snapshotSeq: d.snapshotSeq,
      derivedDataVersion: d.derivedDataVersion ?? 0,
      journal: d.frames.map((f) => ({ seq: f.seq, kind: f.kind, message: f.message })),
      headSeq: this.headSeq(d),
      ui: d.ui,
      recovery: null,
    };
  }

  open(fileKey: FileKey, opts: { mode?: "edit" | "view"; tabId?: string }, owner: object): OpenedFile {
    const meta = this.ws.getMeta(fileKey);
    const mode = opts?.mode === "edit" ? "edit" : "view";
    if (mode === "edit" && this.ws.isFileTrashed(meta)) throw new StoreError("trashed", "This file is in Trash");
    const d = this.fileData(fileKey);
    let sessionID = 0;
    if (mode === "edit") {
      const rt = this.rt(fileKey);
      const live = [...rt.sessions.values()][0];
      if (live) throw new StoreError("already-open", "This file is already open for editing", { tabId: live.tabId ?? null });
      const n = d.nextLocal;
      if (n >= RESERVED_SESSION_LIMIT) throw new StoreError("io", "This file has run out of session ids");
      sessionID = sessionIdFor(this.deviceOrdinal, n);
      d.nextLocal = n + 1;
      this.saveData(fileKey, d);
      rt.sessions.set(sessionID, { owner, tabId: opts?.tabId });
    }
    return this.opened(fileKey, d, mode, sessionID);
  }

  reattach(fileKey: FileKey, sessionID: number, owner: object): { headSeq: number } {
    const d = this.fileData(fileKey);
    const { deviceOrdinal, n } = splitSessionId(sessionID);
    if (deviceOrdinal !== this.deviceOrdinal || n < 1 || n >= d.nextLocal) throw new StoreError("invalid", `session ${sessionID} was never opened for this file`);
    const rt = this.rt(fileKey);
    const other = [...rt.sessions.entries()].find(([sid]) => sid !== sessionID);
    if (other) throw new StoreError("already-open", "This file is already open for editing", { tabId: other[1].tabId ?? null });
    rt.sessions.set(sessionID, { owner, tabId: rt.sessions.get(sessionID)?.tabId });
    return { headSeq: this.headSeq(d) };
  }

  append(fileKey: FileKey, batch: ChangeBatch, owner: object): AppendAck {
    if (!batch || !(batch.message instanceof Uint8Array)) throw new StoreError("invalid", "a batch needs a message");
    if (batch.message.length > MAX_BATCH_BYTES) throw new StoreError("too-large", "This change is too large to save");
    if (!Number.isInteger(batch.batchSeq) || batch.batchSeq < 1) throw new StoreError("invalid", `bad batchSeq ${batch.batchSeq}`);
    const d = this.fileData(fileKey);
    const rt = this.rt(fileKey);
    const session = rt.sessions.get(batch.sessionID);
    if (!session) throw new StoreError("read-only", "This file isn't open for editing in this session");
    if (session.owner !== owner) throw new StoreError("forbidden", "This session belongs to another view");
    const last = d.lastBatchSeq[batch.sessionID] ?? 0;
    if (batch.batchSeq <= last) {
      const ack = rt.acks.get(`${batch.sessionID}:${batch.batchSeq}`);
      if (ack) return { ...ack };
    }
    decodeMessage(batch.message); // refuse what doesn't decode before it is journaled
    const seq = this.headSeq(d) + 1;
    const hlc = this.hlc.now();
    d.frames.push({ seq, sessionID: batch.sessionID, batchSeq: batch.batchSeq, kind: batch.kind, label: batch.label ?? "", hlc, wallClock: batch.wallClock ?? this.clock.now(), message: batch.message });
    d.lastBatchSeq[batch.sessionID] = batch.batchSeq;
    for (const r of (batch.blobRefsAdded ?? []).filter(isSha1)) if (!d.blobRefs.includes(r)) d.blobRefs.push(r);
    if (d.frames.length > COMPACT_FRAMES) this.compact(d);
    this.saveData(fileKey, d);
    const ack = { seq, hlc };
    rt.acks.set(`${batch.sessionID}:${batch.batchSeq}`, ack);
    this.fileChanges.emit({ fileKey, seq, sessionID: batch.sessionID, kind: batch.kind, message: batch.message });
    if (!rt.updatedAtTimer) {
      rt.updatedAtTimer = setTimeout(() => {
        rt.updatedAtTimer = null;
        if (this.ws.files.has(fileKey)) void this.ws.queue.run(() => this.ws.patchFile(fileKey, { updatedAt: this.clock.now() })).catch(() => {});
      }, UPDATED_AT_DEBOUNCE_MS);
    }
    return { ...ack };
  }

  close(fileKey: FileKey, sessionID: number): void {
    this.runtime.get(fileKey)?.sessions.delete(sessionID);
  }

  /** The engine's own snapshot of the whole document (derived fields included) replaces snapshot + journal at the head it names (docs/data.md §5.5). */
  saveSnapshot(fileKey: FileKey, save: SnapshotSave, owner: object): SnapshotSaved {
    if (!save || !(save.message instanceof Uint8Array) || !save.message.length) throw new StoreError("invalid", "a snapshot needs a message");
    if (save.message.length > MAX_SNAPSHOT_BYTES) throw new StoreError("too-large", "This snapshot is too large to save");
    const d = this.fileData(fileKey);
    const session = this.rt(fileKey).sessions.get(save.sessionID);
    if (!session) throw new StoreError("read-only", "This file isn't open for editing in this session");
    if (session.owner !== owner) throw new StoreError("forbidden", "This session belongs to another view");
    const head = this.headSeq(d);
    if (head !== save.headSeq) return { adopted: false, seq: head };
    let message;
    try {
      message = decodeMessage(save.message);
    } catch (e) {
      throw new StoreError("invalid", `the snapshot doesn't decode: ${(e as Error).message}`);
    }
    const first = message.nodeChanges?.[0];
    if (!first?.guid || first.type !== "DOCUMENT" || first.guid.sessionID !== 0 || first.guid.localID !== 0) throw new StoreError("invalid", "a snapshot starts with the DOCUMENT node");
    if (message.nodeChanges!.some((n) => n.phase !== "CREATED")) throw new StoreError("invalid", "a snapshot holds CREATED nodes only");
    const losses = snapshotLosses(this.headTable(d), NodeTable.fromMessage(message));
    if (losses.total) {
      this.log("warn", `${fileKey}: refused the engine's snapshot (it lacks ${losses.total} nodes or values the head holds)`, losses);
      return { adopted: false, seq: head, refused: "loses-data", losses: { missingNodes: losses.missingNodes, droppedFields: losses.droppedFields, examples: losses.examples } };
    }
    d.snapshot = save.message;
    d.snapshotSeq = head;
    d.derivedDataVersion = message.derivedDataVersion || undefined;
    d.frames = [];
    d.blobRefs = [...messageImageHashes(message)];
    this.saveData(fileKey, d);
    return { adopted: true, seq: head };
  }

  backlog(fileKey: FileKey, fromSeq: number): FileChange[] {
    const d = this.fileData(fileKey);
    return d.frames.filter((f) => f.seq > fromSeq).map((f) => ({ fileKey, seq: f.seq, sessionID: f.sessionID, kind: f.kind, message: f.message }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Versions, thumbnails, UI state
  // -------------------------------------------------------------------------------------------------------------------

  addVersion(fileKey: FileKey, input: Pick<VersionRecord, "kind" | "title" | "description" | "restoredFrom"> & { libraryVersion?: number | null }): VersionRecord {
    const d = this.fileData(fileKey);
    this.compact(d);
    const record: VersionRecord = { libraryVersion: null, ...input, id: newVersionId(), createdAt: this.clock.now(), seq: d.snapshotSeq, sizeBytes: d.snapshot.length, blobRefs: [...d.blobRefs], ...(d.derivedDataVersion ? { derivedDataVersion: d.derivedDataVersion } : {}) };
    d.versions.unshift({ record, snapshot: d.snapshot });
    this.saveData(fileKey, d);
    return { ...record };
  }

  createVersion(fileKey: FileKey, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: VersionId }): VersionRecord {
    this.ws.getMeta(fileKey);
    const kind = input?.kind ?? "named";
    if (kind !== "named" && kind !== "restore") throw new StoreError("invalid", `bad version kind ${kind}`);
    if (kind === "restore") {
      if (!input.restoredFrom) throw new StoreError("invalid", "a restore version names the version it restored");
      this.version(fileKey, input.restoredFrom);
    }
    const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : null;
    const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : null;
    return this.addVersion(fileKey, { kind, title, description, restoredFrom: kind === "restore" ? input.restoredFrom! : null });
  }

  private version(fileKey: FileKey, id: VersionId): { record: VersionRecord; snapshot: Uint8Array } {
    const v = this.fileData(fileKey).versions.find((x) => x.record.id === id);
    if (!v) throw new StoreError("not-found", `no version ${id}`);
    return v;
  }

  updateVersion(fileKey: FileKey, id: VersionId, patch: { title?: string; description?: string }): VersionRecord {
    const d = this.fileData(fileKey);
    const v = this.version(fileKey, id);
    const r = { ...v.record };
    if (patch?.title !== undefined) r.title = String(patch.title).trim() || null;
    if (patch?.description !== undefined) r.description = String(patch.description).trim() || null;
    if (r.kind === "autosave" && r.title) r.kind = "named";
    v.record = r;
    this.saveData(fileKey, d);
    return { ...r };
  }

  openVersion(fileKey: FileKey, id: VersionId): OpenedFile {
    const v = this.version(fileKey, id);
    return { meta: { ...this.ws.getMeta(fileKey) }, mode: "view", sessionID: 0, schema: SCHEMA_BINARY.slice(), snapshot: v.snapshot, snapshotSeq: v.record.seq, derivedDataVersion: v.record.derivedDataVersion ?? 0, journal: [], headSeq: v.record.seq, ui: null, recovery: null };
  }

  restoreDiff(fileKey: FileKey, id: VersionId): Uint8Array {
    const v = this.version(fileKey, id);
    return encodeMessage(restoreDiff(this.headTable(this.fileData(fileKey)), NodeTable.fromMessage(decodeMessage(v.snapshot))));
  }

  async duplicateVersion(fileKey: FileKey, id: VersionId): Promise<FileMeta> {
    const src = this.ws.getMeta(fileKey);
    const v = this.version(fileKey, id);
    return this.addFile({ name: `${src.name} (${v.record.title ?? versionDateLabel(v.record.createdAt)})`, folderId: null, snapshot: duplicateSnapshot(v.snapshot), nextLocal: this.fileData(fileKey).nextLocal });
  }

  async saveThumbnail(fileKey: FileKey, png: Uint8Array, size: { width: number; height: number }): Promise<void> {
    if (!(png instanceof Uint8Array)) throw new StoreError("invalid", "a thumbnail is PNG bytes");
    const dims = pngSize(png);
    if (!dims) throw new StoreError("invalid", "a thumbnail must be a PNG");
    if (dims.width > 800 || dims.height > 600) throw new StoreError("invalid", "a thumbnail fits inside 800×600");
    const meta = this.ws.getMeta(fileKey);
    const d = this.fileData(fileKey);
    d.thumbnail = { bytes: png, mime: "image/png" };
    this.saveData(fileKey, d);
    await this.ws.queue.run(() => this.ws.patchFile(fileKey, { thumbnail: { version: (meta.thumbnail?.version ?? 0) + 1, width: size?.width ?? dims.width, height: size?.height ?? dims.height } }));
    this.thumbnails.emit(fileKey);
  }

  /** The thumbnail's bytes and type, or null. */
  thumbnail(fileKey: FileKey): { bytes: Uint8Array; mime: string } | null {
    try {
      return this.fileData(fileKey).thumbnail;
    } catch {
      return null;
    }
  }

  setUiState(fileKey: FileKey, patch: Partial<FileUiState>): void {
    const d = this.fileData(fileKey);
    const cur = d.ui ?? { currentPageId: null, pages: {}, leftPanelWidth: 240, rightPanelWidth: 240 };
    d.ui = { ...cur, ...(patch ?? {}), pages: { ...cur.pages, ...(patch?.pages ?? {}) } };
    this.saveData(fileKey, d);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Blobs
  // -------------------------------------------------------------------------------------------------------------------

  async putBlob(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string; size: number; mime: string }> {
    if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid", "a blob is bytes");
    const sha1 = await sha1Hex(bytes);
    const mime = sniffMime(bytes, hint?.mime);
    if (this.storage.get(K.blob(sha1)) === null) this.storage.set(K.blob(sha1), stringifyWithBytes({ mime, bytes }));
    return { sha1, size: bytes.length, mime };
  }

  blob(sha1: string): { bytes: Uint8Array; mime: string } | null {
    const raw = isSha1(sha1) ? this.storage.get(K.blob(sha1)) : null;
    return raw === null ? null : parseWithBytes<{ bytes: Uint8Array; mime: string }>(raw);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The repositories (the LocalAdapter's shape), bound to an owner of edit sessions
  // -------------------------------------------------------------------------------------------------------------------

  api(owner: object = {}): StoreApi {
    const ws = this.ws;
    const q = <T>(fn: () => Promise<T>) => ws.queue.run(fn);
    const workspace: WorkspaceRepository = {
      getWorkspace: async () => ({ ...ws.workspace }),
      updateWorkspace: (patch) => q(() => ws.updateWorkspace(patch ?? {})),
      getPrefs: async () => structuredClone(ws.prefs),
      setBrowsePrefs: (patch) => q(() => ws.setBrowsePrefs(patch ?? {})),
      listFolders: async () => ws.listFolders(),
      createFolder: (input) => q(() => ws.createFolder(input, newFolderId())),
      updateFolder: (id, patch) => q(() => ws.updateFolder(id, patch ?? {})),
      listFiles: async (query) => ws.listFiles(query),
      getFile: async (fileKey) => ws.getFile(fileKey),
      createFile: (input) => this.createFile(input),
      duplicateFile: (fileKey) => this.duplicateFile(fileKey),
      renameFile: (fileKey, name) => q(() => ws.renameFile(fileKey, name)),
      moveFiles: (keys, folderId) => q(() => ws.moveFiles(keys ?? [], folderId ?? null)),
      trash: async (items) => void (await q(() => ws.trash(items ?? {}))),
      restore: async (items) => void (await q(() => ws.restore(items ?? {}))),
      deleteForever: (items) => this.deleteItems(ws.collectDeletion(items ?? {})),
      emptyTrash: () => this.deleteItems(ws.collectDeletion(ws.trashContents())),
      setStarred: (target, starred) => q(() => ws.setStarred(target, !!starred)),
      recordViewed: (fileKey) => q(() => ws.recordViewed(fileKey)),
      removeFromRecents: (fileKey) => q(() => ws.removeFromRecents(fileKey)),
      watch: (listener) => ws.events.on(listener),
    };
    const files: FileRepository = {
      open: async (fileKey, opts) => this.open(fileKey, opts ?? { mode: "view" }, owner),
      reattach: async (fileKey, sessionID) => this.reattach(fileKey, sessionID, owner),
      append: async (fileKey, batch) => this.append(fileKey, batch, owner),
      flush: async (fileKey) => void this.ws.getMeta(fileKey),
      close: async (fileKey, sessionID) => this.close(fileKey, sessionID),
      subscribe: (fileKey, fromSeq, listener) => {
        let last = fromSeq;
        const deliver = (c: FileChange) => {
          if (c.fileKey !== fileKey || c.seq <= last) return;
          last = c.seq;
          listener(c);
        };
        for (const c of this.backlog(fileKey, fromSeq)) deliver(c);
        return this.fileChanges.on(deliver);
      },
      saveThumbnail: (fileKey, png, size) => this.saveThumbnail(fileKey, png, size),
      setUiState: async (fileKey, patch) => this.setUiState(fileKey, patch),
      saveSnapshot: async (fileKey, save) => this.saveSnapshot(fileKey, save, owner),
      listVersions: async (fileKey) => this.fileData(fileKey).versions.map((v) => ({ ...v.record })),
      createVersion: async (fileKey, input) => this.createVersion(fileKey, input ?? {}),
      updateVersion: async (fileKey, id, patch) => this.updateVersion(fileKey, id, patch),
      openVersion: async (fileKey, id) => this.openVersion(fileKey, id),
      restoreDiff: async (fileKey, id) => this.restoreDiff(fileKey, id),
      duplicateVersion: (fileKey, id) => this.duplicateVersion(fileKey, id),
      importLocalCopy: async () => {
        throw new StoreError("forbidden", "Importing from a path needs the desktop app; use importFigBytes");
      },
      importFigBytes: (bytes, name, folderId) => this.importFigBytes(bytes, name, folderId ?? null),
      exportLocalCopy: async () => {
        throw new StoreError("forbidden", "Saving a local copy needs the desktop app");
      },
    };
    const blobs: BlobStore = {
      put: (bytes, hint) => this.putBlob(bytes, hint),
      has: async (sha1s) => (sha1s ?? []).map((s) => isSha1(s) && this.storage.get(K.blob(s)) !== null),
      get: async (sha1) => {
        const b = this.blob(sha1);
        if (!b) throw new StoreError("not-found", `no blob ${sha1}`);
        return b.bytes;
      },
      url: (sha1) => `app://designer/_blob/${sha1}`,
    };
    const libraries: LibraryRegistry = this.libraries.registry();
    const previews: PreviewService = {
      status: async () => ({ publish: false, reason: NOT_SET_UP }),
      list: async () => [],
      publish: async () => {
        throw new StoreError("offline", NOT_SET_UP);
      },
      stop: async () => {
        throw new StoreError("offline", "Sharing previews needs Firebase sync, which isn't set up");
      },
      exportHtml: async () => {
        throw new StoreError("forbidden", "Exporting a preview needs the desktop app");
      },
    };
    const store: StoreAdmin = {
      shutdown: async () => this.dispose(),
      flushAll: async () => {},
      info: async () => ({
        workspaceDir: "memory://dev-store",
        wid: ws.workspace.wid,
        deviceOrdinal: this.deviceOrdinal,
        generation: 1,
        openFiles: [...this.runtime.entries()].filter(([, r]) => r.sessions.size).map(([fileKey, r]) => ({ fileKey, sessions: r.sessions.size, headSeq: this.headSeq(this.fileData(fileKey)) })),
        sync: { configured: false, enabled: false },
      }),
      collectGarbage: async () => ({ live: 0, deleted: 0, kept: this.storage.keys(`${KV_PREFIX}blob.`).length }),
    };
    return { workspace, files, blobs, libraries, previews, store };
  }
}
