/**
 * Records and value types of the store (docs/data.md §2, §5, §6, §9, §13) — shared by the store, the renderer clients
 * and the viewer. Each record is one JSON file on disk and, later, one Firestore document (§12.4).
 */
import type { SpaceId } from "../org/repositories";
import type { BranchStatus } from "../merge/branches";
import type { CloudFile } from "./cloud";

export type FileKey = string;
export type FolderId = string;
export type VersionId = string;
/** Hybrid logical clock "<ms base36 ×9>.<counter base36 ×3>.<deviceOrdinal base36 ×2>"; sorts lexicographically. */
export type Hlc = string;
/** Per-field last-write stamps */
export type Clock = Record<string, Hlc>;

export interface Workspace {
  wid: string;
  formatVersion: 1;
  /** "‹Owner›'s team": the single team the file browser shows */
  teamName: string;
  createdAt: number;
  /** Enabled automatically in every new file (Figma's team default libraries) */
  defaultLibraries: FileKey[];
  /** Unused (was set by the removed Firebase sync); kept, older workspaces carry it */
  ownerUid: string | null;
  _clk: Clock;
}

export type FolderColor = "none" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "gray";
export const FOLDER_COLORS: readonly FolderColor[] = ["none", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];
/** Folders nest up to this many levels (Figma's limit). */
export const MAX_FOLDER_DEPTH = 10;

export interface Folder {
  id: FolderId;
  name: string;
  /** null = top level of the team */
  parentId: FolderId | null;
  color: FolderColor;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  _clk: Clock;
}

export interface FileMeta {
  fileKey: FileKey;
  /** Default "Untitled" */
  name: string;
  editorType: "design";
  /** null = Drafts */
  folderId: FolderId | null;
  createdAt: number;
  /** Last edit (debounced 5 s) */
  updatedAt: number;
  trashedAt: number | null;
  thumbnail: { version: number; width: number; height: number } | null;
  enabledLibraries: FileKey[];
  library: { status: "none" | "published" | "unpublished"; latestVersion: number | null };
  importedFrom: { kind: "fig" | "legacy"; name: string } | null;
  /**
   * The org space this local copy belongs to (docs/multiplayer.md §14.6): the linked copy of an org file's room. Absent
   * or null: a local file. Local listings (Drafts, folders, search, Trash) leave such copies out; Recents and Starred
   * show them.
   */
  space?: FileSpace | null;
  /**
   * The person's Drafts on the server this record caches (docs/cloud.md §2): its account, room key, and whether it
   * waits to be registered (`pendingCreate`) or has no document here (`remote`). Absent or null: a local file.
   */
  cloud?: CloudFile | null;
  /**
   * A branch's file (docs/data.md §15.2): its main file, the branch's name and status. Absent or null: not a branch.
   * Local listings (Drafts, folders, search) leave branches out — they show under their main file; Recents, Starred and
   * Trash list them.
   */
  branch?: FileBranch | null;
  _clk: Clock;
}

/** `FileMeta.branch` (docs/data.md §15.2) */
export interface FileBranch {
  mainFileKey: FileKey;
  name: string;
  status: BranchStatus;
}

// Branches' records (docs/data.md §15.2) live with the merge types (src/shared/merge/branches.ts); re-exported here.
export type { BranchRecord, BranchReview, BranchStatus } from "../merge/branches";

/** Where an org file lives (docs/multiplayer.md §14.6): its org, its room key, its team and folder (both null: drafts). */
export interface FileSpace {
  orgId: string;
  key: string;
  teamId: string | null;
  projectId: string | null;
}

/** Where Home's Import puts a .fig when an org is the space shown: the org's Drafts (`projectId` null) or a folder */
export interface OrgImportPlace {
  orgId: string;
  projectId: string | null;
}

/** Home's sort keys (docs/research/atlas/01-app-shell-home.md §5.1) */
export const BROWSE_SORT_KEYS = ["last-viewed", "last-modified", "alphabetical", "date-created", "date-trashed", "date-shared"] as const;
export type BrowseSortKey = (typeof BROWSE_SORT_KEYS)[number];
/** Home's views that keep their own sort (§5.2) */
export const BROWSE_VIEWS = ["recents", "drafts", "folder", "folders", "starred", "search", "trash", "shared"] as const;
export type BrowseView = (typeof BROWSE_VIEWS)[number];
/** A view's sort: the key, and "default" (the key's own direction: newest first, A to Z) or "reversed" */
export interface BrowseSort {
  key: BrowseSortKey;
  order: "default" | "reversed";
}

