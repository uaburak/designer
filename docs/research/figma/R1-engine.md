# R1-engine — Figma engine & runtime architecture

Research date: 2026-10-06. Scope: how Figma is actually built (engine, rendering, UI chrome, bindings, text/fonts, desktop app, plugins, performance, undo), checked against the owner's proposed direction for DesignerV2 (C++ scene graph + renderer → Emscripten/Wasm → one WebGL canvas; React+TS panels; Electron with an isolated WebContents per tab; local storage with a scene-graph schema mappable to Firestore with per-property LWW).

## Method

Two kinds of evidence:

1. **Published sources** (Figma engineering blog, help center, developer docs, Electron blog, interviews). Each claim below has a URL that was opened.
2. **Direct inspection of the Figma desktop app installed on this Mac** (read-only, outside the repo), marked `[binary]`. That covers Figma Desktop **126.9.11** (`/Applications/Figma.app`) and the web-app assets it had cached in `~/Library/Application Support/Figma/DesktopProfile/v43/Cache`. I parsed `app.asar`, the Electron framework version string, the main Wasm module (`https://static.figma.com/fullscreen/<sha>/fullscreen-wasm/compiled_wasm.wasm.br`), its Emscripten glue (`.../compiled_wasm.js.br`), and the web app's CSS/JS bundles (`https://www.figma.com/webpack-artifacts/assets/figma_app-*.min.{js,css}.br`). These findings come from strings, import/export tables and source paths that the compiler left in the files. They are reliable as observations, but how they are read is my interpretation, so the structured output marks them `inference`.

## Verdict on the proposed direction (short)

| Proposed | Reality | Match |
|---|---|---|
| Editor core in C++, compiled with Emscripten to Wasm (asm.js before) | Yes. C++ since 2015 (asm.js), Wasm since 2017. One C++ codebase is shared by Design, FigJam, Slides and Sites. It is compiled to Wasm for the web and natively (x64/arm64) for server-side rendering and tests. **But the client Wasm also contains Rust** (kiwi codec, Eg-walker collaborative text, file migrations; C++↔Rust via `cxx`). Figma is also moving parts of the C++ into TypeScript. | Mostly |
| One `<canvas>`, own renderer (not DOM), WebGL | Yes. The 2015 design was a "tile-based" WebGL engine with its own DOM, compositor and text layout. Tiles are still there in 2026 (`RTTileRasterizer`, render tree). | Yes |
| Move to WebGPU | Yes (blog 2025-09-18). A graphics-interface abstraction has WebGL and WebGPU backends. GLSL is converted to WGSL with naga. Dawn is used for native builds. Fallback to WebGL can happen mid-session. WebGL 1 is still the minimum; WebGPU is required only for the new shader features. | Yes |
| React + TypeScript UI chrome | Yes (React 18.3.1 in the shipped bundles; earlier React+Redux). | Yes |
| Tailwind | **No** for Figma's own UI. It uses **CSS Modules + StyleX** under the internal design system FPL. Tailwind ships only inside the code-layers / Make toolchain that compiles *user* code. | No |
| UI↔core via embind | **No embind**. Figma uses custom, code-generated bindings: ~478 binding namespaces such as `NodeTsApi` and `*FacetTsApiGenerated` are installed on `globalThis`, and each wraps C++ exports through `wrapCppFunction`. There are also hand-written C++/JS bindings where Emscripten's were too slow. | No (custom) |
| Electron, each tab an isolated WebContents with its own Wasm | Yes. Electron 43.7.7 / Chrome 150. Each file tab is its own sandboxed `WebContentsView` that loads the figma.com web app, so each tab has its own JS heap and Wasm instance; 14 renderer processes were running. The tab bar is a separate transparent `WebContentsView` running a local React app (`shell.html`). Idle tabs are discarded. | Yes |
| Local storage, scene-graph schema → Firestore with per-property LWW | Matches Figma's model: `Map<ObjectID, Map<Property, Value>>`, per-property last-writer-wins on the server, parent links plus fractional indexing. Figma's server is a Rust process per document; the wire/file encoding is kiwi. | Yes (conceptually) |

