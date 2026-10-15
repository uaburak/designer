# Plugins and widgets (contract, Phase 7 round 5; written 2026-10-11)

**Status: contract; main's side (5e) built — §3.4; the host, the API, the chrome and the schema (5d) — §5a; the server (5c) §10.3a; the store (5g) §10.3b.** This document covers Figma's plugins in DesignerV2:
- the sandbox for a plugin's code and its UI;
- the `figma.*` API we implement first;
- development plugins from a `manifest.json`;
- the Plugins menu, the Actions panel and the Tools tab;
- Dev Mode plugins (codegen, inspect);
- private organization plugins, and admin approval;
- network access;
- what the store, main and the server hold.

Widgets are decided in §11. Research: R18 E-2. The plan: `docs/roadmap.md` "Round 5". The REST API and the D1 tables are in `docs/multiplayer.md` §16 (migration 0015).

Facts were read on 2026-10-11. DEV = `https://developers.figma.com/docs`, HELP = `https://help.figma.com/hc/en-us/articles`.

| Tag | Source |
|---|---|
| **[P-run]** | DEV/plugins/how-plugins-run/ |
| **[P-ui]** | DEV/plugins/creating-ui/; DEV/plugins/api/properties/figma-showui/; DEV/plugins/api/figma-ui/ |
| **[P-man]** | DEV/plugins/manifest/ |
| **[P-api]** | DEV/plugins/api/figma/; DEV/plugins/api/figma-viewport/; DEV/plugins/api/figma-variables/; DEV/plugins/api/figma-clientStorage/; DEV/plugins/accessing-document/ |
| **[P-gen]** | DEV/plugins/codegen-plugins/ |
| **[P-blog]** | "How we built the Figma plugin system" (figma.com/blog) and Evan Wallace's "An update on plugin security" (madebyevan.com/figma/an-update-on-plugin-security/) |
| **[P-run-help]** | HELP/360042786733 (Run plugins in files) |
| **[P-priv]** | HELP/4404228629655 (Create private organization plugins) |
| **[P-approve]** | HELP/4404228724759 (Approve plugins in an organization) |
| **[P-request]** | HELP/17882120337815 (Request approval to use a widget or plugin) |
| **[W]** | DEV/widgets/; DEV/widgets/widget-manifest/ |

(unverified) marks what those pages don't state. Where the text says unverified, the choice made is ours.

## 1. What Figma does

**The sandbox for `code.js`** [P-run]:
- Plugin code runs **on the main thread, in a minimal JavaScript sandbox with no browser APIs**.
- It has ES2020+, the standard built-ins (`Map`, `Promise`, `JSON`, typed arrays, `structuredClone` …) and a minimal `console`.
- It has no DOM and no `XMLHttpRequest`.
- `fetch` is a `figma`-page global (listed in [P-api]); `setTimeout` is unverified.

**History** [P-blog]:
- Figma first used the Realms shim.
- After a 2019 vulnerability report, it moved to **a JavaScript VM written in C, compiled to WebAssembly** (QuickJS, per secondary sources).
- Plugins > Development > "Use Developer VM" runs development plugins in the browser's own engine so devtools work (forum; unverified).

**The UI** [P-ui]:
- `figma.showUI(html, {visible, width = 300 (≥ 70), height = 200, title, position, themeColors})` puts the HTML in an `<iframe>`. The iframe has browser APIs but no document access.
- `__html__` is the manifest's `ui` file. A `ui` map is exposed as `__uiFiles__`.
- **Messages from the plugin to the UI**: `figma.ui.postMessage(msg)`, received as `event.data.pluginMessage`.
- **Messages from the UI to the plugin**: `parent.postMessage({pluginMessage}, '*')`, received by `figma.ui.onmessage` or `figma.ui.on('message')`.
- Messages queue until the iframe loads.
- Data is structured-cloneable, plus `Uint8Array`. Not `Blob` or `ArrayBuffer`.
- An iframe that navigated to a real origin must add `pluginId`.
- The default iframe has a **null origin**: drops arrive as `pluginDrop`, handled by `figma.on('drop')`.
- `figma.ui`: `show`, `hide`, `resize`, `reposition`, `getPosition`, `close`, `postMessage`, `onmessage`, `on` / `once` / `off`.

**Run and close** [P-run]: if `figma.closePlugin(msg?)` isn't called, a "Running ‹name›" toast stays until the user cancels.

**Pages** [P-api]: with `documentAccess: "dynamic-page"`:
- Pages load on demand (`page.loadAsync()`, `figma.setCurrentPageAsync`, `figma.loadAllPagesAsync()`).
- The deprecated synchronous lookups (`getNodeById`, `variables.getVariableById` …) throw.
- `figma.currentPage` is read-only.
- Without it, the first run loads every page ("Loading n pages").

**The manifest** [P-man]: §4.

**Network** [P-man]:
- **Blocked by default**: domains not in `networkAccess.allowedDomains` are blocked by CSP. `["none"]` blocks everything.
- **Wildcards**: `"*"` allows everything but needs `reasoning`; `*.domain` covers subdomains.
- **Schemes and paths**: optional schemes `http`, `https`, `ws`, `wss`; paths are allowed (a trailing `/` covers what is below it).
- **Development**: localhost needs `reasoning`; `devAllowedDomains` applies in development only.
- The limits apply to "requests the plugin makes" (whether this covers the iframe and the sandbox alike is unverified).

**Development** [P-run-help], [P-blog]:
- **Menus**: Figma menu › Plugins › Development › "New plugin…" and "Import new plugin from manifest…".
  - "New plugin…" templates: Default, Run once, Custom UI; in Dev Mode, Inspect and Code Generator.
  - Hot reload, "Use Developer VM" and the console come from community sources (unverified).
- **Where they run**: development plugins appear in a Development section of the plugin lists; developing needs the desktop app.

**Running** [P-run-help]:
- Run last plugin: ⌥⌘P.
- Saved plugins.
- Design: the Tools tab in the left navigation, filtered by Plugin.
- Dev Mode: the Plugins panel in the right sidebar.
- The Actions panel's "Plugins & widgets" tab [P-request].

**Codegen** [P-gen]:
- The manifest has `editorType: ["dev"]`, `capabilities: ["codegen"]` and `codegenLanguages`.
- `figma.codegen.on("generate", e => CodegenResult[] | Promise)` runs on each selection change and preference change, with a 3 s timeout.
- `CodegenResult = {language, code, title}`. Each one is a titled section in Inspect › Code.
- `codegenPreferences` items are `unit`, `select` and `action`. `action` opens `showUI`; listen for `preferenceschange` and call `figma.codegen.refresh()`.

**Private plugins** [P-priv]:
- Publish from an org file: Plugins › Manage plugins › Publish, choosing the org.
- No review. Any member may publish.
- Only the publisher changes access.
- Guests can't install or run them.

**Approval** [P-approve], [P-request]:
- **Settings**: Admin › Settings › Extensions: "Plugin approval" / "Widget approval" — "Only admin-approved plugins." / "Only admin-approved widgets.", with "Allow members to request plugins" / "… widgets".
- **Exempt**: private plugins and widgets.
- **Requests**:
  - Members request from the Actions › "Plugins & widgets" tab › "Request approval", with a reason.
  - Every admin is notified.
  - The review has Overview, Request history, "Try it out", Decline (with an optional reason) and Approve.
  - Enterprise: approval for the whole org or for chosen workspaces. Approving only some workspaces blocks the plugin in drafts.
- **Adding directly**: Admin › Resources › Plugins › "Add plugin".
- **Editing approvals**: "Edit approvals" with per-workspace toggles; a "Usage" tab (Enterprise).
- **Activity**: actions in docs/multiplayer.md §16.11.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Sandbox | **Figma's: a JavaScript VM compiled to WebAssembly on the editor's main thread** — QuickJS through `quickjs-emscripten` (exact pins: `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-asyncify`, versions fixed by 5d at the newest release ≥ 2 weeks old, `package.json` exact). One runtime per plugin run. See the list after this table. |
| 2 | "Use developer VM" | Plugins › Development › **Use developer VM** (a check item, development plugins only): the same host behind a **dedicated Worker** running the plugin's code in V8. See the list after this table. |
| 3 | The UI | A sandboxed iframe with an **opaque (null) origin**, as Figma's. See §3.2. |
| 4 | Network from `code.js` | `fetch` in the sandbox is ours, implemented by **main** (`plugins:fetch`), which checks the URL against the manifest's `networkAccess` before fetching (`net.fetch`, no cookies, 30 s timeout, ≤ 20 MB). The browser build has no main, so `fetch` in `code.js` rejects there ("Network access from plugin code needs the desktop app"); the UI iframe's own fetch still works under its CSP. |
| 5 | Where plugins come from | **No Community** (R18): development plugins imported from a manifest on disk (the owner's own, or a Community plugin's source he got himself); private plugins of the org (server, §10); nothing else. |
| 6 | Undo | Figma's: a run's edits are **one undo step** in the user's history, labelled with the plugin's name, split by `figma.commitUndo()`; `figma.triggerUndo()` undoes the user's last step. Writes are the **user's own** — a plugin runs as the person: it changes their selection and page, unlike an agent's actor (docs/engine.md §9.5). A write while the user drags waits (`E_BUSY` → `engine_idle`); the asyncify build suspends the VM meanwhile. |
| 7 | Pages | We load every page at open (docs/engine.md §2.6), so `loadAsync` / `loadAllPagesAsync` resolve at once. Figma's rules are still enforced: under `"dynamic-page"`, the deprecated sync APIs throw Figma's errors and `figma.currentPage = …` throws. Without `documentAccess`, they work, and a run on a file of more than one page shows Figma's "Loading n pages" toast for parity. |
| 8 | Widgets | **Later, not round 5** (§11). |
| 9 | Plugin data | Figma's `pluginData` (204) and `pluginRelaunchData` (219) on `NodeChange`, with Figma's `PluginData` / `PluginRelaunchData` messages (`figma-schema-106.kiwi`), added to `schema/document.kiwi` by 5d — the round's only schema change (§8). |
| 10 | Dev Mode plugins | `editorType` `dev` with `inspect` / `codegen`: in Dev Mode's right sidebar "Plugins" panel and in Inspect › Code (§7). `vscode` and `textreview` capabilities: ignored (no VS Code extension, no text review). |
| 11 | Code Connect templates | Run in the same QuickJS host with Figma's template API (docs/editor.md D-1): one VM, two APIs. |

