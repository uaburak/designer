# Handoff — where the Figma-clone work stands

Written 2026-10-06 when the first Claude session stopped (its usage limits were nearly full) and the owner moved the work to another Claude account through GitHub (`https://github.com/uaburak/designer`). Read `AGENTS.md`, `docs/architecture.md` and `docs/roadmap.md` first; the contracts in `docs/` decide everything; `docs/research/` holds the verified facts about Figma (with sources).

## Starting the next session

1. Get the code: on the same Mac the folder `~/Desktop/Burak/Code/DesignerV2` is already the clone (`git pull`); elsewhere `git clone https://github.com/uaburak/designer.git && cd designer && npm install` (Node ≥ 22.12; Node 24 used here).
2. Toolchain, only needed to change the C++ (the built `engine.wasm` is committed, so `npm run dev:demo` works without it). On the original Mac it is installed. Elsewhere (macOS, no Homebrew needed):
   ```bash
   pip3 install --user uv cmake ninja
   ~/Library/Python/3.9/bin/uv python install 3.12
   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
   cd ~/emsdk && EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12) ./emsdk install latest && EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12) ./emsdk activate latest
   ```
   `engine/tools/build.mjs` finds `~/emsdk` (or `$EMSDK`), cmake/ninja in `~/Library/Python/3.9/bin` (or on PATH) and a Python ≥ 3.10 by itself.
3. Verify before changing anything: `git status`, `npm run check`, `npm run engine:test`, `npm run engine:shot` (headless canvas checks). Each workstream wrote a **"Status at handoff (2026-10-06)"** section at the top of its own doc — read those four: `docs/engine-build.md`, `docs/design-system-usage.md`, `docs/data-impl.md`, `docs/editor.md` (plus `docs/desktop-impl.md`, finished earlier).
4. A prompt that works for the first message there: *"Read AGENTS.md and docs/handoff.md. Verify the tree (git status, npm run check, npm run engine:test), finish the partial items each workstream lists in its 'Status at handoff' section, then run the integration round described in docs/handoff.md. Work in parallel agents with the folder ownership given there; reply to me in Turkish."*

How the first session worked, worth keeping: parallel agents with **disjoint folder ownership** (each told exactly which folders it may edit, never `git add`/commit), contracts first, every agent ending with `npm run check` (+ `engine:test`) and screenshots of what it built, and the main session verifying each report (tests, screenshots) before starting the next round.

## Owner's decisions (binding)

