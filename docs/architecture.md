# Architecture

DesignerV2 is a 1:1 clone of the Figma desktop app for one person's use: Figma's UI3, Figma's file model, Figma's engine design — without multiplayer. This page is the map; the contracts below decide the details, and the research they rest on (with sources) is in `docs/research/`.

| Contract | What it decides |
|---|---|
| [`schema/document.kiwi`](../schema/document.kiwi), [`schema.md`](schema.md) | The document: Figma's own Kiwi schema trimmed to what we use (Figma's names and field numbers), the property-patch model, ids, fractional ordering, storage mapping |
| [`engine.md`](engine.md) | The C++ engine: scene graph, derived data, layout, geometry, our renderer, text, hit-testing and gestures, undo, the flat C ABI and its generated TypeScript wrapper, tests, milestones E0–E9 |
| [`desktop.md`](desktop.md) | Processes and views, the TabManager, menus, closing and flushing, crashes, the IPC contract, `app://`, security, clipboard, fonts |
| [`data.md`](data.md) | The workspace on disk, per-file snapshot + journal, versions, the store process, repositories, libraries, blobs, `.fig` import/export, Firebase (later), developer previews |
| [`design-system.md`](design-system.md) | The chrome's tokens (Figma's `--figma-color-*`), metrics, theming, CSS Modules, the component inventory |
| [`roadmap.md`](roadmap.md) | The order things are built in |

## The pieces

```
BaseWindow (hiddenInset, traffic lights)
├── WebContentsView  tab bar (38px)                     ─┐
├── WebContentsView  Home (file browser)                 │  each its own renderer process,
└── WebContentsView  one per open file                   │  sandboxed, own preload
     ├── React + TS panels (src/renderer/src/ds, …)       │  (src/main, src/preload,
     └── <canvas> ← engine.wasm (C++ → Emscripten)       ─┘   src/shared/ipc.ts)
main process: TabManager, menus, dialogs, protocol, fonts, clipboard
utilityProcess: the store — the only writer of the workspace (src/store) ⇄ views over MessagePorts
```

- **The engine** (`engine/`, `src/renderer/src/engine/`) owns the open document: a flat node table keyed by `sessionID:localID`, children ordered by fractional `parentIndex` positions, derived data (layout, instance contents, resolved variables, world bounds) recomputed by dependency tracking, our own WebGL2 renderer (WebGPU later behind the same interface), hit-testing, the canvas gestures and undo. React panels read nodes and send commands through a generated flat API; the engine reports selection, hover and every document change.
- **One change format.** A change is a Kiwi `NODE_CHANGES` message carrying only the touched fields. The engine emits it, the store appends it to the file's journal, undo is its inverse, the clipboard carries it, and Firestore will later receive the same fields one property at a time (last writer wins).
- **The store** keeps the workspace in `~/Library/Application Support/DesignerV2/Workspace`: Drafts and folders, files (snapshot + journal + versions + thumbnail), Trash, Recents, Starred, the library registry and content-addressed blobs. Any file in a folder can publish a library; consuming files keep read-only copies and accept updates through Review.
- **Firebase** is an adapter behind the same repositories, off until a config is placed in `userData/firebase/config.json`. Previews for developers: a read-only snapshot shown by a web build of the same renderer.

## History

DesignerV2 began as the desktop app for burakkoc.net's site admin. That code (the DOM editor, the CV, publishing, the old Home, the site's Firebase layer and its sign-in) was deleted in the Phase 2 integration round (2026-10-06); nothing in the tree depends on it, and the site's own data was left untouched.

## Checks

- `npm run check` — types, lint, tests (renderer, shared, store).
- `npm run engine:test` — the engine's native tests (doctest, clang).
- `npm run engine:gen -- --check` — the generated schema codecs are up to date.
- `npm run build` then `node scripts/drive.mjs …` — drive the built app (each run uses its own user data; `thumb` checks Home's card images).
