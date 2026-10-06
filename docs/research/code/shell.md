# Subsystem map: Electron shell, process model, tabs, IPC, build

Repo: `/Users/burak/Desktop/Burak/Code/DesignerV2` (no commits yet; everything staged). Electron 44.5.1, electron-vite 5.0.0, React DOM 19.2.4, Firebase 12.19.0 (versions read from `node_modules`).

Everything below was read in full: `src/main/{index,menu,signIn,env.d}.ts`, `src/preload/index.ts`, `src/shared/{api,firebaseConfig}.ts`, `src/renderer/index.html`, `src/renderer/public/boot.js`, `src/renderer/src/main.tsx`, `src/renderer/src/app/*`, `src/renderer/src/tab/*`, all build configs, `scripts/*`, `docs/architecture.md`, `README.md`, `AGENTS.md`. I also read the parts of other files that touch the shell: `context/ThemeContext.tsx`, `lib/{auth,firebase}.ts`, `demo/{auth,db}.ts`, the start of `demo/{firestore,storage}.ts`, `figma/account.ts`, `cv/CVEditor.tsx:340-375`, `figma/FigmaEditor.tsx` (clipboard and key handling, lines 150-160 and 1875-1935), `styles/app.css:1-110`.

Two claims below were checked by running small Electron 44 tests in the scratchpad (`scratchpad/iframe-move/*.cjs`). Nothing was run against the repo itself.

---

## 1. How it works today

### Process and window model
- **One `BrowserWindow`**, kept in a module-level variable `win` (`src/main/index.ts:101`). It is created at `index.ts:109-201` with `titleBarStyle: "hiddenInset"` and `trafficLightPosition {14,13}` (`:121-123`), and `show:false` until `ready-to-show` (`:119,135`). `webPreferences` sets `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` and `spellcheck:true`, and passes the version through `additionalArguments` (`:125-132`).
- **The window's place is remembered** in `userData/window.json`: `{x,y,width,height,maximized,theme}` (`:63-97`). `onScreen()` checks that the saved place is still on a display (`:94-97`). The file is written on resize, move, maximize and unmaximize (`:137-146`).
- **Single instance.** `requestSingleInstanceLock` is used. `second-instance` only focuses the window or recreates it, and ignores argv (`:251-258`). There is no `open-file`, `open-url` or `setAsDefaultProtocolClient`.
- **The entire UI is one renderer page with two roles** (`src/renderer/src/main.tsx:13-24`). Without `?tab=`, `ShellApp` renders (the tab bar, Home, sign-in and dialogs). With `?tab=<id>&kind=project|preview|cv&slug=<slug>` (`app/bridge.ts:53-60`), `TabApp` renders the file instead. Both are lazy chunks.
- **Each open file is a same-origin `<iframe>` of the shell** (`app/Shell.tsx:256-268`, URL built by `frameUrl` at `:32-37`). Inactive tabs stay mounted and laid out, hidden with `invisible pointer-events-none` (`:266`). Home is a `div` in the shell document, hidden the same way (`:253-255`).
- **Same origin means same process and same thread.** I checked this in Electron 44: same-origin iframes report the same `osProcessId` as the top frame (`framesInSubtree`). The shell, Home and every open file therefore share one renderer process and one JS main thread.
- **Every tab is a full app boot.** Each tab document loads the shared `index` chunk (561 KB), `TabApp` (715 KB) and `NodeView` (2.1 MB, which also contains Firestore). Sizes are from `out/renderer/assets`. Each tab also creates its own Firebase app, Firestore client and Auth instance (`lib/firebase.ts:8-36` runs once per document).

### Tabs (`app/tabs.ts`, `app/Shell.tsx`, `app/TabBar.tsx`)
- **State** is `{tabs: Tab[], active: "home"|id, closed: {kind,slug,title}[] (max 20)}` (`tabs.ts:13-29`). It is changed by a pure reducer with the actions `open`, `activate`, `close`, `report`, `move`, `reopen` and `reset` (`tabs.ts:31-96`).
  - Opening dedupes by `kind+slug` (`:45`).
  - A new tab is inserted after the active one (`:48-50`).
  - Closing the active tab activates its right neighbour, then its left one, then Home (`:60-65`).
