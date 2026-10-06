# Desktop shell — as built

## Status (final integration round, 2026-10-06)

- **Home thumbnails (fixed).** There were two causes:
  - **No thumbnail at all.** A tab closed (or the app quit) within the editor's 4 s thumbnail debounce never wrote one. Main ends the view right after the flush handshake, so the timer and the React cleanup never ran.
  - **A card that looked blank.** The engine renders the page's content bounds edge to edge, so a single shape filled the whole card with one colour.

  Fixes in `src/renderer/src/editor`:
  - The flush handler (`desktop.ts`) awaits `EditorController.beforeFlush` (the pending thumbnail) before the document flush, for every reason (close, quit, hide, discard, reload).
  - `captureThumbnail` (`persistence.ts`) fits the content within 600 × 340 and centres it on an 800 × 600 image in the page's colour. Home's card crops the image to about 16:9 (object-fit: cover), and that band keeps the content and a margin visible.

  The rest of the pipeline was verified working: the store writes `thumbnail.png` and bumps `FileMeta.thumbnail.version`; Home re-reads on the watch event; `_thumb?v=N` is served with CORP `cross-origin` and loads under COEP, in the built app and under the dev server. `scripts/drive.mjs thumb [fileKey]` samples a card's image and fails on a missing or one-colour thumbnail.
