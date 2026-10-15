# 20 — Rendering and performance internals

Figma Design desktop 126.9.13, read statically on 2026-10-16. This chapter is the reference for **Batch D (performance)**: the renderer's backends and fallbacks, context and device loss, the render worker, tiles, text and image rendering, culling, page loading, memory limits and the memory UI, frame scheduling, telemetry, and the hidden debug switches. It concentrates on numbers.

Two earlier REA reports already cover parts of this ground. They are summarised in §2 with links and not repeated:
- [`../rea/canvas.md`](../rea/canvas.md): the render worker, the frame transport, TSMER, tile budget classes, progressive AA, occlusion culling, lazy materialisation, WebGPU self-tests, image downscale and decode colour handling.
- [`../rea/perf-b2c.md`](../rea/perf-b2c.md): measured fps, frame times and memory of Figma and DesignerV2 on the owner's B2C file.

---

## 1. Scope and sources

### 1.1 Sources read

| Source | What was read | How |
|---|---|---|
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (52 MB editor C++) | String table (`strings -n 6`, 104 k lines). Export bodies of `CorePerfInfo_{getHeapMemoryLimit, setHeapMemoryMode}` (exports `$3a`, `Z3a`). The function that chooses small or large tiles (code @0x1f815b0), found by its assertion string's data address | A small Python section parser and byte decoding. No REA analysis session was opened on the wasm |
| `fullscreen__fullscreen-wasm__compiled_wasm.js` (glue) | `initMemory`, the `CorePerfInfo` and `Async` bindings | `rg -o` windows |
| `fullscreen__render-worker-wasm__compiled_wasm.wasm` | String table (63 k lines) | `strings` |
| `figma_app.min.js` | Memory-percentage module (`345296` @2 445 006), `HeapMemoryMode` / graphics backend enums (@7 164 773), out-of-memory and recovery modal (@4 667 841), export memory routing call sites (@2 309 254, @2 314 938) | `rg -o` |
| `3187.min.js` | Heap-mode selection (`707175` @2 783 754), `getMemoryLimit` (@2 837 888), WebGL context-loss handler (@2 724 384), WebGL2 support probe (@14 350 104), `Async` task bindings (@2 341 662), Debug › Rendering menu (@1 985 611), Google-font URLs (@10 338 350), render worker `init` request (@2 846 697), perf HUD (@1 947 964) | `rg -o` |
| `2108.min.js` | WebGPU device init and blocklist (@2 576 349 – 2 581 674), export memory routing (`619600` @827 229), periodic metrics (@820 421), hardware-acceleration detector (@612 651), slow-frame tracker | `rg -o` |
| `4752.min.js` | WebGPU allow rules and backend overrides (@1 958 599 – 1 959 926) | `rg -o` |
| `render_worker.min.js` | Slow-frame bucket tables (@445 994), fps and dropped-frame histograms (@445 684), worker WebGL context attributes | `rg -o` |
| `1540.min.js` / `3653.min.js` | Pages-panel memory-usage card (@225 511) | `rg -o` |
| `2622.min.js`, `6353.min.js` | Image thumbnail mips (@855 259), compressed textures (@1 605 921) | `rg -o` |
| Repo | `docs/research/rea/{canvas,perf-b2c}.md`, `docs/research/figma/R1-engine.md`, `R10-webgpu.md`, atlas chapters 04, 06, 07, 15; `docs/engine.md` §6, §9; `engine/src/render/*`, `src/renderer/src/engine/{gfx,Engine,CanvasController}.ts`, `src/renderer/src/editor/canvas/CommandOverlays.tsx` | read |

### 1.2 Evidence notation

- `<file> @N` is a byte offset in that file. `wasm @0xN` is a file offset in the 52 MB editor wasm.
- `<file>: "…"` is a snippet of 15 words or fewer.
- **C** = CONFIRMED (read directly). **I** = INFERRED (deduced from structure, names or neighbouring code).

---

## 2. Already covered, in one line each

| Topic | Finding | Link |
|---|---|---|
| Threaded rendering | A second C++ build (`render-worker-wasm`) draws the canvas in a Web Worker on an OffscreenCanvas. The main-thread wasm keeps the scene graph, layout and render-tree generation. Gate: `Worker && OffscreenCanvas && transferControlToOffscreen` + feature flag `fullscreen_use_threaded_rendering`. JSON-RPC over MessagePorts; a second role `export` | canvas.md §2.19 |
| Frame transport (§2.20) | Each frame main sends `{frame, imageUpdates, videoUpdates, emojiUpdates}` (ImageBitmaps and VideoFrames transferred). The worker admits scene packets by `(transportRevision, sceneGeneration, updateKind)` with `COMMIT 0 / CHUNK 1 / ABORT 2`, keeps a shadow forest updated incrementally, and replies with five counters (applied revision, UI-commands-decoded, committed, presented and converged generations). A transport failure bumps a recovery epoch and forces a full frame. Main tracks which image hashes are resident in the worker. Frame fields include `canvasToPixels`, `viewSpaceTilePixelSize`, `devicePixelRatio`, `frameBudget`, `allowDeferredRendering`, `useInteractiveRenderer`, `useBicubicSampler` | canvas.md §2.20 |
| Worker loop | `requestAnimationFrame → drainAndRender`. `canvasRenderNeedsMoreFrames()` keeps the loop running. Submits are coalesced. On device loss the worker asks main to restart it (`requestWebGLFallbackRestart`, `requestRestartAfterDeviceRestore`) | canvas.md §2.19, §2.27 |
| Export memory budgets | Decode budget 32 MB, decode concurrency 2 (clamped 1–8), image resource cache 64 MB. Overridable by `render_worker_export_memory_config` | canvas.md §2.21; the routing maths is in §9.3 below |
| TSMER | Edit re-rendering is time-sliced. Budget 16 ms + `editFrameExtraSeconds` (default 0.026 → 42 ms). Render-target switches 250 + extra (default 0). `maxEditTimeSeconds` default 1 | canvas.md §2.10 |
| Tile budget classes | Per frame: mandatory, interruptible, skipped with a coarser fallback, and old tiles forced over budget. `frameBudget`, `tileRenderingBudget` and `renderTargetSwitchBudget` | canvas.md §2.11; counters in §5.4 |
| Tile renderers | `TileTreeRenderer` (a resolution quadtree), `TileGridRenderer`, `HybridTileRenderer` and `RTSimpleRenderer`, switchable at run time; `TileAtlas` textures grow on demand | canvas.md §2.12 |
| Paths and glyphs | Stencil-then-cover with Loop-Blinn cubic coordinates; 16- and 32-bit index glyph shaders; tessellation cached by path hash | canvas.md §2.29; atlas 06 §7 |
| Anti-aliasing | Binary coverage per pass. AA accumulates per tile over extra passes (`maxAAPassCount`); a `SUPERSAMPLE_GROUP` op exists | canvas.md §2.30 |
| Occlusion culling | Render-tree op `OCCLUSION_SCOPE` (20); an opaque axis-aligned rectangle hides what is under it | canvas.md §2.8 |
| Lazy materialisation | Hidden instance children are not materialised until needed (derived flags `culled-via-defer-invisible-children` …) | canvas.md §2.7 |
| Volatile bindings | `VOLATILE_PROPERTY_BINDING` (15) / `VOLATILE_RENDER_EFFECT` (16): a subtree is rasterised once and re-composited while its transform or opacity animates | canvas.md §2.17 |
| WebGPU self-tests | Three parallel tests: two async pipeline compiles and a 4 × 4 render read back with `mapAsync`, each in three error scopes | canvas.md §2.15 |
| Image decode | `decodeAsync(bytes, mime, 4096, 4096, …)`; fit inside the box, except an image whose area is under half the box's. Thumbnail mips halve with `floor((x+1)/2)` until ≤ 512. Colour profiles are stripped and classified (sRGB 0 / Display P3 1); the upload is unpremultiplied | canvas.md §2.5–2.6; atlas 07 §8.6 |
| Task scheduling | C++ posts work through `scheduler.postTask` with three priorities and a TaskController | canvas.md §2.24; details in §8 |
| Measured performance | B2C file, Desktop page: Figma pan 115–117 fps, p95 ≈ 9.2 ms, 0 frames > 33 ms; Figma JS heap 388 MB (wasm and GPU not counted). DesignerV2 has 3–5 frames of about 58 ms per 180-step pan, which is Batch D's first target | perf-b2c.md |