- **Persistence** uses renderer `localStorage` key `designer-tabs`, holding `{tabs:[{id,kind,slug,title}], active}` (`tabs.ts:100-121`). It is written on every state change (`Shell.tsx:54`). On restore, `closed` is always `[]` (`tabs.ts:109`) and every tab starts as `status:"loading"`. All restored iframes mount at once (`Shell.tsx:40,256`).
- **The tab bar** (`TabBar.tsx`):
  - Room for the traffic lights: 78px unless in full screen (`:15-24`, through `isFullScreen` and `onFullScreen` IPC).
  - The Home button, then the file tabs with a kind glyph, title, a dirty dot and ×.
  - Pointer drag reorders tabs (`:64-94`); middle click closes (`:124`); right click opens the shell's DOM context menu (`:125-128`, `Shell.tsx:221-239`).
  - `+` opens the New Project dialog (`:159`, `Shell.tsx:243-246`).
  - The bar's free area drags the window through `-webkit-app-region` (`styles/app.css:97-102`).
- **Focus**: activating a tab focuses the iframe and its `contentWindow` (`Shell.tsx:212-219`).

### The bridge (shell ↔ tab), `app/bridge.ts`
- The bridge is direct JavaScript calls across same-origin frames. There is no `postMessage` or IPC.
  - The shell publishes `window.designerShell` (`ShellBridge`: `report`, `openProject`, `openPreview`, `goHome`, `closeTab`, `signOut`) at `Shell.tsx:125-140`. A tab finds it through `window.parent.designerShell` (`bridge.ts:45-51`).
  - Each tab publishes `window.designerTab` (`TabBridge`: `save(): Promise<boolean>`, `isDirty(): boolean`, `command(cmd)`) at `EditorTab.tsx:37-46`, `PreviewTab.tsx:54-59` and `CVEditor.tsx:360-367`. The shell reaches it through `iframe.contentWindow.designerTab` (`Shell.tsx:56-62`).
- **Reports**: tabs push `{title, dirty, status, savedAt}` (`bridge.ts:10-16`; `EditorTab.tsx:21-31`). `savedAt` makes Home re-read its lists (`Shell.tsx:48,129`).
- **Unsaved-work flows** call `isDirty()` synchronously across documents (`Shell.tsx:85,98`):
  - Closing a tab: the shell asks Save / Don't save / Cancel (`Shell.tsx:80-94`).
  - Closing the window or signing out: the shell asks once for all dirty tabs (Save all, Close without saving, Cancel) in `Shell.tsx:97-111`.
  - The modals are drawn in the shell's DOM over the iframes (`ui.tsx:103-131`, `Shell.tsx:282-319`).
- **`TabBridge.command` is never called.** All three tabs implement it as `() => {}`, and `Shell.command` (`Shell.tsx:143-177`) only ever calls `save()` on a tab.

### The native API (preload) and IPC
- **Preload** (`src/preload/index.ts:13-34`) exposes `window.designer: NativeApi` (typed in `src/shared/api.ts:32-49`) through `contextBridge`. It adds a small `on(channel, fn) → unsubscribe` helper (`:5-11`). Because the preload is sandboxed, it reads the version from `--designer-version=` (`:16`).
- **Only the main frame has the preload.** Tabs reach it through `window.top.designer` (`app/native.ts:11-19`). `isDesktop` is computed from this (`native.ts:22`) and also changes Firebase Auth's popup resolver (`lib/firebase.ts:28`).
- **IPC channels**:

