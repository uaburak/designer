# 22 — Undo, saving and the file format

Figma Design desktop 126.9.13, static reading of the shipped build, plus one check against the owner's own Save Local
Copy (`~/Desktop/AnexEUI - B2C.fig`, exported 2026-10-15). Research date 2026-10-16.

## 1. Scope and sources

**Covered:** undo / redo (what a step is, commit modes, skipping, page restore, staging buffers, multiplayer, limits,
persistence); saving (there is no Save: autosave to the server, the local IndexedDB backup of unsynced changes, offline
editing, reconnect, restore on load, the save-status icon, the "unsaved changes" toasts, ⌘S); Save Local Copy (what is
written, in which order, waits, skip and partial files); the `.fig` container (header, version numbers, chunks,
compression, ZIP form, `meta.json`, images, what the importer requires and rewrites); how the kiwi schema evolves (the
schema embedded in this build compared with the repo's two older Figma schemas); memory limits and the memory UI;
"too large" flows; Duplicate.

**Not covered here:** version history panel and branching (chapter 16), Export and import of other formats (chapter 15,
whose §14.2 already lists the `.fig` reader; this chapter goes deeper on the writer and the required fields), tab and
window shells (chapter 01).

**Prior work summarised, not redone**
- `docs/research/rea/canvas.md` §2.3, §2.4, §2.18: Figma's four undo histories, skippable batches, dangling-reference
  filter, layout enforcement after undo, the persisted `localUndoStack` / `localRedoStack`. Summarised in §2.
- `docs/research/figma/R2-document.md` §4, §5, §8: server checkpoints + journal, the `.fig` ZIP, chunk layout, sample
  versions, derived data stored in files, offline (help site). Summarised in §4–§5, extended.
- `docs/research/atlas/15-export-import.md` §14.2: reader magic table, `bn = 110`, defaults filled on import.
- `docs/research/atlas/16-comments-versions.md` §3: autosave versions in the history panel (server side, 30 min).
- `docs/research/figma/R1-engine.md`: "2 GB per tab" memory (help site), Wasm max 65,536 pages (4 GiB).

**Read for this chapter** (offsets are byte offsets in the minified file)

| File | What |
|---|---|
| `figma_app.min.js` @1 844 632 – 1 870 000 | Autosave manager / session (`eT`, `eS`): IDB commit, restore on load, offline-sync savepoints, GC window |
| `figma_app.min.js` @2 444 730 (module 345296) | Memory warning level, heap usage %, 5 s poll, 90 % threshold |
| `figma_app.min.js` @7 287 857, @7 164 682 | Enums: autosave commit reason; heap memory mode |
| `figma_app.min.js` @2 093 242 | `.fig` import: image upload batches, 413 / 400 handling |
| `3187.min.js` @2 179 716 (module 716751) | IndexedDB `figma-autosave-v3`: stores, keys, version 4, open timeout, retries, quota errors |
| `3187.min.js` @1 071 556 (module 310694), @2 353 999 (795986) | `SET_SAVE_STATUS`, the 60 s "unsaved changes" toast timer, "Changes saved" |
| `3187.min.js` @8 855 386 | `SaveStatus` model (`hasAutosaveChanges`, `hasMultiplayerChanges`, `hasStagedChanges`, `tabCloseText`) |
| `3187.min.js` @9 919 706 | Autosave commit policy enum |
| `3187.min.js` @3 139 170 | Save Local Copy writer (ZIP entries, asset downloads, skip after 20 s, partial file name) |
| `9905.min.js` @449 870 | The save-status icon in the toolbar (`multiplayer-save-status`) and its timing rules |
| `7094.min.js` @423 852 | `showAutosaveVisualBell` (the "you don't need to save" toast) |
| `1a115cee.min.js` @9 889, `7824.min.js` | "Has autosave changes" / log-out modals, expiry text, Home notification |
| `3653.min.js` @195 739, `5741.min.js` @1 929 953 | Memory usage bar, warning panel, reload / recovery-mode modal |
| `fullscreen__import__import.worker.js` @3 187 334, @2 945 940, @3 195 857 | Reader limits, the embedded binary schema `mn`, the import pipeline (checks, rewrites, re-encode) |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (`strings -n 6`) | `FGUndoRedo.cpp`, `Undo::Buffer`, the undo debug dump, `FGAutosave.cpp`, Rust `fig-kiwi` and `file-migrations` crates |
| Shortcut JSON inside the wasm strings | `undo`, `redo`, `create-savepoint`, `create-section-from-selection` |
| Desktop shell English (`en_main.txt` captured by chapter 01) | Close / reload / log-out "unsaved changes" dialogs |
| Owner's file `AnexEUI - B2C.fig` | Header version, chunk compression, `meta.json`, ZIP entry order; its schema compared byte for byte with the build's |

## 2. Undo and redo

### 2.1 Summary of canvas.md (one line each, evidence there)

| Finding | Status |
|---|---|
| `FGUndoRedo` keeps four stacks: `_undoHistory`, `_untaintedUndoHistory`, `_redoHistory`, `_untaintedRedoHistory` | CONFIRMED (canvas.md §2.4) |
| One ⌘Z skips batches that would change nothing visible ("%d batch(es) would be skipped before applying one") | CONFIRMED |
| Batches that point at deleted nodes are filtered ("undo batch cleared by dangling-reference filtering") | CONFIRMED |
| After undo / redo, layout invariants are re-enforced ("Marking field dirty for stack invariant enforcement while undoing/redoing") | CONFIRMED (§2.3) |
| Undo is refused in read-only, playground mode, and while IMAGE_LASSO or RECOLOR is active | CONFIRMED |
| `openIgnoreUndoRedoScope` / `closeIgnoreUndoRedoScope` keep system writes out of history | CONFIRMED |
| Plugin API `commitUndo` → action "commit", `triggerUndo` → action "undo" | CONFIRMED |
| History persisted as `Message.localUndoStack = 22` / `localRedoStack = 23`, each entry a NODE_CHANGES Message | CONFIRMED (schema) |

### 2.2 What makes one undo step (CONFIRMED unless marked)

A step is everything written between two **commits**. The editor does not group by time; it groups by the commit calls
the UI and tools make.

| Item | Value | Evidence | Status |
|---|---|---|---|
| Commit mode enum passed by every panel write | `NO = 0`, `YES = 1`, `YES_WITHOUT_TRACKING_AS_EDIT = 2`, `YES_FORCE_TRACKING_AS_EDIT = 3` | `figma_app.min.js` @2 770 887 | CONFIRMED |
| `YES_*` collapse to YES for the engine | modes 1–3 commit; 2 / 3 differ only in "track as edit" (analytics / edit info) | `figma_app.min.js`: "case E.zk.YES_FORCE_TRACKING_AS_EDIT: … return E.zk.YES" | CONFIRMED |
| Scrubbable inputs, sliders, colour picker (hue, opacity, hex), angle, path trim, transform origin | report `{commit: false}` while dragging and `{commit: true}` on release → the whole drag is one step | `figma_app.min.js`: "onChange:(e,{commit:t})=>eT({...y.hslva,h:e},t)" | CONFIRMED |
| Typed number fields | default commit `YES` on change (Enter / blur) | `figma_app.min.js`: "onChange:(e,t=h.zk.YES)=>" | CONFIRMED |
| Hover previews (font / style pickers) | write with `YES_WITHOUT_TRACKING_AS_EDIT` only when the preview is applied; previews use `NO` | `figma_app.min.js`: "r?G.zk.YES_WITHOUT_TRACKING_AS_EDIT:G.zk.NO" | CONFIRMED |
| Multi-part JS actions (auto layout suggestions, remove all auto layout) | call `commitUndo()` once at the end → one step; an error path calls `commitUndo(); triggerUndo()` to roll back | `figma_app.min.js`: "t.commitUndo(),!0" | CONFIRMED |
| Committing inside a commit | refused: "triggerAction: Trying to commit within a commit." | wasm strings | CONFIRMED |
| Empty batch | dropped: "nothing to commit, empty batch" | wasm strings | CONFIRMED |
| Canvas gestures (drag, resize, rotate, draw) | one step per gesture (mouse down → up), the commit happening on mouse up | INFERRED from the commit model; no time window string exists | INFERRED |
| Arrow-key nudges | each key event goes to C++ with `isRepeat`; whether auto-repeat nudges merge into one step is not readable | `figma_app.min.js` @≈2 093 000: "isRepeat:e.repeat" | INFERRED (open question 1) |
| Text typing | text edits are Rust CollaborativeText ops with their own "undo adjustments"; the grouping of typed characters is not readable | `rust/collaborative-text/src/undo_adjustments.rs` | INFERRED (open question 2) |

### 2.3 What an undo restores

| Item | Value | Evidence | Status |
|---|---|---|---|
| Page | each batch records the pages it touched; the Message carries them as `Message.undoBatchPageIds = 46` (GUID[]) | schema; wasm: "Cannot append undoBatchPageIds to buffer that ends with non-zero byte" | CONFIRMED |
| Edit mode | restored with the step ("update-edit-mode-for-undo") | wasm strings | CONFIRMED (name) / INFERRED (effect: undo re-enters text or vector edit mode) |
| Library asset versions | bumped again for undo: `update-style-version-for-undo`, `-variable-version-`, `-variable-set-version-`, `-shared-symbol-version-`, `-shared-state-group-version-` | wasm strings | CONFIRMED |
| Selection | restored with the batch (Figma's selection is part of the editor state that undo walks; the debug dump prints the scene "after undo") | INFERRED | INFERRED |
| Viewport (pan / zoom) | not a document change, never in a batch | INFERRED (no field) | INFERRED |
| Undo cleared | "Skipping clear of undo/redo buffer." and `clearUndoBufferOperations` exist; the buffer is migrated on a file-version upgrade (`migrate-undo-redo-buffer`) | wasm strings | CONFIRMED |

### 2.4 Buffers, staging and the debug dump

- There is a **primary** undo buffer and, while a "changes stager" is active (branch review, AI previews, staged
  edits), an **active** buffer that is not the primary one: "Active undo buffer is NOT the primary buffer (staging mode
  is routing to a different buffer)". Committing or rolling back the stager (`commit` / `rollback` / `keep_staging`)
  decides whether those steps reach the main history. CONFIRMED (wasm strings 32062, 26503).
- `dump-undo-history` (a debug action) prints: the four stack sizes, `canUndo`, `canRedo`, `hasScene`,
  `inPlaygroundMode`, `toolBlocksUndo (IMAGE_LASSO or RECOLOR)`, `isReadOnly(UNDO_REDO)`, "next undo would apply
  immediately from %s" or "%d batch(es) would be skipped …", and the warning "ALL %d batch(es) across both stacks are
  skippable … undo would drain everything with no visible effect". CONFIRMED (wasm strings 27486–27590, 32024–32062).
- Each history move logs "after commit / undo / redo, undo %d, redo %d, untainted undo %d, untainted redo %d" — so a
  commit, an undo and a redo each touch both the tainted and untainted pair. What taints a batch is stripped
  (canvas.md probe §5 #6). CONFIRMED names / INFERRED meaning.

### 2.5 Shortcuts and gates

| Action | macOS | Windows | Edit modes | Evidence |
|---|---|---|---|---|
| `undo` | ⌘Z | Ctrl+Z | GLOBAL, **not BRANCHING** | shortcut JSON in wasm |
| `redo` | ⇧⌘Z | Ctrl+Y, Ctrl+Shift+Z | GLOBAL | shortcut JSON in wasm |
| Touch | `TapToUndo`, `ThreeFingerSwipeToUndo` (iPad) | — | — | wasm strings |

### 2.6 Multiplayer

- Undo is per client: the stacks are local (`localUndoStack` is a client-side Message field), and an undo emits a
  normal NODE_CHANGES of the inverse values. Remote edits are not in your stack. CONFIRMED (schema, field name).
- Remote changes adjust the local history: "Undo / redo finished. Adjustments that should be passed to the next in the
  stack", collaborative-text `UndoAdjustment` (range in text, original content range), and the dangling-reference
  filter for nodes another user deleted. CONFIRMED (wasm strings 2143–2234, 33057).
- Widget subtrees have their own "[ChangeRegisters] Undoing creation of property register …" path. CONFIRMED.

### 2.7 Limits

| Item | Value | Status |
|---|---|---|
| Number of steps kept | not readable (no constant string) | open question 3 |
| Persisted history size | not readable | open question 3 |
| "Undo/redo history has fewer entries than expected" | an integrity check, no number | CONFIRMED string |

## 3. Saving: autosave, offline, recovery

Figma has no Save command for design files. Every committed change goes to the multiplayer server (journal + periodic
checkpoints, R2 §4) and, in parallel, unacknowledged changes are backed up in the browser's IndexedDB so they survive a
crash, a closed tab or going offline.

### 3.1 The local backup store (CONFIRMED, `3187.min.js` @2 179 716)

| Item | Value |
|---|---|
| Database | `figma-autosave-v3`, IDB version **4**; older `figma-autosave-v2` and `figma-autosave-darklaunch-v2` are deleted on start |
| Store `editor-sessions` (v1) | key `id` (auto-increment); unique index `session-index` on `[userID, fileKey, sessionID]` |
| Store `node-changes` (v1) | key `[editorSessionID, nodeID]` — one encoded node change per node (latest wins) |
| Store `saved-images` (v1) | key `[editorSessionID, hash]` |
| Store `referenced-nodes` (v1) | key `[editorSessionID, nodeID]` — library / referenced nodes needed to apply the changes |
| Store `new-files` (v3) | key `[userID, fileKey]` — files created offline: name ("Untitled" default), editorType, org / team, createdAt |
| Store `activity-log` (v4) | key `id` (auto-increment) — offline activity log |
| Open timeout | 6 000 ms ("Timeout when opening IDB"), up to 5 attempts; transactions retried up to 5 times |
| Errors treated as "storage unavailable", not bugs | QuotaExceededError, full disk, "not enough space for domain", read-only DB, DataError, internal backing-store errors, the timeout |
| Lock | one Web Lock per `autosave-{userID}-{fileKey}-{sessionID}`; a second tab of the same file cannot claim the changes ("Changes not available or already claimed by another tab") |
| Garbage collection | sessions older than **90 days** (`7776e6` ms) are deleted (`figma_app.min.js` @1 844 632) |
| Persistent storage | on restore, Chrome-family browsers call `navigator.storage.persist()` (race with a 200 ms timeout) |

### 3.2 Commits to the backup (CONFIRMED, `figma_app.min.js` @1 862 147)

| Item | Value |
|---|---|
| Who commits | the C++ `FGAutosave` flushes (`flushAutosave`, wasm action `FLUSH_AUTOSAVE = 69`); JS queues each commit in a serial transaction queue |
| Commit payload | changed nodes (encoded changes), cleared nodes, referenced nodes, image hashes, `fileVersion`, `commitPolicy`, `newSessionID`, `uncleanRegisters`, `reason` |
| Commit policy | `ADD_CHANGES = 0`, `REPLACE_CHANGES = 1` (`3187.min.js` @9 919 706) |
| Commit reason | `SYNCED = 0`, `OFFLINE = 1`, `SESSION_START = 2`, `FORCED = 3`, `LIMBOED_CHANGES = 4` (`figma_app.min.js` @7 287 857) |
| Back-pressure | the queue refuses new commits at ≥ 10 pending ("Autosave transaction queue is backed up.") |
| Consistency check | after a commit the number of stored node changes must equal the engine's unclean-register count; after a SYNCED commit IDB must be empty; a mismatch disables autosave for the session |
| Repeated adds | 4 consecutive ADD_CHANGES commits trigger an internal "Autosave Commit Changes" event |
| Failure | any IDB failure → "autosave disabled" for this session (logged once); editing continues online |
| Edit scopes | autosave runs in its own edit scope; "Autosave scopes are not allowed inside any other scopes" (wasm) |
| Offline activity tracking | on an OFFLINE / LIMBOED commit the tracker flushes to disk every **300 s** (`3e5`); on return online, if offline > **60 s**, the log is flushed once more (`3187.min.js` @2 179 709) |

### 3.3 Restore on load and offline sync (CONFIRMED, `figma_app.min.js` @1 868 234)

1. On opening a file, sessions for `(user, file)` younger than 90 days and not locked by another tab are collected.
2. If any has changes, Figma first creates a version-history savepoint labelled **"Offline sync"** with description
   **"Before syncing changes"** (skipped for local / offline-created files).
3. Node changes are applied in GUID order; nodes whose stored change decodes as empty are deleted from IDB.
4. With dynamic page loading, the containing pages of the changed nodes (and of any parentIndex changes) are loaded
   first.
5. Images are restored from `saved-images`, referenced nodes restored, then the changes are migrated to the current
   file version (`migrateAndSetAutosaveChanges`; "Autosave changes are newer than remote file version" is an error)
   and applied as an `autosave` permission scope (edit source tag `AUTOSAVE = 7`, short code "ASAVE").
6. A second savepoint is attempted after the sync; on success the toast **`autosave.changes_synced`** is queued at the
   front of the notification queue (type `AUTOSAVE_CHANGES_RESTORED`).
7. Read-only files never restore (`fileIsReadOnly()` guard).

Files with unsynced changes that are not open appear on Home: a stacked notification "`autosave.notification.message.one_file`"
(file name cut at **40 characters** + "…") or "`…more_than_one_file`" with actions **Open to sync** / **Review** /
**Later** (`7824.min.js`). The "has changes" modal shows an expiry line only in the last **5 days** of the 90-day window:
"`expiry_text_days`" (days = floor((90 d − age) / 1 d)), "`expiry_text_shortly`" under one day (`1a115cee.min.js` @9 889).
Logging out with unsynced changes opens `AutosaveLogOutModal` (Sync changes / Show changes / Discard / Discard and log
out). Opening a new offline file already open in another tab shows `autosave.file_already_open_modal`.

### 3.4 The save status (CONFIRMED)

There is **no "Saved / Saving…" label** in the editor. The status model (`3187.min.js` @8 855 386):

| Field | Meaning |
|---|---|
| `hasAutosaveChanges` | changes not yet confirmed in IDB |
| `hasMultiplayerChanges` | changes sent but not acknowledged by the server |
| `hasStagedChanges` | stager has uncommitted edits |
| `hasUnsavedChanges` | `hasAutosaveChanges || hasMultiplayerChanges` |
| `hasChangesBlockingNavigation` | `hasUnsavedChanges || hasStagedChanges` |
| `tabCloseText` | `NONE`, `DISCONNECTED_AUTOSAVE_DISABLED`, `DISCONNECTED_SERVER_ISSUES`, `DISCONNECTED_OTHER`, `SYNCING_AUTOSAVE_DISABLED`, `SYNCING_SERVER_ISSUES`, `SYNCING_OTHER` |

**Save-status icon** (toolbar, `data-onboarding-key="multiplayer-save-status"`, `9905.min.js` @449 870):

| Rule | Value |
|---|---|
| Poll | every **500 ms** |
| Shown when disconnected for longer than | **10 000 ms** (6 000 ms in one variant, gated by a hook not resolved here) |
| Shown when IDB changes are pending | longer than the threshold since max(first pending, last IDB commit), or **30 s** since they first appeared |
| Shown when server acks are pending | longer than the threshold since max(first pending, last ack), or **30 s** |
| Icon | "offline" glyph when not joined to multiplayer or the live-graph connection is down, else "unsaved" glyph |
| Tooltip | the `tabCloseText` string; when the live graph is down and nothing else applies, `unsaved_changes.disconnected.live_updates` |
| Aria label | `unsaved_changes.aria_label` |

**Toasts** (`3187.min.js` @1 071 556, @2 353 999):
- `hasUnsavedChanges` false → true starts a **60 s** timer (10 ms in e2e runs). When it fires, a persistent toast
  `save_status.unsaved_changes` with button `save_status.learn_more` (opens `AutosaveLearnMoreModal`) appears
  (`timeoutOverride: Infinity`).
- When everything is saved again the toast is dismissed; if it had been shown and the browser is online, a short
  `save_status.changes_saved` toast follows.
- The desktop shell is told `setSaved(!hasChangesBlockingNavigation)` for the tab; closing or reloading such a tab asks
  "You have unsaved changes" (Close Tab / Reload Tab), and closing the window or logging out while saving asks
  "Discard Unsaved Changes?" (desktop shell English, chapter 01 §2.8).
- Navigating away inside the web app with blocking changes shows `autosave.unable_to_leave_document.*` ("OK").

### 3.5 ⌘S

⌘S is **Wrap in new section** (`create-section-from-selection`, Ctrl+S on Windows; chapter 03). Nothing saves. The
"save reminder" toast (`showAutosaveVisualBell`, `7094.min.js` @423 852) is called from C++ — most likely when the
shortcut has nothing to act on (INFERRED). Its text (CONFIRMED):
- offline → `autosave.visual_bell.offline`;
- online with unsaved changes → `autosave.visual_bell.unsaved_changes`;
- online and all saved → one random prefix from ✓ ✔ 💾 👍 ✌️ 👋 😎 ⚡️, two spaces, then
  `autosave.you_dont_need_to_save_reminder`, shown at most once per **14 days** (`12096e5` ms, localStorage key
  `autosaveVisualBellLastTime`).
- Only for users who can edit the open file.

⌥⌘S is Save to version history (`create-savepoint`, chapter 16).

## 4. Save Local Copy (CONFIRMED, `3187.min.js` @3 139 170)

Menu: File › Save local copy… (`save-as`, flags `view_restricted !recovery !figspec`, hidden in integration hosts). If
the file has local variable collections a confirmation modal comes first (chapter 03).

| Step | Behaviour |
|---|---|
| 1 | Optional anti-abuse `POST /api/file_download_log/:key`; a 429 aborts |
| 2 | Wait until **all pages are loaded** (dynamic loading, reason `SAVE_LOCAL_COPY`); progress toast `save_as_actions.downloading_images` / `downloading_content` (online) or `cannot_download_images` / `cannot_download_content` (offline), with Cancel |
| 3 | A secondary button appears at once when offline, else after **20 000 ms**: `save_as_actions.save_without_images` (all pages loaded) or `save_as_actions.save_partial_file` |
| 4 | Spinner toast `visual_bell.saving`; the engine serializes (`attemptActiveDocumentSave`) → `canvas`, `thumbnail`, `clientMeta`, audio hashes |
| 5 | ZIP built with zip.js, no web workers, entries in this order: `canvas.fig` (stored, level 0), `thumbnail.png` (stored), `meta.json` (default deflate), `images/` (directory entry), `images/<sha1-hex>` (stored) for every image already in memory |
| 6 | Missing assets downloaded 5 in parallel with URL refresh: `images/`, `videos/`, `audios/` (+ `audios.json` MIME map), `blob_store/blob_store_references/…`, `make_binary_files/` (+ `make_binary_files.json`); then gated extras `ai_chat.json`, `make_repos.json`, `code_connect.json`, `code_context.json` |
| 7 | File name `"<file name><ext>"`; after a skip, `"<file name> - <save_partial_file_name_suffix {date}>"` with the locale date, `/` and `_` replaced by `-` |
| 8 | Errors: `visual_bell.save_as_error` |

`meta.json` (CONFIRMED in code and in the owner's file): `{client_meta: {background_color {r,g,b,a}, thumbnail_size
{width,height}, render_coordinates {x,y,width,height}}, file_name, developer_related_links: [], exported_at: ISO-8601}`.
The owner's file: thumbnail 293 × 400, `render_coordinates` 1152 × 1573, 425 ZIP entries, 344 MB.

## 5. The `.fig` container

### 5.1 Layout (CONFIRMED: reader and writer in the import worker, plus the owner's file)

| Offset | Size | Content |
|---|---|---|
| 0 | 8 | magic: `fig-kiwi` (Design), `fig-jam.` (FigJam), `fig-deck` (Slides), `fig-buzz` (Buzz), `fig-make` (Make), Sites' magic is obfuscated in code |
| 8 | 4 | uint32 LE version — **106** in the owner's 2026-10-15 export (`6a 00 00 00`) |
| 12 | 4 | uint32 LE length of chunk 0 |
| 16 | n | chunk 0: binary kiwi schema, **raw deflate** (owner's file: 30 049 → 75 243 bytes) |
| … | 4 + m | chunk 1: the `Message`, **zstd** (magic `28 b5 2f fd`) in Figma's own exports; deflate also accepted |
| … | 4 + k | optional further chunks: an 8-byte tag + payload; the PNG signature tag = thumbnail (at most one); unknown tags skipped |

| Reader rule | Value | Status |
|---|---|---|
| Max version accepted | **110** (`const bn=110`, worker @3 187 334); higher → "Unrecognized file version N" | CONFIRMED |
| Message length 0 | "Message is empty" | CONFIRMED |
| Compression detection | zstd magic `28 B5 2F FD`, else raw deflate | CONFIRMED |
| Bare `canvas.fig` vs ZIP | the first 20 bytes decide: ZIP → "fig-zip", else "fig-kiwi" | CONFIRMED (chapter 15) |
| The container version and the schema | **independent**: the same version 106 has carried at least three schemas (558 and 637 definitions in R2's samples, 653 now) | CONFIRMED |

### 5.2 What the importer requires and rewrites (CONFIRMED, worker @3 195 857)

Required, or the import fails:
1. A known magic; version ≤ 110; non-empty schema and message chunks.
2. `message.type == NODE_CHANGES` ("Invalid message").
3. Every NodeChange has a `guid` ("Invalid GUID").
4. Every `parentIndex` has a `guid` and a `position` matching `^[ -~]*[!-~]$` — printable ASCII that does **not end
   in a space** ("Invalid parent index").
5. No cycles in the parent chain ("Cyclic parent chain").

Rewritten on the way in:
- Strings cut at the first NUL (with a console warning).
- GUIDs other than `4294967295:*` raise `maxSessionID`, which the new file's sessions start above.
- Deleted from every node: `sharedComponentMasterData`, `publishedVersion`, `libraryMoveInfo`, `libraryMoveHistory`.
- Legacy auto layout padding: `stackPaddingTop` → `stackVerticalPadding`, `stackPaddingLeft` → `stackHorizontalPadding`
  when the new field is absent.
- Legacy embedded images (`paint.image.dataBlob` into `message.blobs`) are pulled out, SHA-1-named and uploaded; the
  blob bytes are emptied.
- Defaults filled for missing fields (chapter 15 §14.2: name "Object", visible, opacity 1, identity transform, 100 ×
  100, fills #DADADA, text Roboto Regular 12 …); `vectorData.normalizedSize` defaults to `size`.
- The message is **re-encoded with the build's own schema** and written back with the **original version number**
  and the build's compressed schema (`Bn`). Fields unknown to the build are dropped; an optional round-trip check
  reports them: "⚠️ This file could not be fully imported. Some data was discarded and the file may be corrupt." plus
  "· <field> discarded" lines.
- `message.originFileKey` (field 47) becomes the import's `originLibraryKey`; `customToolArtifactRef`s are collected.

Images of a ZIP import are uploaded 5 at a time to `/api/upnode/image?purpose=canvas&sha1=…`; only PNG, JPEG and GIF
(sniffed) are accepted, others skipped with a warning. HTTP 413 counts as oversized, 400 as invalid; other failures
retry 3 times with backoff 1 s · 2^n plus jitter, doubled for 429 / 503. Results: toasts
`fullscreen.file_import.oversized_files_images_exceeded_max_size {oversizedFiles}` and
`fullscreen.file_import.import_invalid_images {invalidFiles}`. Any other failure deletes the half-created file
(`DELETE /api/files_batch`). (`figma_app.min.js` @2 093 242)

What is needed beyond this for the editor to **open** the result is server- and wasm-side and not readable here. The
wasm has the guard "Buffer file version is lower than scene version, blocking import" and Rust file migrations
(`fpm`, `s2`, `s2_a`, `text_source_of_truth`, `text_separate_derived_text_data`, `component_props_variable_value`,
`moonlit_lily_repair`, `sensitive_sticker`), so a file written at an older version is migrated on load. INFERRED.

### 5.3 The schema in this build compared with the repo's copies

The import worker embeds the build's binary schema (`mn`, 75 243 bytes, 653 definitions, worker @2 945 940). Decoded
and compared (CONFIRMED):

| Comparison | Result |
|---|---|
| Build schema vs the owner's 2026-10-15 export (chunk 0) | **byte-identical** (SHA-1 `fa9d0e75…dcfd` both) |
| Build vs `docs/research/figma/figma-schema-106.kiwi` (sections.fig, 2026-08-24, 637 defs) | 16 new definitions, no removals, no renumbering; NodeChange 610 → **616** fields |
| Build vs `docs/research/figma/figma-schema.kiwi` (grida, 2025-12, 526 defs) | 127 new definitions; NodeChange +86 fields; Message +6 |
| Build vs `schema/document.kiwi` | ours: 227 NodeChange fields up to 594 (plus reserved `_rN`); Figma's: 616 up to 616 |

New since the 106 sample (August → October 2026):

| Kind | Name | Fields / values |
|---|---|---|
| NodeChange | `previewRasterSnapshot` 611, `codePreviewState` 612, `audioBeatAnalyses` 613, `nativeCodeSlotId` 614, `attachedCodeSources` 615, `behaviorAttachments` 616 | — |
| Message | `changeSetIdentifiers` 49 | `ChangeSetIdentifiers {clientLifecycleId 1, toolCallId 2}` (AI tool-call attribution) |
| Paint | `videoFillPlayback` 47 | `VideoFillPlayback {startTimeMs, endTimeMs, timelineOffsetUs, playbackDurationUs, loopPhaseOffsetUs, volume, mute}` |
| ExportSettings | `pdfPrint` 18 | — |
| AuthoredColor | `c4` 6; `ColorSpace.CMYK = 7` | CMYK colours |
| BlendMode | `UNSET = 19` | — |
| Variables | `VariableDataType.UNIT_NUMBER = 36`, `VariableResolvedDataType.UNIT_NUMBER = 29`, `VariableAnyValue.unitNumberValue` 34; `UnitNumber {value, unit}`, `Unit {AUTO, PIXELS, PERCENT, REM}` | unit-bearing number variables |
| VariableField | `TRANSFORM_3D_ROTATION_XYZ` 77, `STACK_CHILD_MARGIN_TOP/RIGHT/BOTTOM/LEFT` 78–81, `TIMELINE_DURATION` 82 | — |
| Text | `LineType.CHECKLIST = 5`, `TextLineData.isLineChecked` 11, `DerivedTextData.checklistMarkers` 13 (`ChecklistMarker {bounds, styleID, lineIndex, isChecked}`) | checklists |
| Motion | `TextElementDelayBehaviour` +`clipContent`, `transformOriginMode`, `transformOrigin`; `TextElementTransformOriginMode {MATCH, CHARACTER, WORD, LINE, PARAGRAPH}`; `KeyframeValueType.ROTATION_3D`; `TimelineData.durationUsVar`; `StyleIdForAnimation.timelineOffsetVar` | — |
| Audio | `AudioFill` +8 (`sourceDurationUs`, `bpm`, `beatOffsetUs`, time signature, `beatConfidence`, `volumeVar`, `timelineOffsetVar`); `AudioBeatAnalysis`; `AudioParametrizedField {MISSING, GAIN, TIMELINE_OFFSET}` | — |
| Behaviors | `BehaviorAttachment {attachmentId, behaviorId, revision, propAssignments[], enabled, isDeleted}`, `BehaviorPropAssignment` (11 typed values), `BehaviorTimelineReference`, `BehaviorTimingValue` | — |
| Code / Make | `CodePreviewState {route}`, `CodeSource {id, type}`, `CodeSnapshot.capturedRoute` 10, `CodeSnapshotState.BUILD_ERROR = 6`, `ToolData.nodePropAssignments`, `ComponentPropType.NODE = 18`, `ComponentPropPreferredValues.parameterValues` 3 | — |
| Other | `AgentActivityStatus.COMPLETED = 2`, `NodeChatExchange.sessionId` 5 | — |

Message fields relevant to files and undo (all CONFIRMED in the build schema): `fileVersion` 18 (autosave migration),
`localUndoStack` 22, `localRedoStack` 23, `encodedOffsetsIndex` 34 (partial decode), `undoBatchPageIds` 46,
`originFileKey` 47, `nodeChangeOrder` 48, `changeSetIdentifiers` 49.

## 6. Memory limits and "too large" flows

### 6.1 Memory (CONFIRMED, `figma_app.min.js` @2 444 730, `3653.min.js` @195 739, `5741.min.js` @1 929 953)

| Item | Value |
|---|---|
| Usage % | `mallocLevelBytes / heapMemoryLimit × 100`, clamped 0–100, rounded to 2 decimals; polled every **5 s** |
| Limit | `getHeapMemoryLimit()` from the engine; help site: 2 GB per tab, Wasm memory max 4 GiB (R1) |
| Warning level enum | `SAFE = 0`, `ERROR = 1`, `OOM = 2` |
| Threshold | **≥ 90 %** → level ERROR; on the first crossing `handleHighMemoryUsageThresholdReached()` runs (engine frees what it can) and analytics `memory_threshold_crossed`; below 90 % the counter resets |
| OOM | a dedicated state (level 2) when the engine reports out of memory ("Ran out of memory") |
| Guarded operations | `$m(op)` refuses to run an operation when usage ≥ 90 % or crosses during it (returns `highMemoryThresholdReached`) — used by branching merge / update (chapter 16 "low memory") |
| Heap memory modes | `LEGACY 0`, `DEFAULT 1`, `MERGE_MODAL 2`, `LOAD_ALL_PAGES 3`, `RECOVERY 4`, `MAXIMUM 5` (`figma_app.min.js` @7 164 682) |
| Usage bar | Pages panel, size md, max 100, a mark at **90** labelled `memory_usage_limit`; the % text shows only with `showSidePercentage`, "danger" variant at ERROR |
| Panel text | ERROR: header `memory_usage_almost_out_of_memory` (or `memory_usage_recovery_mode_high` in recovery), body `memory_usage_to_avoid_losing_file_access` / `…_error_contact_file_owner` (viewer) / `…_read_only_view_version_history` / `…_error_edit_view_version_history`, link "Reduce memory usage in files" (help 360040528173). Back to SAFE after a warning: `memory_usage_youre_good_to_go` + `memory_usage_this_file_has_enough_memory` (recovery: `…_recovery_mode_low`) |
| Manage memory modal | `manage_memory_modal.*`: total memory used, page content %, imported components %, total layers, "Show memory in layers panel" (per-layer memory) |
| Out-of-memory modal | cannot be dismissed. Read-only file or already in RECOVERY mode → **Reload** (`memory_warning_modal.reload_*`); otherwise **Open in recovery mode** (`recovery_mode_*`), which reopens the file with `isRecoveryMode: true` |
| Recovery mode | the `recovery` menu flag: Save local copy, Save to version history, branching and more are disabled (chapter 03 / 16) |
| Desktop tabs | the shell shows "Memory usage: {memory}MB/GB" and "Offloaded tab: {memory}MB freed up" on tab previews (chapter 01) |

### 6.2 Size limits seen in this area

| Flow | Limit / behaviour | Status |
|---|---|---|
| `.fig` import images | server answers 413 → counted as "oversized"; the byte limit is server-side | CONFIRMED (flow) / open (number) |
| Community upload | S3 `EntityTooLarge` → `community.actions.file_too_large` | CONFIRMED |
| Library publish | `design_systems.publish_actions.payload_too_large` | CONFIRMED |
| Sites fonts | 25 MB (`file_size_is_over_limit_of_25_mb…`) | CONFIRMED |
| PDF import | 50 MB (chapter 15) | CONFIRMED there |
| Comments media | `comments.upload_error.media_file_size_limit_MB` (chapter 16) | CONFIRMED there |
| A `.fig` file's own size | no client limit found; the owner's 344 MB file exports fine | INFERRED |

## 7. Duplicate

- File menu **Duplicate** (`duplicate-file`, flags `!integration !figspec`, gate `uxp_make_a_copy`); for Make files with
  a payload backend it is a submenu (backend only / entire CMS). Also `duplicate-file-to-your-drafts`,
  `duplicate-branch-as-new-file`. CONFIRMED (`858.min.js`).
- The copy's default name is the original followed by " (Copy)" (stated in the build's MCP tool description). CONFIRMED.
- Duplicating is a server operation; history and comments are not copied (help site; R2 §5 says the same for local
  copies). INFERRED for duplicate.

## 8. UI strings

English is given where attested: **[D]** desktop shell bundle (chapter 01 capture), **[H]** help site via R1/R2, **[R]**
repo. Everything else is an i18n key only.

- Desktop dialogs [D]: "You have unsaved changes"; "Closing the tab won't lose your changes, but you'll have to
  reconnect to sync the changes."; "Close Tab"; "Reload Tab"; "Discard Unsaved Changes?"; "Changes are currently being
  saved. Your changes will be lost if you close …"; "Close Window & Discard Changes"; "Log Out & Discard Changes";
  "Saving file failed"; "Save Local Copy…"; "Memory usage: {memory}MB"; "Offloaded tab: {memory}MB freed up".
- Save status: `save_status.unsaved_changes`, `save_status.changes_saved`, `save_status.learn_more`,
  `unsaved_changes.aria_label`, `unsaved_changes.disconnected.{autosave_disabled, server_issues, other, live_updates}`,
  `unsaved_changes.syncing.{autosave_disabled, server_issues, other, access_revoked, app_out_of_date,
  changes_cannot_be_saved, experiencing_server_issues, logged_out, too_many_people_in_file, unsaved_not_logged_in,
  unsaved_revoked_access, updating_the_app, the_main_component_has_been_deleted, …}`, `reconnecting_modal.loading`.
- Autosave: `autosave.changes_synced`, `autosave.visual_bell.offline`, `autosave.visual_bell.unsaved_changes`,
  `autosave.you_dont_need_to_save_reminder`, `autosave.learn_more.{title, body_save_pending_changes,
  body_use_version_history, done_button}`, `autosave.unable_to_leave_document.{title, pending_changes,
  unsaved_changes_save_in_background, ok_button}`, `autosave.has_changes.{unsaved_changes_to_file,
  unsynced_changes_offline, sync_offline_changes, open_to_sync, dismiss.later, expiry_text_days, expiry_text_shortly}`,
  `autosave.notification.{message.one_file, message.more_than_one_file, action_open_to_sync, action_review,
  action_later}`, `autosave.logout.{log_out, log_out_text.desktop, log_out_text.web, offline_changes,
  offline_changes_synced, offline_changes_discarded, sync_changes, show_changes, discard, discard_and_logout, cancel}`,
  `autosave.file_already_open_modal.{title, body}`, `tile.offline_file_tile.offline_created_file`,
  `file_browser.confirm_file_delete_modal.{offline_files, warning_unsynced_file}`. Version-history labels written by
  sync: "Offline sync" / "Before syncing changes" (literal English in code).
- Save local copy: "Save local copy…" [R, live menu], `save_as_actions.{downloading_images, downloading_content,
  cannot_download_images, cannot_download_content, save_without_images, save_partial_file,
  save_partial_file_name_suffix, export_without_images, export_without_content, cancel}`, `visual_bell.saving`,
  `visual_bell.save_as_error`.
- Import: "⚠️ This file could not be fully imported. Some data was discarded and the file may be corrupt." (literal),
  "Unrecognized file version {n}", "Invalid file header", "Message is empty", "Invalid GUID", "Invalid parent index",
  "Cyclic parent chain" (literal, developer-facing), `fullscreen.file_import.oversized_files_images_exceeded_max_size`,
  `fullscreen.file_import.import_invalid_images`.
- Memory: `fullscreen.pages_panel.memory_usage`, `memory_usage_limit`, `memory_usage_almost_out_of_memory`,
  `memory_usage_to_avoid_losing_file_access`, `memory_usage_error_contact_file_owner`,
  `memory_usage_read_only_view_version_history`, `memory_usage_error_edit_view_version_history`,
  `memory_usage_youre_good_to_go`, `memory_usage_this_file_has_enough_memory`, `memory_usage_recovery_mode_{high, low,
  high_content, low_content}`, `memory_usage_learn_more`; `manage_memory_modal.{manage_memory_modal_title,
  manage_memory_button, total_memory_used, page_content, imported_components, total_layers,
  show_memory_in_layers_panel, show_memory_in_layers_panel_warning}`; `memory_warning_modal.{reload_modal_title,
  reload_modal_content, reload_modal_content_cta, reload_page_button, recovery_mode_modal_title,
  recovery_mode_modal_content, recovery_mode_modal_out_of_memory, recovery_mode_button, learn_more, help_center,
  memory_reduction_tips_modal_title, memory_reduction_tips_{break_files, clean_layers, flatten_shapes,
  trim_components}(_header)}`.
- Duplicate: `fullscreen_actions.duplicate-file`, `duplicate-file-to-your-drafts`, `duplicate-branch-as-new-file`,
  `file_browser.file_browser_actions.duplicate_file_error`.

## 9. DesignerV2 today

Compared with `engine/src/editor/Undo.{h,cpp}`, `schema/document.kiwi`, `src/shared/fig/{container,figFile,figmaExport}.ts`,
`src/store/localStore.ts`, `src/main/{files,tabs,window}.ts`, `docs/data.md`, `docs/desktop.md`.

**Matches**
- One step per transaction; scrub drags commit at the end; plugin `commitUndo` splits (canvas.md §2.4).
- `localUndoStack` 22 / `localRedoStack` 23 un-reserved, `engine_undo_export` / `engine_undo_import` exist (commit
  7bace331); keeping them in the store is still to do.
- ⌘S is Wrap in new section (`WRAP_IN_SECTION`), ⌥⌘S saves a version.
- Save local copy writes `canvas.fig`, `thumbnail.png`, `meta.json`, `images/`, `images/<hash>` in Figma's order;
  header `fig-kiwi` + 106, deflate schema + zstd message (`figmaExport.ts`).
- Local durability is stronger than Figma's IDB backup (store journal, fsync ≤ 1 s, docs/data.md §5), so a "restore
  unsynced changes" flow is not needed while files are local.
- A memory chip exists (View › Memory usage) and an out-of-memory crash page (docs/desktop.md).

**Differs**
- Undo cap: ours 1 000 batches (`kMaxBatches`) and key-repeat nudges merge (`mergeWithLast`); Figma's cap and nudge
  rule are not read (open questions 1, 3).
- Pages: ours restore the page from the selection; Figma stores `undoBatchPageIds` (Message 46, still `_r46` in ours).
- Export schema: ours is a subset of the 106 sample schema (637 defs). Figma's importer decodes with the file's schema
  and re-encodes with its own, so a subset is valid; the schema Figma writes today has 653 definitions.
- ZIP entry compression: Figma stores everything at level 0 except `meta.json` (deflate); ours stores every entry
  (`zip.ts`) — harmless, the reader accepts both.
- Tab "unsaved" dot: Figma's desktop marks a tab only while changes are unacknowledged (`setSaved`); ours tracks our
  own flush state — equivalent while local.

**Missing**
- Undo skip of invisible batches, dangling filter, edit-mode restore, ignore-undo scope (canvas.md §2.4 build steps).
- Undo history kept per device in the store (canvas.md §2.18 step 16).
- The save-status icon and the 60 s "unsaved changes" / "Changes saved" toasts (needed once multiplayer lands; with
  the store they would key on journal acknowledgement).
- The "you don't need to save" toast for ⌘S with nothing selected (14-day throttle).
- Save local copy: the all-pages wait, the 20 s skip / partial-file name, `developer_related_links` in `meta.json`.
- Memory model: % of the engine heap limit with the 90 % mark, the ERROR / OOM states, refusing heavy operations above
  90 %, the warning panel, the Manage memory modal, recovery mode.
- Offline-sync savepoints ("Offline sync" / "Before syncing changes") — relevant only once files sync to the server.
- The importer's rewrites that ours may lack: drop `publishedVersion` / `sharedComponentMasterData` /
  `libraryMoveInfo` / `libraryMoveHistory`; the stackPadding legacy mapping; the trailing-space rule on positions;
  the cycle check (verify in `src/shared/fig/convert.ts`).

### As built (2026-10-18, wave 6)

Built from the lists above. Code: `engine/src/editor/{Undo,Editor}.cpp`, `engine/src/scene/CodecKiwi.*`,
`schema/document.kiwi`; `src/store/local/{undoHistory,fileStore}.ts`, `src/renderer/src/store/documentSource.ts`,
`editor/persistence.ts`; `editor/{saveStatus.ts,SaveStatusIcon.tsx}`, `src/store/multiplayer/service.ts`;
`editor/objectCommands.ts` (Save local copy), `src/main/files.ts`, `src/store/export/fig.ts`.

- **`undoBatchPageIds` 46 (§2.3).** Schema: Message's reserved 46 is `GUID[] undoBatchPageIds` again (Figma's number;
  `npm run engine:gen`, `schemagen --check` 0 problems — **the one schema change of this round**). Each undo step keeps
  the pages its changes were on when it was made (a removal its parent's page, a page's own change none, the internal
  canvas never; a merged step the union), the redo step the same; an undo or redo with nothing selected goes to the
  first of them; a step without them (an older history) falls back to the replayed changes' pages. The undo history's
  Messages carry them (native `w6 undo history`, wasm `engine.wasm.test.ts`).
- **The undo history across sessions (§2.1, canvas.md §2.18).** Exported as the editor goes (100 steps, 16 MB), written
  by the store when the source closes after its last flush — `files/<key>/undo.kiwi`, `"WUH1" | headSeq | bytes`, per
  device — and taken back after the next load while the journal head is the same (docs/data.md §5.7). Labels and
  selections don't travel (as before).
- **Commit modes instead of time windows (§2.2).** Nothing to remove: the engine groups by commits already (a panel
  scrub is one step, a text session one step whatever its pauses, held-arrow nudges one step); docs/engine.md §9.4's
  "1.5 s" was never built and now says so. The skip of invisible batches and the dangling filter were built in the
  REA round (docs/engine.md §9.3), before this list was written.
- **The save status (§3.4).** No "Saved" label. Polled every 500 ms: the offline icon when a shared file's link has
  been down past 10 s; the unsaved icon when changes wait for the store (the source's unacknowledged appends) or for
  the room (`FileShareState.unacked`, frames sent and not acknowledged) more than 10 s since they began or the last
  acknowledgement, or 30 s in all; the tooltip says which. 60 s after changes start waiting (edits made while the
  link is down count): "You have unsaved changes" until they're saved, Learn more; then "Changes saved" when it was
  shown and the file is online. The icon takes the old offline dot's place. (Figma's English for these isn't read:
  question 10.)
- **⌘S (§3.5).** With nothing to wrap in a section: offline → the offline text; unsaved → "Your latest changes are
  still being saved."; else one of Figma's eight prefixes, two spaces and "You don't need to save…", at most once in
  14 days (localStorage `autosaveVisualBellLastTime`); editors only.
- **Save local copy (§4).** A shared file whose images are still coming down: "Downloading images…" with Cancel (×
  cancels too) while they arrive (polled each second); offline at once, else after 20 s, "Save without images", which
  saves `"<name> - partial copy <date>"` (the locale date's / and _ as -) without the missing ones
  (`files.missingImages`, `exportLocalCopy({partial})`). Every page is always loaded here, so Figma's other step (wait
  for all pages) has nothing to wait for. `meta.json` already had `developer_related_links: []`.

**Not done:** an offline backup beyond the journal (the store's journal is the local backup; Figma's "Offline sync" /
"Before syncing changes" savepoints belong with Phase 6's server side); the edit-mode restore and the ignore-undo
scope; the memory model (heap %, OOM states, Manage memory); the importer's rewrites (`convert.ts`, the import
agent's); the desktop shell's `setSaved` per tab (our tab dot follows the flush, equivalent while local).

**Sweep (2026-10-18)** — branch `worktree-agent-a44e0af86efbcac0b`.

- **The ignore-undo scope (§2.1, Figma's `openIgnoreUndoRedoScope` / `closeIgnoreUndoRedoScope`):** `Editor::openIgnoreUndo` / `closeIgnoreUndo` (nesting; one close too many does nothing): writes go into the document and the transaction's changes but leave no inverse in any history — no step of their own, and none joined to the step open around them. ABI `engine_ignore_undo(h, open)`, TS `Engine.ignoringUndo(fn)`. Native `atlas.undo_scope.test.cpp`.
- **The edit mode restored with the step (§2.3, "update-edit-mode-for-undo"):** a user step remembers the layer vector edit mode had when it was made (`UndoBatch::editVector`, carried to the redo side and through merges); undoing or redoing it goes back into vector edit mode on that layer when it is on the current page and no text is being edited. A step made outside the mode leaves the mode as it is (Figma's exit rule isn't read). Not exported with the history (as labels and selections).

**Still not done:** text edit mode restored on undo (whether Figma re-enters text editing isn't read); the memory model (heap %, OOM states, Manage memory); the importer's rewrites; an offline backup beyond the journal and the Offline-sync savepoints (Phase 6); the shell's `setSaved`.

**Phase 6 (2026-10-18, `docs/multiplayer.md` §18.1):** the "Offline sync" / "Before syncing changes" savepoint of a shared file — the room's head kept as a named version before changes made away from it are sent (a link's first connection with changes waiting, or after 60 s offline). The second savepoint after the sync isn't made.

## 10. Open questions

| # | Question | Probe that settles it |
|---|---|---|
| 1 | Do held arrow-key nudges (auto-repeat) make one undo step or one per repeat? Does ⇧+arrow differ? | Hold → for 2 s on a rectangle, then ⌘Z once; read X |
| 2 | How are typed characters grouped for undo (per word, per pause, per text-edit session)? | Type "hello world", pause 2 s, type "again", press ⌘Z repeatedly and record the text after each press |
| 3 | Maximum undo depth and persisted depth | Make 200 nudges with ⇧→ (each committed), then hold ⌘Z and count; reload the tab and check whether undo still works |
| 4 | Is selection restored by undo / redo, and is a page switch alone ever undone? | Select A, move it, select B, ⌘Z: which layer is selected after? Move on page 2, switch to page 1, ⌘Z |
| 5 | When exactly does C++ call `showAutosaveVisualBell` (⌘S with an empty selection? File menu?) | Press ⌘S with nothing selected, online, and read the toast; repeat within 14 days |
| 6 | The second disconnection threshold (6 s vs 10 s) and which state picks it | Disconnect Wi-Fi in a file and time the icon's appearance in desktop and browser |
| 7 | Server-side size limits: max `.fig` import size, max image bytes (413) | Import a `.fig` with a 60 MB PNG; import a > 2 GB `.fig` |
| 8 | Does Figma open a `.fig` whose schema is a strict subset and whose version is 106 but which lacks derived data (`derivedSymbolData`, text glyphs, `fillGeometry`)? | Export from DesignerV2, import in Figma desktop, watch DevTools console for "discarded" lines and the editor for missing render |
| 9 | Heap limit value per memory mode (`getHeapMemoryLimit` in DEFAULT vs RECOVERY vs MAXIMUM) | In a file, run `fullscreenValue`-side `getHeapMemoryLimit()` from DevTools in each mode, or read the Manage memory modal totals |
| 10 | English text of the `autosave.*`, `save_status.*`, `memory_*` keys | Load the English bundle or capture the UI (toast, modals, panel) |