---

## 3. Graphics backends

### 3.1 Backend enum and overrides

| Item | Value | Evidence | |
|---|---|---|---|
| Backend enum | `None 0, WebGL1 1, WebGL2 2, WebGPU 3` | figma_app @7 164 773: "eb.WebGL1=1 … eb.WebGPU=3" | C |
| Override order | Feature flags first: `webgl2_override`, then `webgl1_override`, then `webgpu_override`. After that the URL: `?force-webgpu=1`, `?force-webgl2=1`, `?force-webgl1=1` | 4752 @1 959 926 | C |
| Software rendering for tests | `?software-rendering=1`, honoured only when an internal check (`u.MC()`) passes | 4752 | C (gate meaning I) |
| Minimum | WebGL 1. Shader fills need WebGPU that is not in compatibility mode | R10-webgpu.md (help.figma.com) | C |

### 3.2 WebGL2 support probe (run once, cached)

A `webgl2` context is created on a throwaway canvas and inspected. The result is one of these statuses:

| Status | Rule | |
|---|---|---|
| `webgl2_not_supported` | No context | C |
| `webgl2_disallow_list` | Unmasked renderer string missing, or it matches `/radeon/`. Such machines run on **WebGL 1** | C, 3187 @14 350 104 |
| `webgl2_software_rendering` | The renderer is SwiftShader but a WebGL 1 context on the same machine is not, so WebGL2 alone is software | C |
| `webgl2_success` | Otherwise | C |

`MAX_TEXTURE_SIZE` is recorded from this probe, and both probe contexts are released with `WEBGL_lose_context.loseContext()` (C).

### 3.3 When WebGPU is used

`isWebGPUSupported()` (4752 @1 958 599) is false, unless WebGPU is forced, in each of these cases (C):
- Safari;
- Firefox below `minimum_firefox_version` (default **141**, from the dynamic config `webgpu_platform_device_config`);
- Android, iOS or iPad;
- Linux, unless an internal check `u.PN()` passes (I: the desktop app or an internal build);
- Chrome below `minimum_chromium_version` (default **0**);
- `navigator.gpu` missing.

`isWebGPUSupportedAndAllowed(editor|viewer)` additionally requires:
- no WebGL override;
- for the viewer, both `viewer_editor_renderer_unification` and `use_webgpu_viewer`;
- per platform, a flag: Mac `use_webgpu` (Firefox: `use_webgpu_firefox`), Windows / ChromeOS `use_webgpu_windows_chromeos` (Firefox: `use_webgpu_firefox`), Linux any of the three.

So WebGPU is a **staged rollout behind per-platform flags**. WebGL is the default wherever a flag is off (C).

### 3.4 WebGPU device creation

The flow is in 2108 @2 576 349.

| Step | Behaviour | |
|---|---|---|
| Adapter | `requestAdapter({powerPreference:"high-performance"})`. If that gives nothing or a fallback (software) adapter, retry `"low-power"`, then the default | C |
| No adapter | Status `webgpu_no_adapter`, fallback reason `NO_ADAPTER` | C |
| Software adapter | `webgpu_software_rendering` (`FALLBACK_ADAPTER`), unless `mustUseWebGPU` or tests allow it | C |
| Features | `requiredFeatures` includes `texture-compression-bc` and `texture-compression-astc` when the adapter has them. No `requiredLimits` | C |
| Device failure | `webgpu_no_device` (`REQUEST_DEVICE_FAILURE` or `DEVICE_UNEXPECTEDLY_NULL`) | C |
| GPU info | Read from a WebGL context's `WEBGL_debug_renderer_info` (UNMASKED renderer and vendor), with the adapter's `info` as a fallback. Stored as `figmaRenderingBackend, graphicsCardName, vendor, webGLVersion, webgpuArchitecture, webgpuDescription, webgpuDevice, webgpuVendor` | C |
| Max texture | `maxTextureSize = device.limits.maxTextureDimension2D`. Without `requiredLimits`, WebGPU's default limit of **8192** applies even where WebGL reports 16384. `glMaxTextureSize` is kept apart | C (the 8192 default is the WebGPU spec's) |
| Disallow list | `webgpu_disallow_list` if any of: Windows + Intel `gen-7` / `gen-8`; Apple `metal-3`, unless flag `webgpu_canvas_2d_readpixels` is on; an empty card name when `block_missing_graphics_card_name`; the card name contains an entry of `graphics_card_blocklist`; Firefox and `firefox_graphics_card_blocklist`; non-Firefox and a `{vendor, architecture}` pair in `vendor_architecture_blocklist` | C, 2108 @2 579 799 |
| Success | `webgpu_success`. Statuses are reported as `rendering_and_animation.webgpu_initialization` | C |

### 3.5 Fallback to WebGL