export interface Prefs {
  /** Newest first, ≤ 50 */
  recents: { fileKey: FileKey; viewedAt: number }[];
  /** Every file ever viewed (for "Last viewed" sort) */
  viewedAt: Record<FileKey, number>;
  /** In starring order */
  starred: { files: FileKey[]; folders: FolderId[] };
  browse: {
    layout: "grid" | "list";
    /** The sort before each view kept its own: a view without one in `sorts` uses it when the view offers it */
    sort: "last-viewed" | "last-modified" | "alphabetical" | "date-created";
    /** Each view's sort (Figma keeps one per view); absent: the view's default */
    sorts?: Partial<Record<BrowseView, BrowseSort>>;
    /** The space Home shows (docs/multiplayer.md §14.6; Home's org switcher sets it, per machine). Absent: "local" */
    space?: SpaceId;
  };
  _clk: Clock;
}

export const MAX_RECENTS = 50;

/** What lists show: a file with the joins the renderer needs. */
export type FileListItem = FileMeta & { starred: boolean; lastViewedAt: number | null; sizeBytes: number };

export interface FileUiState {
  currentPageId: string | null;
  pages: Record<string, { viewport: { x: number; y: number; zoom: number }; selection: string[] }>;
  leftPanelWidth: number;
  rightPanelWidth: number;
}

// --- writes (docs/data.md §5.4) ---

/**
 * "merge" (main ← a branch) and "update" (a branch ← main) are the store's own batches (docs/data.md §15.2): journaled,
 * never undoable, applied by open editors as remote changes.
 */
export type BatchKind = "edit" | "undo" | "redo" | "system" | "remote" | "restore" | "merge" | "update";
export const BATCH_KINDS: readonly BatchKind[] = ["edit", "undo", "redo", "system", "remote", "restore", "merge", "update"];

export interface ChangeBatch {
  sessionID: number;
  /** Strictly increasing per session, from 1 */
  batchSeq: number;
  kind: BatchKind;
  label?: string;
  /** kiwi Message NODE_CHANGES, uncompressed, current schema */
  message: Uint8Array;
  /** SHA-1s of images this batch starts using */
  blobRefsAdded?: string[];
  wallClock: number;
}

export interface AppendAck {
  seq: number;
  hlc: Hlc;
}

/**
 * The whole document as the editor's engine holds it (docs/data.md §5.5 "Snapshots from the engine"): every live
 * node CREATED, in snapshot order, with its `@derived` fields and the Message's `derivedDataVersion` — what Figma's
 * files store, so the next open draws its first frame from stored geometry. The store adopts it as the head snapshot
 * only when its journal head is exactly `headSeq` (every change the editor made is journaled, nothing else arrived).
 */
export interface SnapshotSave {
  sessionID: number;
  /** kiwi Message NODE_CHANGES, uncompressed, current schema */
  message: Uint8Array;
  /** The journal seq the document corresponds to (the last ack the editor saw, or the head it opened at) */
  headSeq: number;
}

export interface SnapshotSaved {
  /** False: the head moved past `headSeq` (or the store was busy); the editor may try again later */
  adopted: boolean;
  /** The store's head seq now */
  seq: number;
  /**
   * Set when the store refused the snapshot for what it is, not for when it came: "loses-data" — it lacks a node or a
   * value the head holds (docs/data.md §5.5); the editor stops sending snapshots for this session.
   */
  refused?: "loses-data";
  /** With `refused`: how many nodes and values it would have lost, and a few examples */
  losses?: { missingNodes: number; droppedFields: Record<string, number>; examples: string[] };
}

/** An engine snapshot is at most this large. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;

/** A batch is at most this large (`too-large` otherwise). */
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;

// --- versions (docs/data.md §6) ---

export interface VersionRecord {
  id: VersionId;
  /** "branch": "Branch created" (on main and on the branch), "update": "Updated from main", "merge": "Branch merged"
   *  (docs/data.md §15.2) — kept forever, as every kind but "autosave" */
  kind: "autosave" | "named" | "restore" | "publish" | "import" | "branch" | "update" | "merge";
  title: string | null;
  description: string | null;
  createdAt: number;
  /** Journal position the snapshot represents */
  seq: number;
  sizeBytes: number;
  blobRefs: string[];
  restoredFrom: VersionId | null;
  /** kind "publish": the library version it published */
  libraryVersion: number | null;
  /** `Message.derivedDataVersion` of the version's snapshot (absent / 0: none) */
  derivedDataVersion?: number;
}

// --- libraries (docs/data.md §9) ---

export type AssetKind = "COMPONENT" | "COMPONENT_SET" | "STYLE" | "VARIABLE_COLLECTION" | "VARIABLE";

