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
| Org libraries (contract, Phase 7 round 3) | A library published from an org file lives on the server under its room key: metadata in D1, bytes in one `LibraryObject` Durable Object per library. Scope team or org (= the file's "Anyone at ‹org›" link), approved / enabled by default per org, workspace and team and per editor type, default modes per workspace and team, subscriptions per file on the server, update notices through the Inbox. The store routes `LibraryRegistry` by key: local libraries are §9, unchanged (§16). Library analytics: client-aggregated insert / detach counts and per-file instance snapshots, rolled up daily by a Cron Trigger (§17). |
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

## 16. Libraries in organizations (contract, Phase 7 round 3; written 2026-10-11)

**Status: contract, not built.** Libraries published from org files live on the server, so every member of their audience can enable them, get their updates, and see their use. Local libraries (§9) keep working exactly as today. Research: `docs/research/figma/R18-enterprise.md` C-1, D-3, D-4, D-5. The plan: `docs/roadmap.md` Phase 7 round 3. The organization model this builds on: `docs/multiplayer.md` §14.

Figma's facts below were read on help.figma.com and developers.figma.com on 2026-10-11:
- **[L-org]** Share libraries in an organization — https://help.figma.com/hc/en-us/articles/360040529593
- **[L-find]** Help people find and use libraries (approve, enable by default, default variable modes) — https://help.figma.com/hc/en-us/articles/21310245473815
- **[L-guide]** Guide to managing an organization (libraries, fonts, approved lists) — https://help.figma.com/hc/en-us/articles/360052679454
- **[L-ext]** Extend a variable collection — https://help.figma.com/hc/en-us/articles/36346281624471 ; What's new from Schema 2025 — https://help.figma.com/hc/en-us/articles/35794667554839
- **[L-api-ext]** Plugin API `ExtendedVariableCollection` — https://developers.figma.com/docs/plugins/api/ExtendedVariableCollection/ ; Update 121 (2025-11-20) — https://developers.figma.com/docs/plugins/updates/2025/11/20/version-1-update-121
- **[L-log]** Activity log action types — https://developers.figma.com/docs/rest-api/activity-logs-action-types/
- Cloudflare's limits (read the same day): Workers https://developers.cloudflare.com/workers/platform/limits/ , D1 https://developers.cloudflare.com/d1/platform/limits/ and /pricing/ , Durable Objects https://developers.cloudflare.com/durable-objects/platform/limits/ , R2 https://developers.cloudflare.com/r2/pricing/

**(unverified)** marks a rule we could not find stated by Figma; the choice made there is ours and says so.

### 16.1 What Figma does (the behaviour to match)

**Publishing and audience** [L-org]:
- Libraries are on Organization and Enterprise. Anyone with "can edit" on a file can publish it. Drafts can't publish (§9.3, unchanged).
- Three levels of reach:
  1. **File**: "Anyone with access to the published file can use the library" — guests included, which is how guests get a library: "invite them to the original file".
  2. **Team**: "Only direct team members can access the styles and components." People who reach only some of the team's folders or files don't, unless the file is shared with the organization.
  3. **Organization**: the Publish dialog's checkbox **"Allow any member of ‹organization› to access the file"**. It sets the file's link sharing to **"Anyone at ‹organization›"**. For a published library, setting that link access does the same; setting it back to "Only people invited to this file" removes org access and keeps the team.
- Each publish adds a version history checkpoint. The Libraries button's tooltip reads **"Review library updates"** when libraries used in the file have updates, and **"Review unpublished changes"** when the file has unpublished edits.
- **Unpublish**: the Libraries modal › the library › **Unpublish** › **"Remove file from library"**. It removes the library for everyone; styles stay in files and stop receiving updates.

**Approved libraries** [L-find] (Organization and Enterprise; org admins and workspace admins):
- An approved library shows a **check mark** next to its name in files, in the Assets panel, in quick insert and in Admin, and is **pinned to the top** of the list.
- Org admins: Admin › **Resources** › the library › **Manage this library** › **"Set as approved library"**. Workspace admins: Admin › ‹workspace› › **Libraries** › the same modal and toggle.
- A workspace-approved library shows the check mark in all of that workspace's files, even for people not assigned to the workspace. Draft files show it only for the workspace the person is assigned to.
- A workspace admin can't unapprove a library approved for the organization.

**Enabled by default** [L-find, L-org]:
- Per file type: **Design files**, **FigJam boards**, **Slide decks**, **Figma Buzz files**. The team settings offer **All files** or **Design files** (and FigJam in the older article).
- **Org admins**: any published library for every file of the organization. If the library isn't shared with the whole organization, a warning says enabling it by default publishes it to the organization and changes the file's permissions.
- **Workspace** (Enterprise): org admins and workspace admins, for a workspace's files.
- **Team admins**: any org-shared library, including other teams', for the teams they manage (team › ⌄ › **View settings** › **Shared** › **"View team's libraries"**).
- Lower-level admins can override the defaults for the workspaces or teams they manage. Higher-level admins get an in-app notification when an approved library is overridden.
- The setting doesn't touch anyone's manual access; to remove access, unpublish. Turning a default off: Admin › Resources › Libraries › **Off**; team admins can still enable it, members can still add it by hand.

**Default variable modes** (Enterprise) [L-find]:
- The library must hold a collection with at least two modes, published.
- Team: "View team's libraries" › the library › **Enabled by default** (All files / Design files) › the **Default mode** column. Workspace: Admin › Resources › Libraries (org admins) or Admin › ‹workspace› › Libraries › **Manage this library** › the workspace › **"Enable this library by default"** › Design files › **"Manage default modes"**.
- "People can switch to another mode whenever they need to."

**Extended collections** (Enterprise, Full seats) [L-ext, L-api-ext]:
- Anyone with "can edit" on a file can **Extend collection**. The extension inherits every mode and variable (names, settings, order) and keeps getting the parent's changes "to any variables that have not been explicitly overridden".
- Only **values** can be overridden (blue cells; **Reset change**). No new variables or modes, no description or scope changes ("open the parent collection"). Colour value and opacity override together.
- Library collections can be extended (Plugin API `extendLibraryCollectionByKeyAsync`, Update 121). Extensions chain: `rootVariableCollectionId` is documented with "if Collection C extends B which extends A (root)". An extension can remove a mode only when the parent's mode was deleted.
- After a parent publishes and a consumer accepts, "previously set variable modes" are removed from designs and must be reapplied through the extension (migration flow: export a brand mode, delete it, extend, **Import mode**; on main, not a branch).
- **Mode limits**: Professional 10 and Organization 20 per collection [L-ext Schema 2025]; Enterprise "Unlimited (via extended collections)" (pricing table, R18 D-5). Enterprise's per-collection number is not published (unverified).

**Activity log** [L-log]: `org_library_approve`, `org_library_unapprove`, `org_library_setting_change`, `workspace_library_approve`, `workspace_library_unapprove`, `workspace_library_setting_change`. Figma publishes **no** action for publishing a library or for fonts; we log none either.

### 16.2 Decisions

| Topic | Decision |
|---|---|
| Identity | An org library's key is its file's **room key** (`files.key`, `FileSpace.key`). It is the same on every computer, so copies' `sourceLibraryKey` means the same library for everyone. A local library's key stays its `FileKey` (22 base62, §1). Room keys contain `_` (`roomKeyFor`), so the two never collide: `isLocalLibraryKey`. |
| Where it lives | **D1** holds the metadata: library rows, versions, the current asset list (names for analytics), settings, subscriptions. One Durable Object **`LibraryObject` per library** holds the bytes: version manifests, asset payloads, thumbnails and the images payloads use, in SQLite 1 MB chunks. `server/src/previewObject.ts` is the template. |
| Why not D1 for bytes | The free plan caps one D1 database at **500 MB**, shared with everything else, and a row at 2 MB. A design system with images would eat it. |
| Why not R2 | R2's free tier (10 GB) is roomy, but it is a separate product to enable on the account (unverified: whether it needs a payment method on file), a new binding and a new failure mode. Durable Objects are already used three times. The free plan gives Durable Objects **5 GB per account** across all objects (the per-object figure on the free plan is 1 GB or 10 GB — Cloudflare's page contradicts itself); a few libraries of tens of MB fit. If storage ever binds, payloads move to R2 behind `LibraryObject`'s routes: nothing outside it changes. |
| Atomicity | A publish uploads missing payloads and blobs first (content-addressed, idempotent), then one **commit** call to the object writes manifest *n* in one SQLite transaction, refusing a stale `baseVersion`. D1 is written after it, idempotently. |
| Who sees a library | §16.4: the file's own access, or team membership, or org membership when the library is published to the org. Guests only through the file. |
| Scope | `team` or `org`, Figma's two. **Workspace is not a publishing scope** at Figma (not found in [L-org], [L-find]); workspaces approve and enable by default (§16.5). |
| Org scope = link access | As Figma: scope `org` ⇔ the file's `org_link_access` is not `none`. Publishing with "Allow any member…" sets `org_link_access = 'viewer'` when it was `none`; changing the link to `none` drops the library to `team`. The two are kept equal by one function, `syncLibraryScope`. |
| Subscriptions | Which files enable which library is on the server (`library_subscriptions`), so everyone opening an org file sees the same enabled libraries. A row exists only for an explicit choice; otherwise the defaults decide (§16.5). |
| Update notices | The person's **Inbox** (multiplayer.md §12) carries `{t: "library", libraryKey, version}`; the store turns it into today's `LibraryEvent {type: "published"}`. No bell row: Figma's bell has no library-update kind that we found (unverified), the Libraries button's badge and toast are the notice. |
| Local libraries | Untouched: §9's registry on disk, `Workspace.defaultLibraries`, `FileMeta.enabledLibraries` of local files. |
| Local files and org libraries | Figma's rule: org libraries are offered only in files of that org (drafts in the org included). A local file never lists them. Exception (ours): a local file already holding copies of a library whose file moved into an org keeps receiving its updates (§16.9). |
| Mode cap | The hard 40-mode cap per collection becomes a soft guard of **1,000** modes; extensions are unlimited in number and chain depth ≤ **16** (ours, a guard against cycles and runaway resolution). §16.8. |
| Free-plan limits | Every route is ≤ 6 D1 queries (the free plan allows 50 per invocation), bulk writes use one statement over `json_each(?)` (100 bound parameters at most per query), big work runs in the Durable Object (30 s CPU), the Worker stays under 10 ms CPU. |