| Item | Value | |
|---|---|---|
| Reasons enum | `REQUEST_DEVICE_FAILURE 0, WEBGPU_ERROR 1, WEBGPU_OOM 2, JS_ERROR 3, COMPATIBILITY_TEST_FAILURE 4, DEBUGGING_HELPERS 5, SURFACE_TEXTURE_FAILURE 6, NO_ADAPTER 7, FALLBACK_ADAPTER 8, DEVICE_UNEXPECTEDLY_NULL 9` | C, 3187 |
| Which reasons fall back | Dynamic config `webgl_fallback_triggers` = `{request_device_failure, webgpu_error, webgpu_oom, js_error, compatibility_test}`. The **default for each is false** (the config switches them on) | C |
| Uncaptured errors | Classified `Unknown 0 / Validation 1 / OutOfMemory 2 / Internal 3` and reported | C |
| Analytics | `rendering_and_animation.webgpu_to_webgl_fallback` | C (key) |
| In the worker | `requestWebGLFallbackRestart`: main restarts the render worker on WebGL | C, canvas.md §2.19 |

### 3.6 Device and context loss

**WebGPU device lost** (2108 @2 581 674):
- Pending readbacks are cancelled and listeners are told "lost".
- If the reason is not `"destroyed"`, the device is re-initialised at once.
- If it was destroyed while a recreate was armed, it is re-initialised after **3000 ms**.
- On success, the per-surface colour space and size caches are cleared and listeners get "restored". On failure, a fallback to WebGL is requested (C).

**WebGL context lost** (3187 @2 724 384):

| Item | Value | |
|---|---|---|
| Event | `webglcontextlost` gets `preventDefault()` and `stopImmediatePropagation()`. The engine is told the context is lost | C |
| Restore poll | Every **3000 ms**. If the context is still lost, call `WEBGL_lose_context.restoreContext()` and poll again. At most **3** attempts, then the error "WebGL context was lost and could not be restored" | C |
| Restore loop guard | Each restore that needed a forced request counts as a "consecutive forced restore". At **3**, it stops retrying ("…repeatedly lost after forced restoration"). The count resets when a loss comes **≥ 30 000 ms** after the last restore | C |
| On restore | Emscripten GL extensions are re-initialised. The canvas background flashes to white for one task (`setTimeout 0`) | C |
| Upload state | `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL = NONE` on every context | C |
| Worker context | Attributes `{powerPreference, preserveDrawingBuffer:false}`. Offscreen helpers try `"high-performance"`, then `"default"` | C, render_worker |
| Fatal modal | "webgl-error-modal" with `webgl_error.message.*` keys (§11) | C (keys) |

### 3.7 Hardware-acceleration detector

2108 @612 651:
- Status enum: `UNKNOWN 0, DISABLED 1, ENABLED 2`.
- **DISABLED** when the GPU vendor contains "Google Inc." and the card name contains "SwiftShader".
- UNKNOWN in one environment (`u.eD`; I: the desktop app).
- When DISABLED and not shown before: a visual bell `hardware_acceleration_detector.message` with "Learn more", a timeout of **10 000 ms**, and the localStorage key `hardware_acceleration_disabled_warning_shown`. The Learn more link is help.figma.com article 360039828614, section "Advanced".
- When ENABLED again, the key is deleted and "Hardware Acceleration Turned On" is tracked.
- The status goes into the global logging context as `hardware_acceleration_status`.

All C.

---

## 4. Tiles

### 4.1 Tile sizes

| Item | Value | Evidence | |
|---|---|---|---|
| Small tile | **256 px** (device) | wasm @0x1f815b0: `i32.const 256; i32.div_s` on the system width and height | C (constant), I (meaning) |
| Large tile | **512 px** | same function: `i32.const 512; i32.div_s`, then `+1` per axis | C (constant), I (meaning) |
| Choice | "System dimensions" (I: the screen) are doubled when the scale is **≥ 1.5** (`f32 1.5`). If width × height **> 2 073 599** (that is, ≥ 1920 × 1080 device pixels), the flag for large tiles is set | same function; string "System dimensions need to be set to establish small vs. large tile use" | C (constants), I (rule) |
| Budget check | The 512-tile count of the screen, `(w/512+1)·(h/512+1)`, plus 16, is compared with a texture budget derived from `textureMemoryMB << 18` (bytes), and a warning is logged when it does not fit | same function | I |
| Viewport tile size | `viewSpaceTilePixelSize` travels in every frame to the worker | canvas.md §2.20 | C |
| Atlas | `TileAtlas`, `CompositeTileCacheTileAtlas`: "allocated new texture to handle demand for current frame" | wasm strings | C |
| Large-tile assertion | "finalTile->isLargeTile()" | wasm | C |
| Retain / defer | `CanvasViewState.retainViewportTiles`, `deferTileRefinement` | wasm bindings | C |

### 4.2 Memory the tile cache plans against

`getMemoryLimit()` (3187 @2 837 888) feeds C++ `physicalMemoryMB` and `textureMemoryMB` (assertion "physicalMemoryMB && textureMemoryMB"):

| Platform | hasVirtualMemory | physicalMemoryMB | textureMemoryMB | |
|---|---|---|---|---|
| Desktop browser / desktop app | true | **2048** | **2048** | C |
| iPad (or flag `d`) | true | 2048 | 2048 | C |
| Mobile browser | false | **256** | **256** | C |

The same values go to the render worker's `init` (C). How C++ turns them into a tile cache cap is stripped. The `<< 18` above suggests a quarter of `textureMemoryMB` in bytes, about **512 MiB** on desktop (I).

### 4.3 When tiles re-render, and low resolution during zoom

- **Dirty tiles.** Edits mark dirty rects and tiles (debug views `toggle-display-dirty-rects` and `toggle-display-dirty-tiles`). Re-rendering after an edit is time-sliced by TSMER (canvas.md §2.10) (C).
- **Zoom and pan.** While interacting, the renderer composites existing tiles. The tile tree's `minTileSharpness` / `sumTileSharpness` and `numSmallestTilesOutdated` / `numSmallestTilesDefinitelyCovered` measure how far the shown tiles are from the target resolution. Coarser tiles stand in until sharper ones cover the view (canvas.md §2.12) (C names; I quadtree).
- **Frame flag.** `useInteractiveRenderer` is set during interaction and reset after each drain ("Interactive renderer mode (TileTree or TileGrid)", "(no interactive renderer)").
- **Deferred refinement.** `allowDeferredRendering` / `deferredRenderingSupported` let the frame defer refinement (C).
- **Forced refresh.** A stale stand-in that stays too long is redrawn over budget (`_bgtTilesOldForcedOverBudget`). The age threshold is stripped.
- **AA passes.** A tile first shows binary coverage and gains AA passes over the next frames (`_bgtTilesDoingAAPasses`, `aaPassesCompleted`). A "high quality render" is attempted when idle (`_bgtAttemptedHighQualityRender`) (C names).
- **Page switch.** Feature flag `fullscreen_page_switch_tile_tree` (C) gives page switches a tile-tree path. Behaviour I.