## (a) What lives in the C++ core vs JS/TS

- 2015: the editor is C++ cross-compiled with Emscripten to asm.js. Evan Wallace: "our own DOM, our own compositor, our own text layout engine". It used compact 32-bit floats and pre-allocated typed arrays to avoid GC pauses, ran "within a factor of 2x native", and Figma was considering a browser-like render tree. https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/
- 2017: moved to WebAssembly, load time >3x faster "regardless of document size"; download size barely changed. At that point it was only enabled in Firefox because Chrome did not cache compiled Wasm and had crashes. https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/
- 2018: Wasm enabled in the desktop app, Chrome, Firefox and Safari. Big-file loads went from 29 s to under 8 s. https://www.figma.com/blog/figma-faster/
- 2025 (Pragmatic Engineer interview with Figma Slides engineers): "Figma's core editors use a C++ codebase and custom renderer outputting to a <canvas> element via WebGL or WebGPU"; "UI elements outside the canvas use TypeScript and React"; a "bindings layer" connects them; "Figma is rewriting parts of the C++ codebase into TypeScript"; "the underlying C++ codebase is largely shared across editors". https://newsletter.pragmaticengineer.com/p/building-figma-slides-with-noah-finer
- [binary] The main module `fullscreen-wasm/compiled_wasm.wasm` is 10.4 MB brotli and 51.5 MB raw, with about 52.7k functions (names stripped), 1,773 imports and 4,920 exports. Leftover source paths show the C++ tree `fullscreen/lib/...`:
  - `scenegraph/` (275 paths): nodes built from *facets* (`FGLayoutFacet`, `FGStackFacet` = auto layout, `FGTextFacet`, `FGRenderTreeFacet`), `FGSymbol*` (components are "symbols" internally), `FGStyle*`, `design-systems/` (variables, variable sets/modes), `derived-subtree/` (instance materialization), `dependency/`, `reactive/`, `expressions/`, `textdata/` (`FGLineLayout`, `FGTextEditor`, `FGTextPathLayout`), `FGGridLayout`, `whiteboard/` (FigJam), `slides/`, `sites/`, `motion/`.
  - `editor/` (undo `FGUndoRedo.cpp`, multiplayer bindings, export, import such as pptx), `editor-ui/` (interaction behaviours, text edit mode UI), `ui/` (`FGCanvasContext`, pointer and keyboard).
  - `graphics/` (`FGGpuDevice`, `FGGpuUniformBuffer`, `FGWebGLFallback`, `gl/*.GL.cpp`, `webgpu/*.WebGPU.cpp`), `render-tree/` (`RTTileRasterizer`, `RTPathRasterizer`, `RTGpuStrokeBatcher`, `RTCompositeTileCache`), `render-tree-generation/` (scene graph → render tree), `render-tree-serialization/`, `overlay-rendering/`.
  - `kiwi/` (`render.kiwi.h`, `sync.kiwi.h`), `core/emscripten/` (`FGJsValue`, chunked buffer writer).
  - Rust in the same Wasm: `rust/fig-kiwi`, `rust/eg-walker`, `rust/collaborative-text(-client)`, `rust/file-migrations`, crates such as `cxx`, `serde_json`, `diff-match-patch-rs`. Build paths are `bazel-out/wasm-opt-ST-...` (Bazel, single-threaded build).
  - The UI around it is TypeScript/React in webpack bundles (`figma_app-*.min.js`, about 2,658 `.tsx` module ids across cached chunks).
- [binary] There are separate Wasm modules for other jobs: `render-worker-wasm` (28.9 MB raw; scene graph plus GPU code, with strings about raster/motion export and "render worker freed pooled GPU memory"), `prototype-lib` (the prototype player), and `jsvm-cpp` (the plugin VM, see (f)).

## (b) Rendering

