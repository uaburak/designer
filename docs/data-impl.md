# Data layer — as built

Contracts: `docs/data.md` (store, workspace, journal, versions, libraries, Firebase), `docs/schema.md` + `schema/document.kiwi` (document schema; it wins where they differ), `docs/desktop.md` §1/§9/§10.2 (store port).

---

## Status at handoff (2026-10-06, round 2)

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | passes (both projects) |
| `npm run lint` | 0 problems in data-layer files (4 errors in `engine/tools/fixtures.mjs`, the engine workstream's, at the time of writing) |
| `npm test` | 399 of 399 passed at the time of writing; **the data layer's 19 files / 113 tests** all pass |
| `npm run engine:gen -- --check` | 183 definitions, NodeChange 194 live of 1,001 fields, 1,489 Figma parity checks, **0 problems** |

Data-layer tests (`npx vitest run src/store src/shared/schema src/shared/fig src/shared/store src/renderer/src/store`), round 1 files unchanged (76 tests) plus:

| File | Tests | Covers |
|---|---|---|
| `src/renderer/src/store/__tests__/documentSource.test.ts` | 6 | engine JSON ⇄ kiwi (GUIDs, unknown fields, clears); **open → append → close → reopen sees the changes** (real `StoreClient` over a MessageChannel to the in-process store); batch kinds; store restart mid-edit; refused appends reach `flush`/`onError`; rename/move/trash from elsewhere; remote frames via `onExternalChanges`; named version, restore as one `restore` batch, UI state, thumbnail, duplicate version |
| `src/renderer/src/store/__tests__/devStore.test.ts` | 5 | the seeded demo workspace; Home's operations and their events (same rules as the store); the editor's DocumentSource on the dev store, persisted across a "reload"; two pages following each other's writes; reset |
| `src/renderer/src/store/__tests__/client.dom.test.ts` | 2 | happy-dom: the port handover (`designer:store-port-wanted`, origin/source/type checks, generations, stale ports) |
| `src/store/sync/fieldCodec.test.ts` | 5 | node documents: value mapping, `$b`/`$blob` bytes, blob-index rebasing, `$kiwi` spills (> 20 levels, > 900 KB), derived/unknown refused |
| `src/store/sync/lww.test.ts` | 8 | `coalesce`, `planPush` (newer remote, remote delete, local tombstone, CREATED replace), `planPull` (clears, tombstones), `mergeRecord` |
| `src/store/sync/replicator.test.ts` | 4 | off unless config **and** enabled; push of records + nodes + schema, idempotent; **two devices converge** (field LWW, delete, image blob up and down, records, remote frame reaches the open editor); backoff 2 s → 4 s → 8 s … and recovery |
| `src/store/import/figBytes.test.ts` | 4 | `files.importFigBytes` over a Home port for the 3 samples (same table as the path import), bare canvas named after the dropped file, Drafts default, FigJam/garbage/trashed folder refused; the dev store's import is in `devStore.test.ts` (deflate sample without zstd, zstd samples with an injected decoder) |
| `src/store/compactor.test.ts` | 2 | **the worker compactor**: the store bundle (built with esbuild in the test) as a worker thread, same result as inline; errors cross back |

The dev store was also run in headless Chrome (esbuild bundle of `src/renderer/src/store/index.ts`, no Node imports): seeded lists, thumbnails as object URLs, open/edit/close, the edit still there after a reload.

### Done

1. **Round 1** (unchanged): generator + TS codec, shared schema runtime, `.fig` container/converter, the store (workspace, files, journal, recovery, compaction, versions, blobs, libraries, import/export), RPC server/client.
2. **Store-backed `DocumentSource`** — `src/renderer/src/store/documentSource.ts`, `openStoreDocument(store, fileKey, opts)` (any `StoreApi`: the renderer's `StoreClient`, or a `LocalAdapter` in tests). Loads snapshot + journal merged into one snapshot (`mergedDocument`), appends each change as a `ChangeBatch` (batchSeq per session; `kind` from the engine's USER/UNDO/REDO/SYSTEM, "Restore version" → `restore`; `blobRefsAdded` from image hashes), `flush`, `rename`, `close`; `onExternalChanges` (other sessions' and sync's frames), `onMetaChanged` (renamed/moved/trashed/deleted elsewhere), `onError`; thumbnails, debounced UI state, versions (`saveVersion`, `listVersions`, `updateVersion`, `openVersion`, `restoreVersion(id, apply)`, `duplicateVersion`). Records the file in Recents on open (option). `engineMessage.ts` converts the engine's interim JSON (string GUIDs) to kiwi and back, schema-driven.
3. **Browser dev store** — `src/renderer/src/store/devStore.ts` + `memory/`: a real `StoreClient` over a MessageChannel to the **same `StoreServer`** the utility process runs, backed by `MemoryStore` (workspace rules = the store's own `WorkspaceModel`; files with snapshot + journal, sessions, lock, dedupe, subscriptions, versions, restore diffs, thumbnails, UI state; libraries with the store's own rules (item 9); previews answer empty/`offline`; `.fig` paths `forbidden`), persisted in localStorage one record per key (`designer.devStore.v1.*`) so Home and an editor in two browser tabs share it (`storage` events → workspace events). Seeded on first use (`memory/seed.ts`): folders Client work › Archive, Personal; files Landing page, Wireframes (Drafts), Mobile app, Logo explorations, Old poster, Scratch (in Trash); SVG thumbnails; a starred file and folder; Recents; a named version.
4. **One entry point** — `src/renderer/src/store/index.ts`: `getStoreClient()` (desktop client under the preload, else the dev store; `?store=dev|desktop` forces), `thumbnailUrl(file)`, `openDocument(fileKey, opts)`, plus re-exports (types, `StoreError`, `FOLDER_COLORS`, …).
5. **`WorkspaceModel`** (`src/shared/store/workspaceModel.ts`): the workspace index and Figma's file-browser rules moved out of `LocalWorkspace` (which now only adds the JSON files and start-up repair) so the dev store runs the identical code; `adopt*`/`drop*` take records written elsewhere (sync pulls, other pages). `Emitter`/`SerialQueue` moved to `src/shared/store/` (re-exported from the old paths).
6. **Sync** — `sync/firestoreAdapter.ts` (records merged on `_clk` in transactions; node documents per property with `_clk/_t/_del/_dev`, ≤ 100 per transaction, images and spills uploaded first; pull by `_t` cursor → one change Message; images downloaded into the local blob store), `sync/replicator.ts` (2 s loop, records → push → pull, backoff 2 s–5 min, `pushedSeq`/`pullCursor` in store.json, first push / compacted gap pushes the whole head, `remote` frames never pushed back, status events), `sync/clocks.ts` (per-field clocks), `startSync(store, {enabled, idToken|uid, drivers?})` → null unless `firebase/config.json` is valid **and** `enabled`. `LocalStore` gained `hlc`, `timers` (public) and `replicator`; `store.info().sync.enabled` reflects it; `shutdown()` stops it.
7. **Worker compactor** verified as built (see the test).
8. **`.fig` import from bytes** — `files.importFigBytes(bytes: Uint8Array, name: string, folderId?: FolderId | null): Promise<FileMeta>` (home/editor/main; not retry-safe). The import itself moved to `src/shared/fig/importFig.ts` (sync codecs for the store, `prepareFigImportAsync` for the browser: DecompressionStream, crypto.subtle, the CSP-safe interpreting codec); `importLocalCopy` now goes through the same path. Name: the .fig's `meta.json` `file_name`, else `name` without ".fig". **In the browser, zstd-compressed files (2 of the 3 samples; Figma's newer files) need a decoder**: `createDevStore({ zstdDecompress })` — none is wired, since adding one (e.g. the `fzstd` package, ~8 KB) is a `package.json` change; without it they fail with `unsupported-format`.
9. **Libraries in the dev store and the editor's view of them (2026-10-07, editor round 7)** — the registry's rules (what a publish creates / modifies / removes / moves, a consumer's diff, counts, shape checks, moves → redirects, `withDependencies`) moved out of `src/store/local/libraries.ts` into `src/shared/store/libraryRules.ts`, which `LocalLibraries` (files on disk) and the dev store's new `src/renderer/src/store/memory/memoryLibraries.ts` both run. `MemoryLibraries` keeps records (`lib.<lib>`), complete manifests (`libver.<lib>.<n>`) and per-asset-version payloads (`libasset.<lib>.<key>.<hash>`, written once) in the same localStorage, thumbnails as blobs; a publish in one tab is a `published` event in another (the storage event of a record); trashing follows the file, deleting the file forgets its versions and payloads (`status: "deleted"`). `MemoryStore.addVersion` takes `libraryVersion` (the "publish" history entry). The editor's side: `src/renderer/src/store/libraryAccess.ts` — `DocumentSource.libraries` for an open store file: the registry with this file's key filled in, payloads converted engine JSON ↔ kiwi (`messageToKiwi` / `messageToEngine`), library names and folders from the workspace, and the file's own enabled list / folder followed (`enabled`, `moved` notices). Tests: `store/__tests__/memoryLibraries.test.ts` (publish versions, created / modified / removed, payloads with dependencies, diffs, Move to this file vs Publish as a copy, cross-tab events, forget on delete), and the editor's `libraries.wasm.test.ts` end to end over it.

10. **Libraries — review fixes (2026-10-07)** — `libraryRules.ts`: `diffAgainst` answers once per asset however many copies of it a consumer holds (Update selected instance leaves two of one key: `have` repeats the key), and a redirect another library recorded wins over the old library's manifest, so its consumers see "Moved" as soon as the new library publishes (§9.5 step 2), not only after the old one publishes the removal; `movesOf(…, recorded)` never records a move `movedIn` already holds (both stores pass the record's). `MemoryLibraries` (dev store): a write the browser's storage refuses throws `io` ("The browser's storage is full") instead of only logging — a publish then stops before its record moves on and takes back the payloads and manifest it wrote (§9.3's order now protects something: never a record pointing at a missing manifest, never a manifest listing a payload that isn't there); `unpublish` stops before its event; `forget` still logs. A consumer's `blobRefs` keep the images of the library copies it imports and updates: the engine's import / update is a journaled change carrying the copies' image paints, so `documentSource.onChanges` sends their hashes as `blobRefsAdded` (both stores; the engine's results also list them in `images`). Tests: `memoryLibraries.test.ts` (storage refusing the manifest, a payload or the record: the publish fails with `io`, the record, manifests and payloads stay as they were, consumers see no removal, the next publish works; moved seen before the old library republishes; a move published twice recorded once), `local/libraries.test.ts` (the same move rules), the editor's `libraries.wasm.test.ts` (a library image in the consumer's `blobRefs` on the dev store and, over `rpcTestbed`, on `LocalStore`).

