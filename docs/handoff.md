# Handoff — where the Figma-clone work stands

First written 2026-10-06 when the first Claude session stopped and the owner moved the work to another Claude account through GitHub (`https://github.com/uaburak/designer`). Updated the same day by the second session, which finished every workstream's partial items and ran the integration round. Read `AGENTS.md`, `docs/architecture.md` and `docs/roadmap.md` first; the contracts in `docs/` decide everything; `docs/research/` holds the verified facts about Figma (with sources).

## Status 2026-10-07 (third session, sansato team account)

Phases 3 and 4 are done and pushed: E3 text, E4 vectors, E5 paints / effects / images, E6 components and instances, local variables / modes / styles, and libraries (publish, Libraries modal, Assets sections, updates with Review, Move to this file, Restore component, cross-file paste). The libraries round got a four-lens review (24 confirmed findings) and two fix rounds, each finding re-verified by an independent agent (commits `25239de`, `a37b00e`). Green at `a37b00e`: `npm run check` 562 tests, `npm run engine:test` 236 cases, `engine:shot` 52/52, `editor-shot.mjs` 110/110. The workstream docs' status sections (`docs/engine-build.md` "Libraries — review fixes", `docs/editor.md`, `docs/data-impl.md`) list what is still open; small engine item: `clearedFields` for unmodelled fields.

Next: Phase 5 of `docs/roadmap.md` — export, developer previews, Firebase adapter wiring, `.fig` import polish — unless the owner's review of the app comes first.

## Starting the next session

1. Get the code: `git clone https://github.com/uaburak/designer.git && cd designer && npm install` (Node 24; `.nvmrc`), or `git pull` in an existing clone.
2. Toolchain, only needed to change the C++ (the built release `engine.wasm` is committed, so `npm run dev:demo` works without it). macOS, either way works:
   ```bash
   # without Homebrew
   pip3 install --user uv cmake ninja
   ~/Library/Python/3.9/bin/uv python install 3.12
   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
   cd ~/emsdk && EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12) ./emsdk install latest && EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12) ./emsdk activate latest
   # with Homebrew (used by the second session)
   brew install cmake ninja
   git clone --depth 1 https://github.com/emscripten-core/emsdk.git ~/emsdk
   cd ~/emsdk && EMSDK_PYTHON=/opt/homebrew/bin/python3 ./emsdk install latest && EMSDK_PYTHON=/opt/homebrew/bin/python3 ./emsdk activate latest
   ```
   `engine/tools/build.mjs` finds `~/emsdk` (or `$EMSDK`), cmake/ninja on PATH (or in `~/Library/Python/3.9/bin`) and a Python ≥ 3.10 (`EMSDK_PYTHON`, else `uv python find 3.12`, else `python3`).
3. Verify before changing anything: `git status`, `npm run check`, `npm run engine:test`, `npm run engine:shot` (headless canvas checks). Each workstream keeps a **status section at the top of its own doc** — that section is its authoritative to-do list: `docs/engine-build.md`, `docs/design-system-usage.md`, `docs/data-impl.md`, `docs/editor.md`, `docs/desktop-impl.md`, `docs/home.md`.
4. To drive the built app: `npm run build -- --mode demo`, then `node scripts/drive.mjs …` (it strips `ELECTRON_RUN_AS_NODE`, which some host apps leak into the shell and which stops Electron from launching).

How the sessions worked, worth keeping: parallel agents with **disjoint folder ownership** (each told exactly which folders it may edit, never `git add`/commit), contracts first, every agent ending with `npm run check` (+ `engine:test`) and screenshots of what it built, and the main session verifying each report (tests, screenshots) before starting the next round. Each agent's dev server on its own port (5201–5206), never 5199.

## Owner's decisions (binding)