| Channel | Direction | Where | Purpose |
|---|---|---|---|
| `auth:google` (invoke) | R→M | `index.ts:205-221` | Browser sign-in; returns `SignInResult`; focuses the app afterwards |
| `auth:cancel` | R→M | `index.ts:222` | Close the loopback server |
| `shell:open-external` | R→M | `index.ts:224-226` | `http(s)`/`mailto` only |
| `theme:set` | R→M | `index.ts:228-233` | `nativeTheme.themeSource`, `window.json`, window background |
| `window:guard` | R→M | `index.ts:235-237` | Close guard on/off (sender-checked) |
| `window:close` | R→M | `index.ts:238-243` | Allowed to close; quits if ⌘Q is under way (sender-checked) |
| `window:close-cancel` | R→M | `index.ts:244-246` | Clears `quitting` (not sender-checked) |
| `window:is-fullscreen` (invoke) | R→M | `index.ts:247` | Traffic-light room |
| `window:close-requested` | M→R | `index.ts:152-156` | The page decides about unsaved tabs |
| `window:fullscreen` | M→R | `index.ts:148-149` | Full-screen changes |
| `menu:command` | M→R | `menu.ts:12` | Menu items → shell (`Shell.tsx:182`) |

- **The close protocol.** The shell turns the guard on (`Shell.tsx:192`). On `close`, main calls `preventDefault` and sends `close-requested` (`index.ts:152-156`). The shell runs `settleAll("close")`, then calls `closeWindow()` or `cancelClose()` (`Shell.tsx:193-195`). `before-quit` sets `quitting` (`index.ts:303-305`). A reload clears the guard (`:165-167`), and so does a renderer crash (`:168-170`).

### Menu (`src/main/menu.ts`)
- **App menu** (mac only): About, Toggle Dark Theme, Sign Out, Services, Hide, Quit (`:22-43`).
- **File**: New Project… ⌘N, Save ⌘S, Close Tab ⌘W, Reopen Closed Tab ⇧⌘T (`:44-55`).
- **Edit**: built-in roles only (`:56-69`).
- **View**: reload (dev only), DevTools, full screen (`:70-78`).
- **Window**: minimize, zoom, ⌃Tab / ⌃⇧Tab, ⌘1…⌘9 (`:79-91`).
- **Help**: "Open burakkoc.net" (`:92-95`).
- All custom items go to `win.webContents` as `menu:command` (`:12`). The page sees keys first: the editor's own ⌘S handler (`FigmaEditor.tsx:1906-1916`) calls `preventDefault`, so the menu never sees ⌘S while an editor has focus.

### Security, protocol, permissions
- **`app://designer`** is registered as standard, secure, fetch, CORS and stream (`index.ts:17-18,25`). It is served by `protocol.handle`, which maps to `out/renderer` with a path-traversal guard (`:264-273`). Only `.html` responses get the CSP header (`:269-272`).
- **CSP** (`index.ts:35-47`): `script-src 'self'`; `style-src 'unsafe-inline'`; `img/media/connect/frame` allow any `https:` (connect also allows `wss:`); `worker-src 'self' blob:`. The dev server page has no CSP, and security warnings are turned off in dev (`:21-22`).
- **Navigation**: `setWindowOpenHandler` denies every new window and opens `http(s)` URLs in the browser (`:172-175`). `will-navigate` keeps the main frame inside the app (`:176-180`).
- **Context menu**: editable fields and selected text get the system menu with spelling suggestions (`:182-190`).
- **Permissions**: only `fullscreen` is allowed, plus `clipboard-read` and `clipboard-sanitized-write` from the app's own origin (`:290-292`).
- **Firebase Storage CORS**: `Access-Control-Allow-Origin: *` is injected into GET responses from `firebasestorage.googleapis.com` (`:277-281`).