- One canvas, own renderer, tile-based (2015). A render tree is generated from the scene graph and rasterized in tiles: `RTTileRasterizer` and `RTCompositeTileCache` are in the 2026 binary.
- WebGPU (blog 2025-09-18, Alex Ringlein and Luke Anderson): https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
  - "Our renderer is written in C++. We compile this C++ code to WebAssembly (Wasm) using Emscripten." It is also compiled natively "for server-side rendering, as well as testing and debugging".
  - There was already an interface layer between high-level rendering code and the GL calls. It moved from global-state binding to explicit draw arguments: `context->draw(vertexBuffer, framebuffer, {texture}, material, …)`.
  - Uniforms are batched: `encodeDraw()` then `submit()`. A custom shader processor keeps GLSL (WebGL 1 style), adds includes, and converts to WGSL with **naga**, emitting both outputs.
  - Wasm uses Emscripten's WebGPU bindings and is migrating to Dawn's **emdawnwebgpu**; native builds include **Dawn**. "We also had to write some of our own custom C++/JS bindings in cases where these built-in bindings weren't performant enough."
  - Rollout: non-blocking compatibility tests after startup, a device blocklist, and **mid-session fallback to WebGL** on test failure or device loss. Results improved on some device classes, were neutral on others, with no regressions. Next steps: compute-shader blur and MSAA.
  - WebGL init still runs tests that "render pixels to a texture, read the pixels back" to detect buggy GPUs and drivers.
- [binary] The glue code has both `getContext("webgl"/"webgl2")` and `getContext("webgpu")`, 42 `emscripten_gl*` and 38 `wgpu*` imports including `BeginComputePass`/`DispatchWorkgroups`, and the string `emdawnwebgpu`. The desktop app's hidden debug menu offers renderer Default/WebGL1/WebGL2/WebGPU. Chromium switches set are `ignore-gpu-blocklist` and `force-high-performance-gpu`. The profile has a `DawnWebGPUCache`.
- Help center requirements: minimum WebGL 1.0; WebGPU (not compatibility mode) is required for shaders; Chrome 120+ (113+ for shaders), Firefox 128 ESR+ (141+), Safari 17.4+ (26+). https://help.figma.com/hc/en-us/articles/360039827194
- [binary] Vector and glyph fills use **Loop-Blinn** GPU curve shaders (`LoopBlinnGlyphsUShort`, `LoopBlinnInstanced`, "Glyph path not found in glyph cache"). Boolean operations go through **Skia PathOps** (`FGSkiaPathOps.cpp`).

## (c) UI chrome, styling, bindings

- React + TypeScript (+ Redux in 2020): "our design editor is powered by WebGL and WebAssembly, with some of the user interface implemented in Typescript and React". Comment pins are DOM over the canvas. Keeping the viewport in Redux re-rendered the whole UI on every pan; the fix was an event emitter plus one CSS-translated overlay (19→60 fps). https://www.figma.com/blog/improving-scrolling-comments-in-figma/
- [binary] React **18.3.1** (`reconcilerVersion:"18.3.1-next-f1338f8080-20240426"`), both in the web app chunks and in the desktop shell. Redux and Jotai are present in the bundles.
- **Tailwind: not used for Figma's own UI.** [binary] `figma_app.css` has 0 `--tw-` variables and no Tailwind utility classes. It declares `@layer reset, css-modules;` and `@layer priority1…priority10`, and has about 12.5k CSS-Module classes (`.desktop_new_tab_view--newTabView--OLm30`) and about 6.8k StyleX atomic classes (`.x44aosq{…}`, `*.stylex.ts` modules). The desktop shell CSS also has `@layer fpl`. Tailwind strings (~2.7k `--tw-`) appear only in three chunks that embed a Tailwind compiler and default theme. That matches the code-layers post, which says *user* code layers use "Tailwind v4 with Lightning CSS", bundled by esbuild in a Web Worker. https://www.figma.com/blog/building-figmas-code-layers/
- Design system: UI3 led to rebuilding the internal system as the **Figma Pattern Library (FPL)**, with 680+ tokens and light/dark per product, synced to code via the REST API and GitHub Actions, plus Code Connect. https://www.figma.com/blog/figma-pattern-library/
- Bindings: [binary] there is no `_embind_register*` and no `emscripten::val`. The glue is wrapped in `globalThis.executeFullscreenEmscriptenCode = () => {…}` and defines `function _init_bindings_for_X(){ _X = Object.create(null); globalThis.X = _X; _X.method = _wrapCppFunction(...) }` for **478** namespaces, 106 of them `*FacetTsApiGenerated` (generated per node facet), plus `NodeTsApi`, `SceneGraphTsApi`, `AppStateTsApi`, `VariablesBindings`, `StackBindingsCpp` and so on. `wrapCppFunction` catches C++ failures and returns a default value. Strings are marshalled through helpers such as `setCppClearBufferStringObjectFromJSString`. On the C++ side, `fullscreen/lib/core/emscripten/FGJsValue.cpp` wraps JS values. Conclusion: a **custom, code-generated binding layer**, not embind.
- Skew: Figma's own compile-to-JS language was used for the prototype viewer and mobile. It was migrated to TypeScript with a transpiler, after the C++ engine replaced Skew engine parts. The bundler is esbuild. https://www.figma.com/blog/figmas-journey-to-typescript-compiling-away-our-custom-programming-language/

