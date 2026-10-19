# 17 — Plugins, widgets and the Plugin API

Figma Design 126.9.13 (desktop), read from the cached editor build. This chapter covers the plugin sandbox, the UI iframe, network access, the manifest and how it is checked, the whole `figma.*` surface with its node members per type, limits, errors and events, the editor UI for plugins (menus, the Running toast, development tools), widgets, and a member-by-member comparison with DesignerV2's plugin API.

Prior work this builds on, not repeated here: `docs/plugins.md` (DesignerV2's plugin contract, written from developers.figma.com on 2026-10-11), `docs/research/atlas/03-menus-shortcuts.md` §3.8 (it left the Plugins and Widgets submenus to this chapter), `docs/research/atlas/14-dev-mode.md` §10 / §15 (codegen languages, Inspect, the Dev Mode Plugins tab).

## 1. Scope and sources

| Source | Offset / where | What it holds |
|---|---|---|
| `fullscreen__jsvm-cpp__jsvm-cpp.js` (21.8 KB) | whole file | The Emscripten loader `CppVm` for `jsvm-cpp.wasm`, the C++ VM the plugin's code runs in. Its export list is in §2.1. The `.wasm` itself is not in the cache. |
| `3187.min.js` (14.4 MB; `5519` and `7362` are near-identical builds of the same modules) | @3200000–3530000 | The node property mixins (`e.<name>=function({vm,defineVmProp,…})`), one per member. |
| `3187.min.js` | @3519000–3534000 | The prototype for each node type, built from the mixin lists (`class si`, `rg(n,"FrameNode",…)`). |
| `3187.min.js` | @3582000–3730000 | The `figma` global: events, `showUI`, `notify`, `ui`, `viewport`, `clientStorage`, `variables`, styles, `codegen`, `parameters`, `util`, `constants`, `payments`, `buzz`, `motion`. |
| `3187.min.js` | @3751922–3780000 | The VM wrappers: `CppVm` (`vmType "cppvm"`), the Realms VM (`"realms"`, the developer VM), the run function (globals `setTimeout` / `fetch` / `atob`, evaluating the code). |
| `3187.min.js` | @3065969 | The manifest validator (`Invalid editorType in manifest…`), parameter checks, plugin code templates. |
| `3187.min.js` | CSP / `allowedDomains` module (exports `St, jl, of, pI, pT`) | How `networkAccess` is checked and turned into the UI iframe's CSP. |
| `3187.min.js` | @3231031, @3791686, @3815338 | The `clientStorage` quota and the `pluginData` size limits. |
| `figma_app.min.js` | @7012450 | The manifest's zod schema: permissions, capabilities, editor types, codegen preferences. |
| `figma_app.min.js` | @2802244 | The inner plugin iframe (`class C`): loader shim, theme, permissions policy, the network iframe. |
| `figma_app.min.js` | @1392142 | Modules 381085 / 194524: the Plugins and Widgets menus. |
| `2108.min.js` | @1074114, @1075391, @1084803 | Plugin constants (style table, create-method table, per-editor exclusions), the plugin UI host (`class M`): iframe size, clamping, positions, the Running toast. |
| Repo | `src/renderer/src/editor/plugins/runtime/figma.js`, `host.ts`, `api/*.ts`, `menus.ts`, `vm/quickjs.ts`, `src/shared/plugins/*.ts`, `src/main/plugins/*.ts` | DesignerV2 today (§13). Its node members were listed by evaluating `runtime/figma.js` with a stub bridge, not by reading it. |

Method:
- `metricsKey` / `key` strings were pulled from every `defineVmFunction` / `defineVmProp` / `defineVmIncrementalFunction` call (555 unique metrics keys, 557 definitions).
- Each mixin definer was mapped to the keys it defines.
- The per-type prototype lists were expanded into member sets with a script. The scripts stay in the session scratchpad. No Figma code is copied here.

Marks: **C** = CONFIRMED (read directly in the build); **I** = INFERRED (deduced).

---

## 2. The sandbox

### 2.1 The VMs

| Item | Value | Evidence | |
|---|---|---|---|
| Production VM | `vmType "cppvm"`: a C++ JavaScript VM compiled to WebAssembly (`jsvm-cpp.wasm`), loaded by injecting `Fig.jsvmCppURLs["jsvm-cpp.js"]` as a `<script>` that defines `CppVm`. If it fails: "Failed to load plugin sandbox". | 3187 @3752139 `CppVm({wasmBinaryFile:Fig.jsvmCppURLs["jsvm-cpp.wasm"]…` | C |
| Developer VM | `vmType "realms"`: a hidden `<iframe>` that loads a `Realm` shim script. The code runs in the browser's own engine, so devtools can debug it. It is chosen when `appModel.useRealmsForPluginDev` is set (menu "Use developer VM", §10.2). | 3187 @3221610 `useRealmsForPluginDev?"realms":"cppvm"`; "need to load realm before using it" | C |
| Third type | `"noopvm"`, a scoped VM that "can only run trusted code" (used for the console shim and internal runs). | 3187 "Scoped NoOp Vm can only run trusted code" | C |
| One VM at a time | "Cannot create two CppVm objects at the same time". The VM is reset (`jsvm_reset`) between runs. On iPad / Safari the whole module is dropped after each run. | 3187 @3752139 | C |
| VM exports (the host ABI) | `jsvm_reset, didThrow, lastThrow, null/undefined/globalHandle, retainHandle, releaseHandle, runMicrotasksAndAutorelease, runMicrotasksWithRejectionTracking, typeof, isNumber/Boolean/String/Null/Undefined/Object/Array/ArrayBuffer/Uint8Array/Function, shallowFreezeObject, getNumber/Boolean/String/ArrayBuffer/Uint8Array, toNumber/Boolean/String, newNumber/Boolean/String/Object/ObjectWithProto/Array/ArrayBuffer/Uint8Array/Function, getPropStr, setPropStr, dataDefinePropStr, accessorDefinePropStr, getOwnKeys, getProto, isEqual, callFunction, evalCode, setExecutionTimeLimit, setMaxStackSize, setMemoryLimit` | jsvm-cpp.js export list | C |
| Host-call bridge | One Emscripten `EM_ASM` callback, `Module.invokeCallback(id, this, args)`. A JS exception thrown in a host function becomes a VM exception with the text "in <function name>: <message>". If the message can't be converted: "API error trying to convert error message in invokeCallback() -- please contact support". | jsvm-cpp.js `ASM_CONSTS` | C |
| Host function names | Accessors are wrapped as `get_<prop>` / `set_<prop>`, so a failed setter reads "in set_fills: …". A method's name is its key. | 3187 `newFunction("get_"+n…)`, `"set_"+n` | C |
| Wasm heap ceiling | `getHeapMax()` = 2 147 483 648 bytes (2 GiB). The heap grows by up to +20 % per step, by at most `requested + 96 MiB`. | jsvm-cpp.js | C |
| Execution time / memory / stack limits | `setExecutionTimeLimit`, `setMemoryLimit` and `setMaxStackSize` are exported, but no JS caller was found. Any limits come from the C++ defaults inside `jsvm-cpp.wasm` (not cached). An abort shows "Plugin runtime aborted" (toast, error). A memory error is recorded in stats (`markMemoryError`). | 3187 `setAbortHandler(… "Plugin runtime aborted")` | I |
| Globals removed | `window`, `document`, `indexedDB` are defined as `undefined` on the VM global. | 3187 `B=["window","document","indexedDB"]` | C |
| `import` check | Before eval, the source is matched against a regex for `import` followed by `(`, `//`, `/*`, `<!--` or `-->`. A match throws `SyntaxError("possible import expression rejected around line N")`. | 3187 @3751922 | C |
| How code is evaluated | `evalTopLevelCode` wraps the code in a strict-mode function. The source gets `//# sourceURL=PLUGIN_<runId>_SOURCE`. | 3187 run function | C |
| API versions accepted | Only `api: "0.6.0"` or `"1.0.0"`. Anything else: `Unknown plugin api version "<v>"` (or `widget`). | 3187 @3075124 | C |
| Code size | `plugin code exceeds max size of N MB`. N is `Math.floor(yO/1e6)` with `yO = 0xf00000` (15 728 640 B), so the message reads **15MB**. The same constant table holds 5 242 880 (cover image) and 0x6400000. | 3187 message; figma_app @838032 `yO:0xf00000` | I (constant module matched by name only) |
| Empty code | "Code string cannot be empty" | 3187 | C |
| A newer run of the same plugin | "Plugin run canceled: superseded by a newer run. This may be expected during local development with hot reload." (console warning, local plugins), then "Plugin already terminated". | 3187 run function | C |
| Error reporting | Errors are sent as `plugin_generated_error` events, at most **100** per page session. | 3187 `if(++ec>100)return` | C |
| Runtime error toast | `Plugin <error>` / `Widget <error>`, with " (N errors total)" from the 2nd error. Tools use `plugins.error_occured_while_running_tool[_with_count]`. A message starting "Error" gets a lower-case "error". | 3187 @3075124+ | C |

### 2.2 Globals inside the VM

| Global | Behaviour | Evidence | |
|---|---|---|---|
| `figma` | The API object (§5). Defined on the global. | 3187 `defineProp(e.global,"figma",p)` | C |
| `console` | `log, error, assert, info, warn, clear`, bound to the editor's console. Plugin errors are logged as message + stack. | 3187 `for(let e of["log","error","assert","info","warn","clear"])` | C |
| `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval` | Installed by the host when the VM has none. Ids are VM-side counters starting at **1**. A string callback is `eval`ed. Every timer is cleared when the run shuts down. Timer callbacks are tracked as "PluginTimerCallback" long-animation-frame entries. | 3187 @≈3776000 | C |
| `fetch(url, init)` | Installed by the host. It runs inside a hidden iframe (`plugin-iframe-for-fetch`) that carries the plugin's `allowedDomains` CSP. `init` keys: `method, headers / headersObject (string map), body (string or Uint8Array), credentials, cache, redirect, referrer, integrity…`. The response is a frozen object `{headersObject, ok, redirected, status, statusText, type, url}` with `arrayBuffer()`, `text()` and `json()`. A JSON parse failure rejects with `{message}` ("Error parsing JSON" when the error is not a `SyntaxError`). The whole body is read before the promise resolves. | 3187 @3776324; `FetchInitOptions` schema | C |
| `atob`, `btoa` | Wrap the host's own. | 3187 | C |
| `__html__` | The manifest's `ui` HTML. `showUI(__html__)` is detected by object identity (`getBooleanProp(t,"__html__")`), and the host substitutes the HTML it holds. A getter returns the real string. | 3187 `const __html__ = (() => {…getRealString` @≈3075000; showUI | C |
| `__uiFiles__` | Not found in the build. | rg: no hits | I (absent) |
| `reportSecurityResults` | Only in security-check runs. | 3187 | C |

### 2.3 Run lifecycle

- **Order of a run:**
  1. The VM is created.
  2. The API object is built.
  3. The `run` event is scheduled with `{command, parameters}`.
  4. The code is evaluated. **C** (3187 `triggerOrScheduleRunEvent({command:"parameters"…})`)
- **Shutdown actions** run in order: VM destroy, console restore, the "commit" undo checkpoint (`DX("commit")`), timers cleared, the fetch iframe removed. **C**
- **Console silencing**: while a non-local plugin runs, the editor's own `console.*` methods are silenced. Afterwards it prints "------- Restoring console.log functionality in Figma --------". **C** (3187 module 294606)
- **AI-assistant runs** evaluate with `evalTrustedCode`, and a returned promise is awaited. An unhandled rejection reads "Unhandled promise rejection: …" / "Unknown error in async plugin code". **C**
- **Connection**: a plugin that needs pages waits up to **10 s** for the multiplayer connection. After that: "Unable to establish connection to Figma after 10 seconds. Please check your internet connection." **C** (3187 @3257473 `nY=…()=>10`)

---

## 3. The UI iframe

### 3.1 The three iframes

| Layer | What | Evidence | |
|---|---|---|---|
| Outer "Shim Plugin Iframe" | React `<iframe src="/plugin-sandbox">` with `allow="camera *; microphone *; local-network-access *"`. Its title is "Plugin: ‹name›" / "Widget: ‹name›" (`general.file_type.plugin/widget`). It sets `__FIGMA_PLUGIN_SANDBOX_PAGE_LOADED`. If that fails: "Error loading Figma plugin iframe sandbox. Try refreshing the page." | figma_app (class around `createInnerIframe`) | C |
| Four outer containers | Ids `plugin-iframe-in-modal` (floating window), `plugin-iframe-in-inspect` (Dev Mode panel), `plugin-iframe-in-buzz-left-panel`, `plugin-iframe-for-fetch`. Chosen by `triggeredFrom`: `handoff-relaunch` and `handoff-panel` → INSPECT; codegen / lint / linkpreview → MODAL. | 3187 module 314711 / 600381 | C |
| Network iframe | Created inside the shim. A `<meta http-equiv="Content-Security-Policy">` built from `allowedDomains` goes into its head (§4.2). It holds the inner iframe. Its permissions policy is `camera *` / `microphone *` (only when permitted) plus `local-network-access *`. | figma_app @2802244 | C |
| Inner "Inner Plugin Iframe" `#plugin-iframe` | A `data:text/html;base64` loader shim. It waits for the parent's message (the source must be `window.parent.parent.parent` and the origin the editor's), then `document.write`s, in order: the error-forwarding script, the theme class setter, the CSP-violation logger (local plugins only), the theme CSS variables, the props-kit CSS and the plugin's HTML. A newer path uses a "secure sandbox origin" and posts `{__figmaPluginUi:"document", document}`; the URL carries `?context=base64({allowedDomains, csp})`. | figma_app @2802244 | C |
| Permissions policy | `camera`, `microphone`, `display-capture` and `clipboard-write` are each `*` when the manifest permission exists (`camera`, `microphone`, `displaycapture`, `clipboardwrite`), else `'none'`. Camera / microphone also ask the desktop app (`requestCameraAndOrMicrophonePermissions`, requester "‹name› plugin"). On old desktop builds: "Camera access is only available in the latest version of Figma Desktop". | figma_app `getPermissions` | C |
| Fonts injected | `@font-face` Inter weights 100–900, normal and italic (`Inter-Thin-BETA` … `Inter-Black`), from `static.figma.com/webfont/1/…woff2?v=…`. | figma_app `x=()=>…` | C |
| Theme | With `themeColors: true`, the `<html>` gets class `figma-light` / `figma-dark` (from `data-preferred-theme`; FigJam's whiteboard theme → light) and the `--figma-color-*` variables are injected. On a theme change the iframe gets `{figmaMessage:{type:"THEME", payload:{name, variables}}}`. | figma_app `getThemeClassSetter`, `handleThemeUpdate` | C |
| Error forwarding | The inner document posts `{pluginUIError:{message, stack[, isUnhandledRejection]}}` to its parent for `error` and `unhandledrejection` events (capture phase, no `preventDefault`). Used by the custom-tool "Fix for me" flow. | figma_app inline script | C |
| CSP violation hint (local plugins) | Console warning: "Failed to load resource from ‹uri› since it is not in the list of allowed domains. Please add "‹origin›" to the networkAccess > allowedDomains field in your manifest.json." | figma_app | C |
| Iframe style | `display:block; margin:0; border:none; padding:0; width:100%; height:100%`, with background **white** unless `themeColors`. | figma_app `setIframeStyle` | C |

### 3.2 Messages

| Direction | Shape | Evidence | |
|---|---|---|---|
| Plugin → UI | `figma.ui.postMessage(msg, {origin = "*"})` → the iframe receives `{pluginMessage: msg, pluginId}`. | 3187 `postMessageToIframe({pluginMessage:…,pluginId:…},{origin:i.origin})` | C |
| UI → plugin | The iframe's `message` events (checked: `e.source === inner.contentWindow`) are relayed as `{data, origin}` through a `MessageChannel` to the host, which calls `figma.ui.onmessage(msg, props)` / the `on('message')` handlers. | figma_app `iframeMessageEventListener` | C |
| No UI yet | `postMessage`, `resize`, `reposition`, `show` and `getPosition` throw "No UI to … Did you forget to create a UI by calling showUI?" (variants: "No UI to send a message to.", "No UI to resize.", "No UI to reposition.", "No UI to show.", "Cannot get the UI position."). | 2108 class M | C |
| Internal message types | `$INTERNAL_DO_NOT_USE$RERUN_PLUGIN$`, `$INTERNAL_DO_NOT_USE$CYCLE_FOCUS_FORWARD$` / `…BACKWARD$`. | 3187 module 314711 | C |

### 3.3 `figma.showUI(html, options)` and the window

| Rule | Value | Evidence | |
|---|---|---|---|
| Options schema | `{visible: boolean, title: string, width: int ≥ 0, height: int ≥ 0, position: {x, y finite}, themeColors: boolean, propsKit?: boolean}`, all optional. Defaults: `visible: true`, `themeColors: false`. | 3187 @3618913 area | C |
| Default size | **300 × 200** | 2108 `iframeWidth=300,iframeHeight=200` | C |
| Width clamp | Floating window: `clamp(w, 70, window.innerWidth − 50)`; `null` → 300. Inspect panel: the panel's width. | 2108 @1084803 `getClampedWidth` | C |
| Height clamp | `clamp(h, 0, innerHeight − 48 − <header height>)`; `null` → 200. Panel iframes are not clamped. | 2108 `getClampedHeight`, `P=K_("48px")` | C |
| Default position | `"last"`: the position saved for this plugin id in `localStorage["plugin-positions"]` (clamped to the window), else centred. Codegen runs use `"codegen-default"`: to the left of the Inspect panel, or above it in the VS Code extension. Other forms: `{x, y}` in canvas space; `{windowSpace:true, x, y}`; `{windowSpace:true, anchor:{rect, side, gap, align}}`. When no position is given and a context menu was just used, the window opens at the click point. | 2108 `setInitialPosition` | C |
| Position saved | Every `reposition` / drag stores `{x, y}` per plugin id. | 2108 `storeModalPosition` | C |
| `ui.resize(w, h)` | Both must be **positive integers**. | 3187 `PositiveInteger` | C |
| `ui.reposition(x, y)` | Finite numbers, in canvas coordinates. | 3187 | C |
| `ui.getPosition()` | `{windowSpace, canvasSpace}` | 2108 `getIframePosition` | C |
| queryMode | "Cannot show UI in queryMode." | 3187 | C |
| Inside codegen | Throws "Cannot call figma.showUI inside the codegen generate callback. Move figma.showUI outside the callback and use figma.ui.postMessage within the callback instead to ensure that your plugin handles concurrent "generate" events correctly." (local plugins). | 3187 @3618913 | C |
| Inspect plugins | A Dev Mode inspect plugin (not codegen) that has no iframe after **10 s** is ended with "Inspect panel plugins must have an iFrame when running". | 2108 @1087540 | C |
| Inspect plugin without UI | Manifest template rule: "Inspect panel plugins cannot be created without a UI". | 3187 @3065969 | C |
| Panel switching | `switchContainer` moves a running UI between the modal and the panels, keeping its HTML and size. | 2108 | C |
| Colour picker | Plugins (props-kit) can open Figma's colour picker anchored at `{x, y}`. Initial colour `{r:1, g:1, b:1, a:1}`. | 2108 `showColorPicker` | C |

---

## 4. Network access

### 4.1 Manifest `networkAccess` rules (validator `pI`)

| Rule | Error text | |
|---|---|---|
| `allowedDomains` empty | `Invalid value for allowedDomains. To block all network access, set allowedDomains: ["none"]` | C |
| `"none"` together with other entries | `Invalid value for allowedDomains. 'none' must be the only value in the array.` | C |
| Entry fails the domain regex (scheme `http(s)/ws(s)` optional, `*.` wildcard prefix, host or `localhost`, `:port`, path) and is not `*` | `Invalid value for allowedDomains. '<d>' must be a valid URL.` | C |
| Duplicate entry | `Invalid value for allowedDomains. '<d>' is duplicated.` | C |
| `"*"` without `reasoning` | `Invalid value for networkAccess. If you want to allow all domains, please add a "reasoning" field to the networkAccess object.` | C |
| localhost / port entries (valid for the localhost regex, not the strict one) without `reasoning` | `Invalid value for networkAccess. If you want to allow localhost, please add a "reasoning" field to the networkAccess object. If you only need to access localhost for development, please add a "devAllowedDomains" field instead.` | C |
| `reasoning` longer than **1000** chars | `Invalid value for networkAccess. The "reasoning" field must be less than 1000 characters.` | C |
| Entry without a scheme (other than `*` / `none`) | `Invalid value for allowedDomains. '<d>' must include a scheme, such as https://.` | C |
| `devAllowedDomains` entry invalid | `Invalid value for devAllowedDomains. '<d>' must be a valid URL.` | C |

### 4.2 The CSP that is applied

`networkAccess` is turned into a `<meta>` CSP in the network iframe (function `s`). With `<D>` = the allowed domains joined by spaces:

| Directive | Value |
|---|---|
| `default-src` | `data: blob:` + `<D>` |
| `script-src` | `'unsafe-inline' 'unsafe-eval' data: blob:` + `<D>` (+ the editor origin for props-kit) |
| `style-src` | `'unsafe-inline' 'unsafe-eval' data: blob:` + `<D>` (+ the editor origin for props-kit) |
| `font-src` | `https://static.figma.com/webfont/ data: blob:` + `<D>` |
| `frame-src` | `data: blob: <secure sandbox origin>` (only on the secure-origin path) |

- With `["none"]`, no domains are added. **C**
- With `"*"`, no CSP is added at all. **C**
- There is no `connect-src`: fetches fall back to `default-src`. **C**
- An invalid list only logs a warning and installs no CSP. **C**

Evidence: 3187 module exporting `St, jl, of, pI, pT` (`"default-src data: blob:"`).

### 4.3 URL matching (sandbox `fetch` and image URLs, `pT`)

- The scheme matches when equal, or when the entry is `http:` and the URL is `https:`. Entry `ws:` allows `wss:`, `http:` and `https:`; entry `wss:` allows `https:`. **C**
- **Host**: exact, case-insensitive. `*.x.com` matches any host ending in `.x.com`. **C**
- **Path**:
  - An entry without a trailing `/` must match the URL's path segment for segment, with equal length.
  - An entry ending in `/` matches that prefix.
  - Segments are compared after `decodeURI`. **C**
- **Images**: `createImageAsync(url)` checks the same list: "Image URL ‹url› does not satisfy the allowedDomains specified in the manifest.json". **C**
- **Default sandbox CSP** for a document that has none: `default-src 'none'; form-action 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:;`. **C** (3187 meta string)

---

## 5. The manifest

### 5.1 Schema (zod, `figma_app` @7012450)

| Field | Type | Notes |
|---|---|---|
| `id` | string? | Required to publish. Missing → "Cannot ‹action› in a plugin without an ID. Make sure your plugin manifest has a valid "id" field." (for pluginData, clientStorage …). |
| `name`, `api`, `main` | string | `api` ∈ {`0.6.0`, `1.0.0`} at run time (§2.1). |
| `ui` | string, or map string → string | |
| `build` | string? | |
| `enableProposedApi`, `enablePrivatePluginApi` | bool? | |
| `menu` | array of `{command, name, parameters?, parameterOnly?}` / `{separator:true}` / `{name, menu:[…]}` (recursive) | |
| `networkAccess` | `{allowedDomains: string[], reasoning?, devAllowedDomains?: string[]}` | §4 |
| `relaunchButtons` | `{command, name, multipleSelection?}[]` | |
| `relatedLinkDomains`, `devResourceDomains` | string[] | |
| `parameters` | `{name, key, description?, optional?, allowFreeform?}[]` | |
| `parameterOnly` | bool? | |
| `editorType` | array of `figma`, `figjam`, `inspect`, `dev`, `sites`, `slides`, `buzz` | |
| `containsWidget`, `widgetApi` | bool?, string? | |
| `isTool` | bool? | |
| `permissions` | array of public permissions `currentuser, activeusers, teamlibrary, fileusers, payments, clipboardwrite`, or internal ones `openexternal, analytics, cortex, debug, framejudge, filekey, hidecursors, ai-assistant, camera, microphone, displaycapture` | Internal permissions are stripped from untrusted local and installed plugins ("Untrusted local plugin denied internal api permissions"). |
| `enableReadOnly` | bool? | |
| `capabilities` | `textreview, panel, inspect, codegen, linkpreview, vscode, lint` | |
| `codegenLanguages` | `{label, value}[]` | |
| `codegenPreferences` | union of `{itemType:"action", propertyName, includedLanguages?, label?}`, `{itemType:"unit", scaledUnit, defaultScaleFactor?, default?, includedLanguages?}`, `{itemType:"select", propertyName, label?, options:{label, value, isDefault?}[], includedLanguages?}` | |
| `documentAccess` | `"dynamic-page"` only | |
| `lintRules` | `{key, name, description?}[]` | |

Extra properties are rejected. The zod message "but got additional property X" is rewritten (module 589169 `g`). **C**

### 5.2 Validator rules and texts (3187 @3065969)

| Rule | Text | |
|---|---|---|
| No `editorType` | `Missing editorType in manifest.  Specify a combination of ["figma", "figjam", "dev", "sites", "slides", "buzz"]` (inspect omitted from the hint; two spaces after "manifest.") | C |
| Unknown / empty / too many editor types | `Invalid editorType in manifest.  Specify a combination of […]` | C |
| Running in an editor not listed | `The manifest editorType does not include "<editor>"` | C |
| Unknown permission | `Invalid permission specified: <p>` | C |
| Unknown capability | `Invalid capability specified: <c>` | C |
| `panel / inspect / codegen / linkpreview / vscode` without `dev` | `Capability "<c>" requires "editorType" to include "dev"` | C |
| … on a widget | `Capability "<c>" is not supported for widgets` | C |
| VS Code extension | `Manifest must include "vscode" capability to run in Figma for VS Code Extension` | C |
| `codegenLanguages` without codegen | `codegenLanguages only supported for codegen plugins` | C |
| Codegen without languages | `codegen plugins must define at least one language in codegenLanguages` | C |
| Duplicate `action` propertyName | `codegenPreferences "action" itemType settings must have unique propertyName values` | C |
| `select` default count ≠ 1 | `codegenPreferences itemType: "select" should have exactly one default option` | C |
| More than one `unit` | `codegenPreferences should have at most one itemType: "unit"` | C |
| Widget without `widgetApi: "1.0.0"` | `Widgets must specify the 'widgetApi' manifest field. The latest version is '1.0.0'` | C |
| Widget in Slides | `Widgets are not supported in Figma Slides` | C |
| Duplicate relaunch command | `Expected "manifest.relaunchButtons" to have unique commands, but got more than one button with command: "<c>"` | C |
| `menu` together with `parameters` | `manifest.parameters should not be specified when menu items are defined` | C |
| Empty parameter list | `Expected "<path>.parameters" to have non-empty parameter list.` | C |
| Duplicate parameter key | `Expected "<path>.parameters" to have unique keys, but got more than one parameter with key: "<k>"` | C |
| Required after optional | `Optional parameters must be listed last in the parameter list. <key> not marked as optional.` | C |
| `parameterOnly` without parameters | `Expected parameters to be defined for "<path>" marked as parameterOnly.` | C |
| `relatedLinkDomains` / `devResourceDomains` | Must start `https://` (the check is written oddly: `!startsWith("https://") \|\| startsWith("http://")`); otherwise "Invalid domain '<d>' in '<field>'. Domains must start with 'https:// or 'http://'". Also checked with `URLPattern`. | C |
| `devResourceDomains` without `dev` | `'devResourceDomains' is only supported for plugins with 'editorType' containing 'dev'` | C |
| Generative plugins (custom tools) | `editorType` must be exactly `["figma"]` ("Generative plugins are only supported in Figma Design. Set editorType to ["figma"]."); `documentAccess` must be `"dynamic-page"`; the id must match the tool id. | C |
| Load errors | Each error has a `type` ∈ `LOAD / PARSE / VALIDATE` plus `text`. They show in the Development menu as "⚠ Manifest issue" / "⚠ Plugin missing". | C |

### 5.3 Editor types and nodes

| Item | Value | Evidence | |
|---|---|---|---|
| `figma.editorType` | `figma` (Design, also Draw), `figjam`, `dev`, `slides`, `buzz`, `sites`. `inspect` is the legacy name of `dev`. | figma_app enum `B` | C |
| Mapping to the plugin store | figma / dev / inspect → `DESIGN`; figjam → `WHITEBOARD`; slides; sites; buzz → `COOPER`. | 3187 module 222636 | C |
| Default when `editorType` is missing (templates) | `["figma"]` | 3187 @3065969 | C |
| `create*` excluded in Design | `STICKY, SHAPE_WITH_TEXT, CONNECTOR, CODE_BLOCK, TABLE, MEDIA, SLIDE, SLIDE_GRID, SLIDE_ROW, INTERACTIVE_SLIDE_ELEMENT, WEBPAGE` (list `tO`) | 2108 @1074114 | C |
| `create*` methods (all editors) | `createRectangle, createPage, createSlice, createFrame, createComponent, createBooleanOperation, createVector, createStar, createLine, createEllipse, createPolygon, createText, createSticky, createConnector, createShapeWithText, createCodeBlock, createSection, createTable(numRows?, numColumns? ints ≥ 1), createSlide, createSlideRow, createWebpage, createTextPath` | 2108 @1075391 | C |

---

## 6. The `figma` global

Flags: **RO** = allowed in read-only (view-only) files; **W** = allowed while a widget renders. Calls that are not allowed throw `Can't call "<key>" in read-only mode` / `Can't set "<key>" in read-only mode`. Edits in focus view with changes throw `Cannot call "<key>" in focus view with changes. Reset changes and try again.` **C** (3187 @3587753)

### 6.1 Properties

| Member | Notes | |
|---|---|---|
| `apiVersion` | Non-enumerable, read-only string. | C |
| `command` | The menu command, or `""`. | C |
| `pluginId`, `widgetId` | `widgetId` only exists for widgets. | C |
| `editorType`, `mode` | `mode`: `default`, `textreview`, `inspect`, `codegen`, `linkpreview`, `auth` … | C (keys) / I (value list) |
| `fileKey` | Only with `enablePrivatePluginApi` or the internal `filekey` permission. Non-enumerable. | C |
| `root` | DocumentNode | C |
| `currentPage` | Get / set (set allowed in RO). Under `dynamic-page` the setter throws. A non-page value: "figma.currentPage expects a PageNode". | C |
| `currentUser` | Needs `currentuser`. | C |
| `activeUsers` | Needs `activeusers`. | C |
| `skipInvisibleInstanceChildren` | Get / set (RO-settable). | C |
| `hasMissingFont` | `figma.hasMissingFont` | C |
| `mixed` | The unique symbol for mixed values. | C |
| `payments` | Needs `payments`, otherwise `"payments" permission not specified in manifest.json.` | C |
| `ai` | `generateNode`, `editNodes` (gated) | C |
| `buzz`, `timer`, `textreview`, `vscode`, `lint`, `relatedLinks`, `devResources`, `codegen`, `parameters`, `ui`, `motion`, `viewport`, `clientStorage`, `constants`, `util`, `variables`, `teamLibrary` (needs `teamlibrary`), `annotations`, `internal`, `analytics`, `cortex`, `debug`, `frameJudge`, `kiwi` | Sub-APIs, defined as non-enumerable props. `relatedLinks` is "not available for local plugins. Please use the figma.devResources API instead." | C |

### 6.2 Functions

All of these are **C** from the key table. Async means the function returns a promise.

| Group | Members |
|---|---|
| Run control | `closePlugin(message?)` (RO), `closePluginWithFailure(message)` (test builds only), `notify(message, options)` (RO; §6.4), `showUI` (§3.3), `openExternal(url)`, `on / once / off` (§7) |
| Undo | `commitUndo()`, `triggerUndo()` (not RO) |
| Nodes | `getNodeById` / `getNodeByIdAsync`, `getFileThumbnailNode` / `…Async`, `setFileThumbnailNodeAsync(node)` ("Thumbnail node must be a FrameNode, ComponentNode, ComponentSetNode, or SectionNode"), `getSelectionColors()`, `group, ungroup, flatten, union, subtract, intersect, exclude (nodes, parent, index?)`, `combineAsVariants`, `transformGroup`, `createComponentFromNode`, `createNodeFromSvg(svg)` ("Failed to convert SVG file"), `createNodeFromJSXAsync`, `reconcileNodeFromJSXAsync`, `createPageDivider` (Design), `moveNodesToCoord`, `createCanvasRow`, `get/setCanvasGrid`, `get/setSlideGrid` |
| Pages | `setCurrentPageAsync(page)` ("figma.setCurrentPageAsync expects a PageNode"), `loadAllPagesAsync()` |
| Images, video | `createImage(bytes)` (checks validity; an animated GIF gets its first frame as cover), `createImageAsync(url)`, `getImageByHash(hash)` (RO), `createVideo` / `createVideoAsync`, `createGif`, `createLinkPreviewAsync`. Image objects: `{hash, getBytesAsync(), getSizeAsync()}`; "SHA1 hash does not correspond to an existing image". |
| Fonts | `loadFontAsync(fontName)`, `listAvailableFontsAsync()`, `getFontFamilyVariationAxes(family)` (gate `ce_tl_variable_font_plugin_api`), `loadBrushesAsync({brushType})` |
| Styles | For each of Paint, Text, Grid, Effect (and CustomAnimation behind `metronome_styles_plugin_api`): `create<T>Style()`, `getLocal<T>Styles()` / `…Async()`, `moveLocal<T>StyleAfter(target, ref)`, `moveLocal<T>FolderAfter(folder, ref)`. Also `getStyleById` / `getStyleByIdAsync`, `importStyleByKeyAsync(key)`. Errors: "Target node is a <T> node, instead of <T2>", "Reference node is a … node, instead of …", "Target node and reference node cannot be equal", "Could not create <T> style". |
| Library | `importComponentByKeyAsync`, `importComponentSetByKeyAsync` ("Could not find a published component with the key "<k>"", "Cannot import component with key "<k>" since it is unpublished", "Failed to download the component with the key …"), `importStyleByKeyAsync` |
| Variables (`figma.variables`) | `getVariableById(Async)`, `getVariableCollectionById(Async)`, `getLocalVariables(Async)(type?)`, `getLocalVariableCollections(Async)`, `getSubscribedVariables(type?)`, `createVariable(name, collection, type)` (EASING / TIMING need the metronome gates: "EASING and TIMING variable creation is not currently available"), `createVariableCollection(name)`, `createVariableAlias(variable)` ("Can only construct variable aliases from variables"), `createVariableAliasByIdAsync(id)` ("Invalid variable id"), `importVariableByKeyAsync(key)`, `extendLibraryCollectionByKeyAsync(key, name)` (Enterprise: "Cannot create extended collections outside of enterprise plan."), `setBoundVariableForPaint(paint, field, variable?)` (solid paints only: "can only bind variables to solid paints"; colour variables only), `setBoundVariableForEffect`, `setBoundVariableForLayoutGrid` ("can only bind float variables to layoutGrids") |
| Team library | `getAvailableLibraryVariableCollectionsAsync()`, `getVariablesInLibraryCollectionAsync(key)` (needs `teamlibrary`) |
| Annotations | `getAnnotationCategoriesAsync`, `getAnnotationCategoryByIdAsync`, `addAnnotationCategoryAsync`. A category object has `color`, `isPreset`, `label`, `remove`, `setColor`, `setLabel`. "Annotations can only be written in Dev Mode and Design Mode". |
| Versions | `saveVersionHistoryAsync(title, description?)` → `{id}`; "Failed to save version history. Error: …"; "Version title must be non-empty" |
| Encoding | `base64Encode(Uint8Array)`, `base64Decode(string)` ("Invalid base64 string") |
| Shaders | `listAvailableShaders()`, `importShaderById(id)` (gated). Errors: "Invalid shader id "<id>". Expected an id from figma.listAvailableShaders().", "Shader not imported. Call figma.importShaderById(id) first (id: "<id>")." |
| Misc | `getDisplayMetadataAsync(thumbnailSize = 150 × 150)` (only with `displaycapture`; `null` in the browser), `getHTMLString()` (internal), `analytics.track`, `debugNodes.matchNodes` |
| Util | `rgb(color)`, `rgba(color)`, `solidPaint(color, overrides?)`, `normalizeMarkdown(md)` (all W) |
| Constants | `constants.colors`: two maps (W). Base: black #1E1E1E, gray #B3B3B3, red #F24822, orange #FFA629, yellow #FFCD29, green #14AE5C, blue #0D99FF, violet #9747FF, white #FFFFFF. Light: darkGray #757575, lightGray #E6E6E6, lightRed #FFC7C2, lightOrange #FCD19C, lightYellow #FFE8A3, lightGreen #AFF4C6, lightBlue #BDE3FF, lightViolet #E4CCFF, white #FFFFFF. (Names of the two maps not read.) |
| Motion (gate `metronome`) | `motion.playheadPosition`, `figmaAnimationStyles()`, `physicalSpringToNormalized({mass, stiffness, damping} > 0)` |

### 6.3 `dynamic-page` (incremental mode)

| Rule | Value | Evidence | |
|---|---|---|---|
| Sync / async pairs | `getNodeById→getNodeByIdAsync`, `getStyleById→getStyleByIdAsync`, `getFileThumbnailNode→…Async`, `getLocal*Styles→…Async`, `variables.getVariableById / getVariableCollectionById / getLocalVariables / getLocalVariableCollections → …Async`, `node.mainComponent→getMainComponentAsync`, `instances→getInstancesAsync`, `style.consumers→getStyleConsumersAsync`; setters `fillStyleId→setFillStyleIdAsync` (also stroke / effect / grid / text), `reactions→setReactionsAsync`, `vectorNetwork→setVectorNetworkAsync`, `setRangeTextStyleId / setRangeFillStyleId → …Async` | 3187 `incrementalSafeApi(Set)Key` list | C |
| Calling a sync API under `dynamic-page` | Throws `Cannot call with documentAccess: dynamic-page. Use <asyncName> instead.` With `allowIncrementalUnsafeApiCalls` it only warns: `` `<name>` is deprecated. Please use `<asyncName>` to ensure consistent results.`` | 3187 @3259122 | C |
| `documentchange` under `dynamic-page` | "Cannot register documentchange handler in incremental mode without calling figma.loadAllPagesAsync first." | 3187 | C |
| Unloaded page | "Cannot call getMeasurements() on background page that has not been loaded. Remember to call loadAsync() first."; `loadAsync` on a non-page: "Cannot call loadAsync on a non-page node." | 3187 | C |
| Without `documentAccess` | The editor loads every page first, with the toast `plugins.loading_pages_for_plugin` / `…_for_widget` and a cancel button (`plugins.cancel_loading_pages`). | 3187 i18n keys | C |

### 6.4 `figma.notify(message, options)`

| Option | Rule | |
|---|---|---|
| `timeout` | Number in [0, ∞]. Default **3000 ms**, or **∞** when `error: true`. Raised to at least **100 ms**. Toasts over 3000 ms get a dismiss handler. | C |
| `error` | Default false (red toast). | C |
| `button` | `{text, action}`. `action()` returning `false` keeps the toast open. | C |
| `onDequeue(reason)` | Called with the dequeue reason string. | C |
| Return | `{cancel()}` | C |
| Icon | The plugin's icon when it has a `titleIconURL`. | C |
| Restrictions | queryMode: "Cannot notify in queryMode." Not allowed during widget render. | C |

Evidence: 3187 @3713914; `ShowVisualBellOptions` schema.

### 6.5 Argument validation

- Each argument is checked against a zod schema (e.g. `FontName = {family, style?, variationSettings?}`, `Paint`, `Effect`, `Reaction`, `VectorNetwork` …). **C** (3187 @3787569; schema names listed in the scratch notes: about 190 schemas)
- On failure the whole issue list is thrown. **C**
  - Format: `Property "<name>" failed validation: <issue>[\n<issue>…]`.
  - Each issue: the zod message (with "Required" replaced by "Required value missing"), then " at index N" or " at .path[0].x".
  - Unions: "Expected <path> to be one of the following, but none matched:" followed by indented sub-issues, and "Multiple issues at <path>:" headers.
- The older type checker uses: `Expected "<prop>" to have type <type> but got <actual> instead`, where actual is one of array / null / NaN / Infinity / typeof. **C**
- Primary-field unions: `Expected "<p>" to be an object`, `Expected "<p>.<field>" to be one of the allowed values for this property`. **C**
- Out-of-range values are clamped with a console warning, not thrown. **C**
  - Effect radius > **250** → 250.
  - spread > **30000**.
  - `startRadius` > **100** (`XX`).
  - noise size > **100** (`Mo`).
  - Pattern `scalingFactor` / `spacing.x` / `spacing.y` > **20**.
  - Glass effect params clamped.
  - Max **8** dash pattern entries ("A maximum of 8 dash patterns is supported").
  - "Only one glass effect is allowed per node."
- The default font check: "Cannot load "<family>" without a style. Please specify a style: figma.loadFontAsync({ family: "<family>", style: "Regular" })." Families with no styles: "Cannot load font family "<family>": family is not available. …". Behind `ce_tl_variable_font_plugin_api`, a style-less font loads every style of the family. **C**

---

## 7. Events

| Target | Events | Evidence | |
|---|---|---|---|
| `figma.on / once / off` | `close, selectionchange, currentpagechange, drop, run, documentchange, textreview, slidesviewchange, canvasviewchange, stylechange`; `codegen` (published plugins, the legacy codegen event); `timerstart, timerstop, timerpause, timerresume, timerdone, timeradjust` (FigJam timer) | 3187 @3582227 `oS`, timer list `ad` | C |
| Event names accepted by the schema | `close, selectionchange, currentpagechange, drop, input, run, message, documentchange, stylechange, nodechange, textreview, codegen, generate, preferenceschange, linkpreview, auth, open, slidesviewchange, detect, fix, canvasviewchange` + timer events | 3187 @3519941 `ac` | C |
| `PageNode.on / once / off('nodechange')` | Per page. On a non-page: "Cannot register nodechange handler on non-page node". | 3187 | C |
| `figma.codegen.on` | `generate`, `preferenceschange` | 3187 `addEventHandlersTo(n,["generate","preferenceschange"],"figma.codegen")` | C |
| `figma.lint.on` | `detect`, `fix` | 3187 | C |
| `figma.parameters.on` | `input` | 3187 | C |
| `figma.ui.on / once / off` | `message` | 3187 | C |
| Handler check | "change handler must be a function" / "<event> handler must be a function" | 3187 | C |

**`documentchange` payload:**
- Each change: `{type, origin, id?, node, properties?, style?}`. **C** (3187 @3626089)
- `type` ∈ `CREATE, DELETE, PROPERTY_CHANGE, STYLE_CREATE, STYLE_DELETE, STYLE_PROPERTY_CHANGE`.
- `origin` ∈ `LOCAL, REMOTE`.
- `properties` lists property names.
- **Quirk**: `strokeTopWeight` is reported as **`stokeTopWeight`** (missing r).
- Events are grouped per page guid.

**`slidesviewchange`** → `GRID` | `SINGLE_SLIDE`; **`canvasviewchange`** → `GRID` | `SINGLE_ASSET`. **C**

**Promise callbacks** (codegen `generate`, legacy `codegen`, lint `detect` / `fix`, `linkpreview`):
- The first handler's return value (or promise) is validated against the result schema. **C**
- On rejection the default result is used, and the console gets "Promise returned from codegen 'generate' event rejected. Unable to generate code." plus the error. **C**
- `CodegenResult` = `[{title, code, language}]`, with `language` ∈ `TYPESCRIPT, CPP, RUBY, CSS, JAVASCRIPT, HTML, JSON, GRAPHQL, PYTHON, GO, SQL, SWIFT, KOTLIN, RUST, BASH, PLAINTEXT, DART`. **C**
- Lint detect result = `[{nodeId, explanation}]`. **C**
- **Text review**: the plugin must answer within **3000 ms**, otherwise "Text review plugins must call on('textreview') upon running" (dev plugins). **C** (3187 @2937447)

**`closePlugin` during `close`**: ignored while the `close` event is running synchronously. **C**

---

## 8. Storage, plugin data, relaunch data, parameters

| Item | Value | Evidence | |
|---|---|---|---|
| `clientStorage` backend | IndexedDB database `figma-plugin` (tests: `figma-plugin-testing`), version 1, stores `client-storage` (key `[userID, pluginID, name]`) and `client-quota` (key `[userID, pluginID]` → `{quota}`). | 3187 @3231031 | C |
| Quota | **5 242 880 bytes (5 MB)** per user and plugin. Size = key length + JSON length of the value, where strings count by `.length` and `ArrayBuffer` views by `byteLength`. Over quota: "Client storage quota (5 MB) exceeded for this plugin ID. Please use less client storage." | 3187 @3231031 | C |
| Errors | `Failed to set client storage key "<k>": <e>`, `Failed to delete client storage key "<k>": <e>`, "Cannot access client storage without a user ID" / "…without a plugin ID" | 3187 | C |
| Allowed when | In read-only files yes; during widget render no. | key table | C |
| `setPluginData` / `setSharedPluginData` limit | **102 400 bytes (100 kB)** total UTF-8 length of the strings passed (key + value, plus namespace for shared): "This pluginData entry exceeds 100 kB per entry limit." Plugins on the server flag `ext_plugindata_limit_exempt_plugins` get **64 MiB** (0x4000000): "This pluginData entry exceeds the grace period limit of 64 MB." | 3187 @3791686, @3815338 | C |
| Plugin data in read-only files | `getPluginData`, `setPluginData`, `getSharedPluginData` and `setSharedPluginData` are all allowed in RO (`isAllowedInReadOnly: true`, `hasEditScope: true`). | 3187 pluginData mixin | C |
| Shared namespace | At least **3** chars, at most **1000**, only alphanumerics, `_` or `.`: "The namespace must be at least 3 characters", "The namespace can be at most 1000 characters", "The namespace can only consist of alphanumeric characters, _ or ." | 3187 errors | C |
| Private plugin data | Needs a plugin id ("Cannot get private plugin data in a plugin without an ID…"). | 3187 `p(n,"get private plugin data")` | C |
| `findAllWithCriteria` | `{types?, pluginData?: {keys?}, sharedPluginData?: {namespace, keys?}}`; "Must specify at least one criteria with findAllWithCriteria", "Cannot filter by pluginData outside of a plugin" | 3187 | C |
| Relaunch data | `setRelaunchData({[command]: description})` (schema: string record), `getRelaunchData()`. "Cannot set relaunch data in a widget". Commands must match `manifest.relaunchButtons`. | 3187 | C |
| Parameters | `parameters.on('input', ({key, query, parameters, result}) => …)`. `result.setSuggestions(list)`: entries are strings or `{name, data?, icon?, iconUrl?}`; `data` must survive JSON ("Contains value which could not be serialized to JSON: …"); `icon` and `iconUrl` are exclusive; `JSON(data).length + icon.length` ≤ **20 480** ("Total size of suggestion must be no greater than 20KB"); `iconUrl` must be http(s) and not figma.com or the app host ("figma.com URLs not supported"). `result.setError(msg)` (not on `allowFreeform`) and `result.setLoadingMessage(msg)`. Only one call per result object ("setSuggestions or setError called multiple times on the same result object"). | 3187 @3601851 | C |

---

## 9. Nodes

### 9.1 Base behaviour

- Node handles are VM objects made from one shared prototype per type, with `type` as a non-writable property. **C**
- `toString()` returns **`[Node <id>]`**. **C**
- `findAll / findOne / findChild / findChildren` run the callback in the VM. A crash in the callback reads `"findAll" callback crashed: <message>`. **C**
- **Deleted nodes**: getters throw for removed nodes ("Node with id <id> not found"). The `removed` flag stays readable. **C** for the message, **I** for the exact rule.
- **Valid ids** match `^(\d+:\d+)|(I(\d+:\d+;)*(\d+:\d+))|(T(\d+:\d+;+\d+:\d+;+\d+:\d+))$`. `T…` is a table-cell id. **C** (2108 `vs`)
- **Type names**:
  - Internal `SYMBOL` is exposed as `COMPONENT`, `CANVAS` as `PAGE`, `REGULAR_POLYGON` as `POLYGON`.
  - `SECTION_OVERLAY` uses the Frame prototype; `BRUSH` uses the Vector prototype.
  - The prototype names are `DocumentNode, PageNode, SliceNode, FrameNode, GroupNode, ComponentNode, ComponentSetNode, InstanceNode, BooleanOperationNode, VectorNode, StarNode, LineNode, EllipseNode, PolygonNode, RectangleNode, TextNode, TextPathNode, TransformGroupNode, StickyNode, HighlightNode, CodeBlockNode, ShapeWithTextNode, ConnectorNode, StampNode, WidgetNode, EmbedNode, LinkUnfurlNode, MediaNode, SectionNode, WashiTapeNode, TableNode, TableCellNode, SlideNode, SlideGridNode, SlideRowNode, InteractiveSlideElementNode, ModuleNode, WebpageNode, CodeLayerNode (CODE_INSTANCE), CodeEmbedNode, SlotNode, RepeaterNode, CmsRichTextNode`.
  - **C** (3187 @3533000)

### 9.2 Members per node type (Design)

Read from the prototype lists. Members marked **(D)** exist only in Design / Draw (`aX`: motion, `animationStyles`, `animations`, `getTimelineOffset`, `manualKeyframeTracks`, `timelines`, `applyAnimationStyle`, `removeAnimationStyle`, `applyManualKeyframeTrack`, `removeManualKeyframeTrack`, `setTimelineDuration`, `setTimelineOffset`, `transitionOverrides`). Dev Mode gets only the read half. **C**

**Members every scene node has** (the base list `a_`):
- `toString, parent, clone, remove, name, removed`
- the 6 plugin-data methods, `setRelaunchData / getRelaunchData`
- `widgetHoverStyle, getCSSAsync, isAsset`
- `getRelatedLinksAsync, addRelatedLinkAsync, editRelatedLinkAsync, deleteRelatedLinkAsync, setRelatedLinkPreviewAsync`
- `getDevResourcesAsync, addDevResourceAsync, editDevResourceAsync, deleteDevResourceAsync, setDevResourcePreviewAsync`
- `detachedInfo, getTopLevelFrame` ("getTopLevelFrame is only available in Figma Design")
- `createCanvasControl` ("createCanvasControl is only available in the Design editor")
- plus `id`, `type`

**Scene mixin** (`aI`): `visible, locked, stuckNodes, attachedConnectors`.

**Variables mixin** (`ab`):
- `componentPropertyReferences`
- `variableConsumptionMap`, `updateVariableConsumption`
- `boundVariables`, `setBoundVariable`
- `resolvedVariableModes`
- `inferredVariables`, `availableInferredVariables`
- `explicitVariableModes`, `setExplicitVariableModeForCollection`, `clearExplicitVariableModeForCollection`

**Layout mixin** (`s`):
- `relativeTransform, absoluteTransform, x, y, width, height, absoluteBoundingBox, absoluteRenderBounds`
- `targetAspectRatio, lockAspectRatio, unlockAspectRatio`
- `gridRowSpan, gridColumnSpan, gridRowAnchorIndex, gridColumnAnchorIndex, gridChildHorizontalAlign, gridChildVerticalAlign, setGridChildPosition`
- `rotation, layoutAlign, resize, resizeWithoutConstraints, rescale, constrainProportions, layoutGrow, layoutPositioning`
- `minWidth, minHeight, maxWidth, maxHeight, layoutSizingHorizontal, layoutSizingVertical`
- `transform3d, transformOrigin`

**Other mixins:**
- **Blend** (`ax`): `opacity, blendMode, isMask, maskType, effects, effectStyleId`
- **Geometry** (`ak`):
  - `fills, fillStyleId, setFillsAsync`
  - `strokes, setStrokesAsync, strokeStyleId, strokeWeight, strokeAlign, strokeJoin, dashPattern, strokeCap, strokeMiterLimit`
  - `outlineStroke, fillGeometry, strokeGeometry`
  - `variableWidthStrokeProperties, complexStrokeProperties`
- **Export** (`aY`): `exportSettings, exportAsync`
- **Reactions** (`aq`): `reactions`
- **Annotations** (`aQ`): `annotations`

**Per-type additions:**

| Type | Built from | Type-specific members | Count |
|---|---|---|---|
| DOCUMENT | base + children + `documentColorProfile` ("documentColorProfile only exists on the root node") | `children, findAll, findOne, findChild, findChildren, appendChild, insertChild, findAllWithCriteria, findWidgetNodesByWidgetId` | 42 |
| PAGE | base + children + `guides, selection, selectedTextRange, backgrounds`, export, `prototypeStartNode, loadAsync`, explicit variable modes, `flowStartingPoints, prototypeBackgrounds`, `on/once/off(nodechange)`, measurements (`getMeasurements, getMeasurementsForNode, addMeasurement, editMeasurement, deleteMeasurement`), `isPageDivider`, Dev Mode: `focusedNode` | page backgrounds: "Prototype page backgrounds must be a single solid paint" / "…must use the normal blend mode"; "page backgrounds cannot be bound to variables" | 62 |
| FRAME | base, scene, variables, blend, layout, children, export, geometry, corners (`cornerRadius, cornerSmoothing, topLeftRadius…`), auto layout (`paddingLeft/Right/Top/Bottom, primaryAxisAlignItems, counterAxisAlignItems, primaryAxisSizingMode, layoutWrap, counterAxisSpacing, counterAxisAlignContent`), grid (`gridRowCount, gridColumnCount, gridRowGap, gridColumnGap, gridRowSizingCSS, gridColumnSizingCSS, gridRowSizes, gridColumnSizes, appendChildAt, gridAutoTracks, gridItemsPositioning, reorderRows, reorderColumns`), stroke sides, `inferredAutoLayout, annotations, layoutGrids, gridStyleId, backgrounds, backgroundStyleId, clipsContent, guides, expanded, constraints, layoutMode, counterAxisSizingMode, horizontalPadding, verticalPadding, itemSpacing, overflowDirection, numberOfFixedChildren, overlayPositionType, overlayBackground, overlayBackgroundInteraction, itemReverseZIndex, strokesIncludedInLayout, devStatus`, `scene3d`, reactions, (D), `playbackSettings` | | 191 |
| GROUP | base, scene, variables, blend, layout, children, export, reactions, (D), `inferredAutoLayout, backgrounds, backgroundStyleId, expanded` | no constraints / cornerRadius: "Groups do not have a constraint property. Please set the constraints on the node's children." | 117 |
| COMPONENT | FRAME + `createInstance, description, descriptionMarkdown, documentationLinks, remote, key, getPublishStatusAsync, instances / getInstancesAsync, variantProperties, componentPropertyDefinitions (+ add/edit/deleteComponentProperty), createSlot` | | 206 |
| COMPONENT_SET | FRAME minus reactions / scene3d / playback + component publishing + `defaultVariant, variantGroupProperties, componentPropertyDefinitions` | | 199 |
| INSTANCE | FRAME + `mainComponent` (+ deprecated `masterComponent`), `getMainComponentAsync, scaleFactor, swapComponent, detachInstance, setProperties, variantProperties, componentProperties, isExposedInstance, exposedInstances, overrides, resetOverrides, removeOverrides` | | 205 |
| BOOLEAN_OPERATION | base, scene, variables, blend, geometry, layout, export, corners, children, `booleanOperation, expanded`, reactions, (D) | | 136 |
| RECTANGLE | full shape list `l` (base, scene, variables, blend, geometry, layout, export, `constraints`) + corners + per-corner radii + stroke sides + reactions + (D) + playback + annotations | | 136 |
| LINE | `l` minus `targetAspectRatio, lockAspectRatio, unlockAspectRatio` + reactions … | | 123 |
| ELLIPSE | `l` + corners + `arcData` … | | 129 |
| POLYGON / STAR | `l` + corners + `pointCount` (+ `innerRadius` on STAR) … | | 129 / 130 |
| VECTOR | `l` + corners + `vectorNetwork, vectorPaths, handleMirroring` (+ `setVectorNetworkAsync`) … | "Cannot set width and height of vector node to zero" | 132 |
| TEXT | `l` + text (`characters, insertCharacters, deleteCharacters, hasMissingFont, fontSize, hangingPunctuation, hangingList, paragraphIndent, paragraphSpacing, listSpacing, textCase, textDecoration, textDecorationStyle, textDecorationSkipInk, textDecorationOffset, textDecorationThickness, textDecorationColor, letterSpacing, lineHeight, leadingTrim, fontName, fontWeight, openTypeFeatures, hyperlink`, all `getRange* / setRange*` incl. `TextWrapStyle`, `getStyledTextSegments, canUpgradeToNativeBidiSupport, useNativeBidiSupport, autoRename, textAlignHorizontal, textAlignVertical, textAutoResize, textStyleId, textTruncation, textWrapStyle` (gate `ce_tl_text_wrap_balance_pretty`), `maxLines`) | | 211 |
| TEXT_PATH | `l` + reduced text list (`aM`) + corners + read-only vector + `textPathStartData` | "textPathStartData can only be set on TextPathNodes" | 198 |
| TRANSFORM_GROUP | GROUP-like + `expanded, transformModifiers` | | 115 |
| SECTION | base, scene, children, fills, variables, aspect ratio, corners, strokes, per-corner radii, `resizeWithoutConstraints, resize`, (D), `sectionContentsHidden, devStatus` | "Cannot resize hidden sections" | 102 |
| SLICE | base, scene, variables, layout, export | | 83 |
| SLOT | FRAME list + `resetSlot, limitViolations` | "Cannot reset slot on a non-slot node"; "GRID layoutMode cannot be applied to Slot frames" | 177 |

Other editors' types (FigJam / Slides / Buzz / Sites; listed, out of scope):
- STICKY: `text, authorVisible, authorName, isWideWidth`
- CONNECTOR: `connectorStart / End, connectorLineType, connectorStartStrokeCap / EndStrokeCap, text, textBackground`
- SHAPE_WITH_TEXT: `shapeType`
- CODE_BLOCK: `code, codeLanguage`
- STAMP: `getAuthorAsync` (needs `fileusers`: "Not allowed to fetch author. To do so add 'fileusers' to the permission field of your plugin's manifest.json")
- WIDGET: `widgetId, widgetSyncedState, setWidgetSyncedState, cloneWidget`
- TABLE: `numRows, numColumns, cellAt, insertRow / Column, removeRow / Column, moveRow / Column, resizeRow / Column`
- TABLE_CELL: `rowIndex, columnIndex, text`
- SLIDE: `getSlideTransition, setSlideTransition, isSkippedSlide`
- EMBED: `embedData`; LINK_UNFURL: `linkUnfurlData`; MEDIA: `mediaData`
- WEBPAGE: `isHomepage, webMetadata` ("Cannot modify webMetadata outside of Sites editor")
- **C**

### 9.3 Setter rules worth copying (errors, all C, 3187)

| Area | Rule / text |
|---|---|
| Auto layout | "Can only set layoutPositioning = ABSOLUTE if the parent node has layoutMode !== NONE"; "Can only set layoutWrap = WRAP on nodes with layoutMode === HORIZONTAL or VERTICAL"; "counterAxisAlignItems = BASELINE can only be set when layoutMode === HORIZONTAL"; "Can only set strokesIncludedInLayout on nodes with layoutMode !== NONE"; "Can only set itemReverseZIndex on nodes with layoutMode !== NONE"; "numberOfFixedChildren must be <= the number of children in the node"; `${e} cannot be set to 0, use null to unset` / `…to Infinity…` (min / max sizes); "Can only set ${e} on auto layout nodes and their children" |
| Grid | "gridAutoTracks requires layoutMode === 'GRID'"; "primaryAxisAlignItems must be 'MIN' when layoutMode is 'GRID'" (same for counter); "Grid track size value must be non-negative for FIXED tracks"; "Grid track sizes must be the same length as the grid <row\|column> count"; "cannot set grid row count manually while GridAutoTracks is set to ROWS"; "Column index … out of bounds for grid with N columns and M rows"; "cannot set grid child position directly inside of a grid with automatically positioned items, use parent.insertChild() instead to change the layer index." |
| Text | "Cannot insert characters at index greater than the length of the text"; "deleteCharacters must have (start <= end)"; "Range outside of available characters. 'start' must be less than node.characters.length and 'end' must be less than or equal to node.characters.length"; "Empty range selected. 'end' must be greater than 'start'"; "selectedTextRange must have (start <= end)"; `"SMALL_CAPS" not supported by one or more fonts`; "Text decoration color must be a single solid paint" |
| Paints | "Cannot set IMAGE fill without an imageHash. Use figma.createImage() first, or omit this fill from the array."; "Image rotation must be a factor of 90 degrees" / "…less than 360 degrees"; "Image scaleFactor must be greater than 0"; "fills and strokes variable bindings must be set on paints directly" |
| Components | "Cannot swap to non-component node"; "Cannot detach a non-instance"; "Duplicate property types are not allowed"; "componentProperties variable bindings must be set on componentProperties directly"; "Maximum allowed description length is 1000 characters"; "Documentation links API takes a list of size 0 or 1"; "Documentation link must be a URL" |
| devStatus | "Cannot set devStatus on a node that is not directly under a page or section"; "Cannot set devStatus on a node inside another node with non-null devStatus" |
| Reactions | "Please update the `actions` field instead of the `action` field in order to prevent data loss."; plan gates: "You cannot use Conditional actions in Reactions with your current plan." (also Set Variable, Set Variable Mode, multiple actions); "Actions only support overlayRelativePosition when navigation is "OVERLAY" and the destination is a frame with overlayPosition equal to "MANUAL"" |
| Annotations | "Setting an annotation with no content is invalid, set the annotations field to [] instead"; measurements: "Measurement can't point to itself", "Measurement start side X and end side Y must be on the same axis" |
| Viewport | "viewport.zoom expects a positive number"; "Call to scrollAndZoomIntoView expected an array"; "Cannot modify viewport in queryMode" |
| Export | "Cannot set useAbsoluteBounds for ExportSetting on node that is not type text." (as written, oddly) |

---

## 10. Plugins in the editor

### 10.1 Plugins ▸ (main menu and canvas menu; module 381085)

The menu is built from the saved, recent, development and organisation plugins. **C** (figma_app @1392142)

Hidden entirely in canvas edit modes (vector edit etc.). Order:

1. **Recents**: header `fullscreen_actions.recents`, at most **6** recently used plugins (unpurchased ones hidden). Each is a run item, or a submenu when the manifest has `menu`. Plugins whose `parameters` exist open the parameter entry (parameterOnly unless `parameterOnly:false`).
2. — separator (only if there were recents).
3. **Run last plugin** `plugins-run-last` ⌥⌘P (disabled when there is nothing to re-run).
4. — then **Saved plugins ▸** (`fullscreen_actions.plugins-menu-saved-plugins`, plugins installed by the user).
5. **From ‹org› ▸** (`whiteboard.inserts.plugin_from_org`, "your org" fallback).
6. **Development ▸** (`widgets.development`), desktop app only:
   - every local plugin: a run item; a submenu for a `menu`; or a submenu holding "⚠ Plugin missing" / "⚠ Manifest issue" (disabled), "Show error details…" and "Show in Finder" / "Show in Explorer" (`plugin_development_options_finder` / `…_explorer`, VS Code: `open_directory_vscode`);
   - **Manage plugins in development** (when any local plugin is valid);
   - —, **New plugin…** (`plugin_development_options_new_plugin`, icon plus), **Import plugin from manifest…** (`…_import_plugin`, icon import);
   - —, **View API documentation** (`view_api_documentation`, external link), **Show/Hide console** (`toggle_console`), **Use developer VM** (`use_developer_vm`, check item bound to `useRealmsForPluginDev`), **Hot reload plugin** (`hot_reload_plugin`, check item bound to `hotReloadPluginDev`, **default on**).
7. — **Manage plugins…** (`browse-plugins` → `fullscreen_actions.manage-plugins`).

Variants:
- **View-only** files show "Saved plugins" only, or the disabled "Unavailable in view-only".
- **Text review plugins ▸** is a separate submenu: every saved, recent or local plugin with capability `textreview` ("(dev) ‹name›" for local ones), plus "None". **C**

Widgets ▸ (module 194524):
- the widget run items;
- **Development ▸** with the same error rows and "Manage widgets in development";
- **New widget…** / **Import widget from manifest…**;
- "Manage widgets…", "Select all widgets" (live capture).

On a selected widget the canvas menu offers:
- "Re-render widget" (`widgets.re_render_widget`);
- "Reset widget state" (`widgets.reset_widget_state`);
- "View widget details";
- "Copy widget as layers" (`widgets.copy_as_layers`);
- "Update to latest version" (when a newer version exists).

**C**

### 10.2 Running, toasts, hot reload

| Item | Value | Evidence | |
|---|---|---|---|
| Running toast | Type `plugins-status`, text `fullscreen.plugins.running` ("Running ‹name›"; with the developer VM the name gets " (Developer VM)"). Spinner icon. Button **Cancel** (or **Stop** for background runs). It appears after **300 ms** (`delay` default); panel iframes wait **4000 ms**, background runs **50 ms**. Background: no icon, no timeout. Finished: check icon for **1000 ms**. While the UI is visible the toast is hidden; hiding the UI shows it again. | 3187 @3840531; 2108 `showProgress` | C |
| Toasts not shown | For runs triggered by `codegen`, `design-linter` or `ai-assistant`. | 2108 | C |
| Inserting widgets | `fullscreen.plugins.inserting` | 3187 | C |
| Stopped | `fullscreen.plugins.stopped` | 3187 | C |
| Run last | ⌥⌘P / Ctrl+Alt+P re-runs the last plugin with the same command and parameters. | chapter 03 | C |
| Hot reload | The desktop app watches each local plugin's code, manifest and UI files. On a change to the running plugin's `manifestFileId`, with `hotReloadPluginDev` on, the plugin is re-run (unless it was triggered by codegen or the linter). A selected widget is re-mounted ("hot-reloading re-render"). | figma_app @734001 | C |
| Console | "Show/Hide console" opens the desktop devtools. Plugin `console.*` goes to the app console. | menu action `toggle-console` | C (mapping), I (devtools) |
| Logged out | `plugins.cannot_run_plugin_logged_out` / `…widget…` | 3187 | C |
| Load errors | `plugins.error_loading_environment_plugin / _widget / _tool`; `plugins.no_code_found_for_plugin / _widget` | 3187 | C |
| Quick actions | Plugins are listed in ⌘K (tab "Plugins & widgets"); ⇥ opens parameter entry ("Tab" / "Enter", `fullscreen_actions.plugin_parameters.*`); loading text `qa.parameter.loading.plugin`. | chapter 03 §5 | C |
| Dev Mode | Plugins tab ⌥9; codegen plugins in the Inspect language menu. | chapter 14 | C |

### 10.3 Development templates

- "New plugin…" offers editor types Figma / FigJam / Slides / Buzz / Dev Mode, and templates by editor. **C**
- Design template: "Rectangle Creator" with a Count input, value **5**, and Create / Cancel buttons. **C**
- FigJam: "Shape & Connector Creator"; Slides: "Slide Creator"; Buzz: "Frame Creator"; more than one editor: "Shape Creator". **C**
- A selection-change observer template and a codegen template. **C**
- TypeScript templates hold a `code.js` stub that throws "This plugin template uses TypeScript. Follow the instructions in `README.md` to generate `code.js`." **C**

Evidence: 3187 @3065969 region.

---

## 11. Widgets

| Item | Value | Evidence | |
|---|---|---|---|
| Manifest | `containsWidget: true`, `widgetApi: "1.0.0"`; editor types figma / figjam (not slides). | §5.2 | C |
| VM | Always `cppvm`. Widgets register through `figma.widget.register(fn)`. Without it, a local widget fails with "widget missing call to figma.widget.register". | 3187 run function | C |
| `figma.widget` | `register, waitForTask(promise)` ("waitForTask can only be called in useEffect or an event handler"), `colorMapToOptions(map)` (tooltip = the key split on capitals and title-cased), hooks `useSyncedState(key, default)`, `useSyncedMap(name)` (`get, set, delete, has, keys, values, entries, size, length`), `usePropertyMenu(items, cb)`, `useEffect(fn)`, `useWidgetId()` (alias `useWidgetNodeId`), `useStickable`, `useStickableHost`, `useHideCursors`. Hooks outside rendering: "Cannot use <hook> hook outside of widget rendering." | 3187 @3651749 | C |
| Built-in components | `AutoLayout, Frame, Text, Rectangle, Ellipse, Image, SVG, Input, Line, Fragment, Span` (Span only inside Text: "Span is not valid outside of a Text component"), internal `Instance`. Errors: "<X> is not a built in component", `Invalid node child of type "<t>": …`. | 3187 @3892432 | C |
| Lifecycle commands | `mount, rerender, rerenderSync, click, propertymenu, textEditEnd, attachedStickablesChanged, stuckStatusChanged`. The code's MD5 is kept in plugin data key `localWidgetCodeMD5`; local code changes re-render. | 3187 | C |
| Synced state | Default value function may not return `undefined` ("Cannot return undefined from default value function in useSyncedState"). Writing during render: "Cannot call setSyncedState while widget is rendering." (also `map.set` / `map.delete`). Invalid values: "Invalid syncedState value for widgetID=… name=… value=…". | 3187 | C |
| Lockdown | During render, API members flagged not-W throw `Widget Rendering Error: Cannot use "<key>" during widget rendering.` (e.g. `notify`, `showUI`, `clientStorage`, `loadFontAsync`, `getNodeByIdAsync`, `ui.*`). | 3187 `handleLockDownPluginApiError` | C |
| WidgetNode | `widgetId, widgetSyncedState, setWidgetSyncedState(state, map?), cloneWidget(state, map?)`; `PageNode.findWidgetNodesByWidgetId(id)`. | 3187 | C |
| Render limits | No node-count or time limit was found in the JS. Any limit lives in the C++ renderer. | rg: none | I |

---

## 12. UI strings

The build carries i18n keys. English is given only where the build or a repo capture attests it.

- Menu labels with English **literal in the build** (3187 label map): "Show error details…", "⚠ Plugin missing", "⚠ Manifest issue", "Unavailable in view-only", "Developer VM", "Add plugin from key…", "Add plugin from file…", "Reload", "Remove…", "Run…", "Share…", "Deprecated plugins…", "Not available", "Text review plugins", "None", "(dev) ‹name›".
- Live capture (`docs/research/figma/live/menus/main-plugins.txt`, browser): "Run last plugin" ⌥⌘P, "Saved plugins", "Manage plugins…"; Widgets: "Manage widgets…", "Select all widgets".
- Keys (English from Figma's help where known, otherwise unattested):
  - `fullscreen_actions.plugins-run-last` (Run last plugin)
  - `fullscreen_actions.plugins-menu-saved-plugins` (Saved plugins)
  - `fullscreen_actions.recents`
  - `fullscreen_actions.manage-plugins` (Manage plugins…), `fullscreen_actions.manage-widgets`
  - `widgets.development` (Development)
  - `whiteboard.inserts.plugin_development_options_new_plugin` (New plugin…), `…_import_plugin` (Import plugin from manifest…), `…_finder` (Show in Finder), `…_explorer`
  - `fullscreen_actions.manage_plugins_in_development`, `fullscreen_actions.view_api_documentation`, `fullscreen_actions.toggle_console`, `fullscreen_actions.use_developer_vm`, `fullscreen_actions.hot_reload_plugin`
  - `fullscreen.plugins_menu.open_directory_vscode`, `whiteboard.inserts.plugin_from_org`
  - `whiteboard.inserts.widget_development_options_new_widget / _import_widget`, `whiteboard.inserts.widget_development_import_manifest`, `whiteboard.inserts.widget_development_error_modal_{title,description,close}`
  - `fullscreen.plugins.{running, stopped, inserting, background, cancel, stop}`
  - `plugins.{loading_plugin, loading_pages_for_plugin, loading_pages_for_widget, cancel_loading_pages, cannot_run_plugin_logged_out, cannot_run_widget_logged_out, error_loading_environment_plugin, error_loading_environment_widget, error_loading_environment_tool, error_occured_while_running_plugin, error_occured_while_running_widget, error_occured_while_running_tool, error_occured_while_running_tool_with_count, no_code_found_for_plugin, no_code_found_for_widget}`
  - `fullscreen_actions.plugin_parameters.{enter, tab, to_run_plugin, to_enter_optional_parameters, optional_optional_names}`, `qa.parameter.loading.plugin`, `qa.plugins`, `qa.plugins_widgets`, `qa.extensions.plugin`, `qa.extensions.widget`
  - `widgets.{insert_widget, re_render_widget, reset_widget_state, copy_as_layers, update_to_latest_version, could_not_find_widget_code_to_run, cannot_insert_widget_while_logged_out, widget_can_only_run_in_figma, widget_can_only_run_in_figjam, this_widget_is_not_allowed_by_your_organization, you_cannot_use_this_widget, paid_widgets_can_only_be_run_after_purchasing}`
  - `textreview.{use_plugin_name_title, use_plugin_name_confirm, as_you_type_plugin_name_will_review_your_text_and_provide_suggestions}`
  - `extension_request_modal.*` (approval requests, see docs/plugins.md §1)
  - `general.file_type.plugin` / `.widget`
- Runtime messages in English (literal; full list in §§2–9): "Plugin runtime aborted", "Failed to load plugin sandbox", "Client storage quota (5 MB) exceeded for this plugin ID. Please use less client storage.", "This pluginData entry exceeds 100 kB per entry limit.", "Cannot call with documentAccess: dynamic-page. Use … instead.", "Inspect panel plugins must have an iFrame when running", "Text review plugins must call on('textreview') upon running".

---

## 13. DesignerV2 today

What the repo has (`src/renderer/src/editor/plugins/`; contract `docs/plugins.md`):
- QuickJS sandbox, with a 256 MB memory limit, a 1 MB stack and a **20 s slice timeout** (`host.ts` `SLICE_TIMEOUT_MS`).
- A V8 worker as the developer VM.
- A `plugin:` scheme UI iframe.
- `clientStorage` in main with a 5 MiB quota.
- Plugin data with a 100 kB limit.
- Codegen, parameters, a Plugins menu and a Development submenu.
- The members below were listed by evaluating `runtime/figma.js`.

### 13.1 Matches

| Area | Status |
|---|---|
| UI defaults | 300 × 200, width ≥ 70, height ≥ 0 (host.ts:305). Matches. |
| `clientStorage` quota | 5 × 1024 × 1024 (`src/main/plugins/storage.ts:13`). Matches; the size accounting differs (see 13.2). |
| Plugin data | 100 kB per entry. Matches the number. |
| `dynamic-page` | Sync APIs throw under `dynamic-page`. The text differs (13.2). |
| `ui.*` | `show, hide, resize, reposition, getPosition, close, postMessage, onmessage, on, once, off`: all present. |
| `figma.util`, `annotations`, `teamLibrary` | All members present. |
| `figma.variables` | All except `getSubscribedVariables`. |
| Events | `run, close, selectionchange, currentpagechange, documentchange, drop, stylechange` work. |

### 13.2 Differs (each needs a decision or a fix)

| # | Figma | DesignerV2 |
|---|---|---|
| D1 | `node.toString()` → `[Node <id>]` | `[object TYPE id]` (runtime/figma.js:63) |
| D2 | Sync-API error: `Cannot call with documentAccess: dynamic-page. Use <name> instead.` (no API name in the first half) | `Cannot call figma.getNodeById with documentAccess: dynamic-page. Use figma.getNodeByIdAsync instead.` (text differs) |
| D3 | `notify` default timeout **3000 ms**, **∞ when `error: true`**, raised to at least **100 ms** | Default **4000 ms** whatever `error` is, and no minimum (host.ts:774). The codegen answer timeout is 3000 ms (host.ts:426, "Code generation timed out"), which matches the help-site 3 s |
| D4 | No per-slice time limit in JS (limits only in the C++ VM; unknown) | 20 s slice timeout ("took too long") |
| D5 | UI CSP = `default-src data: blob: <D>`, `script-src / style-src 'unsafe-inline' 'unsafe-eval' data: blob: <D>`, `font-src static.figma.com/webfont/ data: blob: <D>`; **no CSP at all for `*`**; no `connect-src` | `default-src 'none'` + `connect-src <S>` + `frame-src`, `form-action 'none'`, `base-uri 'none'`; `*` → `https: wss:` (docs/plugins.md §3.2) |
| D6 | `allowedDomains` entries **must include a scheme** (error); `*` / localhost without `reasoning` is an **error**; `reasoning` ≤ 1000; duplicates and empty list are errors | Bare hosts accepted (`"figma.com"` → https + wss); missing `reasoning` is a **warning** (src/shared/plugins/manifest.ts) |
| D7 | Manifest error texts (§5.2), including "Missing editorType in manifest.  Specify a combination of […]" | Own wording ("This plugin doesn't run in Figma Design or Dev Mode", "A codegen plugin needs …") |
| D8 | `clientStorage` size = key length + JSON size with strings counted by length | Check storage.ts accounting |
| D9 | `pluginData` limit counts UTF-8 bytes of key + value (+ namespace); text "This pluginData entry exceeds 100 kB per entry limit."; namespace rules 3–1000 chars `[A-Za-z0-9_.]` | `key.length + value.length` (UTF-16), text "Plugin data is limited to 100 kB per entry" (api/nodes.ts:714); namespace rules not seen |
| D10 | `fileKey` only with private API / `filekey` | Same idea (private API). Matches |
| D11 | `fetch` is a **global**, not `figma.fetch` | Both `figma.fetch` and global `fetch` (extra member `figma.fetch`) |
| D12 | `documentchange` reports `strokeTopWeight` as `stokeTopWeight` | Not reproduced (verify what the repo sends) |
| D13 | Node members by type: GROUP / BOOLEAN_OPERATION / SLICE / TRANSFORM_GROUP have **no** `constraints` / `devStatus` / `annotations`; SECTION has corners and no `layoutAlign` / grid-child / min-max / `rotation` / `reactions`; COMPONENT_SET has no `reactions`; LINE has no aspect-ratio methods | The repo puts `devStatus` on every scene node, `constraints` on groups, the full layout list on SECTION, `reactions` on SLICE / SECTION / COMPONENT_SET, and the aspect-ratio methods on LINE |
| D14 | TEXT has no `setRangeFontWeight` / `setRangeOpenTypeFeatures` (get only) | Defines both setters (extra) |
| D15 | COMPONENT has no `setProperties` | Defines one that throws (extra) |
| D16 | PAGE has no `setBackgroundsAsync` | Extra member |
| D17 | Show UI position `"last"` (saved per plugin in `localStorage["plugin-positions"]`, clamped), `codegen-default`, `windowSpace` / `anchor` forms; context-menu click position | Only `{x, y}` in canvas space (host.ts:297); no saved per-plugin position, no `windowSpace` / `anchor` / context-menu placement |
| D18 | Running toast: 300 ms delay, Cancel / Stop button, hidden while UI is visible, check for 1000 ms on finish; name suffix " (Developer VM)" | "Running {name}" with Close (ui/PluginLayer.tsx); timings unverified |
| D19 | Development ▸ order: plugins → Manage plugins in development → — New plugin… / Import plugin from manifest… → — View API documentation / Show/Hide console / Use developer VM / Hot reload plugin; **Recents (≤ 6) are above Run last plugin**; Saved plugins ▸ after it | Repo: Run last → — Saved plugins ▸ + recents → — Development ▸ (New, Import, plugins, — Hot reload, Developer VM, Open console) → From org → — Manage plugins… (menus.ts). Order, recents position, "Manage plugins in development", "View API documentation" and the "Show/Hide console" wording differ |
| D20 | Hot reload on by default, re-runs on code / manifest / ui file change | Present as a menu item; default unverified |
| D21 | `import` expression regex check with "possible import expression rejected around line N" | Not present |
| D22 | API version must be `0.6.0` or `1.0.0` | Not checked |

### 13.3 Missing members

The figma global (Design-relevant). Gated or internal members are marked:
- `getSubscribedVariables` (variables)
- `createVideo` (sync; `createVideoAsync` is a stub)
- `getFontFamilyVariationAxes` (gate)
- `createCustomAnimationStyle`, `getLocalCustomAnimationStyles(Async)`, `moveLocalCustomAnimationStyleAfter`, `moveLocalCustomAnimationFolderAfter` (gate `metronome_styles_plugin_api`)
- `reconcileNodeFromJSXAsync` and `createNodeFromJSXAsync` (stub)
- `listAvailableShaders`, `importShaderById` (gate)
- `figma.motion` (stub), `figma.lint` (`detect` / `fix` events), `figma.relatedLinks`, `figma.textreview` (stub), `figma.timer` (stub), `figma.payments` (stub), `figma.ai` (gated)
- `viewport.canvasView` / `slidesView` (Buzz / Slides)
- `widgetId` and the whole widget API (§11)
- `closePluginWithFailure` (test only)
- `getDisplayMetadataAsync` (`displaycapture`)
- `getHTMLString`, `kiwi`, `internal` (internal)
- `moveLocal*FolderAfter` exist but throw (not supported)
- `devResources.*` and `node.get/add/edit/deleteDevResourceAsync` throw

Missing on **every** Design node type (23):
- `addRelatedLinkAsync, getRelatedLinksAsync, editRelatedLinkAsync, deleteRelatedLinkAsync, setRelatedLinkPreviewAsync, setDevResourcePreviewAsync`
- `availableInferredVariables, variableConsumptionMap, updateVariableConsumption`
- `createCanvasControl, widgetHoverStyle`
- motion (D): `animationStyles, animations, applyAnimationStyle, removeAnimationStyle, applyManualKeyframeTrack, removeManualKeyframeTrack, manualKeyframeTracks, getTimelineOffset, setTimelineOffset, setTimelineDuration, timelines, transitionOverrides`

Missing per type (beyond the common list):

| Type | Missing |
|---|---|
| FRAME | `appendChildAt, backgroundStyleId, backgrounds, constrainProportions, gridAutoTracks, gridColumnSizingCSS, gridRowSizingCSS, gridItemsPositioning, horizontalPadding, verticalPadding, inferredAutoLayout, playbackSettings, reorderColumns, reorderRows, scene3d, transform3d, transformOrigin` |
| COMPONENT | FRAME's list + `createSlot, instances` |
| COMPONENT_SET | FRAME's list minus `playbackSettings, scene3d` |
| INSTANCE | FRAME's list + `masterComponent` (deprecated alias) |
| GROUP | `backgroundStyleId, backgrounds, constrainProportions, detachedInfo, expanded, inferredAutoLayout, setGridChildPosition, transform3d, transformOrigin` |
| SECTION | `cornerRadius, cornerSmoothing, topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius, detachedInfo` |
| BOOLEAN_OPERATION | `constrainProportions, cornerRadius, cornerSmoothing, detachedInfo, expanded, setGridChildPosition, transform3d, transformOrigin` |
| RECTANGLE / LINE / ELLIPSE / POLYGON / STAR / VECTOR | `constrainProportions, detachedInfo, playbackSettings, setGridChildPosition, transform3d, transformOrigin` |
| TEXT | the shape list + `textDecorationColor, textDecorationOffset, textDecorationSkipInk, textDecorationStyle, textDecorationThickness, textWrapStyle, getRangeTextWrapStyle, setRangeTextWrapStyle, canUpgradeToNativeBidiSupport, useNativeBidiSupport` |
| TEXT_PATH | the shape list + `cornerRadius, cornerSmoothing` + `get/setRange` of `Indentation, LineHeight, ListOptions, ListSpacing, ParagraphIndent, ParagraphSpacing, TextDecoration(+Color, Offset, SkipInk, Style, Thickness), TextWrapStyle` |
| TRANSFORM_GROUP | `constrainProportions, detachedInfo, expanded, setGridChildPosition, transform3d, transformOrigin` |
| PAGE | `exportAsync, exportSettings, explicitVariableModes, setExplicitVariableModeForCollection, clearExplicitVariableModeForCollection, focusedNode` (Dev Mode), measurements (`getMeasurements, getMeasurementsForNode, addMeasurement, editMeasurement, deleteMeasurement`), `on / once / off('nodechange')`, `detachedInfo` |
| DOCUMENT | `clone` (exists in Figma's base list), `detachedInfo` |
| SLOT | everything of FRAME (the repo has no SLOT prototype; it falls back to scene + layout + blend), + `resetSlot, limitViolations` |

Also missing outside the API:
- widgets entirely;
- `textreview` / `linkpreview` / `lint` capabilities;
- the three-iframe isolation (the repo uses one sandboxed iframe on its own scheme, which is a fair equivalent);
- the "Text review plugins" submenu.

### As built (2026-10-18, wave 7)

Branch "plugins", in §13's order. Tests: `plugins/__tests__/parity.wasm.test.ts` (12, new), the changed `plugins.wasm.test.ts`, `service.wasm.test.ts`, `src/shared/plugins/plugins.test.ts`, `src/main/plugins/plugins.test.ts`.

**§13.2 — the differences:**
- **D1** `toString()` is `[Node <id>]`.
- **D2** dynamic-page: one text, Figma's — `in <name>: Cannot call with documentAccess: dynamic-page. Use <async name> instead.` (`in get_mainComponent: … Use node.getMainComponentAsync instead.`, `in getNodeById: … Use figma.getNodeByIdAsync instead.`) for every pair of §6.3: `getNodeById`, `getStyleById`, `getFileThumbnailNode`, `getLocal*Styles`, the four variables lookups, `currentPage =`, `mainComponent` (and `masterComponent`), `instances`, the `fillStyleId` / `strokeStyleId` / `effectStyleId` / `gridStyleId` / `textStyleId` / `backgroundStyleId` setters, `reactions =`, `vectorNetwork =`, `setRangeTextStyleId` / `setRangeFillStyleId`. The "in <name>: " prefix is Figma's host-call wrapper (§2.1) applied to these names [derived]. `documentchange` under dynamic-page needs `loadAllPagesAsync` first (Figma's text).
- **D3** `notify`: 3000 ms by default, until dismissed for `error: true`, at least 100 ms (`Infinity` travels as a string, JSON can't carry it); a toast over 3000 ms (or lasting) gets ×; the button's `action()` returning `false` keeps the toast (ds `ToastOptions.keepOnAction`); `onDequeue` hears `"timeout"`, `"dismiss"` (× or `cancel()`) or `"action_button_click"` [the three names are `@figma/plugin-typings`' `NotifyDequeueReason`]. The toast's time is "exact" (not halved by the queue).
- **D5** CSP: **kept ours** (stricter than Figma's — `default-src 'none'`, `connect-src`, `form-action 'none'`, `base-uri 'none'`, and a CSP for `*` too). The task's rule: the sandbox and CSP stay at least as strict as before.
- **D6** `allowedDomains` with Figma's validator texts (§4.1): an entry needs its scheme (`'figma.com' must include a scheme, such as https://.`), `*` and localhost / ports without `reasoning` are errors, `reasoning` < 1000, duplicates, the empty list, `'none'` alone; `devAllowedDomains` entries must be valid URLs (a bare host there still means https + wss). URL matching takes Figma's scheme rule (§4.3): an `http:` entry also covers https, `ws:` covers wss / http / https, `wss:` covers https. Bare hosts already stored keep working at run time (the manifest refuses them on import).
- **D7** manifest texts (§5.2): `Missing editorType in manifest.  Specify a combination of [...]` (editorType is now required), `Invalid editorType …`, `Invalid permission specified: <p>`, `Invalid capability specified: <c>`, `Capability "<c>" requires "editorType" to include "dev"`, the three codegen texts, the duplicate relaunch command, `manifest.parameters should not be specified when menu items are defined`, the parameter list rules (empty, duplicate keys, optional last, `parameterOnly`), `The manifest editorType does not include "figma"` for a plugin that runs in neither editor. `inspect` is read as `dev`; `sites` is accepted (not run). Permissions take `clipboardwrite`; Figma's internal ones are accepted and dropped with "Untrusted local plugin denied internal api permissions" (a warning); capabilities take `panel`, `linkpreview`, `lint` (accepted, nothing runs them yet).
- **D8** `clientStorage`: a string counts by its length (not its JSON); the quota text is Figma's ("Client storage quota (5 MB) exceeded for this plugin ID. Please use less client storage.").
- **D9** plugin data: the limit counts UTF-8 bytes of key + value (+ namespace), "This pluginData entry exceeds 100 kB per entry limit."; the namespace's three rules and texts, checked on get too.
- **D11** `fetch` is a global only (no `figma.fetch`).
- **D12** `documentchange` names the four stroke sides — the top one `stokeTopWeight`, Figma's typo.
- **D13–D16** each type's prototype from Figma's mixin lists (figma.js `TYPES`): no `constraints` / `devStatus` / `annotations` on groups, boolean operations, slices and transform groups; sections have dimensions, fills, strokes, corners, `devStatus`, aspect-ratio lock and motion but no layout list, blend, reactions or export; component sets have no reactions; lines no aspect-ratio methods; slices no blend, reactions or motion; no `setRangeFontWeight` / `setRangeOpenTypeFeatures`, no `setProperties` on components, no `setBackgroundsAsync` on pages.
- **D17** the UI window: 300 × 200, width clamped to 70 … window − 50, height to 0 … window − 48 − the title bar; no position → this plugin's last place (kept per plugin on drag and on `ui.reposition`, clamped into the window) else centred; `{windowSpace: true, x, y}` taken as is; `width` / `height` must be integers ≥ 0, `ui.resize` positive integers; "No UI to send a message to." / "No UI to resize." / "No UI to reposition." / "No UI to show." / "Cannot get the UI position." + " Did you forget to create a UI by calling showUI?".
- **D18** the running toast: shown 300 ms after the run asks for it, a spinner, **Cancel** (= Stop), hidden while the UI shows; a run that ends under it leaves a check for 1000 ms; " (Developer VM)" after the name in the developer VM (ds `Toast` `spinner`).
- **D19** Plugins ▸ in Figma's order, the same in the canvas menu: recents (≤ 6) and a line, Run last plugin, —, Saved plugins ▸, From ‹org› ▸, Development ▸ (the plugins, Manage plugins in development, —, New plugin…, Import plugin from manifest…, —, View API documentation, Show/Hide console, Use developer VM, Hot reload plugin), —, Manage plugins….
- **D20** hot reload is on by default (it was) — matches.
- **D21** the `import` check before the code runs: `possible import expression rejected around line N` (SES's pattern: `import` followed by `(`, `//` or `/*`, not `.import`).
- **D22** `Unknown plugin api version "<v>"` outside 0.6.0 / 1.0.0, and "Code string cannot be empty".

**§13.3 — members added:**
- Every node: `clone` (the document refuses), `detachedInfo`, dev resources (`get` with `includeChildren` / `add` / `edit` / `deleteDevResourceAsync` through Dev Mode's store records, `RunEnv.devResources`), the related-link methods (Figma's "not available for local plugins" text), `availableInferredVariables` / `variableConsumptionMap` (empty, as `inferredVariables`), `explicitVariableModes` read from the node's `variableModeBySetMap` (it answered `{}`), `setDevResourcePreviewAsync` / `updateVariableConsumption` / `createCanvasControl` (not supported).
- Frames and their kin: `backgrounds` / `backgroundStyleId` (deprecated names of `fills` / `fillStyleId`, also on groups), `horizontalPadding` / `verticalPadding`, `constrainProportions`, `targetAspectRatio` (from the document's field; it answered null), `gridAutoTracks`, `gridRowSizes` / `gridColumnSizes` (Figma's GridTrackSize, its two texts), `gridRowAnchorIndex` / `gridColumnAnchorIndex` / `gridRowSpan` / `gridColumnSpan` (they answered undefined), `setGridChildPosition` (Figma's refusal inside a grid that places its items, `gridReflowEnabled`), `appendChildAt`, `reorderRows` / `reorderColumns`.
- COMPONENT `instances` (sync), INSTANCE `masterComponent`, GROUP / BOOLEAN_OPERATION `expanded`, SECTION corners.
- TEXT: `textDecorationStyle` / `Offset` / `Thickness` / `Color` / `SkipInk` (node and range, Figma's shapes; "Text decoration color must be a single solid paint"), `textWrapStyle` (+ `getRangeTextWrapStyle`), `canUpgradeToNativeBidiSupport` / `useNativeBidiSupport()` (Type settings' bidi upgrade).
- PAGE: `exportAsync` (its top-level layers together) / `exportSettings`, `explicitVariableModes` and the set / clear pair (the page's own mode), `focusedNode` (Dev Mode's focus), measurements (`getMeasurements`, `getMeasurementsForNode`, `addMeasurement`, `editMeasurement`, `deleteMeasurement` over MEASUREMENT_*; "Measurement can't point to itself", "Measurement start side X and end side Y must be on the same axis"), `on` / `once` / `off("nodechange")` (the changes grouped by page).
- figma: `variables.getSubscribedVariables` (the file's library copies), `createVideo` (not supported), `relatedLinks` (Figma's text), `lint` (later list).

**Not done (and why):**
- Widgets (§11) — the whole widget API, `widgetId`, Widgets ▸ and the widget node: a round of its own (render, synced state, hooks, the canvas node).
- `transform3d` / `transformOrigin` / `scene3d`, `playbackSettings` (video), `inferredAutoLayout`, `gridItemsPositioning`, `gridRowSizingCSS` / `gridColumnSizingCSS`, `createSlot` / SLOT nodes, `getFontFamilyVariationAxes`, custom animation styles, shaders, `figma.ai`, `figma.timer` / `payments` / `textreview` / `lint` behaviour, `getDisplayMetadataAsync`: gated, other editors', or not in our document yet.
- Motion members `getTimelineOffset` / `setTimelineOffset` / `transitionOverrides` — the Motion owner's (round 8f's surface left as built).
- `textreview` / `linkpreview` / `lint` runs and the "Text review plugins" submenu.
- The context-menu click position for a UI opened from the canvas menu, and the `anchor` form of `position` (its `side` / `align` values are unread).
- The three-iframe isolation (ours: one sandboxed `plugin:` iframe, a fair equivalent — §13.3).

**Sweep (2026-10-18)** — branch `worktree-agent-a44e0af86efbcac0b`: nothing of this list was built. Widgets are a round of their own (the widget node, its render and synced state, the hooks, Widgets ▸); `textreview` needs the engine to draw a plugin's ranges under the text being edited (no text decorations from outside the engine yet) and the "Text review plugins" submenu goes with it; `linkpreview` and `lint` runs have no place in the editor yet to show what they return (dev resources' rich previews, a lint panel). Plugin Actions' synonyms are in atlas 03's sweep.

**New open questions** (to §14's list):
- Q10 The Recents header's English (`fullscreen_actions.recents`) — the recents are listed without a header until it is read.
- Q11 Whether the dynamic-page text for a method carries the "in <name>: " prefix (derived from the host-call wrapper).
- Q12 `setGridChildPosition`'s out-of-bounds text ("Column index … out of bounds for grid with N columns and M rows" has an unread middle; ours: "Row / Column index N is out of bounds for a grid with C columns and R rows").
- Q13 Whether Figma counts a nested string in a clientStorage value by its length too (D8 is read as "strings by length" at every depth).

---

## 14. Open questions

| # | Question | Probe that settles it |
|---|---|---|
| Q1 | The C++ VM's execution-time, memory and stack limits (no JS caller sets them) | Run a dev plugin with `while(true){}` and with a growing array in Figma desktop; time it, and read the toast or console. Or strings-scan `jsvm-cpp.wasm` from the live app's cache. |
| Q2 | The codegen `generate` timeout (docs say 3 s, and the repo uses 3000 ms; not found in 3187) | A codegen plugin that awaits 5 s; check whether Inspect shows its result or an error, and when. |
| Q3 | Whether the plugin code limit message really reads "15MB" (constant table matched by name only) | Import a dev plugin with a 16 MB `code.js`. |
| Q4 | English text of the `fullscreen.plugins.*` and `plugins.*` keys | Capture the en bundle (live probe, as in chapter 09) or run a plugin and copy the toast text. |
| Q5 | Widget render limits (node count, time) | Widget that renders 10 000 `Rectangle`s, and one whose render loops. |
| Q6 | `figma.mode` value list | Log `figma.mode` from plugins started from each entry point (menu, codegen, inspect, textreview, linkpreview). |
| Q7 | The names of the two `figma.constants.colors` maps | `console.log(Object.keys(figma.constants.colors))` in a dev plugin. |
| Q8 | Whether deleted-node getters throw "Node with id … not found" or the "The node … does not exist" text | Remove a node, then read `.name` on the stale handle. |
| Q9 | Whether `setPluginData` in a view-only file persists, or is local only | Run a plugin in a view-only file, set data, reload. |