### 16.3 Records and the store

```ts
// src/shared/libraries/orgTypes.ts (committed verbatim before round 3) — the whole file is in §16.12.
// The essentials, for reading this section:
export type LibraryKey = string;                    // room key (org) or FileKey (local)
export type LibraryScope = "team" | "org";
export type LibraryEditorType = "design" | "figjam" | "slides" | "buzz";
export type SettingScope = { type: "org" | "workspace" | "team"; id: string };
export interface OrgLibraryRecord extends LibraryRecord { org: OrgLibraryContext }   // what listAvailable / getRecord return for org libraries
```

- **The store routes by key.** `src/store/libraries/router.ts` implements today's `LibraryRegistry` over two registries: `LocalLibraries` (§9, unchanged) for local keys and `OrgLibraries` (new, `src/store/libraries/org.ts`) for room keys. A call with a `fileKey` (`listAvailable(forFileKey)`, `setEnabled(fileKey, …)`) goes by that file: an org copy (`FileMeta.space` set) → the org registry, else local. A call with a `libraryFileKey` goes by the key's form. **The interface does not change.**
- **What the editor changes**: one rule, `libraryKeyOfFile(meta)` (= `meta.space?.key ?? meta.fileKey`), wherever it names "this file's library" (Publish, the Libraries modal's "Current file", `markPublished`, the manifest checks of §9.1). Everything else already treats the key as opaque.
- **`OrgLibraries` methods**, over §16.10's routes:

  | `LibraryRegistry` method | Org behaviour |
  |---|---|
  | `listAvailable(forFileKey)` | `GET /libraries?file=<roomKey>` → `OrgLibraryRecord[]` relative to that file (approved, default, default modes). Cached per org file (`Workspace/spaces/library-lists/<orgId>.json` / `designer.devStore.v1.libs.<orgId>`) for offline. |
  | `getRecord(key)` | `GET /libraries/:key` (cached) |
  | `getVersion(key, n?)` | `GET /libraries/:key/versions/:n\|latest`; manifests are immutable and cached on disk forever (`Workspace/spaces/libraries/<key>/versions/<n>.json`) |
  | `previewPublish(key, assets)` | computed **in the store** with `libraryRules.previewAgainst` against the latest manifest (fetched or cached); no server write |
  | `publish(req)` | §16.6: `missing` → `PUT` payloads / blobs → `POST versions` (with `baseVersion`, `scope`, and the collections' modes the store reads from the VARIABLE_COLLECTION payloads). On `conflict` (someone published meanwhile) the store fails with StoreErrorCode `conflict`; the editor re-runs the preview. |
  | `unpublish(key)` | `POST /libraries/:key/unpublish` |
  | `setEnabled(fileKey, key, on)` | `PUT /files/:roomKey/libraries/:key {enabled}`; the copy's `FileMeta.enabledLibraries` is rewritten from the answer's effective list (the field keeps meaning "enabled in this file") |
  | `getPayloads(key, wants, opts)` | local cache `Workspace/spaces/libraries/<key>/assets/<assetKey>/<hash>.kiwi` first; the rest from `POST /libraries/:key/payloads` (one binary answer), images through `GET /libraries/:key/blobs/:sha1` into the local `BlobStore` before the payload is returned |
  | `diff(key, have)` | `POST /libraries/:key/diff` online; offline from the cached latest manifest with `libraryRules.diffAgainst` |
  | `watch` | the Inbox notice `{t: "library", libraryKey, version}` and `{t: "library", libraryKey, status}` → `LibraryEvent` |

- **New store repositories** (`StoreApi` additions; interfaces in `orgTypes.ts`): `orgLibraries: OrgLibrariesRepository` (Admin, team settings, Home's org Libraries page) and `analytics: LibraryAnalyticsRepository` (§17). The event topics `library` (existing) and `fonts` (new, docs/desktop.md §14.3) are fed from the Inbox.
- **Errors**: StoreErrorCode `conflict` (stale publish), `forbidden` with detail `{code}` (`seat_required`, `not_admin`, `branch_cannot_publish`, `draft_cannot_publish`), `offline` (publishing, settings), `not-found`.
- **The browser's MemoryStore** gets the same router (org part only through its server client; payload cache in memory).

### 16.4 Who can see and use an org library

`canUseLibrary(access, lib)` in `server/src/libraries/access.ts`, for a caller and a library (status `published`):
1. The caller can **view the library's file** (`resolveAccess(...).role` not null, `viaLink: false`) → yes. Guests reach libraries only this way [L-org].
2. Else the caller is a **direct member of the file's team** (`team_members` with their user id, or through a `group_grants` row on the team) → yes [L-org "direct team members"].
3. Else the library's scope is `org` and the caller is an org **member or admin** (not a guest) → yes.
4. Else no (404 for the routes, as §14.12: "also for what exists but the caller can't see").

`listAvailable(forFile)` additionally requires the library to be in **the same org** as the file, and not the file itself. Trashed library files list nowhere (status `trashed`).

Admin listings use a wider rule [L-find]: org admins see every library of the org, "including ones in closed or secret teams"; workspace admins every library of their workspaces' teams plus org-scope ones; team admins their team's and every org-scope one.

### 16.5 Approved, default, default modes

**Settings rows** (`library_settings`): one per (library, scope) where `scope` is the org, a workspace or a team. Each holds `approved` (org and workspace rows only) and one tri-state per editor type: `1` on, `0` off (an override), `null` inherit.

**Who may write** (`PUT /orgs/:org/libraries/:key/settings`):

| Scope | approved | defaults | default modes |
|---|---|---|---|
| org | org admins | org admins | — (Figma offers workspace and team) |
| workspace | org admins; that workspace's admins (they can't unapprove an org-approved library — it stays approved: §16.5 resolution) | org admins; that workspace's admins | the same |
| team | — | the team's admins and owner; org admins; that team's workspace admins | the same |

- Enabling a default at **org** scope on a library with scope `team` publishes it to the org: the route sets scope `org` and the file's `org_link_access = 'viewer'` (the warning's "changes the file's permissions"), logs `fig_file_link_access_change` too.
- A team admin may make a default only of a library their team can use (§16.4 rule 2 for their own team's, rule 3 for others').

**Resolution for one file** `F` of editor type `E` (team `T`, workspace `W` = `T`'s workspace; a draft: `W` = its owner's workspace, `T` none) and one library `L` the caller can use:
- `approved(F, L)` = `"org"` if the org row approves; else `"workspace"` if `W`'s row approves; else null. (So an org approval can't be undone from a workspace.)
- `defaultOn(F, L)` = the first non-null of `T`'s row[E], `W`'s row[E], the org's row[E]; null → off. Lower levels override higher ones [L-find].
- `enabled(F, L)` = the file's subscription row if any (`on` / `off`), else `defaultOn(F, L)`. **Effective for existing and new files alike**; a member can still remove a default library from one file (an `off` row) and add it back.
- `defaultModes(F, L)` = per collection, `T`'s choice, else `W`'s; none → the collection's own default (its first mode).
- **Override notice**: when a workspace or team row sets `0` (off) for an editor type on a library approved at a higher level, every org admin (workspace override) or the org and workspace admins (team override) get a notification `library_default_override` (wording unverified: "‹person› turned off ‹library› for ‹team›").