### 4.4 Composite tile grid

Render-tree op `COMPOSITE_TILE_GRID`, with config strings `compositeTileGridTransformHandling`, `compositeTileGridEnableSpatialReuseGate` and `compositeTileGridExpandBounds`. Tiles are reused spatially when a subtree moves, instead of being re-rasterised (I from the names). The shaders are `COMPOSITE_TILE`, `COPY_TILE`, `COPY_AND_TINT_TILE`, `BLEND_TILE_SIMPLE/CUSTOM`, `MASK_TILE*` and the `*_BLUR_TILE*` family (C).

---

## 5. Culling and level of detail

| Mechanism | What it does | |
|---|---|---|
| Viewport culling | Render-tree generation skips what is off-view (`populate-cache-in-viewport`, `can-maybe-cull-derived-subtree`, `is-culling-disabled-for-group`, `should-break-culling-propagation`) | C names |
| Occlusion | `OCCLUSION_SCOPE`; `shouldComputeNodeOccluders`; counter `_nodesCulledByOcclusion`; flag `group_lookahead_occlusion_culling` | C (canvas.md §2.8) |
| Invisible children | Deferred materialisation (`culled-via-defer-invisible-children`) | C (canvas.md §2.7) |
| Overlay UI | Flag `fullscreen_overlay_ui_culling`: off-screen selection and overlay UI is not drawn | C name, I behaviour |
| Hover during pan | Flag `defer_hover_during_pan_zoom`: hover hit-tests wait until the pan or zoom ends | C name, I behaviour |
| Small objects | No explicit LOD threshold string found. Small content is handled by the tile resolution (a coarser tile simply holds fewer pixels) | I |

---

## 6. Text and glyph rendering

| Item | Figma | |
|---|---|---|
| Method | Glyphs are filled vector paths with stencil-then-cover (`LOOP_BLINN_GLYPHS_{UINT,USHORT}`). **No glyph atlas and no SDF text**: the only SDF string is a squiggle texture (`squiggle-sdf.png`, `RSQUIGGLE_SDF`) for spell-check underlines | C; atlas 06 §7 |
| Glyph cache | Outlines cached per face and glyph ("Glyph path not found in glyph cache after insert"). Batches are deduplicated (`deduplicateGlyphRendering*`) | C |
| Small text | No greeking or "text as lines" string. Small text is drawn as paths into tiles like everything else. AA passes refine it | I |
| Hinting | FreeType's `pshinter` / `hinting-engine` strings are present (FreeType is linked for outline extraction) | C strings, I use |
| Emoji | Images (Apple / Noto sets), not colour glyphs | atlas 06 |
| Line breaking | UAX #14 in JS (`JSTextLayout_getAllLineBreakPositions`) | canvas.md §2.26 |

---

## 7. Images

| Item | Value | |
|---|---|---|
| Decode cap | 4096 × 4096 with the half-area exception; optionally clamped to `maxTextureSize` | canvas.md §2.5 |
| Thumbnail tier | `thumbnailSize(w,h)`: halve with `floor((x+1)/2)` until the longer side is **≤ 512**, giving `mipsToDrop` | C, 2622 @855 259 |
| Thumbnail log | "Generating thumbnail from image %s, drop %d mips, %dx%d %0.2f MB to %dx%d %0.2f MB" | C, wasm |
| Resolution choice | Per draw, by the image transform ("Non-finite image transform while selecting image resolution"): the thumbnail when it is enough, the full image when needed | C string, I rule |
| Image data kinds | `COMPRESSED 0, BUFFER 1, BITMAP 2` (enum next to `HeapMemoryMode`) | C, figma_app @7 164 773 |
| Decode worker | `image_io_worker`: `createImageBitmap(blob, {premultiplyAlpha:"none"})`. SVG never goes to the worker. HEIC is converted server-side | canvas.md §2.6 |
| Under memory pressure | The C++ string `unload_compressed_image_data` suggests the compressed bytes are dropped once decoded or under pressure | I |
| Image memory stats | `CorePerfInfo.imageMemStatsAlloc/Free`, `getImageMemStats…`: image memory is tracked apart from the C++ heap. The help center says image decoding in JS memory is **not** counted in the file memory % | C (bindings), R1-engine.md |
| Compressed textures | ASTC 6×6 (`ASTC_6x6`, `WEBGL_compressed_texture_astc`, analytics `…webgl_astc_compressed_textures_support`). The prototype viewer on iOS, Android or a touch Mac POSTs `/file/<key>/generate_compressed_textures`; flag `figjam_ipad_compressed_textures` | C, 6353 @1 605 921 |
| Download priority | The render worker can raise an image's download priority (`raiseImageDownloadPriorityFromRenderWorker {hash}`) | C |
| Export budgets | §9.3 | |

---

## 8. Frame scheduling

| Item | Value | |
|---|---|---|
| Render on demand | C++ calls `Async.requestAnimationFrame()`. JS forwards it to one registered frame callback. A request made before the callback is registered sets a pending flag, and the callback runs as soon as it is registered | C, 3187 module 73447 |
| Background work | `Async.post{UserBlocking,UserVisible,Background}TaskHelper(id, delay)` → `scheduler.postTask(cb, {priority:'user-blocking'\|'user-visible'\|'background', signal, delay})`. Each task has a `TaskController` stored by id for `cancelTask` | C, 3187 @2 341 662 |
| Timers | `Async.setTimeout(id, ms)` calls back into C++ (`timeoutCallback(id)`) | C |
| Worker loop | rAF → `drainAndRender`; `canvasRenderNeedsMoreFrames()` | canvas.md §2.19 |
| Edit slicing | TSMER: 42 ms default budget, 250 target switches, 1 s cap | canvas.md §2.10 |
| Export / thumbnail jobs | At most **6 ms** of work per animation frame (`msPerTick:6`) | atlas 15 |
| Effects animation | Custom-effect ticking pauses under memory pressure (`underMemoryPressure`; the per-frame cap becomes `+!underMemoryPressure` or 999) | C, 3187 |
| Memory poll | The file memory % is recomputed every **5000 ms** | C, §9.1 |
| Periodic metrics | "Fullscreen Periodic Metrics" every **3 600 000 ms** (1 h); the other set every **300 000 ms** (5 min); with `frequent_periodic_metrics`, **60 000 ms**. The first report goes **300 000 ms** after start. CPU usage is included with `cpu_monitoring_enabled` | C, 2108 @820 421 |