11. **Library bookkeeping through Duplicate and Restore version (2026-10-07, review fixes, second round)** — `src/shared/store/assetIdentity.ts`, run by both stores. **Duplicate file / Duplicate version** (`LocalStore.createDuplicate`, `MemoryStore`'s `duplicateSnapshot`): the duplicated snapshot's local assets lose `key`, `publishedVersion` and `libraryMoveInfo` (docs/schema.md §8.1 "Duplicated assets get a new key"); library copies (a node with `sourceLibraryKey` and its subtree) keep theirs; instance-swap preferred values that named a cleared key name the asset by GUID. A snapshot with nothing to clear is still linked / copied as before. **Restore version** (`FileStore.restoreDiff`, `MemoryStore.restoreDiff` → `restoreDiff(head, version)` over `diffTables`): local assets present on both sides keep their bookkeeping (the key never changes; published state follows publishes — the editor reconciles assets a restore re-creates against the latest manifest) and DOCUMENT its `librarySubscriptions` (the store's enabled list isn't versioned); a field the version leaves absent and the head holds at the value absence means (`isAbsentValue`: `@default`, else the kiwi zero value; `variableScopes` excepted) is no change, so a restored head's diff against its version is empty (the engine writes defaults out explicitly); a field going back to a non-zero `@default` is written as that value instead of `clearedFields` (the engine ignores `clearedFields` for fields it keeps without modelling, such as `isSymbolPublishable`). Library copies are written exactly. Tests: `src/shared/store/assetIdentity.test.ts`; end to end on both stores in the editor's `__tests__/libraryBookkeeping.wasm.test.ts`.

12. **Opening a file for the engine (2026-10-07, performance round 2)** — `src/renderer/src/store/loadDocument.ts` (pure): `tableOf(opened)` (snapshot + journal), `engineDocumentFromTable(table)` converts the table **straight to the engine's form** (`NodeTable.snapshotNodes`: snapshot order, derived fields stripped, blob indices rebased only when the table has blobs — not kiwi → Message → engine, which converted the data twice), `fontsOf` (text nodes' `fontName` and `textData.styleOverrideTable` runs), `needsFallbackFont` (CJK / Arabic / Hebrew / Thai / Devanagari / emoji in any text), `sourceTypesOf`, `prepareEngineDocument` (all of it plus the JSON bytes, with timings). `loadWorker.ts` runs it in a module worker (two replies: the fonts as soon as the table is built, then the bytes transferred); `documentSource.ts prepareDocument(opened)` posts to the process's one worker and falls back inline when there is none (tests) or it fails. `StoreDocumentSource.prepare()` (the editor's `DocumentSource.prepare?()`) and `load()` are memoized; `openStoreDocument` starts `prepare()` as soon as the file is open (`prepareEagerly: false` turns it off). `mergedDocument` now goes through the same single conversion. `src/shared/schema/model.ts`: `canContain` memoized per (targets set, type) and `blobOwners()` returns one set (a walk over a 32k-node document asked `reach()` once per field per node: 486 ms); `patch.ts`: `apply` skips the blob walk for a Message without blobs, `toMessage` for a table without any. On the owner's file: the main-thread merge 757 ms (1480 under StrictMode) → 0 on the main thread, 830–1180 ms in the worker overlapping the Wasm compile. Tests: `store/__tests__/loadDocument.test.ts`.