### Sign-in (`src/main/signIn.ts`)
- A one-off HTTP server listens on `127.0.0.1` on a random port (`:106-109`). The system browser opens `http://localhost:<port>/?state=<48 hex>` (`:108`).
- The page it serves (`:114-191`) loads Firebase JS from gstatic at `__FIREBASE_VERSION__` (`:115,157-158`, injected by `electron.vite.config.ts:6,10`). It runs `signInWithPopup` with in-memory persistence and POSTs the Google `idToken` to `/done`, which checks `state` in constant time (`:28-32,79-89`). The server times out after 10 minutes (`:19,65`).
- The renderer then calls `signInWithCredential` (`lib/auth.ts:29-35`). `ShellApp` gates the UI on `ADMIN_EMAILS` (`ShellApp.tsx:21-33`; `lib/auth.ts:11-13`).

### Theme
- `boot.js` sets `data-theme` before first paint from `localStorage["designer-theme"]` (`public/boot.js:1-10`; loaded by `index.html:8`).
- `ThemeProvider` keeps every same-origin document in sync through `storage` events plus a custom event (`context/ThemeContext.tsx:28-39`), and tells main through `setTheme` (`:68`).
- Main keeps its own copy of the theme in `window.json` (`index.ts:111,228-233`).

### Build, demo mode, checks, packaging
- **electron-vite** builds `main` and `preload` with `externalizeDepsPlugin` (`electron.vite.config.ts:9-13`). The renderer config is shared with the browser build (`vite.shared.ts:26-34`; `vite.web.config.ts:5-9`, root `src/renderer`, port 5199).
- **Demo mode** (`--mode demo`) swaps three modules by alias: `@/lib/firestore` → `demo/firestore.ts`, `@/lib/storage` → `demo/storage.ts`, `@/lib/auth` → `demo/auth.ts` (`vite.shared.ts:14-23`).
  - Only those three modules import `@/lib/firebase`, so the demo bundle has no Firebase SDK.
  - The demo modules declare `typeof Real.fn` to stay in step with the real ones (e.g. `demo/auth.ts:44-53`) and keep data in IndexedDB `designer-demo` (`demo/db.ts:6-37`).
  - `__DEMO__` is defined (`vite.shared.ts:31`, declared in `vite-env.d.ts:4`) but nothing reads it.
- **TypeScript and lint**: two projects, node (main, preload, shared, configs) and web (renderer + shared), with `paths` `@/*` and `@shared/*` (`tsconfig.node.json`, `tsconfig.web.json`). ESLint flat config (`eslint.config.mjs`). Vitest runs in a node environment on `src/**/*.test.ts` (`vitest.config.ts`); there are no tests for `tabs.ts`.
- **Packaging** (`electron-builder.yml`): `out/**` + `package.json`, asar, a macOS arm64 DMG only. The app is not signed or notarized (README `:30`). There are no `fileAssociations`, no `protocols`, no auto-update and no entitlements. The icon is drawn by `scripts/make-icon.cjs` in an offscreen BrowserWindow.
- **`scripts/drive.mjs`** drives the built app with Playwright `_electron`:
  - Launches with its own `DESIGNER_USER_DATA` (`:20,45`, honoured at `index.ts:28`).
  - Finds the active tab as `iframe:not(.invisible)` (`:32-35`).
  - Sends menu commands by calling `webContents.send` on window 0 (`:175-179`).
  - Lists all webContents (`:186-191`).

---

## 2. Problems (file:line)

1. **Reordering tabs reloads iframes and discards unsaved edits without asking.**
   - Mechanism: `TabBar` drag → `move` (`TabBar.tsx:90`, `tabs.ts:79-87`) → `Shell` re-renders keyed iframes in the new order (`Shell.tsx:256-268`). React DOM 19.2.4 moves keyed nodes with `insertBefore`; `moveBefore` does not appear in `react-dom-client.*.js`.
   - Moving an iframe in the DOM destroys its document. I confirmed this in Electron 44: after `insertBefore`, the moved iframe's `window` state was gone, while the unmoved one kept its state.
   - With React's keyed algorithm, dragging tab C to the front of [A,B,C] re-inserts A and B. Any dirty editor among them loses its in-memory work, and `isDirty` is never consulted.
   - Fix options: render the iframes in a stable order (for example by creation id) and keep only the tab bar's order in state, or move to WebContentsViews.