**Applying a default mode** (ours: Figma states only the outcome): when the editor first brings a collection of `L` into a file — the first `getPayloads` that creates the collection's copy — and `defaultModes(F, L)` names a mode for it, the editor sets that mode as the explicit mode for the collection on **every page** of the file (`variableModeBySetMap`, docs/schema.md §6.4) in the same undo step as the insertion. People change it afterwards as any explicit mode. Files already holding the collection are not changed when an admin changes the default later.

### 16.6 Publishing from an org file

1. The editor runs §9.3 steps 1–3 unchanged. Its Publish dialog adds Figma's checkbox **"Allow any member of ‹org› to access the file"** (checked when the file's `orgLinkAccess` isn't `none`; disabled for people who can't change the link — `canShare` false).
2. The store's `publish(req)`:
   1. `POST /libraries/:key/missing {payloads: [{key, versionHash}], blobs: [sha1]}` — every payload of the request, every thumbnail sha1 and every image sha1 the payloads use (`messageImageHashes`) → what the object lacks.
   2. `PUT /libraries/:key/payloads/:assetKey/:versionHash` (the snapshot-container bytes of §9.2) and `PUT /libraries/:key/blobs/:sha1` for each missing one. The object checks a blob's SHA-1 and a payload's container magic.
   3. `POST /libraries/:key/versions {baseVersion, description, scope, assets, changes, moves, collections}` → `{version, library}`.