### Partial / not started

- **Sync, not built**: "Download a workspace" (remote-only files are skipped and logged), version snapshots/thumbnails/libraries/device ordinals in Firestore, propagation of delete-forever, `onSnapshot` listeners (the driver has none: open files are polled every 2 s), the `sync` event topic to the views (`Replicator.status` exists; `StoreServer` doesn't forward it yet), the 60 s "unsynced" tab flag. Main still has to pass `settings.sync.enabled` + the Google ID token and call `startSync` in the store process (nothing calls it today, so sync is off).
- `PreviewService` beyond stubs, migrations, workspace relocation and cloud-folder refusal, `DESIGNER_SEED=demo` — unchanged from round 1.
- **C++ outputs** still not compile-checked (`kiwi.h` not vendored; engine workstream).
- The engine's interim JSON can't carry bytes: `messageToEngine` leaves `Uint8Array` fields (image hashes, blob-index geometry) out of what the editor loads. Changes are partial, so the store keeps them, but a node the engine re-creates whole (REMOVED + CREATED) would lose them. Goes away when the engine speaks kiwi.
- **Engine JSON clears of unmodelled fields**: the engine ignores `clearedFields` ids of fields it keeps without modelling (its `extra` map) and emits nothing when one is cleared, so such a clear reaches neither side. The restore diff writes non-zero `@default` fields as values (item 11) and the editor writes Hide when publishing's flags as `true` rather than clearing them; other unmodelled fields a restore or a remote frame clears still don't (engine workstream).
- Dev store limits: the edit lock is per page (two browser tabs can both edit one file; last write wins), localStorage quota (~5 MB; a full write logs a warning and the change lives only in that page — a library publish fails instead, item 10).

### Next steps, in order

1. **Editor**: build the editor's source with `openDocument(fileKey, { tabId })` from `@/store` and pass `{ kind, label }` from `DOCUMENT_CHANGED` as `onChanges`' second argument (the interface's one-argument call also works; kind then defaults to `edit`). Close on tab close; `onExternalChanges` → `engine_apply_changes(…, APPLY_REMOTE)`; `onMetaChanged` → header/tab title, close on trashed/deleted.
2. **Home**: `getStoreClient()`, `store.workspace.watch(…)` to refresh, `thumbnailUrl(file)` for cards.
3. **Desktop**: the main-process wiring below (unchanged API), then `scripts/drive.mjs` end to end.
4. **Sync wiring** (when the owner has a Firebase project): main passes `{enabled, idToken}` to the store (an init field or a `store.*` method), the store calls `startSync`; then "Download a workspace", versions/thumbnails, `onSnapshot`.
5. Previews, migrations, workspace location — as in round 1.

### How Home and the editor get the store

```ts
import { getStoreClient, openDocument, thumbnailUrl } from "@/store";

const store = getStoreClient();            // Electron (window.designer): the port main brokers · browser: the dev store
await store.workspace.listFiles({ in: "recents" });
const off = store.workspace.watch((e) => refresh(e));
const src = thumbnailUrl(file);            // app://designer/_thumb/<key>.png?v=<n> · an object URL · null
const source = await openDocument(fileKey, { tabId });   // DocumentSource for EditorApp
```

`npm run web:demo` → `http://localhost:5199/?files` (Home) and `?editor&file=<fileKey>` (EditorRoute) use the dev store automatically. `?store=dev` forces it inside Electron too. `resetDevStore()` + reload brings the seed back.

### Integration for main (exact)

`electron.vite.config.ts`, main section — add the store as a second main-side entry (the compactor worker reuses the same bundle):

```ts
main: {
  build: {
    externalizeDeps: true,
    rollupOptions: { input: { index: resolve(import.meta.dirname, "src/main/index.ts"), store: resolve(import.meta.dirname, "src/store/index.ts") } },
  },
  define: { __FIREBASE_VERSION__: JSON.stringify(firebaseVersion) },
},
```

`src/main/storeHost.ts` (new, desktop workstream) — start, restart (≤ 3 times in 60 s), broker ports:

```ts
import { app, type WebContents } from "electron";
import { join } from "node:path";
import { startStore, type StoreHandle } from "../store/host";

let store: StoreHandle | null = null;
const views = new Map<number, { wc: WebContents; role: "home" | "editor" }>();
let restarts: number[] = [];
let stopping = false;

export function startStoreHost(onGiveUp: () => void): void {
  const userDataDir = app.getPath("userData");
  const spawn = (generation: number) => {
    store = startStore({ entry: join(__dirname, "store.js"), userDataDir, workspaceDir: process.env.DESIGNER_WORKSPACE ?? join(userDataDir, "Workspace"), generation });
    for (const v of views.values()) store.connectView(v.wc, v.role);
    store.onExit(() => {
      if (stopping) return;
      restarts = [...restarts.filter((t) => Date.now() - t < 60_000), Date.now()];
      if (restarts.length <= 3) spawn(generation + 1); else onGiveUp(); // "DesignerV2 can’t save changes right now."
    });
  };
  spawn(1);
}
export const storeClient = () => store?.client ?? null;                 // main's role-"main" client
export function connectStoreView(wc: WebContents, role: "home" | "editor"): void {
  // A fresh port for every page load (a reload or crash recovery needs a new one; the old one's sessions end).
  wc.on("did-finish-load", () => store?.connectView(wc, role));
  views.set(wc.id, { wc, role });
  wc.once("destroyed", () => views.delete(wc.id));
}
export async function stopStoreHost(): Promise<void> {
  stopping = true;
  await store?.client.store.flushAll().catch(() => {});
  await store?.shutdown();
}
```

Call `connectStoreView(contents, role)` from `createView` (`src/main/views.ts`) for `role === "home" || role === "editor"`; call `startStoreHost` in `app.whenReady()` before `openWindow()`; `await stopStoreHost()` in the quit path after the tabs' flush. Main's own client: `storeClient()!.workspace.watch(e => …)` (`file.renamed` → retitle, `file.trashed`/`file.deleted` → close tabs), `storeClient()!.files.importLocalCopy(path, folderId)`, `…exportLocalCopy(fileKey, path)`.

`src/shared/ipc.ts` `IpcEvents`: `"store:port": { generation: number }` (roles home, editor). Preload (home and editor):

```ts
ipcRenderer.on("store:port", (e, { generation }) => window.postMessage({ type: "designer:store-port", generation }, location.origin, e.ports));
```

The page: `import { getStoreClient } from "@/store"; const store = getStoreClient();` (under the preload that is `storeClient()` from `@/store/client`, which also posts `designer:store-port-wanted`, so a preload that keeps the port until asked can hand it over late). Protocol routes main serves read-only: `app://designer/_blob/<sha1>` → `<workspace>/blobs/<sha1[0..2]>/<sha1>`, `app://designer/_thumb/<fileKey>.png` → `<workspace>/files/<fileKey>/thumbnail.png`.

`host.ts`'s API is unchanged by round 2, so this snippet stands. `StoreServer` now takes any `ServableStore` (a structural interface `LocalStore` satisfies), which the dev store reuses; `index.ts` still constructs it with the `LocalStore`.

### Known breakage

None in the data layer.

---

## How to run

- `npm run engine:gen` — regenerate `src/shared/schema/document.generated.ts`; `-- --check` regenerates into a temp dir, diffs, and runs the schema checks; `-- --cpp <build>` writes the C++ headers into `<build>/generated/schema/`.
- `npx vitest run src/store src/shared/schema src/shared/fig src/shared/store src/renderer/src/store` — the data layer's tests (temp dirs under `os.tmpdir()`, never the real userData). `npm test` runs them with everything else.

## Where things are

| Path | What |
|---|---|
| `engine/tools/schemagen/schemagen.ts` | generator + checks; exports `loadSchema`, `scanTags`, `checkSchema`, `emitTypeScript`, `emitCpp` |
| `src/shared/schema/document.generated.ts` | types, `codec`, `NODE_FIELDS`, `BINDINGS`, `DEFAULTS`, `BLOB_FIELDS`, `DEPRECATED_FIELDS`, `SCHEMA_BINARY`, `SCHEMA_SHA1`, `DOCUMENT_FORMAT_VERSION` |
| `src/shared/schema/patch.ts` | the generic merge (data.md calls it `src/store/kiwi/merge.ts`), restore diff |
| `src/shared/fig/*` | container, ZIP, `.fig`, Figma conversion |
| `src/shared/store/*` | records, repositories, protocol, `StoreClient` |
| `src/store/localStore.ts` | `LocalStore.open()`, `store.api(owner)` = LocalAdapter |
| `src/store/local/*` | workspace, files, journal, snapshots, compaction, versions, blobs, libraries |
| `src/store/server.ts`, `index.ts`, `host.ts` | RPC server, utility-process entry, main-side helper |
| `src/store/sync/*` | Firebase (off): `config`, `paths`, `fieldCodec`, `lww`, `clocks`, `drivers` (SDK + in-memory), `firestoreAdapter`, `replicator` (`startSync`) |
| `src/shared/store/workspaceModel.ts` | the workspace index and file-browser rules (shared by `LocalWorkspace` and the dev store) |
| `src/renderer/src/store/index.ts` | the renderer's one entry: `getStoreClient`, `thumbnailUrl`, `openDocument`, re-exports |
| `src/renderer/src/store/documentSource.ts`, `engineMessage.ts` | the editor's DocumentSource on the store; engine JSON ⇄ kiwi |
| `src/renderer/src/store/devStore.ts`, `memory/*` | the browser dev store (MemoryStore, localStorage records, demo seed) |

## Deviations from the contracts, and why

1. **`tsconfig.node.json` includes `src/store/**/*`** — otherwise `npm run typecheck` would not check the store. **`package.json`**: `kiwi-schema` pinned `0.5.0` in `dependencies`; `engine:gen` runs schemagen directly (there is no `engine/tools/gen.mjs` yet; when there is, it can import schemagen's functions).
2. **Generated file extras**: `SCHEMA_SHA1`, `DEPRECATED_FIELDS`, `FIELD_FLAGS`. The runtime schema model is `decodeBinarySchema(SCHEMA_BINARY)` minus the deprecated ids (`model.ts`) instead of a second embedded copy.
3. **No `fflate`**: compression is injected (`FigCodecs`); the store passes Node's zlib (deflate-raw + zstd). A renderer passes a synchronous deflate (e.g. fflate) for clipboard archives — add the dependency with that code.
4. **Merge location**: `src/shared/schema/patch.ts` (shared with the UI, as asked) rather than `src/store/kiwi/merge.ts`. CREATED for a live GUID is a full replace (schema.md §4.2.2 wins over data.md §5.5).
5. **Compactor worker** = the store bundle run as a worker with `workerData.designerStoreRole === "compactor"`, so the build needs no extra entry.
6. **Snapshots use zstd with the frame checksum**, so bit rot fails decompression and recovery falls back instead of decoding garbage.
7. **Recovery from a version** (nothing else decodes): the version snapshot becomes the head at the highest seq ever written (seqs stay unique); frames after the version are set aside, not replayed. Damaged/dropped files are renamed (`*.damaged-<ms>`, `*.dropped-<ms>`), never deleted; a segment with a hole is copied aside before truncation.
8. **`sharedSymbolVersion` → `version` only on library copies**: the samples show Figma writes it on local components as its own counter ("1:66"). Library copies also map `sharedSymbolReference`/`sharedStyleReference`/`componentKey` → `sourceLibraryKey`/`publishID`/`key`/`version`.
9. **Wire additions**: `files.subscribe(fileKey, fromSeq) → FileChange[]` (backlog, then `file.changes` events) and `files.unsubscribe(fileKey)` are the RPC form of `FileRepository.subscribe`; `store.flushAll`, `store.info`, `store.collectGarbage` join `store.shutdown` (main only).
10. **Import session**: GUIDs with sessionID ≥ 2^20 move to the new file's session n = 1; the file's `nextLocal` starts at 2. Duplicates keep GUIDs (the engine skips used localIDs).
11. **Search** also folds dotless "ı" to "i" (Turkish names: "calis" finds "Çalışma").
12. **Thumbnails** larger than 800×600 are refused (`invalid`); imported `.fig` thumbnails are kept as they are.
13. **Lock**: `.lock` = `{pid, startedAt}` created with O_EXCL; a lock whose pid is gone is taken over (and one with our own pid when no live store of this process holds it, for crash tests).
14. **New files** write `DOCUMENT.librarySubscriptions` for the team's default libraries (schema.md §8.2) alongside `FileMeta.enabledLibraries`; later changes to the document's list are the engine's (journaled edits).
13. **Per-field sync clocks** are `files/<key>/clocks.json` (JSON), not `clocks.bin`: small, written once per sync pass.
14. **A file's first push** (or one whose unpushed frames were compacted away) sends the whole head stamped with the file's `createdAt` (first push) or `updatedAt` (gap), so any later stamp, local or remote, wins over it; the frames after it keep their own stamps.
15. **Pull polls** open files every 2 s (`list(nodes, where _t > cursor, orderBy _t)`) instead of `onSnapshot`, which the narrow driver interface doesn't have yet. Remote frames are never pushed back.
16. **The browser dev store** reuses `StoreServer` and `WorkspaceModel`, so the protocol and the file-browser rules are the store's own; its file side is a separate in-memory implementation (no journal files, recovery or fsync).