- A 1:1 clone of the Figma desktop app for personal use (UI3, Figma's file model and wording). No multiplayer. Never sold or published; design previews will be shared with developer friends later.
- Engine as Figma's: C++ → Emscripten → WebAssembly, **our own renderer** on WebGL2 (no Skia/CanvasKit, no DOM for design objects), React+TS panels, Electron with one WebContentsView per tab.
- Local-first storage, plus an optional Firebase adapter for a **new** Firebase project (config comes from the owner later; nothing in the repo).
- All legacy site-admin code is deleted (done in the integration round). The site's Firebase data is left untouched. No import of the old projects.
- The owner reviews the app now that the integration round is done (Home on the store + engine editor tabs).

## Workstreams — status after the second session

| Workstream | Owns | Status | Its doc |
|---|---|---|---|
| Desktop shell | `src/main`, `src/preload`, `src/shared/{ipc,desktop,tabs,commands,layout}.ts`, `src/renderer/src/app`, `main.tsx`, `electron.vite.config.ts`, `vite.shared.ts`, `scripts/drive.mjs` | **Integration done.** Store `utilityProcess` with restart policy and a port per Home/editor view; `file` tab kind (`fileKey`), one tab per file, session restore; autosave (no Save, no dirty dot; flush on close/quit/hide/sleep); Figma's full menu bar from `MENU_LAYOUT` with enablement from the view in front; `.fig` import / Save local copy; `_thumb` and `_blob` served read-only; COOP/COEP on by default; legacy removed. | `docs/desktop-impl.md` |
| Design system | `src/renderer/src/ds`, `scripts/gen-{tokens,icons}.ts` | **Done (3 rounds).** Gallery checked in a browser (picker slider fixes); file-browser pieces (`CollectionView`, `useSelection`, `ListHeader`/`ListRow`, `FolderCard`, `Breadcrumb`, `InlineEdit`, `Banner`, `Skeleton`); folder colour tokens; `EditorToolbar disabledTools`; dialog theme fix; TabBar/ScrollArea/Dialog tests. | `docs/design-system-usage.md` |
| Engine | `engine/` (except `engine/tools/schemagen`, `ChromePalette.generated.h`), `src/renderer/src/engine` | **E0–E2 done** except GRID. All 20 editor commands, `moveNodes`, `encodeSelection`/`paste`, page args; gestures on world transforms, drag-to-reparent, ⌥-drag duplicate, auto-layout reorder; snapping, ⌥ measurement, guides/bands drawn; golden layout tests against Figma's samples (|Δ| ≤ 0.01); `CONTEXT_MENU` event; offscreen thumbnails; `kiwi.h` vendored and the generated C++ codecs compiled natively. Next: kiwi at the TS↔C++ boundary, GRID, E3 text. | `docs/engine-build.md` |
| Data | `engine/tools/schemagen`, `src/shared/{schema,store,fig}`, `src/store`, `src/renderer/src/store` | **Round 2 done.** Store-backed `DocumentSource` (`openDocument`), in-browser dev store (`getStoreClient()` works in a plain browser), `importFigBytes`, Firestore adapter + replicator (tested on in-memory Firestore; off until configured), worker compactor tested. | `docs/data-impl.md` |
| Editor | `src/renderer/src/editor` | **UI done.** Rail + main menu, Pages, Layers (drag reorder/reparent), rulers, right panel with every Design section, DS ColorPicker (solid), toolbar, context menu from the engine, shortcuts dialog, ⌘\ / ⇧\, version history (⌥⌘S), store-backed files with per-file UI state and thumbnails. `tools/editor-shot.mjs` end-to-end check. | `docs/editor.md` |
| Home | `src/renderer/src/files` | **Done.** Figma's file browser on the store: Recents, Drafts, nested coloured folders, Starred, Trash; grid/list, sort/filter, selection and keys, context menus, Move to folder, Undo toasts, New design file, `.fig` import (picker and Finder drop). | `docs/home.md` |

Reference screenshots of the real Figma desktop app (UI3, dark) are not in the repo (they were the owner's chat attachments); `docs/research/visual-diff.md` holds the measurements taken from them (1 CSS px = 1.3228 image px). Ask the owner to re-share screenshots for a pixel pass.

## Integration round — done

Acceptance (verified with `scripts/drive.mjs` on the built demo app): launch → Home (no sign-in) → new design file → draw frames/rects → close and reopen → everything is there; Trash/restore; two files open in separate processes; quitting with a file open restores it. `npm run check` and `npm run engine:test` green.

## Next (as written after the second session; superseded by the status at the top)

`docs/roadmap.md` Phase 3: E3 text (HarfBuzz, fonts from the system), E4 vectors/pen/booleans, E5 paints/effects/images/tiles (gradients and images in the picker); kiwi at the engine boundary; GRID. Then components/variables/styles/libraries (Phase 4); export, developer previews, the Firebase adapter wiring, `.fig` import polish (Phase 5).

## Open items to remember

- Manual checks the automation couldn't do: dragging the window by the tab bar's empty area; the native tab context menu.
- The engine's wasm output is committed in `src/renderer/src/engine/wasm/` (rebuild **release** before committing); 457 KB after round 2.
- The TS↔engine boundary is JSON with kiwi names (interim) until the generated kiwi codecs are wired (`engine/src/scene/CodecJson.*`, `src/renderer/src/engine/codec.ts`). Image hashes don't cross it yet.
- `docs/schema.md` §3.4 says an absent `stackCounterSpacing` means 0; Figma's own file and the golden test show it means "same as `stackSpacing`" — the schema owner should correct the doc.
- In a plain browser the dev store can't read zstd-compressed `.fig` files (Figma's newer files); the desktop store can. A small decoder (e.g. `fzstd`) passed to `createDevStore({ zstdDecompress })` would fix it.
- The `/_blob` and `/_thumb` protocol token isn't checked yet.
- Wording to confirm against Figma: Home's empty states and toasts.
