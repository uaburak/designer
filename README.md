# DesignerV2

A 1:1 clone of the Figma desktop app, for personal use: Figma's UI3 look and wording, a tab bar with Home and the open files, Home as Figma's file browser (Recents, Drafts, folders, Starred, Trash), and each file in its own tab with the editor (canvas, layers, design panel). The canvas is a C++ engine compiled to WebAssembly and drawn with its own WebGL2 renderer. Files live on this computer, saved as you go; there is no multiplayer and no sign-in.

Start with [AGENTS.md](AGENTS.md) and [docs/handoff.md](docs/handoff.md); how it fits together is in [docs/architecture.md](docs/architecture.md).

## Run

```bash
npm install          # also downloads Electron's binary (postinstall: install-electron)
npm run dev          # the app (Vite dev server + Electron)
npm run dev:demo     # the same, with Figma's sample files imported into a new workspace
```

In a browser, without Electron (an in-memory workspace, nothing saved to disk):

```bash
npm run web          # http://localhost:5199 — Home; ?editor, ?gallery, ?engine, ?tabbar
```

Files are kept in `~/Library/Application Support/DesignerV2/Workspace` (`DESIGNER_WORKSPACE` sets another folder); Help › Open data folder shows it.

## Build

```bash
npm run build        # out/ — run it with `npm start`
npm run dist         # dist/DesignerV2-<version>.dmg (macOS, arm64)
npm run check        # types, lint, tests — before committing
npm run engine:test  # the engine's native tests
```

The app isn't signed with a Developer ID, so macOS asks before opening a downloaded copy the first time (right-click › Open).

## Where things are

| | |
|---|---|
| `src/main/` | Electron: the window, the tabs, the menu bar, flushing on close and quit, the `app://` protocol, the store's process (`storeHost.ts`) |
| `src/preload/` | what each view may ask of the desktop (`window.designer`, typed in `src/shared/desktop.ts`) |
| `src/shared/` | IPC channels, the command registry, the tabs reducer, the document schema and the store's protocol |
| `src/store/` | the store: the only writer of the workspace (a utility process) |
| `src/renderer/src/files/` | Home, the file browser |
| `src/renderer/src/editor/` | a file's editor |
| `src/renderer/src/engine/` | the engine's TypeScript side and its WebAssembly build (`engine/` is the C++) |
| `src/renderer/src/ds/` | the design system (`?gallery`) |
| `src/renderer/src/app/` | the tab bar's view |
| `scripts/drive.mjs` | drives the built app with Playwright — screenshots, clicks, keys |