## (d) Text and fonts

- Own text layout engine since 2015 (see (a)).
- [binary] The main Wasm contains **HarfBuzz** shaping: its trace messages are present ("start table GSUB script tag '%c%c%c%c'", "start lookup %u feature '%c%c%c%c'", "start postprocess-glyphs"), and I checked these against `harfbuzz/src/hb-ot-layout.cc` and `hb-ot-shape.cc`. It also has **FreeType** (`FT_Init_FreeType(&library)`) and **ICU ubidi** for bidi ("Failed to get icu/ubidi info; falling back to LTR"). Glyphs are shaped in C++, their outlines cached, and drawn on the GPU with Loop-Blinn. Emoji have their own path (`FGEmojiId`).
- Font sources: Google/Figma-hosted fonts are fetched as binaries from `static.figma.com/font/...` (seen in the cache). Local fonts work like this: "If you're using the Figma desktop app, you can skip this step. The desktop app includes the Figma font installer". Browser users install **FigmaAgent**. Only .TTF/.OTF are supported, and there are no local fonts on ChromeOS or Linux. https://help.figma.com/hc/en-us/articles/360039956894-Access-local-fonts-on-your-computer
- [binary] Desktop: the tab preload exposes `getFonts`, `getFontFile` and `getFontPreview` over IPC. Font bytes come through a token-protected custom protocol (`fetch("desktop-file:", {headers:{"X-Token":…}})`) and are returned as an ArrayBuffer to the web app. Enumeration is native Rust (`desktop_rust.node`, a Neon addon whose paths include `agent/font/src/lib.rs` and `fonts_mac.rs`, the same code as FigmaAgent). A separate `FigmaAgent.app` lives in `~/Library/Application Support/Figma/`.

## (e) Desktop app

