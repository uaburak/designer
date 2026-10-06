# Engine — architecture and UI↔engine contract

Status: contract for phase 1 (2026-10-06). It replaces the DOM editor (`src/renderer/src/figma/NodeView.tsx`, `css.ts`, `Canvas.tsx` picking/overlays). Implementers build against this document without coordinating. If a decision here has to change, change this file first.

> **Schema alignment (2026-10-06).** `schema/document.kiwi` + `docs/schema.md` were finished after this document and decide every field name. Where this document differs, the schema wins — see `docs/schema.md` §14: component-property bindings are `PROP_REF` entries in `parameterConsumptionMap` (not `componentPropRefs`); variable bindings use `parameterConsumptionMap` only; style references are `styleIdFor*` only; library copies carry `key`, `sourceLibraryKey`, `publishID`, `version` and per-node `overrideKey` (not `sharedSymbolReference`/`sharedStyleReference`/`componentKey`); `backgroundColor` is CANVAS-only (frames use `fillPaints`); `TextData.lines` is source data (layout lives in `derivedTextData`); a CREATED change for a live GUID is a full replace; `textPathStart` is not in v1.

Facts this document builds on: `docs/research/figma/R1-engine.md` (Figma's engine), `R2-document.md` (document model, `.fig`), `R3`/`R4` (variables, components), `figma-schema.kiwi` (Figma's real schema; the field names below are its names), `docs/research/code/model.md` + `editor.md` (what the current code does and what it should port).

---

## 0. What the engine is

One C++20 code base, compiled with Emscripten to one WebAssembly module. Each file tab (its own `WebContentsView` and renderer process) loads one instance of it. It draws everything on the canvas into **one WebGL2 `<canvas>`** with **our own renderer** (no Skia, no CanvasKit, no DOM design objects).

The engine owns:
- the scene graph and every derived value: world transforms, bounds, auto layout, constraints, text layout, instance subtrees, variable/style resolution;
- rendering, including canvas overlays;
- hit-testing, selection, tools and gestures, snapping;
- undo/redo and the transaction model;
- clipboard encoding;
- export rasterization.

TypeScript/React owns:
- the panels, menus, the toolbar, dialogs, Home and the tab bar;
- persistence (it receives change messages from the engine);
- I/O: fonts, image bytes and decoding, the clipboard, files. The engine asks for these through events.

Invariants (they hold in every milestone):
1. **The document is a flat table** `GUID → typed properties`, encoded and decoded as kiwi `NodeChange`s of `schema/document.kiwi`. The engine never invents a second format.
2. **Every mutation goes through a transaction** (§9). A committed transaction produces exactly one change `Message` (for persistence) and at most one undo batch.
3. **Geometry is real**: auto layout, constraints, group bounds and text auto-resize write `size`/`transform` into the document, inside the same transaction as the edit that caused them. Nothing is measured from a browser.
4. **The engine is never the only copy.** Committed changes leave the engine immediately. If the Wasm instance aborts, the tab reloads from storage and nothing committed is lost.
5. **No re-entrancy.** JS never calls into the engine from inside an engine call. Engine→JS notifications are queued and drained after each call (§10.4).
6. **Single user.** There is no multiplayer code. The change messages are per-property, so per-property last-writer-wins sync (Firestore) can be added later without engine changes.

```
 React panels ──useSyncExternalStore── EngineStore ◄─ events (kiwi EngineEvents) ─┐
      │ commands / set_props / reads (kiwi)                                      │
      ▼                                                                          │
 Engine.ts facade ── EngineExports.generated.ts ── C ABI (engine_*) ──► api/ ────┤
                                                                     editor/ tools/ hit/
                                                                     scene/ derive/ layout/ text/ geometry/
                                                                     render/ ── gfx/Device ── gl/ (webgpu/ later)
 storage (main/utility) ◄── DOCUMENT_CHANGED Message bytes ──────────────────────┘
```

---

## 1. Source layout, toolchain, build

### 1.1 Tree

```
engine/
  CMakeLists.txt                 top level: options, third_party, targets
  CMakePresets.json              wasm-debug, wasm-release, wasm-node, native-test, native-bench
  .clang-format                  LLVM base, ColumnLimit 120
  cmake/
    Flags.cmake                  shared compile flags, warnings, sanitizers
    Emscripten.cmake             link flags of the wasm targets (§1.4)
    Generators.cmake             add_custom_command for schemagen / apigen / shadergen
  api/
    api.def.ts                   THE C ABI definition (single source of truth, §10)
    commands.def.ts              CommandId list + metadata (label, undoable, args message)
    engine-api.kiwi              API message types: options, NodeRef, events, layer rows, derived info, command args
  shaders/
    common/*.glsl                includes (paint.glsl, sdf.glsl, color.glsl, loopblinn.glsl)
    *.vert, *.frag               §6.10
  src/
    base/       Types.h Assert.h Result.h Span.h SmallVec.h FlatMap.h Arena.h InternTable.{h,cpp}
                ByteBuffer.{h,cpp} (kiwi wire format) Guid.h FractionalIndex.{h,cpp} Hash.h Log.{h,cpp} Time.h Utf.{h,cpp}
    math/       Vec2.h Mat2x3.h Rect.h Color.h Bezier.{h,cpp} Solve.{h,cpp}
    schema/     SchemaSupport.h (hand-written helpers); generated code lands in ${build}/generated/schema/
    scene/      Document.{h,cpp} NodeTable.{h,cpp} Facets.{h,cpp} Hierarchy.{h,cpp} Txn.{h,cpp} ChangeSet.{h,cpp}
                Apply.{h,cpp} (Message → doc) Encode.{h,cpp} (doc → Message) Blobs.{h,cpp} Pages.{h,cpp}
    derive/     Pipeline.{h,cpp} Dependencies.{h,cpp} Materializer.{h,cpp} Variables.{h,cpp} Styles.{h,cpp}
                WorldTransforms.{h,cpp} Bounds.{h,cpp}
    layout/     Layout.{h,cpp} AutoLayout.{h,cpp} GridLayout.{h,cpp} Constraints.{h,cpp} Groups.{h,cpp}
    geometry/   Path.{h,cpp} VectorNetwork.{h,cpp} Shapes.{h,cpp} CornerSmoothing.{h,cpp} Flatten.{h,cpp}
                CubicToQuad.{h,cpp} Stroker.{h,cpp} Dasher.{h,cpp} Boolean.{h,cpp} PathHitTest.{h,cpp} LoopBlinn.{h,cpp}
    text/       FontRegistry.{h,cpp} FontFace.{h,cpp} Itemizer.{h,cpp} Shaper.{h,cpp} LineBreaker.{h,cpp}
                TextLayout.{h,cpp} GlyphCache.{h,cpp} TextEditor.{h,cpp} CaseMap.{h,cpp} Bidi.{h,cpp}
    render/     Renderer.{h,cpp} RenderTree.{h,cpp} DrawList.{h,cpp} Paints.{h,cpp} ImageCache.{h,cpp}
                MaskAtlas.{h,cpp} PathRenderer.{h,cpp} Effects.{h,cpp} Layers.{h,cpp} Tiles.{h,cpp}
                Overlay.{h,cpp} OverlayStyle.h Camera.{h,cpp}
    gfx/        Device.h GfxTypes.h ShaderLibrary.{h,cpp}
                gl/GLDevice.{h,cpp}          WebGL2 backend (wasm only)
                null/NullDevice.{h,cpp}      records calls; used by native tests
                webgpu/                      later (E9), empty except README
    hit/        SpatialIndex.{h,cpp} (dynamic AABB tree) HitTest.{h,cpp} Picking.{h,cpp} Marquee.{h,cpp}
    editor/     Editor.{h,cpp} Selection.{h,cpp} Undo.{h,cpp} Clipboard.{h,cpp} Commands.{h,cpp} commands/*.cpp
                Snapping.{h,cpp} Guides.{h,cpp} Measure.{h,cpp} Export.{h,cpp}
    tools/      Tool.h ToolController.{h,cpp} MoveTool.cpp ResizeGesture.cpp RotateGesture.cpp MarqueeGesture.cpp
                ShapeTool.cpp TextTool.cpp HandTool.cpp ZoomTool.cpp ScaleTool.cpp PenTool.cpp (E4)
    api/        Api*.cpp (implement every function of api.def.ts) Handles.{h,cpp} EventQueue.{h,cpp}
                ResultSlot.{h,cpp} js/library_engine.js
    export/     SvgWriter.{h,cpp} PdfWriter.{h,cpp} (E7)
  tests/        CMakeLists.txt main.cpp unit/*.test.cpp data/ golden/ render/{harness.html,run-golden.mjs}
  bench/        *.bench.cpp (native-bench preset)
  third_party/  harfbuzz/ libunibreak/ sheenbidi/ utf8proc/ doctest/   (each: sources, LICENSE, VERSION, our CMakeLists.txt)
  tools/        build.mjs watch.mjs gen.mjs schemagen/ apigen/ shadergen/
```

C++ namespace: `eng`. Naming: types `PascalCase`, functions and variables `camelCase`, constants `kName`, members with a trailing `_`.

### 1.2 Language and compiler rules
- **C++20** (`-std=c++20`) for both targets.
- **No exceptions** (`-fno-exceptions`; Emscripten `-sDISABLE_EXCEPTION_CATCHING=1`, which is the default). **No RTTI** (`-fno-rtti`). Errors are `eng::Result<T>` / status codes. Invariant breaks are `ENG_ASSERT` (debug) and `ENG_CHECK` (always on, aborts with a message).
- **Not allowed**: `<iostream>`, `<regex>`, `std::thread`, `std::function` in hot paths, global constructors with work (they run at instantiation).
- Allowed: STL containers, `std::span`, `std::string_view`. Hot-path maps use `eng::FlatMap`, an open-addressing map, not `std::unordered_map`.
- Warnings: `-Wall -Wextra -Wpedantic -Werror -Wno-unused-parameter`. Warnings are off for `third_party/`.
- Floating point: document values are `float` (what kiwi stores). Camera, zoom and the camera-relative world→device composition use `double` (§6.12). `-ffast-math` is **off**, because the native and wasm builds must give the same layout results.
- Wasm: `-msimd128` (Chromium in Electron supports it). Use SIMD only through `math/`.

### 1.3 Toolchain
- **emsdk 6.0.11** at `~/emsdk` (verified: `upstream/emscripten/emscripten-version.txt`). The exact version is pinned in `engine/EMSDK_VERSION`. `build.mjs` warns when the active version differs.
- **CMake 4.4** and **Ninja 1.13** at `~/Library/Python/3.9/bin`. `build.mjs` prepends that directory to `PATH` when `cmake`/`ninja` aren't found.
- **Apple clang 21** for native builds and tests.
- **Node ≥ 24** for the generators. They are TypeScript that Node runs directly (type stripping), so use erasable syntax only: no `enum`, `namespace` or parameter properties. Bump `engines.node` and `.nvmrc` to 24.
- New devDependencies: `kiwi-schema` (MIT, schema parser for the generators) and `pngjs` + `pixelmatch` (MIT, golden tests).

### 1.4 Emscripten flags (cmake/Emscripten.cmake)

Compile flags (every wasm preset): `-std=c++20 -fno-exceptions -fno-rtti -msimd128`.

Link flags, common to every wasm preset:

```
-sWASM=1
-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngineModule
-sENVIRONMENT=web                       # wasm-node preset: -sENVIRONMENT=node
-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_HEAP=64MB -sSTACK_SIZE=2MB
-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2   # (-sUSE_WEBGL2 is deprecated in 6.x; do not use)
-sGL_ENABLE_GET_PROC_ADDRESS=0 -sGL_SUPPORT_AUTOMATIC_ENABLE_EXTENSIONS=0
-sFILESYSTEM=0 -sSUPPORT_LONGJMP=0 -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2 -sPOLYFILL=0
-sEXPORTED_FUNCTIONS=@${build}/generated/api/exports.txt     # generated from api.def.ts, plus _malloc,_free
-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPU32,HEAPF32,HEAPF64
-sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr,onAbort
-sSTRICT=1
--js-library ${src}/api/js/library_engine.js
```

| preset | extra compile | extra link |
|---|---|---|
| `wasm-debug` | `-O1 -g` | `-gsource-map -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2 -sGL_ASSERTIONS=1` |
| `wasm-release` | `-O3 -flto -DNDEBUG` | `-O3 -flto -sASSERTIONS=0 -sGL_TRACK_ERRORS=0` |
| `wasm-node` | `-O2 -DENG_HEADLESS_ONLY` | `-sENVIRONMENT=node`, no GL backend linked; for vitest integration tests |

Notes:
- `EXPORTED_FUNCTIONS` comes from the generated list. `ENG_EXPORT` (= `extern "C" EMSCRIPTEN_KEEPALIVE` in wasm, `extern "C" __attribute__((visibility("default")))` natively) is still put on every definition, so the native tests can call the same ABI.
- `MAXIMUM_MEMORY=4GB` means pointers above 2 GiB come back to JS as negative i32. **The generated TS wrapper applies `>>> 0` to every pointer/u32 return.** Emscripten handles its own glue.
- Memory growth replaces the heap views. **TS never caches a `HEAPU8` view across engine calls**: it reads `module.HEAPU8` fresh each time.
- `ABORTING_MALLOC` is off (because of `ALLOW_MEMORY_GROWTH`), so `malloc` returns 0. `operator new` failure still aborts, and abort = tab reload (invariant 4). The engine emits `MEMORY_PRESSURE` at 2.5 GiB and 3.5 GiB of heap.
- Single-threaded: no pthreads, no `SharedArrayBuffer`, so no COOP/COEP is needed now. A later render worker would need `OFFSCREENCANVAS_SUPPORT`, pthreads and COOP/COEP headers from the `app://` protocol.

### 1.5 CMake presets (engine/CMakePresets.json)

- `wasm-debug`, `wasm-release`, `wasm-node`:
  - generator `Ninja`
  - toolchain `$env{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`
  - `binaryDir` `${sourceDir}/build/<preset>`
  - cache var `ENG_TARGET=wasm`
- `native-test`:
  - generator `Ninja`, compiler `/usr/bin/clang++`, `CMAKE_BUILD_TYPE=Debug`
  - `ENG_SANITIZE=address;undefined` (`-fsanitize=address,undefined -fno-sanitize-recover=all`)
  - builds `engine_tests`; test preset runs `ctest --output-on-failure`
- `native-bench`: `RelWithDebInfo`, no sanitizers, builds `engine_bench`.

`engine/build/` is gitignored.

Targets:
- `eng_core` (static): base, math, scene, derive, layout, geometry, text, hit, editor, tools, render, gfx interface, gfx/null.
- `eng_gfx_gl`: wasm only.
- `third_party_hb`, `third_party_unibreak`, `third_party_sheenbidi`, `third_party_utf8proc`.
- `engine_wasm`: outputs `engine.mjs` + `engine.wasm`.
- `engine_tests`, `engine_bench`: native.

### 1.6 npm scripts and outputs