3. The Worker, for step 3: checks the caller can edit the file (`canEdit`), has a Full seat (`seat_required`), the file isn't a draft (`draft_cannot_publish`, §9.3) or a branch (`branch_cannot_publish`, §15); posts the commit to `LibraryObject` (stale `baseVersion` → 409 `conflict`; a payload or blob the manifest names but the object lacks → 400 `invalid` naming it); then in D1: upserts `libraries`, inserts `library_versions`, upserts the changed `library_assets` rows and marks removed ones, writes `library_redirects` for `mode: "move"`; `syncLibraryScope`; asks the file's room for a version `{kind: "publish", title: description, library_version: n}` (the room's version route of §15.7.1, `RoomVersionKind` already has `publish`); then the Inbox notices (§16.7).
4. The store's answer is §9.3's: the editor's `markPublished`, `meta.library` on the local copy, `LibraryEvent published`.

**Unpublish** (`POST /libraries/:key/unpublish`, editors of the file): status `unpublished`, subscriptions kept (publishing again brings them back), notices with `status`. **File trashed / restored / deleted forever** (§14.12's file routes call `libraryFileStatus`): `trashed` / back to `published` / `deleted` — `deleted` drops the object's storage (`deleteAll`) and the subscriptions; the `libraries` row stays so consumers' Libraries modal can say "Missing library" (§9.6). **Moving the file** to another team or folder changes its team (§16.4 rule 2 follows `files.team_id`; nothing to rewrite).

### 16.7 Update notices

- After a commit, the Worker posts `{t: "library", libraryKey, version}` to the Inbox of every person who can use the library (§16.4), computed in one query: the file's members and group members, its team's members, and — scope `org` — the org's members with an account. More than 500 recipients: the rest through `ctx.waitUntil`. Unpublish / trash / restore / delete post `{t: "library", libraryKey, status}`.
- The store's `NotificationsService` forwards these (`onLibrary`), the org registry drops its cached record and manifest pointer, and `libraries.watch` emits `published` / `status`. The editor does what §9.4 already does: `diff` for each enabled library, the blue badge, "Review library updates".
- Settings changes (approve, defaults, default modes, scope) post `{t: "org", what: "libraries", orgId}` to the org's members: their cached `listAvailable` answers are dropped.

### 16.8 Extended collections at org scale, and the mode cap

Round 5 built extended collections (Extend collection, `VARIABLE_OVERRIDE`, publish / consume / local extensions of library collections; docs/schema.md §6.2–6.6). Org scale adds nothing to the document. The rules:
- **An extension of a library collection** is published from its own file as a library of its own. Its payload carries the parent collection and the parent's variables as `dependencyOnly` assets (§9.1), so consumers of the extension need no access to the parent's library.
- **Chains**: an extension may be extended (C extends B extends A [L-api-ext]). Each level is one library; consumers get the whole chain as dependencies. Depth ≤ 16 (ours; the editor refuses "Extend collection" past it with a toast "Can't extend further").
- **Parent updates** reach the extension's file through §16.7 like any library update. Consumers of the extension see them only after the extension's file accepts them and publishes. That is Figma's chain.
- **Restrictions checked in round 3 (R18 D-5)**, each a test in 3c: in an extension the Local variables window disables Create variable, Add mode, rename of variables / modes / groups, Edit description, Scoping, Delete variable, Duplicate; values can be edited (blue) and **Reset change** reverts; colour and opacity are one override; "Remove mode" only for a mode whose parent mode is gone; "Import mode" into an extension writes overrides only, never adds a mode; extending is refused on a branch's file when migrating (Figma recommends main; ours: allowed, with no warning — unverified whether Figma blocks it).
- **Mode cap**: `LIMITS.modes` (editor/model/variables.ts) goes from 40 to a soft guard of **1,000** per collection, with Figma's error wording for the guard ("Limited to 1000 modes only", the Plugin API's form). We are "Enterprise": no plan checks. Figma's Enterprise per-collection number is unverified; its "unlimited" is through extensions, which have no cap in count here. `docs/schema.md` §6.1's "40 modes" line follows.
- **Accepting a parent's update** in a consumer removes nothing here: our explicit modes point at mode ids that survive. Figma's "previously set variable modes are removed" applies to migrating brand modes into extensions (the modes were deleted). Ours behaves the same in that case: an explicit mode whose mode no longer exists falls back to Auto.

### 16.9 Local files, local libraries, and files moving into an org

- **Local libraries are §9**, unchanged: registry on disk, offered to local files only.
- **A local library file moved into an org** (`projects.moveLocalFile`, §14.6) keeps its `FileKey` as the linked copy; from now on it publishes as the org library `space.key`. On its first org publish the store writes `libraries/<fileKey>/moved.json {to: roomKey, at}` (store-internal; the local record's status stays). Then for **local** consumers holding copies of `<fileKey>`:
  - `diff(fileKey, have)` forwards to the org library and returns every asset whose copy exists as `moved` — a `Redirect {from: (fileKey, key) → to: (roomKey, key)}` — plus the org manifest's updates. Accepting is §9.5's re-point: copies' `sourceLibraryKey` becomes the room key, instances keep their links, the file's `enabledLibraries` swaps the key.
  - From then on that local file receives the org library's updates (ours; Figma has no local space). It still can't *add* org libraries (§16.2).
  - Signed out or no longer able to use the library: `diff` answers from the old local manifest (no updates).
- **Org files consuming a library moved in**: they were local copies too; the same forwarding applies once.
- **Org file → local**: not offered (§14.6). "Duplicate to drafts" (a local copy) keeps the copies (self-contained, §9.4) and lists no org libraries.

### 16.10 HTTP routes

Conventions of §14.12 (JSON, `{error, code}`, `Authorization: Bearer`). `:key` is a library's room key.

**Consuming and publishing** (`server/src/libraries/routes.ts`):

| Route | Who | Request → Response |
|---|---|---|
| `GET /libraries?file=<roomKey>` | can view the file | → `{libraries: OrgLibraryRecord[]}` usable in that file (§16.4, same org), relative to it (§16.5) |
| `GET /libraries/:key` | `canUseLibrary` | → `{library: OrgLibraryRecord}` (relative to the caller's workspace) |
| `GET /libraries/:key/versions/:n` (`latest` allowed) | `canUseLibrary` | → `LibraryVersion` (§9.2's shape; from the object) |
| `POST /libraries/:key/diff` | `canUseLibrary` | `{have: {key, versionHash}[]}` → `LibraryDiff` (computed in the object) |
| `POST /libraries/:key/payloads` | `canUseLibrary` | `{wants: {key, versionHash}[], withDependencies}` → `application/octet-stream`: `[u32 n]` then n × `[u32 jsonLen][{key, versionHash, size}][bytes]` |
| `GET /libraries/:key/blobs/:sha1` | `canUseLibrary` | → bytes, `cache-control: private, max-age=31536000, immutable` |
| `POST /libraries/:key/missing` | can edit the file | `{payloads: {key, versionHash}[], blobs: string[]}` → the same shape, only what the object lacks |
| `PUT /libraries/:key/payloads/:assetKey/:versionHash` | can edit the file | bytes (≤ 50 MB) → 204 |
| `PUT /libraries/:key/blobs/:sha1` | can edit the file | bytes (≤ 50 MB, SHA-1 checked) → 204 |
| `POST /libraries/:key/versions` | can edit, Full seat, not a draft or branch | `OrgPublishInput` → `{version: LibraryVersion, library: OrgLibraryRecord}`; 409 `conflict` when `baseVersion` isn't the latest |
| `PATCH /libraries/:key` | can share the file (`canShare`) | `{scope}` → `{library: OrgLibraryInfo}` (also changes `org_link_access`, §16.2) |
| `POST /libraries/:key/unpublish` | can edit the file | → 204 |
| `GET /files/:key/libraries` | can view the file | → `FileLibraries` `{enabled: LibraryKey[], defaults: LibraryKey[], overrides: {libraryKey, enabled}[]}` |
| `PUT /files/:key/libraries/:libraryKey` | can edit the file | `{enabled: boolean \| null}` (null: back to the default) → `FileLibraries` |

**Managing** (`/orgs/:org/libraries…` and `/teams/:team/libraries`):

| Route | Who | Request → Response |
|---|---|---|
| `GET /orgs/:org/libraries?text=&workspace=&team=&approved=1&default=1` (`/orgs/:org/libraries/analytics`, §17.6, is matched before `:key`) | members (each sees what they can use); admins (§16.4's wider rule) | → `{libraries: OrgLibrarySummary[]}` |
| `GET /orgs/:org/libraries/:key` | as above | → `{library: OrgLibraryInfo}` ("Manage this library": every scope row the caller may see or change) |
| `PUT /orgs/:org/libraries/:key/settings` | §16.5's table | `LibrarySettingsInput` → `{library: OrgLibraryInfo}`; logs `org_library_approve` / `_unapprove` / `org_library_setting_change` (org rows), `workspace_library_approve` / `_unapprove` / `workspace_library_setting_change` (workspace rows); team rows log nothing (Figma names none) |
| `GET /teams/:team/libraries` | team members ("View team's libraries") | → `{libraries: TeamLibraryRow[]}` — the team's own and every org-scope library, with the team row |

**Analytics**: §17.6.

### 16.11 D1: migration `server/migrations/0012_libraries.sql`

0010 (orgs) and 0011 (branches) exist. 0012 is the following text; the round 3 server agent (3a) copies it verbatim. It also holds §17's analytics tables and docs/desktop.md §14.3's fonts table, so the round has one migration.

```sql
-- Libraries in organizations (docs/data.md §16), library analytics (§17), shared fonts (docs/desktop.md §14.3).
-- Times are ms since the epoch; days are 'YYYY-MM-DD' in UTC.

-- One row per org library: its file's room key. No foreign key to files: a library whose file was deleted forever
-- keeps its row (status 'deleted') so consumers can say "Missing library" (§9.6).
CREATE TABLE libraries (
  key               TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- the file's name at the last publish or rename (the live name is files.name while the file exists)
  name              TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'team' CHECK (scope IN ('team', 'org')),
  status            TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unpublished', 'trashed', 'deleted')),
  latest_version    INTEGER NOT NULL,
  -- {components, styles, variables} of the latest version's listed assets
  counts            TEXT NOT NULL DEFAULT '{}',
  first_published_at INTEGER NOT NULL,
  last_published_at INTEGER NOT NULL,
  published_by      TEXT REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX libraries_org ON libraries (org_id, status);

CREATE TABLE library_versions (
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- counts of the version's created / modified / removed / moved (the manifest itself is in LibraryObject)
  changes      TEXT NOT NULL DEFAULT '{}',
  published_at INTEGER NOT NULL,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (library_key, version)
);

-- The latest manifest's assets, for names and counts in analytics and Admin. removed_in: the version that removed it.
CREATE TABLE library_assets (
  library_key       TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('COMPONENT', 'COMPONENT_SET', 'STYLE', 'VARIABLE_COLLECTION', 'VARIABLE')),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  style_type        TEXT,
  resolved_type     TEXT,
  component_set_key TEXT,
  collection_key    TEXT,
  -- VARIABLE_COLLECTION only: [{id, name}] in order (default modes, the Modes tab)
  modes             TEXT,
  version_hash      TEXT NOT NULL,
  dependency_only   INTEGER NOT NULL DEFAULT 0,
  thumbnail_sha1    TEXT,
  removed_in        INTEGER,
  PRIMARY KEY (library_key, key)
);
CREATE INDEX library_assets_kind ON library_assets (library_key, kind);

-- Move to this file (§9.5) across org libraries
CREATE TABLE library_redirects (
  from_library TEXT NOT NULL,
  from_key     TEXT NOT NULL,
  to_library   TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  to_key       TEXT NOT NULL,
  version      INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (from_library, from_key)
);
CREATE INDEX library_redirects_to ON library_redirects (to_library);

-- Approved / enabled by default / default modes, per (library, org | workspace | team). Defaults: 1 on, 0 off (an
-- override of a higher level), NULL inherit.
CREATE TABLE library_settings (
  library_key    TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('org', 'workspace', 'team')),
  scope_id       TEXT NOT NULL,
  approved       INTEGER NOT NULL DEFAULT 0,
  default_design INTEGER CHECK (default_design IN (0, 1)),
  default_figjam INTEGER CHECK (default_figjam IN (0, 1)),
  default_slides INTEGER CHECK (default_slides IN (0, 1)),
  default_buzz   INTEGER CHECK (default_buzz IN (0, 1)),
  -- [{collectionKey, modeId}] (workspace and team rows)
  default_modes  TEXT NOT NULL DEFAULT '[]',
  updated_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (library_key, scope_type, scope_id)
);
CREATE INDEX library_settings_scope ON library_settings (scope_type, scope_id);

-- A file's explicit choice for a library ("Add to file" / "Remove from file"); no row: the defaults decide (§16.5).
CREATE TABLE library_subscriptions (
  file_key    TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  library_key TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  changed_at  INTEGER NOT NULL,
  PRIMARY KEY (file_key, library_key)
);
CREATE INDEX library_subscriptions_library ON library_subscriptions (library_key);

-- §17: insertions and detachments, pre-aggregated by the clients per (day, file, asset, action). team_id and
-- workspace_id are the file's at ingestion (a later move doesn't rewrite history).
CREATE TABLE library_actions_daily (
  day          TEXT NOT NULL,
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('component', 'style', 'variable')),
  file_key     TEXT NOT NULL,
  team_id      TEXT,
  workspace_id TEXT,
  action       TEXT NOT NULL CHECK (action IN ('insert', 'detach')),
  count        INTEGER NOT NULL,
  PRIMARY KEY (library_key, day, asset_key, file_key, action)
);
CREATE INDEX library_actions_team ON library_actions_daily (library_key, team_id, day);

-- §17: the current instances of each library asset in each file (a snapshot the file's clients replace).
CREATE TABLE library_usage (
  file_key     TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('component', 'style', 'variable', 'mode')),
  -- asset_type 'mode': asset_key is '<collectionKey>/<modeId>'
  instances    INTEGER NOT NULL,
  PRIMARY KEY (file_key, library_key, asset_key)
);
CREATE INDEX library_usage_library ON library_usage (library_key, asset_key);

-- The hash of each file's last accepted snapshot (an unchanged upload is a no-op)
CREATE TABLE library_usage_files (
  file_key    TEXT PRIMARY KEY REFERENCES files (key) ON DELETE CASCADE,
  hash        TEXT NOT NULL,
  reported_at INTEGER NOT NULL
);

-- §17.5: the daily roll-up (Cron Trigger) — what the analytics views read.
CREATE TABLE library_asset_stats (
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL,
  instances    INTEGER NOT NULL DEFAULT 0,
  files_using  INTEGER NOT NULL DEFAULT 0,
  teams_using  INTEGER NOT NULL DEFAULT 0,
  inserts_30d  INTEGER NOT NULL DEFAULT 0,
  detaches_30d INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (library_key, asset_key)
);
CREATE TABLE library_stats (
  library_key         TEXT PRIMARY KEY REFERENCES libraries (key) ON DELETE CASCADE,
  teams_using         INTEGER NOT NULL DEFAULT 0,
  inserts_last_week   INTEGER NOT NULL DEFAULT 0,
  inserts_this_week   INTEGER NOT NULL DEFAULT 0,
  detaches_this_week  INTEGER NOT NULL DEFAULT 0,
  -- the last whole day included ('YYYY-MM-DD'): "updated daily"
  through_day         TEXT NOT NULL
);

-- docs/desktop.md §14.3: shared fonts (org or team), one row per face; the bytes are in the org's FontObject.
CREATE TABLE shared_fonts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- null: an organization font; else a team font
  team_id         TEXT REFERENCES teams (id) ON DELETE CASCADE,
  family          TEXT NOT NULL,
  style           TEXT NOT NULL,
  postscript_name TEXT NOT NULL,
  weight          INTEGER NOT NULL,
  italic          INTEGER NOT NULL DEFAULT 0,
  stretch         INTEGER NOT NULL DEFAULT 5,
  variable        INTEGER NOT NULL DEFAULT 0,
  sha1            TEXT NOT NULL,
  format          TEXT NOT NULL CHECK (format IN ('ttf', 'otf')),
  size            INTEGER NOT NULL,
  file_name       TEXT NOT NULL,
  uploaded_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX shared_fonts_face ON shared_fonts (org_id, COALESCE(team_id, ''), family, style);
CREATE INDEX shared_fonts_sha1 ON shared_fonts (org_id, sha1);
```

Notes:
- **Ids**: font face ids are 16-character base62 (`randomId(16)`, as §14.5).
- **Notifications**: `library_default_override` is a new kind (§16.5), stored with `file_key` null and the library's name in `file_name`, as §14.15's org kinds.
- **Activity retention** moves to §17.5's daily cron (§14.15 swept it on read).

### 16.12 Shared types: `src/shared/libraries/orgTypes.ts` (committed verbatim before round 3)

```ts
/**
 * Libraries in organizations (docs/data.md §16) and library analytics (§17): the value types and the two new store
 * repositories, committed before Phase 7 round 3 so its agents compile against the same shapes.
 */
import type { FileKey, FileMeta, LibraryAsset, LibraryRecord, Redirect } from "../store/types";
import type { EditorType, PersonRef } from "../org/types";

// ---- identity ---------------------------------------------------------------------------------------------

/** A library's key: its file's room key for an org library (FileSpace.key), its FileKey for a local one (§16.2). */
export type LibraryKey = string;
/** Local FileKeys are 22 base62; room keys contain "_" (roomKeyFor), so the forms never collide. */
export const isLocalLibraryKey = (key: string): boolean => /^[0-9A-Za-z]{22}$/.test(key);
/** "This file's library": the room key of an org copy, else the local file key. */
export const libraryKeyOfFile = (meta: Pick<FileMeta, "fileKey" | "space">): LibraryKey => meta.space?.key ?? meta.fileKey;

export type LibraryScope = "team" | "org";
/** Figma's "Design files", "FigJam boards", "Slide decks", "Figma Buzz files" */
export type LibraryEditorType = Extract<EditorType, "design" | "figjam" | "slides" | "buzz">;
export const LIBRARY_EDITOR_TYPES: readonly LibraryEditorType[] = ["design", "figjam", "slides", "buzz"];
export type SettingScope = { type: "org"; id: string } | { type: "workspace"; id: string } | { type: "team"; id: string };

/** A published collection's modes, in order (the first is its default) */
export interface CollectionModes {
  collectionKey: string;
  name: string;
  modes: { id: string; name: string }[];
}
export interface DefaultMode {
  collectionKey: string;
  modeId: string;
}

// ---- consuming ----------------------------------------------------------------------------------------------

/** Where an org library stands, relative to the file asking (listAvailable) or the caller (getRecord). */
export interface OrgLibraryContext {
  orgId: string;
  teamId: string | null;
  teamName: string | null;
  workspaceId: string | null;
  scope: LibraryScope;
  /** The library file's name */
  name: string;
  /** null until a client uploaded a thumbnail (OrgFile.thumbnailUrl) */
  thumbnailUrl: string | null;
  publishedBy: PersonRef | null;
  /** The check mark: approved for the organization, for the file's (caller's) workspace, or not */
  approved: "org" | "workspace" | null;
  /** On by default for this file (its editor type, team, workspace) — §16.5 */
  enabledByDefault: boolean;
  /** Default modes for this file's team or workspace (§16.5) */
  defaultModes: DefaultMode[];
  /** Why the caller can use it (§16.4) */
  via: ("file" | "team" | "org")[];
}
/** What LibraryRegistry.listAvailable / getRecord return for an org library: today's record plus `org`. */
export interface OrgLibraryRecord extends LibraryRecord {
  libraryFileKey: LibraryKey;
  org: OrgLibraryContext;
}
export const isOrgLibrary = (r: LibraryRecord): r is OrgLibraryRecord => (r as Partial<OrgLibraryRecord>).org != null;

/** GET/PUT /files/:key/libraries */
export interface FileLibraries {
  /** Effective: explicit choices over the defaults */
  enabled: LibraryKey[];
  /** On by default for this file */
  defaults: LibraryKey[];
  /** The file's explicit choices */
  overrides: { libraryKey: LibraryKey; enabled: boolean }[];
}

// ---- publishing -----------------------------------------------------------------------------------------------

/** POST /libraries/:key/versions (the store builds it from a PublishRequest, §16.6) */
export interface OrgPublishInput {
  /** The latest version the preview was computed against (0: first publish) */
  baseVersion: number;
  description: string;
  /** "Allow any member of ‹org› to access the file" */
  scope: LibraryScope;
  /** The complete manifest of the new version (thumbnails as sha1; payloads and blobs uploaded before) */
  assets: LibraryAsset[];
  changes: { created: string[]; modified: string[]; removed: string[]; moved: Redirect[] };
  moves: { key: string; fromLibraryFileKey: LibraryKey; fromKey: string; mode: "move" | "copy" }[];
  /** Read by the store from the VARIABLE_COLLECTION payloads */
  collections: CollectionModes[];
}
/** POST /libraries/:key/missing, both ways */
export interface LibraryMissing {
  payloads: { key: string; versionHash: string }[];
  blobs: string[];
}

// ---- managing (Admin › Resources › Libraries, team settings, Home's Libraries) ----------------------------------

export interface LibraryScopeSetting {
  scope: SettingScope;
  scopeName: string;
  /** org and workspace rows only */
  approved: boolean;
  /** true on, false off (an override), null inherit */
  defaults: Record<LibraryEditorType, boolean | null>;
  defaultModes: DefaultMode[];
  updatedAt: number;
  updatedBy: PersonRef | null;
}
export interface OrgLibrarySummary {
  key: LibraryKey;
  name: string;
  orgId: string;
  teamId: string | null;
  teamName: string | null;
  workspaceId: string | null;
  scope: LibraryScope;
  status: LibraryRecord["status"];
  latestVersion: number;
  lastPublishedAt: number;
  counts: { components: number; styles: number; variables: number };
  thumbnailUrl: string | null;
  approved: { org: boolean; workspaceIds: string[] };
  /** Where it is on by default (any editor type) */
  defaultIn: { org: LibraryEditorType[]; workspaceIds: string[]; teamIds: string[] };
  /** From the daily roll-up (§17.5) */
  insertsLastWeek: number;
}
export interface OrgLibraryInfo extends OrgLibrarySummary {
  collections: CollectionModes[];
  /** Every scope row the caller may see */
  settings: LibraryScopeSetting[];
  /** What the caller may change */
  canManage: { org: boolean; workspaceIds: string[]; teamIds: string[] };
}
export interface TeamLibraryRow extends OrgLibrarySummary {
  /** The team's own row (defaults null when never set) */
  setting: LibraryScopeSetting;
}
export interface LibrarySettingsInput {
  scope: SettingScope;
  approved?: boolean;
  defaults?: Partial<Record<LibraryEditorType, boolean | null>>;
  /** modeId null: back to the collection's default */
  defaultModes?: { collectionKey: string; modeId: string | null }[];
}
export interface OrgLibrariesQuery {
  text?: string;
  workspaceId?: string;
  teamId?: string;
  approved?: boolean;
  enabledByDefault?: boolean;
}

export interface OrgLibrariesRepository {
  list(orgId: string, query?: OrgLibrariesQuery): Promise<OrgLibrarySummary[]>;
  get(orgId: string, key: LibraryKey): Promise<OrgLibraryInfo>;
  updateSettings(orgId: string, key: LibraryKey, input: LibrarySettingsInput): Promise<OrgLibraryInfo>;
  /** "Allow any member of ‹org› to access the file" after publishing (PATCH /libraries/:key) */
  setScope(key: LibraryKey, scope: LibraryScope): Promise<OrgLibraryInfo>;
  /** Team › View settings › "View team's libraries" */
  teamLibraries(teamId: string): Promise<TeamLibraryRow[]>;
}

// ---- library analytics (§17) ------------------------------------------------------------------------------------

export type AnalyticsAssetType = "component" | "style" | "variable";
export type UsageAction = "insert" | "detach";
/** Figma's ranges: 30, 60, 90 days, "last year" (rolling 12 months) */
export type AnalyticsRange = 30 | 60 | 90 | 365;

/** What the editor reports (§17.3); the store maps fileKey to the room key and `at` to a UTC day. */
export interface LibraryUsageEvent {
  fileKey: FileKey;
  libraryKey: LibraryKey;
  assetKey: string;
  assetType: AnalyticsAssetType;
  action: UsageAction;
  count: number;
  at: number;
}
/** POST /analytics/library-events — pre-aggregated per (day, file, library, asset, action) */
export interface WireUsageEvent {
  day: string;
  file: string;
  library: LibraryKey;
  asset: string;
  type: AnalyticsAssetType;
  action: UsageAction;
  count: number;
}
/** PUT /files/:key/library-usage — the file's current instances of org-library assets (§17.4) */
export interface FileUsageSnapshot {
  /** sha1 of the canonical rows: unchanged → the server does nothing */
  hash: string;
  assets: { library: LibraryKey; asset: string; type: AnalyticsAssetType; instances: number }[];
  modes: { library: LibraryKey; collection: string; mode: string; instances: number }[];
}

/** One week of actions, Figma's REST names; `week` is its Sunday 'YYYY-MM-DD' (UTC) */
export interface WeeklyActions {
  week: string;
  insertions: number;
  detachments: number;
}
export interface AssetStatsRow {
  key: string;
  name: string;
  type: AnalyticsAssetType;
  description: string;
  componentSetKey?: string;
  componentSetName?: string;
  /** Component sets: their variants */
  variants?: number;
  styleType?: string;
  variableType?: string;
  collectionKey?: string;
  collectionName?: string;
  /** A current snapshot */
  instances: number;
  /** In the last 30 days */
  insertions: number;
  detachments: number;
  teamsUsing: number;
  filesUsing: number;
}
/** Library analytics › Overview */
export interface LibraryOverview {
  libraryKey: LibraryKey;
  teamsUsing: number;
  counts: { components: number; styles: number; variables: number };
  /** "Activity this week": the last seven days */
  thisWeek: { insertions: number; detachments: number };
  rows: AssetStatsRow[];
  /** The last day included ('YYYY-MM-DD') */
  throughDay: string;
}
export interface TeamActionsRow {
  teamId: string | null;
  teamName: string;
  workspaceName: string | null;
  insertions: number;
  detachments: number;
  /** Share of all insertions, 0–1 */
  share: number;
}
/** Library analytics › Analytics, for one Type and one Duration */
export interface LibraryActions {
  type: AnalyticsAssetType;
  range: AnalyticsRange;
  series: WeeklyActions[];
  /** "Compare with" */
  compare: { libraryKey: LibraryKey; name: string; series: WeeklyActions[] } | null;
  topTeams: TeamActionsRow[];
  teamsUsing: number;
  rows: AssetStatsRow[];
  throughDay: string;
}
export interface FileUsageRow {
  /** null: "File not visible" (the caller can't see that file or its team) */
  fileKey: string | null;
  fileName: string;
  teamName: string | null;
  workspaceName: string | null;
  instances: number;
  lastModified: number | null;
}
/** One asset's usage view: "Used by" teams, "Used in" files */
export interface AssetUsage {
  row: AssetStatsRow;
  teams: TeamActionsRow[];
  files: FileUsageRow[];
}
export interface ModeUsageRow {
  collectionKey: string;
  collectionName: string;
  modeId: string;
  modeName: string;
  instances: number;
}
/** File browser › All teams (All workspaces) › Libraries */
export interface OrgLibrariesAnalytics {
  totals: { teams: number; teamsWithLibraries: number; libraries: number; components: number; styles: number; variables: number };
  libraries: { key: LibraryKey; name: string; teamName: string | null; components: number; styles: number; variables: number; insertsLastWeek: number }[];
  throughDay: string;
}

export interface LibraryAnalyticsRepository {
  /** The editor's events; queued and batched by the store, never fails (dropped for local files) */
  record(events: LibraryUsageEvent[]): Promise<void>;
  orgOverview(orgId: string, query?: { workspaceId?: string; text?: string }): Promise<OrgLibrariesAnalytics>;
  overview(key: LibraryKey): Promise<LibraryOverview>;
  actions(key: LibraryKey, query: { type: AnalyticsAssetType; range: AnalyticsRange; compareWith?: LibraryKey }): Promise<LibraryActions>;
  usage(key: LibraryKey, assetKey: string): Promise<AssetUsage>;
  modes(key: LibraryKey, collectionKey?: string): Promise<ModeUsageRow[]>;
  /** "Download CSV" (the view offers it above five teams, Figma's rule; the view saves the text through main) */
  csv(key: LibraryKey, query: { type: AnalyticsAssetType; range: AnalyticsRange }): Promise<string>;
}

// StoreApi gains: orgLibraries: OrgLibrariesRepository; analytics: LibraryAnalyticsRepository;
```

### 16.13 Server layout (round 3a)

- `server/src/libraries/`: `routes.ts` (§16.10), `db.ts` (queries, `syncLibraryScope`, `libraryFileStatus`, settings resolution of §16.5), `access.ts` (`canUseLibrary`, the admin reach), `libraryObject.ts` (the Durable Object: tables `manifests(version, json)`, `payloads(key, hash, chunk, bytes)`, `blobs(sha1, chunk, bytes)`, `meta(latest)`; routes `/missing`, `/payload`, `/blob`, `/commit`, `/version/:n`, `/diff`, `/payloads`, `/delete`; `diff` and `payloads` with dependencies use `libraryRules` from `src/shared/store/libraryRules.ts`), `notices.ts` (§16.7).
- `server/src/index.ts`: export `LibraryObject` and `FontObject`; `scheduled()` runs §17.5.
- `server/wrangler.jsonc`: bindings `LIBRARIES` (`LibraryObject`) and `FONTS` (`FontObject`); migration tag **`v4`** `new_sqlite_classes: ["LibraryObject", "FontObject"]`; `"triggers": {"crons": ["17 3 * * *"]}` (one of the free plan's five).
- `server/src/api.ts`: one dispatch line each for `/libraries`, `/analytics`, `/orgs/:org/libraries`, `/orgs/:org/fonts`, `/teams/:team/libraries`, `/fonts`, `/me/fonts`, `/files/:key/libraries`, `/files/:key/library-usage`; the file trash / restore / delete paths call `libraryFileStatus`; `PATCH /files/:key`'s `orgLinkAccess` calls `syncLibraryScope`.
- Tests on node:sqlite with in-memory objects (`server/src/testing/memoryLibraries.ts`, as `memoryPreviews.ts`): publish twice with a stale base, payload dedupe, diff / payloads with dependencies, access rules 1–4 incl. guests and a Limited folder, scope ↔ link access, approval and default resolution across org / workspace / team incl. overrides and drafts, default modes, subscriptions, notices, unpublish / trash / delete, the activity actions.

---

## 17. Library analytics (contract, Phase 7 round 3; written 2026-10-11)

**Status: contract, not built.** Figma's in-app library analytics for org libraries (§16): what the editor reports, how the store batches it, how the server stores and rolls it up, what the views read. Research: R18 D-3. Facts read on 2026-10-11:
- **[A-help]** Library analytics — https://help.figma.com/hc/en-us/articles/360039238353
- **[A-api]** Library Analytics REST endpoints — https://developers.figma.com/docs/rest-api/library-analytics-endpoints/ (Enterprise; round 5a serves them from the same tables)

### 17.1 What Figma does

- **Who**: Organization and Enterprise. Any org **member** with "can view" or "can edit" on the library file. **Guests can't** [A-help].
- **Where**: org-wide — file browser › **All teams** (Enterprise with workspaces: **All workspaces**) › **Libraries**: totals of teams, teams with libraries, libraries, components and styles; per library its components, styles and **"Inserts last week"**; a search field. One library — in the library file, nothing selected, the file name's ⌄ › **Library analytics**, or right-click the library in the file browser.
- **Overview tab**: teams using the library; total components, styles and variables; **"Activity this week"** (the last seven days); every style, variable collection and component listed.
- **Analytics tab**: **Type** (Components / Styles / Variables); **Duration** 30, 60, 90 days or "last year" (rolling 12 months); the **insertions graph** (current data blue, unavailable grey, comparison black, a dashed line for an incomplete week; it runs to the end of the current week); **Compare with** another library's insertions; **Top teams** with insertions and share; a sortable statistics table; **Download CSV** only when more than five teams use the library (otherwise the data can be copied from the modal).
- **Per asset**: components and sets — Variants column, a usage view with description, total instances, teams ("Used by"), files ("Used in"), a file table with instances and last modified; for sets, Instances is a current snapshot, Inserts and Detaches the last 30 days. Styles: the same. Variables: name, collection, instances, inserts and detaches over 30 days; a **Modes** tab (mode, collection, instance count; filter by collection; no drill-down).
- **Insertions**: components — copying and pasting an instance, duplicating one in a file, dragging from Assets, swapping an instance, adding content to a slot. Styles and variables — pasting or duplicating content that uses them, or applying them.
- **Detaches**: "Detach instance"; for styles and variables, their Detach buttons.
- **Not counted**: use in other people's drafts; nested components; a style or variable used by an inserted component (only the component counts), a variable used by an inserted style (only the style); insertions made by duplicating a file; slots themselves (content added to a slot counts as an insertion of its component).
- **Visibility**: file-level usage only for teams open to the whole organization, or "Only those invited" teams the viewer is in; the API calls the rest **"File not visible"** and still counts its instances [A-api].
- **Freshness**: updated **daily**, up to **one year** kept; styles and variables tracked since 2024-10-10.
- **API** [A-api]: weekly actions (`week`, `insertions`, `detachments`) grouped by asset or team, and usages (`usages`, `teams_using`, `files_using`) grouped by asset or file; weeks start Sunday 00:00 UTC; only weeks with data are returned.

### 17.2 Decisions

| Topic | Decision |
|---|---|
| What is measured | Only org libraries (§16) used in **org files that are not drafts and not branches**. Local files and local libraries report nothing (Figma counts organizations only). |
| Drafts | Figma skips "other people's drafts"; since a draft's owner is the only one seeing its numbers anyway, we skip all drafts (ours: simpler, same for everyone else). |
| Who computes events | The **editor**, from its own change batches (§17.3): it has the engine to tell whether a GUID is a library copy. One module, no call sites spread over the editor. |
| Instances | The **store**, from the file's document when the file is closed or flushed idle (§17.4), at most once a day per file and only when changed. |
| Transport | Pre-aggregated in the store per (UTC day, file, library, asset, action) and sent in batches; the server upserts with `count = count + excluded.count`. No raw event rows exist anywhere. |
| No people | No user id, name or IP is stored with analytics (Figma's views and API show none). Team and workspace come from the file. |
| Roll-up | One daily **Cron Trigger** (03:17 UTC) recomputes the stats tables in a few SQL statements that run inside D1; the Worker's 10 ms CPU isn't spent on rows. |
| Weeks | Sunday 00:00 UTC, Figma's API rule; the graph's last week is dashed when incomplete. |
| Retention | Actions 53 weeks; usage rows live while the file and library do. |
| Free plan | A batch is one access query plus one `INSERT … SELECT FROM json_each(?)`; a few friends write tens of rows a day against 100,000. |

### 17.3 Usage events from the editor

`src/renderer/src/editor/libraryUsage.ts` (new, round 3c) watches the editor's own batches (`documentSource.ts` hands it each appended `ChangeBatch` and the engine; one hook line) and calls `store.analytics.record(events)`, debounced 2 s. Rules, per batch:
- **Counted kinds**: `edit` only — the person's own edits, agents' turns included. `undo`, `redo`, `system`, `remote`, `restore` never count; an undone insert is not taken back (unverified at Figma; ours).
- **Files**: org copies (`FileMeta.space` set, `projectId` not null, not a branch). Otherwise nothing is recorded.
- **Component insert** (assetType `component`; the key is the **component's**, a variant's own key — the set's key comes from the manifest): a node CREATED as an INSTANCE whose `symbolData.symbolID` resolves to a copy with `sourceLibraryKey` of an org library, **not inside another instance** and not inside another node created in the same batch that is itself counted (a pasted frame holding three instances counts three; an instance nested in a pasted instance doesn't). Also: an existing instance whose `symbolID` changes to such a copy (**swap**), and an instance created inside slot content (Figma: adding content to a slot).
- **Component detach**: a node whose type changes from INSTANCE and gains `detachedSymbolId` pointing at a library copy (the engine's DETACH).
- **Style insert**: a node's `styleIdFor*` newly set to a library style copy in a batch that is not a component insert of an ancestor (only the component counts); pasted / duplicated content counts each node using the style once per style.
- **Style detach**: a `styleIdFor*` that pointed at a library style copy is cleared **and** the matching paint / text / effect / grid field is written in the same change (the engine's detach writes the look inline; a plain removal doesn't).
- **Variable insert**: a binding (`parameterConsumptionMap` entry or a paint's / effect's variable alias) newly pointing at a library variable copy, not under a counted component insert or style insert.
- **Variable detach**: such a binding removed **and** the raw value written in the same change (Detach variable).
- **Duplicating a file** makes no batches in the new file: nothing counts, as Figma.
- The event's `libraryKey` is the copy's `sourceLibraryKey`; `assetKey` the copy's `key`. Copies of assets the library has since removed still count (their row shows the last known name).

### 17.4 Instance counts per file (the "Instances" snapshot)

`src/store/libraries/usage.ts` (round 3b) computes a `FileUsageSnapshot` for an org copy (same file rules as §17.3) when the file is closed or flushed after 5 minutes idle, **at most once per UTC day per file** and only when its `headSeq` moved since the last one:
- It reads the document as compaction does (snapshot + journal, generic NodeChange merge; no engine).
- **Components**: INSTANCE nodes (real nodes; instance sublayers are derived and never counted — Figma's "nested components") whose `symbolData.symbolID` is a library copy; counted under the copy's `key`.
- **Styles**: nodes with a `styleIdFor*` naming a library style copy, once per (node, style).
- **Variables**: nodes with a binding to a library variable copy, once per (node, variable).
- **Modes**: nodes with an explicit `variableModeBySetMap` entry for a library collection copy, once per (node, mode) — the Modes tab's "instance count" (ours: Figma doesn't define it).
- `hash` = sha1 of the sorted rows. `PUT /files/:roomKey/library-usage` replaces the file's rows unless the hash is unchanged.
- On the owner's 32k-layer file this must stay under 1 s in the store process (a bench, not in `npm run check`).

### 17.5 Batching, ingestion, the daily roll-up

**Client** (`src/store/libraries/analyticsQueue.ts`, both stores):
- `analytics.record` maps each event's `fileKey` to its room key and `at` to its UTC day, drops what §17.2 excludes, and adds it to an in-memory map keyed `(day, file, library, asset, type, action)` → count.
- The map is persisted to `Workspace/spaces/analytics-queue.json` (desktop; `designer.devStore.v1.analytics` in the browser) on every change, debounced 5 s, so a quit or crash loses at most 5 s.
- It is sent every 10 minutes, on quit (best effort, 2 s), and when the connection comes back: `POST /analytics/library-events {events: WireUsageEvent[]}` in chunks of 500. Sent rows leave the queue when the server answers 2xx; `4xx` drops the chunk; `5xx` / offline keeps it. Rows older than 7 days are dropped (the server refuses them anyway). Signed out: nothing is queued.

**Server** (`server/src/analytics/ingest.ts`):
- `POST /analytics/library-events`: for the distinct files of the batch, one query keeps those the caller can **edit** (`resolveAccess`), in an org, with a project (not a draft) and not a branch, and joins each file's `team_id` and its team's `workspace_id`. Rows for other files, for libraries that aren't org libraries of the same org, for days outside [today − 7, today] or with `count` outside 1…10,000 are dropped. One statement inserts the rest:

  ```sql
  INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, workspace_id, action, count)
  SELECT e.value ->> 'day', e.value ->> 'library', e.value ->> 'asset', e.value ->> 'type', e.value ->> 'file',
         e.value ->> 'team', e.value ->> 'workspace', e.value ->> 'action', e.value ->> 'count'
  FROM json_each(?1) AS e
  ON CONFLICT (library_key, day, asset_key, file_key, action) DO UPDATE SET count = count + excluded.count;
  ```

  → `{accepted, dropped}`.
- `PUT /files/:key/library-usage` (can edit; same file rules): unchanged hash → 204; else `DELETE FROM library_usage WHERE file_key = ?`, one `INSERT … SELECT FROM json_each(?)`, the hash row → 204.
- The routes are rate-limited per person: 60 calls an hour (429 `rate_limited`).

**Daily roll-up** (`server/src/analytics/rollup.ts`, `scheduled()` at `17 3 * * *`): for the day `D` = yesterday (UTC), in order, each one SQL statement run in D1:
1. `library_asset_stats` ← for every asset of every published library: `instances`, `files_using`, `teams_using` from `library_usage` (files joined to their current team; drafts and branches excluded again), `inserts_30d` / `detaches_30d` from `library_actions_daily` over [D − 29, D]. (`INSERT OR REPLACE … SELECT … GROUP BY`.)
2. `library_stats` ← per library: teams using (distinct teams with instances or actions in the last 30 days), inserts of the last whole week, inserts and detaches of the last seven days up to D, `through_day = D`.
3. Retention: `DELETE FROM library_actions_daily WHERE day < D − 371 days`; `DELETE FROM activity_log WHERE at < now − 365 days` (moved here from §14.15's read-time sweep).

The views read the stats tables for tables and totals and `library_actions_daily` with `day <= through_day` for the graphs, so numbers change once a day, as Figma's.

### 17.6 Routes (`server/src/analytics/query.ts`)

Who: org members (not guests) who can **view the library's file** (§17.1). `:key` is the library's room key.

| Route | → |
|---|---|
| `GET /orgs/:org/libraries/analytics?workspace=&text=` | `OrgLibrariesAnalytics` (the libraries the caller can use; totals over the org or the workspace) |
| `GET /libraries/:key/analytics/overview` | `LibraryOverview` |
| `GET /libraries/:key/analytics/actions?type=component\|style\|variable&range=30\|60\|90\|365&compare=<key>` | `LibraryActions` (the compared library must be usable by the caller too) |
| `GET /libraries/:key/analytics/usage/:assetKey` | `AssetUsage` |
| `GET /libraries/:key/analytics/modes?collection=` | `{modes: ModeUsageRow[]}` |
| `GET /libraries/:key/analytics/csv?type=&range=` | `text/csv` — Figma's REST column names: `component_key, component_name, component_set_key, component_set_name, instances, insertions, detachments, teams_using, files_using` (styles: `style_key, style_name, style_type, …`; variables: `variable_key, variable_name, variable_type, collection_key, collection_name, …`) |

- **Visibility of files and teams** (§17.1): a `FileUsageRow` or `TeamActionsRow` is named only when its team is open to the org (`org_access` not `none`) or the caller is in it; otherwise `fileKey: null, fileName: "File not visible"` (team: `"Team not visible"`, ours), counts kept.
- Week buckets: `strftime` over `day` shifted to the Sunday; weeks with no data appear as zero in `series` (the graph needs them; the CSV and round 5a's API leave them out as Figma does).
- Round 5a's `/v1/analytics/libraries/:key/{component,style,variable}/{actions,usages}` reuse these queries with Figma's field names and `group_by`.

### 17.7 Privacy

- Stored: library, asset, file room key, team, workspace, day, counts. Never a person, an IP, a node id or content.
- Events leave the computer only for org files the person can edit; local files never report.
- A person leaving the org changes nothing in the numbers (there is nothing personal to remove). Deleting a file forever removes its usage rows (`ON DELETE CASCADE`) and keeps its past actions (team and day only, the file key no longer resolves: "File not visible").
- Settings › Account gains no switch (Figma has none; analytics are the org's).


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
9. **Org libraries in local files** (§16.2, §16.9): Figma offers org libraries only in the org's files. Local files keep receiving updates of a library whose file moved into an org, but can't add org libraries. Should local files be able to add org libraries the owner can use (ours, convenient for files never moved into an org)?