- Electron, and BrowserView came from Figma: `<webview>` was slow and buggy, so Figma contributed **BrowserView**, which "lives in the operating system window hierarchy", "very similar to how Chrome manages its tabs" (2017-06-29). https://www.figma.com/blog/introducing-browserview-for-electron/
- Electron deprecated BrowserView in v30 in favour of **WebContentsView**. https://electronjs.org/blog/migrate-to-webcontentsview
- [binary] Figma Desktop 126.9.11 = **Electron 43.7.7 / Chrome 150.0.7871.250**. `main.js` has 59 `WebContentsView` references and 0 `BrowserView`. Components:
  - **Shell (tab bar and window chrome)**: one `WebContentsView` per window loading local `shell.html` (`<div id="react-page">`, `desktop_shell.js` React 18.3.1, CSS-module classes `file_tab--*`). It has a transparent background (`setBackgroundColor("#00000000")`), uses preload `shell_app_binding_renderer.js` (exposes `__figmaShell`), and runs with `sandbox:true, contextIsolation:true, nodeIntegration:false`.
  - **Each file tab**: its own `WebContentsView` (`sandbox:true, contextIsolation:true`, preload `web_app_binding_renderer.js`) that loads the figma.com web app. The editor JS/Wasm is *not* in `app.asar`; it is downloaded from `static.figma.com` with content-hashed URLs and kept in Chromium's HTTP cache. Each tab therefore has its own renderer process and its own Wasm instance; 14 `Figma Helper (Renderer)` processes plus one GPU process were running.
  - **Home / file browser**: a "new tab page", a web app view kept preloaded and **"stolen"** to become the editor tab when you open a file (`startStolenPreloadedTab`). There is also a preloaded viewer tab.
  - **Tab discarding**: at startup at most **15** tabs load (6 behind a proxy); the rest are restored "discarded" and reload when activated. Every hour, if at least 5 tabs are open, the app is online and outside a 30-minute grace period, it discards non-visible, non-pinned editor/prototype tabs unused for over **48 h**, keeping at least 3 loaded.
  - Native addons: `bindings.node` (Obj-C eyedropper), `desktop_rust.node` (fonts, etc.); there are also MCP-server and Make-local helpers.
- Help center desktop features: tabs, pinned tabs, tab groups, **split tab view**, a tab menu when tabs overflow, dragging tabs to new windows, the file browser on launch, device fonts without the installer, auto-update (old versions supported for 6 months). https://help.figma.com/hc/en-us/articles/5601429983767-Guide-to-the-Figma-desktop-app
- Memory: "2GB per browser tab", which "apply even when you're using Figma's desktop applications". Usage is measured as Wasm memory; image decoding in JS memory is not counted; warning at 90%, lock at 100%. https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files. [binary] The main Wasm imports a non-shared 32-bit memory, min 256 / **max 65536 pages (4 GiB)**, with no SharedArrayBuffer.
- Offline: you can create one new file, edit pages already loaded, use local components, play preloaded prototypes, run plugins already open that do not need browser APIs, and save .fig locally. You cannot open other files, use libraries, see version history or use multiplayer. Changes sync on reconnect. The desktop app can show a modal to discard or show pending changes. https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma

## (f) Plugins (brief)

