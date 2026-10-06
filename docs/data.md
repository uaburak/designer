# Data

Status: **contract**, 2026-10-06. Replaces the "Data" part of `docs/architecture.md` and the Firestore rules in `AGENTS.md` (one transaction per Save, the global `design/*` design system, the site's Firebase). Those describe the old site admin.

> **Schema alignment (2026-10-06).** `schema/document.kiwi` + `docs/schema.md` were finished after this document and decide every field name. Where this document differs, the schema wins — see `docs/schema.md` §14: component-property bindings are `PROP_REF` entries in `parameterConsumptionMap` (not `componentPropRefs`); variable bindings use `parameterConsumptionMap` only; style references are `styleIdFor*` only; library copies carry `key`, `sourceLibraryKey`, `publishID`, `version` and per-node `overrideKey` (not `sharedSymbolReference`/`sharedStyleReference`/`componentKey`); `backgroundColor` is CANVAS-only (frames use `fillPaints`); `TextData.lines` is source data (layout lives in `derivedTextData`); a CREATED change for a live GUID is a full replace; `textPathStart` is not in v1.

Companion contract: `docs/desktop.md` (processes, IPC, protocol, clipboard, fonts).

Scope: everything above the document:
- the workspace on disk: Drafts, folders, files, Trash, Starred, Recents and thumbnails;
- the per-file format: snapshot, journal, versions;
- the single writer and its API;
- libraries;
- blobs;
- import and export;
- the repository pattern and the later Firebase mapping;
- developer previews;
- the legacy import and what is deleted.

What a node, a property, a variable or a component *is* belongs to the document contract. That contract is `docs/engine.md` §2, and its schema is `schema/document.kiwi`, packaged as `resources/schema/document.kiwi`. This document treats nodes as kiwi `NodeChange`s keyed by GUID and needs only the facts listed under **Needs from document contract**.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Model | Figma's: a **workspace** (one team) holds **Drafts** (files with no folder) and **folders**. Folders nest up to 10 levels and can be colour-coded; Figma renamed projects to folders on 2026-08-03 (help.figma.com/hc/en-us/articles/41753150926103). Plus **Recents**, **Starred** and **Trash**. Every file owns its pages, local variables, styles and components, and any file in a folder can publish a library. |
| Where | `<userData>/Workspace`, so `~/Library/Application Support/DesignerV2/Workspace`. It can be moved to another *local* folder in Settings. Cloud-synced folders are refused. |
| On disk | One JSON file per record (workspace, folder, file meta, prefs, library), each a 1:1 future Firestore document. Each file is a **directory** holding a snapshot (a `canvas.fig`-identical kiwi container), an append-only **journal** of change `Message`s, a thumbnail, version snapshots and a local UI state. |
| Blobs | One content-addressed store per workspace (`blobs/<sha1>`), shared by every file, version, library and preview. Mark-and-sweep GC. Exports pack `images/<sha1>` the way `.fig` does. |
| Writer | **One writer**: the store `utilityProcess`. Views reach it over a `MessagePort` RPC. The engine is the only thing that *edits* documents; the store merges NodeChanges generically, driven by the schema, so it can compact, restore and sync without the engine. |
| Durability | An edit batch is acknowledged after `write()`, fsynced at most 1 s later, and fsynced immediately on flush (tab close, quit, hide). Crash recovery is snapshot plus journal replay, with torn-tail truncation and the previous snapshot generation as fallback. |
| Versions | An autosave checkpoint every 30 min of editing, named versions (⌥⌘S), and library publishes. Each is a full snapshot, hard-linked. Restoring is non-destructive: a diff applied as one undoable edit. |
| Libraries | Publishing snapshots each non-hidden component, set, style and variable under a stable 40-hex `key` and a content `versionHash`, into a workspace registry stored per asset version. Consumers keep **in-document read-only copies** (Figma's internal-only canvas), so they work offline and without the library. Updates are pulled through Review. "Move to this file" records redirects. Drafts cannot publish, as in Figma. |
| Repositories | `WorkspaceRepository`, `FileRepository`, `BlobStore`, `LibraryRegistry`. `LocalAdapter` is always authoritative. `FirestoreAdapter` is added later behind a `Replicator` that pushes and pulls with per-property LWW using hybrid logical clocks. `PreviewAdapter` serves the web viewer. |
| Firebase | Off until the owner adds a config file to `userData/firebase/config.json`. Nothing goes in the repo. The Firebase SDK runs only in the store process. Paths: `workspaces/{wid}/…`, `files/{fileKey}/nodes/{guid}` with one field per property, versions, and Storage `blobs/{sha1}`. |
| Previews | A read-only snapshot with derived text and geometry, plus images, uploaded under an unguessable 128-bit id. Viewed in a web viewer (the same Wasm renderer) with Dev-Mode-like Inspect. Fallback without Firebase: one self-contained HTML file. |

---

## 1. Identifiers and clocks

| Id | Format | Made by |
|---|---|---|
| `wid` (workspace) | 16 chars base62, random | store, on first launch |
| `FileKey` | 22 chars base62 (≈131 bits, Figma-like) | store |
| `FolderId` | 16 chars base62 | store |
| `VersionId` | 16 chars base62 | store |
| `PreviewId` | 22 chars base62 (≥128 bits, a capability) | store |
| Node GUID | `{sessionID: uint32, localID: uint32}`, string form `"s:l"`, URL form `s-l` | engine, within the session the store hands out |
| Asset `key` | 40 lowercase hex chars (160 random bits), Figma's format | engine, at first publish; persisted on the asset node |
| `versionHash` | 40 hex chars, sha1 of the asset's canonical payload | engine (deterministic encoding, §9.2) |
| Library version | integer from 1, per library file | store |
| Blob id | sha1 of the bytes, 40 hex chars | store (`node:crypto`) |
| Journal `seq` | uint64 per file, from 1, no gaps | store |

**Session ids** (`sessionID` in GUIDs) let several devices create nodes later without colliding:
- `sessionID = (deviceOrdinal << 20) | n`.
- `deviceOrdinal` (1–4095) lives in `userData/device.json`. It is 1 locally and assigned from Firestore once sync is on (§12).
- `n` counts per file per device. It is persisted in `store.json` and incremented on every edit-mode open.
- The range `sessionID < 2^20` (ordinal 0) is reserved for the document root and initial pages (`0:0`, `0:1`, …, as Figma does) and for GUIDs that come in through `.fig` import.

**HLC** (hybrid logical clock), used to order writes for later LWW:
- String `"<ms base36, 9 chars>.<counter base36, 3 chars>.<deviceOrdinal base36, 2 chars>"`. It sorts lexicographically.
- The store stamps every journal frame and every record mutation.

---

## 2. Records (each one becomes one Firestore document later)

```ts
// src/shared/store/types.ts — shared by the store, the renderer clients and the viewer
export type FileKey = string; export type FolderId = string; export type VersionId = string;
export type Hlc = string; export type Clock = Record<string, Hlc>;     // per-field last-write stamps

export interface Workspace {                 // Workspace/workspace.json  → workspaces/{wid}
  wid: string; formatVersion: 1;
  teamName: string;                          // "‹Owner›'s team"; the single team the file browser shows
  createdAt: number;
  defaultLibraries: FileKey[];               // enabled automatically in every new file (Figma's team default libraries)
  ownerUid: string | null;                   // set when Firebase sync is first turned on
  _clk: Clock;
}

export type FolderColor = "none" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "gray";
export interface Folder {                    // Workspace/folders/<id>.json → workspaces/{wid}/folders/{id}
  id: FolderId; name: string;
  parentId: FolderId | null;                 // null = top level of the team; depth ≤ 10
  color: FolderColor;
  createdAt: number; updatedAt: number;
  trashedAt: number | null;
  _clk: Clock;
}

export interface FileMeta {                  // Workspace/files/<key>/meta.json → workspaces/{wid}/files/{key}
  fileKey: FileKey; name: string;            // default "Untitled"
  editorType: "design";                      // FigJam/Slides are out of scope
  folderId: FolderId | null;                 // null = Drafts
  createdAt: number;
  updatedAt: number;                         // last edit (debounced 5 s)
  trashedAt: number | null;
  thumbnail: { version: number; width: number; height: number } | null;
  enabledLibraries: FileKey[];
  library: { status: "none" | "published" | "unpublished"; latestVersion: number | null };
  importedFrom: { kind: "fig" | "legacy"; name: string } | null;
  _clk: Clock;
}

export interface Prefs {                     // Workspace/prefs.json → workspaces/{wid}/prefs/{uid}
  recents: { fileKey: FileKey; viewedAt: number }[];       // newest first, ≤ 50
  viewedAt: Record<FileKey, number>;                       // every file ever viewed (for "Last viewed" sort)
  starred: { files: FileKey[]; folders: FolderId[] };      // in starring order
  browse: { layout: "grid" | "list"; sort: "last-viewed" | "last-modified" | "alphabetical" | "date-created" };
  _clk: Clock;
}
```

The renderer works with `FileListItem = FileMeta & { starred: boolean; lastViewedAt: number | null; sizeBytes: number }`. The store joins these from the records.

---

## 3. The workspace on disk

### 3.1 Where

The default is **`<userData>/Workspace`**. The reasons:
- It matches Figma: files are not user-visible documents. Getting a file out is an explicit action (Save Local Copy).
- The single-writer and journal invariants hold only on a local disk the app controls. iCloud Drive, Dropbox, OneDrive and Google Drive replay partial writes, create "conflicted copies" and evict files, which breaks append-only journals and rename-based atomic writes.
- Time Machine already backs up `~/Library/Application Support`. Firebase sync (§12) and Save Local Copy are the other backups.
- Dev and test runs are isolated for free (`DesignerV2-Dev`, `DESIGNER_USER_DATA`; `docs/desktop.md` §12.1).

`Settings › Workspace location…` can move the workspace to another **local** folder. It refuses paths under `~/Library/Mobile Documents`, `~/Library/CloudStorage`, `~/Dropbox`, `~/OneDrive` or `~/Google Drive`, and network volumes (`statfs` type `smbfs`, `afpfs`, `nfs`, `webdav`).

A move runs in this order:
1. Store shutdown.
2. Copy the folder.
3. Verify the copy by file count and the sha1 of every `meta.json`.
4. Switch `settings.workspacePath`.
5. Restart the store.
6. Offer to delete the old folder.

`DESIGNER_WORKSPACE` overrides the location.

### 3.2 Layout

```
Workspace/
  .lock                                 {pid, startedAt}; created with O_EXCL; a stale lock (pid gone) is taken over
  workspace.json                        Workspace
  prefs.json                            Prefs
  folders/<FolderId>.json               Folder
  files/<FileKey>/
    meta.json                           FileMeta                                  (synced)
    store.json                          FileStoreState                            (local only, §5.3)
    snapshot-<seq:012>.kiwi             current snapshot (§5.1)
    snapshot-<seq:012>.kiwi             previous generation, kept until the next compaction
    journal-<baseSeq:012>.log           journal segments (§5.2)
    thumbnail.png                       ≤ 800×600 PNG
    ui.json                             FileUiState                               (local only)
    versions/index.json                 VersionRecord[]                           (synced)
    versions/<VersionId>.kiwi           version snapshots (hard links where possible)
    clocks.bin                          per-(guid, field) HLCs; only once sync is on (§12.5)
  blobs/<sha1[0..2]>/<sha1>             immutable blobs (images, large values)
  libraries/<FileKey>/
    library.json                        LibraryRecord
    versions/<n>.json                   LibraryVersion manifest
    assets/<key>/<versionHash>.kiwi     one asset's payload (§9.2)
  previews.json                         PreviewRecord[] (§13)
  schemas/<sha1>.kiwi                   every binary kiwi schema a stored snapshot or journal was written with
  tmp/                                  staging for atomic writes; emptied at start
  .trash-pending/<FileKey>/             directories being deleted forever (rename first, then rm -r)
```

**Atomic writes**:
1. Write to `tmp/<random>`.
2. `fsync` it.
3. `rename` it into place.
4. `fsync` the parent directory.

Every JSON file and every snapshot is written this way. Journals are the only files appended in place.

**Index**: at startup the store reads `workspace.json`, `prefs.json`, `folders/*.json`, `files/*/meta.json` and `libraries/*/library.json` into memory. That is a few hundred small reads, under 50 ms. All listing and search run against this index. There is no separate index file that could disagree with the records.

**Corrupt records**: a corrupt `meta.json` is rebuilt from `store.json` and the snapshot, with the name taken from the snapshot's DOCUMENT node or "Recovered file", and logged. A corrupt `folders/*.json` is dropped, and its files move to Drafts. `workspace.json` and `prefs.json` fall back to their previous generation (`*.json.bak`, kept on every write).

---

## 4. File browser semantics (Figma's rules, single user)

- **Drafts**: files with `folderId: null`. A new file from `+` or ⌘N goes there, as does a file opened from Finder.
- **Folders**: create, rename, recolour, move (no cycles, depth ≤ 10), trash, restore, delete forever. Folder tiles show no thumbnails, as in Figma since the folder change.
- **Files**:
  - **create**: named `Untitled`, opened immediately.
  - **duplicate**: copies the snapshot and blobs refs into a new file named `‹name› (Copy)` in the same location. Versions and UI state are not copied.
  - **rename** and **move to folder**.
  - **trash**, **restore**, **delete forever**.
- **Recents**: the store calls `recordViewed` when a file tab activates. Recents shows the 50 newest non-trashed files. "Remove from recents" removes the entry from `recents` but keeps `viewedAt`.
- **Starred**: files and folders. Trashed items are hidden from Starred and come back on restore.
- **Trash**:
  - Trashing a folder trashes it as one item. Its contents keep their `folderId` and are hidden. Open tabs of contained files close (`file.trashed` with `viaFolder`).
  - **Restore** of a file whose folder is gone or trashed goes to Drafts. Restore of a folder whose parent is gone or trashed goes to the top level.
  - **Delete forever** of a file or folder (recursive) is irreversible. The directory is renamed into `.trash-pending/`, then removed in the background. Blobs are collected by GC (§10.3).
  - **Empty trash** deletes everything in Trash forever.
  - Nothing is purged automatically (verified for Figma in `R5-libraries.md`).
- **Search**: case- and diacritic-insensitive substring over file and folder names that are not trashed.
- **Sort**: Last viewed, Last modified, Alphabetical, Date created. Grid or list.
- **Libraries in Drafts**: a file in Drafts cannot publish. The error is `draft-cannot-publish`, and the UI says to move the file to a folder first, as Figma does.

---

## 5. Per-file format

### 5.1 Snapshot (`snapshot-<seq>.kiwi`): byte-identical to a `.fig`'s `canvas.fig`

```
0   8   prelude "fig-kiwi"
8   4   u32 LE  DOCUMENT_FORMAT_VERSION            (document contract)
12  4   u32 LE  length L0, then L0 bytes: deflate-raw(binary kiwi schema)
…   4   u32 LE  length L1, then L1 bytes: zstd(level 3)(kiwi Message)
```

`Message = { type: NODE_CHANGES, sessionID: 0, ackID: 0, nodeChanges: [every live node, phase CREATED, DOCUMENT first, parents before children], blobs: [...] }`.

Readers accept chunk 1 as zstd (magic `28 B5 2F FD`) or deflate-raw. Disk snapshots use zstd through Node's `zlib.zstdCompress`. Clipboard archives and preview snapshots use deflate-raw, which browsers can decode with `DecompressionStream`. Because a snapshot *is* a `canvas.fig`, Save Local Copy zips it without re-encoding (§11.2).

### 5.2 Journal segment (`journal-<baseSeq>.log`)

```
header (64 bytes)
  0   8  magic "DSGNJRNL"
  8   4  u32 formatVersion = 1
 12   4  u32 DOCUMENT_FORMAT_VERSION
 16  20  sha1 of the binary schema (bytes in Workspace/schemas/<hex>.kiwi)
 36   8  u64 baseSeq
 44   8  f64 createdAt (ms)
 52  12  zero
frame (repeated)
  0   4  u32 magic 0x31_4D_52_46 ("FRM1")
  4   4  u32 payloadLength
  8   4  u32 crc32(payload)                    (node:zlib crc32)
 12   n  payload:
           0  8  u64 seq
           8  4  u32 sessionID
          12  4  u32 batchSeq                  (per session, from 1)
          16  8  f64 wallClock
          24 16  HLC (ASCII)
          40  1  u8 kind  0 edit · 1 undo · 2 redo · 3 system · 4 remote · 5 restore
          41  1  u8 flags bit0 = message is deflate-raw (set when > 64 KB)
          42  2  u16 labelLength
          44  …  label (UTF-8, e.g. "Move", "Paste")
           …  …  kiwi Message (NODE_CHANGES with partial NodeChanges + its own blobs)
```

A segment is closed after a compaction, and a new one starts at the next seq. There is at most one open segment per file.

### 5.3 `store.json` (local only; changes rarely, never on each append)

```ts
interface FileStoreState {
  formatVersion: 1;
  documentFormatVersion: number;
  head: {
    snapshot: string; snapshotSeq: number; segments: string[];
    previous: { snapshot: string; snapshotSeq: number; segments: string[] } | null;
  };
  sessions: { nextLocal: number; lastBatchSeq: Record<string /* sessionID */, number> };   // pruned to the newest 64 sessions
  checkpoint: { lastAt: number | null; editedSince: boolean };
  thumbnail: { seq: number | null };
  blobRefs: string[];               // images referenced by the head snapshot ∪ journal (§10.3)
  sync: { pushedSeq: number; pullCursor: string | null } | null;
}
```

`head.lastSeq` is not stored. It is recovered on open by scanning the open segment, which a CRC scan does at hundreds of MB/s.

### 5.4 Write path (engine → store)

**Needs from engine**:
- One `ChangeBatch` per committed undo step.
- Continuous gestures (drag, resize, scrub) commit when the gesture ends.
- Typing commits when text editing ends, and at least every 1000 ms while typing.
- A batch carries partial NodeChanges with only the fields that changed, encoded with the current schema.

```ts
export type BatchKind = "edit" | "undo" | "redo" | "system" | "remote" | "restore";
export interface ChangeBatch {
  sessionID: number; batchSeq: number;   // batchSeq strictly increasing per session
  kind: BatchKind; label?: string;
  message: Uint8Array;                   // kiwi Message NODE_CHANGES, uncompressed
  blobRefsAdded?: string[];              // sha1s of images this batch starts using
  wallClock: number;
}
export interface AppendAck { seq: number; hlc: Hlc }
```

`BatchKind` follows the engine's transaction kinds (`engine.md` §9.2):

| Engine kind | `BatchKind` |
|---|---|
| User, Gesture | `edit` |
| Undo, Redo | `undo`, `redo` |
| System | `system` |
| Remote | `remote` (written by the store itself, §12.5) |
| a User transaction labelled "Restore version" | `restore` |

Each `DOCUMENT_CHANGED {bytes, kind, label}` becomes one batch.

Store, per file, in order:
1. **Dedupe**: if `batchSeq ≤ lastBatchSeq[sessionID]`, return the stored ack. This makes resends after a reconnect safe.
2. Assign `seq = lastSeq + 1` and an HLC.
3. Append the frame with one `fs.write` on an `O_APPEND` fd.
4. Acknowledge.
5. `fdatasync` at most every 1000 ms while there are unsynced bytes; `files.flush` forces it.
6. Broadcast `file.changes` to subscribed view sessions, such as a Present tab.
7. Bump `meta.updatedAt`, debounced to 5 s.
8. Evaluate compaction and checkpoint triggers.

Limits: a batch is at most 64 MB (`too-large` otherwise). Budget: append to ack p95 under 5 ms for batches under 64 KB.

### 5.5 Compaction

| Trigger | Condition |
|---|---|
| size | open segment > 8 MB, or > 5,000 frames |
| on close | the session ends and the journal is > 512 KB |
| on open | the journal is > 8 MB (compact first, then send the result) |
| rate limit | at most once per 60 s per file |

It runs in a `worker_threads` worker (`src/store/compactor.worker.ts`), off the RPC loop:
1. Decode the head snapshot, then every frame after `snapshotSeq`, with the schema each was written with (`schemas/<sha1>`). Migrate to the current schema if it differs (§5.8).
2. **Generic merge**, with nodes keyed by GUID:
   - `phase: REMOVED` deletes the node.
   - Any other NodeChange creates the node if absent (a CREATED after a REMOVED starts fresh), then **overwrites every top-level field it carries**. That is per-property last-writer-wins at top-level field granularity, the same rule Firestore will use.
   - **Blob-index fields** are any `uint` field, at any depth, whose name ends in `Blob` (`commandsBlob`, `vectorNetworkBlob`, `dataBlob` in `figma-schema.kiwi`). They index into their message's `blobs`. They are rebased: the bytes are appended once (deduplicated by sha1) to the output table and the index is rewritten.
3. Order the nodes DOCUMENT first, then parents before children (topological by `parentIndex.guid`).
4. Encode, write `snapshot-<lastSeq>.kiwi` atomically, update `store.json`:
   - `head.previous` = the old head;
   - `head` = `{snapshot: new, snapshotSeq: lastSeq, segments: [new empty segment]}`.
5. Delete the generation before `previous`, together with its segments.

The engine is never needed. Compaction, restore diffs (§6), library payload stitching and sync all share this merge (`src/store/kiwi/merge.ts`).

**Clearing a property**: kiwi absence means "unchanged", so a removed property is written as `NodeChange.clearedFields: uint[]`, a list of field ids (`engine.md` §2.1). The merge deletes those fields from the node *after* applying the fields the change carries. `clearedFields` itself is never stored on the merged node. The same rule drives restore diffs (§6) and LWW (§12.5): a clear is a write.

### 5.6 Open and crash recovery

`files.open(fileKey, {mode: "edit"})`:
1. **Lock**: if another edit session of this file is live, fail with `already-open` and `{tabId}`. Main activates that tab instead.
2. Read `store.json`, decompress the head snapshot and read its segments. For each frame, verify the magic, the length and the CRC. On the first bad or short frame, **truncate** the segment at the last good offset and record `recovery.truncatedBytes`.
3. If the head snapshot cannot be decoded, fall back to `head.previous` and its segments, which are always kept for this. If that fails too, fall back to the newest version snapshot. Set `recovery.fellBackTo`.
4. If nothing decodes, refuse with `corrupt`. **Never write over what could not be read**: the old `StoredDataError` rule is kept. The file can still be opened in view mode from the newest readable version.
5. Allocate `sessionID` and persist `store.json` before replying.
6. Reply with `OpenedFile` (§8.1): the raw (decompressed) snapshot message plus every frame after it. The editor calls `engine_load(snapshot)`, then `engine_apply_changes(frame, APPLY_LOAD)` for each frame in order (`engine.md` §10).

The editor shows a toast when `recovery` is not null: "Some recent changes couldn't be recovered", or "Recovered from an earlier version", with the time.

Durability by failure:

| Failure | What is lost |
|---|---|
| tab crash | edits the engine had not yet committed (the current gesture) |
| store crash | nothing that was acknowledged |
| OS crash or power loss | at most the last ~1 s of acknowledged batches |

### 5.7 Thumbnails and UI state

- **Thumbnail**: `engine_export(…, ApiExportSettings{thumbnail: true})` (`engine.md` §10.8) of the frame marked "Set as thumbnail". Failing that, the first top-level frame of the first page; failing that, the first page's content bounds. It is drawn on the page colour and fit inside 800×600. The RGBA result is PNG-encoded with `OffscreenCanvas.convertToBlob`. The editor renders it when the tab hides or closes after edits, and at most every 5 min of idle editing. `files.saveThumbnail` writes it atomically and bumps `meta.thumbnail.version`; Home loads `app://designer/_thumb/<key>.png?v=<version>`.
- **UI state** (`ui.json`, local only, written via `files.setUiState`, debounced 2 s by the client):

```ts
export interface FileUiState {
  currentPageId: string | null;
  pages: Record<string, { viewport: { x: number; y: number; zoom: number }; selection: string[] }>;
  leftPanelWidth: number; rightPanelWidth: number;
}
```

### 5.8 Schema evolution

- The current binary schema is `schema/document.kiwi`, packaged as `resources/schema/document.kiwi`. The store copies it into `Workspace/schemas/<sha1>.kiwi` on start. The current schema is encoded and decoded with the generated codec `src/shared/schema/document.generated.ts` (`engine.md` §1.6). Older schemas and Figma's are decoded at runtime with npm `kiwi-schema`, from the schema bytes.
- Every snapshot embeds its schema, and every journal header names one, so old data always decodes.
- On `files.open`, data written with an older `DOCUMENT_FORMAT_VERSION` is decoded with its own schema and passed through `src/store/migrations/<n>.ts` (pure functions on decoded objects; Figma's equivalent is its Rust file-migrations). It is then re-encoded and compacted into a new snapshot. The old snapshot is kept as `*.pre-migration` until the next compaction.
- The engine only ever sees the current schema.

---

## 6. Version history

```ts
export interface VersionRecord {            // files/<key>/versions/index.json (array, newest first) → files/{key}/versions/{id}
  id: VersionId;
  kind: "autosave" | "named" | "restore" | "publish" | "import";
  title: string | null; description: string | null;
  createdAt: number; seq: number;           // journal position the snapshot represents
  sizeBytes: number; blobRefs: string[];
  restoredFrom: VersionId | null;
  libraryVersion: number | null;            // kind "publish": the library version it published
}
```

- **Autosave checkpoint**: when `checkpoint.editedSince` is true and at least 30 min have passed since `checkpoint.lastAt`, the store schedules a checkpoint for the next 2 s with no appends (60 s at most). A checkpoint is a compaction followed by a **hard link** (`fs.link`, falling back to a copy) of the new snapshot into `versions/<id>.kiwi`. Snapshots are immutable, so the version survives later compactions at no extra cost.
- **Named version**: "Save to Version History…" (⌥⌘S) takes a title and description. The client calls `files.flush`, then `files.createVersion({title, description})`. An autosave can be named later with `files.updateVersion` (Figma's "Name this version").
- **Publish** (§9) and **import** (§11) also create version entries. The publish entry carries the publish description, as Figma shows it in history.
- **View a version**: `files.openVersion(fileKey, versionId)` opens a view-mode session with that snapshot. The editor shows it read-only, with "Restore this version".
- **Restore** (non-destructive):
  1. `files.restoreDiff(fileKey, versionId)` returns a NODE_CHANGES message that turns the current head into the version. It contains `REMOVED` for GUIDs that do not exist in the version, full `CREATED` nodes for GUIDs that the current head lacks, and field-level changes for the rest; fields to clear follow the §5.5 requirement.
  2. The editor applies it with `engine_apply_changes(diff, APPLY_USER)`, as **one undoable batch** with label "Restore version". It is journaled as `kind: "restore"`.
  3. It then calls `files.createVersion({kind: "restore", restoredFrom})`, which appears as "Restored version from ‹date›".
- **Duplicate**: `files.duplicateVersion` creates a new file in Drafts named `‹name› (‹version title or date›)`.
- **Retention** (thinned at store start and after each checkpoint):

  | Kind | Kept |
  |---|---|
  | named, restore, publish, import | forever |
  | autosave, newer than 30 days | all |
  | autosave, 30–180 days old | the last one of each day |
  | autosave, older than 180 days | the last one of each week |

  Versions cannot be deleted by hand (Figma has no such action).

---

## 7. The single writer: the store utility process

**Why a separate process.** Every tab is its own renderer process, so the tabs cannot share a database handle, and the sandboxed renderers have no filesystem access. Main must stay responsive for windows and input. A `utilityProcess` gives one writer in Node with a crash domain of its own; main restarts it (`docs/desktop.md` §9).

```
src/store/index.ts            entry: parentPort init, port handshake, method dispatch, role checks
src/store/rpc.ts              envelope, (de)serialisation, transfer of Uint8Array
src/store/local/workspace.ts  LocalWorkspace (records, index, trash, search)
src/store/local/fileStore.ts  per-file actor: sessions, append, flush, open, thumbnails, ui state
src/store/local/journal.ts    segment writer/reader, CRC, truncation
src/store/local/versions.ts   checkpoints, named, restore diff, retention
src/store/local/blobs.ts      put/get/has/GC
src/store/local/libraries.ts  registry, publish, diff, payload fetch, redirects
src/store/kiwi/               schema loading; generic decode/encode (generated codec for the current schema, `kiwi-schema` for others); merge.ts; container.ts → src/shared/fig/container.ts
src/store/compactor.worker.ts
src/store/import/fig.ts, export/fig.ts   (ZIP via `fflate`)
src/store/migrations/
src/store/sync/               Replicator, FirestoreAdapter (later, §12)
src/shared/fig/convert.ts     Figma Message → our Message (owned by the document contract; also used by paste)
```

**Start**: main calls `utilityProcess.fork(storeEntry, [], {serviceName: "DesignerV2 Store"})` and sends `{type: "init", workspaceDir, userDataDir, deviceOrdinal, schemaPath, seed?: "demo"}`. The store takes `Workspace/.lock`, loads the index and replies `ready`.

**Concurrency**:
- Each file has a serial queue (an actor). All workspace mutations share one serial queue. Reads run concurrently.
- Compaction runs in the worker. While it runs, appends go to a new segment, so the worker reads a closed set of segments.

### 7.4 Sessions, reconnects, shutdown

- **Session**: an edit session is bound to the `MessagePort` that opened it. When the port closes (the tab closed or crashed), the store ends the session, releases the lock and runs the on-close compaction rule.
- **Reconnect** after a store restart: `StoreClient` gets a new port with a higher `generation` and calls `files.reattach(fileKey, sessionID, lastAckedBatchSeq)`. The store re-locks for that session and replies with `{headSeq}`. The client then resends every batch it holds unacknowledged, and they are deduplicated by `batchSeq`.
- **Shutdown** (`store.shutdown`, main only): stop accepting appends, fsync every open file, finish or abandon compaction (abandoned compactions leave no trace thanks to atomic writes), release `.lock`, exit 0.

---

## 8. The repository pattern

### 8.1 Interfaces (`src/shared/store/repositories.ts`)

```ts
export type Unsubscribe = () => void;

export type FileQuery =
  | { in: "recents" } | { in: "drafts" } | { in: "folder"; folderId: FolderId }
  | { in: "starred" } | { in: "trash" } | { in: "search"; text: string };

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

  listFolders(): Promise<Folder[]>;                                   // all, incl. trashed (flagged)
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
  deleteForever(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void>;   // items must be in Trash
  emptyTrash(): Promise<void>;

  setStarred(target: { fileKey: FileKey } | { folderId: FolderId }, starred: boolean): Promise<void>;
  recordViewed(fileKey: FileKey): Promise<void>;
  removeFromRecents(fileKey: FileKey): Promise<void>;

  watch(listener: (e: WorkspaceEvent) => void): Unsubscribe;
}

export interface OpenedFile {
  meta: FileMeta; mode: "edit" | "view";
  sessionID: number;                                   // 0 in view mode
  schema: Uint8Array;                                  // current binary schema
  snapshot: Uint8Array; snapshotSeq: number;           // raw kiwi Message, uncompressed
  journal: { seq: number; kind: BatchKind; message: Uint8Array }[];
  headSeq: number;
  ui: FileUiState | null;
  recovery: null | { truncatedBytes: number; droppedFrames: number; fellBackTo: "previous-snapshot" | "version" | null };
}
export interface FileChange { fileKey: FileKey; seq: number; sessionID: number; kind: BatchKind; message: Uint8Array }

export interface FileRepository {
  open(fileKey: FileKey, opts: { mode: "edit" | "view"; tabId?: string; subscribe?: boolean }): Promise<OpenedFile>;
  reattach(fileKey: FileKey, sessionID: number, lastAckedBatchSeq: number): Promise<{ headSeq: number }>;
  append(fileKey: FileKey, batch: ChangeBatch): Promise<AppendAck>;
  flush(fileKey: FileKey): Promise<void>;              // resolves after fdatasync
  close(fileKey: FileKey, sessionID: number): Promise<void>;
  subscribe(fileKey: FileKey, fromSeq: number, listener: (c: FileChange) => void): Unsubscribe;

  saveThumbnail(fileKey: FileKey, png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  setUiState(fileKey: FileKey, patch: Partial<FileUiState>): Promise<void>;

  listVersions(fileKey: FileKey): Promise<VersionRecord[]>;
  createVersion(fileKey: FileKey, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: VersionId }): Promise<VersionRecord>;
  updateVersion(fileKey: FileKey, id: VersionId, patch: { title?: string; description?: string }): Promise<VersionRecord>;
  openVersion(fileKey: FileKey, id: VersionId): Promise<OpenedFile>;          // view mode
  restoreDiff(fileKey: FileKey, id: VersionId): Promise<Uint8Array>;          // NODE_CHANGES message
  duplicateVersion(fileKey: FileKey, id: VersionId): Promise<FileMeta>;

  // Later, with dynamic page loading (engine.md §2.6, REQUEST_PAGE): loadPage(fileKey, pageId) → Uint8Array. v1 opens whole files.
  importLocalCopy(path: string, folderId: FolderId | null): Promise<FileMeta>;    // main only (takes a path)
  exportLocalCopy(fileKey: FileKey, path: string): Promise<void>;                  // main only
}

export interface BlobStore {
  put(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string; size: number; mime: string }>;
  has(sha1s: string[]): Promise<boolean[]>;
  get(sha1: string): Promise<Uint8Array>;             // renderers normally use app://designer/_blob/<sha1>
  url(sha1: string): string;                           // client-side helper, not an RPC
}

export interface LibraryRegistry {
  listAvailable(forFileKey?: FileKey): Promise<LibraryRecord[]>;       // published, not trashed, excluding forFileKey
  getRecord(libraryFileKey: FileKey): Promise<LibraryRecord | null>;
  getVersion(libraryFileKey: FileKey, version?: number): Promise<LibraryVersion>;   // default latest
  previewPublish(libraryFileKey: FileKey, assets: PublishAsset[]): Promise<PublishPreview>;
  publish(req: PublishRequest): Promise<LibraryVersion>;
  unpublish(libraryFileKey: FileKey): Promise<void>;
  setEnabled(fileKey: FileKey, libraryFileKey: FileKey, enabled: boolean): Promise<FileMeta>;
  getPayloads(libraryFileKey: FileKey, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }): Promise<AssetPayload[]>;
  diff(libraryFileKey: FileKey, have: { key: string; versionHash: string }[]): Promise<LibraryDiff>;
  watch(listener: (e: LibraryEvent) => void): Unsubscribe;
}
export type LibraryEvent =
  | { type: "published"; libraryFileKey: FileKey; version: number }
  | { type: "status"; libraryFileKey: FileKey; status: LibraryRecord["status"] };
export interface PublishPreview { created: LibraryAsset[]; modified: LibraryAsset[]; removed: LibraryAsset[]; moved: Redirect[]; unchanged: string[] }

// Not one of the four repositories: a store service that exists only once Firebase is configured (§13).
export interface PreviewService {
  list(fileKey?: FileKey): Promise<PreviewRecord[]>;
  publish(fileKey: FileKey, input: { snapshot: Uint8Array; blobRefs: string[]; options: PreviewOptions }): Promise<PreviewRecord>;  // create or update in place
  stop(previewId: string): Promise<void>;
}
export interface PreviewOptions { pageIds: string[] | "all"; inspect: boolean; export: boolean; expiresInDays: 7 | 30 | null }
export interface PreviewRecord { previewId: string; fileKey: FileKey; createdAt: number; updatedAt: number; expiresAt: number | null; options: PreviewOptions; blobRefs: string[]; url: string }
```

### 8.2 Adapters

| Adapter | Where | Implements | Used by |
|---|---|---|---|
| `LocalAdapter` | store process | all four | **always**: the only thing the UI reads and writes |
| `StoreClient` | every home and editor renderer | all four, as RPC proxies over the store port | the React UI and the engine glue (`src/renderer/src/store/client.ts`) |
| `FirestoreAdapter` | store process, later | all four against Firestore and Storage (§12) | only the `Replicator` (push and pull) and "Download workspace" |
| `PreviewAdapter` | web viewer | `FileRepository.open` (view mode) and `BlobStore.get` | the viewer (§13) |

`Replicator(local, firestore)` runs in the store when sync is on. The UI never chooses an adapter: local-first means every read and write hits `LocalAdapter`, and replication happens behind it.

### 8.3 The store port protocol

```ts
type StoreMethod = `${"workspace" | "files" | "blobs" | "libraries" | "previews" | "store"}.${string}`;
type RpcRequest  = { t: "req"; id: number; m: StoreMethod; a: unknown[] };
type RpcResponse = { t: "res"; id: number; ok: true; v: unknown } | { t: "res"; id: number; ok: false; e: { code: StoreErrorCode; message: string; detail?: unknown } };
type RpcEvent    = { t: "evt"; topic: "workspace" | "file.changes" | "library" | "sync"; d: unknown };
type RpcHello    = { t: "hello"; role: "main" | "home" | "editor"; generation: number };   // first message from the store on a new port

export type StoreErrorCode =
  | "not-found" | "trashed" | "already-open" | "read-only" | "corrupt" | "io" | "disk-full"
  | "unsupported-format" | "too-large" | "draft-cannot-publish" | "invalid" | "forbidden"
  | "offline" | "shutting-down";
```

- The method name is `<repository>.<method>`, for example `files.append` or `workspace.trash`.
- Arguments and results are structured clones. `Uint8Array`s are copied once across the process boundary, with no JSON.
- **Role permissions**:
  - `main`: every method.
  - `home` and `editor`: every method except `files.importLocalCopy`, `files.exportLocalCopy` and `store.*`. Methods that take filesystem paths stay in main, behind native dialogs, so a renderer can never name a path.
- Events go to every port, except `file.changes`, which goes only to ports that subscribed.
- Main also listens to `workspace` events on its own port (tab titles, closing trashed files).

---

## 9. Libraries

### 9.1 Assets, keys, versions

```ts
export type AssetKind = "COMPONENT" | "COMPONENT_SET" | "STYLE" | "VARIABLE_COLLECTION" | "VARIABLE";
export interface LibraryAsset {
  key: string;                       // 40-hex, stable across publishes and renames
  kind: AssetKind;
  styleType?: "FILL" | "TEXT" | "EFFECT" | "GRID";
  resolvedType?: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  name: string; description: string;
  guid: string;                      // node GUID in the library file
  versionHash: string;               // sha1 of the canonical payload
  dependencyOnly: boolean;           // shipped because a published asset needs it; never listed in Assets
  dependencies: string[];            // keys (nested instances' components, aliased variables, styles used)
  componentSetKey?: string; collectionKey?: string;
  containingFrame?: { pageName: string; frameName?: string };   // Assets panel grouping: file › page › frame
  thumbnail: { sha1: string; width: number; height: number } | null;   // ≤ 256 px, 2×
}
```

- **Publishable**: components, component sets, styles (FILL, TEXT, EFFECT, GRID), variable collections and variables.
- **Excluded**:
  - components and sets whose name starts with `.` or `_`, or marked Hide when publishing;
  - collections named with a leading `_` or `.`;
  - variables with `hiddenFromPublishing`.
- An excluded asset that a published one depends on is still shipped, with `dependencyOnly: true`, so consumers render correctly.
- **Key**: at the first publish, the engine writes a fresh `key` into every asset node that lacks one. That is an ordinary journaled edit in the library file. The key never changes afterwards. A cut-and-paste into another file makes a new component with a new key, and the old key is kept only in `libraryMoveInfo` (§9.5).
- **versionHash** (**Needs from engine**): the payload encoding is deterministic. It holds the asset subtree in GUID order, fields in schema order, derived fields excluded, and `versionHash` = sha1 of those bytes. If the content is unchanged, the hash is unchanged.

### 9.2 Registry on disk

```ts
export interface LibraryRecord {          // libraries/<lib>/library.json → workspaces/{wid}/libraries/{lib}
  libraryFileKey: FileKey;
  status: "published" | "unpublished" | "trashed" | "deleted";
  latestVersion: number;
  firstPublishedAt: number; lastPublishedAt: number;
  counts: { components: number; styles: number; variables: number };
  movedIn: Redirect[];                    // assets moved into this library (§9.5)
  _clk: Clock;
}
export interface LibraryVersion {         // libraries/<lib>/versions/<n>.json
  libraryFileKey: FileKey; version: number; publishedAt: number; description: string;
  changes: { created: string[]; modified: string[]; removed: string[]; moved: Redirect[] };
  assets: LibraryAsset[];                 // complete manifest of this version
}
export interface Redirect { fromLibraryFileKey: FileKey; fromKey: string; toLibraryFileKey: FileKey; toKey: string; version: number; at: number }
export interface AssetPayload { key: string; versionHash: string; message: Uint8Array }   // NODE_CHANGES of the subtree + its blobs, library GUIDs
```

- Payloads are stored **per asset version** at `libraries/<lib>/assets/<key>/<versionHash>.kiwi`, using the snapshot container. An unchanged asset is never rewritten. A version manifest just lists `(key, versionHash)`.
- Deselecting a modified asset in the Publish dialog keeps its previous `versionHash` in the new manifest, which is Figma's per-asset deselect.

### 9.3 Publish flow

1. The editor (Assets › Libraries › Publish…) collects every publishable asset with `versionHash` and dependencies, then calls `libraries.previewPublish`.
2. The store returns `PublishPreview { created, modified, removed, moved, unchanged }` against the latest version.
3. The editor shows Figma's Publish dialog: a description field, the Created/Modified/Removed lists with per-asset checkboxes, and "Moved components" with **Move to this file** or **Publish as a copy**.
4. `libraries.publish`:

   ```ts
   export interface PublishAsset extends Omit<LibraryAsset, "thumbnail"> { payload?: Uint8Array; thumbnailPng?: Uint8Array }  // payload required unless (key, versionHash) already stored
   export interface PublishRequest {
     libraryFileKey: FileKey; description: string;
     assets: PublishAsset[];               // every asset the new version contains (selected + kept + dependencies)
     moves: { key: string; fromLibraryFileKey: FileKey; fromKey: string; mode: "move" | "copy" }[];
   }
   ```

   The store:
   - rejects files in Drafts (`draft-cannot-publish`) and duplicate keys (`invalid`);
   - writes the missing payloads and thumbnails (thumbnails go to blobs);
   - writes `versions/<n+1>.json` and then `library.json`, in that order;
   - writes redirects for `mode: "move"` into the target's `movedIn`;
   - creates a version entry (`kind: "publish"`) in the library file's history;
   - sets `meta.library`;
   - emits `library {type: "published", libraryFileKey, version}`.

### 9.4 Consuming

- **Enable**: the per-file Libraries modal lists `listAvailable(fileKey)`, every published library in the workspace, which is "your team" in Figma's wording. "Add to file" or "Remove from file" calls `setEnabled`, which updates `FileMeta.enabledLibraries`. New files start with `Workspace.defaultLibraries`.
- **Use**: when an instance is inserted, a style applied or a variable bound from a library, the editor calls `getPayloads(lib, [(key, latest versionHash)], {withDependencies: true})`. The engine inserts **read-only copies** on the document's internal-only canvas, mapped to local GUIDs.

  **Needs from document contract**: use Figma's fields for the copies:
  - components: `sharedSymbolReference {fileKey: lib, symbolID, versionHash, componentKey: key, libraryGUIDToSubscribingGUID}`;
  - styles: `sharedStyleReference {styleKey, versionHash}`;
  - variables and collections: `key` and `version`;
  - all copies: `sourceLibraryKey`.

  The GUID mapping persists, so later updates map stably.
- Copies make a file self-contained. It renders offline, after the library is unpublished, trashed or deleted, and in a `.fig` export.
- **Update detection**: on open, and on every `library.published` event, the editor calls `diff(lib, have)` for each enabled library, where `have` is its copies' `(key, versionHash)`. The result:

  ```ts
  export interface LibraryDiff { latestVersion: number; updated: LibraryAsset[]; removed: string[]; moved: Redirect[] }
  ```

  A non-empty diff shows Figma's blue badge on Assets/Libraries and the toast "Library updates available".
- **Review and accept**: the Updates modal lists the changed components, styles and variables, comparing old (rendered from the copy) with new (manifest thumbnail or payload). "Update all" or a per-asset update fetches the payloads, and the engine replaces the copies in **one undo batch**. Instances re-materialise. Updates never apply automatically.

### 9.5 Move to this file, Publish as a copy

- **Detection** (**Needs from engine**): a component pasted from another file, whose source was a published component, carries `libraryMoveInfo {oldKey, pasteFileKey}`, Figma's field. It gets a new key in the new file.
- **Move to this file** (the default), when the new file publishes:
  1. The store records `Redirect {from: (pasteFileKey, oldKey) → to: (thisFile, newKey)}`.
  2. Consumers of the old library see it in `diff().moved`, labelled "Moved to ‹file›".
  3. Accepting re-points the copy's library and key, keeping instance links, and **enables the new library** in that file automatically.
  4. When the old library publishes next, the missing key is shown as moved, not removed.
- **Publish as a copy**: no redirect is recorded. The old library keeps its component until it publishes the removal.
- Neither choice can be undone through history, as in Figma. The redirect is permanent.

### 9.6 Removed assets, unpublishing, lost libraries

- **Removed** (deleted or hidden in the library, then published): it appears in `diff().removed`. Consumers keep the copy, and instances keep rendering. Assets no longer lists it. The instance menu shows that the main component was removed from the library and offers Detach.
- **Unpublish** (`libraries.unpublish`): status becomes `unpublished`, and the library is hidden from `listAvailable`. Consumers keep their copies and get no updates. Publishing again continues the version numbering.
- **Library file trashed**: status `trashed`, hidden. Restoring the file restores the status.
- **Library file deleted forever**: status `deleted`, and the registry deletes its payloads and manifests. Consumers are unaffected: they have copies. Their Libraries modal shows "Missing library".

---

## 10. Images and blobs

### 10.1 Ingestion (ImagePipeline, in the editor renderer)

Sources: drag and drop, paste, Place image (⇧⌘K via `file:pick-images`), and import.

1. **Formats**: PNG, JPEG, GIF and WebP are accepted, up to 50 MB of input.
2. **Size**: if either side exceeds **4096 px** (Figma's limit), decode with `createImageBitmap(blob, {resizeWidth, resizeHeight, resizeQuality: "high"})` to fit 4096, then re-encode with `OffscreenCanvas.convertToBlob` (PNG stays PNG; JPEG becomes JPEG at q 0.92; GIF becomes PNG of the first frame). Otherwise the **original bytes are kept untouched**. The old lossy WebP re-encode is gone.
3. **Store**: `blobs.has` (sha1 computed with `crypto.subtle`), then `blobs.put` only if the blob is missing.
4. **Paint**: the engine sets `image.hash` (20 bytes), `originalImageWidth` and `originalImageHeight`, and adds the sha1 to the batch's `blobRefsAdded`.

SVG is not a blob. It is imported as vector nodes (`docs/desktop.md` §13).

### 10.2 Store

- Layout: `blobs/<sha1[0..2]>/<sha1>`. Blobs are immutable.
- `put` is idempotent (hash, then atomic write if missing). The MIME type is sniffed from magic bytes.
- Served read-only by main at `app://designer/_blob/<sha1>` (`docs/desktop.md` §11).
- Geometry blobs (vector networks, path commands) are **not** in the blob store. They live inside messages (`Message.blobs`).

### 10.3 Garbage collection (mark and sweep)

- **When**: in the store, idle, 10 min after start, and after `deleteForever` or `emptyTrash`.
- **Live set**: the union of
  - every file's `store.json.blobRefs` (trashed files included),
  - every `VersionRecord.blobRefs`,
  - every library asset payload's blob refs and thumbnails,
  - every `previews.json` entry's blob refs.
- `blobRefs` is recomputed exactly at each compaction by walking every `Image` value's `hash` field in the merged snapshot. Between compactions it only grows (`blobRefsAdded`), so it is a safe superset.
- **Sweep**: delete blobs that are not live **and** whose mtime is older than 24 h. The grace period covers a put whose referencing batch has not landed yet.

---

## 11. Import and export

### 11.1 Import of a `.fig` (Figma's or ours)

`files.importLocalCopy(path, folderId)`, main only:
1. Open the file as a ZIP (`fflate`) or as a bare `canvas.fig`.
2. Check the prelude:
   - `fig-kiwi` is accepted.
   - `fig-jam.` and `fig-deck` are rejected with `unsupported-format` ("FigJam and Slides files aren't supported").
3. Decode chunk 0 (the schema, deflate-raw) and chunk 1 (zstd or deflate-raw).
4. If the embedded schema's sha1 is ours, take the message as is. Otherwise run `convertFigMessage(message, theirSchema)` from `src/shared/fig/convert.ts`. It drops fields our schema lacks and counts them into `importReport`.
5. Remap GUIDs with `sessionID ≥ 2^20` to a fresh session of the new file (§1). Other GUIDs are kept.
6. Store every `images/<hex>` with `blobs.put`. If the bytes do not hash to the name (`broken_images.fig` shows this happens), keep the computed sha1 and rewrite the paints' `image.hash`.
7. Create the file:
   - name: `meta.json.file_name`, else the file's basename;
   - the snapshot at seq 0;
   - the thumbnail from `thumbnail.png`;
   - a version entry `kind: "import"`;
   - `importedFrom: {kind: "fig", name}`.
8. Library links to Figma libraries arrive as copies on the internal canvas. They render, but their library is unknown, so they show as a missing library. Figma itself warns that re-importing breaks library links.

### 11.2 Save Local Copy

`files.exportLocalCopy(fileKey, path)`, main only, from File › Save Local Copy… or Home's menu:
1. Flush, then compact.
2. Write a ZIP with *stored* (uncompressed) entries, as Figma does:
   - `canvas.fig`: the head snapshot bytes as is (§5.1);
   - `meta.json`: `{client_meta: {background_color, thumbnail_size, render_coordinates}, file_name, exported_at}`;
   - `thumbnail.png`;
   - `images/<sha1>` for each blob ref.
3. Write to `tmp/`, then rename onto `path`.

Version history, UI state and the library registry are not included, as in Figma.

### 11.3 Legacy site projects (design only; optional, one-shot)

This is a pipeline outside the app, so it needs no store internals:
1. **`scripts/legacy/export-site.mjs`**:
   - Standalone Node with the Firebase JS SDK and the old `burakkoc-a15d3` config, taken from git history.
   - Signs in with the old loopback Google flow and reads only.
   - Reads `projects/*`, `projects/*/content/canvas` (the current draft only), `design/variables`, `design/textStyles` and `design/library`.
   - Downloads every Storage URL referenced from the JSON.
   - Writes everything to `~/DesignerV2-legacy-export/`, which is personal data and outside the repo.

   **Run it before Phase 1 deletes the old code** (§14). It does not import app code, but having the old app at hand helps check the result.
2. **`scripts/legacy/convert.ts`** runs once the document schema is stable. It reads the export and writes `.fig` local copies (our schema), which the owner imports with File › Import… into a folder "burakkoc.net". The old types are copied to `scripts/legacy/model.ts` so the converter does not depend on `src/renderer/src/figma`.

| Old (`docs/research/code/model.md`) | New |
|---|---|
| project `{slug, title, …}` | one file, named after `title`; site-only fields (`titleEn`, `category`, `year`, `description*`, `coverImage`, `company`, `order`, published flags) are dropped |
| first page (`doc.nodes`, `pageName`, `background`) + `doc.pages[]` | CANVAS pages, in order |
| `frame` / `rectangle` / `ellipse` / `line` | FRAME / ROUNDED_RECTANGLE / ELLIPSE / LINE |
| `text` | TEXT. `characters` are kept as written. `**bold**` becomes a bold style run; `[label](url)` becomes a hyperlink run. Font family: see Open questions. |
| `component` / `componentSet` / `instance` | SYMBOL / FRAME with `isStateGroup` / INSTANCE. Name-path overrides are re-keyed to guidPaths of `overrideKey`s, resolved against the main component at conversion time. |
| Auto-layout children's stale `x`/`y`, Hug/Fill sizes | ignored; the engine lays out on open |
| global `design/library` components and effect styles, `design/variables` (light/dark), `design/textStyles` | **one library file** "burakkoc.net Design System", published as v1. Variables become a collection "Site" with modes Light and Dark (`kind color` → COLOR; `number` and `weight` → FLOAT; `alias` → VARIABLE_ALIAS). Text and effect styles become TEXT and EFFECT styles. **Names stay as written** (Turkish included). Every converted project file enables this library and gets copies of the assets it uses. |
| `Paint.image.url` (Firebase Storage) | downloaded bytes → blob → `image.hash` |
| `href` on a frame / on text | "On click → Open link" interaction / hyperlink run |
| Overview instance (`c-overview`), `fixed`, `tag`, `narrow`, `pageId`, EN translations (`charactersEn`, `propsEn`, `translations`) | dropped |
| `embed` | a placeholder rectangle named `Embed: ‹kind›` |
| `projects/*/versions`, `published/*`, `cv/main` | not imported |

---

## 12. Firebase (later; off until configured)

### 12.1 Turning it on

- **Config** lives in `userData/firebase/config.json`, written by Settings › Sync › "Connect Firebase project…" (paste JSON) or dropped there by hand:

  ```json
  {
    "firebase": { "apiKey": "…", "authDomain": "…", "projectId": "…", "storageBucket": "…", "messagingSenderId": "…", "appId": "…" },
    "oauth":    { "clientId": "….apps.googleusercontent.com", "clientSecret": "…" },
    "viewer":   { "origin": "https://<project>.web.app" }
  }
  ```

- **The repo holds no config.** It holds `firebase/firestore.rules`, `firebase/storage.rules`, `firebase/firebase.json` (Hosting for the viewer) and `firebase/.firebaserc.example`. `.gitignore` adds `firebase/.firebaserc` and `firebase/*.local.json`.
- `src/shared/firebaseConfig.ts` (the old project) is deleted in Phase 1.
- **Enabling**: Settings › Sync › Turn on → Google sign-in (§12.3) → then one of:
  - **"Upload this workspace"** on the first device. It creates `workspaces/{wid}` with `ownerUid`, pushes everything (with progress) and keeps `deviceOrdinal` 1.
  - **"Download a workspace"** on a new device with an empty local workspace. It lists `workspaces` where `ownerUid == uid`, allocates a `deviceOrdinal` from `workspaces/{wid}/devices` in a transaction, then pulls everything.

  Two existing workspaces are never merged.
- **Turning it off** stops the Replicator. Local data is untouched.

### 12.2 Where it runs

- The Firebase JS SDK (`firebase/app`, `firebase/auth`, `firebase/firestore` and `firebase/storage`, modular, Node builds) runs **in the store process** with `inMemoryPersistence` and the memory cache.
- No renderer imports Firebase, and the renderer CSP stays `connect-src 'self'`.
- The local workspace is the offline cache, so Firestore's own persistence is not needed.

### 12.3 Sign-in

This is the old loopback design, now owned by sync:
1. Main runs Google OAuth for installed apps: PKCE, a loopback redirect on `127.0.0.1:<random port>`, the system browser, a `state` checked in constant time and a 10-minute timeout. Scopes are `openid email profile`, and it uses the config's Desktop client.
2. Main stores the **Google refresh token** encrypted with `safeStorage` in `userData/firebase/session.bin`.
3. At each start with sync on, main exchanges the refresh token for a fresh Google ID token and hands it to the store.
4. The store calls `signInWithCredential(auth, GoogleAuthProvider.credential(idToken))`. Firebase refreshes its own token in memory from then on.
5. `Settings › Sync › Sign out` deletes `session.bin`.

### 12.4 Paths

| Firestore document | Content | Local source |
|---|---|---|
| `workspaces/{wid}` | `Workspace` | `workspace.json` |
| `workspaces/{wid}/folders/{folderId}` | `Folder` | `folders/<id>.json` |
| `workspaces/{wid}/files/{fileKey}` | `FileMeta` | `files/<key>/meta.json` |
| `workspaces/{wid}/prefs/{uid}` | `Prefs` | `prefs.json` |
| `workspaces/{wid}/libraries/{libraryFileKey}` | `LibraryRecord` | `libraries/<key>/library.json` |
| `workspaces/{wid}/libraries/{libraryFileKey}/versions/{n}` | `{version, publishedAt, description, changes, assetCount}`; the full manifest is in Storage | `libraries/<key>/versions/<n>.json` |
| `workspaces/{wid}/devices/{ordinal}` | `{name, createdAt, lastSeenAt}` plus a counter doc `workspaces/{wid}/devices/_counter` | `userData/device.json` |
| `files/{fileKey}` | `{wid, ownerUid, documentFormatVersion, schemaSha1, createdAt}` | `store.json` (subset) |
| `files/{fileKey}/nodes/{guid}` | **one document per node, one field per top-level NodeChange property**, plus `_clk`, `_t`, `_del`, `_dev` | merged snapshot plus journal |
| `files/{fileKey}/versions/{versionId}` | `VersionRecord` minus `blobRefs` | `versions/index.json` |

| Storage object | Content |
|---|---|
| `blobs/{sha1}` | image bytes and spilled large values (immutable; `Cache-Control: immutable`) |
| `thumbnails/{fileKey}.png` | thumbnail; custom metadata `version` |
| `versions/{fileKey}/{versionId}.kiwi` | version snapshot |
| `libraries/{libraryFileKey}/versions/{n}.json` | full `LibraryVersion` manifest |
| `libraries/{libraryFileKey}/assets/{key}/{versionHash}.kiwi` | asset payload |
| `schemas/{sha1}.kiwi` | binary schemas |
| `previews/{previewId}/…` | §13 |

**No journal in Firestore.** The local journal *is* the outbox. Node documents are the merged state, and incremental pulls query `_t`. A remote journal would duplicate the node documents and double the writes.

**Node document encoding** (`src/store/sync/fieldCodec.ts`):

| kiwi | Firestore |
|---|---|
| `bool` | boolean |
| `byte`, `int`, `uint`, `float` | number; `int64`/`uint64` become a decimal string |
| `string` | string |
| enum | the value's name (string) |
| struct or message | map with schema field names (never prefixed `_`) |
| `T[]` | array (kiwi has no arrays of arrays) |
| `byte[]`, blob-index fields (`*Blob`) | `{"$b": Bytes}` if ≤ 256 KB, else `{"$blob": sha1}` with the bytes in Storage `blobs/{sha1}` |
| `GUID` | string `"s:l"` |

- **Derived caches never reach Firestore.** These are fields flagged `DERIVED_CACHE` in `engine/tools/schemagen/fieldmeta.ts` (`engine.md` §2.3): `fillGeometry`, `strokeGeometry`, `derivedTextData`, `derivedSymbolData` and the layout parts of `textData`. The engine never writes them to documents, and import drops them, so they appear only in viewer snapshots (§13). The field codec rejects them as a safety net.
- A node document whose encoding exceeds 900 KB spills its largest fields to `{"$blob"}`. A value nested deeper than 20 levels spills too.

Sync metadata on each node document:
- `_clk`: map from field name to HLC;
- `_t`: `serverTimestamp()` of the last write;
- `_del`: HLC of deletion, a tombstone kept 30 days;
- `_dev`: device ordinal of the last writer.

Records (workspace, folders, files, prefs, libraries) carry their `_clk` map from §2.

### 12.5 Per-property LWW

**Push** (Replicator, per file, at most every 2 s while there are new frames, which keeps under Firestore's 1 write/s per document):
1. Take the frames with `seq > sync.pushedSeq`. Coalesce them to the last value and HLC per `(guid, field)`; a REMOVED becomes a tombstone with its HLC.
2. Upload the blobs they reference that are missing remotely, before any document that references them.
3. For each chunk of ≤ 100 node documents, run `runTransaction`: read them, then for each field write it only if the local HLC is newer than the remote `_clk[field]`.
   - Skip a field when the remote `_del` is newer than its local HLC.
   - A local tombstone wins over every field older than it.
   - Write `_t: serverTimestamp()`.
4. Advance `pushedSeq`.

Records use the same rule against their `_clk`.

**Pull**:
- While a file has a session, run `onSnapshot(query(nodes, where("_t", ">", pullCursor), orderBy("_t")))`. Also on open, and on startup for files viewed in the last 7 days.
- For each changed document, keep the fields whose remote HLC is newer than the local per-field clock in `clocks.bin`. That file is maintained by the store for synced files and holds, per `(guid, field)`, the HLC of the latest write it knows about.
- The kept fields become a journal frame with `kind: "remote"`. It is broadcast to the open editor as `file.changes`, and the engine applies it with `engine_apply_changes(…, APPLY_REMOTE)`: **no undo entry**, no `DOCUMENT_CHANGED` (Figma's rule: you undo only your own changes).
- Workspace collections are listened to continuously.

**Offline**: the app is fully functional. The Replicator retries with exponential backoff from 2 s to 5 min. A tab reports `unsynced: true` once its outbox has been non-empty for over 60 s (shown as Figma's unsynced icon on the tab).

**Limits respected**: documents ≤ 1 MiB; ≤ 100 operations per transaction (Firestore allows 500); field names are schema names; depth ≤ 20.

### 12.6 Security rules (sketch; `OWNER_UID` filled in by the owner at deploy)

```
// firebase/firestore.rules
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function isOwner() { return request.auth != null && request.auth.uid == 'OWNER_UID'; }
    match /{path=**} { allow read, write: if isOwner(); }
  }
}
// firebase/storage.rules
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isOwner() { return request.auth != null && request.auth.uid == 'OWNER_UID'; }
    match /{path=**} { allow read, write: if isOwner(); }
    match /previews/{previewId}/{rest=**} { allow get: if resource.metadata.revoked != 'true'; }   // get, never list
  }
}
```

---

## 13. Developer preview sharing (design)

Goal: developer friends open a link and see the designs exactly as rendered, with Dev-Mode-like Inspect. They are read-only, need no account and cannot list anything else.

**Flow**:
1. In the editor: Share → **"Share preview…"** modal, with these options:
   - pages (all or chosen);
   - **Inspect** (on by default);
   - **Allow exporting assets** (on);
   - expiry (Never, 7 days, 30 days).

   Then **Publish preview**, and **Copy link** once it exists. Later the modal shows **Update preview** and **Stop sharing**.
2. The editor calls `engine_encode_document(ENCODE_BAKE_TEXT)` (`engine.md` §10.8). Later it adds `ENCODE_PAGES(list)` for chosen pages; until then, every page is included. The snapshot holds the internal canvas (components, styles, variables) and, on each TEXT node, `derivedTextData` with **glyph outlines as blobs**. The viewer therefore renders exact text without the owner's font files, so no fonts are redistributed. The viewer runs the same `engine.wasm` in `VIEWER` or `INSPECT` mode.
3. `previews.publish(fileKey, {snapshot, blobRefs, options})` (store `PreviewService`, §8.1; needs sync configured):
   - It reuses the file's existing `previewId`, or makes a new 22-char one.
   - It uploads `previews/{id}/doc.kiwi` (the container with a deflate-raw data chunk) and `previews/{id}/images/{sha1}` for the referenced blobs.
   - It uploads `previews/{id}/manifest.json` **last**, with custom metadata `revoked: "false"`.
   - It records `PreviewRecord {previewId, fileKey, createdAt, updatedAt, expiresAt, options, blobRefs, url}` in `previews.json`.

   The link is `https://<viewer.origin>/p/{previewId}`.

   ```json
   { "format": 1, "previewId": "…", "fileName": "…", "publishedAt": 0, "expiresAt": null,
     "pages": [{ "id": "0:1", "name": "Page 1" }], "snapshot": "doc.kiwi", "documentFormatVersion": 1,
     "images": ["<sha1>"], "options": { "inspect": true, "export": true } }
   ```

4. **Stop sharing**: set `revoked: "true"` on the manifest, then delete the folder. An expired preview (`expiresAt` passed) is refused by the viewer and swept by the store at its next start while sync is on.

**Viewer** (`src/viewer/`, built by `vite.viewer.config.ts` into `out/viewer`, deployed by the owner with `firebase deploy --only hosting`):
- The same `engine.wasm` in **viewer mode** (no editing APIs), plus a small React shell.
- It has the page list, a read-only layers list, pan and zoom, Present (the prototype player) and **Inspect**. Inspect shows:
  - size, position and rotation;
  - auto layout (direction, gap, padding, sizing) and constraints;
  - fills and strokes with hex/RGBA and **variable names with the resolved mode**;
  - typography with **text style names**;
  - effects;
  - a CSS snippet;
  - Alt-hover distance measurement;
  - export of the selection as PNG or SVG, rendered client-side.
- Data comes from `PreviewAdapter`: `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/previews%2F<id>%2F<name>?alt=media`.
- The viewer is single-threaded, so Hosting needs no COOP/COEP. `firebase.json` still sets them, for parity.

**Fallback until Firebase is configured**: Share › **"Export preview as HTML…"** writes one self-contained HTML file through `file:export-assets`. It contains the viewer JS, the engine Wasm, the snapshot and the images, all inlined as base64. The Wasm is instantiated from bytes, so the file works from `file://` in Chrome, Safari or Firefox (WebGL 2 required). Its size is about 1.37 × (wasm + document + images). Friends receive it like any attachment.

---

## 14. What is deleted from the old code, and when

**Phase 0 (owner, before any deletion)**: commit the current tree and tag it `site-admin-final`. The repository has no commits yet, and this keeps the site admin recoverable. Run `scripts/legacy/export-site.mjs` (§11.3) if the old projects will be wanted.

**Phase 1** lands with the new shell and store. The old site admin stops being the product.
- **Firebase site data**: `src/shared/firebaseConfig.ts`, `lib/firebase.ts`, `lib/auth.ts`, `lib/firestore.ts`, `lib/storage.ts`, `lib/media.ts`, `lib/slug.ts` and `lib/slug.test.ts`, `lib/siteConfig.ts`, and `lib/data.ts`. Its error vocabulary moves to `StoreErrorCode` and its never-overwrite-unread rule to §5.6.
- **The demo backend**: `demo/*` and the `--mode demo` aliases in `vite.shared.ts`, replaced by `DESIGNER_SEED=demo`.
- **The `firebase` and `gsap`/`@gsap/react` dependencies.**
- **Publish to the site**: `figma/publish.ts`, `figma/site.ts`, `figma/draft.ts`, `home/actions.ts`, publish and unpublish in `figma/session.ts` and `figma/chrome.tsx`, the Published view, and the Live/Changed badges.
- **The CV**: `cv/*`, `types/cv.ts`, `lib/cvDefaults.ts`, `components/Footer.tsx`, `PageEntrance.tsx` and `TextScrollingEffect.tsx`.
- **The preview tab**: `tab/PreviewTab.tsx` and `tab/siteTokens.ts`.
- **Site embeds and the site model**: `figma/embeds/*`, `figma/EmbedView.tsx`, `figma/overview.ts`, `figma/systemLibrary.ts`, the global `design/*` design-system loading, the starting site tokens and Turkish text styles in code (`components/project/designVariables.tsx` and `textStyles.ts` starting lists), and `home/Library.tsx`.
- **The global library**: `figma/designSystem.ts` (tombstones and detach) is not deleted yet. It is kept as reference for §9.6 until Phase 2.
- **The sign-in** (`docs/desktop.md` §16).
- **`AGENTS.md`'s rule to mirror changes into `burakkoc.net/Web/portfolio/src/figma`** is dropped at once. The site keeps its own renderer, its own Firebase project (`burakkoc-a15d3`) and its web admin. DesignerV2 no longer reads or writes them.

**Phase 2** lands when the Wasm engine renders and edits files and the panels are ported. The DOM editor goes: `figma/NodeView.tsx`, `css.ts`, `vectorSvg.ts`, `inline.ts`, `exportNode.ts`, `dom.ts`, `picking.ts`, `PageView.tsx`, `Canvas.tsx`, `session.ts`, `figma/model.ts` (after its types are copied to `scripts/legacy/model.ts`), `components/admin/useUndo.ts`, and the remaining site-only renderer components (`ZoomableIframe`, `ScrollReveal`, `CodeHighlight` if unused). Until then, `src/renderer/src/figma/**` stays in the tree as porting reference but is **not imported by any entry**, so it does not ship.

**Phase 3** (optional): delete `scripts/legacy/` once the owner confirms the imported projects.

---

## Open questions

1. **Coarse LWW for instance overrides**: `engine.md` §14 Q1 asks whether instance overrides stay one `symbolData` property. If they do, LWW merges two devices' overrides on the same instance at whole-property granularity. That is acceptable for one user, and changing it is a document-contract decision. (Clearing fields is settled: `clearedFields`, §5.5.)
2. **`DOCUMENT_FORMAT_VERSION` in the `fig-kiwi` header**: can real Figma open our Save Local Copy? That depends on how close our schema stays to `figma-schema.kiwi`. If it cannot, should local copies use our own extension? Today: `.fig`, with no promise that Figma opens it.
3. **Folder colours**: Figma's exact folder palette since August 2026 is unverified. The `FolderColor` names above are placeholders.
4. **Drafts cannot publish**: kept for fidelity. The owner may prefer to allow it, which is a one-line change in `libraries.publish`.
5. **Version storage cost**: every checkpoint is a full snapshot. Hard links make unchanged snapshots free, but a 20 MB file edited daily grows by about 20 MB per checkpoint. Delta versions could come later if this matters.
6. **OAuth client**: the sign-in plan needs a "Desktop app" OAuth client in the new project. The alternative is a Cloud Function that mints custom tokens. Decide when the owner creates the project.
7. **Legacy text font**: the old model has no font family (text inherited the site's CSS font). Which family should converted text use: the site's font, if installed, or Inter?
8. **Previews and glyph outlines**: the preview design assumes the engine can emit text layout with outlines. If it cannot at first, previews would need font files, and only fonts marked `embeddable` could be uploaded.
