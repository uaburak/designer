/**
 * The repository interfaces (docs/data.md §8.1). `LocalAdapter` (store process) implements them against the disk;
 * `StoreClient` (renderers, main) implements them as RPC proxies over the store port; `FirestoreAdapter` (store
 * process, later, behind sync) against Firestore and Storage. The UI only ever talks to the local one.
 */
import type {
  AppendAck,
  AssetPayload,
  BatchKind,
  ChangeBatch,
  FileKey,
  FileListItem,
  FileMeta,
  FileUiState,
  Folder,
  FolderColor,
  FolderId,
  LibraryDiff,
  LibraryRecord,
  LibraryVersion,
  PreviewOptions,
  PreviewRecord,
  Prefs,
  PublishAsset,
  PublishPreview,
  PublishRequest,
  VersionId,
  VersionRecord,
  Workspace,
} from "./types";

export type Unsubscribe = () => void;

export type FileQuery =
  | { in: "recents" }
  | { in: "drafts" }
  | { in: "folder"; folderId: FolderId }
  | { in: "starred" }
  | { in: "trash" }
  | { in: "search"; text: string };

export type WorkspaceEvent =
  | { type: "workspace.updated"; workspace: Workspace }
  | { type: "prefs.updated"; prefs: Prefs }
  | { type: "folder.created" | "folder.updated" | "folder.trashed" | "folder.restored"; folder: Folder }
  | { type: "folder.deleted"; folderId: FolderId }
  | { type: "file.created" | "file.updated" | "file.restored"; file: FileMeta }
  | { type: "file.renamed"; fileKey: FileKey; name: string }
  | { type: "file.moved"; fileKey: FileKey; folderId: FolderId | null }
  | { type: "file.trashed"; fileKey: FileKey; viaFolder: FolderId | null }
  | { type: "file.deleted"; fileKey: FileKey };

export interface WorkspaceRepository {
  getWorkspace(): Promise<Workspace>;
  updateWorkspace(patch: Partial<Pick<Workspace, "teamName" | "defaultLibraries">>): Promise<Workspace>;
  getPrefs(): Promise<Prefs>;
  setBrowsePrefs(patch: Partial<Prefs["browse"]>): Promise<Prefs>;

  /** All folders, trashed ones included (flagged by trashedAt) */
  listFolders(): Promise<Folder[]>;
  createFolder(input: { name: string; parentId: FolderId | null; color?: FolderColor }): Promise<Folder>;
  updateFolder(id: FolderId, patch: Partial<Pick<Folder, "name" | "color" | "parentId">>): Promise<Folder>;

  listFiles(query: FileQuery): Promise<FileListItem[]>;
  getFile(fileKey: FileKey): Promise<FileListItem>;
  createFile(input: { name?: string; folderId: FolderId | null }): Promise<FileMeta>;
  duplicateFile(fileKey: FileKey): Promise<FileMeta>;
  renameFile(fileKey: FileKey, name: string): Promise<FileMeta>;
  moveFiles(fileKeys: FileKey[], folderId: FolderId | null): Promise<void>;