---

## 9. Memory

### 9.1 The file memory percentage

figma_app module `345296` @2 445 006:

| Item | Value | |
|---|---|---|
| Used bytes | `mallocLevelBytes = getTotalUsedHeapMemory() + getFileLoadPeakMemoryDeltaBytes()`: the wasm heap in use, plus the peak extra while a file loads | C (3187 `707175` `Yc`) |
| Limit | `CorePerfInfo.getHeapMemoryLimit()` | C |
| Percent | `used / limit × 100`, clamped 0–100, rounded to **2 decimals**. A debug override can pin it | C |
| Poll | `setInterval(5000)` while subscribed | C |
| Threshold | **≥ 90 %**: state goes 0 → 1 (calls C++ `handleHighMemoryUsageThresholdReached()`, which runs the high-memory optimisations; event `fullscreen_platform.high_memory_usage_optimization_triggered`) → 2. **< 90 %** resets the state to 0 | C |
| Warning level | `SAFE 0, ERROR 1, OOM 2`. ERROR when the state is 2. OOM when the out-of-memory modal is open. Pushed to C++ by `setMemoryWarningLevel(level)` | C |
| Guarded operations | `$m(op)`: an operation (I: load all pages, merge) is refused when the % is already ≥ 90, or when the threshold was crossed while it ran → `{highMemoryThresholdReached:true}` | C |
| Per-page share | `KV(pageBytes, rootBytes)` = `used × pageBytes / rootBytes / limit`. Shown as `x.x %` when ≥ 10 %, else `x.xx %`; in the layers panel `x.x %` when ≥ 0.1 %, else "--" | C |
| Hidden pages share | `Zz()` = the share of `getHiddenCanvasMemoryUsage() / getRootMemoryUsage()`. `pageContentPct = total − hidden share` (analytics) | C |
| Help center | "2GB per browser tab … even in the desktop app"; "warning at 90 %, lock at 100 %"; Wasm memory only | R1-engine.md |

### 9.2 Heap limits by mode

`HeapMemoryMode` = `LEGACY 0, DEFAULT 1, MERGE_MODAL 2, LOAD_ALL_PAGES 3, RECOVERY 4, MAXIMUM 5` (figma_app @7 164 773, C). The limits were decoded from the bodies of `getHeapMemoryLimit` (wasm @0x2c53567) and `setHeapMemoryMode` (code @0x1625c5a):

| Mode | Heap limit | When | |
|---|---|---|---|
| LEGACY 0 | 2 GiB (`0x80000000`) | compatibility | C |
| DEFAULT 1 | **2 GiB** (2 147 483 648 B) | normal editing | C |
| MERGE_MODAL 2 | **3 GiB** (`0xC0000000`) | branch review / merge | C (limit), I (when, from the name) |
| LOAD_ALL_PAGES 3 | **3 GiB** | loading every page (search all pages, plugins with `documentAccess` …) | C (limit), I (when) |
| RECOVERY 4 | **4 GiB − 64 KiB** (`0xFFFF0000`) | `?recovery=true`, the "recovery mode" reload | C |
| MAXIMUM 5 | 4 GiB − 64 KiB | flag `wasm_4gb` + `?wasm-4gb=1` | C |

- A mode change that would set a limit **below the bytes already in use** fails. It logs "Couldn't change memory mode", and JS logs `setHeapMemoryMode(n) failed` (C).
- The Wasm memory is created with `initial = INITIAL_MEMORY or 16 MiB` and **maximum 65 536 pages (4 GiB)**, not shared (glue @2 610, C). The heap limit is therefore Figma's own accounting cap inside a 4 GiB address space, not the Wasm maximum.
- JS constants next to the mode selection: `1 GiB` (`0x40000000`) and `1 MiB` (`1048576`) (C). Their use is not read.

### 9.3 Export memory routing (adaptive memory policy)

2108 module `619600` @827 229 decides where an export renders: the shared canvas worker, a dedicated export worker, or synchronously on the main thread (`synchronous_memory_routing`, log "Adaptive memory policy routed export to synchronous execution"). All values below are C.

**Forecast.** Every term is doubled for transfer plus working copy:
- tree = 2 × `renderTreeBytes` (64 MiB `0x4000000` when the tree size is not known);
- images = 2 × decoded + compressed + uncompressed bytes;
- effects = 2 × custom-effect bytes;
- output = 2 × w × h × 4.
- peak = the sum of those four.
- uncertainty reserve = clamp(0.25 × peak, **32 MiB**, **256 MiB**).
- worker startup reserve = **96 MiB** (`0x6000000`) when the dedicated worker is not warm.
- shared peak = peak + uncertainty; dedicated peak = shared peak + startup reserve.

**Budget.**
- heap limit = `jsHeapSizeLimit`, or else the wasm heap limit.
- target = limit × **0.75** on Safari or Firefox, **0.8** when `navigator.deviceMemory` ≤ 4 GiB, else **0.85**.
- headroom = target − max(JS heap used, wasm heap used).
- per-transaction cap = **512 MiB** when deviceMemory is unknown, else max(**192 MiB**, deviceMemory / 8).
- transaction budget = min(headroom, cap); with no heap limit known, min(**384 MiB**, cap).
- hard cap = **512 MiB** when deviceMemory ≤ 4 GiB, else **1 GiB**.

**Route.**
1. Shared peak > hard cap → synchronous (`individual_hard_cap`).
2. Shared worker preferred → canvas worker when it is available and fits the budget (`forced_canvas_worker`); otherwise synchronous (`insufficient_headroom`).
3. Dedicated peak > budget → canvas worker if that fits (`reuse_canvas_worker`); otherwise synchronous.
4. Otherwise → dedicated worker (`within_budget`).

**Admission.** Exports already reserved plus this one over budget → `delay` (`queued_work_exceeds_budget`).

**Legacy path.** When the policy flag is off: synchronous if wasm used + 2 × decoded + output > **0.85** × wasm limit (or > **256 MiB** with no limit known).

**Image budgets inside an export.** Decode budget **32 MiB** (`0x2000000`) by default, otherwise derived from the transaction budget. The resource cache is derived from the transaction budget (canvas.md §2.21).

### 9.4 Memory UI