```jsonc
"engine:gen":         "node engine/tools/gen.mjs",                     // TS outputs of schemagen/apigen; `-- --check` fails if stale
"engine:build":       "node engine/tools/build.mjs wasm-release",
"engine:build:debug": "node engine/tools/build.mjs wasm-debug",
"engine:build:node":  "node engine/tools/build.mjs wasm-node",
"engine:test":        "node engine/tools/build.mjs native-test --test",
"engine:watch":       "node engine/tools/watch.mjs",                  // rebuilds wasm-debug on change in engine/, schema/
"engine:golden":      "node engine/tests/render/run-golden.mjs",      // §11.3
"predev":      "npm run engine:build:debug",
"predev:demo": "npm run engine:build:debug",
"prebuild":    "npm run engine:build",
"check":       "npm run engine:gen -- --check && npm run typecheck && npm run lint && npm test && npm run engine:test"
```

`build.mjs <preset> [--test]` does the following:
1. Finds emsdk (`$EMSDK` or `~/emsdk`) and sets `EMSDK`, `EM_CONFIG` and `PATH` (emsdk dirs plus `~/Library/Python/3.9/bin`). It does not source `emsdk_env.sh`.
2. Runs `cmake --preset <preset>` (first time only), then `cmake --build --preset <preset>`.
3. For wasm presets, copies the outputs:
   - `wasm-debug`/`wasm-release` → `src/renderer/src/engine/wasm/engine.mjs`, `engine.wasm` (+ `engine.wasm.map` for debug)
   - `wasm-node` → `engine/build/wasm-node/engine-node.mjs` + `.wasm`, used by vitest
4. With `--test`, runs `ctest --preset native-test`.

`src/renderer/src/engine/wasm/` is gitignored. Vite picks up `engine.wasm` through the `new URL("engine.wasm", import.meta.url)` that the ES6 glue contains, and emits it as an asset.

Generated code:
- **C++ is generated into `${build}/generated/`** and never committed. It comes from CMake custom commands that run the generators with `DEPENDS` on `schema/document.kiwi`, `engine/api/*`, `engine/shaders/*` and `engine/tools/schemagen/fieldmeta.ts`.
- **TS is generated into the source tree and committed**, so `npm run typecheck` works without emsdk:
  - `src/renderer/src/engine/generated/EngineExports.generated.ts`
  - `src/renderer/src/engine/generated/api.generated.ts` (codec and types for `engine-api.kiwi`)
  - `src/renderer/src/engine/generated/fields.generated.ts`
  - `src/renderer/src/engine/generated/commands.generated.ts`
  - `src/shared/schema/document.generated.ts` (codec and types for `document.kiwi`, shared with main/storage; see §14 Q1)
- `engine:gen -- --check` regenerates into a temp directory and diffs.

### 1.7 Electron requirements (for the shell architect)
- CSP `script-src 'self' 'wasm-unsafe-eval'`. Today's `src/main/index.ts` CSP has `script-src 'self'`. The dev server page has no CSP.
- The `app://` protocol handler must serve `.wasm` with `Content-Type: application/wasm`, so that `WebAssembly.instantiateStreaming` works. Set it explicitly; don't rely on `net.fetch` of a file URL.
- Register the scheme with the `codeCache: true` privilege (V8 code cache for the large glue/wasm).
- Each tab document contains exactly one `<canvas id="engine-canvas">`, created by `EngineCanvas.tsx`. `engine_create` gets the selector `"#engine-canvas"`.
- The UI font file `src/renderer/public/fonts/InterVariable.ttf` (OFL 1.1) ships with the app. It is the canvas UI font (labels, size badge) and the default document font ("Inter", 12, Regular).

---

## 2. Scene graph

### 2.1 Contract with `schema/document.kiwi`
The schema architect writes `schema/document.kiwi` (in parallel). The engine compiles against it through `tools/schemagen` and needs the following. Names are Figma's (`figma-schema.kiwi`).

- `struct GUID { uint sessionID; uint localID; }` and `struct ParentIndex { GUID guid; string position; }`.
- `message NodeChange` with `guid=1`, `phase=2` (`CREATED|REMOVED`), `parentIndex=3`, `type=4`, `name=5`, and the property fields. **A field id is never reused.** The engine's `Field` enum value equals the kiwi field id.
- `message Message { MessageType type; uint sessionID; NodeChange[] nodeChanges; Blob[] blobs; … }`. `struct Blob { byte[] bytes; }`. Fields such as `commandsBlob`/`vectorNetworkBlob`/`dataBlob` are indices into `Message.blobs`.
- **A way to clear a field** in a patch. The engine needs it for unbinding a variable, removing an override, and resetting to default. It writes `uint[] clearedFields` (field ids) on NodeChange unless the schema names it otherwise (§14 Q1).
- Node types as Figma's `NodeType`: `DOCUMENT, CANVAS, FRAME, GROUP, VECTOR, STAR, LINE, ELLIPSE, REGULAR_POLYGON, ROUNDED_RECTANGLE, TEXT, SLICE, SYMBOL, INSTANCE, BOOLEAN_OPERATION, SECTION, VARIABLE_SET, VARIABLE, …`.
  - **Groups**: real Figma files store a group as a `FRAME` with `resizeToFit=true` and no fills (verified in `samples/structure.fig`: "Group 1", "Group 2"). The engine treats `GROUP` and `FRAME && resizeToFit` identically ("group semantics").
- **Child transforms are relative to the direct parent, groups included.** Verified: "Rectangle 2" in "Group 2" has translation (0,0); the group has (37,34).

`tools/schemagen/fieldmeta.ts` is **the one place** that maps schema field names to engine semantics (§2.3). If the schema renames a field, only that table changes.