- A 1:1 clone of the Figma desktop app for personal use (UI3, Figma's file model and wording). No multiplayer. Never sold or published; design previews will be shared with developer friends later.
- Engine as Figma's: C++ → Emscripten → WebAssembly, **our own renderer** on WebGL2 (no Skia/CanvasKit, no DOM for design objects), React+TS panels, Electron with one WebContentsView per tab.
- Local-first storage, plus an optional Firebase adapter for a **new** Firebase project (config comes from the owner later; nothing in the repo).
- **Delete all legacy site-admin code in the integration round** (DOM editor, CV, publishing, preview tab, old Home, `lib/`, `demo/`, sign-in, site components, Tailwind/gsap/prismjs/dompurify…). The site's Firebase data is left untouched. No import of the old projects.
- The owner reviews the app only after the integration round (Home on the store + engine editor tabs).

## Toolchain (installed, user-level)

`export EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12); source ~/emsdk/emsdk_env.sh` → emcc 6.0.11. CMake 4.4 and Ninja 1.13 are in `~/Library/Python/3.9/bin`. `engine/tools/build.mjs` activates the toolchain itself.

## Workstreams — status when the first session stopped

All five stopped cleanly on request (each brought its folder to compiling + tests green and wrote a **"Status at handoff (2026-10-06)"** section at the top of its doc — that section is the authoritative to-do list for the workstream).

| Workstream | Owns | Status | Its doc |
|---|---|---|---|
| Desktop shell | `src/main`, `src/preload`, `src/shared/{ipc,desktop,tabs,commands,layout,api}.ts`, `src/renderer/src/app`, `tab`, `main.tsx`, `electron.vite.config.ts`, `vite.shared.ts`, `scripts/drive.mjs` | **Done.** BaseWindow + a WebContentsView (own renderer process) per tab bar / Home / file; TabManager in main (lazy restore, reorder without reload, ⇧⌘T, ⌘1–9, ⌃Tab); typed IPC with sender checks; native Save/Don't Save dialogs for the legacy tabs; crash/hang recovery; CSP with `'wasm-unsafe-eval'`. Verified end to end with `scripts/drive.mjs`. Not built: `tab:flush`, `menu:state`, store/fonts/clipboard/file channels, the spare editor view, Figma's full menu bar. | `docs/desktop-impl.md` |
| Design system | `src/renderer/src/ds`, `scripts/gen-tokens.ts`, `scripts/gen-icons.ts`, the generated block of `src/renderer/public/boot.js`, `engine/src/render/ChromePalette.generated.h` | **Done (2 rounds).** 174 `--figma-color-*` tokens light/dark (dark values from Figma's docs bundle), measured metrics, ~40 components incl. ColorPicker (6 paint types, gradient stops, eyedropper, one final change per drag), AlignmentMatrix, the UI3 EditorToolbar (530×48, Draw/Design/Motion/Dev Mode group), 236 icons from SVG, generators with `--check` (`npm run tokens`, `npm run icons`), happy-dom component tests, Figma's Home wording. `?gallery`. Not yet viewed in a browser: the round-2 Gallery demos. | `docs/design-system-usage.md` |
| Engine | `engine/` (except `engine/tools/schemagen` and `ChromePalette.generated.h`), `src/renderer/src/engine` | E0+E1 **done** (renderer, camera, hit-testing, gestures, undo; `?engine`; `npm run engine:shot`). Round 2 was **stopped part-way** — see its handoff section for exactly which of the editor API (GROUP…DUPLICATE_PAGE, `moveNodes`, `encodeSelection`, `paste`), snapping, ⌥-drag, reparenting and E2 auto layout landed. | `docs/engine-build.md` |
| Data | `engine/tools/schemagen`, `src/shared/{schema,store,fig}`, `src/store`, `src/renderer/src/store` (+ `tsconfig.node.json` includes `src/store`) | **Round 1 done.** Generator + committed TS codec (`npm run engine:gen -- --check`: 1,489 Figma parity checks), `.fig` container + ZIP + converter (3 sample files round-trip, no node lost), patch model, fractional index, the store (workspace, trash, journal with fsync, crash recovery, compaction, versions, blobs + GC, libraries, `.fig` import, Save Local Copy), RPC server/client with reconnect. Written but untested: `src/store/host.ts` (main's helper), the worker compactor, sync drivers; `firestoreAdapter.ts`/`replicator.ts` not written; generated C++ headers not compiled yet (needs `kiwi.h` vendored). | `docs/data-impl.md` (has the exact main-process integration snippet) |
| Editor | `src/renderer/src/editor`, the `?editor` route in `main.tsx`, `docs/editor.md` | **Logic done, UI not started.** Done: `DocumentSource` + memory source, `engineCompat.ts` (runtime-detects engine features still landing), the Layers-tree model (rows, ⇧/⌘ selection, drop positions), Mixed values, panel geometry, colours, clipboard formats, ruler ticks, UI store/controller/hooks, ~90 commands with Figma's labels and shortcuts, keyboard routing, clipboard I/O. **Next first:** `EditorApp.tsx` + the `?editor` route, then rail/main menu, Pages, Layers, rulers, right panel sections, toolbar (use `ds` EditorToolbar), context menu, screenshots vs the reference images. | `docs/editor.md` |

Reference screenshots of the real Figma desktop app (UI3, dark), used for every visual comparison, are not in the repo (they were the owner's chat attachments); `docs/research/visual-diff.md` holds the measurements taken from them (1 CSS px = 1.3228 image px). Ask the owner to re-share screenshots if a new comparison is needed.

Verify first (`git status`, `npm run check`, `npm run engine:test`) and fix anything red before going on.

## Next: the integration round

Three workstreams, started once the editor UI exists (finish the Editor workstream's next steps first, or fold them into workstream 3):

1. **Desktop integration + legacy removal** (owns the desktop folders above): start the store `utilityProcess` through `src/store/host.ts` and hand each view its MessagePort; a tab kind for workspace files (`fileKey`); Home and editor views load the new apps; autosave semantics (no Save, no dirty dot; flush on close/quit/hide); Figma's menu bar (File, Edit, View, Object, Text, Arrange, Vector, Window, Help) from one command registry routed to the active view, with enablement from the view; delete every legacy folder/route/dependency listed above and the sign-in; theme only through `ds/theme.ts`.
2. **New Home** (owns a fresh `src/renderer/src/home`): Figma's file browser on the store — Recents, Drafts, folders (nested, coloured), Starred, Trash (restore / delete forever); cards with thumbnails and list view; sort/filter; selection, context menus (Open, Open in new tab, Rename, Duplicate, Move to…, Star, Move to trash); new design file; import `.fig`; built only from `ds/`.
3. **Editor ↔ store** (owns `src/renderer/src/editor`): a `DocumentSource` over the store client (load snapshot + journal, append each change, flush), thumbnails, rename from the header, version history (autosave checkpoints, named versions ⌥⌘S, non-destructive restore), Back to files.

Acceptance: `npm run check` + `npm run engine:test` green; `npm run build -- --mode demo` and `scripts/drive.mjs` show: launch → Home (no sign-in) → new design file → draw frames/rects → close and reopen → everything is there; Trash/restore; two files open in separate processes.

## After that

`docs/roadmap.md` Phase 3: E3 text (HarfBuzz, fonts from the system), E4 vectors/pen/booleans, E5 paints/effects/images/tiles; then components/variables/styles/libraries (Phase 4); export, developer previews, the Firebase adapter, `.fig` import (Phase 5).

## Open items to remember

- Manual checks the automation couldn't do: dragging the window by the tab bar's empty area; the native tab context menu.
- The engine's wasm output is committed in `src/renderer/src/engine/wasm/` (rebuild **release** before committing); the contract wanted it gitignored with predev/prebuild hooks.
- The TS↔engine boundary is JSON with kiwi names (interim) until the generated kiwi codecs are wired (`engine/src/scene/CodecJson.*`, `src/renderer/src/engine/codec.ts`).
- COOP/COEP off by default (`DESIGNER_CROSS_ORIGIN_ISOLATED=1` turns it on) — can be turned on once the legacy pages are gone.
- No git commit exists yet; ask the owner before making the first one.
