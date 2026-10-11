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
- the repository pattern (sync and accounts: `docs/multiplayer.md`, §12);
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
| Branches (contract, Phase 7) | A branch is a copy of a main file with the same GUIDs and asset keys plus its own base snapshot. Updates from main and merges are a three-way merge per (GUID, field) over NODE_CHANGES, grouped like Figma's `DiffChunk`. A merge is one journaled batch plus a version of `kind: "merge"` (§15). |
| Repositories | `WorkspaceRepository`, `FileRepository`, `BlobStore`, `LibraryRegistry`. `LocalAdapter` is always authoritative. `FirestoreAdapter` is added later behind a `Replicator` that pushes and pulls with per-property LWW using hybrid logical clocks. `PreviewAdapter` serves the web viewer. |
| Server | Replaced Firebase (2026-10-10): accounts, shared files and previews on Cloudflare, `docs/multiplayer.md` (§12). Only the store process talks to it. |
| Previews | A read-only snapshot with derived text and geometry, plus images, uploaded under an unguessable 128-bit id. Viewed in a web viewer (the same Wasm renderer) with Dev-Mode-like Inspect. Published to the Cloudflare Worker (`docs/multiplayer.md` §9) or exported as one self-contained HTML file. |

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
- Time Machine already backs up `~/Library/Application Support`. Save Local Copy is the other backup (a shared file also lives in its room, `docs/multiplayer.md`).
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