| Surface | Behaviour | |
|---|---|---|
| View › Memory usage (`toggle-memory-usage-indicator`, `UiState.showMemoryUsage`; also `showInFileMemoryPercentage`, `in_file_memory_usage_toggle`) | A card in the Pages panel: title `fullscreen.pages_panel.memory_usage`, a progress bar (`max 100`, value = %, label `…memory_usage_limit`), the % as an integer (`Math.trunc`) on the right, danger colour at ERROR, a close × (hidden at ERROR), and a "Manage memory" button (`manage_memory_modal.manage_memory_button`) | C, 1540 @223 897 |
| ERROR message | Header `…almost_out_of_memory` (recovery mode: `…recovery_mode_high`). Body: `…to_avoid_losing_file_access`; viewer → `…error_contact_file_owner`; viewer in version history → `…read_only_view_version_history`; editor in version history → `…error_edit_view_version_history`. Then "Learn more" → help article 360040528173 "Reduce memory usage in files" | C |
| Back to SAFE after a warning | Header `…youre_good_to_go` (recovery: `…recovery_mode_low`), body `…this_file_has_enough_memory` (recovery: `…recovery_mode_low_content`) | C |
| Exit recovery | Shown in recovery mode when % **< 45**: `…recovery_mode_exit`, which reloads the file without `isRecoveryMode` (event `exit_recovery_mode`) | C, 1540 @225 511 |
| Recovery mode on load | In recovery mode the card opens by itself and the manage-memory modal opens once | C |
| Manage memory modal | Rows `total_memory_used`, `page_content`, `imported_components`, `total_layers` (`getFileNodeCount()`), toggle `show_memory_in_layers_panel` (+ warning) | C keys |
| Out-of-memory modal | Cannot be closed (`preventUserClose`). Read-only, or already in recovery → "reload" variant (`memory_warning_modal.reload_*`, button `reload_page_button`). Otherwise → "recovery mode" variant (`recovery_mode_modal_title`, `…_out_of_memory`, `…_content`, button `recovery_mode_button`, which reloads with `isRecoveryMode:true`). Both have "Learn more". Branching shows its own variant (`collaboration.branching.file_out_of_memory`) | C, figma_app @4 667 841 |
| Tips modal | `memory_warning_modal.memory_reduction_tips_*`: trim components, flatten shapes, clean layers, break files | C keys |
| All-pages search | At the threshold, canvas search falls back (`canvas_search.iterative_all_pages_search_memory_fallback`); `all_pages_load_result = "memory_limit"` | C |
| Desktop tab hover | Flags `desktop_tab_hover_memory_info`, `desktop_report_periodic_process_memory_metrics` → `pollProcessMemory()` | C |
| Debug | `purge-all-memory`, `download-memory-profile`; `window.DebuggingHelpers.forceHighMemoryOptimizations()`; with `memory_profiling_local`, `window.startMemoryProfile({samplingRatio 0–1, stackTraceLimit, recordWasmMemory, recordJsBufferMemory})` writes to a picked file (sampling ratio stored ×256); `getTopMemoryFunctions()` prints the top 10 allocators | C, 3187 @2 783 754 |
| Leak alert | "Potential memory leak: session_delta_bytes has exceeded alerting threshold"; metric `memory.fullscreen.session_delta_mb` | C strings (threshold stripped) |

### 9.5 Dynamic page loading and unloading

| Item | Value | |
|---|---|---|
| Model | The server answers `Message.sceneGraphQueries` (16) = `SceneGraphQuery{startingNode 1, depth 2, behavior 3}` with `SceneGraphQueryBehavior DEFAULT 0 / CONTAINING_PAGE 1 / PLUGIN 2` and `sceneGraphQueryMode` (45) `ADD 0 / SET 1` | C, figma-schema-106.kiwi:4406–4421 |
| Client | `FGMultiplayerPageSyncing.cpp`: "Adding sceneGraphQuery for %s with depth %u and behavior %s"; "Resolving query … all nodes already loaded"; "setSubscribedPages"; "Upgraded client to full connection"; reconnect `JOIN_END_INCREMENTAL_RECONNECT` (21) | C strings |
| What loads | The current page plus its read dependencies (components, styles, variables). Write dependencies load on edit. Instance sublayers are derived. Result: 33 % faster slowest loads, 70 % fewer nodes in memory | R1-engine.md (blog 2024-05-22) |
| Load all pages | "Incrementally loading all pages..."; heap mode LOAD_ALL_PAGES (3 GiB); result `complete / memory_limit / error` with its duration | C |
| Unloading | `fullscreen_platform.dynamic_page_unloading_result` and `…_page_counts`; `dynamic_page_unloading_last_unloaded_page_count`; `all_pages_retained`, `loaded_pages`. Pages not shown are unloaded again (I: when memory is high) | C names, I trigger |
| Debug | `debug-incremental-loading-all-pages`, `debug-incremental-loading-current-only`, `debug-incremental-all`; validation mode `full-with-incremental-validation` | C |
| Packed subtrees | NodePacker keeps cold subtrees as encoded bytes (`disableNodePacker`) | canvas.md §2.16 |

---

## 10. Telemetry, fps and debug switches

### 10.1 Slow-frame sampling

render_worker @445 994 and 2108; all C.
- Every frame time is sampled with a rate looked up in a bucket table. Frames **≥ `unsampledFrameTimeMs`** are always logged, and they also force the next frame to be sampled.
- **Table A** (editor): `unsampledFrameTimeMs` **50**. Rates for frames up to 1 / 9 / 17 / 19 / 20 / 23 / 25 / 29 / 32 / 48 / 64 ms: 0.00224, 0.0000467, 0.0000267, 0.000107, 0.00058, 0.000507, 0.00186, 0.00156, 0.00225, 0.000753, 0.0039.
- **Table B** (`unsampledFrameTimeMs` **300**): the same rates, plus 80 ms 0.00803, 100 ms 0.0142, 300 ms 0.00711.
- Each sample carries the frame number, CPU timer tree, GPU metrics, "optimization exposures", file key, plan tier, `ranFullscreenLoop`, `lastCheckpointSize` and GPU info.
- A frame over the threshold also raises the RUM action `slow_frame_threshold_exceeded` with `frameTimeMs` and `frameTimeThresholdMs`.
- The render worker has its own `render_worker_slow_frame_tracker`.

### 10.2 Frame histograms

render_worker @445 684; C.
- `fps` histogram bins (ms): 1, 9, 17, 19, 20, 23, 25, 29, 32, 48, 64, 80, 96, 112, 224, 448, 896, 1792, 3584, ∞. It logs `frame_count`, `mean_frame_ms`, `max_frame_ms` and `count_<a>_to_<b>_ms`, plus avg, max, stdd and total.
- `dropped_frames` bins: 0, 1, 2, 4, 8, 16, 32, 64, 128, 256, ∞ frames.
- Other collectors: `collector_fullscreen_frame_time`, `collector_fullscreen_idle_frame_time`, `render_worker_dropped_frames`, `critical_interaction_instrumentation_pan_zoom`, `track_layers_panel_scrolling_frame_rate`, `properties_panel.update_selection_properties_latency`.

