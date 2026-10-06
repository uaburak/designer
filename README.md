# DesignerV2

burakkoc.net's design tool as a desktop app: the site's admin — its projects, their Figma-like editor, the shared library, the CV — in an Electron window that looks and works like Figma's desktop app. A tab bar with Home and the open files; Home is Figma's file browser; each project opens in a tab with the editor (canvas, layers, design and prototype panels).

It works on the site's own data — the same Firebase project as burakkoc.net (`burakkoc-a15d3`). What you save here is the site's draft; what you publish here is what the site shows.

## Run

```bash
npm install          # also downloads Electron's binary (postinstall: install-electron)
npm run dev          # the app, on the site's data — sign in with the admin's Google account
npm run dev:demo     # the app on demo data kept on this computer: no Firebase, no sign-in
```

In a browser, without Electron (the sign-in is Firebase's popup there):

```bash
npm run web          # http://localhost:5199, the site's data
npm run web:demo     # the same, demo data
```

## Build

```bash
npm run build        # out/ — run it with `npm start`
npm run dist         # dist/DesignerV2-<version>.dmg (macOS, arm64)
npm run check        # types, lint, tests — before committing
```

The app isn't signed with a Developer ID, so macOS asks before opening a downloaded copy the first time (right-click › Open).

## Signing in

Google doesn't allow signing in inside an app's own web view, so the sign-in happens in your browser: **Continue with Google** opens a page at `http://localhost:<port>` (served by the app, for this one sign-in), you pick the account there, and the app signs in to Firebase with what Google returns. The app remembers the sign-in. Only the accounts in `ADMIN_EMAILS` (`src/renderer/src/lib/auth.ts`) get in — the same list as the site's `firestore.rules` and `storage.rules`, which are what really protect the data.

`localhost` must stay in Firebase Authentication's authorized domains (it is by default).

## Where things are

| | |
|---|---|
| `src/main/` | Electron: the window, the app menu, closing with unsaved work, the `app://` protocol, the browser sign-in (`signIn.ts`) |
| `src/preload/` | what the page may ask of the desktop (`window.designer`, typed in `src/shared/api.ts`) |
| `src/renderer/src/app/` | the shell: the tab bar, the tabs, the sign-in screen, the dialogs |
| `src/renderer/src/home/` | Home: the sidebar, the file grid and list, the library, the trash |
| `src/renderer/src/tab/` | a tab's page: a project's editor, a saved draft's preview |
| `src/renderer/src/figma/` | the editor — the Figma clone from burakkoc.net's admin |
| `src/renderer/src/cv/` | the CV's editor and its live page |
| `src/renderer/src/lib/` | data (`firestore.ts`, `data.ts`), files (`storage.ts`, `media.ts`), sign-in (`auth.ts`) |
| `src/renderer/src/demo/` | the demo's data, files and sign-in (`--mode demo`) |
| `scripts/drive.mjs` | drives the built app with Playwright — screenshots, clicks, keys |

How it fits together: [docs/architecture.md](docs/architecture.md).