**Derived data (2026-10-07, Figma parity round 3).** A disk snapshot may carry the engine's `@derived` fields (`derivedTextData` with glyph outlines in `blobs`, `derivedSymbolData` with instance sublayer geometry, `fillGeometry` / `strokeGeometry`) with `Message.derivedDataVersion` set to the engine stamp that computed them — what Figma's own files store, so an open draws its first frame from stored geometry before any font arrives. The snapshot the engine writes (§5.5 "Snapshots from the engine") has them; a compaction keeps them for the nodes no frame touched (the merge drops a node's derived fields when a change touches it, §5.5 step 2); an import of a `.fig` keeps Figma's text layout and instance geometry stamped `FIGMA_DERIVED_DATA_VERSION` (§11.1 step 4; the engine reads it as its own, the next engine snapshot replaces it with the engine's stamp). `store.json` records the head's `derivedDataVersion` (`Generation.derivedDataVersion`, `OpenedFile.derivedDataVersion`, `VersionRecord.derivedDataVersion`), so the editor knows before decoding whether the first frame can wait for nothing.

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

**Derived fields in the merge** (2026-10-07): a node's `@derived` fields (§5.1) were computed from its values, so any change to the node — an update, a CREATED replace — drops them; a change Message never brings them in (a CREATED change carrying them has them dropped; only a snapshot with `derivedDataVersion` does). The merged snapshot keeps the untouched nodes' fields and the snapshot's `derivedDataVersion` (`NodeTable.toMessage({keepDerived: true})`, `CompactOutput.derivedDataVersion`).

**Snapshots from the engine** (2026-10-07, Figma parity round 3). The engine is the only thing that can compute derived data, so besides the worker's merge there is a second way a head snapshot is written: the editor hands the store `engine_encode_document(ENCODE_DERIVED)`'s kiwi Message — every live node CREATED in snapshot order, derived fields and `derivedDataVersion` included — through **`files.saveSnapshot(fileKey, {sessionID, message, headSeq})`** (`SnapshotSave` → `SnapshotSaved {adopted, seq}`; the editor's `DocumentSource.saveSnapshot`). The store adopts it only when its journal head is exactly `headSeq` — every change of the session is in the journal and nothing else (another session's frame) arrived — and writes it as `snapshot-<headSeq>.kiwi` exactly as a compaction's result (the folded segments become `previous`, the generation before is dropped, `blobRefs` recomputed from the message); a snapshot of an unchanged head (`headSeq == snapshotSeq`) replaces the file in place and the generations stay. Declined (`adopted: false`, not an error) when the head moved: the editor tries again at the next quiet moment. Refused (`adopted: false, refused: "loses-data"`, with the losses) when it lacks a node or a reference / content field the head holds (identity, mains, styles, variables and their bindings, library bookkeeping, text, vectors, paints, effects) — other values may change, to their defaults too (in kiwi absence is the default; geometry the engine corrected in memory and bound values it re-resolved reach the file this way) (`src/shared/store/snapshotCheck.ts`); the editor then stops sending snapshots for the session. Refused (`invalid`) when the bytes don't decode, don't start with the DOCUMENT node or hold anything but CREATED nodes; `read-only` / `forbidden` for a session that isn't the caller's edit session. The editor sends one 5 s after the last change on an idle moment, once 15 s after an open whose stored snapshot lacked this engine's derived data, and at the tab's flush (close, quit, hide) when the encode fits the handshake (`src/renderer/src/editor/persistence.ts trackSnapshot`); never while a transaction is open. The store's own compactor still runs for sessions that ended without one, on open, and for versions (`addVersion` compacts first; the version then links whatever the head snapshot holds, derived data included).

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
  1. `files.restoreDiff(fileKey, versionId)` returns a NODE_CHANGES message that turns the current head into the version. It contains `REMOVED` for GUIDs that do not exist in the version, full `CREATED` nodes for GUIDs that the current head lacks, and field-level changes for the rest; fields to clear follow the §5.5 requirement. A field the version leaves absent and the head holds at the value absence means (docs/schema.md §3.4) is no change, and one going back to a non-zero `@default` is written as that value. Local assets keep their library bookkeeping and the document its enabled libraries (§9.1).
  2. The editor applies it with `applyChanges(diff, "restore")` (APPLY_USER | APPLY_EXACT: library copies written too), as **one undoable batch** with label "Restore version". It is journaled as `kind: "restore"`.
  3. It then calls `files.createVersion({kind: "restore", restoredFrom})`, which appears as "Restored version from ‹date›".
- **Duplicate**: `files.duplicateVersion` creates a new file in Drafts named `‹name› (‹version title or date›)`. Its assets are new assets (§9.1).
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

// Not one of the four repositories: a store service; publishing needs the signed-in session (§13, docs/multiplayer.md §9).
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
- An excluded asset that a published one depends on is still shipped, with `dependencyOnly: true` (unlisted: never in Assets, never "removed" for consumers), so consumers render correctly and their copies of it keep getting its updates through the asset that uses it. That includes a component hidden or deleted after it was published that a published asset still nests: the Publish dialog shows its row as **Removed** with "Used by ‹asset›"; selected (the default), it ships unlisted; deselected, it stays listed — never both (§9.6).
- **What a published asset uses goes with it**: an asset whose payload a publish writes carries what it uses as it is now, so a new or modified asset it uses ships in the same version, at that content, listed — even when its own row is deselected. In the Publish dialog that row is checked and locked, with "Used by Button" ("Used by Button and Chip", "Used by Button and 2 others"), until every asset that uses it is deselected. A deselected asset keeps its last published entry, and what that entry's payload uses keeps shipping with it. The manifest and the payloads therefore always agree.
- **Key**: at the first publish, the engine writes a fresh `key` into every asset node that lacks one. That is an ordinary journaled edit in the library file, not an undo step. The key never changes afterwards: not by undo, not by Restore version. A cut-and-paste into another file makes a new component with a new key, and the old key is kept only in `libraryMoveInfo` (§9.5). **Duplicate file** and **Duplicate version** make new assets: the copy's local assets lose `key`, `publishedVersion` and `libraryMoveInfo` (library copies keep theirs), so the duplicate publishes as a new library with keys of its own (`src/shared/store/assetIdentity.ts`, both stores).
- **Published state follows publishes**: after a publish, the library file's assets carry the version's hashes in `publishedVersion` and published moved mains lose `libraryMoveInfo` (the engine's `markPublished`, a SYSTEM change: journaled, never an undo step). An asset the version removed has no `publishedVersion`, so a cross-file paste treats it as unpublished. Undo / redo and Restore version can bring back older document states, so the editor checks the assets against the file's latest manifest (on open, when a refresh finds a new version, after an undo / redo or a restore that brings bookkeeping back) and fixes them the same way. Restore version restores content and Hide when publishing, never a local asset's `key`, `publishedVersion` or `libraryMoveInfo`, nor the document's enabled libraries (§6).
- **versionHash**: the engine's content hash of the asset (docs/engine-build.md, "Libraries — review fixes"): the subtree in tree order, fields in schema order, derived fields, GUIDs, its place on the page, bound values and library bookkeeping left out, references outside it by the target asset's key; the hashes of the hidden assets it ships with (`dependencyOnly`) fold in, so a change to a hidden asset — or hiding one it nests — makes what uses it Modified. If the content is unchanged, the hash is unchanged.

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
- **Review and accept**: the Updates modal lists the changed components, styles and variables, comparing old (rendered from the copy) with new (manifest thumbnail or payload). "Update all" or a per-asset update fetches the payloads, and the engine replaces the copies in **one undo batch**. Accepting one asset also brings the hidden (`dependencyOnly`) assets it uses whose copies are behind, so it shows them as published. Instances re-materialise. Updates never apply automatically.

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

- **Removed** (deleted or hidden in the library, then published, and nested in no published asset): it appears in `diff().removed`. Consumers keep the copy, and instances keep rendering. Assets no longer lists it. The instance menu shows that the main component was removed from the library and offers Detach. In the library file the asset loses `publishedVersion` (§9.1).
- **Still used**: a component hidden or deleted in the library that a published asset still nests is not removed: it ships unlisted (`dependencyOnly`) with that asset, its row in the Publish dialog reads **Removed** with "Used by ‹asset›", consumers see no "Removed from library" and their copies keep getting its updates (§9.1).
- **Restore component** (a consumer, on a removed component): the copy becomes this file's own main, on the current page; its instances stay linked. When the file holds several copies of it (Update selected instance leaves them), every copy's instances, nested ones included, move to that main, overrides kept, and the other copies go. One undo step.
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

**Progressive images (2026-10-07, Figma parity round 3; as built in `src/renderer/src/editor/images.ts`, `thumbHash.ts`, `model/paints.ts`).** Figma shows a ThumbHash placeholder in the first frame, loads only the images in the viewport at high resolution and a low-quality copy for the rest (help.figma.com/hc/en-us/articles/360052988373; "high-resolution" = larger than 512×512). Ingestion computes, besides the bytes: the paint's `thumbHash` (field 25 — Evan Wallace's ThumbHash of a ≤ 100 px downscale, 19–28 bytes) and its low-res copy for `imageThumbnail` (field 9): an image over 512 px on a side is re-encoded at ≤ 512 px on the longer side (JPEG q 0.85 for JPEG / WebP originals, PNG otherwise) and stored as a **blob of its own**; a smaller image is its own thumbnail (`imageThumbnail.hash == image.hash`), as Figma's files do. GC (§10.3) counts every `Image.hash` at any depth of a node, so the tier is a blob ref of the file like the image (`messageImageHashes`, `NodeTable.imageHashes`; the batch's `blobRefsAdded` carries both). The engine asks `REQUEST_IMAGE {hash, maxDevicePx}` (how big the paint has been drawn so far, docs/engine-build.md round 3 item 5) and draws `Paint.thumbHash` itself until a bitmap arrives; the editor answers with the tier when the paint covers ≤ 512 device px and the full image otherwise, or when the engine asks again for more. Files whose IMAGE paints lack the two fields (older files, imports) get them written back as one SYSTEM change (journaled, not an undo step) once the images are decoded — the current page's paints only, ≤ 50 per idle slice. The `.fig` import keeps Figma's `imageThumbnail` when the file carries that image (else drops it) and maps `thumbHashBase64` (Figma's field 24) to `thumbHash` bytes.

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
4. If the embedded schema's sha1 is ours, take the message as is. Otherwise run `convertFigMessage(message, theirSchema, MODEL, {keepDerived: true})` from `src/shared/fig/convert.ts`. It drops fields our schema lacks and counts them into `importReport`; it keeps Figma's `derivedTextData` and `derivedSymbolData` (guidPath / size / transform / text) stamped `FIGMA_DERIVED_DATA_VERSION`, maps Figma's slots to ours (the content frame under its instance) — docs/data-impl.md "Import fidelity".
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

## 12. Sync and accounts — see docs/multiplayer.md

The Firebase adapter planned here (Firestore per-property sync, Storage, Firebase sign-in) was replaced by the owner's
decision of 2026-10-10: accounts, sharing, multiplayer and developer previews run on Cloudflare (a Worker, a Durable
Object per shared file and per preview, D1), contract in `docs/multiplayer.md`. Its code (`src/store/sync/`, the
`firebase/` project files) was removed on 2026-10-11. The workspace on disk stays the local source of truth; a shared
file's room is reached behind the same repositories (`src/store/multiplayer/`).

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
3. `previews.publish(fileKey, {snapshot, blobRefs, options})` (store `PreviewService`, §8.1; needs the signed-in session — *as built 2026-10-11 it publishes to the Cloudflare Worker, docs/multiplayer.md §9; the Storage paths below were the Firebase design*):
   - It reuses the file's existing `previewId`, or makes a new 22-char one.
   - It uploads `previews/{id}/doc.kiwi` (the container with a deflate-raw data chunk) and `previews/{id}/images/{sha1}` for the referenced blobs.
   - It uploads `previews/{id}/manifest.json` **last**, with custom metadata `revoked: "false"`.
   - It records `PreviewRecord {previewId, fileKey, createdAt, updatedAt, expiresAt, options, blobRefs, url}` in `previews.json`.

   The link is `<server>/p/{previewId}` (the Worker serves the viewer there).

   ```json
   { "format": 1, "previewId": "…", "fileName": "…", "publishedAt": 0, "expiresAt": null,
     "pages": [{ "id": "0:1", "name": "Page 1" }], "snapshot": "doc.kiwi", "documentFormatVersion": 1,
     "images": ["<sha1>"], "options": { "inspect": true, "export": true } }
   ```

4. **Unpublish**: `DELETE /previews/<id>` on the server. An expired preview (`expiresAt` passed) is refused by the server (410) and the viewer, its files deleted by its Durable Object's alarm, and its record swept by the store when it next gets a session.

**Viewer** (`src/viewer/`, built by `vite.viewer.config.ts` into `out/viewer`, deployed as the Worker's static assets — docs/multiplayer.md §9):
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
- Data comes from the same origin: `/previews/<id>/manifest.json`, `doc.kiwi`, `images/<sha1>` (`src/viewer/remote.ts loadRemote`).
- The viewer is single-threaded, so it needs no COOP/COEP.

**Without an account**: Share › **"Export preview as HTML…"** writes one self-contained HTML file through `file:export-preview` (§13.1). It contains the viewer JS, the engine Wasm, the snapshot and the images, all inlined as base64. The Wasm is instantiated from bytes, so the file works from `file://` in Chrome, Safari or Firefox (WebGL 2 required). Its size is about 1.37 × (wasm + document + images). Friends receive it like any attachment.

### 13.1 As built (2026-10-08, branch `dev-previews`)

**Snapshot.** The editor makes it, and only the store packages and writes it (`src/renderer/src/editor/previews.ts previewSnapshot`).
- Every included page is derived first (`engine.layerTree(page)`, which also asks for the page's fonts). The editor waits for the fonts (up to 8 s) and then calls `engine.encodeDocumentKiwi({derived: true})`. This is the round-3 `ENCODE_DERIVED` snapshot and plays the part of `ENCODE_BAKE_TEXT`: each instance carries `derivedSymbolData` and each text whose font was present carries `derivedTextData` with glyph outlines.
- A text whose font is missing in the editor too is stored without outlines. The viewer then lays it out with Inter, as the editor draws it.

**Package** (`src/shared/preview/`, pure, shared by the store, the viewer and the tests):
- `format.ts` holds `PreviewManifest` and `PreviewPackage`, the file names (`manifest.json`, `doc.kiwi`, `images/<sha1>`), expiry and validation.
- `package.ts buildPreviewPackage`:
  - decodes the snapshot;
  - keeps only the chosen pages (`keepPages`; the internal canvas always stays);
  - lists the pages and their top-level layers, topmost first (`previewPagesOf`);
  - collects the images the paints use (`messageImageHashes`, read from the blob store);
  - writes `doc.kiwi`, a fig-kiwi container with our schema and a deflate-raw data chunk, which browsers inflate with `DecompressionStream`.
- `html.ts inlinePreviewHtml` turns the viewer's page plus a package into one HTML file. The package goes in `<script id="designer-preview-data" type="application/json">` as `{manifest, doc: base64, images: {sha1: base64}}`, and `<` is escaped. The title becomes "‹file› – Developer preview". `readInlinePreview` reads it back.

**Store** (`src/store/preview/previews.ts`, wired in `LocalStore` as `previewsOf`):
- `previews.status()` answers `{publish, reason}`: "Log in to publish" while main has handed the store no session (2026-10-11; before, Firebase's reasons).
- `previews.list(fileKey?)` lists the published previews.
- `previews.publish(fileKey, {snapshot, options})`:
  - uploads to the server with the session (`LocalStore.session`, captured from `multiplayer.setSession`): the images it lacks (`POST /previews/<id>/images/missing`, then `PUT …/images/<sha1>`), `doc.kiwi` (staged), then the manifest **last**, which makes it live and drops images the new version no longer uses (docs/multiplayer.md §9);
  - reuses the file's `previewId`, so the link stays the same;
  - records `PreviewRecord` in `previews.json`. Blob GC keeps the published images.
- `previews.stop(previewId)` (Unpublish) deletes it on the server (already gone: fine), then drops the record.
- `previews.exportHtml(fileKey, {snapshot, options}, path)` is **main-only**: it is in `MAIN_ONLY`, because it takes a path. It reads the viewer's built page (`viewerTemplate`, by default `out/viewer/index.html` next to `out/main`), inlines the package and writes the file atomically.
- The browser dev store answers `status` with publish off and refuses `exportHtml`.
- The link is the server's answer, `<server>/p/<previewId>`.

**Main and IPC.** `file:export-preview` (editor role; `{fileKey, snapshot, options}`) shows `showSaveDialog` with "Export preview as HTML" and `‹name›.html`. Main then calls `store.previews.exportHtml`. It is exposed as `designer.files.exportPreview`.

**Editor** (`ShareDialog.tsx`):
- It opens from the right panel's **Share** button and from File ▸ **Share preview…** (`file.share-preview`, which is in the menu bar too).
- The dialog is titled "Share “‹file›”". It has a note, **Pages** (All pages / Only “‹page›”), **Inspect**, **Allow exporting assets** and **Link expires** (Never / In 7 days / In 30 days).
- **Publish preview** copies the link once published. After that the dialog shows the link with **Copy link**, **Update preview** and **Unpublish**.
- **Export as HTML…** appears in the desktop app.
- While publishing is off, a banner gives the store's reason.

**Viewer** (`src/viewer/`, built by `vite.viewer.config.ts` with `npm run build:viewer`; `npm run build` builds it too). The build is **one page**, `out/viewer/index.html`, about 6.1 MB:
- its JS and CSS are inlined, and fonts and icons are data URLs;
- the engine's Wasm is a base64 `<script id="designer-engine-wasm">` block, instantiated from bytes with `loadEngine({wasmBinary})`;
- `<!--designer:preview-data-->` marks where the store puts a package.

The same page is the Worker's static asset for `/p/<id>`, so the export is just this page with a data block. How it works:
- **Source** (`source.ts`): the inline block (an exported file); `/p/<id>` (or `?p=<id>`, with `&server=<origin>` for another server) read from `/previews/<id>/…`; or `?src=<folder>` (dev). The HTTP cases go through `remote.ts loadRemote`, a general loader (a fig-kiwi document or a bare kiwi Message, a manifest URL or one made from the message) meant also for a shared file's room snapshot. Expired previews (410 or `expiresAt`) and documents from a newer format are refused with a message.
- **Engine**: the same `engine.wasm`, loaded with `loadKiwi(message, {page})` and `setImageSource` from the package.
- **Fonts** (`fonts.ts`): only the bundled upright Inter is shipped, for the canvas's labels and upright-Inter texts. Every other face, Inter's italics included, is reported missing on purpose, so those texts draw from the stored outlines and none of the owner's font files are redistributed. The italic file isn't even bundled.
- **Read-only input** (`ViewerCanvas.ts`): the engine sees hovers, clicks (a press and release in place: Figma's selection rules, ⌘ deep select, ⇧ adds) and the wheel, never a drag.
  - A drag pans, and so do Space-drag and the middle button.
  - A double-click selects one level deeper.
  - Keys: ⇧1 zoom to fit, ⇧2 zoom to selection, ⌘± zoom, ⇧0 / ⌘0 100 %, Esc selects the parent.
- **Layout**, Dev Mode's ([R9](research/figma/R9-dev-mode.md)):
  - **Left**: the file name with "Developer preview", Pages, and the Layers tree (read-only; the selection's ancestors open).
  - **Canvas** with hover **measurements**: red lines and values between the selection and the hovered layer, with no ⌥ needed, from `inspect/measure.ts`.
  - **Inspect**, nothing selected: the page, Code with the language (CSS / iOS (SwiftUI) / Android (Compose), remembered), the page's Frames, and Variables with "Open variables table" (collections, one column per mode, a click copies).
  - **Inspect**, one layer: its name and type; Component or Instance (main component, variant and properties); Layout (box model with padding, size, left and top in the parent, Hug / Fill, rotation, radius, opacity, auto layout and gap); Code (CSS grouped Layout / Style / Typography, each with Copy, or a SwiftUI or Compose snippet); Colors (fill and stroke with hex, the variable's name with its collection and mode, or the style's name); Typography (text style, font, weight, size, line height with %, letter spacing, content); Effects; Annotations, Assets and Export (when allowed; see "Round 5" below). Every value copies on click.
- **Snippets** (`inspect/css.ts`, `inspect/native.ts`, `inspect/model.ts`, pure and tested) follow Figma's output as far as it is documented: `var(--Name, fallback)`, a variable's Web code syntax honoured, `#FFF` shortening, the `line-height … /* 125% */` comment, the text style as a comment, blur halved for CSS, `url(<path-to-image>) lightgray 50% / cover no-repeat`.

**Hosting** (2026-10-11): the Worker serves the viewer and the files (docs/multiplayer.md §9); the `firebase/` project files were removed.

**Checks:**
- `src/store/preview/previews.test.ts` (8 tests): pages and frames, `keepPages`, the container and manifest, the HTML block round trip with escaping, `exportHtml` writing a file from blobs, the role rule; against the real Worker handler (node:sqlite D1, `PreviewBox` objects in process): "Log in to publish" until a session, publish, read back by anyone, update in place, Unpublish, someone else's preview refused, the sweep of expired ones.
- `src/viewer/inspect/inspect.test.ts` (12 tests): numbers, colours, variable names, sizing, typography, gradient angle, CSS for an auto-layout frame, text, variables and flex items, SwiftUI, Compose, measurements.
- `src/viewer/testing/preview.wasm.test.ts`: a synthetic file made by the real engine (variable-bound fill, text style, image, Inter Italic caption, component and instance, two pages) gives a derived snapshot with outlines. Its package and HTML round trip load into a fresh engine with the stored layout, and the panels' reads (variable with collection and mode, style name, parent layout, page boxes, layer order) come back right.
- `npm run viewer:check` (`vitest.viewer.config.ts`, headless Chromium, about 15 s) has two cases:
  - it builds the viewer, exports the synthetic file to an HTML file and opens it from `file://`; it checks that it renders, then selects from Layers, inspects CSS / SwiftUI / Compose, the variable and the text style, draws the italic caption from its outlines, measures on hover and switches pages;
  - it serves the page at `/p/<id>` and the package under `/previews/<id>/` (the Worker's layout) with only one page and Inspect off, and checks that an expired preview (`?src=`) is refused.
  Screenshots go to `$TMPDIR/designer-viewer-check/`.

**Round 5 (2026-10-08, branch `r5-prototype-viewer`; R9-dev-mode.md):**
- **Read-only engine**: the viewer turns on the engine's viewer mode (`setViewerMode`, docs/engine-build.md "Round 5"): no resize handles, nothing a click, a drag or a key could change; edits through the API return `E_READONLY`.
- **Present**: ▶ in the Inspect header (⌥⌘↩) plays the preview's prototype in the presentation view (`PresentationView`, on an engine of its own loading the preview's Message and images) — device frames, scale options, Esc back.
- **Export** (`DevSections.tsx`): the layer's export settings (else 1x PNG), "+" for more, each a scale (0.5x–4x) and a format (PNG, JPG, SVG, PDF) — drawn by the E7 exporters (`editor/exportCore.ts`, shared with the editor; the vector writers get the preview's images) — "Export ‹layer›" downloads one file or a ZIP.
- **Assets**: the icons (small layers made only of vector shapes) and images inside the selected layer, with a thumbnail; icons as SVG / PNG / JPG / PDF, images as "Source image file" (the original from the preview) or "Layer export".
- **Code / List** toggle (remembered) and the **units** in the language menu's Settings: CSS px / rem, iOS pt / px, Android dp / sp / px, and "Set unit scale…" (root font size; scale factor) — `inspect/units.ts`.
- **Statuses**: designs marked "Ready for dev" / "Completed" (`sectionStatusInfo`, set in the editor's canvas menu) are listed under "Ready for development" in the left panel and badged in Inspect.
- **Annotations** stored in the file (`annotations`: the note's HTML as text, the pinned properties with the layer's values) show on the canvas as a green dot with the note, and in Inspect.
- **Expired previews** are swept (`previews.sweepExpired`; since 2026-10-11 when the store gets a session, deleting them on the server).
- Checks: `inspect/devMode.test.ts` (statuses, annotations, asset detection, List rows, units), `preview.wasm.test.ts` (the status, annotation and icon through the snapshot; viewer mode), `previews.test.ts` (the sweep), `npm run viewer:check` (status, annotation, rem, List, Compose, the icon in Assets, an SVG export downloaded and read, Present).

**Round 6 (2026-10-08, branch `r6-annotations-devmode`; R9-dev-mode.md "Round 6"):**
- **Annotations drawn by the engine**: the viewer turns on the engine's Dev Mode dots (`setAnnotationView(true, true)`); a click opens the note's label with its leader line (the DOM pins are gone). Notes read `labelV2` (markdown) first.
- **Statuses**: "Changed" when the design's `editInfo.lastEditedAt` is later than its status (the editor stamps editInfo; Figma's files carry it), in the left panel, Inspect and on the canvas; Inspect shows "Edited … ago".
- **The editor's Dev Mode uses these panels** (docs/editor.md "round 6"), with `ViewerState.host` for what only the editor has (Compare changes, focus view, the status menu).
- **Version history** for Compare changes: `DocumentSource.openVersion` (the store's `files.openVersion`).

**Not done:**
- Annotation and measurement tools in the viewer (it is read-only; the editor's Dev Mode has them) (the viewer shows what a .fig brings); Figma's "Automatically detect icons" switch and its exact heuristic (ours: ≤ 128 px, vectors only); the exact unit conversion of native snippets.
- Publishing is checked against `wrangler dev` (2026-10-11), not yet against the deployed Worker. The desktop export path (editor → `file:export-preview` → the store) is checked by types and the store tests, not by driving the built app: the Save dialog is native. Reading `out/viewer/index.html` from inside `app.asar` in a packaged build is untried.
- The exact SwiftUI / Compose output and the redline colours are unverified against Figma (R9).

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

## 15. Branches (contract, Phase 7 round 2; written 2026-10-11)

**Status: contract; the server side (round 2c) is built — §15.7.1.** It covers:
- Figma's branching and merging: a branch is a separate copy of a main file, kept up to date from main and merged back;
- the three-way merge over our own change format;
- where branches live for local and for shared (room) files.

Research: `docs/research/figma/R18-enterprise.md` D-1. The plan: `docs/roadmap.md` Phase 7 round 2. Figma's facts, read 2026-10-11:
- **[B-guide]** Guide to branching — https://help.figma.com/hc/en-us/articles/360063144053
- **[B-merge]** Merge branch into main file — https://help.figma.com/hc/en-us/articles/5691189138839
- **[B-update]** Get updates from main files — https://help.figma.com/hc/en-us/articles/5665728006423
- **[B-review]** Request a branch review — https://help.figma.com/hc/en-us/articles/5691414603543 ; Review branch changes — https://help.figma.com/hc/en-us/articles/5693123873687
- **[B-share]** Share a branch — https://help.figma.com/hc/en-us/articles/5665697002263
- Figma's schema (`docs/research/figma/figma-schema-106.kiwi`):
  - `DiffPayload {nodeChanges, blobs, diffChunks, diffBasis, basisParentNodeChanges, parentNodeChanges, diffType}`
  - `DiffChunk {nodeChanges (indices), phase, displayNode, canvasId, canvasName, canvasIsInternal, chunksAffectingThisChunk, basisParentHierarchy, parentHierarchy, basisParentHierarchyGuids, parentHierarchyGuids}`
  - `DiffType {BRANCHING, NODE_CHANGES_ONLY}`
  - `MessageType.DIFF = 13`
  - `Message.pasteBranchSourceFileKey = 26`
  
  That is: Figma computes branch diffs as NodeChanges grouped into chunks, one per displayed layer. We use the same shape.
- The activity log's `file_repo {id, name, main_file_key}` entity: a main file and its branches form a **repo** (docs/multiplayer.md §14.10).

### 15.1 What Figma does (the behaviour to match)

**Who.** Branching is on Organization and Enterprise and needs a **Full seat**. You need view or edit access to the main file [B-guide]. Viewers can branch only when "viewers can copy" is on; otherwise they don't see the option. There is no limit on the number of branches.

**Create.** The file-name menu has "Create branch…", which asks for a name. The branch is an exact copy of main at that moment. The left sidebar shows "‹file› / ‹branch›" [B-guide].

**Access** [B-share]:
- Anyone with access to main can open its branches.
- Inviting someone to a branch also gives them main.
- Branch links carry `/branch/<key>`.

**Version history.**
- Checkpoints are labelled **"Branch created"**, **"Updated from main"** and **"Branch merged"**.
- An extra checkpoint is made before a merge [B-guide].
- Comments are the branch's own: main's don't appear, and the branch's don't merge.
- Publishing a library is only possible from main.

**Updates from main** [B-update]:
- A notice says main has changed. You take **all** updates or none: they can't be picked.
- Conflicts can be resolved then, or left for the merge.
- Conflicts are listed in a left sidebar; selecting one shows **main on the left, the branch on the right**. You pick one per conflict, and a badge shows the pick. **Resolve all** offers "Pick main file" / "Pick branch".
- "Apply changes" applies them. You can undo by restoring an earlier version.

**Review** [B-review]:
- "Review and merge changes…" opens **Branch review**, with the changes ("side by side" by default, or overlay with an opacity slider).
- **Request review** takes reviewers (suggested: people who can edit main) and a description. The branch shows **In review**.
- A reviewer answers with **Add your review** › **Approve** or **Suggest changes**, which shows the badge **Changes suggested**. The author then uses **Request another review**.
- **Approved** does not merge by itself.

**Merge** [B-merge]:
- Anyone who can edit main merges; others must request a review.
- Everything merges or nothing does.
- The name and description go into main's version history.
- The branch is archived. A memory-limit banner blocks merging.

**View branches**: tabs **Active**, **Archived** (merged and archived) and **Yours**. People who can edit main can open, copy link, merge, archive, rename and restore branches there.

**Unverified:**
- whether branches of branches exist (we refuse them);
- whether a merged branch can be restored (we refuse it: R18's reading);
- what "Pick main" does to the branch's *other*, non-conflicting edits on the same layer (we keep them: §15.4 rule 6);
- the exact wording of the update notice.

### 15.2 Records

```ts
// src/shared/store/types.ts (additions, round 2a)
export type BranchStatus = "active" | "archived" | "merged";
export interface BranchRecord {
  /** The branch's own file (a local file, or a room for a shared main) */
  branchFileKey: FileKey;
  mainFileKey: FileKey;
  /** Room keys when main is shared (the branch is then shared too); null for local files */
  mainKey: string | null;
  branchKey: string | null;
  name: string;
  createdBy: { id: string | null; name: string | null };   // null id: the local user
  createdAt: number;
  status: BranchStatus;
  /** The merge base: main as it was at "Create branch" or the last "Update from main" */
  base: { mainSeq: number; mainVersionId: VersionId | null; at: number };
  /** main's head seq when the branch last looked (the "main has changed" notice compares it) */
  mainSeenSeq: number;
  archivedAt: number | null;
  mergedAt: number | null;
  mergedBy: string | null;
  /** The main's version "Branch merged" made by the merge */
  mergeVersionId: VersionId | null;
  review: BranchReview | null;
}
export interface BranchReview {
  id: string;
  state: "in-review" | "approved" | "changes-suggested" | "closed";
  requestedBy: string | null;
  description: string;
  createdAt: number;
  reviewers: { userId: string; name: string | null; verdict: "pending" | "approved" | "changes-suggested"; comment: string; at: number | null }[];
}

// FileMeta gains (round 2a; local listings show a file with `branch` only under its main):
//   branch: { mainFileKey: FileKey; name: string; status: BranchStatus } | null
// VersionRecord.kind gains "branch" ("Branch created"), "update" ("Updated from main"), "merge" ("Branch merged");
//   all three are kept forever (§6 retention). The pre-merge checkpoint is an ordinary "autosave".
// BatchKind gains "merge" (main ← branch) and "update" (branch ← main): journaled, never undoable, applied to open
//   editors as remote changes (APPLY_REMOTE); undoing a merge = restoring the version before it (Figma).
```

**The branch point and the base.**
- At "Create branch" the store first makes a **"branch" version on main** (a full snapshot, §6).
- The branch keeps **its own copy of the base snapshot**: `files/<branch>/branch/base.kiwi` (hard link of main's version file, as §6) and `branch.json` (the `BranchRecord`).
- "Update from main" replaces both with main's head at that moment. The base is always the main state the branch last absorbed, so a conflict resolved once never comes back.
- For a shared main, the branch room stores the base as its own chunks (`base`, §15.7).

**The copy keeps identity** (unlike Duplicate, §6):
- The branch is made from main's head snapshot with **the same GUIDs, the same asset keys and the same library bookkeeping**: no `withNewAssetIdentity`.
- Its pages, variables, styles and components are the same nodes.
- Only the branch's `FileMeta` (name "‹branch›", `branch`) and its store state are new.

**GUID ranges** (two files with the same GUIDs must never mint the same new ones):
- **Local:** sessionIDs are `(deviceOrdinal << 20) | n`, with `n` counted per file (§1). At creation, main's `sessions.nextLocal` jumps by **4096** and the branch's starts at main's old value: the branch owns `[old, old + 4096)`. A branch that runs out asks main for the next block (same store, same rule).
- **Rooms:** the main room's session counter jumps by **65536** and the branch room's starts at the old value (`POST /files/:key/branches` returns it, §15.7).

### 15.3 The diff

`src/shared/merge/diff.ts` generalizes `files.restoreDiff` (`diffTables` in `src/shared/schema/patch.ts`, `restoreDiff` in `src/shared/store/assetIdentity.ts`): `diff(a, b)` is the per-node, per-field difference that turns table `a` into table `b`.

- **Equality** is on decoded values. `@blob` fields compare by the **bytes** (SHA-1) of their blobs, never by index: two tables number blobs differently. Images compare by hash.
- **Absence** follows `docs/schema.md` §3.4: a field absent on one side and holding the value absence means on the other is **no change** (as `restoreDiff`).
- **`@derived` fields are never compared** and never written.
- **Keyed fields** are lists with stable item keys. They are diffed **per item**, so that two sides editing different items of one property don't collide:

  | Field | Item key |
  |---|---|
  | `symbolData.symbolOverrides` | the entry's `guidPath` (its overrideKeys), then per field inside the entry |
  | `componentPropAssignments` | `defID` |
  | `componentPropDefs` | `id` |
  | `parameterConsumptionMap.entries` | `variableField` |
  | `variableDataValues.entries` | `modeID` |
  | `variableSetModes` | `id` |
  | `prototypeInteractions` | `id` |
  | `librarySubscriptions` (DOCUMENT) | `libraryKey` |

  Everything else (`fillPaints`, `textData`, `effects`, `vectorData`, …) is **one value**, as the per-property rule of `docs/schema.md` §4.2 says.
- **Output**: a `TableDiff` (§15.6). Each node is created, removed, or updated with its changed fields and keyed items; each field records its value on both sides.

### 15.4 Three-way merge

Inputs:
- **B** — the base: main at the branch point or last update;
- **O** — ours: the head of the side receiving nothing yet;
- **T** — theirs: the head of the side being written.

| Direction | O | T | Written to |
|---|---|---|---|
| merge | branch | main | main |
| update | main | branch | branch |

`dO = diff(B, O)` and `dT = diff(B, T)`. For every GUID changed on either side:

1. **Only one side changed it**: take that change.
2. **Both updated the same field or keyed item**:
   - equal values → no conflict (convergent);
   - different values → **conflict** `field` (or `keyed`, naming the item).
3. **Different fields or items of one node** → no conflict; both apply. A keyed field's merged value is rebuilt from B's items with both sides' item changes.
4. **Removed on one side, changed on the other** → **conflict** `delete-edit`. "Changed" includes: any field of the node; a node created under it; a node moved into it; a reference to it set on the other side (`symbolData.symbolID`, `styleIdFor*`, a variable alias, `transitionNodeID`, a `PROP_REF`). Removed on both → removed, no conflict.
5. **`parentIndex`** is one field, judged specially:
   - Different **parents** on the two sides → conflict `move`.
   - The same parent with different positions → **no conflict**: the side being merged in wins (the branch on merge, main on update). Order-only collisions are noise.
   - If the two moves together would make a node its own ancestor → conflict `cycle` on both nodes.
6. **Resolving** a conflict picks **main** or **branch** for that conflict's (GUID, field / item) pairs only. The non-conflicting changes of both sides in the same layer still apply (unverified against Figma, §15.1). A resolved `delete-edit`:
   - "keep the deletion" removes the node and its subtree, including what the other side created in it;
   - "keep the edit" brings the node back (its full state from the side that kept it, and its removed ancestors as they were in B).
7. **Position collisions**: siblings from the two sides that land on the same `parentIndex.position` under one parent get the incoming node re-keyed (`keyBetween` its neighbours, `docs/schema.md` §10). The merge batch carries the new position.
8. **Library copies** (nodes with `sourceLibraryKey` on the internal canvas, `docs/schema.md` §8.2):
   - The side with the higher library `version` wins the whole copy subtree, with no conflict. Equal versions with different contents is a `field` conflict, which shouldn't happen.
   - Enabled libraries (`librarySubscriptions`) merge per `libraryKey`.
9. **Local assets** (`key`, `publishedVersion`, `libraryMoveInfo`): never conflict. On merge, main's bookkeeping is kept (publishing happens only from main).
10. **Type conversions** (REMOVED + CREATED of the same GUID on one side, §4.2.2) count as one change of the whole node. Against an edit on the other side they are a `field` conflict on the node, resolved whole.
11. **Validity**: the merged table is checked by the engine's rules (`docs/schema.md` §4.6) before anything is written. A variable gaining a mode on one side and a new variable on the other is valid (a missing mode value falls back to the default). A violation that no rule above explains aborts with `invalid` and the offending GUIDs: a bug to fix, never written.

**Result**: the merged table **M**, and the batch `diffTables(T, M)` cleaned like `restoreDiff` (absence rules, bookkeeping). With no conflicts, merging into an unchanged side gives exactly the other side: if `T == B` then `M == O`. A test checks this.

**Grouping — Figma's DiffChunk** (what Review and Resolve conflicts list). Every changed node goes to one chunk, keyed by its **display node**:

| Node | Display node |
|---|---|
| On a page | its top-level layer (the ancestor whose parent is a CANVAS) |
| A page itself (name, order, background) | the page |
| A variable, a mode or an extension override | its collection (VARIABLE_SET) |
| A style | the style |
| A component or variant (when on the internal canvas) | the component or its set |
| A library copy | the library copy's root |
| DOCUMENT | the document |

- A chunk's `phase` is CREATED, REMOVED or updated (absent) by its display node's own fate.
- `canvasId` / `canvasName` / `canvasIsInternal` name its page.
- `parentHierarchyGuids` is the path to it.
- A node moved between two display nodes belongs to the **destination's** chunk, and the source chunk lists it in `chunksAffectingThisChunk`. Removed nodes group by their display node in B.
- Conflicts are listed per chunk, which is the conflict item of Resolve conflicts. "Pick main" / "Pick branch" on a chunk resolves all its conflicts; **Resolve all** resolves every chunk.

### 15.5 The flows

**Create branch** (`branches.create(mainFileKey, name)`):
1. Flush main.
2. Make version `kind: "branch"` on main.
3. Copy main's head snapshot into a new file. It has `FileMeta.branch` set, the same folder as main and the name "‹branch›". Its own first version is `kind: "branch"` ("Branch created").
4. Write `base.kiwi` and `branch.json`.
5. Reserve the GUID block.

Refused for:
- a branch of a branch (`invalid`);
- a viewer of a shared main without "viewers can copy" (`forbidden`);
- in an org, a seat other than Full (`forbidden`, `seat_required`).

**The notice**: the branch compares main's head seq with `mainSeenSeq`. Main changed since the base → the editor's banner offers to review updates (wording to read from Figma before building; §15.1).

**Update from main** (`previewUpdate` → `applyUpdate`):
1. Merge with direction `update`.
2. Conflicts are shown (main left, branch right) and must all be picked before Apply.
3. Apply appends the batch to the branch as `kind: "update"`, then makes version `"update"` ("Updated from main") on the branch.
4. The base becomes main's head (the T used) and `mainSeenSeq` moves.

Undo: restore an earlier branch version.

**Review**:
- `requestReview` takes reviewers and a description. The state becomes `in-review`, and the reviewers are notified: a notification of kind `branch_review_request`, in-app (§12 of docs/multiplayer.md; email not built).
- A reviewer answers `approved` or `changes-suggested` with a comment. The review's state is the latest verdict, and the author is notified.
- `Request another review` reopens the review with the verdicts reset to pending.
- Branch comments live on the branch file as any file's (§10 of docs/multiplayer.md) and never merge.

**Merge** (`previewMerge` → `merge`):
1. Flush both sides. For a shared main, its link must be **live and caught up**, with nothing pending, else `offline`.
2. Merge with direction `merge` and all conflicts resolved (none left in `unresolved`, else `invalid`).
3. If either head moved since the preview → `stale` (the UI previews again).
4. Make the pre-merge checkpoint: an autosave version on main.
5. Append the batch to main as **one batch `kind: "merge"`**. For a shared main this is one room frame, sent by the merging person's store; every other client receives it as remote changes.
6. Make main's version **`kind: "merge"`**, titled by the merger's name field (default "‹branch›"), with their description ("Branch merged" when untitled).
7. The branch gets version "merge", `status: "merged"`, `mergedAt` / `mergedBy` / `mergeVersionId`, and is archived.

Undo: restore main's pre-merge version (Figma).

**Archive / restore**:
- `archive` sets `status: "archived"`: hidden from Active, read-only. People who can edit main may do it, and so may the branch's creator (theirs, in the Yours tab).
- `restore` sets an archived (not merged) branch back to `active`. A merged branch can't be restored (`invalid`); Duplicate it instead.
- Deleting a branch is Delete forever of an archived branch's file (`branch_delete`).

**Elsewhere**:
- Publishing a library from a branch is refused (`draft-cannot-publish`'s sibling `branch-cannot-publish`, new StoreErrorCode).
- Copying from a branch sets `Message.pasteBranchSourceFileKey` (docs/schema.md §15) so a paste into main can tell (round 2b decides the use).

### 15.6 Types: `src/shared/merge/` and the `branches` repository

```ts
// src/shared/merge/types.ts
import type { GUID, Message } from "../schema/document.generated";
import type { NodeTable } from "../schema/patch";

export const ABSENT: unique symbol = Symbol("absent");
export type Value = unknown | typeof ABSENT;

export interface FieldChange { field: string; before: Value; after: Value }
export interface ItemChange { field: string; itemKey: string; before: Value; after: Value } // keyed fields (§15.3)
export interface NodeDelta {
  key: string;                       // "s:l"
  guid: GUID;
  phase: "created" | "removed" | "updated";
  fields: FieldChange[];             // updated: changed whole fields; created: every field
  items: ItemChange[];               // updated: changed items of keyed fields
}
export interface TableDiff { deltas: Map<string, NodeDelta> }

export type Side = "main" | "branch";
export type ConflictKind = "field" | "keyed" | "delete-edit" | "move" | "cycle";
export interface Conflict {
  id: string;                        // "<guid>|<field>[|<itemKey>]" — stable across previews
  kind: ConflictKind;
  guid: string;
  field: string | null;
  itemKey: string | null;
  base: Value; main: Value; branch: Value;
  /** For delete-edit: which side removed it */
  removedOn: Side | null;
  chunk: number;
}
/** Figma's DiffChunk (figma-schema-106.kiwi), with GUIDs as "s:l" strings and our conflicts */
export interface DiffChunk {
  index: number;
  displayNode: string;
  displayName: string;
  displayType: string;               // NodeType name
  phase: "CREATED" | "REMOVED" | null;
  canvasId: string;
  canvasName: string;
  canvasIsInternal: boolean;
  /** Indices into MergeResult.batch.nodeChanges */
  nodeChanges: number[];
  chunksAffectingThisChunk: number[];
  parentHierarchyGuids: string[];
  /** Which sides changed something in it */
  changedOn: Side[];
  conflicts: string[];
}
export type Resolutions = Record<string /* Conflict.id, or "chunk:<index>", or "*" */, Side>;
export interface MergeInput {
  base: NodeTable;
  main: NodeTable;
  branch: NodeTable;
  direction: "merge" | "update";
  resolutions?: Resolutions;
}
export interface MergeResult {
  direction: "merge" | "update";
  /** NODE_CHANGES to apply to the target head (main on merge, the branch on update); empty when nothing changes */
  batch: Message;
  chunks: DiffChunk[];
  conflicts: Conflict[];
  /** Conflict ids still without a side; non-empty → the batch must not be written */
  unresolved: string[];
  stats: { created: number; removed: number; updated: number; reKeyed: number };
}

// src/shared/merge/index.ts
export declare function diff(a: NodeTable, b: NodeTable): TableDiff;
export declare function merge3(input: MergeInput): MergeResult;
/** The chunk a node belongs to in a table (§15.4 grouping) */
export declare function displayNodeOf(table: NodeTable, guidKey: string): string;
```

```ts
// src/shared/store/repositories.ts (additions, round 2a) — StoreApi gains `branches: BranchesRepository`, topic "branches"
export type BranchEvent =
  | { type: "branch.updated"; branch: BranchRecord }
  | { type: "branch.main-changed"; branchFileKey: FileKey; mainHeadSeq: number }
  | { type: "branch.merged"; branch: BranchRecord };

export interface MergePreview {
  previewId: string;                 // valid ~10 minutes, one per branch and direction
  direction: "merge" | "update";
  mainHeadSeq: number;
  branchHeadSeq: number;
  chunks: DiffChunk[];
  conflicts: Conflict[];
  unresolved: string[];
  stats: MergeResult["stats"];
}

export interface BranchesRepository {
  create(mainFileKey: FileKey, name: string): Promise<BranchRecord>;
  /** "Active" | "Archived" (archived + merged) | "Yours" (created by the user, any status) */
  list(mainFileKey: FileKey, tab: "active" | "archived" | "yours"): Promise<BranchRecord[]>;
  get(branchFileKey: FileKey): Promise<BranchRecord | null>;
  rename(branchFileKey: FileKey, name: string): Promise<BranchRecord>;
  archive(branchFileKey: FileKey): Promise<BranchRecord>;
  restore(branchFileKey: FileKey): Promise<BranchRecord>;
  /** Main's head vs the base: whether to show the notice */
  mainStatus(branchFileKey: FileKey): Promise<{ changed: boolean; mainHeadSeq: number; baseSeq: number }>;
  preview(branchFileKey: FileKey, direction: "merge" | "update", resolutions?: Resolutions): Promise<MergePreview>;
  /** A side of a preview opened read-only for Compare changes' views (side by side / overlay): base, main, branch or
   *  the merged result */
  openSide(previewId: string, side: "base" | "main" | "branch" | "merged"): Promise<OpenedFile>;
  applyUpdate(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions }): Promise<BranchRecord>;
  merge(branchFileKey: FileKey, input: { previewId: string; resolutions: Resolutions; title?: string; description?: string }): Promise<{ branch: BranchRecord; version: VersionRecord }>;
  requestReview(branchFileKey: FileKey, input: { reviewerIds: string[]; description: string }): Promise<BranchReview>;
  answerReview(branchFileKey: FileKey, input: { verdict: "approved" | "changes-suggested"; comment?: string }): Promise<BranchReview>;
  watch(listener: (e: BranchEvent) => void): Unsubscribe;
}
```

- **Errors**: `stale` (new StoreErrorCode: a head moved since the preview), `invalid` (unresolved conflicts, branch of a branch, restoring a merged branch), `forbidden` (seat, viewers can't copy, can't edit main to merge), `offline`, `branch-cannot-publish`.
- **Where the code goes** (round 2a):
  - `src/shared/merge/`: `diff.ts`, `merge3.ts`, `chunks.ts`, `types.ts`, `index.ts`; pure, no Node or DOM.
  - `src/store/branches/`: the service over `FileStore` and `MultiplayerService`, the previews cache, `branch.json` / `base.kiwi`, GUID blocks.
- **Memory**: one merge holds three `NodeTable`s. The owner's 32k-layer file is about 3 × its table, which is fine in the store process; never in a view.

### 15.7 Shared files (rooms) and the server

A branch of a shared main is itself shared: its own `FileRoom` and its own D1 `files` row (same org, team and folder as main). The room's role check goes through main: §15.1's "anyone with access to main can open its branches" is `resolveAccess(main)`. A grant on the branch also writes a grant on main (Figma: inviting to a branch gives main) and logs `branch_member_add`. Migration **`server/migrations/0011_branches.sql`** (round 2c, the text below):

```sql
-- Branches (docs/data.md §15): a branch is a file whose repo's main file is main_key.
CREATE TABLE branches (
  key             TEXT PRIMARY KEY REFERENCES files (key) ON DELETE CASCADE,
  main_key        TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      INTEGER NOT NULL,
  -- the main room's seq the branch's base is (moves on "Update from main")
  base_seq        INTEGER NOT NULL,
  main_seen_seq   INTEGER NOT NULL,
  -- first session id of the branch room's block (§15.2)
  session_base    INTEGER NOT NULL,
  archived_at     INTEGER,
  archived_by     TEXT REFERENCES users (id),
  merged_at       INTEGER,
  merged_by       TEXT REFERENCES users (id),
  merge_version   TEXT
);
CREATE INDEX branches_main ON branches (main_key, status);

CREATE TABLE branch_reviews (
  id           TEXT PRIMARY KEY,
  branch_key   TEXT NOT NULL REFERENCES branches (key) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users (id),
  description  TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'in-review' CHECK (state IN ('in-review', 'approved', 'changes-suggested', 'closed')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX branch_reviews_branch ON branch_reviews (branch_key, created_at);

CREATE TABLE branch_reviewers (
  review_id TEXT NOT NULL REFERENCES branch_reviews (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verdict   TEXT NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'approved', 'changes-suggested')),
  comment   TEXT NOT NULL DEFAULT '',
  at        INTEGER,
  PRIMARY KEY (review_id, user_id)
);
```

| Route | Who | Request → Response |
|---|---|---|
| `POST /files/:key/branches` | can view main (+ copy allowed), Full seat in an org | `{branchKey, name, baseSeq}` → `{branch: BranchRow, sessionBase}`; then the client uploads the branch snapshot (`PUT /files/:branchKey/snapshot?seq=0`) and the base (`PUT /files/:branchKey/base?seq=<baseSeq>`, chunks like snapshots) |
| `GET /files/:key/branches?tab=active\|archived\|yours` | can view main | `{branches: BranchRow[]}` |
| `PATCH /branches/:key` | can edit main, or the creator | `{name?, status?: "archived" \| "active"}` → `{branch}` |
| `GET /branches/:key/base` · `PUT …/base?seq=` | can view / can edit the branch | the base snapshot (Update from main replaces it) |
| `POST /branches/:key/updated` | can edit the branch | `{baseSeq, mainSeenSeq}` → `{branch}` (after the update's frame is acknowledged) |
| `POST /branches/:key/merged` | can edit main | `{mainSeq, versionId}` → `{branch}` (after the merge frame is acknowledged; logs `repo_merge_to_source`, notifies the creator and reviewers) |
| `POST /branches/:key/reviews` | can view the branch | `{reviewerIds, description}` → `{review}` |
| `POST /branches/:key/reviews/:id/verdict` | a reviewer | `{verdict, comment?}` → `{review}` |

- **Room versions** (round 2c; Figma's history for shared files):
  - The room writes a version snapshot every 30 minutes of edits, and on name, publish and merge.
  - Kept in the room's storage as chunks with a `versions` table there.
  - `GET /files/:key/versions`, `POST /files/:key/versions {kind, title?, description?, seq}`.

  The store's `FileRepository.listVersions` etc. read them for shared files. Kinds are the same as §6 plus §15.2's.
- **The merge frame is computed by the client**: the room never decodes kiwi (§4 of docs/multiplayer.md). The room checks only that the sender can edit main.
- **Comments**: a branch room's comments are the branch file's; Figma doesn't merge them.

#### 15.7.1 As built — round 2c, the server (2026-10-11)

Files: `server/migrations/0011_branches.sql` (the text above, verbatim), `server/src/branches.ts` (routes), `server/src/branchAccess.ts` (who someone is to a branch), `server/src/roomBox.ts` (the room's storage, out of `fileRoom.ts`), `server/src/fileRoom.ts` (sockets + alarm only), tests `server/src/branches.test.ts` (5) over `server/src/testing/memoryRooms.ts` (the real `RoomBox` + `Room` per key on node:sqlite). No wrangler Durable Object migration: the new room tables are created on start and `alarm()` needs none.

**Routes and payloads** (for the store's client; `branches.ts` header has the full list):

| Route | Who | Request → Response |
|---|---|---|
| `POST /files/:main/branches` | can view main + `canExport` (viewers can copy), Full seat in an org | `{branchKey, name, baseSeq}` → 201 `{branch, sessionBase, mainVersionId}`; then `PUT /files/:branchKey/snapshot?seq=0` (the room makes "Branch created" from it, `versionId` in the answer) and `PUT /branches/:branchKey/base?seq=<baseSeq>` |
| `GET /files/:main/branches?tab=active\|archived\|yours` | can view main | `{branches}`; 400 on a branch |
| `GET /files/:key/versions` · `POST` | view · edit | `{versions}` newest first · `{kind: autosave\|named\|restore\|publish\|import, title?, description?, seq?, restoredFrom?, libraryVersion?}` → 201 `{version}` (restore = the client sends its restore frame, then posts `kind: "restore", restoredFrom`); `branch` / `update` / `merge` only by the branch routes (400); `publish` on a branch → 400 `branch_cannot_publish` |
| `GET /files/:key/versions/:id` · `PATCH` | view · edit | `{version}` · `{title?, description?}` → `{version}` (an autosave given a title becomes `named`) |
| `GET /files/:key/versions/:id/snapshot` · `…/frames` | view | the snapshot the version starts from (`x-seq` = the version's seq, `x-snapshot-seq`) · the frames after it up to `x-seq`, as `GET /room/frames` (`[u32 length][changes-down frame]…`) — the document at the version = snapshot + frames |
| `PUT /files/:key/versions/:id/snapshot` | edit | the client's snapshot of the document at the version's seq → `{version}` (its frames are then dropped; history nobody needs is collected) |
| `GET /branches/:key` · `PATCH` · `DELETE` | view · edit main or creator · same | `{branch}` · `{name?, status?: "archived"\|"active"}` → `{branch}` (merged → active: 400) · 204, an archived / merged branch only (409 when active) |
| `GET /branches/:key/main` · `POST …/seen` | view | `{changed, mainHeadSeq, baseSeq, mainSeenSeq}` (`changed` = main's head > base) · `{mainSeq}` → `{branch}` (`main_seen_seq` only grows) |
| `GET /branches/:key/base` · `PUT …/base?seq=` | view · edit the branch | bytes (`x-seq`) · the first PUT is the base; later ones are **staged** until the update that absorbs them |
| `POST /branches/:key/update` | edit the branch | envelope `{mainSeq, branchSeq, sessionID?, batch?}` + batch → `{branch, seq, versionId}` |
| `POST /branches/:key/merge` | edit main | envelope `{mainSeq, branchSeq, title?, description?, sessionID?, batch?}` + batch → `{branch, mainSeq, versionId, preVersionId, branchVersionId}` |
| `GET /branches/:key/reviews` · `POST` | view the branch | `{reviews}` newest first · `{reviewerIds, description}` → 201 `{review}` (reviewers must be able to open the branch, else 400) |
| `POST /branches/:key/reviews/:id/verdict` | a reviewer of that review | `{verdict: "approved"\|"changes-suggested", comment?}` → `{review}` |

- `branch` is `BranchRecord` with the room's fields: `{branchKey, mainKey, name, status, createdBy: {id, name}, createdAt, baseSeq, mainSeenSeq, sessionBase, archivedAt, archivedBy, mergedAt, mergedBy, mergeVersionId, review}`; the store maps `mainKey` / `branchKey` to its file keys and `base.mainSeq` = `baseSeq` (`mainVersionId` is in the create answer only). `review` is the latest `{id, state, requestedBy, description, createdAt, updatedAt, reviewers: [{userId, name, verdict, comment, at}]}`.
- `version`: `{id, kind, title, description, createdAt, seq, snapshotSeq, sizeBytes, restoredFrom, libraryVersion, user: {id, name}}` (`user.id` null for the room's own autosaves). Ids are `VersionId`s (16 base62).
- **The envelope** (`roomBox.ts encodeEnvelope`): `[u32 BE JSON length][JSON, UTF-8][kiwi Message]` — the merge core's batch as a `changes-up` frame would carry it; an empty batch is allowed (only the version is made). `sessionID` / `batch`: the sender's session in the target room when its store is connected there — the frame then comes back as its own (an acknowledgement); otherwise the frame has session 0 and every client, the sender's too, applies it as remote.
- **`GET /files/:key`** adds `branch: {mainKey, mainName, name, status} | null`.
- Errors: `{error, code}` as §14.15; new codes **`stale`** (409: a head moved since the preview — `mainHeadSeq` or `lastSeq` in the body) and **`branch_cannot_publish`**; `seat_required` (`seat: "full"`) for branching on a lesser seat.

**Choices and deviations:**
- **Merge and update go through the Worker** (`POST /branches/:key/merge|update`) instead of a socket frame followed by `…/merged` / `…/updated` (the table above): the target room appends the batch with the next seq, stores it and sends it to every member like any frame (`POST /room/apply`), but only if its head is still the `expectSeq` the merge read — the check and the append are one step of the Durable Object, so `stale` is exact. Merge: the branch room is **frozen** at `branchSeq` first (`/room/freeze`, `stale` if it moved; frames sent to it afterwards are refused and the socket closed 4003), then main takes the pre-merge **autosave**, the frame and the **`merge`** version (title = the given title or the branch's name; description as given) in one transaction; a stale main thaws the branch. Then the branch gets its `merge` version, `status: merged` (+ `archived_at`), `merge_version`, its people are reauthorized (read-only), and the creator and reviewers are told (`branch_merged`). Update: main's head must equal `mainSeq` (checked, not locked: a later main edit is simply after the new base), the base staged at `mainSeq` (409 `base_missing` otherwise) becomes the base in the same transaction as the frame, then the branch's `update` version; D1 `base_seq` and `main_seen_seq` move.
- **Access** (`branchAccess.ts`, used by `Access.file` in `org/db.ts`): a branch resolves through main's rows; its **creator edits it** (a viewer of main who may copy works in their own branch; Figma lets them branch) but shares / manages only as main allows; `archived` / `merged` → `canEdit` false, room role `viewer`. A branch's `files` row is owned by its creator, in main's org / team / folder, and is left out of every listing (`accessibleFiles`, `GET /files`) — 2d shows branches under main. Link passwords: a branch's own row has none, so someone in main by a password-protected link alone can't open its branches (unbuilt: passes for main checked on branches).
- **Inviting to a branch** (`PUT /files/:branch/members`): written on main (raised to the new role if lower) and on the branch, `branch_member_add` / `_permission_change`; in an org only for people already in the org or on main (others through main's Share: guest rules). `DELETE` removes the branch's row only (`branch_member_remove`); access stays main's.
- **Session blocks**: `POST /room/session-block` on main (counter += 65536, the old value returned as `sessionBase`), `POST /room/init-branch {sessionBase}` on the new branch room (refused once it holds a document). A branch running out of its block is not handled (65,536 sessions).
- **Room versions** (`roomBox.ts`): a version = a snapshot at `snapshot_seq` + the frames up to `seq` (the room never encodes kiwi). Snapshots and frames are kept once in `history_snapshots` / `history_frames` and shared by the versions that need them; `PUT …/versions/:id/snapshot` lets the client compact one. Autosave: the first edit starts a 30-minute clock (any version restarts it); an edit past it sets the object's alarm 2 s out (pushed back by later edits, at most 60 s after it fell due); the alarm takes an `autosave` if frames came since the last version. Unlimited history: nothing is thinned (the store's §6 retention is local only). "On name / publish" are the client's `POST …/versions` (`named`, `publish`); "on merge" is the merge route's.
- **Notifications** (server-side kinds, as `OrgNotificationKind`): `branch_review_request` (each reviewer; `text` the description, `state` pending → the verdict when answered), `branch_review` (the asker; `state` = `approved` | `changes-suggested`, `text` the comment), `branch_merged` (creator and reviewers, not the merger) — `src/shared/notifications.ts` doesn't list them yet.
- **Activity** (org files only): `branch_create`, `branch_archive`, `branch_unarchive`, `branch_delete`, `branch_member_add` / `_permission_change` / `_remove`, `repo_merge_to_source` (merge), `repo_merge_from_source` (update), entity `file_repo {id: main key, name: main's name, main_file_key}`, details `{branch_key, branch_name, …}`.
- **Deleting**: `DELETE /branches/:key` (archived / merged) deletes the branch's room and rows; deleting a main file for good deletes its branches first.
- Not built: review state `closed` is never set (a merge leaves the last verdict); "Request another review" reuses the open review (verdicts reset, reviewers replaced); folder file counts (`fileCount`) and the room reauth lists still count branch rows; moving main to another folder leaves its branches' rows where they were (access is main's anyway); no thinning or size cap of room history; `fig_file_view` is logged for branch sockets as for files.

### 15.8 Test corpus (round 2a: `src/shared/merge/*.test.ts`, `src/store/branches/*.test.ts`)

Each case builds B, then O and T by applying change Messages, runs `merge3` in both directions and checks the batch, the chunks and the conflicts:

1. Nothing changed (B = O = T) → empty batch, no chunks.
2. Only one side changed → the batch equals that side's diff; with `T == B`, the merged result equals O.
3. Different nodes on each side → clean.
4. Different fields of one node → clean, both kept.
5. Same field, same value → clean, no write.
6. Same field, different values → one `field` conflict. Pick main / pick branch / "chunk:i" / "*" each give the expected M.
7. `textData` edited on both sides → `field` conflict (no character merge).
8. Main edits a child, the branch deletes its top-level frame → `delete-edit` on the frame's chunk. Both resolutions, including bringing back removed ancestors.
9. Created on one side under a node removed on the other → `delete-edit`.
10. Removed on both sides → clean.
11. Moved to different parents → `move` conflict. The same parent with different positions → incoming position, no conflict. Swapping A into B and B into A → `cycle`.
12. Siblings inserted at the same position → re-keyed, order deterministic.
13. Instance overrides: different guidPaths on one instance → clean, one merged `symbolData`. The same guidPath and field → `keyed` conflict.
14. `componentPropAssignments`, `componentPropDefs`, `parameterConsumptionMap`, `prototypeInteractions` per key.
15. Variables:
    - values in different modes → clean; the same mode → `keyed`;
    - a mode added on one side and a variable added on the other → valid M;
    - a collection removed vs a variable edited → `delete-edit`;
    - an extended collection's override vs the parent's value.
16. Styles: one style edited on both sides; a style removed on main while the branch applies it (`styleIdFor*`) → `delete-edit`.
17. Components: a main component edited on both sides; a variant added on one side while the set is renamed on the other → clean.
18. Library copies: main at library version 5, the branch at 4 → 5's subtree, no conflict. Enabled libraries merged per key.
19. Local asset bookkeeping is kept from main; a branch can't publish.
20. Pages: added on both sides, reordered, renamed vs deleted.
21. Images: a branch-only image travels with the batch (`blobRefsAdded`); blob fields compare by bytes across tables.
22. Type conversion on one side vs an edit on the other.
23. `clearedFields` and `@default` values: a field cleared on one side vs set to its default on the other → convergent.
24. `@derived` never in the batch.
25. Update then merge: a conflict resolved during the update doesn't reappear at the merge.
26. A stale preview → `stale`.
27. GUID blocks: new nodes on main and on the branch after the split never collide (store test).
28. Shared main (store against the real handler and room on node:sqlite): create, edit both, update, merge as one frame received by a third client, versions on both.
29. **The owner's 32k-layer file**: a branch with 500 edits across 50 frames merges in under 2 s in the store process, its memory bounded by three tables (a bench, not in `npm run check`).

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
