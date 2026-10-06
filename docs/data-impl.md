# Data layer — as built

Contracts: `docs/data.md` (store, workspace, journal, versions, libraries, Firebase), `docs/schema.md` + `schema/document.kiwi` (document schema; it wins where they differ), `docs/desktop.md` §1/§9/§10.2 (store port).

---

## Status at handoff (2026-10-06)

### Checks at handoff

| Command | Result |
|---|---|
| `npm run typecheck` | passes (both projects) |
| `npm run engine:gen -- --check` | 183 definitions, NodeChange 194 live of 1,001 fields, 953 reserved numbers, 1,489 Figma parity checks, **0 problems**; committed TS output up to date |
| `npm run lint` | 0 problems in data-layer files. **2 errors in `src/renderer/src/editor/hooks.ts`** (`react-hooks/immutability`, another workstream's file, not touched) |
| `npm test` | 288 of 289 pass. **The data layer's 11 files / 76 tests all pass.** The one failure is `src/renderer/src/engine/__tests__/abi.test.ts` ("commands: abi.ts = Commands.h"), the engine workstream's |

Data-layer tests (`npx vitest run src/store src/shared/schema src/shared/fig src/shared/store`):

| File | Tests | Covers |
|---|---|---|
| `src/shared/schema/fractionalIndex.test.ts` | 6 | schema.md §10.2 vectors, keysBetween, rebalancing, the 24-char rule |
| `src/shared/schema/codec.test.ts` | 6 | NODE_CHANGES round trip (CREATED + update with `clearedFields`), new-file nodes, field registry, defaults, bindings, blob fields |
| `src/shared/schema/patch.test.ts` | 10 | apply rules (update, clear, REMOVED, CREATED = full replace, missing/invalid), snapshot order, blob rebasing/dedupe, image refs, restore diff both ways, GUID allocation |
| `src/store/kiwi/samples.test.ts` | 18 | the 3 Figma samples: ZIP/meta/thumbnail/container, image SHA-1s, interpreter = compileSchema (byte-identical re-encode), lossless rewrite, **import by name** (§1.1 pt 5), full conversion |
| `src/store/local/journal.test.ts` | 3 | header/frame layout, torn tail, CRC hole, seq gap, writer/reopen truncation |
| `src/store/local/workspace.test.ts` | 6 | layout + lock, Drafts/folders/rename/move/search (diacritics), nesting ≤ 10 + no cycles, trash/restore/delete forever/empty trash, recents ≤ 50, damaged-record repair |
| `src/store/local/fileStore.test.ts` | 10 | sessions/lock/dedupe/replay, subscribers + fsync timer + updatedAt, torn-tail recovery, previous-generation fallback, version fallback + `corrupt`, compaction (generations, exact blobRefs, auto past 5,000 frames), versions (named, open, restore diff, duplicate), autosave checkpoint, thumbnails + UI state |
| `src/store/local/libraries.test.ts` | 3 | publish/preview/diff/payloads with dependencies, drafts refused, Move to this file vs Publish as a copy, unpublish/trash/restore/delete forever, default libraries |
| `src/store/local/blobs.test.ts` | 2 | put/has/get/MIME, mark-and-sweep with 24 h grace, trashed files keep refs |
| `src/store/import/fig.test.ts` | 7 | import of each sample (images, thumbnail, import version, session remap), FigJam/garbage refused, rehash of mismatched images, Save Local Copy (head snapshot as is) + re-import, duplicate file |
| `src/store/rpc.test.ts` | 5 | hello/roles, main-only methods, events fan-out, port close ends sessions, **store restart: reattach + resend unacked + resubscribe** |

Sample `.fig` numbers (from the tests): `structure.fig` 26 → 26 nodes, `sections.fig` 21 → 21, `stacks_wrap.fig` 57 → 57 (no node type dropped). Projected Messages encode to 7,819 / 36,049 / 6,699 bytes and decode identical; as our snapshots (zstd data + ≈13 KB deflated schema) 14,460 / 13,736 / 14,004 bytes. Dropped NodeChange fields are exactly schema.md §13 categories: `editInfo`, `userFacingVersion`, `maskIsOutline`, `exportBackgroundDisabled`, `containerSupportsFillStrokeAndCorners`, `rectangleCornerToolIndependent`, `*Version` stamps, `textTracking`, and Figma's local-component `sharedSymbolVersion` counter.

### Done and verified

1. **Generator** `engine/tools/schemagen/schemagen.ts` (one file, Node 24 erasable TS, kiwi-schema 0.5.0 API): TS output `src/shared/schema/document.generated.ts` (committed), C++ outputs with `--cpp <build>` → `<build>/generated/schema/{document.kiwi.h, document.stream.h, node_fields.h}`, and `--check` with the four schema checks of schema.md §2.2. `npm run engine:gen` added.
2. **Shared schema runtime** (`src/shared/schema/`): `model.ts` (schema model, eval-free), `codec.ts`, `guid.ts`, `fractionalIndex.ts`, `patch.ts` (node table, apply, snapshot order, blob pool, restore diff), `visit.ts`, `dynamic.ts` (interpreting codec for any schema, CSP-safe).
3. **`.fig` container** (`src/shared/fig/`): `container.ts`, `zip.ts` (reader incl. deflated entries/data descriptors/ZIP64; stored writer), `figFile.ts`, `crc32.ts`, `compression.ts` (injected codecs), `convert.ts` (projection by name + §11.1 mappings).
4. **Store** (`src/store/`): workspace records/index/trash/search (`local/workspace.ts`), per-file actor with journal, fsync, recovery, compaction, checkpoints, versions, thumbnails, UI state (`local/fileStore.ts`, `local/journal.ts`, `local/snapshot.ts`, `local/compact.ts`, `local/versions.ts`), blobs + GC (`local/blobs.ts`), libraries (`local/libraries.ts`), import/export (`import/fig.ts`, `export/fig.ts`), composition root + `LocalAdapter` (`localStore.ts`, `store.api(owner)`), RPC server (`server.ts`), entry (`index.ts`), main-side host (`host.ts`), compactor inline/worker (`compactor.ts`), test harnesses (`testing/`).
5. **Repository interfaces and protocol** (`src/shared/store/`): `types.ts`, `repositories.ts`, `protocol.ts`, `client.ts` (transport-agnostic `StoreClient` with reconnect); renderer wrapper `src/renderer/src/store/client.ts`.

### Partial (compiles, not tested or not wired)

- **Sync** (`src/store/sync/`): `config.ts` (done; config path `userData/firebase/config.json`), `paths.ts` (done, exact §12.4 paths), `fieldCodec.ts` (node document encoding incl. `$b`/`$blob`/`$kiwi` spills — no tests yet), `lww.ts` (coalesce, `planPush`, `planPull`, `mergeRecord` — no tests yet), `drivers.ts` (lazy Firebase SDK loader via runtime `import()` of `firebase/*`, plus `MemoryFirestore`/`MemoryStorage` for tests — untested). **Missing:** `firestoreAdapter.ts` (the `FirestoreAdapter` class implementing the four interfaces) and `replicator.ts`. `FileStore.framesSince / appendRemote / syncState / setSyncState` were added for the Replicator and are untested.
- **Compactor worker**: `workerCompactor()` + `runCompactorWorker()` + the dispatch in `index.ts` exist; only the inline compactor is exercised (tests run in-process; the worker needs the built bundle).
- **`host.ts`**: typechecked, not run (needs main's wiring below).
- **C++ outputs**: generated, **not compile-checked** — `kiwi.h` is not vendored yet (`engine/third_party/kiwi/` belongs to the engine workstream) and none was found on disk.
- **Renderer client**: typechecked; no test of the `window` port handover (needs a DOM test env).

### Not started

- `PreviewService` beyond stubs (`list` reads `previews.json`; `publish`/`stop` answer `offline`), the HTML export fallback.
- `clocks.bin`, Download/Upload workspace, device ordinals from Firestore.
- `src/store/migrations/` (nothing to migrate at `DOCUMENT_FORMAT_VERSION = 1`).
- Workspace location move and cloud-folder refusal (data.md §3.1).
- convert.ts: Figma's per-node `libraryGUIDToSubscribingGUID` → `overrideKey` on library copies (no sample has library copies).

### Next steps, in order

1. **Wire the store into main** (desktop workstream; snippet below), then verify with `scripts/drive.mjs` that the store process starts, takes the lock, and a Home page lists files through `storeClient()`.
2. **Engine**: vendor `kiwi.h` at `engine/third_party/kiwi/` and call `node engine/tools/schemagen/schemagen.ts --cpp ${build}` from `engine/cmake/Generators.cmake`; compile `document.kiwi.h` + `document.stream.h` + `node_fields.h` in one TU with `IMPLEMENT_SCHEMA_H` (schema.md §2.2). `fieldmeta.ts` can import `loadSchema()`/`scanTags()` from schemagen for the tag model.
3. **Sync**: write `src/store/sync/firestoreAdapter.ts` (records via `mergeRecord` in transactions at `firestorePaths`; nodes via `coalesce` → `encodeNodeFields` (spills uploaded first) → `planPush` in ≤ 100-doc transactions with `_clk/_t/_del/_dev`; pull via `list(nodes, where _t > cursor, orderBy _t)` → `decodeNodeFields` → `planPull` → `FileStore.appendRemote`), `src/store/sync/replicator.ts` (2 s push loop, 2 s–5 min backoff, `pushedSeq`/`pullCursor` in store.json, `clocks.bin`), tests against `MemoryFirestore`/`MemoryStorage`. Keep it off unless `config.json` exists **and** main's `settings.sync.enabled`.
4. Previews (`PreviewService`) on top of sync; "Export preview as HTML…" fallback.
5. Run the worker compactor in the built app; measure append → ack p95 (< 5 ms for < 64 KB).
6. Workspace location (§3.1), `DESIGNER_SEED=demo` (main passes `seedFigs`), migrations when the format version moves.

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

The page: `import { storeClient } from "@/store/client"; const store = storeClient();` (it also posts `designer:store-port-wanted`, so a preload that keeps the port until asked can hand it over late). Protocol routes main serves read-only: `app://designer/_blob/<sha1>` → `<workspace>/blobs/<sha1[0..2]>/<sha1>`, `app://designer/_thumb/<fileKey>.png` → `<workspace>/files/<fileKey>/thumbnail.png`.

### Known breakage

None in the data layer. Outside it at handoff: 2 lint errors in `src/renderer/src/editor/hooks.ts`, 1 failing test in `src/renderer/src/engine/__tests__/abi.test.ts`.

---

## How to run

- `npm run engine:gen` — regenerate `src/shared/schema/document.generated.ts`; `-- --check` regenerates into a temp dir, diffs, and runs the schema checks; `-- --cpp <build>` writes the C++ headers into `<build>/generated/schema/`.
- `npx vitest run src/store src/shared/schema src/shared/fig src/shared/store` — the data layer's tests (temp dirs under `os.tmpdir()`, never the real userData). `npm test` runs them with everything else.

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
| `src/store/sync/*` | Firebase (off) |

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