export interface LibraryAsset {
  /** 40 lowercase hex, stable across publishes and renames */
  key: string;
  kind: AssetKind;
  styleType?: "FILL" | "TEXT" | "EFFECT" | "GRID";
  resolvedType?: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  name: string;
  description: string;
  /** Node GUID ("s:l") in the library file */
  guid: string;
  /** SHA-1 of the canonical payload */
  versionHash: string;
  /** Shipped because a published asset needs it; never listed in Assets */
  dependencyOnly: boolean;
  /** Keys: nested instances' components, aliased variables, styles used */
  dependencies: string[];
  componentSetKey?: string;
  collectionKey?: string;
  /** Assets panel grouping: file › page › frame */
  containingFrame?: { pageName: string; frameName?: string };
  /** ≤ 256 px, 2× */
  thumbnail: { sha1: string; width: number; height: number } | null;
  /**
   * Figma's userFacingVersion (atlas 12 §6.1, §9): the library version (as text) that published this content — a new
   * one when the asset is created or its content changes, the previous one kept while it doesn't. The store stamps it
   * (`stampUserFacingVersions`); manifests written before 2026-10-18 have none.
   */
  userFacingVersion?: string;
}

export interface Redirect {
  fromLibraryFileKey: FileKey;
  fromKey: string;
  toLibraryFileKey: FileKey;
  toKey: string;
  version: number;
  at: number;
}

export interface LibraryRecord {
  libraryFileKey: FileKey;
  status: "published" | "unpublished" | "trashed" | "deleted";
  latestVersion: number;
  firstPublishedAt: number;
  lastPublishedAt: number;
  counts: { components: number; styles: number; variables: number };
  /** Assets moved into this library (§9.5) */
  movedIn: Redirect[];
  _clk: Clock;
}

export interface LibraryVersion {
  libraryFileKey: FileKey;
  version: number;
  publishedAt: number;
  description: string;
  changes: { created: string[]; modified: string[]; removed: string[]; moved: Redirect[] };
  /** Complete manifest of this version */
  assets: LibraryAsset[];
}

/** NODE_CHANGES of the asset's subtree + its blobs, with library GUIDs */
export interface AssetPayload {
  key: string;
  versionHash: string;
  message: Uint8Array;
}

/** `payload` is required unless (key, versionHash) is already stored. */
export interface PublishAsset extends Omit<LibraryAsset, "thumbnail"> {
  payload?: Uint8Array;
  thumbnailPng?: Uint8Array;
}

export interface PublishRequest {
  libraryFileKey: FileKey;
  description: string;
  /** Every asset the new version contains (selected + kept + dependencies) */
  assets: PublishAsset[];
  moves: { key: string; fromLibraryFileKey: FileKey; fromKey: string; mode: "move" | "copy" }[];
  /**
   * An org file's library (docs/data.md §16.6): the Publish dialog's "Allow any member of ‹org› to access the file"
   * ("org") or not ("team"). Absent: the library's current scope ("team" on a first publish). Local libraries ignore it.
   */
  scope?: "team" | "org";
}

export interface PublishPreview {
  created: LibraryAsset[];
  modified: LibraryAsset[];
  removed: LibraryAsset[];
  moved: Redirect[];
  unchanged: string[];
}

export interface LibraryDiff {
  latestVersion: number;
  updated: LibraryAsset[];
  removed: string[];
  moved: Redirect[];
  /**
   * The publishes the updated assets' content comes from (their `userFacingVersion`s), newest first — the Updates
   * tab's groups with each publish's description (atlas 12 §6.3). Absent from a store that doesn't know them.
   */
  publishes?: LibraryPublish[];
}

/** One publish of a library, as the Updates tab heads its group */
export interface LibraryPublish {
  version: number;
  publishedAt: number;
  description: string;
}

// --- previews (docs/data.md §13) ---

export interface PreviewOptions {
  pageIds: string[] | "all";
  inspect: boolean;
  export: boolean;
  expiresInDays: 7 | 30 | null;
}

export interface PreviewRecord {
  previewId: string;
  fileKey: FileKey;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  options: PreviewOptions;
  blobRefs: string[];
  url: string;
}

// --- identifier formats (docs/data.md §1) ---

const BASE62 = /^[0-9A-Za-z]+$/;
export const isFileKey = (s: unknown): s is FileKey => typeof s === "string" && s.length === 22 && BASE62.test(s);
export const isFolderId = (s: unknown): s is FolderId => typeof s === "string" && s.length === 16 && BASE62.test(s);
export const isVersionId = (s: unknown): s is VersionId => typeof s === "string" && s.length === 16 && BASE62.test(s);
export const isSha1 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
export const isAssetKey = isSha1;