2. **One thread for everything.** The shell, Home and all tabs share one renderer process and one main thread (verified by `osProcessId`; structure at `Shell.tsx:256-268`).
   - A heavy tab (export, a big canvas) freezes the tab bar, Home and every other tab.
   - A renderer crash takes all files down. Main only resets the close guard (`index.ts:168-170`); there is no reload or recovery.
3. **Restore boots every tab at once** (`tabs.ts:102-113`, `Shell.tsx:256`). Each tab parses about 3.4 MB of JS and creates its own Firebase, Firestore and Auth clients (`lib/firebase.ts:8-36`). There is no lazy loading or discarding of background tabs, and hidden tabs stay fully alive (`Shell.tsx:265-266`).
4. **Closing the window depends on the renderer cooperating, with no timeout** (`index.ts:152-156,238-243`). If the shared thread hangs without crashing, the window cannot be closed except by force quitting. `window:close-cancel` does not check its sender (`index.ts:244-246`).
5. **The Edit menu uses roles** (`menu.ts:56-69`).
   - Choosing Undo, Redo, Delete or Select All with the mouse runs Chromium's text-editing commands in the focused frame, not the editor's model actions. The editor's undo exists only as a ⌘Z `keydown` handler (`FigmaEditor.tsx:1926-1928`).
   - Copy, Cut and Paste do work, because the roles fire DOM clipboard events that the editor listens for (`FigmaEditor.tsx:1879-1902`).
   - `TabBridge.command` is a dead path (`bridge.ts:34`, never called from `Shell.tsx:143-177`).
6. **Sub-frame navigation is not guarded.** `will-navigate` only covers the main frame (`index.ts:176-180`).
   - In a Preview tab, a site-relative link (an anchor without a target for relative hrefs at `NodeView.tsx:437-440` and `RichText.tsx:47-51`, or `window.location.assign` at `PageView.tsx:22`) navigates the tab iframe to `app://designer/projects/...`.
   - The protocol handler has no such file (`index.ts:264-268`), so the tab is replaced by an error page.
   - The fix is `will-frame-navigate`. I did not run this end to end, so treat it as plausible rather than confirmed.