### 2.2 Storage
- **`NodeId`** is a dense `uint32` slot index into `NodeTable`, plus a generation in a parallel array; 0 is null.
- **`Guid`** is packed into a `uint64`. `FlatMap<uint64, NodeId> guidToId`.
- **Core columns** in `NodeTable`, one array per column (SoA), for the hot passes:
  - `guid`, `type`, `parent` (NodeId), `children` (`SmallVec<NodeId,4>`, sorted)
  - `position` (interned string id), `name` (interned)
  - `flags` (`visible`, `locked`, `mask`, `clipsContent`, `isDerived`, `isGroupLike`, `hasEffects`, …)
  - `dirty` (§3.1)
  - `transform` (`Mat2x3f`, Figma's `Matrix m00 m01 m02 / m10 m11 m12`), `size` (`Vec2f`)
  - `world` (`Mat2x3f`), `worldBounds` and `renderBounds` (`RectF`)
  - `symbolRoot` (NodeId of the enclosing SYMBOL, or 0)
- **Facets**: typed property groups generated from the schema. A node has a facet record only once one of the facet's fields is set. Records live in per-facet pools; each node has one `uint32` slot per facet (0 = absent).

  | Facet | Fields (Figma names) |
  |---|---|
  | `Paint` | `fillPaints, strokePaints, strokeWeight, strokeAlign, strokeCap, strokeJoin, miterLimit, dashPattern, borderTopWeight…, borderStrokeWeightsIndependent, opacity` (copy), `blendMode` |
  | `Corner` | `cornerRadius, rectangle*CornerRadius, rectangleCornerRadiiIndependent, cornerSmoothing` |
  | `Effect` | `effects` |
  | `Stack` (container) | `stackMode, stackSpacing, stackCounterSpacing, stackHorizontalPadding, stackVerticalPadding, stackPaddingRight, stackPaddingBottom, stackPrimarySizing, stackCounterSizing, stackPrimaryAlignItems, stackCounterAlignItems, stackCounterAlignContent, stackWrap, stackReverseZIndex, bordersTakeSpace, gridRows, gridColumns, gridRowGap, gridColumnGap, gridRowsSizing, gridColumnsSizing` |
  | `StackChild` | `stackChildPrimaryGrow, stackChildAlignSelf, stackPositioning, minSize, maxSize, gridRowAnchor, gridColumnAnchor, gridRowSpan, gridColumnSpan, gridChildHorizontalAlign, gridChildVerticalAlign, horizontalConstraint, verticalConstraint, proportionsConstrained` |
  | `Frame` | `frameMaskDisabled, resizeToFit, layoutGrids, isStateGroup, backgroundColor, scrollBehavior` |
  | `Text` | `textData, fontName, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, textAlignHorizontal, textAlignVertical, textAutoResize, textTruncation, maxLines, textCase, textDecoration, leadingTrim, fontVariations, fontVariant*` |
  | `Vector` | `vectorData, handleMirroring, arcData, count, starInnerScale, booleanOperation, textPathStart` |
  | `Symbol` | `symbolData, componentPropDefs, componentPropRefs, componentPropAssignments, overrideKey, sharedSymbolReference, componentKey` |
  | `Binding` | `parameterConsumptionMap, variableConsumptionMap, variableModeBySetMap, styleIdForFill, styleIdForStrokeFill, styleIdForText, styleIdForEffect, styleIdForGrid, inheritFillStyleID…` |
  | `Variable` | `variableSetModes, variableSetID, variableResolvedType, variableDataValues, variableScopes, key, styleType` |
  | `Misc` | `exportSettings, prototypeInteractions, internalOnly, isPageDivider, …` |
  | `Opaque` | every field `fieldmeta.ts` doesn't list: kept as raw kiwi-encoded bytes per field id, decoded never, re-encoded verbatim, so round-trips are lossless. |

- **Strings** are interned (`InternTable`). Blob-backed values (`vectorNetworkBlob`, path blobs, `image.hash`) are owned by `Blobs` (refcounted byte arrays). On encode they are re-emitted with fresh indices.

### 2.3 Field metadata (generated from `fieldmeta.ts`)
`kFieldInfo[fieldId] = { facet, cppType, dirtyMask, flags }`. The flags are:
- `OVERRIDABLE`: may be written on an instance sublayer (R4 §3: text properties, `fillPaints`, `strokePaints`, `strokeWeight`, `effects`, `layoutGrids`, `exportSettings`, `name`, `visible`, `opacity`, corner radii, `stack*` spacing/padding/alignment, `overriddenSymbolID`, and `size` on the instance root only).
- `BINDABLE(VariableField)`: can carry a variable binding (R3 §2, R3-25).
- `LAYOUT_INPUT` / `LAYOUT_OUTPUT`: `size` and `transform` are outputs when the node is laid out.
- `DERIVED_CACHE`: never written by the engine, dropped on import. These are `fillGeometry, strokeGeometry, derivedTextData, derivedSymbolData`, and the layout parts of `textData` (`glyphs, baselines, layoutSize, lines`).
- `NOT_PERSISTED`: in-memory only.

`fieldmeta.ts` is reviewed whenever the schema changes. `schemagen` fails the build when a field it lists is missing from the schema.

### 2.4 Hierarchy and order
- `parentIndex` is one atomic property (R2 §2). Children are sorted by `position` (byte-wise compare), ties broken by GUID. **Index 0 is the bottom layer** (back-to-front, as in Figma's API).
- **Fractional positions are Figma's base-95 digits**: ASCII 0x20 (`' '` = 0) to 0x7E (`'~'` = 94).
  - `base/FractionalIndex`: `between(a,b)`, `before(a)`, `after(a)`, `nBetween(a,b,n)`. A generated key never ends with digit 0.
  - The TS twin must produce identical keys. Both are tested against `engine/tests/data/fractional-index-vectors.txt`.
- **Reparent validation**: a node can't become its own ancestor; CANVAS only under DOCUMENT; DOCUMENT has no parent; VARIABLE/VARIABLE_SET only under a CANVAS with `internalOnly`.
  - A user transaction that violates this is rejected (`E_INVALID`).
  - An incoming message (`engine_apply_changes`) that violates it, or whose parent hasn't arrived yet, parks the node in an **orphan list**: not rendered, re-tried at the end of the apply. Orphans still left are reported once (`NOTIFY`) and kept, so they round-trip.

### 2.5 Identity
- **GUID allocation**: storage assigns a `sessionID` per open file session (a counter persisted with the file) and passes it in `EngineOptions.sessionID`. The engine allocates `localID` from 1 upward, skipping ids already used in that session. `sessionID 0` is reserved for the DOCUMENT `0:0`, pages created by Home, and the internal canvas.
- **Derived nodes** (instance sublayers, §3.3) are rows in the same `NodeTable` with `isDerived`. They are never encoded. Their identity is a **`NodeRef` path**: `[instanceGuid, overrideKey₁, …]`, where `overrideKey(n) = n.overrideKey ?? n.guid` of the component node (R4 §3).
  - String form for TS/React keys, Figma's format: `"12:34"` for a real node, `"I12:34;5:6;7:8"` for a derived one.
  - `FlatMap<pathHash, NodeId>` keeps a derived node's `NodeId` stable across re-materialization while the structure is unchanged, so selection survives edits to the main component.
- **Copies of component subtrees keep the source's `overrideKey`.** This covers duplicate, paste, library copies and "Move to this file", and is how instances' overrides keep matching after the main is replaced by a new copy.

### 2.6 Pages
- Pages are CANVAS children of `0:0`. The internal canvas (`internalOnly=true`) holds local styles, variable collections and variables, and read-only library copies. It is never shown and never drawn.
- `currentPage` and the per-page selection are editor state, not document state.
- **Dynamic page loading is supported by design.** A page can be a stub (CANVAS with `childrenLoaded=false` in memory). Switching to it emits `REQUEST_PAGE`; storage answers with `engine_apply_changes(…, APPLY_LOAD)`. The internal canvas is always loaded. This is implemented after E7; until then everything loads.

---

## 3. Derived data and invalidation (Materializer spirit)

### 3.1 Dirty bits (per node, `NodeTable.dirty`)
`HIERARCHY`, `INSTANCE` (re-materialize), `BINDINGS` (re-resolve variables/styles), `TEXT` (re-shape), `LAYOUT` (this node's own layout must run), `LAYOUT_SUBTREE`, `GEOMETRY` (paths/strokes), `WORLD` (world transform), `BOUNDS`, `RENDER` (render-tree node), `PAINT_ONLY` (tiles only).

A write marks `kFieldInfo[f].dirtyMask` on the node and propagates:
- `LAYOUT` goes up to the **layout root**: the nearest ancestor that is not auto-layout and not hugging.
- `WORLD` goes down (lazily: the pass walks dirty subtrees).
- Writes inside a component subtree go to the instances that depend on it (§3.2).

### 3.2 Dependencies (`derive/Dependencies`)
`Dependencies` keeps reverse edges `source → dependents` as `FlatMap<uint64 sourceKey, SmallVec<DepEdge>>`, where an edge is `{dependent NodeId, kind}`. Derivers record them while deriving and clear a dependent's old edges before re-deriving it, which gives automatic dependency tracking with push invalidation, as Figma's Materializer does.

| source key | recorded by | pushes |
|---|---|---|
| component root (SYMBOL NodeId) | Materializer | `INSTANCE` on each instance using it, nested ones included |
| VARIABLE NodeId | Variables resolver, per consumer field | `BINDINGS` on the consumer |
| VARIABLE_SET (mode list/default change) | resolver | `BINDINGS` on consumers of its variables |
| node with `variableModeBySetMap` | resolver | `BINDINGS` on descendants that resolved through it |
| style node | Styles | `BINDINGS` on consumers |
| font face key | text layout | `TEXT` on text nodes that use it (font arrived, or went missing) |
| image hash | render | `PAINT_ONLY` |

`symbolRoot` is cached per node and updated on reparent. A write to a node with `symbolRoot ≠ 0` pushes `INSTANCE` to that root's dependents.

### 3.3 Update pipeline (`derive/Pipeline`), fixed order
Run by `Txn::flush()` (inside a gesture), by `Txn::commit()`, and by `engine_tick`:

1. **Hierarchy**: re-sort dirty child lists, resolve orphans, update `symbolRoot`.
2. **Materialize** (`derive/Materializer`) every `INSTANCE`-dirty instance, outermost first.
   - The blueprint is the main component's subtree (`symbolData.symbolID`, or the swapped `overriddenSymbolID`).
   - Apply property refs (`componentPropRefs` VISIBLE / TEXT_DATA / OVERRIDDEN_SYMBOL_ID / … from `componentPropAssignments`, falling back to the defaults in `componentPropDefs`), then `symbolData.symbolOverrides` matched by `guidPath`. Usage-site overrides beat overrides baked into nested instances.
   - Nested instances recurse. Derived nodes keep their NodeIds by path and only changed props mark `RENDER`. Cycle guard: depth 16.
3. **Bindings** (`derive/Variables`, `derive/Styles`) for `BINDINGS`-dirty nodes, derived nodes included.
   - Mode of collection C for node n: the nearest ancestor-or-self (the page included) with a `variableModeBySetMap` entry for C; otherwise C's default (first) mode.
   - Aliases resolve with the consumer's mode **per collection along the chain** (R3-09), depth ≤ 16, cycles → unresolved.
   - Styles copy their values (`fillPaints`, text props, `effects`, `layoutGrids`) into the consumer.
   - **Resolved values are written into the node's own field as system writes** (§9.1), the way Figma stores `Paint.color` next to `colorVar`. The document then always holds its resolved values, and a viewer or storage can read them without the resolver. For derived nodes the values stay in memory.
4. **Text layout** for `TEXT`-dirty nodes (§7). It gives the intrinsic size used by auto-resize and by layout's measure.
5. **Layout** (§4) from each dirty layout root. Outputs (`size`, `transform`) are system writes.
6. **Geometry** for `GEOMETRY`-dirty nodes: fill/stroke paths in local space (§5).
7. **World transforms and bounds** for `WORLD`/`BOUNDS`-dirty subtrees; update the spatial index (§8.1).
8. **Render tree sync** for `RENDER`-dirty nodes; invalidate tiles (§6.9).

Steps 1–5 run before a transaction commits, so their writes join its change message and undo batch. Steps 6–8 run lazily in `engine_tick`. Stages 2–5 depend on each other (an instance resized by layout changes its derived children's layout). One ordered pass per flush is enough: layout handles the instance sublayers in the same recursion, and materialization never depends on layout output.

### 3.4 Load
`engine_load` trusts the stored geometry. It does **not** re-run auto layout on load: Figma's files and ours already store laid-out geometry. It does:
- materialize all instances (their sublayers were never stored);
- resolve bindings;
- lay out text.

If a text node's measured auto-size differs from the stored size by more than 0.01, its layout ancestors are marked dirty. The resulting system writes leave as a non-undoable `DOCUMENT_CHANGED` of kind `SYSTEM`.

Text whose fonts are still pending keeps its stored size (no write) until the font arrives or is declared missing (§7.1).

---

## 4. Layout (`layout/`)

All layout is computed by the engine and written back as real `size`/`transform` (invariant 3). Figma's internal field names are used throughout.

### 4.1 Driver
`Layout::run(rootId)`:
1. **Measure, bottom-up**, with a per-pass memo keyed by `(node, availableW, availableH)`:
   - `measure(node, constraint)` returns the node's size for a given available size.
   - Text measures through `TextLayout` with a width constraint.
   - Groups measure as the union of their children.
2. **Arrange, top-down**: writes `size` and `transform` through `txn.systemSet`, which records nothing when the value is equal.

Math is in `double`, stored as `float`. Positions are not rounded, as in Figma (center alignment can give .5). The only rounding is pixel-grid snapping in gestures (§8.5).

### 4.2 Auto layout (`AutoLayout.cpp`): `stackMode HORIZONTAL | VERTICAL`
- **Padding**: `stackHorizontalPadding` (left), `stackVerticalPadding` (top), `stackPaddingRight`, `stackPaddingBottom`.
- **Gap**: `stackSpacing`. `stackPrimaryAlignItems = SPACE_BETWEEN` gives "Auto" gap; `SPACE_EVENLY` is supported too.
- **Container sizing**:
  - primary axis: `stackPrimarySizing` (`FIXED` | `RESIZE_TO_FIT*` = Hug)
  - counter axis: `stackCounterSizing`
- **Child sizing**:
  - primary Fill: `stackChildPrimaryGrow > 0`. Figma only uses 0/1; the engine splits remaining space proportionally anyway.
  - counter Fill: `stackChildAlignSelf = STRETCH`.
  - otherwise Fixed, or Hug for frames/text that hug.
- **Min/max**: `minSize`/`maxSize` clamp in both measure and arrange. Fill distribution iterates until no child is newly clamped (CSS flex freeze loop).
- **Alignment**:
  - primary: `stackPrimaryAlignItems` (MIN/CENTER/MAX/SPACE_BETWEEN/SPACE_EVENLY)
  - counter: `stackCounterAlignItems` (MIN/CENTER/MAX/BASELINE). BASELINE uses the first baseline of text children (from `TextLayout`; a frame's baseline is its first text descendant's).
- **Wrap** (`stackWrap=WRAP`, horizontal only):
  - lines are broken greedily by measured child sizes plus gap
  - `stackCounterSpacing` between lines
  - `stackCounterAlignContent` AUTO | SPACE_BETWEEN
- **Strokes in layout**: `bordersTakeSpace` adds the stroke weights (per side when independent) to the padding.
- **Absolute children** (`stackPositioning=ABSOLUTE`) are skipped by the flow and positioned by constraints (§4.4) against the frame.
- **`stackReverseZIndex`** changes paint order only (render tree), never positions.
- **Hidden children** (`visible=false`) take no space, as in Figma.

### 4.3 Grid (`GridLayout.cpp`): `stackMode GRID`
- Tracks are `gridColumns`/`gridRows` (GUIDPositionMap, each track has a GUID and a fractional position) sized by `gridColumnsSizing`/`gridRowsSizing`: fixed px, flex (fr), or hug. The algorithm is CSS-grid-like:
  1. fixed tracks;
  2. hug tracks = the max of the measured spanning items;
  3. flex tracks share what's left, by weight.
- Gaps: `gridColumnGap`/`gridRowGap`.
- Items:
  - placement `gridColumnAnchor`/`gridRowAnchor` (track GUIDs) plus `gridColumnSpan`/`gridRowSpan`
  - alignment `gridChildHorizontalAlign`/`gridChildVerticalAlign` (AUTO/MIN/CENTER/MAX), with AUTO = stretch for Fill items
- Automatic placement (2026 "auto rows/positioning") is row-major into the first free cells.

### 4.4 Constraints (`Constraints.cpp`)
- Applies to children of non-auto-layout frames, and to absolute children of auto-layout frames.
- Uses `horizontalConstraint`/`verticalConstraint`, `ConstraintType`: `MIN` (left/top), `MAX`, `CENTER`, `STRETCH` (left+right), `SCALE`.
- **Constraints act only when the parent's size changes inside a transaction.** The old size is the first-recorded old value of the parent's `size` in the current transaction (§9.1), so no extra state is needed.
- Constraints don't apply:
  - inside groups (groups follow their children, §4.5);
  - when the user resizes with ⌘ held: the gesture sets `ignoreConstraints` (Figma's behaviour).

### 4.5 Groups and boolean operations (`Groups.cpp`)
After children change, a group-like node (`GROUP`, `FRAME+resizeToFit`, `BOOLEAN_OPERATION`):
1. computes the union of its children's bounds in its own space;
2. sets `size` to that union;
3. moves its `transform` by `R·(dx,dy)` (R = its rotation/scale) and shifts each child's `transform` by `(−dx,−dy)`.

World positions stay put. Everything is a system write. An empty group is deleted at commit (Figma behaviour).

### 4.6 Text auto-resize
`textAutoResize`:
- `WIDTH_AND_HEIGHT`: size = the laid-out text bounds;
- `HEIGHT`: width fixed, height = content;
- `NONE`: fixed box, with `textAlignVertical` placement inside it.

`textTruncation=ENDING` with `maxLines` truncates with "…" (§7.4). With Fill/Hug in auto layout, text measures under the parent's constraint (wraps at the given width).

### 4.7 Tests
Real Figma files carry Figma's own layout results. The golden layout tests (§11.1):
1. import `samples/stacks_wrap.fig`, `sections.fig` and later fixtures;
2. mark every auto-layout node dirty;
3. re-run layout;
4. compare `size`/`transform` with the stored values, |Δ| ≤ 0.01.

---

## 5. Geometry (`geometry/`)

- **`Path`**: verbs (MOVE, LINE, QUAD, CUBIC, CLOSE) plus `float` points in local space.
  - Serialized as Figma's `commandsBlob` stream: a byte opcode `0=Z 1=M 2=L 3=Q 4=C`, then float32 LE coordinates (R2 §5).
  - Fill rule: `WindingRule NONZERO|ODD`.
- **Shapes** (`Shapes.cpp`):
  - rect/rounded rect with four radii, clamped like Figma: radii scale down proportionally when the sum on a side exceeds the side;
  - ellipse, with `arcData {startingAngle, endingAngle, innerRadius}` for pies and donuts;
  - `REGULAR_POLYGON` (`count`), `STAR` (`count`, `starInnerScale`), with corner radius on the vertices;
  - `LINE` (length = `size.x`), with arrow caps from `strokeCap`.
- **Corner smoothing** (`CornerSmoothing.cpp`): when `cornerSmoothing > 0`, each corner is built from Figma's squircle construction (arc plus two cubic transitions, with the extent `p = (1+ξ)·r` clamped to half the side). The result is a path. Smoothed rects never use the SDF fast path.
- **Vector networks** (`VectorNetwork.cpp`):
  - Parses and writes Figma's `vectorNetworkBlob` byte for byte (layout as in fig2sketch's `vector_network.py`, verified on the sample blobs): vertices, segments with tangents, regions with loops, winding rule and `styleID`.
  - Fill path = the regions' loops. Stroke = all segments.
  - `vectorData.normalizedSize` vs `size` gives the scale.
  - `styleOverrideTable` gives per-region fills.
- **Flattening and curves**:
  - `Flatten` turns curves into polylines with tolerance in device px (default 0.2), used for hit-tests, booleans and the stroker's inner work.
  - `CubicToQuad` approximates each cubic with quadratics within a **local-space tolerance** chosen for a precision level. Level ℓ = ⌈log2(maxDeviceScale)⌉, clamped to [0, 8], and is re-generated when the zoom crosses a level. The path renderer uses this output (§6.3).
- **Stroker** (`Stroker.cpp`) outputs a fill path:
  - Joins `strokeJoin` MITER/BEVEL/ROUND with `miterLimit`.
  - Caps `strokeCap` NONE/ROUND/SQUARE plus arrow caps (ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED, DIAMOND_FILLED).
  - `Dasher` applies `dashPattern` by arc length before stroking.
  - **`strokeAlign` INSIDE/OUTSIDE**: stroke the center line at 2×weight, then intersect with the fill (INSIDE) or subtract it (OUTSIDE). This is done at render time by stencil (§6.4); `Boolean` is used only when an explicit outline is needed (Outline stroke, export).
  - Per-side weights (`borderTopWeight…` with `borderStrokeWeightsIndependent`) apply to rect frames only.
- **Booleans** (`Boolean.cpp`, E4): `UNION/INTERSECT/SUBTRACT/XOR` over paths **that keep their curves**.
  - Algorithm: a C++ port of paper.js's boolean pipeline (MIT; keep its notice): bézier–bézier intersection by fat-line clipping, split at intersections, winding-number classification of each curve, then trace the result.
  - BOOLEAN_OPERATION nodes render live from their children's geometry (cached result path, recomputed on `GEOMETRY` dirtiness of any child).
  - Flatten (⌘E) writes the result as a VECTOR.
- **Path hit-testing** (`PathHitTest.cpp`): winding number on the flattened polyline at the current zoom tolerance; distance to the polyline for strokes and lines.

---

## 6. Renderer (ours)

### 6.1 Graphics interface (`gfx/Device.h`)
Explicit-argument draws, no global GL state above the backend (the same move Figma made before WebGPU, R1 §b):

```cpp
namespace eng::gfx {
enum class Format : uint8_t { RGBA8, R8, RG8, R16F, RGBA16F, D24S8 };
struct TextureDesc { uint32_t w, h, layers = 1, mips = 1, samples = 1; Format fmt; bool renderTarget = false; };
struct PipelineDesc { ShaderId shader; VertexLayoutId layout; BlendState blend; StencilState stencil;
                      ColorMask colorMask = ColorMask::All; Topology topology = Topology::Triangles; };
struct PassDesc { TargetId target; LoadOp colorLoad; Color clear; LoadOp stencilLoad; uint8_t clearStencil; IRect viewport; };
struct DrawCall {
  PipelineId pipeline; BufferSlice vertices, instances, indices; uint32_t count, instanceCount = 1;
  TextureId textures[4]; SamplerId samplers[4]; UniformSlice uniforms; IRect scissor; uint8_t stencilRef = 0;
};
class Device {
 public:
  virtual Caps caps() const = 0;                              // maxSamples, maxTextureSize, floatRenderable, …
  virtual TextureId createTexture(const TextureDesc&) = 0;
  virtual TargetId createTarget(TextureId color, TextureId depthStencil) = 0;
  virtual BufferId createBuffer(BufferKind, uint32_t bytes, Usage) = 0;
  virtual void write(BufferId, uint32_t offset, std::span<const uint8_t>) = 0;
  virtual void upload(TextureId, uint32_t level, uint32_t layer, IRect, std::span<const uint8_t>) = 0;
  virtual void uploadBitmap(TextureId, uint32_t jsBitmapId) = 0;   // GL: texImage2D(ImageBitmap) via JS lib
  virtual void beginPass(const PassDesc&) = 0;
  virtual void draw(const DrawCall&) = 0;
  virtual void endPass() = 0;
  virtual void resolve(TargetId msaa, TargetId dst, IRect) = 0;          // MSAA resolve (blitFramebuffer)
  virtual void copyToTexture(TargetId src, IRect, TextureId dst, IPoint) = 0;  // backdrop reads
  virtual void readPixels(TargetId, IRect, std::span<uint8_t> rgba8) = 0;
  virtual void submit() = 0;
  virtual void destroy(ResourceId) = 0;
};
}
```

- **Uniforms**: one std140 UBO ring per frame (`bindBufferRange`, aligned to `UNIFORM_BUFFER_OFFSET_ALIGNMENT`).
- **Per-primitive data**: instanced vertex attributes.
- **Shaders** are GLSL written in a restricted common subset with macros (`UBO(name, binding)`, `TEX(name, binding)`). `tools/shadergen` expands them to:
  - `#version 300 es` (WebGL2, now);
  - later `#version 450` → naga → WGSL (WebGPU, E9).
  - Output: `${build}/generated/Shaders.generated.cpp`.
- **Program compile** uses `KHR_parallel_shader_compile`: all programs are compiled at `engine_create`, and a pipeline isn't used before its `COMPLETION_STATUS`, so the first frame doesn't jank.
- **Context**: `emscripten_webgl_create_context("#engine-canvas")` with:
  - `majorVersion=2`, `alpha=false` (the engine paints the page background)
  - `depth=false`, `stencil=false`, `antialias=false`: all real drawing goes to our own MSAA targets, and the default framebuffer only receives the composite
  - `premultipliedAlpha=true`, `preserveDrawingBuffer=false`, `powerPreference="high-performance"`
  - extensions enabled explicitly: `EXT_color_buffer_float`, `OES_texture_float_linear`, `EXT_texture_filter_anisotropic`, `KHR_parallel_shader_compile`
- **Startup readback test**: draw a known pattern to a texture and read it back, the same practice as Figma (R1 §b). On a mismatch, emit `NOTIFY{GPU_UNRELIABLE}` and continue.
- **Context loss**: TS forwards `webglcontextlost`/`webglcontextrestored` to `engine_gl_context_lost/restored`. Every GPU resource is a cache that can be rebuilt from the scene.

### 6.2 Render tree (`render/RenderTree`)
The render tree is separate from the scene graph (Figma's `render-tree/`). It is a flat array of `RenderNode`s in paint order with subtree ranges. Each holds:
- world transform (camera-relative at draw time)
- clip (rect, rrect or path id)
- paint list (fills, then strokes)
- geometry handle (primitive kind + params, or `PathId`)
- effects
- opacity, blend mode
- flags: `needsLayer`, `isMask`, `maskType`

It is synced from `RENDER`-dirty nodes. Hidden nodes, the internal canvas and other pages have no render nodes. `stackReverseZIndex` reverses the children range.

### 6.3 Primitives and paths

**Primitives** (the bulk of design content) draw as one instanced, batched **analytic-SDF** quad pipeline (`shape.vert/frag`). One instance carries:
- the 2×3 transform and size;
- four corner radii;
- stroke weight(s) and align;
- `kind` (RECT, RRECT, ELLIPSE, LINE);
- paint index;
- clip-mask flag.

The SDFs are the per-corner rounded-box distance and the gradient-normalised ellipse distance `f/|∇f|`. AA = coverage from distance over `fwidth`, which stays correct under rotation and scale. Strokes are SDF bands: INSIDE `[-w,0]`, CENTER `[-w/2,w/2]`, OUTSIDE `[0,w]`. Lines and strokes thinner than 1 device px draw 1 px wide with alpha × width (hairline rule), so nothing drops out when zoomed out.

The fast path is not used when any of these is present: `cornerSmoothing > 0`, `arcData`, dashes, non-uniform per-side strokes on a non-rect, or caps/arrows. Those go through paths.

**General paths** (vectors, booleans, stars, polygons, smoothed corners, arcs, stroke outlines, glyphs). **Decision: stencil-then-cover with Loop-Blinn quadratic curve triangles, anti-aliased by MSAA.** This follows Figma: the binary has `LoopBlinnInstanced` and `LoopBlinnGlyphsUShort`, and Figma's WebGPU post lists MSAA.
- **Stencil pass**: a triangle fan from the first point of each contour over its on-curve points, plus one curve triangle per quadratic. The curve fragment discards where `u²−v > 0`.
- Stencil op: INCR_WRAP / DECR_WRAP by facing (NONZERO), or INVERT (ODD).
- **Cover pass**: a bounding quad tested against `stencil ≠ 0`, with the paint shader, clearing the stencil as it goes.
- Geometry is built once per path **in local space** (`LoopBlinn.cpp` + `CubicToQuad` at precision level ℓ), so pan and zoom never re-tessellate. It lives in `PathCache` (a VBO arena, LRU).

Why this technique:
- It needs **no triangulation**: winding is counted in the stencil, so self-intersecting vector networks and both fill rules are exact.
- It is resolution-independent and simple (about 600 lines).
- It ports directly to WebGPU (stencil + MSAA).
- GPU tessellation is not available: WebGL2 has no tessellation or compute shaders. CPU triangulation (earcut/libtess) of self-intersecting networks plus separate edge AA is more code and more fragile.

**AA quality.** MSAA samples = `min(4, MAX_SAMPLES)`; the preference "Higher quality" uses 8 where the GPU supports it. Small paths need more than 4 samples to look like Figma, so there is a **`MaskAtlas`**:
- Paths whose device bounds are ≤ 128×128 px (icons) and glyphs with em ≤ 64 device px are rasterized into an R8 coverage atlas (2048² layers, up to 4 layers) with the same stencil-then-cover algorithm at **4×4 supersampling plus MSAA 4×** (64 samples), then box-downsampled.
- Atlas key: geometry id + the 2×2 linear part quantized to 1/64 + subpixel x/y offset quantized to 1/4 px.
- These items then draw as batched, textured quads with the paint applied in the shader.
- If the golden thresholds still fail, the fallback is §14 Q3.

### 6.4 Strokes
- **SDF fast path**: rect, rrect and ellipse with a solid, undashed stroke (including per-side weights on rects).
- **Otherwise**: the outline from `Stroker` is drawn as a path. INSIDE/OUTSIDE use the stencil: draw the fill into stencil bit 7, then cover the 2×-weight stroke where bit 7 is set (INSIDE) or not set (OUTSIDE). Winding counts use bits 0–6. This is Figma's look: an inside stroke never goes past the shape.

### 6.5 Paints (`render/Paints`)
Paints are evaluated in the shape's local unit square through `Paint.transform` (Figma's gradient/image matrix).

- **Solid**: color × `Paint.opacity` × node opacity (when no layer is needed).
- **Gradients**: the `t` function per type:
  - LINEAR: x in gradient space
  - RADIAL: `2·|p − (0.5,0.5)|`
  - ANGULAR: `atan2` normalised to [0,1)
  - DIAMOND: `2·(|x−0.5|+|y−0.5|)`
- Stops are baked into a 256-texel RGBA8 row of a ramp atlas (256×512). Interpolation happens in premultiplied sRGB (CSS behaviour; calibrated in §14 Q2), with ±0.5/255 ordered dither in the shader against banding.
- **Images**: `imageScaleMode` FILL (cover), FIT (contain), STRETCH (crop, through `Paint.transform`) and TILE (`scale`, repeat). Also `rotation`, and `filterColorAdjust` (exposure, contrast, saturation, temperature, tint, highlights, shadows) as shader math.
- Per-paint `blendMode` uses the layer rules (§6.7) when it isn't NORMAL.
- Paints stack in order: fills first, then strokes. A node with several paints draws several instances in the same batch.

### 6.6 Images (`render/ImageCache`)
- **Key**: `Paint.image.hash` (20-byte SHA-1, R2 §5).
- **Unknown hash**: emit `REQUEST_IMAGE {hash, maxDevicePx}`. While it loads, draw a 32×32 texture decoded from `Paint.thumbHash` (decoder in `render/ThumbHash.cpp`, ~120 lines) when present, otherwise a flat `#e6e6e6`.
- **Upload path**: TS fetches the bytes, decodes them with `createImageBitmap` (premultiply, colour space "srgb"), stores the bitmap in `Module.engineBitmaps` and calls `engine_image_add_bitmap(hash, bitmapId, w, h)`. The engine creates a texture and its JS library does `texImage2D(ImageBitmap)` directly. No pixels are copied through Wasm memory.
- The headless/Node path is `engine_image_add_rgba_take`.
- **Mipmaps** (`generateMipmap`) and trilinear plus anisotropic filtering.
- **GPU budget**: 512 MB, LRU. An evicted image whose node becomes visible again emits `REQUEST_IMAGE` again.
- Images larger than 4096 px are downscaled by TS at import (Figma's cap).

### 6.7 Effects, layers, blend modes, masks, clipping
**Layers.** A render node with `needsLayer` draws its subtree into an offscreen RGBA8 target (pooled, device-px, clipped to the visible region plus the effect outset), then composites it with `composite.frag`. `needsLayer` is set by:
- opacity < 1 on a node with more than one paint or with children;
- `blendMode` other than PASS_THROUGH/NORMAL on a container;
- a mask group;
- layer blur;
- non-rect shadows.

A leaf with opacity just multiplies alpha, with no layer.

**Blend modes.**
- Fixed-function: NORMAL, MULTIPLY (`DST_COLOR, ONE_MINUS_SRC_ALPHA`), SCREEN (`ONE, ONE_MINUS_SRC_COLOR`), LINEAR_DODGE (`ONE, ONE`).
- Every other mode in Figma's `BlendMode` uses `copyToTexture` of the backdrop region, then `composite.frag` with the W3C compositing formulas: separable and non-separable HUE/SATURATION/COLOR/LUMINOSITY, plus LINEAR_BURN.
- All blending is in non-linear sRGB with premultiplied alpha, matching Figma and CSS.

**Drop and inner shadows.**
- Shape is rect/rrect (no smoothing) and the node has an opaque fill: **Evan Wallace's analytic blurred rounded-rectangle shadow** (closed-form erf along one axis, 4-sample integration along the other) in one instanced pass, with no offscreen. Spread grows or shrinks the rect. The inner shadow is the inverted form, clipped to the shape.
- Any other shape (vectors, text, frames without fill, where the alpha of the contents matters):
  1. render the alpha into a layer;
  2. dilate or erode for `spread` (a morphology pass at radius `spread`, or an offset path for vectors);
  3. blur;
  4. tint with `color`;
  5. composite under (drop) or over and clipped to (inner) the node.
- `showShadowBehindNode=false` knocks the shape out of the drop shadow.

**Blur.** Separable Gaussian with the linear-sampling trick. **σ = radius / 2** (CSS mapping, calibrated in §14 Q2). The kernel half-width is 3σ. For σ > 4 device px, first downsample by 2^k until σ' ≤ 4 (k ≤ 5), blur, then upsample bilinearly.
- **Layer blur** (`FOREGROUND_BLUR`): blur the node's layer.
- **Background blur** (`BACKGROUND_BLUR`): copy the backdrop under the node's bounds plus 3σ, blur it, draw it clipped to the node's shape, then draw the node.
- Progressive blur (`blurOpType`, `startOffset/endOffset`, `startRadius`), NOISE, GRAIN, GLASS and REPEAT are after E7.

**Masks.** A child with `mask=true` masks its following siblings up to the end of the parent (R7 P0).
- `maskType VECTOR` / `maskIsOutline`: the mask's geometry becomes a clip (below). No layer.
- `ALPHA` / `LUMINANCE`: render the mask into an R8 target (its alpha or luminance) and the masked siblings into a layer, then `composite.frag` multiplies.

**Clipping frames** (`frameMaskDisabled=false`):
- An axis-aligned rect clip in device space becomes the **scissor**.
- Anything else (rounded, rotated, nested) renders the clip stack's coverage into an R8 **clip-mask** target with the SDF/path pipelines (AA edges). Shaders multiply by `uClipMask` when the instance's clip flag is set.
- Nested clips intersect while the mask is built.

### 6.8 Rendering modes and LOD
- **Direct mode (E0–E4)**: each frame, cull with the spatial index against the viewport, then draw the visible render nodes into an MSAA target the size of the viewport, resolve, and present.
- **Tile mode (E5 onward, the default)**: §6.9. Both modes share `Renderer::drawRegion(Encoder&, deviceRect)`.
- **LOD**:
  - Skip nodes whose device bounds are < 0.5 px.
  - Containers smaller than 2 px draw as one rect in the average of their fills (only in tiles at zoom < 0.25).
  - Text whose em is < 3 device px draws as greeked bars: line boxes at 35% of the text colour. It draws glyphs from 3 px up.

### 6.9 Tiles (`render/Tiles`)
Tiles exist for large documents at low zoom, as Figma's `RTTileRasterizer`/`RTCompositeTileCache` do.

**Grid.**
- Tiles are 256×256 device px, anchored at the world origin for a given zoom.
- Key: `(pageId, zoomBits, tx, ty)`, where `zoomBits` is the exact float bits of the zoom at rest.
- **Storage**: an RGBA8 `TEXTURE_2D_ARRAY` (256×256×L). The budget is 256 MB (1,024 tiles), LRU.

**Rasterizing a tile.**
1. Render into an MSAA target of size `(256 + 2·apron)²`. The apron is the largest effect sampling radius among the tile's nodes (background blur needs its neighbours' pixels).
2. Resolve.
3. Copy the centre into the tile layer.

**Each frame.**
1. Compute the visible tiles at the current zoom.
2. Missing or dirty tiles go into a priority queue, from the viewport centre outward.
3. Rasterize within the **time budget**: 6 ms per frame during interaction, 12 ms when idle (measured with `emscripten_get_now`).
4. Anything not ready yet shows the best cached tiles from another zoom, scaled with bilinear filtering (blurry while zooming, crisp on settle).

Continuous zoom (pinch/wheel) never rasterizes at intermediate zooms: re-raster starts 120 ms after the last zoom change. Discrete zoom steps (⌘+/−, Shift+1) raster at once.

**Invalidation.** A changed render node invalidates the tiles under its old and new `renderBounds` at every cached zoom. Dirty tiles that are off-screen are evicted. A move gesture just invalidates the old and new bounds each frame (a few tiles per frame). There is no special "live layer"; add one only if a benchmark needs it.

### 6.10 Shaders (initial set)
| file | purpose |
|---|---|
| `shape.vert/frag` | SDF rect/rrect/ellipse/line, fill and stroke, every paint kind (uber-shader branching on the instance's paint kind) |
| `path_stencil.vert/frag` | fan plus Loop-Blinn curve triangles, stencil only |
| `path_cover.vert/frag` | cover quad, paint, stencil test |
| `mask.vert/frag` | MaskAtlas quads (glyphs, small paths), with paint |
| `shadow_rrect.vert/frag` | analytic rounded-rect drop and inner shadow |
| `blur.frag`, `down.frag`, `up.frag` | separable Gaussian, pyramid |
| `morph.frag` | dilate/erode for spread |
| `composite.vert/frag` | layer composite: opacity, all blend modes, alpha/luminance mask, backdrop |
| `clipmask.frag` | clip coverage into R8 |
| `tile.vert/frag` | draw cached tiles (scaled) |
| `overlay.*` | reuses `shape` and `mask` |

### 6.11 Canvas overlays (`render/Overlay`, `OverlayStyle.h`)
Overlays are drawn by the engine after the scene, straight into the default framebuffer at device resolution and never tiled. 1-px lines are snapped to pixel centres.

| Overlay | Look (CSS px; colours light/dark) |
|---|---|
| Selection outline | 1 px `#0d99ff` / `#0c8ce9`, along the node's rotated box (not the AABB). Components and instances use `#9747ff` / `#8a38f5`; slots `#ff24bd` |
| Multi-selection bounds | 1 px in the selection colour, around the combined rotated box when all rotations match, otherwise the AABB |
| Resize handles | 8×8 white squares with a 1 px selection-colour border at corners (edges are invisible hit zones); hidden when the box is < 24 px |
| Rotation zones | invisible 16 px zones outside the corners (cursor only) |
| Size badge | pill: height 16, radius 2, 6 px below the box, background in the selection colour, white 11 px Inter weight 500, `W × H` (rounded to 2 decimals, trailing zeros trimmed) |
| Hover outline | 2 px in the selection colour (§14 Q2) |
| Frame and section titles | top-level frames: 11 px Inter, `#898989` dark / `rgba(0,0,0,0.5)` light, baseline 10 px above the frame; selection colour when selected; clickable and draggable |
| Marquee | fill = selection colour at 10%, 1 px border |
| Smart guides and measurement | `#f24822`, 1 px; distance labels are red pills with 11 px white text |
| Auto layout | padding and gap bands on hover (pink `#ff24bd` at 15%), insertion indicator 2 px in the selection colour, on-canvas padding/gap handles |
| Pixel grid | zoom ≥ 8 (800%): 1 px lines at 10% (§14 Q2) |
| Layout grids | the document's `layoutGrids` (they are content, so tiled) |
| Text | caret 1 px (2 px at ≥ 200% zoom) in the selection colour, blinks at 530 ms; selection highlight at 30% |
| Vector edit / pen | vertices: 6 px circles; tangents: 1 px lines with 4 px dots |
| Gradient handles | E5 |

**Stays in React**: the rulers (a canvas-2D strip outside the engine canvas, fed by `CAMERA_CHANGED`; the existing `Rulers.tsx` is the base), context menus, tooltips, the inline number inputs for padding/gap (opened by `REQUEST_INLINE_EDIT`), comment pins, and the hidden IME `<textarea>` (§7.6).

### 6.12 DPR, coordinates, frame pacing, colour
- **Coordinates**:
  - world units = Figma px, y down;
  - camera `{x, y, zoom}` in `double`, `screenCss = world·zoom + (x, y)`;
  - zoom range 0.02–256.
- **Camera-relative rendering**: the device matrix is composed in `double` relative to the viewport centre before the final `float` cast, so far-from-origin content doesn't jitter at high zoom.
- **DPR**: TS observes the canvas with `ResizeObserver` (`devicePixelContentBoxSize` for exact backing pixels) and calls `engine_set_viewport(cssW, cssH, dpr, pxW, pxH)`. The engine sets the canvas backing size (`emscripten_set_canvas_element_size`).
- **Frame pacing** (render on demand; JS owns `requestAnimationFrame`):

  ```ts
  function frame(t: number) {
    scheduled = false;
    const f = api.tick(h, t);                    // pipeline, animations; returns flags
    if (f & TICK_NEEDS_RENDER) api.render(h);   // tiles within budget + composite + overlays
    const delay = api.nextFrameDelay(h);         // -1 idle, 0 next rAF, >0 ms (caret blink)
    if (delay === 0) schedule(); else if (delay > 0) setTimeout(schedule, delay);
  }
  ```

  Any input or engine call that changes something sets the engine's `needsFrame`. The facade calls `schedule()` after every call when `engine_needs_frame(h)` returns true.
- **Colour**: the canvas is `drawingBufferColorSpace = "srgb"`, or `"display-p3"` when the document's `documentColorProfile` is DISPLAY_P3. Colours are stored as float RGBA in the document's space. No linear-light blending.

---

## 7. Text (`text/`)

### 7.1 Fonts
- **Bytes come from TS** (fonts are I/O):
  1. The engine emits `REQUEST_FONT {family, style}` the first time a `FontName` is needed.
  2. TS asks main over IPC (system fonts enumerated and read in main; Inter from `public/fonts/`; later Google Fonts) and calls `engine_font_add_take(ptr, len, faceIndex)`. The engine **takes ownership** of the `engine_alloc`'d buffer and frees it when the face is destroyed. It returns a `faceId`.
  3. If no font is found, TS calls `engine_font_missing(family, style)`.
- **Parsing**: HarfBuzz `hb_blob` over the buffer (`HB_MEMORY_MODE_READONLY` + destroy callback) → `hb_face_create(blob, index)` → `hb_font`. Metrics come from OS/2 and hhea; `fontLineHeight` = ascender − descender + lineGap. Named instances come from `fvar`, and `fontVariations` set the axes with `hb_font_set_variations`.
- **TTC/OTC** are supported through `faceIndex`. WOFF/WOFF2 are not supported: system fonts and Google's API both give TTF/OTF.
- **Missing fonts** follow Figma's behaviour:
  - the node renders with Inter at its stored size;
  - auto-resize writes are suppressed;
  - its `DerivedInfo.missingFont` is set (the panel shows "Missing fonts");
  - text editing on it is refused with `NOTIFY{MISSING_FONT}`.
- **Fallback**: TS calls `engine_set_fallback_fonts([...])` once at startup, with an ordered list of families (Apple Color Emoji, PingFang SC, Hiragino Sans, Apple SD Gothic Neo, Noto Sans …). The engine requests each the first time a codepoint isn't covered by the primary face.

### 7.2 Shaping: **vendor HarfBuzz**
Figma ships HarfBuzz in its Wasm (R1 §d), and a correct OpenType shaper (GSUB/GPOS, complex scripts, variable fonts, features) is years of work. We do not write our own.

- **Itemization** (`Itemizer.cpp`) splits the text into runs by:
  1. style run: `textData.characterStyleIDs` + `styleOverrideTable` (each a sparse NodeChange);
  2. script: HarfBuzz's built-in UCD `hb_unicode_script`;
  3. bidi level: SheenBidi, UAX #9;
  4. font coverage, with fallback.
- **Pre-shape case mapping**: `textCase` UPPER/LOWER/TITLE via utf8proc (Unicode default and special casing, not locale-sensitive). SMALL_CAPS uses the `smcp`/`c2sc` features.
- **`hb_shape`** gets features from `fontVariant*` (`liga`, `clig`, `dlig`, `hlig`, `ordn`, `zero`, `lnum`/`onum`, `pnum`/`tnum`, `frac`, `sups`/`subs`, `smcp`), plus `kern`.
- **`letterSpacing`** (PIXELS, or PERCENT of the font size) is added to each cluster's advance after shaping, except after the last cluster of a line (Figma behaviour).

### 7.3 Outlines: **HarfBuzz draw API, no FreeType**
- `hb_font_draw_glyph` with our `hb_draw_funcs` (move/line/quadratic/cubic/close) gives a `Path`, for glyf, CFF and CFF2, variations included. FreeType adds nothing we need, because we don't hint.
- `GlyphCache` key: `(faceId, glyphId, variationHash)` → `PathId`, resolution-independent, LRU.
- **Emoji (E3.2)**:
  - Apple Color Emoji is sbix: `hb_ot_color_glyph_reference_png` returns PNG bytes, which TS decodes like an image (`REQUEST_DECODE` path), into a colour-glyph atlas.
  - COLRv0/v1 via `hb_font_paint_glyph`: after E7.

### 7.4 Line breaking and layout (`LineBreaker.cpp`, `TextLayout.cpp`)
- **Break opportunities**: UAX #14 via libunibreak. Greedy fill, as Figma and browsers do. A word that doesn't fit is broken at grapheme boundaries (libunibreak grapheme breaks). No hyphenation. `textWrapStyle` balance/pretty is after E7.
- **Line height**: `lineHeight` `Number{value, units}`: RAW 100% means "Auto" = the font's `fontLineHeight` at the size; PIXELS; PERCENT of the font size.
- **Baseline placement** uses CSS half-leading: `baseline = lineTop + (lineHeight − (ascent + descent))/2 + ascent`. The line's ascent/descent is the max over its runs.
- `leadingTrim CAP_HEIGHT` trims the first and last lines to cap height and baseline.
- `paragraphSpacing`, `paragraphIndent`; lists (`textListData`) in E3.2.
- **Alignment**: `textAlignHorizontal` LEFT/CENTER/RIGHT/JUSTIFIED. Justified stretches inter-word space on every line except the last line of a paragraph.
- `textAlignVertical` applies only to fixed boxes.
- **Truncation**: `textTruncation=ENDING` with `maxLines`, or the box height for fixed boxes. The last visible line is cut so "…" (U+2026, shaped in the last run's font) fits.
- **Output** `TextLayout`:
  - `lines[] {y, baseline, ascent, descent, width, x, glyphRange, charRange}`
  - `glyphs[] {faceId, glyphId, x, y, advance, cluster (UTF-8 offset), styleId}`
  - decorations: underline/strikethrough rects from `post`/OS/2 metrics, with `textDecorationStyle` solid/dotted/wavy
  - `size`, `firstBaseline`
- Cached per node and rebuilt on `TEXT` dirtiness.

### 7.5 Glyph drawing
> **Decided while implementing E3 (2026-10-07)**: glyphs are drawn by a fragment shader that computes coverage from the glyph's quadratic curves directly (a +x and a +y ray per pixel, Lengyel's root classification; curves in one RGBA32F texture), not by stencil-then-cover + MaskAtlas: the canvas has no MSAA, and this is crisp at every zoom with no atlas. Case mapping uses a generated table (no utf8proc). Details in `docs/engine-build.md` "Status: E3 text".

- **em ≤ 64 device px**: `MaskAtlas` (§6.3), keyed by `(faceId, glyphId, varHash, emSizeQ = ⌈em·4⌉/4, subpixelX/4)`. One instanced draw per paint per text node. Fills apply in node space, so gradient and image text work.
- **Larger**: direct path rendering from `GlyphCache` (Loop-Blinn), a glyph instanced by transform.
- **Text strokes**: stroke outlines of the glyph paths, via the path renderer.
- **Effects** on text: §6.7, shape = the glyph alpha.
- Grayscale AA only; no LCD subpixel AA (Figma does the same). A contrast/gamma tweak for small text is a calibration item (§14 Q2).

### 7.6 Text editing (`TextEditor.cpp`), in the engine
- **Entering**: double-click on text, Enter on a selected text node, or the Text tool click/drag (click = auto width, drag = fixed width / auto height). Esc leaves; leaving an empty text node deletes it (Figma).
- **Model**: caret and anchor as UTF-8 offsets, snapped to grapheme boundaries. The API exposes **UTF-16 offsets** for JS/IME interop.
- **Motion**:
  - ←/→ by grapheme; ⌥ by word (libunibreak word breaks); ⌘ to line start/end;
  - ↑/↓ by line, keeping the x affinity;
  - ⇧ extends the selection;
  - double-click selects a word, triple-click a paragraph, drag selects; ⌘A selects all the text.
- **Edits**: insert, delete back/forward (⌥ word, ⌘ line), new line, and style ops on ranges (⌘B bold, ⌘I italic, ⌘U underline, ⇧⌘X strikethrough, size/weight/line-height nudges) through `characterStyleIDs` and `styleOverrideTable`. Typing goes through `engine_text_input`. Each text edit writes `textData` (one property) inside a transaction (§9.4 covers coalescing).
- **IME**: the engine emits `TEXT_EDIT {active, ref, caretRectCss, selection}`. TS keeps a hidden `<textarea>` positioned at the caret and forwards the composition:
  - `compositionupdate` → `engine_text_composition(text, selStartU16, selEndU16)` (drawn underlined, not committed)
  - `compositionend` → `engine_text_composition_end(text)`
  - plain `beforeinput` insertText → `engine_text_input`

  The textarea also gives the Electron context menu (spelling off) and the copy/paste events.

---

## 8. Hit-testing, selection, tools, snapping

### 8.1 Spatial index (`hit/SpatialIndex`)
- One **dynamic AABB tree** per loaded page (Box2D-style: fat AABBs with 2 px margin, incremental insert, remove and move).
- It holds every rendered node, derived instance sublayers included, keyed by `worldBounds` (`renderBounds` for culling).
- Used by culling, hit-tests, marquee and snapping candidates.

### 8.2 Hit-test (`hit/HitTest`, `hit/Picking`)
`hitTest(worldPt, slopCss=4)`:
1. Query the tree.
2. Test candidates **in reverse paint order** (topmost first) in local space:
   - rect/rrect/ellipse analytically;
   - paths by winding number;
   - strokes and lines by distance ≤ max(half width, slop);
   - text by its line boxes (not glyph ink);
   - frames by their box only when they have a visible fill or stroke, or are top-level;
   - groups never by themselves, only through children.
3. Hidden nodes and **locked nodes and their descendants are skipped** (they stay selectable from the Layers panel).
4. Clipped content outside a clipping frame doesn't hit.

**Picking rules** (port of `figma/picking.ts:54-68`, the spec):
- With no modifier, the pick is the deepest hit whose parent is **open** (selected, or an ancestor of the selection). Otherwise it is the top-level frame's direct child, and otherwise the top-level node.
- **⌘ (deep select)**: the deepest hit, instance sublayers included.
- **Groups**: a hit inside a group selects the outermost unopened group.
- **Instances**: the first click selects the instance; double-click or ⌘ goes into derived sublayers.
- **Top-level frames**:
  - press-drag on the frame's own empty area starts a marquee;
  - a click without a drag selects the frame;
  - the frame title selects and drags it.
- **Double-click**: text → edit; container → select its child under the point; vector → vector edit mode (E4).
- Enter selects **all** children (Figma; today's code selects the last child only), ⇧Enter selects the parent, Tab/⇧Tab the next/previous sibling.
- Esc: cancel the gesture, else the parent, else deselect.

### 8.3 Selection model (`editor/Selection`)
- Selection is per page, an ordered set of `NodeRef`s, kept as `NodeId`s internally. It survives re-materialization by path.
- Every undo batch stores the selection before and after.
- `SELECTION_CHANGED` is emitted after each tick in which it changed.

### 8.4 Tools and gestures, in C++ (Figma's interactions are in C++, R1 §a)
- `ToolController` routes pointer events to the active `Tool`. A `Gesture` (move, resize, rotate, marquee, draw, pan, zoom, text select, pen, gradient-handle drag) owns a `TxnKind::Gesture` transaction from its 3 px drag threshold to pointer-up.
- **Esc or window blur cancels the gesture**: `txn.rollback()`, restoring the exact start state. This fixes today's "commit on blur" bug.
- **Tools** (`Tool` enum): `MOVE, SCALE, HAND, FRAME, SECTION, SLICE, RECTANGLE, LINE, ARROW, ELLIPSE, POLYGON, STAR, IMAGE, PEN, PENCIL, TEXT, COMMENT`.
  - TS sets the tool (`engine_set_tool`) from the toolbar and from the tool shortcuts.
  - After a draw, the tool returns to MOVE (Figma), and `TOOL_CHANGED` is emitted.
- **Gesture rules** (Figma):
  - **Move**: ⇧ locks the axis; ⌥ duplicates (the copy is created at the threshold, inside the same transaction); dropping on a frame reparents (single and multi-selection).
  - **Auto layout move**: dropping into an auto-layout frame shows the insertion indicator and reorders.
  - **Resize**: 8 handles plus edge zones; ⇧ keeps the ratio (`proportionsConstrained` always keeps it); ⌥ resizes from the centre; resizing past zero flips (writes a negative scale into `transform`); multi-selection scales the members' boxes.
  - **Rotate**: ⇧ snaps to 15°; rotation is about the selection centre.
  - **Draw**: ⇧ square/circle (45° for lines); ⌥ from the centre; a click without a drag makes 100×100, or a 100 px line.
  - **Space** held = hand; middle button = hand; H = hand tool; Z = zoom tool.
  - **Wheel**:
    - pinch (`ctrlKey` from a trackpad) zooms about the pointer by `exp(−dy·0.01)`;
    - ⌘/Ctrl + wheel zooms;
    - otherwise the wheel pans (⇧ = horizontal).
- **Keys the engine handles itself** (`engine_key` returns `HANDLED`):
  - arrows (nudge 1, ⇧ 10, from preferences; in auto layout, ← → / ↑ ↓ reorder);
  - Esc, Enter, ⇧Enter, Tab, ⇧Tab;
  - Space and the modifier states;
  - every key while editing text.
  - **Everything else is unhandled** and goes to TS's command registry (§10.6).

### 8.5 Snapping, smart guides, measurement (`editor/Snapping`, `Measure`)
- **Candidates**: siblings, the parent and other nodes visible in the viewport (a spatial query), plus page guides and layout-grid lines.
- **Targets**: edges and centres; equal-spacing distribution (shown with spacing pills); pixel grid.
- **Threshold**: 6 CSS px. Holding Ctrl temporarily disables snapping (Figma).
- **Pixel-grid snapping** (preference on by default) rounds the final position and size to whole px. Applies to move, resize, draw and pen.
- Guides draw only for snapped axes, spanning the snapped objects, not the whole viewport.
- **⌥ measurement**: distances from the selection to the hovered node, or to the parent's edges. ⌥⌘ also measures to locked/nested nodes.

### 8.6 Decisions recorded while implementing E2 (2026-10-06)
Behaviour the contract left open, as built (`editor/Commands.cpp`, `tools/Gestures.cpp`); change here first if Figma turns out to differ.
- **Moving into and out of frames** is live: the layers' parent follows the topmost frame under the pointer (not instances, locked or hidden frames; a clipping ancestor must contain the pointer too). A layer inside a group stays in the group while the pointer is over the group's own frame or page. ⌘ keeps the parents and turns snapping off; so does ⌃.
- **Dragging inside auto layout** keeps the frame's shape: the dragged layer keeps its slot (layout doesn't move it), the siblings stay, and a 2 px insertion line shows where it lands; it is placed on drop. A layer dragged in from elsewhere, or an ⌥-copy, takes no space until it is dropped. Leaving the frame lets the frame reflow at once.
- **Snapping candidates** are the drop parent's other children in and around the view plus the parent frame's box; boxes turned against the page don't snap their resize edges. Snapped axes keep the snapped value; the others round to whole px (the moving box's top-left, not each layer's).
- **⌘D** duplicates in place, just above the original; top-level frames instead go to the right of the selection, `width + 100` px further, skipping right while that spot is taken. The copy keeps the name. **Duplicate page** names the copy "‹name› copy".
- **Add auto layout (⇧A)**: a lone plain frame converts in place (direction from the spread of its children's centres, gap = the mean gap rounded, padding from where the content sits, counter alignment when all children share it, Hug both ways, children re-keyed in flow order). Anything else (several layers, a shape, an auto-layout frame) is wrapped in a new fill-less, non-clipping auto-layout frame with padding 0.
- **Paste**: into the one selected frame (where the content sat in its own parent if that fits, else centred); beside the selected layer (same page position); else on the page where it was, or centred in the view when that is out of view. `inPlace` keeps the page position. Fresh ids from the session.
- **Arrow keys** on auto-layout children move them one place along the flow; across the flow they do nothing.
- **Right-click** (or ⌃-click on a Mac, where ⌃ isn't the command key) selects what a left click would pick unless it is already selected (empty canvas keeps the selection), then emits `CONTEXT_MENU {targetKind, x, y, hits}`; `hits` is every layer under the point, topmost first, each as its path innermost first, for "Select layer ▸". ⌃ therefore disables snapping only once a drag has started.
- **Thumbnails** (until `engine_export`, §10.8): `engine_render_thumbnail(page, maxSize)` renders a page's content bounds, fitted in the content's aspect, without overlays, into an offscreen RGBA8 + stencil target (`gfx::Device::createTarget`/`readPixels`) and returns `width, height, RGBA8`; TS encodes the PNG (`Engine.renderThumbnail`). The canvas is never drawn to, so it works for hidden tabs too.

---

## 9. Transactions and undo/redo

### 9.1 Transactions (`scene/Txn`)
```cpp
Txn& t = doc.begin(TxnKind::User /*Gesture|Undo|Redo|System|Remote|Load*/, "Move");
t.set<F::transform>(id, m);     // generated typed setter per field
t.create(NodeType::ROUNDED_RECTANGLE, parentIndex, props);  // allocates GUID
t.remove(id);                   // removes subtree, children first
t.flush();                      // run pipeline stages 1–5 now (live gesture feedback)
t.commit();                     // stages 1–5, then emit + undo batch
t.rollback();                   // apply inverse, emit nothing
```

- **Writes**:
  - An equal value is a no-op.
  - The **first** write of a `(node, field)` records the old value as kiwi-encoded bytes in the transaction arena. Later writes only update `ChangeSet`, so a whole drag coalesces.
  - `create` records an inverse REMOVED. `remove` records an inverse CREATED with every field of every node in the subtree.
- **System writes** (`t.systemSet`, from layout, groups, binding resolution and auto-resize) are recorded in the same transaction with inverses.
- **On commit**:
  1. **Forward `Message`** (`type NODE_CHANGES`, `sessionID`, `nodeChanges`, `blobs`): one NodeChange per touched real node, carrying only its changed fields plus `clearedFields`. Creations come parents-first with every field; removals children-first, as `phase=REMOVED`. Derived nodes are never included. It is emitted as `DOCUMENT_CHANGED {bytes, kind, label}`.
  2. **Undo batch**: `{label, inverse NodeChanges, selectionBefore, selectionAfter, pageId}`, for kinds User and Gesture.
  3. Clear the dirty change set.
- **Nesting**: a `begin` inside an open transaction joins it. Panel scrubbing uses `engine_txn_begin/commit` around many `engine_set_props` calls, so it is one undo step and one message.

### 9.2 Kinds
| kind | undo batch | `DOCUMENT_CHANGED` | used by |
|---|---|---|---|
| User / Gesture | yes | yes | commands, panel writes, gestures, paste |
| Undo / Redo | moves the batch to the other stack | yes | ⌘Z / ⇧⌘Z |
| System | no | yes (`kind=SYSTEM`) | load-time normalisation (§3.4), late-arriving fonts |
| Remote | no | no | `engine_apply_changes(APPLY_REMOTE)` (future sync, external edits) |
| Load | no | no | `engine_load`, page loading |

### 9.3 Undo/redo (`editor/Undo`)
- **Undo**:
  1. Switch to the batch's page if it differs (emits `CURRENT_PAGE_CHANGED`).
  2. Apply the inverse NodeChanges in a `TxnKind::Undo` transaction. That records its own inverse, which becomes the redo batch.
  3. Run stages 1–5. They normally produce no further writes; if something drifted (fonts, for example), the writes join the same transaction.
  4. Restore `selectionBefore`.
- **Redo** is symmetric.
- **A new User transaction clears the redo stack.** Undo writes are ordinary document changes that leave for storage. This follows Figma's principle that undo modifies history ("undo a lot, copy, redo back → document unchanged", R1 Undo).
- **Budget**: 128 MB of inverse data or 1,000 batches; the oldest are dropped.
- **Undo is blocked** during a gesture, during IME composition, and in VIEWER mode.
- Since this is single-user, there is no redo-history rewriting for remote edits. Remote changes simply aren't undoable.

### 9.4 Coalescing rules (one undo step each)
- A gesture, from the pointer-down threshold to pointer-up.
- A panel scrub: `txn_begin` … `txn_commit`.
- Key-repeat nudges of the same selection with no other step between them.
- Typing in one text node, until the caret moves by navigation, the selection or style changes, or 1.5 s passes without typing.
- A command: one step, labelled with the command's Figma name ("Group selection", "Add auto layout"…).

---

## 10. Binding contract: C ABI plus a generated TS wrapper

### 10.1 Principles
- **No embind.** The ABI is a flat C ABI: `ENG_EXPORT` functions taking only `i32/u32/f64` and pointers. This matches Figma's generated flat `*TsApiGenerated` bindings over `wrapCppFunction` (R1 §c).
- **One definition file**, `engine/api/api.def.ts`, generates:
  - `${build}/generated/api/EngineApi.h`: the prototypes. A missing implementation is a link error.
  - `exports.txt`: `EXPORTED_FUNCTIONS`.
  - `src/renderer/src/engine/generated/EngineExports.generated.ts`: a typed wrapper class `EngineExports` with the marshalling.

  ```ts
  // engine/api/api.def.ts (excerpt)
  export default defineApi({
    engine_create:      { args: { canvas: "cstr?", opts: "bytes" }, ret: "handle" },
    engine_load:        { args: { h: "handle", doc: "bytes" }, ret: "status" },
    engine_read_nodes:  { args: { h: "handle", refs: "bytes", fields: "u16[]", flags: "u32" }, ret: "result:ReadNodesResult" },
  });
  // arg kinds: handle u32 i32 f64 bool bytes(ptr,len) str(ptr,len utf8) cstr?(nul-terminated or 0) u16[](ptr,count)
  // ret kinds: void u32 i32 f64 handle status(i32) result:<KiwiType> (status + result slot decoded by the wrapper)
  ```
- **Every structured payload is kiwi**:
  - documents and changes: `Message` from `schema/document.kiwi`;
  - everything API-only (options, refs, events, rows, derived info, command args): `engine/api/engine-api.kiwi`.
  - `schemagen` compiles the two schemas as one namespace. API-only types are prefixed `Api` to avoid collisions; `NodeRef`/`EngineEvent` keep short names.
  - JSON is never used.

### 10.2 Memory ownership
1. **JS → engine, borrowed (the default)**:
   - The wrapper copies the input into a **per-module scratch buffer** (an `engine_alloc`'d region, 64 KB initially, grown by doubling). Inputs bigger than 1 MB get a temporary `engine_alloc`/`engine_free` pair.
   - The engine **must not keep** the pointer after it returns.
2. **JS → engine, transferred** (functions ending `_take`: `engine_font_add_take`, `engine_image_add_rgba_take`):
   - JS allocates with `engine_alloc`, fills the buffer and passes it.
   - The engine owns it and frees it with `free()`. JS never touches it again.
3. **Engine → JS results**:
   - Functions with `result:` write into the module's **result slot** (one growing byte vector) and return a status.
   - The wrapper reads `engine_result_ptr()`/`engine_result_len()` and **copies** (`HEAPU8.slice`) before any other engine call. The slot is valid only until the next call that writes a result.
4. **Events**: `engine_take_events(h)` puts an `EngineEvents` message in the result slot (rule 3). Payload byte arrays (`DOCUMENT_CHANGED.bytes`, `EXPORT_DONE.bytes`) are decoded as copies.
5. **Engine → JS imports** (`library_engine.js`) are leaf utilities only and get views that are valid only during the call:
   - `ejs_log(level, ptr, len)`
   - `ejs_tex_image_bitmap(target, level, internalFormat, format, type, bitmapId)` (uses Emscripten's `GLctx`, then `bitmap.close()`)
   - `ejs_now()`

   They must never call engine exports.
6. **Strings** are UTF-8 (`str`) everywhere. Text-editing offsets crossing the ABI are UTF-16 code units.
7. **Pointers and u32s** returned to JS are `>>> 0`'d. Heap views are re-read after every call (growth).

### 10.3 Initial API (E0–E3)
Status codes (`i32`): `OK=0, E_HANDLE=-1, E_DECODE=-2, E_INVALID=-3, E_OOM=-4, E_NOT_FOUND=-5, E_READONLY=-6, E_BUSY=-7 (gesture or composition active), E_UNSUPPORTED=-8`. `engine_last_error()` puts the text in the result slot. Below, `refs` is a kiwi `NodeRefList { NodeRef[] refs }` and `NodeRef { GUID[] path }`.

**Module**
| function | notes |
|---|---|
| `u32 engine_abi_version()` | the wrapper refuses a mismatch with the generated constant |
| `u32 engine_alloc(u32 len)` / `void engine_free(u32 ptr)` | malloc/free |
| `u32 engine_result_ptr()` / `u32 engine_result_len()` | result slot |
| `u32 engine_events_flag_ptr()` | address of a u32 that is ≠ 0 while any queue has events (read once, then polled from HEAPU32 with no call) |
| `i32 engine_last_error()` | result: utf8 |
| `i32 engine_font_add_take(u32 ptr, u32 len, u32 faceIndex)` | returns `faceId` ≥ 0; owns the buffer |
| `void engine_font_missing(str family, str style)` | |
| `void engine_set_fallback_fonts(bytes ApiStringList)` | |
| `i32 engine_image_add_bitmap(bytes hash20, u32 bitmapId, u32 w, u32 hgt)` | GL upload via the JS lib |
| `i32 engine_image_add_rgba_take(bytes hash20, u32 ptr, u32 w, u32 hgt)` | headless/Node; premultiplied RGBA8 |
| `void engine_image_failed(bytes hash20)` | draws the broken-image placeholder |

**Lifecycle and document**
| function | notes |
|---|---|
| `handle engine_create(cstr? canvasSelector, bytes ApiEngineOptions)` | `ApiEngineOptions {sessionID, mode EDITOR\|VIEWER\|INSPECT\|HEADLESS, theme LIGHT\|DARK, devicePixelRatio, gpuBudgetMB=512, undoBudgetMB=128, preferences}`; selector 0 = headless (no GL) |
| `void engine_destroy(handle h)` | |
| `status engine_load(h, bytes Message)` | the full document; resets undo; trusts stored geometry (§3.4) |
| `result:Message engine_apply_changes(h, bytes Message, u32 flags)` | flags `APPLY_USER` (undoable + emitted) \| `APPLY_REMOTE` \| `APPLY_LOAD`, `RETURN_INVERSE`; the result is the inverse Message when asked for |
| `result:Message engine_encode_document(h, u32 flags)` | the full snapshot; `ENCODE_BAKE_TEXT` adds `derivedTextData` with glyph outline blobs (viewer bundles, §10.8); `ENCODE_PAGES(list)` later |
| `void engine_set_current_page(h, u32 sessionID, u32 localID)` | |
| `result:ApiPageList engine_pages(h)` | `{guid, name, isDivider, backgroundColor, childrenLoaded}`; the internal canvas is excluded |

**View, input, frames**
| function | notes |
|---|---|
| `void engine_set_viewport(h, f64 cssW, f64 cssH, f64 dpr, u32 pxW, u32 pxH)` | |
| `void engine_set_camera(h, f64 x, f64 y, f64 zoom)` | from Home thumbnails/links; zoom commands are commands |
| `void engine_set_theme(h, u32 theme)` / `void engine_set_preferences(h, bytes ApiPreferences)` | `{nudgeSmall=1, nudgeBig=10, snapPixelGrid=true, snapGeometry=true, snapObjects=true, highQualityAA=false, …}` |
| `u32 engine_pointer(h, u32 type, f64 x, f64 y, u32 button, u32 buttons, u32 mods, f64 pressure, u32 clickCount, u32 pointerType, f64 timeMs)` | type DOWN/MOVE/UP/CANCEL/ENTER/LEAVE; x,y = CSS px in the canvas; returns `HANDLED`\|`CAPTURE` (TS calls `setPointerCapture`) |
| `u32 engine_wheel(h, f64 x, f64 y, f64 dx, f64 dy, u32 deltaMode, u32 mods, u32 flags)` | flags `PINCH` (ctrlKey from a trackpad) |
| `u32 engine_key(h, u32 type, u32 keyCode, u32 codepoint, u32 mods, u32 repeat)` | `keyCode` = generated enum of `KeyboardEvent.code`; `codepoint` from a single-char `key`; returns `HANDLED` |
| `void engine_modifiers(h, u32 mods)` / `void engine_blur(h)` | blur cancels gestures |
| `void engine_text_input(h, str)` / `void engine_text_composition(h, str, u32 selStartU16, u32 selEndU16)` / `void engine_text_composition_end(h, str)` | §7.6 |
| `void engine_set_tool(h, u32 tool)` | |
| `void engine_set_hover(h, bytes refs)` | Layers row hover → canvas outline |
| `u32 engine_tick(h, f64 timeMs)` | `TICK_NEEDS_RENDER` |
| `void engine_render(h)` | |
| `i32 engine_next_frame_delay(h)` / `u32 engine_needs_frame(h)` | §6.12 |
| `void engine_gl_context_lost(h)` / `void engine_gl_context_restored(h)` | |

**Selection and reads (for panels)**
| function | notes |
|---|---|
| `result:ApiSelection engine_get_selection(h)` | `{pageId, refs}` |
| `status engine_set_selection(h, bytes refs)` | from Layers/Find |
| `result:Message engine_read_nodes(h, bytes refs, u16[] fields, u32 flags)` | **the generic property getter**: one NodeChange per ref holding only the requested fields (empty list = all typed fields); derived nodes are encoded with their effective values and `guidPath` set; flags `INCLUDE_CHILD_IDS` |
| `result:ApiDerivedInfoList engine_read_derived(h, bytes refs)` | per ref: `absoluteTransform`, `absoluteBoundingBox`, `absoluteRenderBounds`, `panelX/panelY` (the transform's translation relative to the nearest non-group ancestor, Figma's x/y), `panelRotation = atan2(−m10, m00)` in degrees (Figma's API definition), `panelW/H`, `overriddenFields u16[]`, `mainComponent NodeRef`, `isMainRemote`, `resolvedModes {setGUID→modeGUID}`, `boundFieldValues` (resolved), `missingFont`, `textStyleRanges`, `layoutContext` (parent stackMode, which sizing modes are legal) |
| `result:ApiLayerRows engine_layer_rows(h, u32 pageSess, u32 pageLocal, bytes ApiExpandedSet, u32 firstRow, u32 count)` | windowed rows: `{totalRows, rows[{ref, depth, type, name, visible, locked, hasChildren, expanded, selected, inSelectionPath, icon, isComponentish, isDerived}]}`, top layer first (Layers order) |
| `result:ApiHit engine_hit_test(h, f64 x, f64 y, u32 flags)` | refs under the point (top first) for the context menu's "Select layer" |
| `result:ApiFindResults engine_find(h, bytes ApiFindQuery)` | names and text, this page or all pages, type filters |
| `result:ApiNodeList engine_list_nodes(h, bytes ApiListQuery)` | e.g. local styles, variable collections, components (they are nodes on the internal canvas or on pages) |
| `result:ApiResolved engine_resolve_variable(h, bytes varRef, bytes consumerRef)` | value plus alias chain for the variable picker |

**Writes and commands**
| function | notes |
|---|---|
| `status engine_set_props(h, bytes refs, bytes NodeChange, u32 flags)` | **the generic setter**: the fields present (plus `clearedFields`) are written on each ref. On a derived ref, overridable fields become overrides on the owning instance; anything else → `E_INVALID`. Flags `NO_UNDO_MERGE` |
| `status engine_set_geometry(h, bytes refs, u32 prop, f64 value, u32 mode)` | prop X/Y/W/H/ROTATION/CORNER_RADIUS; mode ABSOLUTE\|DELTA; Figma panel semantics (rotation about the centre, aspect lock, constraints for W/H, fixed sizing set on resize in auto layout) |
| `u32 engine_txn_begin(h, str label)` / `status engine_txn_commit(h)` / `void engine_txn_cancel(h)` | panel scrubs and multi-call actions |
| `result:ApiCommandResult engine_command(h, u32 commandId, bytes args)` | §10.6; result: created/affected refs, notices |
| `u32 engine_command_state(h, u32 commandId)` | `ENABLED`\|`CHECKED`, for menus |
| `result:Message engine_copy(h, u32 flags)` | flags `CUT`. A `Message` with nodeChanges and blobs of the selection (plus the main components and styles the receiver needs); `pasteFileKey`, `pastePageId` |
| `status engine_paste(h, bytes Message, u32 mode, f64 x, f64 y)` | mode IN_PLACE\|AT_POINT\|OVER_SELECTION\|REPLACE; R4 §8 paste rules for components |
| `u32 engine_export(h, bytes refs, bytes ApiExportSettings)` | returns a jobId; the result comes as `EXPORT_DONE` (§10.8) |

**Events**
| function | notes |
|---|---|
| `u32 engine_has_events(h)` | |
| `result:EngineEvents engine_take_events(h)` | drains the queue |

**Diagnostics**: `result:ApiStats engine_stats(h)` (frame ms, raster ms, nodes, derived nodes, GPU bytes, heap bytes) and `void engine_set_debug(h, u32 flags)` (show tiles, dirty rects, wireframe, overdraw).

### 10.4 Events (engine → JS), delivered through a queue
The engine never calls JS back during its own work. It appends `EngineEvent`s to a per-handle queue and sets the events flag. **After every export call**, the generated wrapper checks `HEAPU32[eventsFlagPtr>>2]`. If it is set, the wrapper calls `engine_take_events`, decodes the events and dispatches them to subscribers synchronously, after the engine has returned. The TS-level "callbacks" (`onSelectionChanged`, `onDocumentChanged`, …) are these dispatches.

| `EventType` | payload | coalescing |
|---|---|---|
| `SELECTION_CHANGED` | `pageId, refs` | last per tick |
| `DOCUMENT_CHANGED` | `bytes (Message), kind USER\|UNDO\|REDO\|SYSTEM, label` | one per committed txn; TS forwards it to storage at once (invariant 4) |
| `NODES_CHANGED` | `refs[], fieldGroupMask[]` (groups: GEOMETRY, LAYOUT, PAINT, TEXT, NAME, VISIBILITY, COMPONENT, BINDINGS) | one per tick, merged; includes live gesture changes before commit, for panels |
| `STRUCTURE_CHANGED` | `pageId` | per tick (Layers tree shape) |
| `PAGES_CHANGED` / `CURRENT_PAGE_CHANGED` | `pageId` | |
| `CAMERA_CHANGED` | `x, y, zoom` | last per tick (rulers, zoom %) |
| `TOOL_CHANGED` | `tool` | |
| `CURSOR` | `CursorKind` (DEFAULT, HAND, GRABBING, CROSSHAIR, PEN, PEN_ADD, PEN_REMOVE, PEN_CLOSE, IBEAM, RESIZE, ROTATE, MOVE_DUPLICATE, ZOOM_IN, ZOOM_OUT, EYEDROPPER, NOT_ALLOWED) + `angleDeg` | last per tick; TS maps it to CSS cursors (resize/rotate SVG cursors pre-rendered at 15° steps) |
| `HOVER_CHANGED` | `ref` | Layers row highlight |
| `UNDO_STATE` | `canUndo, canRedo, undoLabel, redoLabel` | |
| `REQUEST_FONT` | `family, style` | once per font |
| `REQUEST_IMAGE` | `hash, maxDevicePx` | once until answered or evicted |
| `REQUEST_PAGE` | `pageId` | dynamic page loading (later) |
| `TEXT_EDIT` | `active, ref, caretRectCss, selStartU16, selEndU16, styleAtCaret` | |
| `CONTEXT_MENU` | `targetKind (CANVAS\|SELECTION\|TEXT\|VECTOR), x, y` | TS draws the menu |
| `REQUEST_INLINE_EDIT` | `kind (PADDING_TOP…\|GAP…), rectCss, value` | TS shows an input, then commits through `set_props` |
| `NOTIFY` | `code (MISSING_FONT, GPU_UNRELIABLE, ORPHANS, CANNOT_EDIT_INSTANCE_CHILD …), args` | TS shows a Figma-worded toast |
| `EXPORT_DONE` | `jobId, format, width, height, bytes` | |
| `MEMORY_PRESSURE` | `heapBytes, level` | |

### 10.5 TS side (`src/renderer/src/engine/`)
| file | role |
|---|---|
| `wasm/engine.mjs`, `wasm/engine.wasm` | build output (gitignored) |
| `generated/*.generated.ts` | §1.6 |
| `loadEngine.ts` | `await createEngineModule({ locateFile })` once per tab process; checks `engine_abi_version` |
| `Engine.ts` | facade: `class Engine` with typed methods over `EngineExports`, kiwi encode/decode, the event pump, `on(type, cb)`, `schedule()` |
| `EngineStore.ts` | external store, topics: `selection`, `page`, `pages`, `tool`, `undo`, `textEdit`, `hover`, `structure:<pageId>`, `node:<refKey>` versions |
| `hooks.ts` | `useSelection()`, `useCurrentPage()`, `useTool()`, `useUndoState()`, `useNodeProps(refs, fields)`, `useDerived(refs)`, `useLayerRows(pageId, window)` |
| `EngineCanvas.tsx` | owns `<canvas id="engine-canvas">` and the hidden IME `<textarea>`; wires pointer/wheel/key/composition/resize/context-loss events; runs the rAF loop |
| `nodeRef.ts` | `refKey(ref)` ↔ `"12:34"` / `"I12:34;5:6"`, parse/format |

**React subscription** (`useSyncExternalStore`). Snapshots are immutable and versioned per topic; an event replaces only its topic's snapshot.

```ts
export function useSelection(): ApiSelection {
  return useSyncExternalStore(cb => store.subscribe("selection", cb), () => store.selection);
}
// Re-reads from the engine only when NODES_CHANGED touched one of `refs` in a group covering `fields`;
// getSnapshot returns the cached object while versions are unchanged (stable identity).
export function useNodeProps<F extends FieldName>(refs: readonly NodeRef[], fields: readonly F[]): NodeProps<F>[] {
  const key = useMemo(() => propsKey(refs, fields), [refs, fields]);
  return useSyncExternalStore(cb => store.subscribeNodes(refs, fieldGroupsOf(fields), cb), () => store.readProps(key, refs, fields));
}
```

- The camera does **not** go through React state, because it changes every frame while panning. Rulers and the zoom % subscribe with `store.subscribe("camera", cb)` and draw imperatively, as today's `view.ts` pattern does.
- Mixed values: the Inspector reads every selected ref and derives "Mixed" in TS.

### 10.6 Commands
`engine/api/commands.def.ts` lists every command with its `id`, its Figma label (for the undo label and menus), its args message, and whether it is undoable. The generator outputs the `CommandId` const map and arg types (`commands.generated.ts`) and the C++ dispatch table. TS's command registry (menus, shortcuts, toolbar) calls `engine.command(id, args)` and gets menu state from `engine_command_state`.

Initial set (E1–E3; later milestones add theirs):
- `UNDO, REDO`
- Selection: `SELECT_ALL, SELECT_NONE, SELECT_INVERSE, SELECT_MATCHING, SELECT_CHILDREN, SELECT_PARENT, SELECT_NEXT_SIBLING, SELECT_PREV_SIBLING`
- Editing: `DELETE, DUPLICATE, RENAME{name}, GROUP, UNGROUP, FRAME_SELECTION, CREATE_NODE{type, props, parentRef?, point?}`
- Arrange: `ALIGN{LEFT|HCENTER|RIGHT|TOP|VCENTER|BOTTOM}, DISTRIBUTE{H|V}, TIDY_UP, BRING_FORWARD, SEND_BACKWARD, BRING_TO_FRONT, SEND_TO_BACK, FLIP_H, FLIP_V, NUDGE{dx,dy}`
- `TOGGLE_LOCK, TOGGLE_VISIBLE, SET_OPACITY{value}`, `COPY_PROPERTIES, PASTE_PROPERTIES`
- Auto layout: `ADD_AUTO_LAYOUT` (infers direction and gap from the arrangement, as `FigmaEditor.tsx:698-709` does), `REMOVE_AUTO_LAYOUT`
- View: `ZOOM_IN, ZOOM_OUT, ZOOM_TO_100, ZOOM_TO_FIT, ZOOM_TO_SELECTION, ZOOM_TO{ref}, NEXT_FRAME, PREV_FRAME, TOGGLE_PIXEL_GRID, TOGGLE_LAYOUT_GRIDS, TOGGLE_OUTLINE_MODE`
- Pages: `CREATE_PAGE, DUPLICATE_PAGE, DELETE_PAGE, MOVE_TO_PAGE{pageId}`
- Text: `TEXT_TOGGLE_BOLD, TEXT_TOGGLE_ITALIC, TEXT_TOGGLE_UNDERLINE, TEXT_TOGGLE_STRIKETHROUGH, TEXT_ADJUST{SIZE|WEIGHT|LINE_HEIGHT|LETTER_SPACING, ±}`
- `PLACE_IMAGES{hashes, sizes, point}`
- Later:
  - E4: `BOOLEAN_{UNION,SUBTRACT,INTERSECT,EXCLUDE}, FLATTEN, OUTLINE_STROKE, USE_AS_MASK`
  - E6: `CREATE_COMPONENT, CREATE_MULTIPLE_COMPONENTS, COMBINE_AS_VARIANTS, ADD_VARIANT, DETACH_INSTANCE, RESET_OVERRIDES{fields?}, PUSH_OVERRIDES_TO_MAIN, GO_TO_MAIN_COMPONENT, SWAP_INSTANCE{component}, INSERT_INSTANCE{component, point}, APPLY_LIBRARY_UPDATE{…}`

**Keyboard routing.** `EngineCanvas` sends every keydown that arrives while the canvas has focus to `engine_key` first. If the result isn't `HANDLED`, TS's shortcut registry runs: ⌘Z, ⌘G, V/F/R/O/L/T/P tool letters, ⌥⌘K, …. While a panel input has focus, keys never reach the engine.

### 10.7 Clipboard
- **Copy/cut**: `engine_copy` returns a `Message`. TS writes it to the system clipboard over IPC as three formats:
  - a private type `application/x-designerv2-kiwi`;
  - `text/html` carrying the same bytes base64'd in a comment, for later pasting between files and apps (Figma does this through HTML);
  - `image/png` when one node is selected (via export).
- **Paste**: TS reads the private format (else HTML, else image → `PLACE_IMAGES`, else text → a new text node) and calls `engine_paste`.

### 10.8 Export and the preview path
- **Raster** (PNG/JPG): the engine renders the node(s) offscreen at the asked scale (it tiles internally when the size exceeds `MAX_TEXTURE_SIZE`) and reads back premultiplied → straight RGBA8. `EXPORT_DONE.bytes` = RGBA. TS encodes with `OffscreenCanvas.convertToBlob`. Export settings: `exportSettings` (scale or width/height constraint, suffix, format, contents-only).
- **Vector** (E7): `SvgWriter` (paths, gradients, filters for shadows and blurs, clipPaths, masks, text as `<text>` or outlines) and `PdfWriter` (paths, fonts subset with hb-subset, images by hash). `EXPORT_DONE.bytes` = the file.
- **Thumbnails** for Home: `engine_export` of the first top-level frame of page 1 at the thumbnail size, with `ApiExportSettings{thumbnail:true}`, when the tab hides or closes.
- **Preview for developer friends** (read-only sharing; the viewer app is owned by the share architect). The **same `engine.wasm`** runs in `mode=VIEWER`: no edit commands, no undo, no `DOCUMENT_CHANGED`.
  - **INSPECT mode** adds Dev-Mode-like behaviour: click to select (read-only), hover redlines to the selection, and spacing measurements without ⌥. `engine_read_derived` supplies the geometry; TS turns it into CSS (today's `css.ts` knowledge survives as "Copy as CSS").
  - The viewer loads a **snapshot from `engine_encode_document(ENCODE_BAKE_TEXT)`**. Each TEXT node then carries `derivedTextData` with glyph outlines as blobs (Figma's own approach), so friends see exact text **without the font files**. Images are referenced by hash and published alongside.
  - The engine renders baked glyphs whenever a text node's fonts are unavailable and baked data is present.

---

## 11. Testing

### 11.1 Native unit tests (`native-test` preset, doctest)
- **Runner**: `engine/tests/main.cpp`.
- **Sanitizers**: ASan and UBSan.
- **GPU**: none. `gfx/null/NullDevice` records draw calls, so batching and render-tree logic can be asserted.
- **Fixtures** in `engine/tests/data/`: `.bin` Messages converted from `docs/research/figma/samples/*.fig` by the TS importer, plus hand-built ones.
- **Fonts**: `InterVariable.ttf` plus one CFF font (`SourceSans3-Regular.otf`, OFL) are in `tests/data/fonts/`.

| file | covers |
|---|---|
| `base.fractional_index.test.cpp` | the shared vectors file; between/before/after; no key ends in digit 0 |
| `base.bytebuffer.test.cpp` | kiwi varints, the kiwi float encoding, strings: byte-equal to the `kiwi-schema` JS encoder outputs in `data/kiwi-vectors/` |
| `scene.roundtrip.test.cpp` | load → encode is byte-identical for every fixture; opaque fields preserved |
| `scene.hierarchy.test.cpp` | ordering, reparent, cycle rejection, orphans |
| `scene.txn.test.cpp` | coalescing, rollback restores bytes, forward Message contents, `clearedFields` |
| `undo.test.cpp` | property test: 500 random user transactions, undo all → encode equals the original; redo all → equals the final |
| `layout.autolayout.test.cpp` | hand cases for each mode, sizing, min/max freeze, wrap, absolute, `bordersTakeSpace` |
| `layout.figma_golden.test.cpp` | §4.7, against the stored Figma geometry, |Δ| ≤ 0.01 |
| `layout.constraints.test.cpp`, `layout.groups.test.cpp` | |
| `geometry.*.test.cpp` | vector network blob round-trip (sample blobs byte-identical), stroker joins/caps/dashes, corner smoothing against reference points, cubic→quad error bound, booleans (E4) |
| `text.*.test.cpp` | shaping of Inter "AV fi", line breaks (UAX #14 test subset), auto-resize, truncation; Figma golden: glyph x/baselines of `samples` text nodes against their stored `derivedTextData`/`baselines`, |Δ| ≤ 0.5 px with Inter |
| `hit.*.test.cpp` | picking rules (port today's `picking.ts` cases), locked/hidden, rotated, clipped, groups, instances |
| `derive.materializer.test.cpp` | instance sublayers equal the fixture's `derivedSymbolData` sizes and transforms; override precedence; stable NodeIds across main edits |
| `derive.variables.test.cpp` | mode inheritance, alias chains across collections, cycles |
| `render.batching.test.cpp` | NullDevice: 10k rects = 1 draw; paint switches; clip-mask usage |

### 11.2 Wasm integration tests (vitest, `wasm-node` build)
`src/renderer/src/engine/__tests__/*.test.ts` drive a headless engine (`mode=HEADLESS`) through the real generated wrapper. They cover:
- event pump order;
- result-slot copying;
- heap growth while views are held: the wrapper must re-read;
- pointers above 2 GiB (forced by allocating 2.1 GB, test-only flag);
- command/undo flows end to end.

`npm test` runs them when `engine/build/wasm-node/` exists and skips them otherwise.

### 11.3 Golden image tests (headless Chromium)
- `npm run engine:golden` builds `wasm-release` and launches Chromium through `playwright-core` with `--use-angle=swiftshader --enable-unsafe-swiftshader` (deterministic software GL).
- It loads `engine/tests/render/harness.html`, which renders each fixture scene at 1× and 2× DPR and reads the pixels back.
- It compares against `engine/tests/golden/<name>@<dpr>.png` with `pixelmatch` (threshold 0.1, ≤ 0.1% differing pixels).
- `--update` rewrites the goldens.
- **Figma calibration set** (`golden/figma/`): screenshots exported from Figma at 1× and 2× for shadows, blurs, gradients, small text, icons and strokes. These fix §14 Q2, and their tolerances are looser (≤ 1% of pixels with ΔE > 3).

### 11.4 Performance (`native-bench` plus in-app)
Targets on the owner's M3:

| metric | target |
|---|---|
| load 100k nodes | < 600 ms |
| pan/zoom on a 100k-node page | 60 fps (tiles) |
| a move-drag frame with 1k selected | < 8 ms engine time |
| selection change → panels updated | < 16 ms |
| typing | < 4 ms per keystroke |
| core memory | ≤ 400 B/node plus facets |

`engine_stats` feeds a debug HUD (⌥⌘P toggles it). `scripts/drive.mjs` gets a `perf` command that records frame times.

---

## 12. Third-party code (minimal by design)

| library | version (pin at vendoring) | licence | used for | build |
|---|---|---|---|---|
| **HarfBuzz** | 12.x | MIT ("Old MIT") | font parsing, metrics, shaping, glyph outlines (`hb-draw`), colour glyph PNGs; **hb-subset** in E7 for PDF/SVG fonts | amalgamated `src/harfbuzz.cc` (+ `harfbuzz-subset.cc` in E7) compiled as C++ with `-fno-exceptions -fno-rtti -DHB_NO_MT -DHB_NO_GETENV -DHB_NO_SETLOCALE -DHB_NO_OPEN -DHB_NO_BUFFER_SERIALIZE -DHB_NO_BUFFER_MESSAGE -DHB_NO_ERRNO`; no ICU/glib/FreeType integrations; ~0.8 MB wasm |
| **libunibreak** | 6.x | zlib | UAX #14 line breaks, word and grapheme breaks | plain C, our CMakeLists |
| **SheenBidi** | 2.x | Apache-2.0 (ship its NOTICE in the app's licences) | UAX #9 bidi (E3.2) | plain C, unity build |
| **utf8proc** | 2.10+ | MIT | Unicode case mapping for `textCase` (UPPER/LOWER/TITLE) | plain C |
| **doctest** | 2.4.x | MIT | native tests only | single header |
| paper.js boolean algorithm (port, not vendored code) | — | MIT notice kept in `geometry/Boolean.cpp` | curve-preserving booleans (E4) | ours |
| Inter | 4.x | OFL-1.1 (font asset) | UI font, default document font | `src/renderer/public/fonts/` |
| emdawnwebgpu (E9) | Emscripten port | BSD-3 | WebGPU backend | `--use-port=emdawnwebgpu` |
| naga-cli (E9, build-time only) | — | MIT/Apache-2.0 | GLSL → WGSL in shadergen | `cargo install naga-cli` |

**Explicitly not used**:
- Skia, CanvasKit, Skia PathOps (the owner's decision);
- FreeType: HarfBuzz draws outlines and we don't hint;
- ICU: SheenBidi, libunibreak and utf8proc cover what we use;
- zlib/zstd: `.fig` import runs in TypeScript in the main/utility process with `node:zlib` (`inflateRawSync`, `zstdDecompressSync`), which hands the engine our own `Message`;
- image codecs: the browser decodes, and export encodes with `convertToBlob`;
- JSON libraries;
- a hash-map library: `FlatMap` is ours.

---

## 13. Milestones

Each milestone ends with `npm run check` green and `npm run dev:demo` showing the result.

**E0: build pipeline + clear colour**
- emsdk/CMake/Ninja wiring, `CMakePresets.json`, `build.mjs`/`watch.mjs`.
- Generator skeletons: `schemagen` compiles `schema/document.kiwi` to C++ and TS, `apigen`, `shadergen`.
- `engine_create/destroy/set_viewport/tick/render`; `loadEngine.ts`, `Engine.ts`, `EngineCanvas.tsx`.
- CSP `wasm-unsafe-eval`, `.wasm` MIME, one doctest test.
- Accept:
  - The tab shows the canvas cleared to the page colour (`#f5f5f5` light / `#1e1e1e` dark), crisp at DPR 2, resizing with the window.
  - `engine:test` passes.
  - Release wasm ≤ 400 KB brotli at this stage.

**E1: scene graph, rectangles, camera, hit-test, selection, move**
- `NodeTable`, facets, `Apply`/`Encode`, `Txn`, undo/redo, events, `engine_load/apply_changes/encode_document`.
- SDF primitives with solid fills and simple strokes, frames with clipping (scissor/clip mask), ellipses, lines.
- Camera: wheel, pinch, space, H, zoom commands.
- Spatial index, picking rules, selection, the move/resize/rotate/marquee/draw gestures, overlays.
- Layer rows, `read_nodes`/`set_props`/`set_geometry`, the E1 commands, `DOCUMENT_CHANGED` → storage, copy/paste.
- Accept:
  - Fixture round-trips are byte-identical.
  - The 100k-rect page pans at 60 fps in direct mode with culling.
  - The undo property test passes.
  - Drag + Esc restores exactly.

**E2: auto layout**
- AutoLayout (H/V/wrap), Grid, constraints, groups, text-less hug, the `stackReverseZIndex` paint order, sections.
- Auto layout gestures: insertion indicator, reorder by drag and arrows, padding/gap handles with `REQUEST_INLINE_EDIT`.
- `ADD_AUTO_LAYOUT` inference.
- Accept: the Figma layout goldens pass (stacks_wrap, sections); 1,000 nested auto-layout frames relayout in < 4 ms per edit.

**E3: text**
- FontRegistry with Inter bundled and system fonts via IPC, HarfBuzz, itemization, libunibreak, TextLayout (all §7.4), auto-resize in layout, baseline alignment.
- Path renderer core (stencil + Loop-Blinn + MSAA) and MaskAtlas for glyphs.
- Text editing with caret, selection and IME; text styles applied.
- E3.2: bidi, emoji (sbix), lists, OpenType features panel.
- Accept: Figma text goldens (glyph positions ≤ 0.5 px with Inter); typing < 4 ms; Turkish casing of "i/İ" follows Unicode default mapping (documented).

**E4: vectors, pen, booleans**
- Vector network model and editing mode, Pen/Pencil, shapes (polygon, star, arcs, arrows), corner smoothing.
- Full stroker (aligns, caps, joins, dashes), MaskAtlas for small paths.
- Booleans (live + Flatten), Outline stroke, masks (vector/alpha/luminance).
- Accept: vector blob round-trip; booleans on the curve test suite; small-icon goldens against the Figma calibration set.

**E5: paints, effects, images, tiles**
- Gradients (4 kinds) with on-canvas handles, images (ImageCache, scale modes, filters, thumbHash placeholders), shadows (analytic plus generic), layer and background blur, layers/opacity/all blend modes.
- **Tile mode** with LOD and budgets.
- Accept: Figma calibration goldens; 60 fps zoomed out on a 100k-node page with effects; GPU memory within budget.

**E6: components, instances, variables**
- Materializer (instances, nested, swaps, property refs, overrides by guidPath, slots data model), variants, component properties, Reset/Push/Detach/Go to main.
- Variable resolver (modes, aliases, composed colour), styles (fill/stroke/text/effect/grid), library copies on the internal canvas and applying accepted updates.
- Accept: the fixture instances match `derivedSymbolData`; a mode switch on a 10k-consumer page takes < 50 ms; main-component edits update 1k instances in < 30 ms.

**E7: export and preview**
- PNG/JPG/SVG/PDF export, Copy as PNG/SVG, thumbnails, `ENCODE_BAKE_TEXT`, VIEWER/INSPECT modes, hb-subset.
- Accept: SVG/PDF goldens rendered by Chromium match the canvas within tolerance; a viewer snapshot renders without fonts installed.

**After E7**: E8 prototype player in the engine (interactions, Smart animate); E9 WebGPU backend behind `gfx::Device` (naga WGSL, mid-session fallback to WebGL like Figma); dynamic page loading; progressive blur/noise/glass; render worker.

---

## 14. Open questions

1. **Schema coordination** (with the schema architect's `schema/document.kiwi`). This document uses Figma's internal names, and `fieldmeta.ts` remaps them if the schema differs. Four points to confirm:
   - the name of the field-clearing mechanism (`clearedFields`);
   - groups as `FRAME+resizeToFit` (Figma's files) vs `GROUP`;
   - whether instance overrides stay one `symbolData` property (coarse for LWW) or are split per path;
   - whether the generated `src/shared/schema/document.generated.ts` is the one TS codec for everyone (assumed here).
2. **Fidelity calibration** needs Figma screenshots of the calibration scenes (§11.3). Constants to fix:
   - blur σ = radius/2;
   - gradient interpolation space (premultiplied is assumed);
   - hover outline width (2 px assumed) and handle size (8 px);
   - light-theme frame title colour;
   - pixel-grid threshold (800%);
   - small-text contrast.
3. **AA risk.** If stencil-then-cover + MSAA (with the 64-sample MaskAtlas for small items) misses the small-vector goldens, switch the path *fill* to GPU coverage accumulation (Pathfinder-style tiled signed-area masks on R16F) behind the same `PathRenderer` interface. Decide at the end of E4.
4. **Booleans.** The paper.js port is time-boxed to 2 weeks in E4. The fallback is Clipper2 (Boost licence) on flattened curves, with results marked approximate.
5. **Persisting derived caches.** Should the main document also persist `derivedTextData` (fast load, renders before fonts arrive)? Currently it is only baked into viewer snapshots.