### 10.3 HUDs and the Debug › Rendering group (internal builds)

The internal debug menu has a `debug-group-rendering` (3187 @1 985 611, C):

| Action | Effect |
|---|---|
| `download-memory-profile` | Saves a memory profile |
| `download-webgl-trace` | Saves a recorded WebGL trace (`webgl_recorder`) |
| `print-image-diagnostics`, `print-render-tree` | Console dumps |
| `purge-all-memory` | Frees caches |
| `toggle-allow-time-sliced-edit-rendering-optimization` | TSMER on/off |
| `toggle-display-cpu-timer-tree` | CPU timer tree overlay |
| `toggle-display-dirty-rects`, `toggle-display-dirty-tiles` | Damage overlays |
| `toggle-display-expensive-tiles` | Highlights costly tiles |
| `toggle-display-gpu-metrics` | GPU metrics overlay |
| `toggle-display-metronome-texture-cache` | Motion texture cache |
| `toggle-display-node-occluders` | Occluders overlay |
| `toggle-display-pixel-heat-map` | Overdraw heat map |
| `toggle-memory-usage-indicator` | §9.4 card |
| `toggle-overlay-ui-rendering` | Overlay UI on/off |
| `toggle-perf-hud` | Perf HUD (flag `perf_hud`): a floating list of the last **60** scene-update summaries, placed at 240 px + 5 |
| `toggle-perf-mode-medium` | `EditorPreferences.togglePerfModeMedium` |
| `toggle-redux-mirror-hud` | "Show Redux mirror HUD" |
| `toggle-resource-use` | `UiState.renderResourceUse`: "Total GPU Memory", "Textures Memory", "Render Buffers Memory", "Uniform Buffers Memory", "Vertex Buffers Memory", "Geometry Memory", "Render Tree Memory", "Draw Calls", "%d MB VRAM", "%d MB Rendered Tile VRAM" |
| `toggle-tsmer-config` | TSMER modal (canvas.md §2.10) |

Other rendering debug items: `toggle-pixel-preview` (Pixel preview, user-visible), `toggle-frame-clipping`, `toggle-outline-mode-object-bounds`, `toggle-sync-cursor-rendering` (`syncCursorRenderingToSceneGraph`), `debugShow3dBounds`.

### 10.4 Hidden URL parameters

C for all.

| Parameter | Effect |
|---|---|
| `force-webgpu=1`, `force-webgl2=1`, `force-webgl1=1` | Backend override |
| `software-rendering=1` | Allow software rendering (internal) |
| `recovery=true` | Heap mode RECOVERY (4 GiB) |
| `wasm-4gb=1` | Heap mode MAXIMUM (needs flag `wasm_4gb`) |

### 10.5 Desktop "hardware acceleration" toggle

Not in this build: the Electron main process is not in the cache. In the web app, the only hardware-acceleration surface is the SwiftShader detector (§3.7). See open question 4.

---

## 11. Fonts (loading and caching)

| Item | Value | |
|---|---|---|
| Google / Figma font index | `https://static.figma.com/font/index_<digest>.json` or `.kiwi.json`, with digest `f094b6f0d563caa35ae4edafd0fb9240` (figma-gov: `static.figma-gov.com/font`) | C, 3187 @10 338 350 |
| Font files | `<base>/<file>`. Weight-name map: Thin 100 … Black 900 | C |
| Worker fonts | The render worker gets only the **Inter** faces at `init`; other fonts are sent as needed | C, 3187 @2 846 697 |
| Missing fonts | Drawn from stored `derivedTextData` until the face arrives; `reportUnloadedFontsToSentry` | atlas 06 §6 |
| Local fonts | The font agent at `127.0.0.1:44950`; version gates < 14 and ≥ 22 | atlas 06 §6.6, R11-fonts.md |
| Font cache policy | `ResolvedFontCacheUpdatePolicy`, `ResolvedFontCacheObserver` (C++) | C names |

---

## 12. GPU feature detection list

What Figma probes or uses (C unless marked):
- WebGL: `WEBGL_debug_renderer_info` (a warning on Windows without it; Firefox needs `webgl.enable-debug-renderer-info`), `ANGLE_instanced_arrays`, `WEBGL_lose_context`, `WEBGL_compressed_texture_astc` / `_etc` / `_pvrtc`, `MAX_TEXTURE_SIZE`, renderer regexes `/radeon/` and `/swiftshader/`.
- ChromeOS: `/uhd graphics \(jsl\)/i` with `/vulkan/i`, a special case (`isJSLUHDChromeOS`).
- WebGPU: adapter `info.isFallbackAdapter`, features `texture-compression-bc` and `texture-compression-astc`, `limits.maxTextureDimension2D`, `getPreferredCanvasFormat()`, vendor and architecture for the blocklists.
- Sync readback: a WebGPU OffscreenCanvas, read through a hidden WebGL context, or through two 2-D canvases (an `alpha:false` one for RGB and an alpha one for A) for listed vendor / architecture pairs (`webgpu_sync_readback_config`).
- Platform: `hardwareConcurrency`, `navigator.deviceMemory`, `performance.memory` (`usedJSHeapSize`, `jsHeapSizeLimit`), `is64BitBrowser`.

---

## 13. UI strings

The build carries i18n keys. English text is given only where it is attested (source in brackets).