7. **The CSP blocks WebAssembly.** `script-src 'self'` (`index.ts:37`) makes `WebAssembly.compile` throw; I confirmed this in Electron 44 with the same directive. The protocol handler sets no COOP/COEP headers (`index.ts:269-271`), so `crossOriginIsolated` is false and there is no `SharedArrayBuffer`, which Emscripten pthreads need.
   - In the same test, `'wasm-unsafe-eval'` plus `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on a `protocol.handle` response gave `compiled`, `crossOriginIsolated=true` and `SharedArrayBuffer` defined.
   - COEP `require-corp` would break today's `https:` images and frames (`index.ts:39,43`) unless they are served with CORP/CORS headers or COEP is set to `credentialless`.
   - Dev and prod differ: the dev page has no CSP (`index.ts:21-22`).
8. **No local font access.** The permission handler denies everything except clipboard and full screen (`index.ts:290-292`), so `queryLocalFonts()` (`local-fonts`) is refused.
9. **A single-window assumption runs throughout:** module-level `win` (`index.ts:101`), the menu bound to `() => win` (`:294`), IPC sender checks against `win.webContents` (`:236,239`), and `drive.mjs` uses `getAllWindows()[0]` (`:116,177`).
10. **The bridge only works same-origin and same-process.**
    - `native()` reaches `window.top.designer` (`native.ts:13-15`); `shellBridge()` reaches `window.parent` (`bridge.ts:47`).
    - `isDirty()` is a synchronous cross-document call (`Shell.tsx:85,98`).
    - The modals (`ui.tsx:103-131`) and the tab context menu (`Shell.tsx:221-239,321`) are drawn in the shell's DOM over the tab iframes.
    - None of this survives a process split.
11. **Tab state lives in the renderer and is fragile.**
    - It is kept in `localStorage` (`tabs.ts:100-121`), so main cannot see it.
    - Closed-tab history is not persisted (`tabs.ts:109`).
    - Unsaved work is lost on a crash because there is no autosave or recovery.
12. **There are two sources of truth for the theme:** `window.json` (`index.ts:111,231`) and `localStorage["designer-theme"]` (`boot.js:4`, `ThemeContext.tsx:14`).
13. **Packaging gaps** (`electron-builder.yml:10-17`): arm64 DMG only, unsigned and not notarized (README `:30`), no file associations or URL scheme, and no `open-file` / `second-instance` argv handling (`index.ts:254-258`).
14. **Minor issues:**
    - `__DEMO__` is unused (`vite.shared.ts:31`).
    - `drive.mjs` depends on the Tailwind class `.invisible` (`:33`).
    - The sign-in opens `localhost` while the server listens on `127.0.0.1` (`signIn.ts:106-108`). This code goes away anyway.
    - There are no unit tests for the pure `tabsReducer`.

---

## 3. Site, Firebase and CV coupling (drop or replace for a Figma clone)

- **Main process**: all of `src/main/signIn.ts`; IPC `auth:google` and `auth:cancel` (`index.ts:205-222`); the Firebase Storage CORS hack (`index.ts:275-281`); the CSP's `connect-src https: wss:`, kept for Firebase (`index.ts:42`); About text `copyright: "burakkoc.net"` (`index.ts:261`); the `__FIREBASE_VERSION__` define (`electron.vite.config.ts:5-10`, `src/main/env.d.ts:2`).
- **Menu**: "Sign Out" (`menu.ts:31`), "New Project…" (`menu.ts:47`, which becomes "New design file"), Help "Open burakkoc.net" (`menu.ts:94`), and `MenuCommand` `new-project` and `sign-out` (`api.ts:10,19`).
- **Preload and shared**: `signInWithGoogle` and `cancelSignIn` (`preload/index.ts:17-22`); `GoogleCredential` and `SignInResult` (`api.ts:23-30`); all of `src/shared/firebaseConfig.ts`.
- **Shell renderer**:
  - The sign-in gate, the `SignIn` screen and `NotAdmin` (`ShellApp.tsx:21-110`); `ADMIN_EMAILS` (`lib/auth.ts:11-13`).
  - `signOut` and the `settleAll("sign-out")` path (`Shell.tsx:113-118`, `ShellBridge.signOut` at `bridge.ts:26`, `figma/account.ts:16-17`).
  - "Copy link to the site page" (`Shell.tsx:236`); the `savedAt` refresh of Home's Firestore lists (`Shell.tsx:48,129`; `bridge.ts:15`).
  - `NewProjectDialog` with title and slug (`Shell.tsx:271-280`).
  - The `firebase/auth` `User` type on the shell (`Shell.tsx:2,39`).
- **Tabs**:
  - `TabKind` values `"preview"` and `"cv"` (`tabs.ts:11`, filter at `:106`).
  - `PreviewTab` (the site's draft at site widths) and `siteTokens.ts`; `CVEditor` in a tab (`TabApp.tsx:11`); `ShellBridge.openPreview` (`bridge.ts:22`, `Shell.tsx:132`).
  - The CV glyph and preview icon (`TabBar.tsx:38-46,136`).
  - Tabs identified by `slug` (`tabs.ts:16-17,45`), which becomes a file key.
  - `EditorTab` loads the site-wide design system (`EditorTab.tsx:16-17,76-77`); in Figma, variables and styles belong to the file plus subscribed libraries.
- **Data and demo**: the `--mode demo` aliases swap Firestore, Storage and Auth (`vite.shared.ts:14-23`), and their API shape is the site's. `isDesktop` changes Firebase Auth (`lib/firebase.ts:28`).
- **Packaging and docs**: `appId: net.burakkoc.designer` (`electron-builder.yml:1`); `package.json` description and author; README, `docs/architecture.md` and AGENTS.md, which all describe the site admin.

---

## 4. Differences from Figma desktop (shell level)

- **Process model.** Figma's desktop app runs each open file in its own web contents and renderer process, separate from the tab bar and the file browser. Here, all files are same-thread iframes of one page.
- **Saving.** Figma has no file Save: work is saved continuously, and version-history entries are made explicitly. Here there is an explicit Save (⌘S), dirty dots on tabs, and "Unsaved changes" prompts on tab close, window close and sign out (`TabBar.tsx:139`, `Shell.tsx:282-319`).
- **New file.** Figma's `+` and ⌘N create an untitled file straight away. Here both open a title/slug dialog on Home (`Shell.tsx:148-151,243-246`).
- **Native menu bar.** Figma's menu bar mirrors its editor menu (File, Edit, View, Object, Text, Arrange, Vector, Plugins, Window, Help) and acts on the canvas. Here: File has 4 items, Edit is roles only (which don't act on layers), View is DevTools and full screen, and Help is a website link (`menu.ts:44-95`). Menu enablement is never driven by editor state.
- **Missing desktop flows**: no import of local files (open / drag a `.fig` onto the app or Dock), no export or "save local copy", no recent files in the Dock menu, no deep links into a file, no more than one window, and no dragging a tab out to a new window (`index.ts:101,254-258`).
- **Home** lives inside the shell document (`Shell.tsx:253-255`), not as its own tab view.
- **Local fonts** are unavailable (`index.ts:290-292`).
- **Tab kinds** are site concepts (preview, CV); Figma's are Design, FigJam, Slides and prototype.
- **Clipboard.** Layers go onto the system clipboard as plain text with a `figma-layers:` prefix (`FigmaEditor.tsx:156,625-633`), which pollutes text paste. Figma uses an HTML clipboard payload, so layers paste between files and into Figma itself.

---

## 5. What a Figma-desktop process model would need

**Window and views**
- Main owns a `TabManager` per window. Each file tab becomes a `WebContentsView` added to `win.contentView`, sized below the 40px bar, shown and hidden with `setVisible`, and focused with `webContents.focus()`.
- The tab bar is its own small view, or stays in the window's base webContents. Home is its own view.
- Views are created lazily: only the active tab loads at launch, and background tabs can be discarded.
- Each view handles `render-process-gone` with a "tab crashed, reload" state.

**Tab state in main**
- Move `tabs.ts`'s reducer (it is pure, so it moves as is) into main, or into a shared module used by both.
- Persist to `userData/tabs.json`, like `window.json` (`index.ts:72-91`), including closed-tab history.
- Broadcast the state to the tab-bar view.

**IPC instead of `bridge.ts`**
- `tab:report` (title, status, and later "unsynced") goes from view to main to tab bar.
- `shell:*` requests (open file, go home, close tab) go from view to main.
- The tab's `save` and `isDirty` become main-held state: main caches `dirty` from reports instead of calling a synchronous `isDirty()`, or sends a request and waits for the reply.
- Use `MessageChannelMain` ports between a view and the document store for binary scene-graph traffic.

**Preload**
- Every view gets the preload, with its own role-specific API. Main checks `event.senderFrame` and the view id on every handler. `native()`'s fallback to `window.top` goes away.

**Dialogs and menus**
- Anything that must cover a file view becomes either native (`dialog.showMessageBox`, `Menu.popup` for the tab context menu) or a temporary overlay view. Today's shell-DOM modals (`ui.tsx:103`) and the tab context menu cannot draw over views.

**Menu routing**
- `menu:command` goes to the focused window's active view, not `win.webContents`.
- Replace the Edit roles with commands the editor handles (undo, redo, select all, delete, zoom…), keeping roles only where a DOM text field has focus.
- Views report menu state (`canUndo`, `hasSelection`) so main can enable and disable items.

**Local files and the document store**
- Main or a `utilityProcess` owns the store (files with pages; per-file variables, styles and components; published libraries).
- Files open from `open-file`, argv (`second-instance`) and drag onto the Dock; `.fig`-like import and export go through `dialog.showOpenDialog` / `showSaveDialog`.
- Autosave with crash recovery replaces Save.
- `electron-builder` gets `fileAssociations` (and optionally `protocols`).
- The demo alias technique (`vite.shared.ts:14-23`) becomes the seam between a local store and a later Firestore/LWW store.

**Clipboard**
- Add IPC to main's `clipboard` for a private binary format (`clipboard.writeBuffer` / `readBuffer` with a custom type), HTML and image (`readImage` / `writeImage`) together. Keep the DOM copy, cut and paste events as triggers (they already work through the roles).

**WASM and WebGL**
- The CSP gets `'wasm-unsafe-eval'`.
- `protocol.handle` adds COOP `same-origin` and COEP `require-corp` (or `credentialless`) to HTML responses, so `SharedArrayBuffer` works for Emscripten threads.
- Consider Electron's custom-scheme `codeCache` privilege for the large JS/WASM bundles.
- Serve `.wasm` as `application/wasm` for streaming compilation.
- Allow `local-fonts`, or better, enumerate and read system fonts in main and hand the bytes to the WASM text engine.
- On-canvas text editing needs its own IME, spellcheck and context-menu bridge; today's handler (`index.ts:182-190`) covers only DOM editable fields.

**Multiple windows**
- A per-window registry replaces the single `win`. Tab drag-out creates a new window and re-parents the view.

**Tooling**
- `drive.mjs` must address views rather than `iframe:not(.invisible)`. Its `windows` command already lists all webContents (`drive.mjs:186-191`).

---

## 6. Worth keeping

- **Window setup**:
  - `hiddenInset`, the traffic-light position matched to the 40px bar, `show:false` until `ready-to-show`, the background colour from `nativeTheme` (`index.ts:109-135,50`).
  - Window-state persistence with the on-screen check (`index.ts:63-97,137-146`).
  - Single-instance lock and `activate` handling (`index.ts:251-300`).
- **Security baseline**:
  - `sandbox`, `contextIsolation` and `!nodeIntegration` (`index.ts:127-129`).
  - The `app://` privileged scheme and the path-guarded `protocol.handle` that injects headers (`index.ts:25,264-273`); it is the natural place to add the WASM CSP and COOP/COEP.
  - The deny-all window-open handler with external links in the browser, and `will-navigate` (`index.ts:172-180`).
  - The permission handlers (`index.ts:290-292`), extended.
  - The editable-field context menu with spelling suggestions (`index.ts:182-190`).
  - Dev console forwarding (`index.ts:193-197`).
  - The `DESIGNER_USER_DATA` override for test runs (`index.ts:28`).
- **Close-with-unsaved-work handshake** (`index.ts:102-107,152-161,235-246`). Under autosave, the same handshake becomes "flush pending writes before quit".
- **Typed IPC contract pattern**: `NativeApi` and `MenuCommand` in `src/shared/api.ts`, the preload's `on()` helper that returns an unsubscribe, and the version passed through `additionalArguments` for a sandboxed preload.
- **`tabsReducer`** (`tabs.ts:42-96`): pure. It covers browser-like insertion, close-neighbour selection, reorder and reopen, and can move to main as is.
- **`TabBar.tsx`**: the Figma desktop tab bar look and behaviour (traffic-light room, drag reorder, middle click, dirty dot, `app-drag`).
- **`ui.tsx`** primitives in the UI3 look, `icons.tsx`, `boot.js` (no theme flash) and `ThemeContext` (cross-document sync).
- **Build**: electron-vite with one renderer config shared by Electron and the browser (`vite.shared.ts`, `vite.web.config.ts`); the alias-swap technique for backends; the two-project tsconfig; the ESLint flat config; the vitest setup; `make-icon.cjs`; and `drive.mjs` (Playwright `_electron` harness with a REPL, screenshots and menu-command injection).
