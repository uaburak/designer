# Desktop shell

Status: **contract**, 2026-10-06. It replaces what `docs/architecture.md` and `AGENTS.md` say about the window, the tabs, `bridge.ts`, the same-origin iframes and the sign-in. Those two files describe the old site admin and will be rewritten to match this document.

Companion contract: `docs/data.md` covers the workspace, the file format, the single writer (the store), libraries, Firebase and preview sharing. Where this document says "store port" or "`FileRepository`", the definition is in `docs/data.md`.

Scope: the Electron main process, the views and their processes, the tabs, the menu bar, IPC, the `app://` protocol, security, clipboard, fonts and crash recovery. Out of scope: the C++ engine, the document schema, the React panels and Home's UI. Those contracts are written separately. This document only states what they must provide to the shell; each such requirement is marked **Needs from engine** or **Needs from UI**.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Window | One `BaseWindow` per window. v1 opens one window; every structure is keyed by `windowId`, so a later "Move to New Window" needs no redesign. `titleBarStyle: "hiddenInset"`, traffic lights at `{x: 14, y: 12}`. |
| Views | Each view is a `WebContentsView` with its own renderer process: **tabbar** (38 px, always loaded), **home** (always loaded, tab 0), **one view per open file** (its own Wasm instance), and **one spare editor** that is pre-warmed and adopted by the next file that opens. |
| Tab state | Lives in main (`TabManager`), using a pure reducer in `src/shared/tabs.ts`. Persisted in `userData/session.json`. Restored lazily: only the active tab loads. |
| Hidden tabs | `view.setVisible(false)` plus an explicit `tab:visibility` event. The process, Wasm heap, undo stack and React state survive. Reordering tabs never reloads a view. |
| Saving | Changes save continuously to the store, as in Figma. There is no Save command, no dirty dot and no "Save changes?" dialog. Closing a tab or quitting runs a **flush handshake** with a 3 s timeout. Native dialogs appear only when a flush fails or a tab hangs. |
| Modals | A view draws DOM UI only over itself. Anything at shell level is native: tab context menu, overflow menu, file pickers, failure and hang dialogs. |
| Menu | A native menu bar that mirrors Figma's editor menus, built from one registry, `src/shared/commands.ts`. Clicks and unhandled accelerators are routed to the active view. Views report enabled and checked state. Copy, Cut and Paste stay as roles so DOM clipboard events fire. |
| Data writes | Only the **store** `utilityProcess` writes. Views talk to it over a direct `MessagePort`, not through main. Main only reads blobs, thumbnails and fonts to serve them over `app://`. |
| Fonts | A **fonts** `utilityProcess` scans and parses system and user fonts. Bytes are served at `app://designer/_font/<id>` and need a per-launch token. Chromium's `local-fonts` permission stays denied. |
| Clipboard | Written in the view's DOM `copy` event, in one atomic DataTransfer: our own type `application/x-designerv2-kiwi`, a Figma-compatible `text/html` envelope carrying the same kiwi archive, and `text/plain`. Copy as PNG uses the async Clipboard API. Nothing is written over IPC (§13 explains why). |
| Security | Sandbox, context isolation, no Node in renderers. CSP is `script-src 'self' 'wasm-unsafe-eval'` with no network origins. **Cross-origin isolated** (COOP `same-origin`, COEP `require-corp`). Every IPC handler validates the sender and its role. |
| Threads | The v1 engine is single-threaded Wasm, like Figma's. Cross-origin isolation is turned on anyway: it costs nothing here and enables `SharedArrayBuffer` for a later threaded build and `measureUserAgentSpecificMemory()` for the memory meter. |
| Old sign-in | Removed from the app. Its loopback-browser design comes back only inside the opt-in Firebase sync (`docs/data.md` §12), driven from main and the store. Renderers never load Firebase. |

---

## 1. Processes

```
main (Electron main, Node)
 ├─ WindowController (v1: one)
 │    ├─ BaseWindow (hiddenInset, traffic lights)
 │    ├─ tabbar   WebContentsView  ── renderer process (React tab bar)
 │    ├─ home     WebContentsView  ── renderer process (React file browser)
 │    ├─ file tab WebContentsView × k ── renderer process each (React panels + Wasm engine + 1 WebGL2 canvas)
 │    └─ spare    WebContentsView  ── renderer process (Wasm compiled + instantiated, no file yet)
 ├─ TabManager, Menu, dialogs, settings.json, session.json
 ├─ app:// protocol handler (static files, /_blob, /_thumb, /_font)
 ├─ StoreHost ── utilityProcess "DesignerV2 Store" (single writer; docs/data.md)
 └─ FontsHost ── utilityProcess "DesignerV2 Fonts" (font index; started lazily)
Chromium GPU process (shared by every view)
```