- Memory card: `fullscreen.pages_panel.memory_usage` ["Memory usage", live View menu, atlas 03 line 931], `…memory_usage_limit`, `…memory_usage_almost_out_of_memory`, `…memory_usage_to_avoid_losing_file_access`, `…memory_usage_error_contact_file_owner`, `…memory_usage_read_only_view_version_history`, `…memory_usage_error_edit_view_version_history`, `…memory_usage_this_file_has_enough_memory`, `…memory_usage_youre_good_to_go`, `…memory_usage_recovery_mode_high`, `…_high_content`, `…_low`, `…_low_content`, `…memory_usage_recovery_mode_exit`, `…memory_usage_learn_more`.
- Manage memory: `manage_memory_modal.manage_memory_modal_title`, `.manage_memory_button`, `.total_memory_used`, `.page_content`, `.imported_components`, `.total_layers`, `.show_memory_in_layers_panel`, `.show_memory_in_layers_panel_warning`.
- Out of memory: `memory_warning_modal.reload_modal_title`, `.reload_modal_content`, `.reload_modal_content_cta`, `.reload_page_button`, `.recovery_mode_modal_title`, `.recovery_mode_modal_out_of_memory`, `.recovery_mode_modal_content`, `.recovery_mode_button`, `.learn_more`, `.help_center`, `.help_center_resource_and_link`, `.memory_reduction_tips_modal_title`, `.memory_reduction_tips_{trim_components,flatten_shapes,clean_layers,break_files}[_header]`; `collaboration.branching.file_out_of_memory`; `canvas_search.iterative_all_pages_search_memory_fallback`; `proto.lib.device_low_memory`.
- WebGL error: `webgl_error.message.we_cant_open_that_file_header`, `.we_cant_open_this_file_webgl_trouble`, `.webgl_disabled`, `.if_this_problem_persists`, `.this_help_article_link`, `.got_it`.
- Hardware acceleration: `hardware_acceleration_detector.message`, `.learn_more`.
- TSMER modal: `tsmer_config.modal.levers_label`, `.edit_frame_budget_seconds`, `.edit_frame_budget_render_target_switches`, `.max_edit_frame_time_seconds`, `.reset`.
- Debug actions: `fullscreen_actions.<action>` for every action in §10.3.
- Help links: "Reduce memory usage in files" (360040528173); "Configure your browser for Figma" (360039828614).
- Console / log strings (English in the binary): "WebGL context was lost and could not be restored", "WebGL context was repeatedly lost after forced restoration", "Context still lost, requesting restore (attempt N)", "WebGPU device was lost: ", "WebGPU device was re-initialized after timeout.", "No WebGPU adapters found. We should fallback to WebGL.", "Couldn't change memory mode", "Low Mem GPU: successfully freed memory.".

---

## 14. DesignerV2 today

| Area | DesignerV2 | vs Figma |
|---|---|---|
| Backend choice | WebGPU when `navigator.gpu` gives a high-performance, non-fallback, non-compatibility adapter; empty blocklist; after 2 fallbacks on the machine, WebGL2; `?gfx=webgl\|webgpu` (`gfx.ts`) | **Differs.** No low-power / default adapter retry. No WebGL1 path or Radeon rule. No platform rules (Safari / Firefox < 141 / Linux). Asks for `requiredLimits.maxTextureDimension2D` (Figma doesn't, so it gets 8192). Figma's defaults are WebGL unless a rollout flag is on |
| Device / context loss | `webglcontextlost` → `preventDefault` + `engine.contextLost()`; restored → `contextRestored()` (`CanvasController.ts:356`); WebGPU loss falls back to WebGL2 | **Partial.** No 3 s forced `restoreContext()` poll (3 attempts), no restore-loop guard (3, reset after 30 s), no WebGPU re-init after 3 s |
| Hardware-acceleration warning | none | **Missing** (SwiftShader detector and visual bell) |
| Render worker | Main-thread engine per file process | **Missing** (canvas.md §2.19) |
| Tiles | Canvas-sized content cache. 256² zoom tiles in 2048² atlases, 128 MB, only for slow-page zooms (`Renderer.h:551–572`); pool 192 MB | **Differs.** Figma: 256 / 512 tiles picked by screen size (≥ 1920×1080 device px → 512), AA passes, a sharpness quadtree |
| Image cache | 512 MB `ImageCache` budget; tiers ≤ 512 fitted (not halved); 4096 cap with no half-area exception | Partial (canvas.md §2.5) |
| Glyphs | Analytic curve coverage, `CurveCache` 64 MB | Different by design (keep) |
| Memory cap | Wasm `MAXIMUM_MEMORY=4GB`. engine.md §1.4 documents `MEMORY_PRESSURE` at 2.5 / 3.5 GiB, but **no code emits it** (no hits in `engine/src` or `src`) | **Missing.** No heap limit by mode, no 90 % threshold, no recovery mode |
| Memory UI | View › Memory usage: a chip with engine bytes + JS heap in **MB**, polled every 1 s (`CommandOverlays.tsx:164`) | **Differs.** Figma shows a % of the mode's limit in a Pages-panel card, with warning, OOM and recovery flows and a manage-memory modal |
| Page loading | Pages are derived on first show; all nodes are decoded at load (`engine.md` §3.4) | Partial. No unloading, no packed subtrees, no load-all-pages mode |
| Scheduling | rAF on demand with `nextFrameDelay`; `requestIdleCallback` for thumbnails, search and images (timeouts 200 / 2000 / 4000 / 5000 ms) | Partial. No `scheduler.postTask` priorities for engine work |
| Export routing | Main-thread offscreen render, no budgets | **Missing** (§9.3) |
| Telemetry | none (`engine-bench` offline only) | **Missing.** No slow-frame sampling or fps / dropped-frame histograms |
| Debug overlays | `engine_stats`; `?engine` playground | **Missing** in-app overlays: dirty tiles, expensive tiles, heat map, resource use |

---

## 15. Open questions

| # | Question | Probe that settles it |
|---|---|---|
| 1 | The exact small / large tile rule (is it the screen or the canvas size? what does the 512-tile count + 16 compare against?) and the tile cache's byte cap | Decompile wasm @0x1f815b0 and its callers with a proper disassembler (one bounded `llvm-objdump --start-address` window). Live: `toggle-resource-use` on a 1440×900 @2× screen and on a 1280×720 @1× window, and read "Rendered Tile VRAM" |
| 2 | What `handleHighMemoryUsageThresholdReached()` frees (page unloading? compressed image data? undo?) | Live: an internal build, or `DebuggingHelpers.forceHighMemoryOptimizations()` in a debug session, and watch `dynamic_page_unloading_result` |
| 3 | The stale-tile force-redraw age and the AA pass count (`maxAAPassCount`) | Disassemble around `_bgtTilesOldForcedOverBudget` / "passIndex < maxAAPassCount". Live: screen-record a zoom-out on a heavy page at 240 fps |
| 4 | Whether Figma desktop has a "disable hardware acceleration" menu item, and its label | Open Figma desktop › Help menu (and the Electron app's `app.asar`, not in this cache) |
| 5 | The WebGPU rollout flags' current values for this account (`use_webgpu`, `webgl_fallback_triggers`) | Live: in Figma web, read `window.INITIAL_OPTIONS.feature_flags` / `dynamic_configs` in the console |
| 6 | When MERGE_MODAL and LOAD_ALL_PAGES are switched on and off | `rg` callers of `F4(`/`setHeapMemoryMode` with mode 2 / 3 in 3187 and figma_app (bounded windows) |
| 7 | The session memory-leak alert threshold | Disassemble the reference to "session_delta_bytes has exceeded alerting threshold" |
| 8 | Whether small text gets any special handling (minimum size, hinting at 1×) | Live: compare Figma and DesignerV2 renders of 4–8 px text at 100 % (`engine:shot` against a Figma export) |