**Decision 1, the QuickJS sandbox:**
- **Isolation**: the VM has its own heap, with no access to the editor's realm, DOM, IPC or engine except through the host functions the API exposes.
- **Limits**:
  - memory 256 MB per run (`runtime.setMemoryLimit`);
  - stack 1 MB;
  - an interrupt handler lets **Stop plugin** (the "Running ‹name›" toast's ✕) end a runaway loop.
- **Async host calls**: the asyncify build lets host functions return promises — needed for `…Async` APIs, `fetch`, `clientStorage`, and waiting while the user drags (decision 6).

**Decision 2, the developer VM:**
- The Worker runs the plugin's code in V8, so devtools can debug it.
- **Synchronous calls**: made through a `SharedArrayBuffer` and `Atomics.wait`. The views are cross-origin isolated (docs/desktop.md §12.3).
- **Locked globals**: `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `Worker`, `indexedDB` and `caches` are deleted from the worker's global scope and prototypes before the plugin's code loads. The worker's script is served with `connect-src 'none'` (§3.3).
- **One `PluginVm` interface** covers both VMs; the API code is shared.
- Figma's isolation guarantee holds only in QuickJS. The developer VM is for the person developing.

## 3. Architecture

```
editor view (renderer, main thread)
 ├─ PluginHost (editor/plugins/host.ts) — one per running plugin; menus, toast, Stop
 │   ├─ PluginVm: QuickJsVm (vm/quickjs.ts) | DevWorkerVm (vm/devWorker.ts)
 │   │     code.js  ──calls──▶ figma.* bridge (api/*.ts) ──▶ EditorController / engine (setProps, txn, export…)
 │   └─ PluginUiFrame (ui/PluginWindow.tsx): <iframe sandbox src="plugin://<runId>/ui.html"> — a ds floating window
 │         ui.html ⇄ postMessage {pluginMessage} ⇄ host ⇄ figma.ui.onmessage
 ├─ store (MessagePort): plugins repository — saved / recents, private plugins (server), approvals
 └─ main (IPC plugins:*) — development manifests and files, fetch with the allowlist, clientStorage, plugin: protocol
```

### 3.1 The host (`src/renderer/src/editor/plugins/`, 5d)

**Files:**
- `host.ts`: `PluginHost` (run, stop, the run's undo grouping, events).
- `vm/`: `types.ts` (`PluginVm`), `quickjs.ts`, `devWorker.ts`, `devWorker.worker.ts`.
- `api/`: the `figma` object, by area — `nodes.ts`, `create.ts`, `selection.ts`, `viewport.ts`, `ui.ts`, `storage.ts`, `variables.ts`, `styles.ts`, `fonts.ts`, `images.ts`, `export.ts`, `events.ts`, `codegen.ts`, `devResources.ts`, `util.ts`.
- `ui/`: the plugin window, the "Running ‹name›" toast, the parameters prompt.
- `menus.ts`: the plugin parts of the Plugins menu, the canvas menu and Actions.

**How a call works:**
- A node handle in the VM is an object `{id}`, frozen, with prototype getters and setters by node type.
- Every property read and write is one host call `nodeGet(id, prop)` / `nodeSet(id, prop, value)`.
- They reuse the agents' Plugin-API property layer: `editor/agents/nodeSpec.ts` (`readProps`, `fieldsOf`, `describePaints`, `parsePaints` …) and `src/shared/agents/layerProps.ts`. Properties keep Figma's Plugin API names, which the agents' tools already speak.
- Returned values are copied (Figma's arrays are frozen copies: `fills` must be reassigned).
- Writes inside one run go through **one open USER transaction per synchronous slice**, coalesced into the run's undo step (`merge` on the editor's transaction).
- `figma.commitUndo()` closes the step.

**Events:**
- **Engine events** (`SELECTION_CHANGED`, `CURRENT_PAGE_CHANGED`, `DOCUMENT_CHANGED`) feed `figma.on('selectionchange' | 'currentpagechange' | 'documentchange')`.
- **`documentchange`** carries Figma's `DocumentChange` list (`CREATE` / `DELETE` / `PROPERTY_CHANGE` with `properties`, `origin: "LOCAL" | "REMOTE"`), built from the batch's NODE_CHANGES.

**Ending a run:**
- A run ends on `closePlugin`, Stop, or the file closing.
- On close: `figma.on('close')` handlers run (≤ 500 ms, ours), then the VM is disposed.

### 3.2 The UI iframe

**Desktop:**
- **Scheme**: main registers a privileged scheme `plugin` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`). The UI is `plugin://<runId>/ui.html`, made from the manifest's `ui` HTML for that run.
- **Iframe**: `sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`, **without `allow-same-origin`**: an opaque origin, no storage, no access to the editor.
- **Response headers** from `src/main/plugins/protocol.ts`:

  | Header | Value |
  |---|---|
  | `Cross-Origin-Embedder-Policy` | `credentialless` |
  | `Cross-Origin-Resource-Policy` | `cross-origin` |
  | `Content-Security-Policy` | `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: <S>; style-src 'unsafe-inline' <S> https://fonts.googleapis.com; font-src data: <S> https://fonts.gstatic.com; img-src data: blob: <S>; media-src data: blob: <S>; connect-src <S>; frame-src <S>; worker-src blob:; form-action 'none'; base-uri 'none'` |

  `<S>` is the manifest's `allowedDomains` turned into CSP sources by `src/shared/plugins/network.ts toCspSources` (`none` → nothing; `*` → `https: wss:`; a path keeps its path), plus `devAllowedDomains` for development plugins.
- **Why `credentialless`**: the parent requires COEP, so the frame needs a COEP of its own, and `credentialless` lets plugin UIs load outside images that send no CORP.
- **The editor's CSP** (docs/desktop.md §12.2) changes `frame-src 'none'` to `frame-src plugin:`.
- **Navigation**: `will-frame-navigate` lets frames navigate within `plugin:` and to the manifest's allowed `https:` origins (Figma's "navigated to a custom URL"); anything else is cancelled. `window.open` goes to `shell.openExternal`.

**Browser build** (dev, web): the iframe is `srcdoc` with the same `sandbox`, and the CSP is injected as `<meta http-equiv="Content-Security-Policy">` at the top of the HTML.

**Messages:**
- The host accepts only `message` events whose `event.source` is that iframe's `contentWindow`.
- Messages are queued until the frame's `load`.
- `{pluginMessage, pluginId?}` is unwrapped as Figma's. Sent values go through `structuredClone`; `Blob` and `ArrayBuffer` are refused, as Figma's.
- `pluginDrop` is handled as Figma's (`figma.on('drop')`, with canvas coordinates from the drop point).

**Theme**: `themeColors: true` injects Figma's `--figma-color-*` variables (light and dark, from `src/renderer/src/ds`) and `class="figma-light|figma-dark"` on `<html>`, as Figma.

**The window**:
- A ds floating panel over the canvas: the title bar with the plugin's name and ✕, and the iframe below.
- Draggable; the position is kept per plugin.
- `position` takes canvas coordinates.
- `resize` / `reposition` / `getPosition` follow the API.

### 3.3 Main (`src/main/plugins/`, 5e)

- **`manifests.ts`**: development plugins.
  - The list lives in `userData/plugins/development.json` as `{path, id, name, addedAt}[]`.
  - Import: "Import new plugin from manifest…" opens main's file dialog (`manifest.json`). Main reads the manifest and validates it (`src/shared/plugins/manifest.ts parseManifest`).
  - `build`: the manifest's shell command is **not run** (Figma's field is experimental; running arbitrary commands from a manifest is refused — ours). The person runs their build themselves.
  - Main reads `main` and `ui` from the folder: paths inside the manifest's folder only, after symlinks; ≤ 20 MB each.
  - Views never read files.
- **`watch.ts`**: **Hot reload plugin** (a check item, on by default). `fs.watch` on the plugin's folder (`main`, `ui` files), debounced 300 ms, sends `plugins:changed {id}`. The host restarts a running development plugin with the new code: Figma's "restarts automatically after you rebuild".
- **`protocol.ts`**: the `plugin:` scheme (§3.2).
  - Runs are registered by the view with `plugins:open-ui {runId, html, allowedDomains, dev}`.
  - A run's documents are forgotten at `plugins:close-ui`.
  - The developer VM's worker script is also served here (`plugin://<runId>/worker.js`, CSP `connect-src 'none'`).
- **`fetch.ts`**: `plugins:fetch {runId, url, init}`.
  - Main checks the run's manifest `networkAccess`: domain, scheme, path, and `devAllowedDomains` for development plugins.
  - Blocked → Figma's CSP-style error text: "Refused to connect to '‹url›' because it violates the plugin's networkAccess (manifest.json)".
  - Answers `{status, statusText, headers, body: Uint8Array}`.
- **`storage.ts`**: `figma.clientStorage`.
  - `userData/plugins/storage/<pluginId>.json`.
  - **5 MB per plugin**: the key's size plus the value's JSON size, a `Uint8Array` by its length (Figma's rule).
  - Calls `plugins:storage {op: get | set | delete | keys, pluginId, key?, value?}`.
  - Writes are atomic (temp + rename).
- **IPC channels** (`src/shared/ipc.ts`, committed before the round), editor views only:
  - `plugins:list-development`, `plugins:import-manifest`, `plugins:remove-development`, `plugins:read`
  - `plugins:open-ui`, `plugins:close-ui`, `plugins:fetch`, `plugins:storage`
  - `plugins:changed` (event), `plugins:open-console`
  - "Open console" = the view's devtools, development plugins only.

### 3.4 As built — main (5e, 2026-10-11, branch `worktree-agent-a80cb44f954b9e7d1`)

**Where**: `src/main/plugins/` — `manifest.ts` (main's `parseManifest`), `network.ts` (the `allowedDomains` rules and the CSP), `manifests.ts` (development plugins), `watch.ts`, `runs.ts`, `protocol.ts`, `fetch.ts`, `storage.ts`, `templates/`, `index.ts` (the wiring); `src/main/devmodeLinks.ts`. Tests: `src/main/plugins/plugins.test.ts` (24), `src/main/devmodeLinks.test.ts` (4).

**Changes to §3.3's channels** (`src/shared/ipc.ts`; `window.designer.plugins` / `window.designer.devMode` in `src/shared/desktop.ts` `PluginsDesktopApi`, one method per channel):
- **New `plugins:begin-run {runId, allowedDomains, devAllowedDomains?, dev}`** and **`plugins:end-run {runId}`**. A run without a UI still fetches, so main needs its network rules before any `showUI`. `open-ui` also registers the run when `begin-run` wasn't called.
- **`plugins:open-ui`** gains `devAllowedDomains?` (counted when `dev`).
- **New `plugins:new-plugin {name, template}`** → `{plugin, manifest, editorType} | {cancelled}`. `template` is `default`, `run-once`, `custom-ui`, `inspect` or `codegen`.
- **Run ids** are the host of `plugin://<runId>/`, and a standard scheme lower-cases hosts. So an id is `[a-z0-9][a-z0-9-]{0,62}`; a UUID fits.
- **Ownership**: the view that registers a run owns it. Another view's `fetch` / `open-ui` / `close-ui` with that id is refused. A view's reload or close ends its runs.

**Manifests** (`manifest.ts`, `manifests.ts`):
- §4's fields, each checked and copied. Anything else is dropped.
- Refused: widget manifests ("Widgets aren't supported in DesignerV2 yet"); `main` / `ui` paths that are absolute or contain `..`; domains that aren't Figma's forms (an entry is a CSP source, so `;` `,` spaces and quotes are never accepted); `"none"` beside other entries; `codegen` without `codegenLanguages`.
- `*` and localhost without `reasoning` give a console warning.
- **The development list**: `userData/plugins/development.json` `{path, id, name, addedAt}[]`, written temp + rename.
  - The id is the manifest's `id`, else `dev:<sha1(path)>`.
  - Re-importing the same path or id replaces the entry and keeps its `addedAt`.
  - Import checks that the files are readable.
- **`read`**:
  - Re-reads the manifest. Each file is resolved with `realpath` and must stay inside the folder's `realpath` (a symlink out is refused). Each file ≤ 20 MB.
  - `ui` → `{"": html}`, or the map's keys.
  - The listed id is kept even if the manifest's id changed since the import.
- `build` is kept and never run.
- **Duplicate rules**: resolved by 5d — main's pure copies moved to `src/shared/plugins/manifest.ts` / `network.ts` (the editor's helpers added on top; `toCspSources(entries)` is now `cspSourcesOf`), main imports them (§5a).

**Network rules** (`network.ts`):
- A scheme-less entry means `https` + `wss` (the CSP rule on an https page, which Figma's iframes are).
- `*.x` covers subdomains, not `x` itself. A port defaults to the scheme's.
- A path ending in `/` is a prefix; any other path is exact (the query is ignored).
- `*` → `https:` + `wss:`. `none` → nothing, so `["none"]` gives `connect-src 'none'`.
- `devAllowedDomains` is added only when `dev`.
- **CSP sources** are written with their scheme, because the document's own scheme is `plugin:` and a scheme-less source would match only `plugin:` URLs.

**The `plugin:` scheme** (`protocol.ts`):
- **Registration**: in the same `registerSchemesAsPrivileged` call as `app` (`src/main/protocol.ts`; a second call would replace the first), with `standard`, `secure`, `supportFetchAPI` and `corsEnabled`. `index.ts` has one line: `handlePluginScheme()` after `handleScheme()`.
- **What it serves**: only `GET` / `HEAD` of `/ui.html` of a run whose UI is open. Headers: §3.2's CSP, COEP `credentialless`, CORP `cross-origin`, `nosniff`, `no-referrer`, `no-store`.
- **The editor's CSP**: `frame-src plugin:`.
- **Frame navigation**: `views.ts`'s `harden` calls `guardPluginFrames`. A subframe may load:
  - `plugin://<one of the view's runs>/ui.html`;
  - `https:` URLs one of the view's runs allows;
  - `about:blank` / `about:srcdoc`.
  Anything else is cancelled. `window.open` already goes to the browser.
- **The developer VM's `worker.js`** (§3.3) isn't served. A dedicated Worker must be same-origin with the page that creates it, so `plugin:` can't host the editor's worker. 5d builds it from the app's own files or a blob.

**`fetch`** (`fetch.ts`):
- `net.fetch` / Node `fetch` through `mainFetch`, with `credentials: "omit"`.
- Redirects are followed by hand (`redirect: "manual"`, ≤ 20), and every hop is checked against the run's rules. A refused hop throws §3.3's text with that hop's URL.
- 303, and 301 / 302 after a POST, become a GET without a body. `Authorization` is dropped when a redirect goes to another origin.
- Forbidden request headers are dropped (`cookie`, `host`, `origin`, `referer`, `sec-*`, `proxy-*` …). `set-cookie` never comes back.
- 30 s for the whole request, ≤ 20 MB each way.

**`clientStorage`** (`storage.ts`):
- `userData/plugins/storage/<pluginId>.json`. An id that isn't `[A-Za-z0-9_-]{1,100}` (such as `dev:…`) is stored as `h-<sha1>.json`.
- **Size**: key length + the value's JSON length, and a `Uint8Array` by its byte length (nested inside objects too). A write past 5 MB throws "clientStorage is full: a plugin may store at most 5 MB" (wording ours).
- `Uint8Array`s are kept as `{"$bytes": base64}`. A literal `$bytes` key is escaped.
- `undefined` can't be stored; `get` of a missing key answers `undefined`.
- Calls are serial per plugin. Writes are temp + rename, and an empty store deletes its file.

**Hot reload** (`watch.ts`):
- `fs.watch(folder, {recursive})` per listed development plugin, filtered to `manifest.json`, `main` and the `ui` files.
- Debounced 300 ms, then `plugins:changed {id}` goes to every editor view. The watches follow the list (list, import, remove).
- The "Hot reload plugin" check item is the editor's: its host ignores the event when the item is off.

**New plugin…** (`templates/`, `index.ts newPlugin`):
- Five templates: `default` (5 rectangles, closes), `run-once` (a closing message), `custom-ui` (a count field, `postMessage` both ways), `inspect` (Dev Mode, selection details) and `codegen` (Dev Mode, CSS).
- Each manifest has a random 19-digit `id`, `api` "1.0.0", `editorType`, `documentAccess: "dynamic-page"` and `networkAccess: {allowedDomains: ["none"]}`.
- The code is ours, in the shape of Figma's samples.
- Main's Save dialog names a new folder (one that exists must be empty, apart from `.DS_Store`). The files are written with `wx`, and the plugin is imported.

**Open console**: `sender.openDevTools({mode: "detach"})`.

**`devmode:link-title`** (`devmodeLinks.ts`, editor.md D-3):
- `https:` only, also at every redirect (≤ 5).
- Hosts that are this computer or the local network are refused by their written form: localhost, `*.local`, loopback, private, link-local, CGNAT, ULA, v4-mapped. A DNS name that resolves to one of them isn't caught.
- No cookies, 5 s.
- Only `text/html` / `xhtml` with a 2xx status. At most 512 kB is read, stopping at `</title>`.
- The charset comes from the header or a `<meta>`. Entities are decoded, space is collapsed, and the title is cut at 300 characters.
- Anything else answers `null`.

**Verified**:
- `npm run check`: 205 files, 1732 tests.
- The built app driven with `scripts/drive.mjs`. In a new file's editor, `designer.plugins.openUi` + an `<iframe sandbox="allow-scripts">` loaded `plugin://e2e-run-1/ui.html` inside the cross-origin-isolated editor. Inside the frame:
  - `origin` was `"null"`;
  - `localStorage` threw;
  - `parent.document` was refused;
  - the frame's `fetch('https://example.com/')` was blocked by `connect-src 'none'`.
- In the same run:
  - `plugins:fetch` to the same URL answered the refusal text;
  - a run id the view doesn't own was refused;
  - a `clientStorage` set / get round-tripped `{n, Uint8Array}`;
  - `devMode.linkTitle("http://127.0.0.1/")` answered `null`.

**Not built**:
- `worker.js` (see above).
- The dev server's CSP: there is none to change (`vite.shared.ts` sets no CSP).
- A positive `fetch` and a plugin UI loading a COEP-less outside picture weren't run against the live network.
- The import dialog and Save dialog flows were only exercised through unit tests of what they call.

## 4. The manifest (`src/shared/plugins/manifest.ts`)

Figma's fields [P-man], parsed and checked by `parseManifest(json, {development})` → `{manifest} | {errors: string[]}`:

| Field | Ours |
|---|---|
| `name`, `id`, `api`, `main` | required. `id` for development plugins: any string (Figma assigns ids on publish; a manifest without one gets `dev:<sha1(path)>`). `api` is kept and shown (we implement "1.0.0") |
| `ui` | a string → `__html__`; a map → `__uiFiles__` |
| `editorType` | `figma` and / or `dev` are run; `figjam`, `slides`, `buzz` are accepted and ignored (set aside, roadmap Phase 7). A manifest with neither `figma` nor `dev` is listed disabled: "This plugin doesn't run in Figma Design or Dev Mode" |
| `documentAccess` | `"dynamic-page"` or absent (decision 7) |
| `networkAccess` | `{allowedDomains (≥ 1), reasoning?, devAllowedDomains?}` with Figma's rules: `"*"` and localhost need `reasoning` (a warning in the console when missing, not an error — ours) |
| `parameters`, `parameterOnly` | Figma's Quick Actions parameters: the Actions panel prompts as Figma (§6) |
| `menu` | nested items, separators, `command` → `figma.command` |
| `relaunchButtons` | shown in the Design panel's header for selected nodes with `setRelaunchData` (§8), Figma's buttons |
| `permissions` | `currentuser` (`figma.currentUser`: name, id, photo from the account; `null` signed out), `activeusers` / `fileusers` (multiplayer peers from presence), `teamlibrary` (`figma.teamLibrary` over the enabled libraries), `payments` (refused: no payments) |
| `capabilities` | `inspect`, `codegen` (§7); `textreview`, `vscode` ignored |
| `codegenLanguages`, `codegenPreferences` | §7 |
| `enableProposedApi`, `enablePrivatePluginApi` | the second gives `figma.fileKey` (the room key or the local key) and `figma.devResources` (Figma's private partner API) |
| `build`, `containsWidget`, `widgetApi` | `build` ignored (§3.3); widget manifests rejected until §11 |

## 5. The `figma.*` API — round 5's subset (by Figma's typings, `@figma/plugin-typings`)

**Implemented in round 5.** Names, signatures, errors and coercion are Figma's.

**Global properties and calls:**
- `figma.apiVersion`, `command`, `pluginId`, `editorType` (`"figma"` | `"dev"`), `mode` (`"default"` | `"inspect"` | `"codegen"`), `fileKey` (private API).
- `root`, `currentPage`, `setCurrentPageAsync`, `skipInvisibleInstanceChildren`, `hasMissingFont`, `currentUser`, `activeUsers`.
- `closePlugin`, `notify(message, {timeout, error, button: {text, action}, onDequeue})` → `NotificationHandler`, `commitUndo`, `triggerUndo`, `saveVersionHistoryAsync(title, description)` (a named version), `openExternal`.
- `showUI`, `figma.ui.*` (§3.2).
- `getNodeByIdAsync`, and `getNodeById` (throws under dynamic-page).
- `loadAllPagesAsync`, `getFileThumbnailNodeAsync`, `getSelectionColors`, `mixed`, `base64Encode` / `base64Decode`.
- `fetch`: Figma's `FetchOptions` / `FetchResponse` (`text()`, `json()`, `arrayBuffer()` → `Uint8Array`), through main (decision 4).

**Creating nodes:**
- `createRectangle`, `createLine`, `createEllipse`, `createPolygon`, `createStar`, `createVector`, `createText`, `createFrame`, `createComponent`, `createComponentFromNode`, `createPage`, `createSection`, `createSlice`, `createNodeFromSvg` (the vector import of `src/shared/vectorImport`), `createImage(bytes)`, `createImageAsync(url)` (through `fetch`), `getImageByHash`.
- `combineAsVariants`, `group`, `ungroup`, `flatten`, `union` / `subtract` / `intersect` / `exclude`.

**Nodes** — the mixins of Figma's typings for the types we have:

| Area | Members |
|---|---|
| Base | `id`, `parent`, `name`, `removed`, `remove()`, `toString()`, `getPluginData` / `setPluginData` / `getPluginDataKeys`, `getSharedPluginData` / `setSharedPluginData` / `getSharedPluginDataKeys`, `setRelaunchData` / `getRelaunchData`, `isAsset`, `getCSSAsync` (the viewer's CSS, `src/viewer/inspect/css.ts`), `getTopLevelFrame`, `type` |
| Scene | `visible`, `locked`, `stuckNodes` (empty), `componentPropertyReferences`, `boundVariables`, `setBoundVariable`, `resolvedVariableModes`, `explicitVariableModes`, `setExplicitVariableModeForCollection`, `clearExplicitVariableModeForCollection` |
| Children | `children`, `appendChild`, `insertChild`, `findChildren`, `findChild`, `findAll`, `findOne`, `findAllWithCriteria`, `findWidgetNodesByWidgetId` (empty) |
| Layout | `x`, `y`, `width`, `height`, `minWidth` / `maxWidth` / `minHeight` / `maxHeight`, `relativeTransform`, `absoluteTransform`, `absoluteBoundingBox`, `absoluteRenderBounds`, `rotation`, `resize`, `resizeWithoutConstraints`, `rescale`, `constraints`, `layoutAlign`, `layoutGrow`, `layoutPositioning`, `layoutSizingHorizontal` / `Vertical` |
| Auto layout and grid | `layoutMode`, `layoutWrap`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `counterAxisAlignContent`, `paddingLeft` / `Right` / `Top` / `Bottom`, `itemSpacing`, `counterAxisSpacing`, `itemReverseZIndex`, `strokesIncludedInLayout`; grid `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridRowSizes` / `gridColumnSizes`, `setGridChildPosition` |
| Frames | `clipsContent`, `layoutGrids`, `gridStyleId`, `guides`, `expanded` |
| Look | `fills`, `strokes`, `strokeWeight`, `strokeAlign`, `strokeCap`, `strokeJoin`, `strokeMiterLimit`, `dashPattern`, `strokeTopWeight` …, `cornerRadius`, `topLeftRadius` …, `cornerSmoothing`, `opacity`, `blendMode`, `isMask`, `maskType`, `effects`, `fillStyleId` / `strokeStyleId` / `effectStyleId` and their `setFillStyleIdAsync` … forms, `exportSettings`, `exportAsync(settings)` (`PNG` / `JPG` / `SVG` / `PDF` / `JSON_REST_V1` — the last one is §16.6's `fileJson.ts`, shared with 5b) |
| Vectors | `vectorNetwork` / `setVectorNetworkAsync`, `vectorPaths`, `handleMirroring`, `fillGeometry`, `strokeGeometry`, `outlineStroke` |
| Text | `characters`, `fontName`, `fontSize`, `fontWeight`, `textCase`, `textDecoration`, `letterSpacing`, `lineHeight`, `paragraphSpacing`, `paragraphIndent`, `listSpacing`, `textAlignHorizontal` / `Vertical`, `textAutoResize`, `textTruncation`, `maxLines`, `hyperlink`, `textStyleId`, `insertCharacters`, `deleteCharacters`, `getRangeFontName` … the `getRange*` / `setRange*` family (fontName, fontSize, fills, textCase, textDecoration, letterSpacing, lineHeight, hyperlink, listOptions, indentation, textStyleId, boundVariable), `getStyledTextSegments` |
| Components | `ComponentNode`: `createInstance`, `key`, `description`, `descriptionMarkdown`, `documentationLinks`, `remote`, `componentPropertyDefinitions`, `addComponentProperty`, `editComponentProperty`, `deleteComponentProperty`, `getInstancesAsync`; `ComponentSetNode`: `defaultVariant`, `variantGroupProperties`; `InstanceNode`: `getMainComponentAsync`, `swapComponent`, `componentProperties`, `setProperties`, `detachInstance`, `removeOverrides` (and its deprecated alias `resetOverrides`: every override, the property values kept, as Figma), `overrides`, `exposedInstances`, `isExposedInstance`; `FrameNode`: `detachedInfo` (null on instances and components; `library` by the asset's key, else `local`) |
| Pages and document | `PageNode`: `selection`, `selectedTextRange`, `flowStartingPoints`, `backgrounds`, `prototypeBackgrounds`, `loadAsync`, `children`; `DocumentNode`: `children`, `documentColorProfile` |
| Prototyping | `reactions` / `setReactionsAsync` (Figma's Reaction `{action, actions, trigger}`, converted both ways by the agents' `agents/prototypeSpec.ts` — shapes in `src/shared/agents/prototypeSchema.ts`; Figma's Plugin writer rules: the side swapped LEFT ↔ RIGHT / TOP ↔ BOTTOM for every directional transition, so `{MOVE_OUT, LEFT}` is stored `MOVE_OUT_TO_RIGHT`; EASE_IN written as EASE_IN 15; custom bezier x clamped to 0–1, custom spring mass / stiffness / damping clamped and v₀ 0; mouse delays in `interactionMaintained` / `interactionDuration`; `stateManagementVersion` 1. The Prototype panel keeps its own arrows until a probe shows how Figma's panel draws `MOVE_OUT_TO_LEFT`, `docs/research/rea/motion.md` §5.9), `overflowDirection`, `scrollBehavior`, `overlayPositionType`, `overlayBackground`, `overlayBackgroundInteraction` |
| Dev Mode | `devStatus` (`{type: "READY_FOR_DEV" \| "COMPLETED", description?}` \| null, over `sectionStatusInfo`), `annotations` (over the document's annotations), `figma.annotations.getAnnotationCategoriesAsync` / `addAnnotationCategoryAsync` / `getAnnotationCategoryByIdAsync` |

**Areas:**
- **Viewport**: `figma.viewport.center`, `zoom`, `bounds`, `scrollAndZoomIntoView`.
- **Client storage**: `figma.clientStorage.getAsync` / `setAsync` / `deleteAsync` / `keysAsync`.
- **Fonts**: `loadFontAsync` (the editor's font loading, `editor/openFonts.ts`), `listAvailableFontsAsync`.
- **Styles**:
  - `getStyleByIdAsync`, `getLocalPaintStylesAsync` / `Text…` / `Effect…` / `Grid…`;
  - `createPaintStyle` / `createTextStyle` / `createEffectStyle` / `createGridStyle`;
  - `moveLocalPaintStyleAfter` …;
  - `importStyleByKeyAsync`, `importComponentByKeyAsync`, `importComponentSetByKeyAsync`, `importVariableByKeyAsync` (the libraries the file can use, data.md §9 / §16).
- **Variables**:
  - `figma.variables.getVariableByIdAsync`, `getVariableCollectionByIdAsync`, `getLocalVariablesAsync`, `getLocalVariableCollectionsAsync`;
  - `createVariable`, `createVariableCollection`, `extendLibraryCollectionByKeyAsync`;
  - `createVariableAlias`, `createVariableAliasByIdAsync`, `setBoundVariableForPaint` / `Effect` / `LayoutGrid`;
  - the `Variable` and `VariableCollection` objects (`setValueForMode`, `addMode`, `renameMode`, `removeMode`, `remove`, extended-collection overrides).
- **Team library**: `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync`, `getVariablesInLibraryCollectionAsync`.
- **Utilities**: `figma.util.rgb`, `rgba`, `solidPaint`, `normalizeMarkdown`.
- **Constants**: `figma.constants.colors`.
- **Events**: `figma.on` / `once` / `off` for `run`, `close`, `selectionchange`, `currentpagechange`, `documentchange`, `drop`, `stylechange`.
- **Parameters**: `figma.parameters.on('input', ({query, key, parameters, result}) => result.setSuggestions(...) | setError | setLoadingMessage)`.
- **Codegen**: `figma.codegen.on('generate' | 'preferenceschange')`, `preferences`, `refresh` (§7).
- **Dev resources**: `figma.devResources` (private API) and the node methods `getDevResourcesAsync`, `addDevResourceAsync`, `editDevResourceAsync`, `deleteDevResourceAsync` (docs/editor.md D-3).

**Later (not round 5; each throws `"‹name› is not supported in DesignerV2 yet"`):**
- `figma.payments`, `figma.timer`, `figma.buzz`, `figma.textreview`, `figma.vscode`, `figma.motion`.
- `createNodeFromJSXAsync`, `createVideoAsync`. (`createTextPath`, `transformGroup`, `loadBrushesAsync`: §5b, round 7e.)
- FigJam and Slides creators (`createSticky`, `createConnector`, `createShapeWithText`, `createTable`, `createSlide` …).
- `figma.widget`.
- `figma.on('slidesviewchange' | 'canvasviewchange' | 'textreview')`.
- `PageDivider`. (`TransformGroupNode`, `TextPathNode`: §5b.)

**Typings**: `src/shared/plugins/api.d.ts` is **not ours to write**. The test fixtures use the published `@figma/plugin-typings` (dev dependency, exact pin) to type-check the sample plugins, so the API's shape is Figma's by construction.

**Test plugins** (`src/renderer/src/editor/plugins/__tests__/fixtures/`):
- `rectangles` (Figma's "Default" template);
- `run-once` (the "Run once" template);
- `custom-ui` (the template with UI, `postMessage` both ways);
- `selection-colors`;
- `rename-layers`;
- `codegen-css` (a Dev Mode codegen);
- `network` (fetch allowed and refused);
- `storage`;
- `dynamic-page` (deprecated sync APIs throw);
- `parameters`;
- `relaunch`.

## 5a. As built — the host (5d, 2026-10-11)

**Where**: `src/renderer/src/editor/plugins/` — `host.ts` (`PluginRun`), `service.ts` (`PluginService`, one per editor: `attachPlugins` / `pluginsOf` / `usePluginService`), `vm/` (`types.ts`, `quickjs.ts`, `devWorker.ts`, `devWorker.worker.ts`), `runtime/` (`bridge.js`, `figma.js` — the VM-side scripts, imported `?raw`), `api/` (`codec.ts`, `context.ts`, `convert.ts`, `nodes.ts`, `document.ts`, `sha1.ts`), `menus.ts`, `actions.ts`, `desktop.ts`, `ui/` (`store.ts`, `PluginLayer.tsx`, `NewPluginDialog.tsx`), `index.ts` (`createSandbox`). Shared: `src/shared/plugins/manifest.ts` and `network.ts` — **one copy for main and the editor** (main's 5e copies moved here; main imports them). Chrome: `panels/ActionsPanel.tsx` (+ `panels/actionsTab.ts`), `panels/LeftPanel.tsx` (Tools), `panels/design/RelaunchButtons.tsx`, `menus.ts` / `commands.ts`, `EditorApp.tsx` (`<PluginLayer />`).

**Packages** (exact): `quickjs-emscripten-core` 0.32.0 + `@jitl/quickjs-wasmfile-release-asyncify` 0.32.0 (the newest ≥ 2 weeks old; 2026-02-16); dev `@figma/plugin-typings` 1.139.0 (2026-09-23; 1.140/1.141 were too new). The view loads QuickJS's `.wasm` from the URL Vite gives it (`…/wasm?url` + `newVariant`): Vite's dependency step moves the module's JS away from the file it looks for (the browser got index.html); tests in Node read it from the package.

**The VM bridge** (both VMs, one protocol):
- The VM gets one host function, `__hostCall(op, json) → json`; `bridge.js` takes it off the global and builds `call(op, …args)`. Values are JSON; a `Uint8Array` is `{$u8: base64}`, `figma.mixed` `{$mixed: 1}`, a node `{$node, $type}`. An answer is `{ok}` | `{err}` | `{async: id}` (a promise in the VM, settled later through `__settle`).
- `figma.js` builds `figma` over it: node handles are frozen `{__nodeId, __type}` objects whose prototype is built per type from Figma's mixins (so `"children" in node`, `node.fills = …`, `===` between handles work); every property is `get` / `set` on the host. Values read are frozen (sloppy-mode writes to them are silent, strict-mode ones throw — as Figma's).
- Timers (`setTimeout` / `setInterval`), `console`, `structuredClone` are the bridge's; `fetch` is `figma.fetch`.
- **Host functions** (`host.ts makeOps`, `api/*.ts`): node properties go through the agents' layer properties (`agents/nodeSpec.ts readProps / fieldsOf`) where the shapes are the Plugin API's (layoutMode, itemSpacing, padding*, sizing, constraints, layoutSizing* …); paints, effects, layout guides, transforms, line height, letter spacing, font names, corner radii (MIXED), plugin data and the rest are converted in `api/convert.ts` / `api/nodes.ts`.

**Undo and slices** (decision 6), engine additions (the round's only engine change besides the schema):
- `engine_txn_begin_run(label, join)` (`Editor::txnBeginRun`): a USER transaction whose step a later slice may **join** while nothing else entered the user's history since (the undo count and the label must match; an undo, redo or another edit splits). Each write host call opens the run's slice lazily (`ctx.write()`), committed at the end of the task; `figma.commitUndo()` makes the next slice not join; `triggerUndo()` commits and undoes. A run is one undo step labelled with the plugin's name (native test `scene.txn.test.cpp`, wasm test `plugins.wasm.test.ts`).
- A slice starts only when the engine is idle (no drag, scrub or actor write: `engine.idle()`, polled every 30 ms) — no asyncify suspension is needed: JS is single-threaded, so the user can't start a drag inside a slice. The asyncify build is used as the contract pins it.
- `engine_set_style_range(from, to)` (`Editor::setStyleRange`): run fields that `set_props` writes go to UTF-16 [from, to) of a text that isn't being edited — `setRange*` (native test `text.edit.test.cpp`).

**Limits** (decision 1): 256 MB heap, 1 MB stack, an interrupt handler. **Deviation**: QuickJS runs on the main thread, so nothing — not the toast's Stop — can be clicked while a slice runs; a slice past **20 s** is interrupted (the run ends: "‹name› took too long and was stopped"). Stop ends a run between slices (timers, UI messages) at once. Templates (`createSandbox`) default to 5 s.

**The developer VM** (decision 2): `DevWorkerVm` + `devWorker.worker.ts`, built from the app's own files (`new URL(…, import.meta.url)`, same-origin; 5e's `plugin:` can't host it). The worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `Worker`, `SharedWorker`, `indexedDB`, `caches`, `WebTransport`, `BroadcastChannel`, `navigator` before the plugin's code; host calls block on `Atomics.wait` over a 1 MB `SharedArrayBuffer`, longer answers in chunks. **Deviation**: the worker script has no `connect-src 'none'` CSP of its own (the app's files carry none); the deleted globals are the guard. Development plugins only, "Use developer VM" checked. A write while the engine is busy throws there (the worker can't be paused): "The document is busy…".

**The UI**: `PluginLayer` draws each run's window (ds floating panel, title bar with ✕, draggable, position kept per plugin in localStorage) with `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" src="plugin://<runId>/ui.html">` (desktop, `plugins:open-ui`) or `srcdoc` with the CSP meta first (browser build, and the desktop's fallback when `open-ui` fails). Messages only from that iframe's `contentWindow`; `{pluginMessage}` unwrapped; queued until `load`; out with `"*"` (opaque origin). `themeColors` injects this theme's `--figma-color-*` values and `figma-light|dark` on `<html>`. "Running ‹name›" (ds `Toast`, ✕ = Stop) while a run has no visible UI. `figma.notify` → the ds toast (`button`, `timeout`, `onDequeue` "timeout" / "dismiss").

**Main** (5e's channels): every run calls `plugins:begin-run {runId, allowedDomains, devAllowedDomains?, dev}` and `end-run` at its end; run ids are `run-<base36 time>-<n>` (lower case). `fetch` is checked in the editor first (`allowedUrl`, Figma's refusal text) and again by main; without main (browser) plugin code can't fetch ("Network access from plugin code needs the desktop app"). `clientStorage` through main; in the browser, per view in memory. Hot reload restarts a running development plugin with the same command (ignored when "Hot reload plugin" is off).

**The chrome**:
- Figma menu › **Plugins ▸**: Run last plugin ⌥⌘P, Saved plugins ▸, the plugins run here (recents, each with its manifest `menu` as a submenu), Development ▸ (New plugin…, Import new plugin from manifest…, the development plugins, Hot reload plugin ✓, Use developer VM ✓, Open console), From ‹org› ▸ (private plugins), Manage plugins… (Actions on Plugins & widgets). The canvas menu's Plugins ▸ has the run section and Development. Widgets stay disabled (§11). Row ids `plugin:<source>:<id>:<command>` (`runPluginMenuItem`).
- **New plugin…**: "Create a plugin" (Figma design / Dev Mode, name, template), Save as → `plugins:new-plugin`.
- **Actions › Plugins & widgets**: Recents, Saved, Development, From ‹org›; search finds plugins and their menu commands (also in All); ⋯ = Save / Remove from saved, Open console, Remove. **Parameters**: the run starts with `awaitParameters` (`figma.on("run")` waits), the palette asks each parameter with `figma.parameters.on("input")`'s suggestions / error / loading message, Tab / Enter to the next, Enter on the last → `submitParameters`; Esc stops the run.
- **Tools tab**: the plugins by Source (Development, Your organization) with the type filter (Widgets / Shaders list none); Create = New plugin….
- **Relaunch buttons** (`RelaunchButtons`) under the Design panel's header for the selection (several layers: `multipleSelection` commands they all have), and with nothing selected the page's and the document's.
- Saved / recents through `store.plugins` (5g) with a localStorage fallback; approval through `store.plugins.allowed` before a bundle is read (refused: "Your organization only allows approved plugins"). "Loading n pages" (parity) for a manifest without `documentAccess` on a file of more than one page.

**The API** — built: the globals and calls of §5 (`closePlugin`, `notify`, `commitUndo` / `triggerUndo`, `saveVersionHistoryAsync` (when the editor gives a saver), `openExternal`, `showUI` / `figma.ui.*`, `getNodeById(Async)` with dynamic-page errors, `currentPage` / `setCurrentPageAsync`, `loadAllPagesAsync`, `getSelectionColors`, `base64*`, `fetch`), creating (rectangle … slice, page, component from node, SVG, images (`createImage` hashes synchronously with SHA-1, `createImageAsync` via fetch)), `group` / `ungroup` / `flatten` / boolean ops / `combineAsVariants`, node properties and methods (base, scene, children, layout incl. `resize` / `rescale`, blend, geometry, corners, frames and auto layout, text incl. `insertCharacters` / `deleteCharacters` / `getRange*` / `setRange*` for font name, size, fills, case, decoration, letter spacing, line height, hyperlink, `getStyledTextSegments`, components and instances (properties, `createInstance`, `swapComponent`, `setProperties`, `detachInstance`, `resetOverrides`), pages, `exportAsync` (PNG / JPG / SVG / SVG_STRING / PDF), `getCSSAsync`, `devStatus`, `annotations`, `reactions`), plugin data and relaunch data, viewport, clientStorage, fonts (`loadFontAsync` resolves — the engine asks for fonts itself; `listAvailableFontsAsync` = the file's fonts and Inter), styles (local lists, create, name / description / paints / font size and name), variables (local lists, create, values per mode, rename, scopes, code syntax, modes, `setBoundVariable`, aliases, `setBoundVariableFor*`), utilities, events (`run`, `close`, `selectionchange`, `currentpagechange`, `documentchange` with Figma's `DocumentChange` list, `drop`), parameters, codegen (`generate` with Figma's 3 s), `figma.currentUser` (with the permission), the "later" list throwing "… is not supported in DesignerV2 yet".
- **Not built yet** (each throws or answers empty, Figma's shape): `import*ByKeyAsync`, `teamLibrary` (empty lists), `extendLibraryCollectionByKeyAsync`, annotation categories (empty), `figma.devResources` and the node dev-resource methods, `exportAsync` `JSON_REST_V1` (5b's `fileJson.ts`), `vectorNetwork` / `vectorPaths` / `fillGeometry` / `strokeGeometry` (empty), `setGridChildPosition`, range `listOptions` / `indentation` / style ids / bound variables (read only, defaults), codegen preferences UI (5f), Dev Mode's Plugins panel (5f), `stylechange`. Fonts: `characters =` doesn't refuse an unloaded font (the engine loads it).

**Tests**: `plugins/__tests__/plugins.wasm.test.ts` (20: the §5 fixtures — rectangles, run-once, custom-ui, selection-colors, rename-layers, codegen-css, network, storage, dynamic-page, parameters, relaunch — on the wasm engine; the sandbox's escapes; the slice limit and Stop; errors; documentchange / selectionchange; export, text ranges, group, clone, components; `createSandbox`), `service.wasm.test.ts` (5), `devWorker.test.ts` (2), `src/shared/plugins/plugins.test.ts` (7), main's `plugins.test.ts` on the shared rules. The fixtures' `code.js` are type-checked against `@figma/plugin-typings` (`npm run typecheck` runs `__tests__/fixtures/tsconfig.json`). Verified in a browser (`vite --config vite.web.config.ts`, `?editor`): the Custom UI round trip (rectangles made, the answer shown in the iframe, the iframe's `fetch` blocked by its CSP), the run as one undo step, the Running toast's Stop, the Plugins menu, Actions' plugin rows and the parameters prompt end to end, relaunch buttons and a relaunched run. Not verified: the desktop app with real development plugins (`plugin:` iframe, main's fetch), the developer VM in Electron.

## 5b. Draw (round 7e, 2026-10-12; docs/draw.md §7)

Figma's Update 123 (2026-01-26) as `@figma/plugin-typings` 1.139.0 types it. **Where**: `editor/plugins/api/draw.ts` (the host side), `runtime/figma.js` (the shapes), the readers shared with REST and Dev Mode in `src/shared/draw/apiShapes.ts`.

**Node types.** The engine's `TEXT_PATH` (41) is the API's `TEXT_PATH`; its `TRANSFORM` (48) is `TRANSFORM_GROUP` (`api/convert.ts apiType`, so `findAllWithCriteria({types})` and handles see them).
- **`TextPathNode`**: Figma's text subset (`characters`, `fontName`, `fontSize`, `fontWeight`, `textCase`, `letterSpacing`, `hyperlink`, `textStyleId`, `textAlignHorizontal` LEFT / CENTER / RIGHT / JUSTIFIED, `textAlignVertical`, `autoRename`, `insertCharacters` / `deleteCharacters`, the `getRange*` / `setRange*` of that subset, `getStyledTextSegments`), read-only `vectorPaths` / `vectorNetwork` / `handleMirroring`, and **`textPathStartData`** `{segment, position}` — read from `textPathStart.tValue` (segment + position, docs/draw.md §4.4 [unverified encoding]); written with `SET_TEXT_PATH_START`. No auto resize, line height or paragraph properties.
- **`TransformGroupNode`**: a group's mixins plus **`transformModifiers`**: the document's REPEAT modifiers as `{type: "REPEAT", count, unitType, offset, repeatType, axis?}` (LINEAR `axis` HORIZONTAL ↔ X, VERTICAL ↔ Y; `offset` = `offset.x`). Setting it writes the field directly (one step of the run, any engine): the REPEATs are replaced, SYMMETRY / SKEW a file holds are kept after them.

**`ComplexStrokesMixin`** on every node with geometry:
- **`complexStrokeProperties`**: read from the document's implicit kind (§4.3) — `{type: "BASIC"}`; `{type: "DYNAMIC", frequency, wiggle, smoothen}`; `{type: "BRUSH", brushType: "STRETCH", brushName, direction}` or `{type: "BRUSH", brushType: "SCATTER", brushName, gap, wiggle, sizeJitter, angularJitter, rotation}`. `brushName` is the BRUSH node's built-in key (its display name and type), else `"CUSTOM"`. Writing: BASIC / DYNAMIC → `SET_STROKE_KIND`; BRUSH → `SET_STROKE_BRUSH` with the installed built-in (`engine.listBrushes()` by name and type), then `SET_BRUSH_SETTINGS`. Figma's rules: `"CUSTOM"` throws "Setting a custom brush is not supported yet"; an unloaded brush throws "The brush ‹NAME› isn't loaded: call figma.loadBrushesAsync('‹TYPE›') first" [wording ours]; ranges as the typings (frequency 0.01–20, smoothen 0–1, sizeJitter 0–3, angular jitter and rotation −180…180) throw outside them; wiggle and gap have no upper bound in Figma's, so ours are clamped (`SCATTER_RANGE` / `DYNAMIC_RANGE`).
- **`variableWidthStrokeProperties`** (Figma's shape, live — `docs/research/rea/vector.md` §3): `{widthProfile, variableWidthPoints: [{position, width}]}` for every stroke kind, the points given for presets too; `width` = the point's ascent (0.5 = half the weight on each side); a reversed preset (Flip) reads as that preset. Writing a preset or custom points (`ascent = descent = width`; CUSTOM needs at least one point) goes through `SET_WIDTH_PROFILE {plugin: true}`; only a complex (branching) network is refused ("Cannot set variableWidthStrokeProperties on complex vector nodes") (an instance's sublayer is written as an override; a library copy is read-only) — dynamic, brush and dashed strokes take and keep the points. `transformModifiers` counts are integers 2…40 (Figma's zod messages, e.g. "Number must be less than or equal to 40 at [0].count"); `dashPattern` holds at most 8 positive entries ("A maximum of 8 dash patterns is supported"), `strokeMiterLimit` 1–16.
- **`setFillsAsync` / `setStrokesAsync`**: Figma's way to set pattern fills and strokes (the PATTERN paint of round 7, §5's `paintFromApi`).

**`figma.*`**:
- **`createTextPath(node, startSegment, startPosition)`**: a vector, rectangle, ellipse, polygon, star or line; `CREATE_TEXT_PATH {replace: true}` — the source goes, the TEXT_PATH takes its name, parent and index (found in the parent's children at the source's index); the returned node is the one to use, as Figma says.
- **`transformGroup(nodes, parent, index, modifiers)`**: `ADD_TRANSFORM_MODIFIER` on the nodes (wraps them as Group does), then the whole list written to the group in order [Figma's "each to the node at the same position" read as a slip, docs/draw.md §4.2], then moved to `parent` / `index`.
- **`loadBrushesAsync('STRETCH' | 'SCATTER')`**: installs every built-in of that type (`engine.installBrush` with our artwork, `src/shared/draw/brushes/`), inside the run's step.

**Until round 7b** the engine's Draw calls are Engine.ts stubs: `createTextPath`, `transformGroup`, `loadBrushesAsync`, `textPathStartData =` and `complexStrokeProperties =` answer "‹name› is not supported in DesignerV2 yet"; every reader, `transformModifiers =` and `variableWidthStrokeProperties =` work now.

**`documentchange`**: `textPathStart` → `textPathStartData`, `transformModifiers`, the stroke-kind fields → `complexStrokeProperties`, `variableWidthPoints` → `variableWidthStrokeProperties`.

**Tests**: `plugins/__tests__/draw.test.ts` (fake engine: the readers, every writer's commands in order, validation, the stubs' answer); `plugins/__tests__/draw.wasm.test.ts` (QuickJS + the wasm: the API's shape, a dynamic stroke read back, custom width points written; three end-to-end tests `it.skip` with `TODO(7b)` — text path, transform group, brushes).

## 6. The chrome

**Figma menu › Plugins** (`editor/menus.ts`'s plugin items, 5d; the 181-wide menu of editor.md round 12). From the top:
1. **Run last plugin** ⌥⌘P.
2. **Saved plugins ▸**.
3. The plugins the person ran, by their manifest `menu` (nested).
4. **Development ▸** with:
   - New plugin…
   - Import new plugin from manifest…
   - the development plugins
   - a separator
   - Hot reload plugin ✓
   - Use developer VM
   - Open console
5. **Manage plugins…**.

**New plugin…** is the "Create a plugin" modal:
- Figma design / Dev Mode, the name, the template (Default, Run once, Custom UI; Dev Mode: Inspect, Code Generator), then **Save as**.
- Main writes the template's files (`manifest.json`, `code.js`, `ui.html`) into a folder the person picks. The templates are bundled from Figma's own quickstart: plain JavaScript, no build step.

**Manage plugins…** opens the Actions panel's "Plugins & widgets" tab, scrolled to "Manage". Publishing from there is §10.

**The canvas menu**: Plugins ▸ (a layer's menu and the empty canvas's) lists the same as the menu's run section.

**Actions (⌘K) › Plugins & widgets** (`panels/ActionsPanel.tsx`; today it says plugins aren't part of the app):
- **Sections**:
  - Recents;
  - Saved;
  - **Development**;
  - **From ‹org›** (the org's private plugins);
  - in orgs with approval on, **Approved**.
- **Rows**: a row runs the plugin. The ⋯ menu offers Save / Remove from saved, Open console (development), Remove (development).
- **Not approved** (org files, approval on): the row is dimmed with **Request approval** when `pluginRequests` is on (§10.3).
- **Search**: typing filters the list, and a plugin's `menu` commands appear as their own rows (Figma's Quick Actions).
- **Parameters**: a plugin with `parameters` prompts in the palette as Figma's: one field per parameter, suggestions from `figma.parameters.on('input')`, Tab to the next, Enter to run.

**The Tools tab** (left navigation; `editor/panels/LeftPanel.tsx`'s Tools content):
- Lists the same plugins under Source (Development / Organization) and Category, with the filter by type (Plugins / Widgets).
- "Create" opens New plugin…

**Dev Mode**: the right sidebar's **Plugins** panel (§7).

**Saved plugins and recents**:
- Kept per person in the store: `Workspace/plugins.json` on the desktop, `designer.devStore.v1.plugins` in the browser.
- Shape: `{saved: PluginRef[], recents: PluginRef[] (≤ 10)}`. Figma links them to the account; ours stay per installation.

**The "Running ‹name›" toast**:
- Shown at the bottom centre while a run is open and its UI is hidden or absent, with ✕ = Stop (Figma's).
- `figma.notify` toasts use the editor's ds `Toast`, with Figma's `button` and `timeout` semantics.

## 7. Dev Mode plugins

- **The Plugins panel** (Dev Mode's right sidebar, `src/viewer/` through the editor's `DevPanels`, 5f):
  - Lists the plugins with `editorType` `dev`.
  - Running one with `inspect` opens its UI inside the panel (`showUI` docked, not floating); `figma.mode === "inspect"`.
  - The More menu pins / unpins one.
- **Codegen**:
  - A plugin with `codegen`, chosen in Inspect › Code's language menu (its `codegenLanguages` as entries, after the built-in CSS / iOS / Android), runs headless with `figma.mode === "codegen"`.
  - On each selection change and preference change, `generate` is called with `{node, language}` and has 3 s (Figma's) to answer `CodegenResult[]`.
  - Each result is a titled code block in Inspect.
  - Errors and timeouts show Figma's error block.
  - The VM stays alive while the language is selected, and is disposed when it changes or Dev Mode closes.
- **Preferences**:
  - `unit` → the unit menu gains the scaled unit;
  - `select` → a menu per preference;
  - `action` → a menu item that runs `figma.on('preferenceschange')` with `showUI`.
  - Values are kept per plugin in `clientStorage`'s store (main).
- **Dev Mode's edits**: the engine's viewer mode with Dev Mode's own edits (editor.md round 6). A Dev Mode plugin may write only what Dev Mode may (annotations, measurements, statuses, dev resources, plugin data); other writes throw Figma's "Cannot write to node … in Dev Mode" (wording unverified).

**As built (5f, 2026-10-12)**: docs/editor.md "As built — Dev Mode in the editor, the viewer and the CLI" › Dev Mode plugins. The Plugins tab beside Inspect, inspect UIs docked (`PluginWindowState.docked`, `PluginFrame`), codegen languages under "Plugins" in the language menu with one headless run while chosen (`PluginRun.headless()`: no "Running" toast for `codegen` / `inspect` runs). Not built: preferences (`unit`, `select`, `action`), Dev Mode's write restrictions for plugins.

## 8. Plugin data in the document (schema, 5d)

`schema/document.kiwi` gains Figma's messages and fields, with Figma's numbers (from `docs/research/figma/figma-schema-106.kiwi`; check `@ours` collisions first; `docs/schema.md` gets the rows):

```kiwi
message PluginData {
  string pluginID = 1;
  string value = 2;
  string key = 3;
}

message PluginRelaunchData {
  string pluginID = 1;
  string message = 2;
  string command = 3;
  bool isDeleted = 4;
}

// in NodeChange:
  PluginData[] pluginData = 204;
  PluginRelaunchData[] pluginRelaunchData = 219;
```

- **`setPluginData(key, value)`**: an entry `{pluginID: <the plugin's id>, key, value}`. `setSharedPluginData(namespace, key, value)` uses `pluginID = "shared:" + namespace` (ours: Figma's encoding of shared data inside the same field is unverified). An empty value deletes the entry.
- **Merging**: the whole list is one field, so multiplayer's last writer wins per node across plugins. Accepted, as the engine's yield rule already works per field (engine.md §9.5 "Limits").
- **`PluginRelaunchData.customToolId`** (Figma's field 5, `CodeComponentId`) is left out: Figma's Make tools.
- **Engine**: no hand-written code is expected. The fields are stored, journaled and copied by the generated tables. 5d regenerates (`npm run engine:gen`) and rebuilds the release wasm — **the round's only engine build**.
- **REST and `.fig` export**: `GET /v1/files?plugin_data=` reads them (§16.6). `.fig` export carries them; they are Figma's fields.

## 9. Security summary

| Threat | Answer |
|---|---|
| Plugin code reaching the editor, IPC or other files | QuickJS: separate heap, only the API's host functions. Developer VM: a Worker with the network globals deleted, used only for development plugins by the person developing them |
| Plugin UI reaching the editor | opaque-origin iframe, no `allow-same-origin`, messages accepted only from its `contentWindow` |
| Network beyond the manifest | UI: CSP from `allowedDomains`; `code.js`: main's `fetch` checks the same list; the developer VM's worker: `connect-src 'none'` + deleted globals |
| Runaway code | memory limit, interrupt handler, Stop; the developer VM's worker is terminated |
| Reading files on disk | only main reads a development plugin's own folder |
| Org policy | private plugins: org members only (guests refused, as Figma); approval enforced in org files (§10.2) |
| Secrets | no tokens or session reach a plugin; `figma.currentUser` is name / id / photo only |

## 10. Private plugins and approval (server `server/src/plugins/`, 5c; store `src/store/plugins/`, 5g; Admin, 5h)

### 10.1 Private plugins

**Publishing.** From an org file: Manage plugins › a development plugin's **Publish…** opens the Publish modal:
- the name, a description, the icon (optional, ≤ 128 kB PNG);
- "Publish to: ‹org›" (the only choice; there is no Community);
- **Publish**.

Each publish:
1. The store uploads with `POST /orgs/:org/plugins` `{manifest, parts: {name, sha1, size}[]}` → `{plugin, missing: string[]}`.
2. It sends the missing parts with `PUT /plugins/:id/parts/:version/:name` (bytes ≤ 10 MB each, SHA-1 checked; chunked into `plugin_chunks`).
3. It commits with `POST /plugins/:id/versions/:version/commit`.

The first publish assigns the id: a 19-digit decimal string, like Figma's. The development manifest's `id` is **not** rewritten on disk; the store remembers `{path → publishedId}` (ours: Figma asks you to put the id in your manifest; we tell the person to and show it). Later publishes of the same development plugin update it (version + 1).

**Who:**
- Any org **member** may publish (Figma's; no review).
- Only the publisher, or an org admin (ours: Figma lets only the publisher change access), may update or delete.
- Guests can't list, run or publish (403).

**Routes:**

| Route | Answer |
|---|---|
| `GET /orgs/:org/plugins?kind=` | `{plugins: PrivatePlugin[]}` |
| `GET /plugins/:id` | `{plugin}` |
| `GET /plugins/:id/parts/:version/:name` | bytes, `immutable` |
| `PATCH /plugins/:id` | `{name?, description?}` |
| `DELETE /plugins/:id` | soft delete (`deleted_at`) |

**Running.** A private plugin is downloaded to the store's cache (`Workspace/spaces/plugins/<id>/<version>/…`), then run like a development plugin. Its manifest's network rules hold; `devAllowedDomains` is ignored.

**Activity**: `private_plugin_publish` / `_update` / `_delete`.

### 10.2 Approval

- **Settings** (Admin › Settings › **Extensions**, 5h): `OrgSettings.pluginApproval` ("Allow all plugins" / "Only admin-approved plugins."), `pluginRequests` ("Allow members to request plugins"); the same for widgets (stored, for §11).
  - Logged as `plugin_approvelist_enable` / `_disable`, and `widgets_enabled` / `widgets_disable` (Figma's names).
- **What approval governs here**: in an org file with `pluginApproval: "approved"`, a plugin may run only if one of these holds:
  - it is a **private plugin** of that org (exempt, as Figma);
  - its manifest id has an approval row for the org, or for the file's workspace (Enterprise per-workspace);
  - it is a **development plugin run by the person developing it** (ours: Figma's rule for development plugins under approval is unverified; refusing them would make developing in org files impossible).

  Approval rows are keyed by the manifest `id`, because we have no Community.
- **Workspace-only approvals**: a plugin approved only for some workspaces is blocked in drafts (Figma's).
- **Enforcement**:
  - The editor checks before a run, through `store.plugins.allowed(fileKey, pluginId)`. It reads the org's settings and approvals, cached with the org (data of §14.6).
  - Refused → the run doesn't start, with the toast "Your organization only allows approved plugins" and **Request approval** (when allowed).
  - The server can't see plugin runs; the check is client-side, like Figma's.
- **Routes** (org admins; workspace admins for their workspaces' rows):

  | Route | Body → answer |
  |---|---|
  | `GET /orgs/:org/admin/plugins?kind=` | → `{approved: PluginApproval[], requests: PluginRequest[], private: PrivatePlugin[]}` |
  | `POST /orgs/:org/admin/plugins/approvals` | `{pluginId, kind, name, scope: {type: "org"} \| {type: "workspace", ids}}` (Figma's "Add plugin" with a plugin id instead of a Community link) |
  | `DELETE /orgs/:org/admin/plugins/approvals/:pluginId?workspace=` | — |

  Logged as `plugin_approvelist_add` / `_add_workspace` / `_remove` / `_remove_workspace` (widgets: `widget_approvelist_*`).

### 10.3 Requests

- **Requesting**:
  - Members: `POST /orgs/:org/plugins/requests {pluginId, kind, name, manifest, reason, workspaceId?}` → `{request}`, logged as `plugin_approvelist_request_org`.
  - Only when `pluginRequests` is on (else 403 `forbidden`).
  - One pending request per (person, plugin).
- **Who is told**: every org admin (workspace admins for workspace-scoped approval) gets notification kind `plugin_request` ("‹name› requested ‹plugin›", ours; Figma's wording unverified). Email: none (§12 has no mail).
- **Reviewing**: Admin › Resources › Plugins › **Requests** (5h). The review modal has:
  - **Overview**: the manifest's name, editor types, network domains with their `reasoning`, permissions, capabilities;
  - **Request history**;
  - **Try it out**: runs it in a new local draft outside the org — Figma's "a draft in a team outside the organization";
  - **Decline** (an optional reason);
  - **Approve** (org, or chosen workspaces on Enterprise).
- **Answering**: `POST /orgs/:org/admin/plugins/requests/:id {approve, reason?, workspaceIds?}`.
  - Logged as `plugin_approvelist_request_approve_org` / `_reject_org` / `_approve_workspace` / `_reject_workspace`.
  - The requester gets `plugin_request_answer` ("Your request for ‹plugin› was approved | declined").
  - A declined requester may ask again.

### 10.3a As built — the server (5c, 2026-10-11, branch `worktree-agent-a0361bbba40d714b8`)

**Where**: `server/src/plugins/` (`private.ts`, `approvals.ts`, `routes.ts`), dispatched from one `api.ts` line. Tests: `server/src/plugins/plugins.test.ts`.

**Publishing (§10.1), three steps:**
1. `POST /orgs/:org/plugins {manifest, parts, name?, description?, pluginId?}` answers `{plugin, version, missing}`.
   - **A new plugin** gets its 19-digit id right away, in a `version = 0` row. Lists and `GET /plugins/:id` hide that row until the first commit.
   - **`pluginId`** names a plugin to update. Only its publisher or an org admin may.
   - **The pending manifest and part list** are stored as the version's `.meta` chunk, so the commit needs no body.
   - **Parts whose SHA-1 is unchanged** from the current version are copied over on the server and aren't listed in `missing`.
   - **Refused**: widgets ("Widgets aren't supported in DesignerV2 yet"), a manifest without `name` / `main` / `api` or over 64 kB, and part lists without `code`. Part names are `code`, `ui` or `ui:<key>`, at most 50 parts.
2. `PUT /plugins/:id/parts/:version/:name` uploads one part.
   - It is checked against its declared SHA-1 and size, ≤ 10 MB.
   - It is stored in 1 MiB chunks.
   - A version other than current + 1 answers 409 `stale`.
3. `POST /plugins/:id/versions/:version/commit` answers `{plugin}`.
   - Every part must match. Otherwise it answers 409 with `missing`.
   - It is atomic on the version (another publish that finished first → 409 `stale`).
   - It keeps the current and the previous version's chunks.
   - Logged as `private_plugin_publish` on version 1, `private_plugin_update` after.

**The other routes:**
- `GET /plugins/:id/parts/:version/:name` serves the current or the previous version, `private, max-age=31536000, immutable`.
- `PATCH /plugins/:id` → `{plugin}`, logged as `private_plugin_update`.
- `DELETE /plugins/:id` → 204. It soft-deletes the row, drops the chunks and logs `private_plugin_delete`.
- Guests get 403 everywhere; people outside the org get 404.
- Each change sends `{t: "plugins", orgId}` to the org's inboxes (for the store's `plugins` topic).

**Members' routes** (these two are ours, needed by 5g's `allowed` and "Request approval"):
- `GET /orgs/:org/plugins/approved?kind=` → `{approved}`.
- `GET /orgs/:org/plugins/requests` → `{requests}` (the caller's own).

**Requests (§10.3)**:
- `POST /orgs/:org/plugins/requests` → 201 `{request}`.
- Refused with 403 `forbidden` when the kind's requests are off, and for guests.
- Refused with 409 for a second pending request, or when the plugin is already approved for the org (or for the `workspaceId` asked about — a workspace approval doesn't cover drafts).
- Org admins, plus the workspace's admins when `workspaceId` is given, get `plugin_request`: `text` = the plugin's name, `fileName` = the org's name, `state: "pending"`. It counts in the Requests tab's pending number.

**Admins (§10.2)**:
- `GET /orgs/:org/admin/plugins?kind=` (default `plugin`) → `{approved, requests, private}`. Workspace admins see only their workspaces' requests.
- `POST …/approvals` → 204. Approving for the org needs an org admin; workspace scopes need an admin of each. Approving also answers the pending requests it covers.
- `DELETE …/approvals/:pluginId?workspace=&kind=` → 204 / 404.
- `POST …/requests/:id {approve, reason?, workspaceIds?}` → `{request}`. A request already answered → 409.

**Answering**:
- The requester gets `plugin_request_answer` with `state` approved | denied. The admins' rows take the same state.
- A declined request keeps `declineReason`, and the person may ask again.
- Actions are `plugin_approvelist_*` / `widget_approvelist_*` as §16.11. A decline is `_reject_workspace` when the answering admin is a workspace admin, `_reject_org` otherwise.

**Settings** (`server/src/org/admin.ts` `patchSettings`):
- The four keys are validated.
- `pluginApproval` → `plugin_approvelist_enable` (approved) / `_disable` (all).
- `widgetApproval` → `widgets_enabled` (approved) / `widgets_disable` (all). This pairing is our reading of Figma's names.
- A change to `pluginRequests` / `widgetRequests` is logged under its kind's approval action, with the key in `details` (Figma has no action for it).

### 10.3b As built — the store (5g, 2026-10-11, branch `worktree-agent-a3ed1d1a7df356ff6`)

**Where**: `src/store/plugins/service.ts` (`PluginsService`, no Node or DOM imports), wired in `LocalStore` and `MemoryStore`. Tests: `src/store/plugins/plugins.test.ts`, against 5c's real handler (the org of `server/src/testing/orgWorld.ts`).

**Change to §10.4**: `PluginsRepository.watch(listener)` and `PluginsEvent` (`{what: "local"}` | `{what: "org", orgId}`). Like `orgs.watch`, it is the client's listener on topic `plugins`, not an RPC.

**Saved and recents:**
- Kept in `Workspace/plugins.json` (desktop) and `designer.devStore.v1.plugins` (browser).
- The shape is `{v: 1, saved, recents, published}`. `published` maps `orgId + development path` to the published id.
- A ref is checked and copied (`cleanRef`). One plugin is the same `source.type` and id (plus path or org); a private plugin's versions count as one.
- Recents: newest first, at most `MAX_RECENTS` = 10. Running a private plugin moves a saved ref to that version.
- Each change says `{what: "local"}`.

**Private plugins:**
- `listPrivate(orgId)` calls `GET /orgs/:org/plugins` (both kinds). The answer is cached in `spaces/plugins/orgs/<orgId>.json`, keyed by the signed-in person. Offline, the cache answers; with nothing cached the call fails with `offline`.
- `bundle(id, version)`:
  - The parts come from the manifest's `ui`: `code`, then `ui` or `ui:<key>`.
  - Each part is read from `spaces/plugins/<id>/<version>/<part>` (`ui:k` is stored as `ui-k`), else downloaded and kept.
  - The manifest is kept beside the parts, so a cached version opens offline.
  - Without a cache, `GET /plugins/:id` must name that version as current; otherwise the call fails with `conflict` `{current}`.
  - The browser keeps bundles in memory and org lists in `designer.devStore.v1.plugins.org.<orgId>`.
- `publish(orgId, bundle, {name, description, developmentPath})`:
  1. Checks the parts first: a single `""` ui file can't sit beside named ones; keys are `[A-Za-z0-9_.-]{1,64}`; a part is at most 10 MB.
  2. Hashes the parts with SHA-1 (`crypto.subtle`).
  3. `POST /orgs/:org/plugins`, with `pluginId` when this folder published before. If that plugin is gone (404), it publishes again as a new one.
  4. `PUT`s only the parts in `missing`, then commits.
  5. Writes the new version's bundle into the cache.
  6. Says `{what: "org"}`.

  An update sends only the changed parts, because the server copies the unchanged ones.
- `removePrivate(id)`: `GET` (for the org), then `DELETE`. It also drops the plugin from saved, recents and `published`.

**`allowed(fileKey, ref)`:**
1. A private plugin, for an org guest → `{ok: false, reason: "guest"}`, wherever it runs.
2. The file's org comes from `FileMeta.space`. Without one → ok.
3. The org's settings and role come from the org cache (`OrgService.orgs.get`; a settings change reaches it with the Inbox's `{t: "org"}`). `pluginApproval` / `widgetApproval` "all" → ok.
4. Exempt → ok: the org's own private plugins, and development plugins (§10.2).
5. Otherwise the members' `GET /orgs/:org/plugins/approved?kind=`:
   - kept 30 s (`APPROVED_TTL_MS`), and dropped by `{t: "plugins", orgId}` and by every change made here;
   - cached for offline use, together with each team's workspace;
   - an org row, or a workspace row for the file's team's workspace, allows it. Drafts have no workspace.
6. Refused → `canRequest` = the kind's requests setting is on, the person isn't a guest, and they have no pending request for it (`GET /orgs/:org/plugins/requests`).

**Requests and admin calls**: `request`, `admin`, `approve`, `unapprove` and `answer` are thin over §10.3a's routes. Each change says `{what: "org", orgId}`. `unapprove` sends `kind=widget` only when the cached lists know the id only as a widget.

**Events**: `NotificationsService.onPlugins` hands on the Inbox's `{t: "plugins", orgId}`; the service turns it into `{what: "org", orgId}`. `StoreServer` broadcasts topic `plugins`; `StoreClient` hands it to `plugins.watch`.

**Not built**: plugin icons (§10.1's optional PNG; neither the server nor the store carries them), `PATCH /plugins/:id` (no repository method), and a size limit for the bundle cache (it is never swept).

### 10.3c As built — Admin (5h, 2026-10-12)

- **Settings › Extensions** (`admin/Settings.tsx`, `admin/SettingsExtensions.tsx`): Plugin approval / Widget approval rows; their dialog saves `{pluginApproval, pluginRequests}` (widgets the same) in one `updateSettings`.
- **Resources › Plugins / Widgets** (`admin/Plugins.tsx`) over `store.plugins` (`AdminStore.plugins`, Home passes `client.plugins`): Approved (grouped by plugin; Add plugin by ID and name; Remove, or Edit approvals per workspace with `approve` / `unapprove`), Requests (the review; `answer` with `reason` or `workspaceIds`), From ‹org› (private plugins; `removePrivate`). A workspace admin's Admin has the same under its own **Plugins** item, scoped to the workspace.
- **Try it out** is `AdminApp`'s `onTryPlugin(request)`; Home doesn't pass it yet (a local draft outside the org with the plugin needs 5d's host), so the button is disabled there.
- The fake (`admin/fake/fakePlugins.ts`) keeps §10.3a's rules. Wording: research R19 §11.

### 10.4 Types (`src/shared/plugins/types.ts`, committed verbatim before the round)

```ts
/** Plugins (docs/plugins.md). The manifest is Figma's manifest.json. */
export type PluginEditorType = "figma" | "figjam" | "dev" | "slides" | "buzz";
export type PluginKind = "plugin" | "widget";
export interface PluginParameter { name: string; key: string; description?: string; allowFreeform?: boolean; optional?: boolean }
export type PluginMenuItem = { name: string; command: string; parameters?: PluginParameter[]; parameterOnly?: boolean } | { separator: true } | { name: string; menu: PluginMenuItem[] };
export interface CodegenPreference {
  itemType: "unit" | "select" | "action";
  propertyName?: string; label?: string;
  scaledUnit?: string; defaultScaleFactor?: number; default?: boolean;
  options?: { label: string; value: string; isDefault?: boolean }[];
  includedLanguages?: string[];
}
export interface PluginManifest {
  name: string; id: string; api: string; main: string;
  ui?: string | Record<string, string>;
  editorType?: PluginEditorType[];
  documentAccess?: "dynamic-page";
  networkAccess?: { allowedDomains: string[]; reasoning?: string; devAllowedDomains?: string[] };
  parameters?: PluginParameter[]; parameterOnly?: boolean;
  menu?: PluginMenuItem[];
  relaunchButtons?: { command: string; name: string; multipleSelection?: boolean }[];
  enableProposedApi?: boolean; enablePrivatePluginApi?: boolean;
  build?: string;
  permissions?: ("currentuser" | "activeusers" | "fileusers" | "payments" | "teamlibrary")[];
  capabilities?: ("textreview" | "codegen" | "inspect" | "vscode")[];
  codegenLanguages?: { label: string; value: string }[];
  codegenPreferences?: CodegenPreference[];
  containsWidget?: boolean; widgetApi?: string;
}
/** Where a runnable plugin comes from */
export type PluginSource = { type: "development"; path: string } | { type: "private"; orgId: string; version: number };
export interface PluginRef { id: string; name: string; kind: PluginKind; source: PluginSource; editorTypes: PluginEditorType[] }
export interface PluginBundle { manifest: PluginManifest; code: string; ui: Record<string, string> /* "" = the single ui file */ }

export interface PrivatePlugin { id: string; orgId: string; kind: PluginKind; name: string; description: string; manifest: PluginManifest; version: number; publishedBy: { id: string; name: string | null } | null; createdAt: number; updatedAt: number; canManage: boolean }
export interface PluginApproval { pluginId: string; kind: PluginKind; name: string; scope: { type: "org" } | { type: "workspace"; id: string }; addedBy: string | null; addedAt: number }
export interface PluginRequest { id: string; orgId: string; pluginId: string; kind: PluginKind; name: string; manifest: PluginManifest | null; requestedBy: { id: string; email: string; name: string | null }; workspaceId: string | null; reason: string; state: "pending" | "approved" | "declined"; declineReason: string; createdAt: number; answeredAt: number | null }

/** The plugins repository on StoreApi (both stores; events on topic "plugins") */
export interface PluginsRepository {
  /** Saved and recent plugins of this installation */
  local(): Promise<{ saved: PluginRef[]; recents: PluginRef[] }>;
  setSaved(ref: PluginRef, saved: boolean): Promise<void>;
  ranRecently(ref: PluginRef): Promise<void>;
  /** Private plugins of an org (cached for offline) and their bundles */
  listPrivate(orgId: string): Promise<PrivatePlugin[]>;
  bundle(pluginId: string, version: number): Promise<PluginBundle>;
  publish(orgId: string, bundle: PluginBundle, meta: { name: string; description: string; developmentPath: string }): Promise<PrivatePlugin>;
  removePrivate(pluginId: string): Promise<void>;
  /** May this plugin run in this file? (§10.2) */
  allowed(fileKey: string, ref: PluginRef): Promise<{ ok: true } | { ok: false; reason: "approval"; canRequest: boolean } | { ok: false; reason: "guest" }>;
  request(orgId: string, input: { pluginId: string; kind: PluginKind; name: string; manifest: PluginManifest; reason: string; workspaceId?: string }): Promise<PluginRequest>;
  /** Admin › Resources › Plugins / Widgets */
  admin(orgId: string, kind: PluginKind): Promise<{ approved: PluginApproval[]; requests: PluginRequest[]; private: PrivatePlugin[] }>;
  approve(orgId: string, input: { pluginId: string; kind: PluginKind; name: string; scope: { type: "org" } | { type: "workspace"; ids: string[] } }): Promise<void>;
  unapprove(orgId: string, pluginId: string, workspaceId?: string): Promise<void>;
  answer(orgId: string, requestId: string, input: { approve: boolean; reason?: string; workspaceIds?: string[] }): Promise<PluginRequest>;
}
```

Before the agents, the main session also adds `plugins: PluginsRepository` to `StoreApi`, with a `notImplemented` stub in both stores, as round 4 did for `identity`.

## 11. Widgets — later

Not built in round 5. Widgets are a node type (`WIDGET`, with synced state on the node), not a plugin run, and they need four things:
- **the schema**: Figma's widget fields in `figma-schema-106.kiwi`;
- **the engine**: rendering a widget's JSX tree as real child nodes, kept in sync;
- **`figma.widget`**: `register`, `useSyncedState`, `useSyncedMap`, `usePropertyMenu`, `useEffect`, `waitForTask`, the `AutoLayout` / `Frame` / `Text` / `SVG` / `Input` … components;
- **multiplayer**: code runs only on the clicking client, everyone sees the resulting nodes [W].

Most widgets are FigJam's, and FigJam is set aside (roadmap, 2026-10-11).

What round 5 does for widgets:
- keeps the Widgets menu (Manage widgets…, Select all widgets) disabled;
- refuses widget manifests ("Widgets aren't supported in DesignerV2 yet");
- stores the Admin widget settings and approval rows (the same tables, `kind = 'widget'`), so Admin › Settings › Extensions and Resources › Widgets are complete.

A later round ("Widgets", after Motion) takes the four parts above in one engine + chrome pair.

## 12. Ownership in round 5 (see `docs/roadmap.md` "Round 5")

| Agent | Owns |
|---|---|
| 5c | the server (§10) |
| 5d | the host, the API, the menus, Actions, the Tools tab, the schema (§3.1, §5, §6, §8) |
| 5e | main (§3.2's protocol, §3.3) |
| 5f | Dev Mode's Plugins panel and codegen in Inspect (§7) |
| 5g | the store's `plugins` repository |
| 5h | Admin › Settings › Extensions, Admin › Resources › Plugins / Widgets, the request review, the notification rows |