Connections:
- **main ↔ view**: Electron IPC (`ipcMain` / `ipcRenderer` through the role's preload).
- **view ↔ store**: one `MessagePort` per view, brokered by main with `MessageChannelMain`. Document bytes never pass through main.
- **main ↔ store**: one `MessagePort`. Main uses it for workspace events (renames, trash), import and export, flush-all and shutdown.
- **main ↔ fonts**: `utilityProcess` `postMessage`.

Crash domains: a file tab takes down only itself, and the same is true of home and the tab bar. The store and fonts processes are restarted by main (§9).

### Source layout (new or moved files)

```
src/main/index.ts        app lifecycle, single-instance lock, open-file / open-url, protocol registration
src/main/window.ts       WindowController: BaseWindow, view layout, full screen, show-on-ready
src/main/tabs.ts         TabManager: tab records + runtime, discard policy, spare view, persistence
src/main/views.ts        ViewFactory: webPreferences per role, URLs, crash/unresponsive wiring
src/main/menu.ts         application menu built from src/shared/commands.ts; routing; state application
src/main/ipc.ts          every ipcMain handler; sender/role validation
src/main/protocol.ts     app:// handler, headers, token check
src/main/dialogs.ts      native message boxes and file pickers
src/main/clipboard.ts    paste trigger, Finder file reading
src/main/settings.ts     userData/settings.json
src/main/session.ts      userData/session.json
src/main/storeHost.ts    spawns/restarts the store utility process, brokers ports
src/main/fontsHost.ts    spawns the fonts utility process, resolves font ids to paths
src/shared/ipc.ts        channel names and payload types (§10), the single source of truth
src/shared/desktop.ts    the window.designer API per role (§10.3)
src/shared/commands.ts   CommandId registry: label, accelerator, scope, menu placement (§8)
src/shared/tabs.ts       pure tabs reducer (moved from src/renderer/src/app/tabs.ts, extended)
src/preload/common.ts    on() helper, store-port forwarding, init
src/preload/tabbar.ts    window.designer: TabBarApi
src/preload/home.ts      window.designer: HomeApi
src/preload/editor.ts    window.designer: EditorApi
src/preload/crashed.ts   window.designer: CrashedApi
src/renderer/tabbar.html, home.html, editor.html, crashed.html   (Vite multi-page inputs)
src/renderer/src/tabbar/, src/renderer/src/home/, src/renderer/src/editor/   (React roots)
src/store/…              the store utility process (docs/data.md §7)
src/fonts/index.ts       the fonts utility process (§14)
```

`electron.vite.config.ts` gets three main-side entries (`index`, `store`, `fonts`), four preload entries and four renderer HTML inputs.

---

## 2. The window

The window is a `BaseWindow`, not a `BrowserWindow`. With BrowserWindow, the window's own webContents would be a renderer sitting under every view: it could not draw over them and would add one process for nothing. Every view is a peer in `win.contentView`.

```ts
new BaseWindow({
  width, height, x, y,                 // from session.json, checked by onScreen() (kept from today's index.ts)
  minWidth: 800, minHeight: 520,
  show: false,
  title: "DesignerV2",
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 14, y: 12 },
  backgroundColor: theme === "dark" ? "#2c2c2c" : "#ffffff",
});
```

Constants (`src/shared/layout.ts`):

| Name | Value | Note |
|---|---|---|
| `TABBAR_HEIGHT` | 38 | Includes the 1 px bottom line, which the tab bar page draws itself (measured in `docs/research/visual-diff.md`) |
| `TRAFFIC_LIGHT_ROOM` | 80 | Left inset of the Home tab; 0 in full screen |
| `HOME_TAB_WIDTH` | 40 | |
| default size | 1440 × 900 | |

**Layout** (`WindowController.layout()`). It runs on `resize`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen` and `screen` `display-metrics-changed`:
- `tabbar.setBounds({x: 0, y: 0, width: W, height: 38})`
- Every *loaded* content view (home, file tabs, spare): `setBounds({x: 0, y: 38, width: W, height: H - 38})`. Hidden views are resized too, so switching tabs never causes a resize followed by a re-render flash.
- `W` and `H` come from `win.getContentBounds()`. On macOS `resize` fires continuously during a live resize, and `setBounds` is called synchronously in that handler.

**Showing**: the window is shown when the tab bar sends `shell:ready` (after its first paint) *and* the active content view has fired `did-finish-load`, or after 1500 ms, whichever comes first.

**Full screen**: the tab bar stays and the traffic lights disappear. Main sends `window:state {fullScreen}` and the tab bar drops its 80 px left inset. `View > Enter Full Screen` is the `togglefullscreen` role (⌃⌘F).

**Window state** (bounds, maximized, full screen) is part of `session.json` (§4.4). `window.json` and its `theme` field go away: the theme lives in `settings.json` (§10.2).

**macOS lifecycle**: closing the window does not quit (`window-all-closed` does nothing on darwin). `activate` with no window recreates it from `session.json`. ⌘Q quits through the flush handshake (§6).

---

## 3. Views

| Role | URL | Preload | Created | Discarded | Surface (`design-system.md` `surfaceBackground`) |
|---|---|---|---|---|---|
| `tabbar` | `app://designer/tabbar.html` | `tabbar.js` | at launch | never (recreated after a crash) | `tabbar` (`#3b3b3b` dark / `#e6e6e6` light) |
| `home` | `app://designer/home.html` | `home.js` | at launch | never | `app` |
| `editor` | `app://designer/editor.html?tab=<tabId>` (spare: no `tab`) | `editor.js` | on tab activation, or adopted from the spare | §4.5 | `app` |
| `crashed` | `app://designer/crashed.html?tab=<tabId>&reason=<reason>` | `crashed.js` | after a crash loop (§9) | when the tab closes or reloads | `app` |

Main calls `view.setBackgroundColor(surfaceBackground(surface, resolvedTheme))` when it creates a view and on every theme change, so no view flashes the wrong colour before it paints.

`webPreferences` for every role:

```ts
{
  sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  spellcheck: role === "home" || role === "editor",
  backgroundThrottling: true,
  v8CacheOptions: "bypassHeatCheck",          // cache compiled JS on first run (large bundles)
  preload: join(__dirname, `../preload/${role}.js`),
  additionalArguments: [`--designer-role=${role}`, `--designer-version=${app.getVersion()}`, `--designer-theme=${preference}:${resolved}`],
}
```

The preload turns `--designer-theme` into the synchronous snapshot `window.designer.theme = {preference, resolved}`, which `boot.js` reads before first paint (`design-system.md` §2.3).

`editor` uses the same page for design files and prototype tabs. It learns which one it is from `tab:attach` (§10.1).

### 3.1 The spare editor (Figma's "preloaded tab")

- **Creation**: 3 s after Home's `shell:ready`, main creates a spare `editor` view without a `tab` parameter. It is not added to any tab and stays hidden at full content bounds. It loads the page, compiles and instantiates the Wasm engine, then waits.
- **Adoption**: when a file opens and a spare exists, main assigns the spare's view to the new tab and sends `tab:attach` (§10.1). A file therefore opens with no JS parse and no Wasm compile.
- **Replacement**: a new spare is created 3 s after each adoption. There is at most one spare per window. Setting `DESIGNER_DISABLE_SPARE=1` turns this off, for tests.
- **What is pre-warmed**: the page's JS, React and the Wasm module, which is compiled and instantiated through `createEngineModule()`. `engine_create` takes the `sessionID` (`engine.md` §10), so it is deferred until `tab:attach`. It is cheap: shader programs compile in parallel at create.
- **On attach**, the page runs this sequence:
  1. `store.files.open(fileKey, {mode: "edit"})`.
  2. `engine_create("#engine-canvas", {sessionID, mode: EDITOR, …})`.
  3. `engine_load(snapshot)`.
  4. `engine_apply_changes(frame, APPLY_LOAD)` for each journal frame, in order.

---

## 4. TabManager

### 4.1 Types (`src/shared/tabs.ts`)

```ts
export type TabId = string;                  // "home" or a 10-char base62 id
export type TabKind = "home" | "file" | "prototype";
export type TabStatus = "discarded" | "loading" | "ready" | "crashed" | "unresponsive" | "error";

export interface TabRecord {                 // persisted
  id: TabId;
  kind: TabKind;
  fileKey?: string;                          // file and prototype tabs
  pageId?: string;                           // GUID "s:l", prototype: the flow's page
  startNodeId?: string;                      // prototype: the flow's starting frame
  title: string;                             // last known; the view's report wins
  lastActiveAt: number;
}

export interface TabInfo extends TabRecord { // what the tab bar and Home see
  status: TabStatus;
  unsynced: boolean;                         // only with Firebase sync on (docs/data.md §12)
}

export interface ClosedTab { kind: "file" | "prototype"; fileKey: string; pageId?: string; startNodeId?: string; title: string; index: number; closedAt: number; }

export interface TabsSnapshot { windowId: string; tabs: TabInfo[]; activeTabId: TabId; canReopen: boolean; fullScreen: boolean; }

export type TabsAction =
  | { type: "open"; tab: Omit<TabRecord, "lastActiveAt">; position: "end" | { after: TabId } }
  | { type: "activate"; id: TabId; at: number }
  | { type: "close"; id: TabId; at: number }
  | { type: "move"; id: TabId; toIndex: number }
  | { type: "reopen"; at: number }
  | { type: "retitle"; id: TabId; title: string }
  | { type: "drop-file"; fileKey: string };  // trashed / deleted: close its tabs, purge it from `closed`
```

The reducer keeps today's tested behaviour (`src/renderer/src/app/tabs.ts`) and adds these rules:
- `tabs[0]` is always `{id: "home", kind: "home"}`. It cannot be closed, and `move` clamps `toIndex` to at least 1.
- **Dedupe**: `open` of a `file` whose `fileKey` already has a tab activates that tab instead. A `prototype` tab is deduped by `(fileKey, startNodeId)`.
- **Insert position**: a tab opened from Home, the tab bar, the menu or the Dock goes at the **end**. A tab opened from inside a file (Present, "Go to main component" in a library file) goes right **after the opener**.
- **Closing the active tab** activates its right neighbour, then its left neighbour (Home at worst).
- **Closed history** holds at most 20 entries and is persisted. `reopen` pops entries until it finds one whose file still exists and is not in the trash (main asks the store before dispatching).
- Unit tests live in `src/shared/tabs.test.ts`; they are missing today.

### 4.2 Runtime state (main only)

```ts
interface TabRuntime {
  view: WebContentsView | null;     // null = discarded
  status: TabStatus;
  loadedAt: number | null;
  crashes: number[];                // timestamps, last 10 min
  menuState: MenuState;             // §8.4
  unsynced: boolean;
}
```

### 4.3 Operations

| Operation | Trigger | Effect |
|---|---|---|
| activate | click, ⌘1–⌘9, ⌃Tab, ⌃⇧Tab, open of an already-open file | §5 "Activation" |
| open file | Home, `+`, ⌘N, Dock/Finder `.fig`, deep link, `nav:open-file` | reducer `open`, then activate (creates or adopts a view) |
| close | ×, middle click, ⌘W, the tab's context menu, `tabs:close` from the view itself | flush handshake (§6), then destroy the view; reducer `close` |
| move | drag in the tab bar | reducer `move` only; **no view is touched**; tab bar re-renders |
| reopen | ⇧⌘T, File menu, the tab's context menu | reducer `reopen`, then activate |
| retitle | `tab:report {title}`, store event `file.renamed` | reducer `retitle` |
| drop-file | store events `file.trashed`, `file.deleted` | flush, then close every tab of that file without asking; purge it from `closed` |

Keyboard (all shell-scoped, §8):
- ⌘1 is Home, ⌘2–⌘8 are `tabs[1..7]`, ⌘9 is the last tab.
- ⌃Tab and ⌃⇧Tab cycle through all tabs, Home included.
- ⌘W closes the active file tab; on Home it does nothing.
- ⇧⌘T reopens the last closed tab.
- ⌘N creates a new design file and opens it.

### 4.4 Persistence (`userData/session.json`)

```ts
interface SessionFile {
  version: 1;
  windows: Array<{
    id: string;
    bounds: { x: number; y: number; width: number; height: number };
    maximized: boolean;
    fullScreen: boolean;
    tabs: TabRecord[];
    activeTabId: TabId;
    closed: ClosedTab[];
  }>;
}
```

- Written debounced (500 ms) after every reducer change and every move or resize, and synchronously on quit.
- Writes are atomic: write to `session.json.tmp`, fsync, then rename.
- **Restore**:
  1. Read the file.
  2. Ask the store which `fileKey`s still exist and are not in the trash, and drop the rest.
  3. Create the records with `status: "discarded"`.
  4. Load only the active tab. If the active tab was dropped, activate Home.
- On a corrupt or missing file, start with Home only.

### 4.5 Lazy loading and discarding

- A discarded tab is shown in the tab bar like any other (Figma does the same). Activating it creates or adopts a view and loads it.
- `MAX_LOADED_FILE_TABS = 12`. When a 13th loads, the least recently active non-active file tab is discarded.
- Main checks every 30 min and discards any non-active file tab that has been inactive for more than 24 h.
- Discarding means: flush handshake (`reason: "discard"`), then `view.webContents.close()`, then `status: "discarded"`. The undo history goes, as in Figma after a reload. The viewport, page and selection are persisted per file (`ui.json`, `docs/data.md` §5) and come back.

---

## 5. Activation and hidden tabs

**Activation** (`TabManager.activate(id)`):
1. If the target has no view, create one or adopt the spare, add it to `win.contentView`, set its bounds, then `tab:attach`.
2. Call `target.view.setVisible(true)`, then `previous.view.setVisible(false)`.
3. Send `tab:visibility {visible: true}` to the target and `{visible: false}` to the previous tab. The page must not rely on `document.visibilityState` alone.
4. Call `target.view.webContents.focus()`.
5. Apply the target's menu state (§8.4), push `tabs:state` to the tab bar and Home, and persist (debounced).
6. For a file tab, call the store's `workspace.recordViewed(fileKey)`, which feeds Recents.

**What a hidden editor keeps**: its process, Wasm memory, undo stack, selection, viewport, panel state (React) and its WebGL context. The tab is only hidden, never reloaded.

**What a hidden editor does** (**Needs from engine/UI**), on `tab:visibility {visible: false}`:
- Stop requesting animation frames.
- Commit any in-progress gesture as a batch and send unsent batches to the store. No fsync is needed here.
- If anything was edited since the last thumbnail, render the file thumbnail (`docs/data.md` §5.7).
- Start a 5-minute timer. If the tab is still hidden when it fires, call `engine_trim_gpu_caches()` to drop tile caches and keep the context. **Needs from engine**: this export is not yet in `engine.md` §10.

On `{visible: true}`, request a frame. If `webglcontextlost` happened while hidden, rebuild from the scene graph.

**Memory meter**: every 10 s, main sends the active editor `tab:memory {workingSetMB}` from `app.getAppMetrics()`, matched by `webContents.getOSProcessId()`. The page combines it with `performance.measureUserAgentSpecificMemory()`, which is available because the views are cross-origin isolated, and with the Wasm heap size for Figma's memory indicator.

---

## 6. Closing, quitting, flushing

Figma saves continuously, so there is nothing to ask the user. The only question is whether the last edits reached the store. The page has already sent every committed batch (`docs/data.md` §5.4), so what remains is in-flight batches and the fsync.

**Flush handshake** (`TabManager.flush(tab, reason)`):
1. Main sends `tab:flush {reqId, reason}` with `reason: "close" | "quit" | "discard" | "reload"`.
2. The page commits any in-progress gesture, sends its pending batches and awaits `files.flush(fileKey)`, which fsyncs (`docs/data.md` §7). It then replies `tab:flushed {reqId, ok: true}`, or `{ok: false, error}` if the store reported a failure.
3. The timeout is `FLUSH_TIMEOUT_MS = 3000`.
4. Views that are crashed or discarded resolve immediately with `ok: true`: nothing in them is unsent that could still be sent.

Decision (2026-10-06): `reason` also takes `"hide"`, sent without waiting when a file tab is hidden (another tab comes in front, Save local copy) and when the Mac sleeps or locks.

**Close tab**: flush. On `ok`, destroy the view and record the tab as closed. Otherwise show a native dialog:

| Case | `dialog.showMessageBox(win, …)` |
|---|---|
| store failure | message: `Your recent changes to “‹name›” couldn’t be saved.`; detail: the store's error text; buttons: `Try Again`, `Close Anyway`, `Cancel` (default 0, cancel 2) |
| timeout | message: `“‹name›” isn’t responding.`; detail: `Changes from the last few seconds may not be saved.`; buttons: `Wait`, `Close Tab` (default 0) |

**Close window**: flush every loaded tab of the window in parallel, then close it. The tabs stay in `session.json` and come back with the window.

**Quit** (⌘Q, Dock "Quit", `before-quit`):
1. On the first `before-quit`, call `preventDefault()` and set `quitting = true`.
2. Flush every loaded tab in every window in parallel.
3. Send `store.shutdown()` over main's store port: fsync and close every file, with a 3 s timeout.
4. Write `session.json` synchronously, then call `app.quit()` again.

Failures use the same dialogs, with `Quit Anyway` in place of `Close Anyway`.

**System events**:
- `powerMonitor` `suspend` and `lock-screen`: flush all with no dialog.
- `shutdown`: `preventDefault()`, flush all, store shutdown, then `app.quit()`.

There is no `window:guard`, `window:close-requested` or `isDirty()` any more. Main never waits on a renderer without a timeout.

---

## 7. Native versus in-view UI

A view's DOM can only draw over that view. The rule:

- **Native** (main): the application menu; the tab context menu and the tab overflow menu (`Menu.popup({window: win, x, y})`); open, save and folder pickers; the shell-level message boxes in §6 and §9; the About panel (`app.setAboutPanelOptions`); the editable-field context menu with spelling suggestions (kept from today's `index.ts`, used when the page did not handle `contextmenu`).
- **In-view** (DOM, over its own view only):
  - In a file: the canvas and layer context menus, every Figma modal and popover (Publish library, Libraries, Version history, Share, Move to folder, export), the keyboard shortcuts panel and toasts.
  - In Home: its menus, the New folder, Rename and Move dialogs, Delete forever confirmation and toasts.
  - In the tab bar: hover states. Tab tooltips use the `title` attribute, which Chromium renders as a native tooltip, so it is not clipped by the 38 px view.
- **Never**: a DOM element in one view that has to cover another view, or a view that grows over the others to fake an overlay.

Tab context menu (native), in this order:
1. `Close Tab`
2. `Close Other Tabs`
3. `Close Tabs to the Right`
4. separator
5. `Copy Link` (deep link, §15)
6. `Show in File Browser` (activates Home and reveals the file)
7. separator
8. `Reopen Closed Tab`

Home's tab menu has only `Reopen Closed Tab`.

---

## 8. The menu bar

### 8.1 Registry (`src/shared/commands.ts`)

```ts
export type CommandScope = "app" | "shell" | "editor" | "home" | "view";   // "view" = whichever view is active
export interface CommandSpec {
  id: string;                    // "<area>.<verb>", kebab-case verb: "edit.undo", "object.group-selection"
  label: string;                 // Figma's English wording, title case as in Figma's mac menu bar
  accelerator?: string;          // Electron accelerator syntax
  scope: CommandScope;
  role?: Electron.MenuItemConstructorOptions["role"];
  kind?: "normal" | "checkbox";
}
export const COMMANDS = [ /* … */ ] as const satisfies readonly CommandSpec[];
export type CommandId = (typeof COMMANDS)[number]["id"];
export const MENU_LAYOUT: Record<TopMenu, Array<CommandId | "-" | { submenu: string; items: Array<CommandId | "-"> }>>;
```

The engine and UI teams add their commands to this registry. The menu, the keyboard shortcuts panel and the views' key dispatchers all read it. An id never changes after it ships.

### 8.2 Layout

Top level: **DesignerV2 · File · Edit · View · Object · Text · Arrange · Vector · Window · Help** (Figma's menu bar without Plugins and Widgets).

| Menu | Items (shell and app items are fixed here; the editor team fills Object, Text, Arrange and Vector from `docs/research/figma/R7-editor.md`) |
|---|---|
| DesignerV2 | About DesignerV2 · — · Settings… ⌘, · Theme ▸ (Light, Dark, Use System Setting) · — · Services · — · Hide ⌘H · Hide Others ⌥⌘H · Show All · — · Quit ⌘Q |
| File | New Design File ⌘N · Import… · — · Close Tab ⌘W · Reopen Closed Tab ⇧⌘T · — · Save to Version History… ⌥⌘S · Show Version History · — · Save Local Copy… · Export… ⇧⌘E · Export Frames to PDF… · — · Duplicate · Rename · Move to Folder… · Delete… · — · Share Preview… |
| Edit | Undo ⌘Z · Redo ⇧⌘Z · — · Copy ⌘C (role) · Cut ⌘X (role) · Paste ⌘V (role) · Paste Over Selection ⇧⌘V · Paste to Replace ⇧⌘R · Duplicate ⌘D · Delete ⌫ · — · Copy As ▸ (Copy as Text, Copy as Code ▸ CSS, Copy as SVG, Copy as PNG ⇧⌘C, Copy Link ⌃⌘L) · Copy Properties ⌥⌘C · Paste Properties ⌥⌘V · — · Select All ⌘A · Select Inverse ⇧⌘A · Select None · Select Matching Layers ⌥⌘A · Select All with Same ▸ · — · Find and Replace… ⌘F |
| View | Pixel Grid ⇧' · Snap to Pixel Grid ⇧⌘' · Layout Guides ⌃G · Rulers ⇧R · Outlines ⌘Y · — · Show/Hide UI ⌘\ · Minimize UI ⇧\ · — · Zoom In ⌘= · Zoom Out ⌘- · Zoom to 100% ⇧0 · Zoom to Fit ⇧1 · Zoom to Selection ⇧2 · — · Previous Page · Next Page · — · Enter Full Screen ⌃⌘F (role) · Developer ▸ (Toggle Developer Tools ⌥⌘I, Reload Tab, Open Data Folder) |
| Window | Minimize ⌘M (role) · Zoom (role) · — · Show Next Tab ⌃Tab · Show Previous Tab ⌃⇧Tab · — · Home ⌘1 · Tab 2 ⌘2 … Tab 8 ⌘8 · Last Tab ⌘9 · — · Bring All to Front (role) |
| Help | Keyboard Shortcuts ⌃⇧? · — · Open Data Folder |

`Reload Tab` has no accelerator: ⌘R is Figma's Rename. Developer items exist in packaged builds too, because this is a personal tool.

### 8.3 Routing and accelerators

On macOS, Chromium gives every key event to the focused page first. Only events the page leaves unhandled (no `preventDefault`) reach the menu's key equivalents. The design builds on that:

1. Every accelerator is registered and shown.
2. **Needs from UI**: each view has one key dispatcher on `window`, built from `COMMANDS`. When focus is not in a DOM text field, it runs its own shortcuts (tools, nudges, Space-pan, and every editor command) and calls `preventDefault()`. It **never** calls `preventDefault()` on shell accelerators: ⌘W, ⌘N, ⇧⌘T, ⌃Tab, ⌃⇧Tab, ⌘1–⌘9, ⌘Q, ⌘,, ⌘H, ⌘M, ⌃⌘F.
3. A menu click, or an accelerator the page did not handle, runs `click(item, win, event)`:
   - scope `app` or a `role`: Electron or main handles it.
   - scope `shell`: TabManager or main handles it (tabs, New Design File, Import, theme, settings).
   - otherwise: `activeView.webContents.send("menu:command", {id, source: event.triggeredByAccelerator ? "accelerator" : "menu"})`.
4. **The view's rule**:
   - For `source: "accelerator"` while a DOM text field has focus, only `edit.undo`, `edit.redo` and `edit.select-all` run, as `document.execCommand("undo" | "redo" | "selectAll")` on the field. Every other command is ignored.
   - For `source: "menu"`, the view runs the command against the editor even if a field has focus, after blurring the field.
5. **Copy, Cut and Paste** stay Electron roles. Chromium dispatches DOM `copy`, `cut` and `paste` events in the focused view, and both text fields and the editor listen to them (§13).
6. **Hung views**: main's `before-input-event` on every view intercepts ⌘W, ⌃Tab, ⌃⇧Tab and ⌘1–⌘9 while that view's status is `unresponsive`, so a hung tab can still be left or closed.

**Decisions recorded during integration (2026-10-06):**
- File menu wording follows Home: "Move to folder…" (workspace folders, docs/data.md) and "Move to trash".
- Menu labels use Figma's sentence case ("Group selection", "Paste over selection"), as Figma's own menus and the editor's command table write them. macOS's own items keep title case.
- Command ids are the editor's (`object.group`, `help.shortcuts`, …). Scopes are `app`, `shell`, `view` (Home or a file, whichever is in front) and `editor`.
- Accelerators without ⌘ or ⌃ are displayed and not registered (`registerAccelerator: false`), so a registered ⇧R or ⌥A can't take a character typed into a field.

### 8.4 Menu state

```ts
export interface MenuStatePatch {
  enabled?: Partial<Record<CommandId, boolean>>;
  checked?: Partial<Record<CommandId, boolean>>;     // View toggles, Theme radio
}
```

- Views send `menu:state` with only the keys that changed, at most once per animation frame (≤ 30/s).
- Main merges the patch into that view's `TabRuntime.menuState`. If the view is active, main mutates the existing items (`Menu.getApplicationMenu().getMenuItemById(id).enabled = …`). It never rebuilds the menu.
- On activation, the whole stored state of the new active view is applied.
- **Defaults**:
  - Every `editor` command is disabled until the active editor reports.
  - With Home active, `editor` commands are disabled and Home reports its own (`file.rename`, `file.duplicate`, `file.delete`, `file.move-to-folder` when a file is selected).
  - `shell` and `app` commands are managed by main (for example, `file.reopen-closed-tab` follows `canReopen`).
- Labels never change at runtime; toggles use `checked`.

---

## 9. Crash and hang recovery

| Event | Response |
|---|---|
| editor `render-process-gone` (reason ≠ `clean-exit`) | Status becomes `crashed`. The store ends that session when its port closes, and every acknowledged batch is already on disk. If the view had loaded more than 60 s earlier and the tab has crashed fewer than 2 times in 10 min, **auto-reload**: discard the dead view, then create or adopt a view and attach the same file. Otherwise load `crashed.html` in a new view. It shows "This file stopped working", the text "Your work is saved up to the moment the tab stopped.", and the buttons `Reload` and `Close Tab`. |
| editor `unresponsive` | Status becomes `unresponsive` (the tab bar shows it). If the tab is active and still hung after 5 s, show a native dialog with `signal` from an `AbortController`: `“‹name›” isn’t responding.`, detail `You can wait for it or reload the tab.`, buttons `Wait` and `Reload Tab`. `responsive` aborts the dialog and restores the status. |
| editor reports `tab:report {status: "error", error: "out-of-memory"}` | Same as a crash, but go straight to `crashed.html?reason=memory`: "This file ran out of memory". |
| home or tabbar `render-process-gone` | Recreate the view immediately and push `tabs:state`. No data is at risk. |
| store utilityProcess `exit` | Restart it, at most 3 times in 60 s. Re-broker a new port to every view (`store:port`). Each view's `StoreClient` reattaches its sessions and resends unacknowledged batches; the store dedupes them (`docs/data.md` §7.4). On the 4th exit, show a native dialog `DesignerV2 can’t save changes right now.` with `Try Again` and `Quit`. In the meantime, editors show a read-only banner and stop accepting edits. |
| fonts utilityProcess `exit` | Restart on the next request. Views keep using the font index they already have. |
| `child-process-gone` of type `GPU` | Chromium restarts the GPU process. Views get `webglcontextlost` and `webglcontextrestored`, and the engine re-uploads (**Needs from engine**). After 3 GPU crashes in 5 min, log it and suggest `Settings › Renderer › WebGL 2 (compatibility)`. |
| Wasm trap or JS exception at boot | The page reports `tab:report {status: "error", error}`. The tab shows the error page in the view with `Reload` and `Close Tab`. |

---

## 10. IPC contract

### 10.1 Conventions

- Channel names are `domain:verb`. Kinds:
  - **invoke**: request/response (`ipcRenderer.invoke` / `ipcMain.handle`).
  - **send**: fire-and-forget from a view to main.
  - **event**: from main to a view (`webContents.send`).
- Payloads are structured-clone values. Binary data is `Uint8Array`.
- **Validation in main (`src/main/ipc.ts`)** for every channel:
  1. `event.sender.id` belongs to a registered view.
  2. That view's role is allowed on the channel (the tables below).
  3. `event.senderFrame` is the main frame of that view.
  4. The frame URL's origin is `app://designer`, or the dev server's origin in development.

  Anything else is dropped and logged once.
- All names and types live in `src/shared/ipc.ts` as three maps, `IpcInvoke`, `IpcSend` and `IpcEvents`, keyed by channel. Preload and main import these, so a channel cannot drift.
- The page never sees `ipcRenderer`. It only sees `window.designer`, typed by role in `src/shared/desktop.ts`.

### 10.2 Channels

Roles: **T** tabbar, **H** home, **E** editor, **C** crashed, **All** every role.

**Init and window**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `desktop:init` | invoke | All | `void → InitInfo { version: string; platform: "darwin"; role: Role; tabId: TabId \| null; token: string; settings: Settings; windowId: string }` |
| `shell:ready` | send | T, H, E | `void` (sent after first paint; drives window show and spare timing) |
| `window:state` | event | T, H, E | `{ fullScreen: boolean; focused: boolean }` |

**Tabs**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `tabs:get` | invoke | T, H | `void → TabsSnapshot` |
| `tabs:state` | event | T, H | `TabsSnapshot` (on every change) |
| `tabs:activate` | send | T, H | `{ tabId }` |
| `tabs:close` | send | T, E, C | `{ tabId }` (E and C may only close their own tab) |
| `tabs:move` | send | T | `{ tabId, toIndex }` |
| `tabs:context-menu` | send | T | `{ tabId, x, y }` → native menu (§7) |
| `tabs:overflow-menu` | send | T | `{ x, y }` → native menu listing every tab |
| `tabs:reopen` | send | T, H | `void` |

**Navigation and creating files**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `nav:open-file` | invoke | H, E | `{ fileKey; pageId?; nodeId?; from?: TabId } → { tabId }` |
| `nav:open-prototype` | invoke | E | `{ fileKey; pageId; startNodeId? } → { tabId }` |
| `nav:new-file` | invoke | T, H, E | `{ folderId: string \| null; name?: string } → { fileKey; tabId }`. Main calls `workspace.createFile`, then opens it. Default name `Untitled`; default folder: Drafts, or the folder Home is showing. |
| `nav:go-home` | send | E | `{ revealFileKey?: string }` |

**Editor lifecycle**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `tab:attach` | event | E | `{ tabId; fileKey; mode: "edit" \| "prototype"; pageId?; nodeId?; startNodeId? }` (also adopts the spare) |
| `tab:report` | send | E | `TabReport { title?: string; status?: "loading" \| "ready" \| "error"; error?: string; unsynced?: boolean }` |
| `tab:visibility` | event | E | `{ visible: boolean }` |
| `tab:flush` | event | E | `{ reqId: number; reason: "close" \| "quit" \| "discard" \| "reload" }` |
| `tab:flushed` | send | E | `{ reqId: number; ok: boolean; error?: string }` |
| `tab:navigate` | event | E | `{ pageId?; nodeId? }` (deep link into an already-open file) |
| `tab:memory` | event | E | `{ workingSetMB: number }` (every 10 s while active) |
| `crashed:reload` | send | C | `void` |

**Menu**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `menu:command` | event | H, E | `{ id: CommandId; source: "menu" \| "accelerator" \| "tabbar" }` |
| `menu:state` | send | H, E | `MenuStatePatch` |
| `menu:popup` | invoke | T, H, E | `{ template: NativeMenuItem[]; x: number; y: number } → string \| null` (the picked item's `id`, or null if dismissed). Main builds the menu with `Menu.buildFromTemplate` and shows it with `menu.popup({window, x, y, callback})`. This is the generic native menu from `design-system.md` §4.8, used for any menu that would not fit inside its view. The tab bar's own menus (`tabs:context-menu`, `tabs:overflow-menu`) are built by main because their items are shell commands. |

```ts
export interface NativeMenuItem { id?: string; label?: string; type?: "normal" | "separator" | "checkbox" | "submenu"; checked?: boolean; enabled?: boolean; accelerator?: string; submenu?: NativeMenuItem[] }
```

**Files and native dialogs.** Workspace changes (open, create, duplicate, rename, move, trash, restore, delete forever) are **store-port** calls (`docs/data.md` §8) made directly by H and E. Only operations that need a native dialog or a file path go through main.

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `file:import` | invoke | H, E | `{ folderId: string \| null; paths?: string[] } → ImportResult { files: { fileKey; name }[]; failed: { path; error }[] }`. Without `paths`, main shows `showOpenDialog({filters: [{name: "Figma files", extensions: ["fig"]}], properties: ["openFile", "multiSelections"]})`. Main then calls the store's `files.importLocalCopy(path, folderId)` for each path. |
| `file:save-local-copy` | invoke | H, E | `{ fileKey } → { path } \| { cancelled: true }`. `showSaveDialog({defaultPath: "<name>.fig"})`, then the store's `files.exportLocalCopy(fileKey, path)`. |
| `file:export-assets` | invoke | E | `{ files: { name: string; bytes: Uint8Array }[] } → { paths: string[] } \| { cancelled: true }`. For one file, `showSaveDialog`. For more, `showOpenDialog({properties: ["openDirectory", "createDirectory"]})`, writing every file into the folder; a name collision becomes `name 2.png`, Finder-style. |
| `file:pick-images` | invoke | E | `{ multiple: boolean } → { files: { name; mime; bytes: Uint8Array }[] } \| { cancelled: true }` (Place image ⇧⌘K; PNG, JPEG, GIF, WebP, SVG; at most 50 MB each) |
| `file:path-for-dropped` | — | H, E | not a channel: the preload exposes `webUtils.getPathForFile(file)` as `designer.files.pathFor(file)` for `.fig` drops onto Home or the canvas |
| `file:reveal-data-folder` | send | H, E | `void` (`shell.openPath(workspaceDir)`) |

**Clipboard** (§13)

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `clipboard:trigger-paste` | send | E | `void`. Main calls `event.sender.paste()`, which fires a DOM `paste` event in the view (used by Paste Over Selection, Paste to Replace and the canvas menu's "Paste here"). |
| `clipboard:read-files` | invoke | E | `void → { files: { name; mime; bytes: Uint8Array }[] }`. Finder-copied files: main reads `NSFilenamesPboardType`, falling back to `public.file-url`, and returns only images and `.svg` up to 50 MB each. |

**Fonts** (§14)

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `fonts:list` | invoke | E | `void → FontIndex` |
| `fonts:changed` | event | E | `{ version: number }` |
| bytes | protocol | E | `GET app://designer/_font/<faceId>` with header `X-Designer-Token` |

**Images, blobs and thumbnails.** Writes go through the store port (`blobs.put`). Reads go through the protocol:

| Route | Roles | What |
|---|---|---|
| `GET app://designer/_blob/<sha1>` | H, E | blob bytes (images). MIME is sniffed from magic bytes. `Cache-Control: max-age=31536000, immutable` |
| `GET app://designer/_thumb/<fileKey>.png?v=<n>` | H | file thumbnail |

**Theme and settings**

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `settings:get` | invoke | All | `void → Settings` |
| `settings:set` | invoke | H, E | `Partial<Settings> → Settings` |
| `settings:changed` | event | All | `Settings` |

```ts
export interface Settings {
  theme: "system" | "light" | "dark";                 // the preference; changed only through theme:set
  nudge: { small: number; big: number };              // 1 / 10
  snapToPixelGrid: boolean;
  keepToolSelected: boolean;
  highlightLayersOnHover: boolean;
  renameDuplicatedLayers: boolean;
  showDimensions: boolean;
  renderer: "auto" | "webgl2" | "webgl2-compat" | "webgpu";   // webgpu only once the backend exists
  workspacePath: string | null;                       // null = default (docs/data.md §3)
  owner: { name: string; email: string | null };      // shown in Home's account row; local profile, no sign-in
  sync: { enabled: boolean };                         // docs/data.md §12; config lives elsewhere
}
```

**Theme** (the mechanism is `design-system.md` §2.3; these are its channels):

| Channel | Kind | Roles | Payload → result |
|---|---|---|---|
| `theme:set` | invoke | H, E | `ThemePreference → { preference, resolved }`. Main stores `settings.theme`, sets `nativeTheme.themeSource` and resolves with `nativeTheme.shouldUseDarkColors`. |
| `theme:changed` | event | All | `{ preference: ThemePreference; resolved: "light" \| "dark" }`. Sent on `theme:set`, and on `nativeTheme` `updated` while the preference is `system`. Main also calls `setBackgroundColor(surfaceBackground(…))` on every view. |

Each view gets the theme synchronously at boot through `--designer-theme` (§3). There is no `localStorage` theme and no cross-document sync in the desktop app. The menu's `DesignerV2 › Theme ›` radio items call the same path in main. The engine gets its overlay colours from the editor host (`design-system.md` §2.4).

**Keyboard shortcuts help**: `Help › Keyboard Shortcuts` (⌃⇧?) is `menu:command {id: "help.keyboard-shortcuts"}` to the active editor, which draws Figma's bottom shortcuts panel from `COMMANDS`. It is disabled on Home.

**External links**

| Channel | Kind | Roles | Payload |
|---|---|---|---|
| `shell:open-external` | send | H, E, C | `{ url }`. Only `https:`, `http:` and `mailto:` are allowed; anything else is dropped. |

**Store port**

| Channel | Kind | Roles | Payload |
|---|---|---|---|
| `store:port` | event + transferred `MessagePort` | H, E | `{ generation: number }` (a new generation after each store restart) |

The preload forwards the port to the page: `window.postMessage({type: "designer:store-port", generation}, location.origin, event.ports)`. `StoreClient` in the page accepts only that message type from `location.origin`. The protocol on the port is `docs/data.md` §8.3.

### 10.3 `window.designer` per preload (`src/shared/desktop.ts`)

```ts
type Unsubscribe = () => void;

interface DesktopCommon {
  init(): Promise<InitInfo>;
  ready(): void;                                             // shell:ready
  theme: { preference: ThemePreference; resolved: "light" | "dark" };   // synchronous snapshot from --designer-theme, kept current by the preload
  setTheme(p: ThemePreference): Promise<{ preference: ThemePreference; resolved: "light" | "dark" }>;   // theme:set
  onThemeChanged(cb: (t: { preference: ThemePreference; resolved: "light" | "dark" }) => void): Unsubscribe;
  settings: { get(): Promise<Settings>; onChanged(cb: (s: Settings) => void): Unsubscribe };
  onWindowState(cb: (s: { fullScreen: boolean; focused: boolean }) => void): Unsubscribe;
  onFullScreen(cb: (fullScreen: boolean) => void): Unsubscribe;          // shorthand over window:state (design-system.md §4.23)
  menu: { popup(template: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null> };   // menu:popup
}

export interface TabBarApi extends DesktopCommon {
  tabs: {
    get(): Promise<TabsSnapshot>; onState(cb: (s: TabsSnapshot) => void): Unsubscribe;
    activate(id: TabId): void; close(id: TabId): void; move(id: TabId, toIndex: number): void;
    contextMenu(id: TabId, x: number, y: number): void; overflowMenu(x: number, y: number): void;
    reopen(): void; newFile(): void;                          // "+" → nav:new-file { folderId: null }
  };
}

export interface HomeApi extends DesktopCommon {
  tabs: { get(): Promise<TabsSnapshot>; onState(cb: (s: TabsSnapshot) => void): Unsubscribe; activate(id: TabId): void; reopen(): void };
  nav: { openFile(fileKey: string): Promise<{ tabId: TabId }>; newFile(folderId: string | null): Promise<{ fileKey: string; tabId: TabId }> };
  files: { import(folderId: string | null, paths?: string[]): Promise<ImportResult>; saveLocalCopy(fileKey: string): Promise<{ path: string } | { cancelled: true }>; pathFor(file: File): string; revealDataFolder(): void };
  menu: { onCommand(cb: (c: MenuCommandEvent) => void): Unsubscribe; setState(p: MenuStatePatch): void };
  settings: DesktopCommon["settings"] & { set(p: Partial<Settings>): Promise<Settings> };
  openExternal(url: string): void;
  token: string;                                              // for _blob/_thumb URLs (?t=)
}

export interface EditorApi extends DesktopCommon {
  tab: {
    onAttach(cb: (a: TabAttach) => void): Unsubscribe;
    report(r: TabReport): void;
    onVisibility(cb: (v: { visible: boolean }) => void): Unsubscribe;
    onFlush(cb: (reason: FlushReason) => Promise<void>): Unsubscribe;   // preload answers tab:flushed (ok:false on rejection)
    onNavigate(cb: (n: { pageId?: string; nodeId?: string }) => void): Unsubscribe;
    onMemory(cb: (m: { workingSetMB: number }) => void): Unsubscribe;
    close(): void;
  };
  nav: { openFile(fileKey: string, at?: { pageId?: string; nodeId?: string }): Promise<{ tabId: TabId }>; openPrototype(fileKey: string, pageId: string, startNodeId?: string): Promise<{ tabId: TabId }>; goHome(revealFileKey?: string): void; newFile(): Promise<{ fileKey: string; tabId: TabId }> };
  menu: { onCommand(cb: (c: MenuCommandEvent) => void): Unsubscribe; setState(p: MenuStatePatch): void };
  files: { import(folderId: string | null, paths?: string[]): Promise<ImportResult>; saveLocalCopy(fileKey: string): Promise<{ path: string } | { cancelled: true }>; exportAssets(files: { name: string; bytes: Uint8Array }[]): Promise<{ paths: string[] } | { cancelled: true }>; pickImages(multiple: boolean): Promise<{ files: PickedFile[] } | { cancelled: true }>; pathFor(file: File): string; revealDataFolder(): void };
  clipboard: { triggerPaste(): void; readFiles(): Promise<{ files: PickedFile[] }> };
  fonts: { list(): Promise<FontIndex>; onChanged(cb: (v: { version: number }) => void): Unsubscribe; url(faceId: string): string };
  settings: DesktopCommon["settings"] & { set(p: Partial<Settings>): Promise<Settings> };
  openExternal(url: string): void;
  token: string;
}

export interface CrashedApi extends DesktopCommon { reload(): void; close(): void; openExternal(url: string): void }
```

`isDesktop`, `native()`, `window.top.designer` and `bridge.ts` are gone. A page that needs desktop features reads `window.designer`. The web viewer (`docs/data.md` §13) is a separate build with no `window.designer`.

---

## 11. The `app://` protocol

`protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])`

Every page is served from the origin `app://designer` and handled by `protocol.handle("app", …)` in `src/main/protocol.ts`:

| Path | Source | Extra rules |
|---|---|---|
| `/*.html`, `/assets/*`, `/engine/*` | `out/renderer/…` via `net.fetch(pathToFileURL(file))`. The path-traversal guard from today's `index.ts` is kept. | `.wasm` is served as `application/wasm`, so `WebAssembly.instantiateStreaming` works; `.js`/`.mjs` as `text/javascript`. |
| `/_blob/<sha1>` | `<workspace>/blobs/<sha1[0..2]>/<sha1>` (read-only; `docs/data.md` §10) | token; `immutable` |
| `/_thumb/<fileKey>.png` | `<workspace>/files/<fileKey>/thumbnail.png` | token; `no-cache` (callers add `?v=`) |
| `/_font/<faceId>` | the path from FontsHost's index | token; `font/ttf`, `font/otf` or `font/collection`; header `X-Designer-Collection-Index` |

The token is 32 random bytes in hex, generated per launch. It is handed out by `desktop:init`. It must arrive as header `X-Designer-Token` (fetch) or query `t` (for `<img>` in Home and in panels). Otherwise the response is 403. The token is defence in depth: no other origin can read local fonts or images by guessing URLs.

Headers on **every** response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

HTML responses add the CSP (§12.2).

**Dev parity**: `npm run dev` serves the pages from electron-vite's dev server. `vite.shared.ts` sets `server.headers` to the same COOP, COEP and CORP values. The dev page is cross-origin to `app://designer`, so in dev only the private routes answer with `Access-Control-Allow-Origin: <dev origin>` and `Cross-Origin-Resource-Policy: cross-origin`. The dev page gets the same CSP through a `<meta http-equiv>` that Vite injects, with `'unsafe-inline'` added to `script-src` for HMR.

---

## 12. Security

### 12.1 Baseline
- `app.enableSandbox()` before `ready`. The `webPreferences` are in §3.
- **Navigation**:
  - `will-navigate` and `will-frame-navigate` allow only `app://designer/*.html` (or the dev origin). An `http(s)` target goes to `shell.openExternal`; anything else is cancelled.
  - `setWindowOpenHandler` returns `{action: "deny"}` and opens `http(s)` and `mailto` externally.
  - `will-attach-webview` calls `preventDefault()`.
- **Permissions** (`setPermissionRequestHandler` and `setPermissionCheckHandler`, origin `app://designer` only):
  - Allowed: `clipboard-read`, `clipboard-sanitized-write`, `fullscreen`, `pointerLock` (for Figma's drag-to-scrub on number fields).
  - Denied: everything else, including `local-fonts`, `media`, `notifications` and `geolocation`.
  - `setDevicePermissionHandler(() => false)`.
- **No remote content**: no view ever loads `http(s)`. Firebase (later) runs only in the store process (`docs/data.md` §12), so it is not subject to the renderer CSP.
- **IPC validation** as in §10.1.
- **Electron fuses** (electron-builder `electronFuses`):

  | Fuse | Value |
  |---|---|
  | `runAsNode` | `false` |
  | `enableNodeOptionsEnvironmentVariable` | `false` |
  | `enableNodeCliInspectArguments` | `false` |
  | `enableEmbeddedAsarIntegrityValidation` | `true` |
  | `onlyLoadAppFromAsar` | `true` |
  | `grantFileProtocolExtraPrivileges` | `false` |
  | `enableCookieEncryption` | `true` |

- **userData**: the packaged app uses `~/Library/Application Support/DesignerV2`. Unpackaged (`!app.isPackaged`) uses `…/DesignerV2-Dev`, so a dev run never shares a workspace with the installed app. `DESIGNER_USER_DATA` overrides both.

### 12.2 CSP (HTML responses)

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data: blob:;
media-src 'self' blob:;
connect-src 'self' blob: data:;
worker-src 'self' blob:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

`'wasm-unsafe-eval'` is required: `shell.md` §2 showed that `script-src 'self'` alone blocks `WebAssembly.compile` in Electron 44. There are no `https:` or `wss:` sources any more.

### 12.3 Cross-origin isolation (decided: on)

COOP `same-origin` plus COEP `require-corp` gives `crossOriginIsolated === true` (verified in Electron 44, `shell.md` §2). Reasons to turn it on now:
1. It costs nothing: every resource is same-origin `app://`.
2. It enables `SharedArrayBuffer`, so a later threaded engine build (pthreads for tile rasterisation or image decode) needs no shell change.
3. It enables `performance.measureUserAgentSpecificMemory()` for the memory meter and full-resolution timers for the frame-time harness.

The v1 engine is built single-threaded with non-shared memory (`-sPTHREADS=0`, `-sALLOW_MEMORY_GROWTH=1`, `-sMAXIMUM_MEMORY=4GB`), matching Figma's shipped module (`R1-engine.md` §e).

### 12.4 Packaging (`electron-builder.yml`)
- `appId: net.burakkoc.designerv2`, `productName: DesignerV2`, macOS arm64 DMG, ad-hoc signed. It is personal use, so there is no notarisation.
- `fileAssociations`: `.fig` with `role: Viewer` and `LSHandlerRank: Alternate` (through `extendInfo`), so DesignerV2 never takes `.fig` away from Figma.
- `protocols`: `designerv2` (§15).
- `extraResources`: `schema/document.kiwi` → `resources/schema/document.kiwi` (the store loads it; `docs/data.md` §5.8) and `resources/seed/*.fig` (demo seed). Inter ships inside the renderer build (`public/fonts/`).

---

## 13. Clipboard

Figma's own format is a `text/html` envelope with a base64 kiwi archive inside. We write that envelope too, plus our own type.

This section is the contract for the shell's side of `engine.md` §10.7. It keeps that section's private type and its HTML envelope, and changes two things:

1. **There is no IPC write.** Electron's main-process `clipboard.writeBuffer` replaces the whole pasteboard on every call, so main cannot put a custom type, `text/html` and `text/plain` on the pasteboard together. The renderer's DOM `copy` event can do it in one atomic write.
2. **A normal copy carries no PNG.** Figma's ⌘C does not either: an image comes only from Copy as PNG (⇧⌘C). An export on every copy would also make copying a large selection slow.

**Copy and Cut** (⌘C and ⌘X, the Edit roles, or the canvas context menu, which calls `document.execCommand("copy")` from a click so it counts as a user gesture). This happens in the editor's DOM `copy`/`cut` listener, synchronously and atomically:

```ts
e.preventDefault();
const message = engine.copy({ cut });            // engine_copy → kiwi Message (engine.md §10.7)
const archive = figContainer(schemaBytes, message, "deflate-raw");   // "fig-kiwi" prelude, version, deflate-raw schema, deflate-raw Message
const b64 = base64(archive);
const meta = base64(JSON.stringify({ fileKey, pasteID, dataType: "scene", app: "designerv2" }));
e.clipboardData.setData("application/x-designerv2-kiwi", b64);
e.clipboardData.setData("text/html",
  `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span>` +
  `<span data-buffer="<!--(figma)${b64}(/figma)-->"></span></div>` +
  `<span style="white-space:pre-wrap;">${escapeHtml(plain)}</span>`);
e.clipboardData.setData("text/plain", plain);   // text layers' characters joined by "\n", else layer names
```

`engine_copy` supplies the `Message`: the selected subtrees, plus the main components and styles they depend on, plus their blobs, `pasteFileKey` and `pastePageId`. `figContainer` (`src/shared/fig/container.ts`, shared with the store) wraps it with deflate-raw, so browsers can decode it with `DecompressionStream`. No zstd is needed in the renderer. Deflate here is synchronous: the payload is small, and `fflate`'s `deflateSync` is used because the `copy` event cannot await.

**Paste** (⌘V role, or `clipboard:trigger-paste`). The editor's DOM `paste` listener reads `e.clipboardData`, takes the first match in this order and calls `preventDefault()`:
1. `application/x-designerv2-kiwi`: unwrap the archive, then `engine_paste(message, mode)`.
2. `text/html` containing `(figma)…(/figma)`: decode the archive. If its schema is ours, `engine_paste`. If it is Figma's (pasted from real Figma), convert it with `src/shared/fig/convert.ts` (the same converter `.fig` import uses), then `engine_paste`.
3. `e.clipboardData.files` holding images (screenshots, images copied from browsers): ImagePipeline (`docs/data.md` §10), then the engine command `PLACE_IMAGES` (`engine.md` §10.6).
4. `text/plain` starting with `<svg`, or `image/svg+xml`: an SVG import into vector nodes. **Needs from engine**: `engine_import_svg`, not yet in `engine.md` §10; until it exists, SVG text pastes as a text layer.
5. Empty, but Finder copied files: `designer.clipboard.readFiles()`, then go to step 3 or 4.
6. `text/plain`: a new text layer, or the text inserted if a text layer is in edit mode (the engine handles this itself).

When focus is in a DOM text field, the listener does nothing and the field pastes natively.

**Paste modes** (`engine_paste` modes `IN_PLACE`, `AT_POINT`, `OVER_SELECTION`, `REPLACE`): Paste Over Selection (⇧⌘V), Paste to Replace (⇧⌘R) and "Paste here" all work the same way. The view sets `pendingPasteMode`, then calls `designer.clipboard.triggerPaste()`. Main calls `webContents.paste()`, and the resulting `paste` event uses the mode and clears it. Order is guaranteed because the view sets the mode before it asks.

**Other copies**:
- Copy as PNG (⇧⌘C): `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`, rendered by the engine at 2×.
- Copy as SVG and Copy as Code › CSS: `text/plain`, as Figma does.
- Copy Link (⌃⌘L): `text/plain` deep link (§15).

`figma-layers:` plain-text payloads (today's `FigmaEditor.tsx:156`) are dropped.

---

## 14. Fonts

- **Process**: the `fonts` utilityProcess (`src/fonts/index.ts`) starts on the first `fonts:list`. A malformed font can crash only that process.
- **Sources**:
  - `system`: `/System/Library/Fonts/**` and `/System/Library/AssetsV2/com_apple_MobileAsset_Font*/**/AssetData/*` (downloaded system fonts).
  - `user`: `/Library/Fonts/**` and `~/Library/Fonts/**`.
  - `bundled`: `src/renderer/public/fonts/InterVariable.ttf` (Inter, the default for new text, matching Figma's default Inter Regular 12).
- **Formats**: `.ttf`, `.otf`, `.ttc`, `.otc`. Figma supports only TTF and OTF; `.dfont` is skipped.
- **Parsing**: a small dependency-free sfnt reader (`src/fonts/sfnt.ts`) reads `name` (IDs 1, 2, 4, 6, 16, 17), `OS/2` (weight class, width class, `fsSelection`, `fsType`), `head`, and `fvar`/`STAT` for variable axes and named instances. A collection yields one face per index.
- **Index**: `userData/cache/fonts-v1.json`, keyed by `path + mtime + size`. Only new or changed files are reparsed. `fs.watch` on the user directories triggers an incremental rescan, then `fonts:changed`.

```ts
export interface FontFaceInfo {
  id: string;                    // first 16 hex of sha1(path + "#" + collectionIndex)
  family: string;                // typographic family (name 16, else 1)
  style: string;                 // typographic subfamily (name 17, else 2), e.g. "Semi Bold Italic"
  postscriptName: string;
  weight: number; italic: boolean; stretch: number;      // 100–900, fsSelection/style, 1–9
  source: "system" | "user" | "bundled";
  collectionIndex: number;
  variable: null | { axes: { tag: string; name: string; min: number; max: number; default: number }[]; instances: { name: string; coords: Record<string, number> }[] };
  embeddable: boolean;           // fsType allows at least preview & print (used by preview export, docs/data.md §13)
}
export interface FontIndex { version: number; faces: FontFaceInfo[] }   // paths are never sent to renderers
```

- **Bytes**: `fetch(designer.fonts.url(id), {headers: {"X-Designer-Token": token}})` returns the whole file, plus `X-Designer-Collection-Index`. Main resolves `id` to a path through FontsHost and streams it. The bundled Inter is the static file `src/renderer/public/fonts/InterVariable.ttf` (`engine.md` §1.7), served at `app://designer/fonts/InterVariable.ttf`. The index lists it with `source: "bundled"`, and `fonts.url(id)` returns that static URL.
- **Request path** (`engine.md` §7.1):
  1. The engine emits `REQUEST_FONT {family, style}`.
  2. The TS FontRegistry looks the face up in the `FontIndex`, matching `family` with `style`, then postscript name, then the nearest weight and italic.
  3. It fetches the bytes and calls `engine_font_add_take(ptr, len, collectionIndex)`.
  4. If nothing matches, it calls `engine_font_missing`.
- **Needs from engine**: shape and rasterise from these bytes (HarfBuzz and FreeType or equivalent, per `R1-engine.md` §d). The engine caches loaded faces per tab. DOM text is never used on the canvas.
- **Missing fonts**: a layer whose font is not in the index draws with stored glyph outlines, if the document has them, or else with Inter. The editor shows Figma's "Missing fonts" UI.

---

## 15. Opening files from outside, deep links

- **URL scheme** `designerv2://`: `designerv2://file/<fileKey>?node-id=<s>-<l>` (Figma's URL style, `1-23` for GUID `1:23`), and `designerv2://folder/<folderId>`. These are handled by `open-url` (queued until ready) and by `second-instance` argv. An open file is activated and sent `tab:navigate`; a file that is not open is opened at that node.
- **`.fig` files**:
  - Opened from Finder or the Dock (`open-file`, queued before `ready`) or passed in `second-instance` argv: imported into **Drafts** through the store's `files.importLocalCopy`, then opened in a new tab. Figma does the same for a double-clicked `.fig`.
  - Dropped on Home: imported into the folder being viewed, not opened. Home shows a toast `Imported “‹name›”` with an `Open` action.
- **Single instance**: `requestSingleInstanceLock` is kept. `second-instance` now parses argv for paths and `designerv2://` URLs.

---

## 16. What happens to today's shell code

| Today | Fate |
|---|---|
| `src/main/index.ts` window setup, `onScreen`, single-instance, protocol guard, link handling, editable context menu, dev console forwarding, `DESIGNER_USER_DATA` | **Port** into `window.ts`, `protocol.ts` and `index.ts` as described above |
| `window.json` | **Replace** with `session.json` (bounds and tabs) and `settings.json` (theme) |
| `src/main/menu.ts` | **Rewrite** from `src/shared/commands.ts` |
| `src/main/signIn.ts`, `auth:google`, `auth:cancel`, `__FIREBASE_VERSION__` define, `src/shared/firebaseConfig.ts` (old `burakkoc-a15d3` config), the Storage CORS hack, `connect-src https: wss:` | **Delete** in the shell rewrite. The loopback system-browser flow (random port on 127.0.0.1, `state` checked in constant time, 10-minute timeout) comes back, redesigned, in `src/main/sync/googleSignIn.ts` when Firebase sync is built (`docs/data.md` §12.3). Git history keeps the old file. |
| `window:guard`, `window:close-requested`, `window:close`, `window:close-cancel` | **Replace** with the flush handshake (§6) |
| `src/shared/api.ts` (`NativeApi`, `MenuCommand`, `GoogleCredential`, `SignInResult`) | **Replace** with `src/shared/ipc.ts`, `desktop.ts` and `commands.ts` |
| `src/preload/index.ts` | **Split** into the role preloads; the `on()` helper and the `--designer-version=` argument are kept |
| `src/renderer/src/main.tsx` two-role page, `?tab=&kind=&slug=` | **Replace** with separate HTML entries per role |
| `app/Shell.tsx`, `app/ShellApp.tsx` (sign-in gate, `NotAdmin`), `app/bridge.ts`, `app/native.ts`, `tab/TabApp.tsx`, `tab/EditorTab.tsx` | **Delete**. Iframes, `designerShell`/`designerTab`, sync `isDirty` and the DOM modals over tabs all go. |
| `app/tabs.ts` reducer | **Move** to `src/shared/tabs.ts` and extend it (§4.1). Tests are added. |
| `app/TabBar.tsx`, `app/icons.tsx`, `app/ui.tsx` | **Port** to the tabbar root, restyled to the measured metrics: 38 px, `#3b3b3b`, Home 40 px, room 80 px, `#4f4f4f` separators, active tab `#2c2c2c`. Drag, middle-click and the dirty dot: the dirty dot is removed; the rest is kept. |
| `public/boot.js`, `context/ThemeContext.tsx` cross-document sync | **Replace** as `design-system.md` §2.3 specifies: `boot.js` reads `window.designer.theme`; `ds/theme.ts` replaces ThemeContext; `theme:set`/`theme:changed` replace `theme:set` (old) plus localStorage |
| `tab/PreviewTab.tsx`, `tab/siteTokens.ts`, `cv/*`, the `preview` and `cv` tab kinds | **Delete** (`docs/data.md` §14) |
| `scripts/drive.mjs` | **Update**: find pages by URL (`/tabbar.html`, `/home.html`, `/editor.html?tab=<id>`); `menu <id>` calls the click path in main through `electronApp.evaluate`; the active editor is the one whose tab is active in `tabs:get` |
| `scripts/make-icon.cjs` | **Keep** |

---

## 17. Test hooks

| Env var | Effect |
|---|---|
| `DESIGNER_USER_DATA=<dir>` | userData root (kept) |
| `DESIGNER_WORKSPACE=<dir>` | workspace root, overriding `settings.workspacePath` |
| `DESIGNER_SEED=demo` | on an empty workspace, import `resources/seed/*.fig` into a "Samples" folder (`npm run dev:demo` sets this and a temporary userData) |
| `DESIGNER_DISABLE_SPARE=1` | no spare editor view |
| `DESIGNER_LOG=debug` | verbose main, store and fonts logs to stdout |

Main also handles `ipcMain` `test:*` channels when `process.env.DESIGNER_TEST === "1"`: `test:tabs` returns full runtime state, and `test:flush-all` runs the quit flush without quitting. These are compiled out of packaged builds.

---

## Open questions

1. **`setVisible(false)` and page visibility**: does `document.visibilityState` become `hidden` and does rAF stop for a `WebContentsView` hidden with `setVisible(false)` in Electron 44? The design does not depend on it, because `tab:visibility` is explicit, but GPU and CPU use while hidden does. Verify with `drive.mjs`. If it does not, use `contentView.removeChildView()` for hidden tabs.
2. **`codeCache` privilege for Wasm**: does the custom-scheme `codeCache` privilege also cache compiled Wasm for `instantiateStreaming`? If not, the spare view hides the compile cost for the first open only. Measure the compile time of the real `engine.wasm`.
3. **Exact Figma wording** for the tab context menu, the crashed page and the hang dialogs. The strings above are ours, written in Figma's style. They should be checked against Figma Desktop 126 and replaced if Figma's differ.
4. **Light-theme tab bar colours** are marked "G" (unverified) in `design-system.md` §1.3. The shell takes whatever `surfaceBackground("tabbar", …)` returns.
5. **Will real Figma accept our clipboard envelope** (paste from DesignerV2 into Figma)? Reading Figma's clipboard into ours is designed and in scope. The other direction depends on how close the document schema stays to `figma-schema.kiwi` (the document contract's decision).
6. **Multiple windows and dragging a tab out**: the structures allow it, but it is not scheduled for v1.