  trash(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void>;
  restore(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void>;
  /** Items must be in Trash */
  deleteForever(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void>;
  emptyTrash(): Promise<void>;

  setStarred(target: { fileKey: FileKey } | { folderId: FolderId }, starred: boolean): Promise<void>;
  recordViewed(fileKey: FileKey): Promise<void>;
  removeFromRecents(fileKey: FileKey): Promise<void>;

  watch(listener: (e: WorkspaceEvent) => void): Unsubscribe;
}

export interface OpenedFile {
  meta: FileMeta;
  mode: "edit" | "view";
  /** 0 in view mode */
  sessionID: number;
  /** Current binary schema */
  schema: Uint8Array;
  /** Raw kiwi Message, uncompressed, current schema */
  snapshot: Uint8Array;
  snapshotSeq: number;
  journal: { seq: number; kind: BatchKind; message: Uint8Array }[];
  headSeq: number;
  ui: FileUiState | null;
  recovery: null | { truncatedBytes: number; droppedFrames: number; fellBackTo: "previous-snapshot" | "version" | null };
}

export interface FileChange {
  fileKey: FileKey;
  seq: number;
  sessionID: number;
  kind: BatchKind;
  message: Uint8Array;
}

export interface FileRepository {
  open(fileKey: FileKey, opts: { mode: "edit" | "view"; tabId?: string; subscribe?: boolean }): Promise<OpenedFile>;
  reattach(fileKey: FileKey, sessionID: number, lastAckedBatchSeq: number): Promise<{ headSeq: number }>;
  append(fileKey: FileKey, batch: ChangeBatch): Promise<AppendAck>;
  /** Resolves after fdatasync */
  flush(fileKey: FileKey): Promise<void>;
  close(fileKey: FileKey, sessionID: number): Promise<void>;
  subscribe(fileKey: FileKey, fromSeq: number, listener: (c: FileChange) => void): Unsubscribe;

  saveThumbnail(fileKey: FileKey, png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  setUiState(fileKey: FileKey, patch: Partial<FileUiState>): Promise<void>;

  listVersions(fileKey: FileKey): Promise<VersionRecord[]>;
  createVersion(fileKey: FileKey, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: VersionId }): Promise<VersionRecord>;
  updateVersion(fileKey: FileKey, id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord>;
  /** View mode */
  openVersion(fileKey: FileKey, id: VersionId): Promise<OpenedFile>;
  /** NODE_CHANGES message */
  restoreDiff(fileKey: FileKey, id: VersionId): Promise<Uint8Array>;
  duplicateVersion(fileKey: FileKey, id: VersionId): Promise<FileMeta>;

  /** Main only (takes a path) */
  importLocalCopy(path: string, folderId: FolderId | null): Promise<FileMeta>;
  /**
   * A `.fig` from its bytes (Home's Import in any window, a file dropped from Finder, the browser demo): a new file in
   * `folderId` (default Drafts) named from the .fig's meta (else `name`, ".fig" dropped), with its images, thumbnail
   * and an "import" version. `unsupported-format` for FigJam/Slides/not a .fig, `corrupt`, `too-large` (> 1 GB).
   */
  importFigBytes(bytes: Uint8Array, name: string, folderId?: FolderId | null): Promise<FileMeta>;
  /** Main only */
  exportLocalCopy(fileKey: FileKey, path: string): Promise<void>;
}

export interface BlobStore {
  put(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string; size: number; mime: string }>;
  has(sha1s: string[]): Promise<boolean[]>;
  /** Renderers normally use app://designer/_blob/<sha1> */
  get(sha1: string): Promise<Uint8Array>;
  /** Client-side helper, not an RPC */
  url(sha1: string): string;
}

export type LibraryEvent = { type: "published"; libraryFileKey: FileKey; version: number } | { type: "status"; libraryFileKey: FileKey; status: LibraryRecord["status"] };

export interface LibraryRegistry {
  /** Published, not trashed, excluding forFileKey */
  listAvailable(forFileKey?: FileKey): Promise<LibraryRecord[]>;
  getRecord(libraryFileKey: FileKey): Promise<LibraryRecord | null>;
  /** Default latest */
  getVersion(libraryFileKey: FileKey, version?: number): Promise<LibraryVersion>;
  previewPublish(libraryFileKey: FileKey, assets: PublishAsset[]): Promise<PublishPreview>;
  publish(req: PublishRequest): Promise<LibraryVersion>;
  unpublish(libraryFileKey: FileKey): Promise<void>;
  setEnabled(fileKey: FileKey, libraryFileKey: FileKey, enabled: boolean): Promise<FileMeta>;
  getPayloads(libraryFileKey: FileKey, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }): Promise<AssetPayload[]>;
  diff(libraryFileKey: FileKey, have: { key: string; versionHash: string }[]): Promise<LibraryDiff>;
  watch(listener: (e: LibraryEvent) => void): Unsubscribe;
}

/** Not one of the four repositories: a store service that exists only once Firebase is configured (§13). */
export interface PreviewService {
  list(fileKey?: FileKey): Promise<PreviewRecord[]>;
  /** Create or update in place */
  publish(fileKey: FileKey, input: { snapshot: Uint8Array; blobRefs: string[]; options: PreviewOptions }): Promise<PreviewRecord>;
  stop(previewId: string): Promise<void>;
}

/** `store.*`: process-level calls, main only. */
export interface StoreAdmin {
  /** Stop accepting appends, fsync every open file, finish or abandon compaction, release the lock */
  shutdown(): Promise<void>;
  /** fsync every open file (the quit flush, docs/desktop.md §6) */
  flushAll(): Promise<void>;
  info(): Promise<StoreInfo>;
  /** Mark and sweep the blob store now (normally idle-scheduled, §10.3) */
  collectGarbage(): Promise<{ live: number; deleted: number; kept: number }>;
}

export interface StoreInfo {
  workspaceDir: string;
  wid: string;
  deviceOrdinal: number;
  generation: number;
  openFiles: { fileKey: FileKey; sessions: number; headSeq: number }[];
  sync: { configured: boolean; enabled: boolean };
}

/** Everything one port can reach. */
export interface StoreApi {
  workspace: WorkspaceRepository;
  files: FileRepository;
  blobs: BlobStore;
  libraries: LibraryRegistry;
  previews: PreviewService;
  store: StoreAdmin;
}
