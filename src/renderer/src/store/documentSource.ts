/**
 * The editor's DocumentSource over the store (docs/editor.md §3, docs/data.md §5.4–§6): one edit session of one file.
 *
 *   const source = await openStoreDocument(getStoreClient(), fileKey, { tabId });
 *   engine.load(await source.load());                         // snapshot + journal, merged into one snapshot
 *   engine.onDocumentChanged((e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
 *   source.onExternalChanges((m) => engine.applyChanges(m, APPLY_REMOTE));   // sync pulls, another session's writes
 *   source.onMetaChanged(({ fileName, location, trashed }) => …);           // renamed/moved/trashed elsewhere
 *   await source.close();                                     // tab closes: flush, end the session
 *
 * Every committed change becomes one `ChangeBatch` (batchSeq from 1 per session, kind from the engine's transaction
 * kind, "Restore version" → `restore`), appended in commit order; the StoreClient keeps unacknowledged batches across
 * a store restart and resends them. `flush()` resolves once every change handed over is acknowledged and fsynced, and
 * rejects with the first append the store refused since the last flush.
 *
 * Versions (§6): `saveVersion` (⌥⌘S: flush + a named version), `listVersions`, `updateVersion` ("Name this version"),
 * `openVersion` (a read-only document), `restoreVersion` (the restore diff handed to the editor to apply as one
 * undoable "Restore version" edit, journaled as `restore`, then a "restore" history entry), `duplicateVersion`.
 */
import type { DocumentSource, LibraryAccess } from "@/editor/documentSource";
import type { Message as EngineMessage } from "@/engine/codec";
import { decodeMessage, encodeMessage } from "../../../shared/schema/codec";
import { messageImageHashes, NodeTable } from "../../../shared/schema/patch";
import type { FileChange, OpenedFile, StoreApi, Unsubscribe, WorkspaceEvent } from "../../../shared/store/repositories";
import type { BatchKind, ChangeBatch, FileKey, FileMeta, FileUiState, Folder, FolderId, VersionId, VersionRecord } from "../../../shared/store/types";
import { messageToEngine, messageToKiwi } from "./engineMessage";
import { storeLibraryAccess } from "./libraryAccess";

/** The engine's transaction kinds (DOCUMENT_CHANGED's `kind`, engine.md §9.2). */
export type EngineChangeKind = "USER" | "UNDO" | "REDO" | "SYSTEM";

/** What the editor knows about a change besides its Message (both optional). */
export interface ChangeInfo {
  kind?: EngineChangeKind;
  /** The undo label ("Move", "Paste"); "Restore version" makes the batch a `restore` */
  label?: string;
}

/** Where the file is and whether it still exists, as the header and the tab show it. */
export interface DocumentMeta {
  fileName: string;
  /** "Drafts" or the folder's name */
  location: string;
  folderId: FolderId | null;
  /** In Trash (by itself or through its folder): the tab should close */
  trashed: boolean;
  /** Deleted forever: the tab should close */
  deleted: boolean;
}

export interface StoreDocumentSourceOptions {
  /** The tab's id, so `already-open` can name the tab that holds the file */
  tabId?: string;
  /** Record the file in Recents on open (default true; Figma does it when the tab activates) */
  recordViewed?: boolean;
  /** Problems no caller awaits (an append the store refused, a failed UI-state write) */
  onError?: (e: unknown) => void;
  /** `setUiState` debounce (docs/data.md §5.7: 2 s) */
  uiStateDelayMs?: number;
  /** Wall clock for batches (tests) */
  now?: () => number;
}

export interface StoreDocumentSource extends DocumentSource {
  readonly fileKey: FileKey;
  readonly sessionID: number;
  readonly fileName: string;
  readonly location: string;
  /** The file's record as last seen */
  readonly meta: FileMeta;
  /** Not null when opening had to recover (the editor shows a toast, docs/data.md §5.6) */
  readonly recovery: OpenedFile["recovery"];
  /** The file's local UI state (current page, viewports, selection, panel widths) from the last session */
  readonly uiState: FileUiState | null;
  /** Journal position the loaded document represents */
  readonly headSeq: number;
  readonly closed: boolean;

  load(): Promise<EngineMessage>;
  /** One committed change, in commit order. `info` maps the engine's kind and label onto the batch. */
  onChanges(changes: EngineMessage, info?: ChangeInfo): void;
  flush(): Promise<void>;
  rename(name: string): Promise<void>;