- Each plugin has a main-thread sandbox with document API access and no browser APIs, plus a null-origin iframe for UI and network, linked by postMessage. An iframe-only design was rejected because every API call becomes async and serialization is huge (14 s on Microsoft's design system file). The first sandbox (Realms shim) was replaced in Oct 2019 by "a JavaScript VM written in C and cross-compiled to WebAssembly" (QuickJS). It is "somewhat slower… but intrinsically more secure". https://www.figma.com/blog/how-we-built-the-figma-plugin-system/ · https://madebyevan.com/figma/an-update-on-plugin-security/ · https://developers.figma.com/docs/plugins/how-plugins-run
- [binary] `jsvm-cpp.wasm` (240 KB brotli) exports a handle-based VM API (`jsvm_evalCode`, `jsvm_newObject`, `jsvm_callFunction`, `jsvm_setMemoryLimit`, `jsvm_setExecutionTimeLimit`, `jsvm_runMicrotasksAndAutorelease`) and contains QuickJS-style errors ("[function bytecode]", "out of memory in regexp execution").

## (g) Performance techniques documented by Figma

- Load: Wasm switch (3x); 2018 renderer restructuring (load 29 s→<8 s; zoom/drag up to 3x).
- **Dynamic page loading** (2024-05-22): load only the current page plus its *read dependencies* (component of an instance, styles, variables); *write dependencies* load on edit; the server computes them with QueryGraph; instance sublayers are deferred because they are "fully derivable". Results: slowest loads 33% faster, 70% fewer nodes in memory, 33% fewer OOMs. https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/
- Incremental frame loading for prototypes (2024-01-23): a `query`/`reply`/`changes` subscription protocol, with eviction of unsubscribed nodes. https://www.figma.com/blog/incremental-frame-loading/
- Server memory (2025-06-18): the Rust multiplayer server stores node properties as a u16 field id → value map; replacing BTreeMap with a flat sorted vector (~60 keys average, <200 fields) gave 20% less memory and 20% faster p99 deserialization. https://www.figma.com/blog/supporting-faster-file-load-times-with-memory-optimizations-in-rust/
- Reactive core (2026-03-17): **Materializer** builds "derived subtrees" with automatic dependency tracking and push-based invalidation. It replaces "Instance Updater" and removes "back-dirties" between layout, variables and constraints. Variable mode changes are 40–50% faster. [binary] `scenegraph/derived-subtree/`. https://www.figma.com/blog/how-we-rebuilt-the-foundations-of-component-instances/
- Unified parameters (2025-07-29): variables and component properties share types and bindings, with property-level invalidation and transitive resolution. https://www.figma.com/blog/a-tale-of-two-parameter-architectures/
- Layers panel (2026-06-11): a two-pass row-ID fetch, windowing, compiled derived-property dependency graphs and ropes made it 30–50% faster, with "higher FPS and fewer slow frames" on the canvas. https://www.figma.com/blog/improving-performance-in-the-layers-panel/
- April 2026 update: vector editing up to 10x faster, frame rates up to 4x smoother in Make, 92% fewer memory warnings. https://forum.figma.com/product-updates-3/performance-improvements-to-make-your-workflows-faster-53316
- Perf testing (2023-08-29): GPU VMs running headless Chromium on every commit (10-minute feedback) plus a lab of older laptops. The "C++ editor" is compiled to a stand-alone binary for tests. https://www.figma.com/blog/keeping-figma-fast/
- C++ build times (2024-04-25): builds grew 50% while code grew 10%; fixed with DIWYDU/includes.py and Bazel remote caching. https://www.figma.com/blog/speeding-up-build-times/
- Ex-Figma engineer: Wasm is limited to 4 GB (32-bit) and its memory is "grow-only"; "we built two separate layout engines" for auto layout, "a constant source of subtle bugs". https://andrewkchan.dev/posts/figma2.html
- Accessibility (2026-07-01): the canvas "takes over rendering from the browser", so Figma builds an internal accessibility tree plus a React "Mirror DOM" of invisible elements positioned with CSS from each layer's affine transform. https://www.figma.com/blog/building-accessibility-into-a-canvas-based-product/

## Undo/redo at the engine level

- Principle (multiplayer post, 2019-10-16): "if you undo a lot, copy something, and redo back to the present… the document should not change". "An undo operation modifies redo history at the time of the undo". You undo only your own changes. Data model: a "tree of objects, similar to the HTML DOM", `Map<ObjectID, Map<Property, Value>>`, server-side per-property LWW, client ID embedded in new object IDs, parent links plus fractional-index positions, and the server rejecting reparent cycles. https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- [binary] Undo lives in the C++ core (`fullscreen/lib/editor/app/FGUndoRedo.cpp`). Strings show batches and buffers (`Undo::Batch {`, `Undo::Buffer`, `untaintedUndoHistory: %d batches`) and per-mode blocking ("Undo is blocked by read-only mode / playground mode / the current tool").
- Plugin API: `figma.commitUndo()` "Commits actions to undo history"; by default plugin actions are not committed, so a whole run is one undo step. https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/

## File format

- kiwi is Evan Wallace's schema-based binary format (C++/JS/Rust/Skew), with optional fields and forward/backward compatibility. https://github.com/evanw/kiwi
- `.fig` (third-party reverse engineering) is a ZIP holding `canvas.fig` (prelude `fig-kiwi`, a version, a deflate-compressed schema chunk and a zstd-compressed message with `nodeChanges`), `meta.json`, a thumbnail and `images/`. The same structure is used for `.deck` and `.jam`. https://cdn.jsdelivr.net/npm/openfig-core@0.4.1/README.md. Evan's own parser warns it is "an unstable internal implementation detail". https://madebyevan.com/figma/fig-file-parser/
- [binary] `fullscreen/lib/kiwi/render.kiwi.h`, `sync.kiwi.h`, `rust/fig-kiwi`, and zstd in the client.

## Implications for DesignerV2 (single-user local clone)

1. The architecture is right, but the scale is not realistic. Figma's engine is about 52k Wasm functions and 51 MB of code built by a large team over ten years. A one-person clone should **copy the data model and boundaries, not the size of the C++ codebase**. Options:
   - Engine in TypeScript first, with the scene graph as `Map<id, Map<prop, value>>` and facets, and WebGL2/WebGPU behind a small graphics interface. Move hot paths to Wasm later.
   - Or C++/Rust → Wasm, using off-the-shelf parts that Figma itself uses: HarfBuzz (harfbuzzjs), FreeType, ICU bidi, Skia PathOps.
   - CanvasKit (Skia in Wasm) gives text, paths, effects and a GPU surface in one dependency and is the shortest path to Figma-grade output on one canvas. This is my recommendation, not something Figma does.
2. Keep a **render tree separate from the scene graph**, rasterize in tiles with a tile cache, and invalidate via dependency tracking (Materializer-style derived subtrees for instances, variables and styles). Design for WebGPU with WebGL fallback from day one via an abstraction that takes explicit draw arguments, as Figma's does.
3. **Bindings**: generate them (one TS namespace per facet or API, functions taking IDs, strings through shared buffers). Avoid fine-grained embind object graphs. Figma's bindings are flat function namespaces keyed by node IDs.
4. **Desktop**: replace the current iframe-per-tab model (AGENTS.md) with Figma's layout:
   - a shell `WebContentsView` (React tab bar, transparent, own preload);
   - one sandboxed, context-isolated `WebContentsView` per file, with a minimal preload bridge;
   - a preloaded "new tab / Home" view reused to open files quickly;
   - discarding of idle tabs.
   This also gives each file its own heap and Wasm memory budget (Figma: 2 GB per tab).
5. **Fonts**: enumerate system fonts in the main process (native addon, or Chromium's `queryLocalFonts()`), stream bytes to the tab through a token-guarded custom protocol, and shape/render in the engine. Do not use DOM text for the canvas.
6. **Undo**: engine-level, transaction-batched inverse property patches over the same property map (one batch per user gesture, plus explicit commit points like `figma.commitUndo`). Single-user means no redo-history rewriting is needed, but the same per-property patches map 1:1 to future Firestore per-property LWW.
7. **Storage**: per-node property maps, stable client-unique IDs, parent-ID plus fractional-index ordering, and pages as subtrees that can be loaded on demand (dynamic page loading). Do not reuse `.fig` as the native format: it is undocumented and unstable. A kiwi- or protobuf-style schema with optional fields is a good fit.
8. **UI chrome**: React + TS is right. For a faithful UI3 look, use design tokens (FPL-like) with CSS Modules or StyleX. Tailwind is not what Figma uses, though nothing stops DesignerV2 from using it.
9. **Testing**: keep a native/Node build of the engine for unit and interaction tests, and add a frame-time harness that drives the built Electron app (like `scripts/drive.mjs`).

## Open questions

- Exactly what `render-worker-wasm` does: export only, or also off-main-thread canvas rendering via OffscreenCanvas (the glue mentions OffscreenCanvas).
- Whether WebGPU is the default for all users and platforms in 2026, or still gated by blocklists and percentages.
- The precise glyph pipeline (Loop-Blinn outlines vs. cached atlases at small sizes; hinting; FreeType's role vs. HarfBuzz's own font functions).
- How undo batches are formed and how undo interacts with derived subtrees and auto layout recomputation. Not published.
- How Figma generates its binding layer (IDL or C++ annotations). Not published.
- IP: a "1:1 clone" of Figma's UI3 look and wording may raise trade-dress and copyright issues. Worth a decision before copying icons and layouts verbatim.
