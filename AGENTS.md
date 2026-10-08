# DesignerV2

**Work in progress — read [`docs/handoff.md`](docs/handoff.md) first**: where each workstream stopped, what to verify, and what to do next.

A 1:1 clone of the Figma desktop app for one person's own use — Figma's UI3 look and wording, Figma's semantics (Home with Drafts, folders, Recents, Starred, Trash; files with pages; every file owning its local variables, styles and components; libraries published from any file and enabled in others, updates reviewed and accepted). The one thing Figma has that this doesn't: multiplayer.

How it is built is in the contracts, which decide over anything else: `docs/architecture.md` (overview), `schema/document.kiwi` + `docs/schema.md` (the document), `docs/engine.md` (the engine and its bindings), `docs/desktop.md` (processes, IPC), `docs/data.md` (storage, libraries, Firebase), `docs/design-system.md` (the chrome's look). The research they rest on is in `docs/research/`. Rules that hold everywhere:

- The canvas is the engine's: C++ (`engine/`) compiled with Emscripten to WebAssembly, drawing with our own renderer on one WebGL2 canvas — no DOM, Skia or CanvasKit for design objects. The scene graph, layout, hit-testing, gestures and undo live in C++; the React panels read and change the document only through the generated flat API in `src/renderer/src/engine/` (no embind).
- `schema/document.kiwi` is the one definition of the document (Figma's own schema, trimmed: Figma's names and field numbers). C++ and TypeScript codecs are generated from it; a change to the document is a `NODE_CHANGES` message carrying only the touched fields — files, the journal, undo, the clipboard and the engine stream all use it.
- Each window holds a tab bar, Home and one view per open file, each its own `WebContentsView` and renderer process (`src/main`); views talk to main only through the typed channels in `src/shared/ipc.ts`, and to the store over their MessagePort.
- The store (`src/store`, a utility process) is the only writer of the workspace on disk; Firebase is an adapter behind the same repositories, off until configured. Nothing writes files from a view.
- The chrome uses the design system in `src/renderer/src/ds` (Figma's `--figma-color-*` tokens, CSS Modules) — no hard-coded colours or sizes, no utility-class frameworks.
- The UI is English, in Figma's wording.

Before committing: `npm run check` (types, lint, tests) and `npm run engine:test` (the engine's native tests). To see a change: `npm run dev:demo`, `?gallery` for the design system, `?engine` for the engine's playground, `npm run viewer` (the developer preview viewer, `?src=<preview folder>`; `npm run viewer:check` exports a synthetic file and opens it headless), or drive the built app with `scripts/drive.mjs`. The Emscripten toolchain is at `~/emsdk` (activate with `export EMSDK_PYTHON=$(~/Library/Python/3.9/bin/uv python find 3.12); source ~/emsdk/emsdk_env.sh`); CMake and Ninja are in `~/Library/Python/3.9/bin`.