  /** Changes to this file that this source did not make (sync pulls, kind "remote"), to apply without an undo entry. */
  onExternalChanges(listener: (changes: EngineMessage, info: { seq: number; kind: BatchKind }) => void): Unsubscribe;
  /** The file was renamed, moved, trashed, restored or deleted (from Home, the menu or another window). */
  onMetaChanged(listener: (meta: DocumentMeta) => void): Unsubscribe;
  onError(listener: (e: unknown) => void): Unsubscribe;

  /** A PNG ≤ 800×600 (docs/data.md §5.7); Home shows it on the file's card */
  saveThumbnail(png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  /** Debounced (2 s); written on close at the latest */
  setUiState(patch: Partial<FileUiState>): void;

  listVersions(): Promise<VersionRecord[]>;
  /** "Save to Version History…" (⌥⌘S) */
  saveVersion(input?: { title?: string; description?: string }): Promise<VersionRecord>;
  /** "Name this version" / edit a version's title and description */
  updateVersion(id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord>;
  /** A version as a read-only document (view mode) */
  openVersion(id: VersionId): Promise<EngineMessage>;
  /**
   * Non-destructive restore: hands `apply` the diff that turns the current document into the version; the editor
   * applies it as one undoable edit (APPLY_USER, label "Restore version"), whose change comes back through
   * `onChanges` and is journaled as `restore`. Then records a "restore" version and returns it.
   */
  restoreVersion(id: VersionId, apply: (diff: EngineMessage) => void | Promise<void>): Promise<VersionRecord>;
  /** A new file in Drafts from a version */
  duplicateVersion(id: VersionId): Promise<FileMeta>;

  /** Writes the pending UI state, flushes, ends the edit session. Idempotent. */
  close(): Promise<void>;

  /** The workspace's libraries for this file (docs/data.md §9) */
  readonly libraries: LibraryAccess;
}

export const RESTORE_LABEL = "Restore version";

const KIND: Record<EngineChangeKind, BatchKind> = { USER: "edit", UNDO: "undo", REDO: "redo", SYSTEM: "system" };

function batchKind(info: ChangeInfo | undefined, restoring: boolean): BatchKind {
  if (restoring || info?.label === RESTORE_LABEL) return "restore";
  return (info?.kind && KIND[info.kind]) || "edit";
}

/** The opened file's snapshot with its journal applied: one snapshot Message, DOCUMENT first, parents before children. */
export function mergedDocument(opened: Pick<OpenedFile, "snapshot" | "journal" | "sessionID">): EngineMessage {
  const table = NodeTable.fromMessage(decodeMessage(opened.snapshot));
  for (const frame of opened.journal) table.apply(decodeMessage(frame.message));
  return messageToEngine(table.toMessage({ sessionID: 0 }));
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
        console.error("document source: listener failed", err);
      }
    }
  }
  get size(): number {
    return this.set.size;
  }
}

/** Opens `fileKey` for editing (a new session) and returns its DocumentSource. Rejects with the store's error (`already-open`, `trashed`, `not-found`, `corrupt`). */
export async function openStoreDocument(store: StoreApi, fileKey: FileKey, opts: StoreDocumentSourceOptions = {}): Promise<StoreDocumentSource> {
  const opened = await store.files.open(fileKey, { mode: "edit", tabId: opts.tabId });
  let folders: Folder[] = [];
  if (opened.meta.folderId) folders = await store.workspace.listFolders().catch(() => []);
  if (opts.recordViewed !== false) await store.workspace.recordViewed(fileKey).catch((e) => opts.onError?.(e));
  return new Source(store, opened, folders, opts);
}

