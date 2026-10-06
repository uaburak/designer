# Architecture

DesignerV2 is burakkoc.net's admin as a desktop app. It reads and writes the site's Firebase project — the same documents the web admin (`burakkoc.net/Web/portfolio`, `/admin`) uses — so the two can be used side by side.

## The window

One `BrowserWindow` (`src/main/index.ts`), its title bar hidden (`hiddenInset`): the page draws Figma's tab bar itself, 40px tall, the traffic lights in its left 78px (none in full screen), its free room moving the window (`app-drag`).

Everything in the window is the renderer's — the tab bar, Home, the open files. The renderer is one page with two roles (`src/renderer/src/main.tsx`):

- **The shell** (no `?tab=`): the tab bar, Home, the sign-in, the dialogs.
- **A tab** (`?tab=<id>&kind=project|preview|cv&slug=<slug>`): one open file, loaded by the shell **in an iframe of its own**. Each tab is a document of its own: the editor's keys, clipboard and window listeners stay inside it, and its unsaved work lives in it while it is behind another tab (hidden with `visibility`, so its canvas keeps its size and view).

The shell and its tabs are the same origin and call each other directly (`src/renderer/src/app/bridge.ts`):

| | |
|---|---|
| `window.designerShell` (the shell's) | a tab reports its title, whether it is dirty, a save that went through; asks to open a project or a preview, to go Home, to close itself, to sign out |
| `window.designerTab` (each tab's) | the shell asks it to save, or whether it holds unsaved work |

Tabs (`src/renderer/src/app/tabs.ts`): Home, then the open files, kept in localStorage — the next launch opens them again. ⇧⌘T reopens a closed one.

### What only the desktop does (`src/main`, `src/preload`, `src/shared/api.ts`)

- **The menu** (`menu.ts`): its items send commands to the shell (`menu:command`): New Project ⌘N, Save ⌘S, Close Tab ⌘W, Reopen Closed Tab ⇧⌘T, ⌃Tab / ⌃⇧Tab, ⌘1 (Home) … ⌘9 (the last tab), the theme, Sign Out. A key the page uses itself (the editor's ⌘S, ⌘Z…) reaches the page first. The Edit menu's roles are what make copy and paste work in text fields on a Mac.
- **Closing with unsaved work**: the shell turns the guard on (`window:guard`); closing the window (or ⌘Q) asks the page (`window:close-requested`), which asks about every dirty tab — Save all, close without saving, Cancel — and then closes it (`window:close`) or keeps it (`window:close-cancel`). Closing one tab asks the same way, in the shell.
- **The theme**: system, light or dark — kept in localStorage (`designer-theme`), followed by every tab (`context/ThemeContext.tsx`), told to the desktop (`nativeTheme`) for its menus and the window's background.
- **Links**: an http(s) address opens in the browser (`setWindowOpenHandler`, `will-navigate`); the window never leaves the app.
- **The built page** is served from `app://designer` (a secure origin of its own) with a CSP (`CSP` in `index.ts`). While developing, it is electron-vite's dev server, and the page's warnings and errors come out in the terminal.
- **Storage's pictures**: the bucket sends no CORS header for its public files, so on the web the editor's export can't embed them; the app adds `Access-Control-Allow-Origin: *` to those GET answers.

## Signing in

Google refuses to sign in inside an app's web view, and Firebase's popup needs a page on an authorized domain. So (`src/main/signIn.ts`): **Continue with Google** starts a one-off server on `127.0.0.1` and opens `http://localhost:<port>/?state=<random>` in the system's browser. That page loads Firebase (from Google's CDN, the version the app runs), signs in with the popup (in memory only — nothing stays in the browser), and posts the Google credential back with the state. The app signs in to Firebase with it (`signInWithCredential`, `src/renderer/src/lib/auth.ts`); Firebase keeps the session in the app's IndexedDB, which every tab reads. The server answers this one sign-in and closes (on its own after ten minutes). Cancel closes it at once.

Who gets in: `ADMIN_EMAILS` (`lib/auth.ts`) — the same list as the site's `firestore.rules` and `storage.rules`, which are what protect the data.

## Data

All of it is the site's Firestore and Storage, read and written by `src/renderer/src/lib/firestore.ts` and `storage.ts` exactly as the web admin does — see the site's `docs/architecture.md` for the documents. In short:

| Document | What |
|---|---|
| `projects/{slug}` (+ `content/canvas`, `versions/{id}`) | a project: its fields, where it stands, its draft (one JSON text), its last 20 saves |
| `published/{slug}`, `publishedIndex/{slug}` | what the site shows of it, frozen at Publish |
| `design/variables`, `design/textStyles`, `design/library` | the design system, shared by every project |
| `cv/main` | the CV |

**Writes happen only on Save** (and the home's actions: create, duplicate, reorder, publish, unpublish, trash, restore, delete). A save writes everything it changed in one transaction, refused when a part was saved elsewhere since (its `rev`). Uploading a picture is the one immediate write.

New here: **the trash**. *Move to trash* sets `trashedAt` on the project and takes it off the site (its published documents deleted); its draft and versions stay until *Delete forever* (`deleteProject`). *Restore* brings it back as a draft. The web admin doesn't know the field: it lists a trashed project as a draft.

`lib/data.ts` holds what the data layer shares without Firebase: the limits, the errors, the stored shapes, `errorText`.

### The demo

`--mode demo` (`npm run dev:demo`, `npm run web:demo`) swaps three modules at build time (`vite.shared.ts`): `@/lib/firestore` → `demo/firestore.ts`, `@/lib/storage` → `demo/storage.ts`, `@/lib/auth` → `demo/auth.ts`. Same functions, kept in this computer's IndexedDB, a few sample projects to begin with; nothing reaches Firebase. Their signatures are checked against the real ones (`typeof Real.fn`).

## Home (`src/renderer/src/home`)

Figma's file browser for the site's projects. The sidebar: the account (theme, sign out), search, **Recents** (opened on this computer), **Published**, then the site as Figma's team — **Drafts**, **All projects**, **Library**, **CV**, **Trash** — and the starred files. The files as cards (the cover, or a cover made of the title) or a list; filter (all, published, drafts, changed since published) and sort (last modified, opened, created, alphabetical, site order).

A click opens a file in a tab (or brings its tab forward); ⌘/⇧-click selects; the right click, ⌫ (to the trash), ⌘A, Enter and Esc work on the selection. In *Site order* the cards are dragged to reorder the site's lists. Recents, starred files and how the lists are shown are this computer's (`prefs.ts`), not the site's data.

**Library** draws the shared library as it is: every component (rendered by the editor's `NodeView`), the colour variables, the text styles.

## The editor (`src/renderer/src/figma`)

The web admin's Figma clone, as it is there — model, canvas, panels, prototype player, export (see the site's `docs/architecture.md`, *The editor*). `tab/EditorTab.tsx` wraps it with the session (`figma/session.ts`: load, local undo, save, publish, versions) and reports to the shell. What changed for the desktop:

- *Back to files* (main menu) brings Home forward; the file stays open behind it.
- *View on site* opens burakkoc.net in the browser; *Preview the saved draft* opens a preview tab (`tab/PreviewTab.tsx`: the site's page at desktop, tablet and phone widths, in the site's colours).
- Leaving with unsaved work is the shell's question (the editor's `beforeunload` and history guard are gone).

**Keep the site in step.** The site draws a published page with its own copy of the renderer (`src/figma` in the portfolio: `model.ts`, `NodeView.tsx`, `css.ts`, `PageView.tsx`…). A change here to the model or to how a node draws must be made there too, or a page published from here draws differently on the site.

## The CV (`src/renderer/src/cv`)

The web admin's CV editor in a tab: the form on the left, the CV page as the site draws it on the right (in the site's colours). Save (⌘S) writes `cv/main`; undo and redo in memory; the shell asks before the tab closes with something unsaved.

## Checks

`npm run check`: types (main and renderer), lint, tests (the model, the shared library, slugs, arithmetic in number fields — pure, no browser, no Firestore).

`scripts/drive.mjs` drives the built app with Playwright — launch, screenshots, clicks, keys, the menu's commands, code in the page or in the tab in front:

```bash
npm run build -- --mode demo
node scripts/drive.mjs launch "click-text All projects" "ss all" quit
```

Each run uses its own user data (`DESIGNER_USER_DATA`), so the everyday app's sign-in and tabs are left alone.