- **`firebase` is a dependency** (the store's sync drivers import it at run time in a packaged app).
- **Dev servers are cross-origin isolated too.** `vite.shared.ts` `isolationHeaders()` is the dev server's (electron-vite and `vite.web.config.ts`) and preview's `server.headers`; `DESIGNER_CROSS_ORIGIN_ISOLATED=0` turns it off. Verified: `crossOriginIsolated` is true in all six browser routes, and Electron against the dev server shows Home, the editor and the cross-origin `_thumb` images.

## Status (integration round 2, 2026-10-06): legacy removed

This section supersedes everything below it: the round-1 status that follows and §1–§11, which describe the first build. Read those only for the parts this section doesn't change.

**Done**
- **The new Home is the only Home.** The Home view loads `?files` (FilesApp). A page with no query, in a browser, is Home too. The switch (`DESIGNER_NEW_HOME`, `settings.json` `newHome`, `DEFAULT_NEW_HOME`) is gone. "+" and ⌘N call `nav:new-file`, which creates `Untitled` in Drafts through the store and opens it.
- **Legacy deleted.**
  - Renderer: `src/renderer/src/{figma,cv,home,lib,demo,components,context,types,styles,tab}`. From `app/`: `HomeApp`, `AuthGate`, `Shell`, `ShellApp`, the old `TabBar`, `bridge`, `icons`, `ui`, `tabs`.
  - Main and shared: `src/main/signIn.ts`, `src/main/env.d.ts`, `src/shared/api.ts`, `src/shared/firebaseConfig.ts`.
  - Channels: `auth:google`, `auth:cancel`, `session:auth`, `session:request-sign-out`, `session:sign-out`, `tab:request`, `tab:response`.
  - The `project` / `preview` / `cv` tab kinds and `slug`; dirty dots, Save and the Save/Don't Save dialogs; the sign-in gate.
  - The Sign Out and Save menu items, the Firebase Storage CORS hook, and the `__FIREBASE_VERSION__` / `__DEMO__` defines and the demo aliases.
  - Dependencies: `tailwindcss`, `@tailwindcss/vite`, `tailwind-merge`, `gsap`, `@gsap/react`, `prismjs`, `@types/prismjs`, `dompurify`; `npm run web:demo` too.
  - Kept: `firebase` (the store's sync drivers import it lazily) and `clsx` (`ds/util/cx.ts`).
- **Tabs are files only.** A tab is `{id, kind: "file", fileKey, title, status}`. Restoring a session drops any old site-admin tabs.
- **The tab bar** is the design system's `TabBar` (`ds/components/TabBar`) inside `app/TabBarApp.tsx`.
- **Theme only through `ds/theme.ts`.** `main.tsx` imports `ds/global.css`, which brings Inter and `tokens.css`. In `boot.js`, the desktop's `window.designer.theme` now wins over localStorage (a stale page copy could flash the wrong theme before).
- **Cross-origin isolation is on by default:** COOP `same-origin`, COEP `require-corp`, CORP on every `app://` response, and CORP `cross-origin` on `/_blob` and `/_thumb`. Verified: `crossOriginIsolated === true` and `SharedArrayBuffer` exist in Home, the tab bar and editors, and the engine and thumbnails load. `DESIGNER_CROSS_ORIGIN_ISOLATED=0` turns it off. The CSP has no network origins any more.
- **Menu bar.** `file.move` is "Move to folder…" and `file.delete` is "Move to trash", as in Home. In Home, Edit › Select all and Edit › Delete chosen from the menu go to Home as `menu:command`: they act on its file selection, and Home reports their enablement. Keys Home leaves unhandled, and Undo/Redo, still act natively on its text fields. Unknown `menu:state` keys (the editor's `tool.*`, `theme.*`) are dropped.
- **Quit.** Once the windows' files have flushed, `finishQuit()` (`window.ts`) stops the store and writes `session.json`, then calls `app.exit(0)`. A second `app.quit()` after a cancelled one was ignored on the SIGTERM path, which left the app running with the workspace locked. Verified: SIGTERM and SIGINT both exit and release the lock.
- **`scripts/drive.mjs`**:
  - strips `ELECTRON_RUN_AS_NODE` itself;
  - retries a launch that hangs: COOP's first-load process swap sometimes leaves Playwright's attach waiting forever, about half of launches. The app itself starts every time; with isolation off, 12 of 12 launches attached.

**Acceptance verified with `scripts/drive.mjs`** (`npm run build -- --mode demo`; screenshots in `/tmp/designer-work/desktop/r2/`):
1. Launch → Home, no sign-in.
2. Home's "New design file" → an `Untitled` tab (`?editor&file=`).
3. Drew a frame and a rectangle; Layers shows Frame 1 and Rectangle 1.
4. Closed the tab, quit, relaunched, and double-clicked the card in Home: both layers are there.
5. With a second file open, the two editors run in separate renderer processes.
6. Edit › Move to trash from Home trashed the first file and closed its open tab; Trash › Restore brought it back, and it still opens with both layers.
7. Quitting with an edited file open, then relaunching, restores the tab with its layers.
8. In a browser (`vite.web.config.ts` on 5205), `/`, `?files`, `?editor`, `?gallery`, `?engine` and `?tabbar` all load with no page errors.

**Next**
- The `/_blob` and `/_thumb` token.
- `tab:attach` and the spare editor; `tab:navigate`.
- `tabs:overflow-menu`, fonts, clipboard and settings channels.
- Deep links (a tab's "Copy link" is disabled until then).
- The discard policy.
- `crashed.html`.
- Separate HTML entries per role.

---

## Status (integration round 1, 2026-10-06)

The sections below §0 were written before that round.

**Done**
- **Store process.** `src/main/storeHost.ts` starts `out/main/store.js` (second main entry in `electron.vite.config.ts`) through `src/store/host.ts` before the first window. It restarts the store at most 3 times in 60 s, then asks `DesignerV2 can’t save changes right now.` with `Try Again` / `Quit`. Every Home and editor view gets a fresh `MessagePort` on every page load and after every restart (`store:port`). The preload holds the port until the page posts `designer:store-port-wanted`, then forwards it as `designer:store-port`. On quit, the store is flushed (`store.flushAll`) and shut down in `will-quit`, after the windows' tabs have flushed. The workspace is `DESIGNER_WORKSPACE` or `<userData>/Workspace`. `DESIGNER_SEED=demo` imports `docs/research/figma/samples/*.fig` into an empty workspace.
- **`app://designer/_blob/<sha1>` and `/_thumb/<fileKey>.png`** are served read-only from the workspace. Names are matched against a pattern; blob MIME is sniffed. The per-launch token is not enforced yet.
- **File tabs.** `kind: "file"` with `fileKey` (`src/shared/tabs.ts`); a file tab's `slug` is `""`. Each file tab has one tab per file and loads `?editor&file=<fileKey>&tab=<tabId>` in its own process. On `file.renamed`/`file.updated` the tab is retitled. On `file.trashed`/`file.deleted` the tab is flushed and closed without a question, and the file is removed from the closed history. File tabs are kept in `session.json` (with `fileKey`); at launch, files that are gone or in the trash are dropped and names are refreshed from the store. ⇧⌘T skips files that are gone. Showing a file tab calls `workspace.recordViewed`.
- **Autosave semantics.** File tabs have no dirty dot and no Save dialog. Closing a tab or window, quitting or signing out sends `tab:flush {reason: "close"|"quit"}` (3 s). If the flush fails, main asks `Your recent changes to “‹name›” couldn’t be saved.` (`Try Again` / `Close Anyway` or `Quit Anyway` / `Cancel`). If it times out, main asks `“‹name›” isn’t responding.` (`Wait` / `Close Tab` or `Quit Anyway`). Hiding a tab (another tab comes in front), Reload Tab, and the Mac sleeping or locking also flush, without waiting (reason `"hide"` or `"reload"`). Legacy tabs keep their Save, dirty dot and `tab:request`.
- **Home switch.** Home loads `?files` (the new file browser) when `DESIGNER_NEW_HOME=1` or when `settings.json` has `"newHome": true`. Otherwise it loads `?home` (legacy). `DESIGNER_NEW_HOME=0` forces the legacy Home. **To flip the default:** `DEFAULT_NEW_HOME = true` in `src/main/session.ts`. While the legacy Home is the Home, "+" and ⌘N open its New Project dialog. `nav.newFile()` from Home or an editor always creates a store file.
- **Menu bar.** Figma's menu bar is built from `MENU_LAYOUT` in `src/shared/commands.ts`: File, Edit, View, Object, Text, Arrange, Vector, Window, Help, after the app menu (About, Theme, Sign Out (legacy), Services, Hide, Quit). Labels use Figma's sentence case, and ids are the editor's (`src/renderer/src/editor/commands.ts`). Scopes:
  - `app` and `shell` are handled by main.
  - `view` goes to the view in front: Home or a file.
  - `editor` goes only to a file tab.
  - Undo, Redo, Select all and Delete run natively in Home.

  Enabled and checked state comes from the view in front (`menu:state`). Main merges it per view, mutates the items in place on activation and on every report, and never rebuilds the menu. View and editor items stay disabled until the view reports them. Main keeps three exceptions enabled: `file.close-tab` (when a tab is in front), `file.reopen-closed-tab` (`canReopen`), and `file.save-local-copy` (main writes the copy of the file in front itself). Accelerators without ⌘ or ⌃ (⇧R, ⌥A, ⌫, PgUp) are shown but not registered, so they never take a letter typed into a field.
- **Import… / Save local copy… / Open data folder** go through main's native dialogs and main's store client (`src/main/files.ts`).
- **Theme aliases.** `onThemeChange` and `window.desktop` / `legacyDesktopAlias` are no longer in `src/preload/common.ts`. `ds/theme.ts` uses only `window.designer.theme`, `setTheme` and `onThemeChanged`, and nothing else reads the aliases. The stale `window.desktop` comment in `src/shared/api.ts` was corrected.

**Verified with `scripts/drive.mjs`** (built with `npm run build -- --mode demo`; unset `ELECTRON_RUN_AS_NODE` if the shell has it):
- The store's utility process starts and takes `Workspace/.lock` (`{pid, startedAt}`). The lock is released after quit.
- The Home view gets a port and the store's hello (`{t: "hello", role: "home", generation: 1}`).
- `new-file` twice opens two `?editor&file=` tabs, each in its own renderer process.
- On relaunch, file tabs come back lazily with their store names.
- Renaming in the store retitles the tab, and trashing the file closes its tab.
- Close tab and ⇧⌘T work.
- A view's `menu.setState` enables and checks the Object, Edit and View items; Home in front disables the editor items.
- Hiding a tab flushes with `"hide"`. A rejected flush asks the Try Again / Close Anyway / Cancel question.
- After the store is killed, generation 2 starts, takes the stale lock, and a page that asked gets `port 2`.
- The legacy Home and CV tab still work: Save is enabled only there.

**Next**
- The legacy removal (handoff step 1), then `DEFAULT_NEW_HOME = true`, removal of the sign-in gate, the `session:*`/`auth:*` channels and `tab:request`, and `slug` from tabs.
- The `/_blob` and `/_thumb` token (handed out by `desktop:init`).
- `tab:attach` and the spare editor; `tab:navigate` for `pageId`/`nodeId` (accepted by `nav:open-file`, not acted on yet).
- `tabs:overflow-menu`, fonts, clipboard channels, `settings:*`, and Settings… ⌘,.
- Deep links (a file tab's "Copy link" is disabled until then).
- Discard policy.

### Channels and preload API added this round

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `nav:open-file` | invoke | H E | `{fileKey, title?, background?, pageId?, nodeId?}` or legacy `{kind, slug, title?}` → `{tabId, existing}` |
| `nav:new-file` | invoke (was send) | T H E | `{folderId?: string\|null, name?}` → `{fileKey, tabId}`, or `null` when T/⌘N open the legacy Home's dialog |
| `nav:go-home` | send | E | `{revealFileKey?}`. Without it, main reveals the editor's own file. |
| `file:import` | invoke | H E | `{folderId, paths?}` → `{files: {fileKey, name}[], failed: {path, error}[]}` (no paths: the Open dialog) |
| `file:save-local-copy` | invoke | H E | `{fileKey}` → `{path} \| {cancelled: true}`. An open tab of the file is flushed first. |
| `file:reveal-data-folder` | send | H E | `void` |
| `tab:flush` | event | E | `{reqId, reason: "close"\|"quit"\|"discard"\|"reload"\|"hide"}` |
| `tab:flushed` | send | E | `{reqId, ok, error?}` |
| `menu:state` | send | H E | `MenuStatePatch {enabled?, checked?}` (only what changed) |
| `home:reveal` | event | H | `{fileKey}` (a tab's "Show in file browser", an editor's "Back to files") |
| `store:port` | event + MessagePort | H E | `{generation}` |
| `desktop:init` | invoke | All | now also `fileKey` (the editor's file, else null) |
| `home:state` | event | H | now also `openFileKeys` |

`window.designer` (types in `src/shared/desktop.ts`):
- **Home and editor**:
  - `nav.openFile(fileKey, {title?, background?}?) → Promise<{tabId, existing}>`, or `nav.openFile({kind, slug, title?})` for legacy.
  - `nav.newFile(folderId?, name?) → Promise<{fileKey, tabId} | null>`.
  - `files.import(folderId, paths?)`, `files.saveLocalCopy(fileKey)`, `files.pathFor(file)` (webUtils), `files.revealDataFolder()`.
  - `menu.onCommand(cb)`, `menu.setState(patch)`. Patches are merged and sent once per 16 ms.
- **Home** also has `home.onReveal(cb)`.
- **Editor** also has:
  - `tab.onFlush(cb: (reason) => void | Promise<void>)`. Resolve when everything is in the store and `files.flush` returned; a rejection is reported as a failed save. With no handler, the preload answers ok at once.
  - `nav.goHome(revealFileKey?)`, which is "Back to files".
- **What the views must do:**
  - The editor registers `tab.onFlush` (send pending batches, `await source.flush()`) and reports `menu.setState` from its commands' `enabled`/`checked`.
  - The editor reports the file's real name (`tab.report({title})` wins over the store's name).
  - The editor answers `menu:command` ids as `runEditorCommand(ed, id)`.
  - The new Home handles `menu:command` for `file.duplicate|rename|move|delete|save-local-copy` and reports their enablement.

`scripts/drive.mjs` now finds every view's page by main's URL (`?files` and `?editor&file=` too) and has `store`, `new-file [name]`, `open-file <fileKey>` and `files [drafts|recents|trash]`. `__designer` (under `DESIGNER_TEST=1`) adds `store()`, `storeClient()` and `newHome()`.

---

Status (first round): implemented 2026-10-06. This describes what the code does today. `docs/desktop.md` is the contract this work follows; where the two differ, the reason is a legacy feature that must keep working until the new data layer and engine land (§10 lists every difference).

---

## 1. Process model

```
main (Electron main, Node)                    src/main/
 ├─ WindowController (v1: one window)          window.ts
 │   ├─ BaseWindow  hiddenInset, traffic lights {14, 12}, no page of its own
 │   ├─ tabbar  WebContentsView ── renderer process   index.html?tabbar      preload/tabbar.js
 │   ├─ home    WebContentsView ── renderer process   index.html?home        preload/home.js
 │   └─ editor  WebContentsView × open file tabs, each its own renderer process
 │                                                    index.html?tab=<id>&kind=<kind>&slug=<slug>   preload/editor.js
 ├─ TabManager (tabs, views, unsaved-work questions, crash/hang)   tabs.ts
 ├─ menu (from src/shared/commands.ts)          menu.ts
 ├─ IPC handlers, each checked                  ipc.ts
 ├─ app:// protocol, CSP                        protocol.ts
 ├─ session.json / settings.json                session.ts
 ├─ native dialogs                              dialogs.ts
 ├─ theme (nativeTheme, theme:changed)          theme.ts
 └─ Google sign-in in the browser (legacy)      signIn.ts
```

Measured with `scripts/drive.mjs` (the `tabs` command prints `webContents.getOSProcessId()` per view): the tab bar, Home and every loaded file tab each run in a different renderer process. A crash in one (`forcefullyCrashRenderer`) leaves the others' process ids unchanged.

Every view: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `webviewTag: false`, `backgroundThrottling: true`, `v8CacheOptions: "bypassHeatCheck"`, spellcheck except in the tab bar, and `additionalArguments` `--designer-role`, `--designer-version`, `--designer-theme=<preference>:<resolved>`. `app.enableSandbox()` is called before `ready`. Links out (`setWindowOpenHandler`, `will-navigate`) go to the system browser; `will-attach-webview` is refused; editable fields get the native context menu with spelling suggestions.

All views share the default session and the `app://designer` origin (dev: the Vite server's origin), so localStorage, IndexedDB (Firebase Auth's persistence, the demo store) and `storage` events are shared across processes. The legacy theme and demo sign-in sync between views relies on that.

### Hidden views

`view.setVisible(false)`. Measured in Electron 44 outside Playwright (a standalone BaseWindow + two WebContentsViews): a hidden view reports `document.visibilityState === "hidden"`, requestAnimationFrame stops (0 frames/s) and timers are throttled to about 1/s; shown again, it is back to 120 frames/s. `removeChildView` behaves the same, so views stay children and are only toggled. This answers open question 1 of `docs/desktop.md`. Main also sends `tab:visibility` (the contract's explicit signal); the legacy pages ignore it.

Under Playwright the hidden pages stay `visible` and keep rendering (the attached CDP session keeps them alive), so this cannot be measured with `drive.mjs`.

---

## 2. The window

- `BaseWindow` (no webContents of its own), `minWidth 800`, `minHeight 520`, shown when the tab bar has painted (`shell:ready`) and the content view in front has loaded, or after 1.5 s.
- **Layout** (`WindowController.layout`, on `resize`, which macOS sends continuously while dragging, and on full-screen changes): the tab bar at `{0, 0, W, 38}`, every content view, hidden ones included, at `{0, 38, W, H − 38}`. Verified: after `setSize(1100, 760)` the tab bar is `{0,0,1100,38}` and the view in front `{0,38,1100,722}`.
- **Full screen**: `window:state {fullScreen, focused}` goes to every view; the tab bar's left room drops from 80 to 8 px.
- **Closing** (red button, ⇧⌘W, ⌘Q): the `close` event is prevented, `TabManager.settleAll()` asks about unsaved tabs (§5), then the window closes, or the app quits.
- The window's place (bounds, maximized, full screen) and its tabs are kept in `session.json`. macOS: closing the window does not quit; `activate` reopens it from the session.

---

## 3. Views and pages

One HTML page (`src/renderer/index.html`), a role per query (`src/renderer/src/main.tsx`), each role a lazy chunk:

| Query | Page | Notes |
|---|---|---|
| `?tabbar` | `app/TabBarApp.tsx` | Renders `app/TabBar.tsx` (today's look) from main's `tabs:state`; 38 px, `#3b3b3b` dark, 1 px bottom line, 80 px traffic-light room. Signed out: a bare drag strip. |
| `?home` (and the default when `window.designer` exists) | `app/HomeApp.tsx` | `AuthGate` (legacy sign-in) around `home/Home.tsx` and the New Project dialog. |
| `?tab=<id>&kind=project\|preview\|cv&slug=` | `tab/TabApp.tsx` | The legacy editor, preview and CV pages; `tab/host.ts` connects them to main. |
| `?gallery` | `ds/Gallery.tsx` | Through `import.meta.glob`, so the build never fails while the module is missing; a note is shown instead. |
| `?engine` | `engine/Playground.tsx` | Same. |
| none, in a browser | `app/ShellApp.tsx` | `npm run web`: the old same-origin iframe shell (`app/Shell.tsx`), kept for browser use only. |

`public/boot.js` sets `data-theme` before the first paint: the localStorage preference the legacy pages keep, else the preload's `window.designer.theme`, else the system's. It also sets the tab bar's own background in the tab bar view.

---

## 4. TabManager (`src/main/tabs.ts`)

- **State**: the pure reducer in `src/shared/tabs.ts` (moved from `app/tabs.ts`, tested in `src/shared/tabs.test.ts`): `{tabs, active, closed (≤ 20)}`, open next to the active tab (at the end from Home), dedupe by kind and slug, close brings the right neighbour forward (then the left one, then Home), `move`, `reopen`, plus `status` for main's own statuses (`discarded`, `crashed`, `unresponsive`).
- **Runtime** per loaded tab: `{view, crashed, hung (AbortController of the hang dialog), asking, restarting}`.
- **Lazy restore**: tabs come back from `session.json` as `discarded` with no view. Only the active one gets a view at launch; any other gets one the first time it is shown. Verified: after relaunch `tabs` shows the active tab with a pid and the others as `(no view) … discarded`; activating one creates its view.
- **Show** (`show()`): ensure the target's view, `setVisible(true)` on it, `setVisible(false)` on the rest, send `tab:visibility`, `webContents.focus()` on it, push `tabs:state` and `home:state`, persist (debounced). A crashed or hung tab shown asks its question again.
- **Reorder**: the reducer's `move` only. No view is touched. Verified: with an unsaved rectangle in a tab, dragging it in the tab bar keeps the same webContents id, process id, a `window.__marker` set before the move and the unsaved change.
- **Close**: ask the tab whether it has unsaved work (`tab:request {op: "is-dirty"}`, 1.5 s timeout, falling back to the tab's last report). If so, activate it and show the native dialog `Save / Don’t Save / Cancel`. Save sends `tab:request {op: "save"}` (120 s timeout; 10 s for a hung tab) and closes only when the page answers `true`. Then the reducer's `close`, `removeChildView`, `webContents.close()`.
- **Reopen** (⇧⌘T): the reducer's `reopen`, which gives a new id and a new view.
- **⌘1–⌘9, ⌃Tab, ⌃⇧Tab, ⌘W**: menu accelerators, handled by `TabManager.command`. While a tab is `unresponsive`, its view's `before-input-event` catches ⌘W, ⌃Tab, ⌃⇧Tab and ⌘1–⌘9, so a hung tab can still be left or closed.
- **The sign-in gate (legacy)**: Home reports `session:auth {signedIn}` (an admin signed in or not). While `false`, no file tab is shown, their views are closed, the tab bar shows no tabs, and tab commands do nothing; the tabs stay in the session for the next sign-in. Sign out (menu, Home, an editor's account menu) runs `settleAll("sign-out")`, resets the tabs, then sends Home `session:sign-out`, which calls `signOutUser()`.

---

## 5. Unsaved work, closing, quitting

The legacy editor (`kind=project`) and the CV editor have explicit Save against Firebase, so the dirty-dot and Save/Don’t Save guard stays for them. The contract's autosave and flush handshake apply to the engine's files later.

| Moment | What happens |
|---|---|
| Close one tab | `is-dirty` → `Do you want to save the changes you made to “‹title›”?` with `Save / Don’t Save / Cancel` |
| Close window (red button, ⇧⌘W) | every loaded tab asked in parallel → one dialog for all dirty tabs: `Save All / Close Without Saving / Cancel`; Save All activates each dirty tab in turn and saves it, since a hidden page's timers are throttled |
| ⌘Q | the same, with `Quit Without Saving` |
| Sign out | the same, with `Sign Out Without Saving` |
| A save fails or times out | `“‹title›” couldn’t be saved.` and the close is cancelled |

All of these were driven end to end in the demo build: Cancel keeps the tab or the window, Don’t Save closes it, Save and Save All write the draft (the rectangle drawn before closing is there after reopening and after a relaunch).

---

## 6. Crashes and hangs

| Event | Response |
|---|---|
| A file tab's `render-process-gone` (not `clean-exit`) | Status `crashed`. If it is in front, `“‹title›” crashed.` with `Reload / Close Tab`; otherwise the question waits until the tab is shown. Reload reloads the view in a new process; Close Tab closes it without asking. |
| A file tab's `unresponsive` | Status `unresponsive`. If it is in front, `“‹title›” isn’t responding.` with `Wait / Reload Tab`, taken away by `responsive` (AbortSignal). Reload Tab kills the renderer (`forcefullyCrashRenderer`) and reloads the page once the process is gone. |
| Home's or the tab bar's `render-process-gone` | Reloaded at once. |

Verified: a forced crash with Reload gives the tab a new process id while Home and the tab bar keep theirs, and Close Tab closes it. Hang handling was verified by emitting `unresponsive` on the view, because Chromium never reports a hang while a debugger (Playwright) is attached: Reload Tab gives a new process, Wait keeps it, and ⌘W sent to the hung view closes it.

---

## 7. IPC (`src/shared/ipc.ts`)

Every handler goes through `check()` in `src/main/ipc.ts`. The sender must be a registered view, its role must be allowed on the channel, the message must come from the view's main frame, and the frame must be on an app URL (`app://` or the dev server's origin). Otherwise the message is dropped and logged once. A file tab never names its own tab: main knows which view sent the message. Payloads are type-checked again in main (string lengths, kinds).

**invoke** (view → main → answer)

| Channel | Roles | Payload → result |
|---|---|---|
| `desktop:init` | T H E | `→ {version, platform, role, tabId, windowId, theme}` |
| `tabs:get` | T H | `→ TabsSnapshot {windowId, tabs (Home first), activeTabId, canReopen, fullScreen, signedIn}` |
| `nav:open-file` | H E | `{kind: "project"\|"preview"\|"cv", slug, title?} → {tabId}` |
| `theme:set` | T H E | `ThemePreference → {preference, resolved}` |
| `menu:popup` | T H E | `{template: NativeMenuItem[], x, y}` (view coordinates) → picked `id` or `null` |
| `auth:google` | H | `→ SignInResult` (legacy, the browser sign-in) |

**send** (view → main)

| Channel | Roles | Payload |
|---|---|---|
| `shell:ready` | T H E | after the first paint |
| `tabs:activate` | T H | `{tabId}` |
| `tabs:close` | T E | `{tabId}`; an editor closes only itself |
| `tabs:move` | T | `{tabId, toIndex}`, Home = 0 |
| `tabs:context-menu` | T | `{tabId, x, y}` → native menu: Close Tab · Close Other Tabs · Close Tabs to the Right · — · Copy Link · Show in File Browser · — · Reopen Closed Tab |
| `tabs:reopen` | T H | |
| `nav:new-file` | T H E | legacy: activates Home and opens its New Project dialog |
| `nav:go-home` | E | |
| `tab:report` | E | `{title?, dirty?, status?, savedAt?}` |
| `tab:response` | E | `{reqId, ok, value?, error?}`, the answer to `tab:request` |
| `session:auth` | H | `{signedIn}` (legacy gate) |
| `session:request-sign-out` | H E | |
| `auth:cancel` | H | |
| `shell:open-external` | H E | `{url}`, only `http(s):` and `mailto:` |

**events** (main → view)

| Channel | To | Payload |
|---|---|---|
| `tabs:state` | T H | `TabsSnapshot`, on every change |
| `window:state` | T H E | `{fullScreen, focused}` |
| `menu:command` | H E | `{id: CommandId, source: "menu"\|"accelerator"}` |
| `tab:visibility` | E | `{visible}` |
| `tab:request` | E | `{reqId, op: "is-dirty"\|"save"}`; main always waits with a timeout |
| `home:state` | H | `{visible, openSlugs, savedAt}` |
| `session:sign-out` | H | sign out now (unsaved tabs settled) |
| `theme:changed` | T H E | `{preference, resolved}` |

**`window.designer`** (`src/shared/desktop.ts`), one per role, exposed with `contextBridge`:

- **All roles**: `role`, `platform`, `version`, `init()`, `ready()`, `theme` (the boot snapshot), `setTheme(p)`, `onThemeChanged(cb)` (alias `onThemeChange`), `onWindowState(cb)`, `onFullScreen(cb)`, `menu.popup(template, at)`.
- **tabbar**: `tabs.{get, onState, activate, close, move, contextMenu, reopen, newFile}`.
- **home**: `tabs.{get, onState, activate, reopen}`, `nav.openFile`, `home.onState`, `menu.onCommand`, `session.{auth, requestSignOut, onSignOut}`, `signInWithGoogle`, `cancelSignIn`, `openExternal`.
- **editor**: `tab.{report, onVisibility, onRequest, close}`, `nav.{openFile, goHome, newFile}`, `menu.onCommand`, `session.requestSignOut`, `openExternal`.

The page never sees `ipcRenderer`, `require` or `process`; this was checked in the views. As a temporary alias, `window.desktop.setTheme` is also exposed, because `ds/theme.ts` calls that name (§10).

**Legacy seams in the renderer.** `app/native.ts` `native()` builds the old `NativeApi` (sign-in, theme, links) on `window.designer`. `app/bridge.ts` `shellBridge()` is IPC in a desktop tab and the parent frame's `designerShell` in a browser. The pages still register `window.designerTab {save, isDirty, command}`, and `tab/host.ts` answers `tab:request` and `menu:command` from it.

**Preloads** are built as isolated bundles (electron-vite `isolatedEntries`, `externalizeDeps: false`), because a sandboxed preload can't load a shared chunk. electron-vite 5 draws a progress line with terminal cursor calls that throw when output is piped; `electron.vite.config.ts` stubs them when stdout isn't a TTY.

---

## 8. Menu and command routing

`src/shared/commands.ts` is the registry: id, label, accelerator, scope. `src/main/menu.ts` builds the menu bar from it.

- **DesignerV2**: About · Theme ▸ (Light, Dark, Use System Setting: radio items, checked from `nativeTheme.themeSource`) · Sign Out · Services · Hide… · Quit.
- **File**: New Project… ⌘N · Save ⌘S · Close Tab ⌘W · Close Window ⇧⌘W · Reopen Closed Tab ⇧⌘T.
- **Edit**: Undo ⌘Z · Redo ⇧⌘Z · Cut/Copy/Paste/Paste and Match Style (roles) · Delete · Select All ⌘A.
- **View**: Enter Full Screen (role) · Developer ▸ (Toggle Developer Tools ⌥⌘I for the focused view, Toggle Tab Bar Developer Tools, Reload Tab).
- **Window**: Minimize, Zoom · Show Next Tab ⌃Tab · Show Previous Tab ⌃⇧Tab · Home ⌘1, Tab 2–8 ⌘2–⌘8, Last Tab ⌘9 · Bring All to Front.

How commands are routed:

- Keys reach the focused page first. The menu sees only what the page leaves unhandled, so the editor's own ⌘S, ⌘Z and other shortcuts stay the editor's.
- A click, or an unhandled accelerator, runs `TabManager.command(id, source, focusedWebContents)`. Main handles the shell commands: tabs, theme, sign-out, devtools, close window.
- **Undo, Redo, Select All, Delete** go to the focused view.
  - In Home or the tab bar (DOM pages), main calls `webContents.undo()/redo()/selectAll()/delete()`. Verified on Home's search field: abc → ab → abc.
  - In a file tab, main sends `menu:command`. `tab/host.ts` then picks one of three paths:
    - A DOM text field has focus: `document.execCommand`.
    - The command came from a menu click: the page's own `designerTab.command(id)`, or else the key the command stands for, dispatched to the page, so the editor's own handler runs it against its model.
    - The command came from an accelerator: nothing more, because the page already saw that key.
  - Verified: Edit ▸ Undo removes the rectangle just drawn and clears the unsaved dot; Redo brings it back.
- **Save** goes to the tab in front as `menu:command`, and `host.ts` calls `designerTab.save()`. Verified: the unsaved dot clears.
- **New Project…** and **+** activate Home and open its dialog.

---

## 9. Persistence, protocol, security

- **`userData/session.json`**: `{version: 1, windows: [{id, bounds, maximized, fullScreen, tabs: [{id, kind, slug, title}], activeTabId, closed}]}`. Written 500 ms after a change, only when it differs from the last write, atomically (temp file, fsync, rename), and at once on close or quit. On first run it takes the window's place from the old `window.json`. The renderer's `designer-tabs` localStorage key is no longer read by the desktop app; the browser shell still uses it.
- **`userData/settings.json`**: `{theme}`. Read at launch into `nativeTheme.themeSource`, falling back to the old `window.json` theme.
- **`app://designer`** (`src/main/protocol.ts`):
  - Privileges: standard, secure, fetch, CORS, stream and `codeCache`.
  - Path-guarded and served from `out/renderer`.
  - `.wasm` is served as `application/wasm` and JS as `text/javascript`; every response gets `nosniff`.
  - HTML gets the CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src/media-src 'self' data: blob: https:; font-src 'self' data: blob:; connect-src 'self' data: blob: https: wss:; frame-src 'self' https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'`.
  - Verified: an inline script is blocked with a `script-src-elem` violation.
  - The `https:`/`wss:` sources stay for the legacy Firebase data layer and the site's pictures and embeds.
- **COOP/COEP: off by default.**
  - The legacy pages load cross-origin pictures, video and YouTube embeds that send no CORP header. `require-corp` would block them; `credentialless` would still block the embeds.
  - The v1 engine is single-threaded and needs no SharedArrayBuffer.
  - `DESIGNER_CROSS_ORIGIN_ISOLATED=1` turns on COOP `same-origin`, COEP `require-corp` and CORP `same-origin` for every response. Verified: `crossOriginIsolated === true` and `SharedArrayBuffer` is defined in every view.
  - Turn it on for good (contract §12.3) when Firebase leaves the renderers.
- **Permissions**: `clipboard-read`, `clipboard-sanitized-write`, `fullscreen` and `pointerLock` are allowed, for the app's own origin only. Everything else is denied, and `setDevicePermissionHandler` returns false.
- **Electron fuses**: not set yet. `enableNodeCliInspectArguments: false` would stop Playwright from driving a packaged build (`DESIGNER_EXECUTABLE`). Set them together with a packaging test.

---

## 10. Differences from `docs/desktop.md`, and why

| Contract | As built | Why / when |
|---|---|---|
| No dirty dot, no Save, flush handshake (`tab:flush`) | Built for `file` tabs. Legacy tabs keep dirty dots, Save, `tab:request {is-dirty \| save}` and Save/Don’t Save dialogs | The legacy editor and CV save explicitly to Firebase (coordinator's ruling); they go in the next round. |
| Separate `tabbar.html`, `home.html`, `editor.html` | One `index.html`, the role in the query | It keeps the existing build and the browser shell. Splitting is a build-config change (`vite.shared.ts` inputs) once the legacy pages go. |
| Tab kinds `file` / `prototype`, `fileKey` | `file` (with `fileKey`) built, next to the legacy `project` / `preview` / `cv` (`slug`); no `prototype` yet | The legacy kinds go with the legacy pages. |
| `nav:new-file` invoke → `{fileKey, tabId}` | Built; returns `null` when "+"/⌘N open the legacy Home's dialog | Until the new Home is the default. |
| Spare pre-warmed editor | Not built | Needs the engine's attach-later boot (`tab:attach`). |
| `crashed.html` view after a crash loop; auto-reload after more than 60 s | Native `Reload / Close Tab` dialog, no auto-reload | As briefed. The `restarting` flag is where auto-reload would go. |
| Discard policy (12 loaded tabs, 24 h idle) | Not built | Lazy restore is built; discarding is a timer plus `drop()`. |
| `tab:memory`, `tabs:overflow-menu`, fonts and clipboard channels | Not built (`menu:state`, the store port and the file channels are built) | They belong with the engine and fonts work. |
| Theme only through main (no localStorage) | Main owns the preference and broadcasts `theme:changed`. The legacy `ThemeContext` still keeps localStorage, and Home carries main's changes into it. | `ThemeContext` is replaced by `ds/theme.ts`. Once that reads `window.designer.setTheme` and `onThemeChanged`, drop the `window.desktop` alias and the Home bridge. |
| Sign-in removed | Kept: `AuthGate` in Home, `session:auth` gate | As briefed: it stays until the data layer replaces it. |
| Full-screen room 0 | 8 px | `design-system.md` §4.23 says 8. |

---

## 11. Driving it (`scripts/drive.mjs`)

`npm run build -- --mode demo`, then `node scripts/drive.mjs launch …`. Each run sets `DESIGNER_TEST=1`, which makes main expose `globalThis.__designer`: `current()`, `debug()`, `command(id)`, the `answers` queue and the `asked` log.

**Page commands** act on a target view. The default is the content view in front. `use tabbar|home|active|<tab id>` changes it; `@target` as the first word changes it for one command.

| Commands | What they do |
|---|---|
| `click`, `click-text`, `press`, `dblpress`, `drag`, `click-at`, `key`, `type`, `eval`, `text`, `wait`, `ss-view` | Act on the target view's page |
| `ss <name>` | The whole window: main captures the tab bar and the view in front and stacks them |
| `tabs` / `state` | Main's tabs, which one is in front, and each view's pid and webContents id |
| `menu <command id>` | Main's click path. Keys typed into a page never reach the menu bar. |
| `answer Save,Cancel` | Queues answers to the next native dialogs (logged, not shown) |
| `asked` | The dialogs asked so far and their answers |
| `drag-tab <from> <to>` | A real mouse drag in the tab bar |
| `main-eval <expr>` | Runs in main, with `electron` in scope |
| `pages`, `windows` | Playwright's pages; every webContents and its pid |
| `quit` | Answers "Quit Without Saving" and kills the app if it hasn't quit after 10 s |

`launch` passes `colorScheme: null` (Playwright otherwise forces light) and `chromiumSandbox: true`.

Playwright limits:

- After a renderer crash, Playwright can't drive that view again; `pageOf` says so. `ss` and `main-eval` still work.
- Chromium reports no hangs while a debugger is attached.
- Hidden views stay `visible` under CDP.

The dev server path works too: `ELECTRON_RENDERER_URL=http://localhost:5199 node scripts/drive.mjs …` with `npm run web:demo` running. `npm run dev:demo` was also started once and ran.