class Source implements StoreDocumentSource {
  readonly fileKey: FileKey;
  readonly sessionID: number;
  readonly recovery: OpenedFile["recovery"];
  readonly uiState: FileUiState | null;
  readonly headSeq: number;
  meta: FileMeta;
  closed = false;
  private trashed = false;
  private deleted = false;
  private readonly folderNames = new Map<FolderId, string>();
  private batchSeq = 0;
  private restoring = false;
  private inFlight = new Set<Promise<unknown>>();
  private firstError: unknown = null;
  private readonly errors = new Listeners<unknown>();
  private readonly metaListeners = new Listeners<DocumentMeta>();
  private readonly external = new Listeners<{ message: EngineMessage; seq: number; kind: BatchKind }>();
  private externalOff: Unsubscribe | null = null;
  private readonly offWatch: Unsubscribe;
  private readonly fileMeta = new Listeners<FileMeta>();
  readonly libraries: LibraryAccess;
  private uiPatch: Partial<FileUiState> | null = null;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly store: StoreApi,
    private opened: OpenedFile | null,
    folders: Folder[],
    private readonly opts: StoreDocumentSourceOptions,
  ) {
    const o = opened!;
    this.fileKey = o.meta.fileKey;
    this.sessionID = o.sessionID;
    this.recovery = o.recovery;
    this.uiState = o.ui;
    this.headSeq = o.headSeq;
    this.meta = o.meta;
    for (const f of folders) this.folderNames.set(f.id, f.name);
    this.offWatch = store.workspace.watch((e) => {
      const before = this.meta;
      this.onWorkspaceEvent(e);
      if (this.meta !== before) this.fileMeta.emit(this.meta);
    });
    this.libraries = storeLibraryAccess(store, () => this.meta, (l) => this.fileMeta.add(l));
  }

  get fileName(): string {
    return this.meta.name;
  }

  get location(): string {
    const id = this.meta.folderId;
    return id === null ? "Drafts" : (this.folderNames.get(id) ?? "Drafts");
  }

  private snapshotMeta(): DocumentMeta {
    return { fileName: this.fileName, location: this.location, folderId: this.meta.folderId, trashed: this.trashed, deleted: this.deleted };
  }

  private fail(e: unknown): void {
    this.firstError ??= e;
    this.errors.emit(e);
    this.opts.onError?.(e);
  }

  private onWorkspaceEvent(e: WorkspaceEvent): void {
    let changed = false;
    switch (e.type) {
      case "file.renamed":
        if (e.fileKey !== this.fileKey || e.name === this.meta.name) return;
        this.meta = { ...this.meta, name: e.name };
        changed = true;
        break;
      case "file.moved":
        if (e.fileKey !== this.fileKey) return;
        this.meta = { ...this.meta, folderId: e.folderId };
        if (e.folderId && !this.folderNames.has(e.folderId)) {
          void this.store.workspace
            .listFolders()
            .then((list) => {
              for (const f of list) this.folderNames.set(f.id, f.name);
              this.metaListeners.emit(this.snapshotMeta());
            })
            .catch(() => {});
          return;
        }
        changed = true;
        break;
      case "file.updated":
      case "file.restored":
        if (e.file.fileKey !== this.fileKey) return;
        changed = e.file.name !== this.meta.name || e.file.folderId !== this.meta.folderId || (e.type === "file.restored" && this.trashed);
        this.meta = { ...e.file };
        if (e.type === "file.restored") this.trashed = false;
        break;
      case "file.trashed":
        if (e.fileKey !== this.fileKey || this.trashed) return;
        this.trashed = true;
        changed = true;
        break;
      case "file.deleted":
        if (e.fileKey !== this.fileKey) return;
        this.deleted = true;
        changed = true;
        break;
      case "folder.created":
      case "folder.updated":
      case "folder.restored":
        if (this.folderNames.get(e.folder.id) === e.folder.name) return;
        this.folderNames.set(e.folder.id, e.folder.name);
        changed = e.folder.id === this.meta.folderId;
        break;
      default:
        return;
    }
    if (changed) this.metaListeners.emit(this.snapshotMeta());
  }

  async load(): Promise<EngineMessage> {
    if (!this.opened) throw new Error("This document source was closed");
    return mergedDocument(this.opened);
  }

  onChanges(changes: EngineMessage, info?: ChangeInfo): void {
    if (this.closed) {
      this.fail(new Error("A change arrived after the document was closed; it wasn't saved"));
      return;
    }
    if (!changes?.nodeChanges?.length) return;
    let batch: ChangeBatch;
    try {
      const kiwi = messageToKiwi({ ...changes, sessionID: this.sessionID });
      const refs = [...messageImageHashes(kiwi)];
      batch = {
        sessionID: this.sessionID,
        batchSeq: ++this.batchSeq,
        kind: batchKind(info, this.restoring),
        label: info?.label ?? (this.restoring ? RESTORE_LABEL : undefined),
        message: encodeMessage(kiwi),
        ...(refs.length ? { blobRefsAdded: refs } : {}),
        wallClock: (this.opts.now ?? Date.now)(),
      };
    } catch (e) {
      this.fail(e);
      return;
    }
    const p = this.store.files.append(this.fileKey, batch).then(
      () => undefined,
      (e) => this.fail(e),
    );
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  async flush(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
    const err = this.firstError;
    this.firstError = null;
    if (err) throw err;
    await this.store.files.flush(this.fileKey);
  }

  async rename(name: string): Promise<void> {
    const meta = await this.store.workspace.renameFile(this.fileKey, name);
    if (meta.name !== this.meta.name) {
      this.meta = { ...this.meta, name: meta.name };
      this.metaListeners.emit(this.snapshotMeta());
    }
  }

  onExternalChanges(listener: (changes: EngineMessage, info: { seq: number; kind: BatchKind }) => void): Unsubscribe {
    const off = this.external.add((e) => listener(e.message, { seq: e.seq, kind: e.kind }));
    if (!this.externalOff && !this.closed) {
      this.externalOff = this.store.files.subscribe(this.fileKey, this.headSeq, (c: FileChange) => {
        if (c.sessionID === this.sessionID) return; // our own batches
        try {
          this.external.emit({ message: messageToEngine(decodeMessage(c.message)), seq: c.seq, kind: c.kind });
        } catch (e) {
          this.fail(e);
        }
      });
    }
    return () => {
      off();
      if (!this.external.size && this.externalOff) {
        this.externalOff();
        this.externalOff = null;
      }
    };
  }

  onMetaChanged(listener: (meta: DocumentMeta) => void): Unsubscribe {
    return this.metaListeners.add(listener);
  }

  onError(listener: (e: unknown) => void): Unsubscribe {
    return this.errors.add(listener);
  }

  saveThumbnail(png: Uint8Array, size: { width: number; height: number }): Promise<void> {
    return this.store.files.saveThumbnail(this.fileKey, png, size);
  }

  setUiState(patch: Partial<FileUiState>): void {
    if (this.closed) return;
    this.uiPatch = { ...(this.uiPatch ?? {}), ...patch };
    if (this.uiTimer) clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => void this.writeUiState(), this.opts.uiStateDelayMs ?? 2000);
  }

  private async writeUiState(): Promise<void> {
    if (this.uiTimer) clearTimeout(this.uiTimer);
    this.uiTimer = null;
    const patch = this.uiPatch;
    this.uiPatch = null;
    if (!patch) return;
    await this.store.files.setUiState(this.fileKey, patch).catch((e) => this.fail(e));
  }

  listVersions(): Promise<VersionRecord[]> {
    return this.store.files.listVersions(this.fileKey);
  }

  async saveVersion(input: { title?: string; description?: string } = {}): Promise<VersionRecord> {
    await this.flush();
    return this.store.files.createVersion(this.fileKey, { kind: "named", title: input.title, description: input.description });
  }

  updateVersion(id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord> {
    return this.store.files.updateVersion(this.fileKey, id, patch);
  }

  async openVersion(id: VersionId): Promise<EngineMessage> {
    return mergedDocument(await this.store.files.openVersion(this.fileKey, id));
  }

  async restoreVersion(id: VersionId, apply: (diff: EngineMessage) => void | Promise<void>): Promise<VersionRecord> {
    await this.flush();
    const diff = messageToEngine(decodeMessage(await this.store.files.restoreDiff(this.fileKey, id)));
    this.restoring = true;
    try {
      await apply(diff);
    } finally {
      this.restoring = false;
    }
    await this.flush();
    return this.store.files.createVersion(this.fileKey, { kind: "restore", restoredFrom: id });
  }

  duplicateVersion(id: VersionId): Promise<FileMeta> {
    return this.store.files.duplicateVersion(this.fileKey, id);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.writeUiState();
        await this.flush().catch((e) => this.opts.onError?.(e));
      } finally {
        this.closed = true;
        this.opened = null;
        this.offWatch();
        this.externalOff?.();
        this.externalOff = null;
        await this.store.files.close(this.fileKey, this.sessionID).catch((e) => this.opts.onError?.(e));
      }
    })();
    return this.closing;
  }
}
