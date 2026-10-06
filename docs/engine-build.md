# Engine: build, run, test, API (milestones E0 + E1, E2 in progress)

## Status at handoff (2026-10-06)

The session was paused partway through round 2. Everything below is green at handoff:
- `npm run engine:test`: 75 doctest cases, 71,993 assertions, ASan/UBSan.
- `npm run typecheck`, `npm run lint`, `npm test` (37 files, 289 tests).
- `npm run engine:shot`: 9/9 browser checks.

The committed **release** wasm in `src/renderer/src/engine/wasm/` matches the source.

### Round 2: done and verified

- **Model.** 23 schema fields added, with their kiwi ids:
  - auto layout (container): `stackMode`, `stackSpacing`, the four paddings, `stackPrimarySizing` (absent means Hug), `stackCounterSizing`, `stackPrimaryAlignItems`, `stackCounterAlignItems`, `stackCounterAlignContent`, `stackWrap`, `stackCounterSpacing` (optional), `stackReverseZIndex`, `bordersTakeSpace`;
  - auto layout (child): `stackChildPrimaryGrow`, `stackChildAlignSelf` (absent means AUTO), `stackPositioning`, `minSize`, `maxSize`;
  - constraints: `horizontalConstraint`, `verticalConstraint`, `proportionsConstrained`.

  Node types SYMBOL, INSTANCE and SECTION are read as frame-like containers. The field mask is now 64-bit (`FieldMask`). `CodecJson` reads and writes every new field, emits `clearedFields` when an optional field is unset, and accepts GUID objects `{sessionID, localID}`. Files: `engine/src/scene/Node.{h,cpp}`, `CodecJson.{h,cpp}`.
- **Spatial index and derived-geometry cache** (docs/engine.md §8.1):
  - `engine/src/hit/SpatialIndex.{h,cpp}`: a Box2D-style dynamic AABB tree, one per page.
  - `Document` caches world transforms, render bounds, sibling indexes and paint order (`paintsBefore`, which respects `stackReverseZIndex`). `apply()` keeps the cache current, and it is recomputed lazily.
  - `hitPath` and `marqueeHits` now query the index.
  - Tests: `scene.hierarchy` and `layout.test.cpp` ("spatial index").
- **Layout** (`engine/src/layout/Layout.{h,cpp}`, docs/engine.md §4):
  - horizontal and vertical auto layout, with wrap (lines broken greedily, the row gap, `stackCounterAlignContent`);
  - gaps including SPACE_BETWEEN, SPACE_EVENLY and SPACE_AROUND; padding, plus the stroke when `bordersTakeSpace`;
  - Hug, Fill (`stackChildPrimaryGrow`, with a min/max freeze loop) and Fixed sizing; STRETCH; min/max;
  - absolute children follow constraints;
  - constraints MIN/MAX/CENTER/STRETCH/SCALE when a frame is resized in a transaction, computed from the values the transaction started with, so a gesture never drifts;
  - groups refit to their children (§4.5), and an empty group is deleted at commit.

  It runs inside USER and GESTURE transactions: at commit, and on every `setProps`, so panel scrubs update live. The writes are system writes, part of the same undo step and the same `DOCUMENT_CHANGED`. Tests are in `engine/tests/unit/layout.test.cpp`: wrap and center/center results equal Figma's numbers from `stacks_wrap.fig` (typed into the test), plus overflowing centred vertical, hug, fill and undo, group fit and deletion, and constraints.
- **Groups now store their own box.** `Document::localBounds` is `{0, 0, size}` for every node, and layout keeps a group's `size` and `transform` equal to the union of its children. The playground's sample group was given its real size (150×110).

### API names that exist now (the editor codes against these)

- **`abi.ts` `CommandId`.** The E1 ids, plus these new ids with final values:
  - GROUP 60, UNGROUP 61, FRAME_SELECTION 62, DUPLICATE 63, FLIP_HORIZONTAL 64, FLIP_VERTICAL 65;
  - ALIGN_LEFT 70, ALIGN_HORIZONTAL_CENTER 71, ALIGN_RIGHT 72, ALIGN_TOP 73, ALIGN_VERTICAL_CENTER 74, ALIGN_BOTTOM 75;
  - DISTRIBUTE_HORIZONTAL 76, DISTRIBUTE_VERTICAL 77;
  - ADD_AUTO_LAYOUT 80, REMOVE_AUTO_LAYOUT 81;
  - CREATE_PAGE 90, DELETE_PAGE 91, DUPLICATE_PAGE 92.

  The C++ copy is `engine/src/editor/Commands.h`, and vitest checks that the two agree. **These commands are not implemented yet:** `engine.command(...)` returns `Status.E_UNSUPPORTED` (−8), and `commandState` returns 0 for them.
- **`Engine.ts`.** No new methods this round. The full list is unchanged from E1 (see "The TS API" below): `create`, `load`/`loadDocument`, `applyChanges`, `encodeDocument`, `pages`, `setCurrentPage`, `setViewport`, `setCamera`, `getCamera`, `setTheme`, `pointer`, `wheel`, `key`, `modifiers`, `blur`, `setTool`, `setHover`, `getSelection`, `setSelection`, `readNodes`, `readNode`, `hitTest`, `setProps`, `txnBegin`/`txnCommit`/`txnCancel`, `command`, `commandState`, `undo`, `redo`, `stats`, `on`/`onAny`/`onDocumentChanged`/`onSelectionChanged`/`onCursor`, `schedule`, `renderNow`, `destroy`.
- **Not in `Engine.ts` or the ABI yet:** `moveNodes(refs, parent, index)`, `encodeSelection()`, `paste(message, {inPlace})`, and command args carrying a page GUID (`command(name, {page})`). `Editor.h` declares `moveNodes`, `copySelection`, `paste` and the command helpers (`wrapSelection`, `ungroup`, `duplicate`, `flip`, `align`, `distribute`, `addAutoLayout`, `removeAutoLayout`, `createPage`, `deletePage`, `duplicatePage`, `reparent`, `cloneSubtree`, `placeManyAt`, `topSelectionInPaintOrder`), but **none of them is defined**: calling one is a link error. They are marked in the header.

### Partial (written, not wired)

- **Snapping and measurement.** `engine/src/editor/Snapping.{h,cpp}` is written and compiles but has no tests and isn't used yet:
  - `Snapper::snapBox` snaps edges and centres, and equal spacing (centred between two layers, or matching an existing gap);
  - `snapPoint` and `guidesFor`;
  - `measureBetween` gives the ⌥ distances.
- **Overlay.** `Overlay` (`render/Renderer.h`) has fields for `guides`, `spacings`, `measureTarget`, `measures`, `measureGuides`, `insertion` and `bands`, and `Editor::overlay()` fills them from state that nothing sets yet. `render/Overlay.cpp` doesn't draw them yet.
- **Gesture state.** `Editor.h` has the gesture state for the new behaviour (`excluded_`, `originals_`, `duplicating_`, `dropParent_`, `snapper_`, `insertion_`, `bands_`, `ignoreConstraints_`). The methods that would use it (`startMove(mods)` beyond the old behaviour, `setDuplicating`, `dropTargetAt`, `prepareSnapping`, `updateInsertion`, `finishMove`, `updateMeasure`, `updateAutoLayoutBands`) are declared but not defined.

### Not started

- **Editor-support API:** the 19 commands above, `moveNodes`, `encodeSelection`/`paste` (the clipboard Message follows docs/schema.md §4.1, with `clipboardSelectionRegions.enclosingFrameOffset` giving each source parent's position on the page), and page arguments on `engine_command`.
- **Canvas feel:**
  - ⌥-drag duplicate;
  - drag-to-reparent into and out of frames;
  - smart guides and equal-spacing marks drawn while moving, resizing and drawing, with ⌃/⌘ disabling snapping;
  - ⌥-hover measurement;
  - auto layout: reorder by drag with the insertion indicator, and the padding/gap bands on hover;
  - arrow keys reordering auto-layout children.
- **Layout follow-ups:** GRID layout (§4.3); BASELINE alignment (needs text); a converter turning `docs/research/figma/samples/*.fig.json` into `engine/tests/data/` fixtures, for the golden comparison of §4.7.
- **Kiwi** at the TS↔C++ boundary.

### Known behaviour at handoff (not breakage, but worth knowing)

- **Gestures are still E1's.** Moving works in the parent's space, nothing is reparented, and nothing snaps. Layout runs only when the gesture commits, so:
  - during a drag, a group's box doesn't follow its children until release;
  - dragging an auto-layout child moves it freely, and on release it goes back to its place in the flow (no reorder yet).
- **`stackCounterSpacing` absent means "the same as `stackSpacing`".** That is what Figma's own layout does in `stacks_wrap.fig`. `docs/schema.md` §3.4 says absence means 0, so the schema owner should confirm.
- **`Document::worldTransform` now returns by value**, from the cache.

### Next steps, in order

1. **Editor-support API.**
   - Define the declared command helpers in `editor/Commands.cpp`, following the semantics in this round's brief. Group and frame selection wrap at the topmost selected node's place; group is FRAME + `resizeToFit` with no fill; frame selection is a white frame without clipping, like the old `FigmaEditor.groupSelection`. Add auto layout infers direction and gap from the arrangement, converts a lone frame in place, and wraps anything else.
   - Add `CommandArgs.page` parsing to `engine_command` (the args JSON `{"page":"0:3"}`) and `command(name, args: Record<string, number | string>)` to `Engine.ts`.
   - Add `engine_move_nodes` → `Engine.moveNodes(refs, parent, index): number`, `engine_encode_selection` → `Engine.encodeSelection(): Message | null`, and `engine_paste` → `Engine.paste(message, { inPlace }): number`.
   - Add the TS shortcuts: ⌘G, ⇧⌘G, ⌥⌘G, ⌘D, ⇧H, ⇧V, ⌥A/⌥H/⌥D/⌥W/⌥V/⌥S, ⇧A, ⌥⇧A.
   - Write native tests for each, then update `exports.txt`, `EngineExports.ts` and `abi.test.ts`.
2. **Gestures on world transforms** (`tools/Gestures.cpp`).
   - Store each target's start world transform and parent. Every step recomputes local = inverse(current parent's world) × desired world, so group refits and reparenting stay exact.
   - Call `flushLayout()` at the end of every step.
   - Then add drag-to-reparent (`dropTargetAt`: the topmost frame-like node under the pointer, excluding what's being moved; ⌘ keeps the parent) and ⌥-drag duplicate (`setDuplicating`, which toggles mid-drag).
   - Then auto-layout drags: `excluded_` takes the dragged layers out of the flow while dragging; `updateInsertion` places the insertion indicator; on drop, write the key at the insertion index.
3. **Snapping.** `prepareSnapping`: siblings from `Document::query` around the viewport, plus the parent frame's box. Use `Snapper::snapBox` in move and `snapPoint` in resize and draw, with a threshold of 6 CSS px ÷ zoom. ⌃ or ⌘ disables snapping, and positions round to the pixel grid. Draw `guides`, `spacings`, `measures` and `insertion` in `render/Overlay.cpp` in `#F24822`, with pills for the numbers (text comes in E3). Add ⌥ measurement in `updateHover`, via `measureBetween`.
4. **E2 remainder.**
   - Convert the Figma samples to fixtures and add golden tests within |Δ| ≤ 0.01.
   - The auto-layout padding/gap bands on hover.
   - When a resize changes an auto-layout child, set its resized axes to Fixed (Fill → Fixed, STRETCH → AUTO, Hug → FIXED).
   - GRID.
5. **Kiwi boundary.** Replace `scene/CodecJson` and `src/renderer/src/engine/codec.ts` with the schemagen codecs (`engine/tools/schemagen`, owned by the data agent: read it, don't edit it).
6. **E3 text.** HarfBuzz shaping, line breaking, glyph rendering (path renderer and mask atlas), and text editing with IME. After that: the size-badge text, frame titles, measurement numbers, and baseline alignment.

---


The canvas engine is C++20 compiled to WebAssembly with Emscripten. It owns the scene graph, the transactions and undo, hit-testing and picking, the tools and gestures, the camera, and its own WebGL2 renderer (no Skia, CanvasKit or DOM). React and TS panels sit around it. `docs/engine.md` is the architecture contract, and `schema/document.kiwi` with `docs/schema.md` define the data. This page covers what exists today and how to work with it.

## Quick start

| | |
|---|---|
| `npm run engine:build` | release Wasm → `src/renderer/src/engine/wasm/engine.{mjs,wasm}` (−O3, LTO) |
| `npm run engine:build:debug` | the same with assertions, `-O1 -g` and `engine.wasm.map` |
| `npm run engine:test` | native doctest suite with ASan + UBSan |
| `npm run engine:watch` | rebuilds `wasm-debug` whenever `engine/src`, `engine/api`, `engine/cmake` or `schema/` change |
| `npm run engine:dev` | the playground alone, at http://localhost:5299 (Vite, no shell, no Firebase) |
| `npm run engine:shot -- <dir>` | headless Chromium: loads the playground, runs a set of gestures, checks the results, saves PNGs |
| `?engine` in the app | the same playground inside the desktop app or `npm run web` |
| `npm test` | includes `src/renderer/src/engine/__tests__`: the ABI twins, plus the real Wasm driven through the TS facade in Node |

`engine/tools/build.mjs <preset> [--test]` sets up the toolchain itself:
- Emscripten: `$EMSDK` or `~/emsdk`. It sets `EMSDK`, `EM_CONFIG` and `PATH` and does not source `emsdk_env.sh`. It warns if the active version differs from `engine/EMSDK_VERSION` (6.0.11).
- CMake and Ninja: taken from `~/Library/Python/3.9/bin` when they are not already on `PATH`.
- Python for `emcc`: `EMSDK_PYTHON`, otherwise `uv python find 3.12`.

Presets live in `engine/CMakePresets.json`: `wasm-release`, `wasm-debug` and `native-test`. Build trees go in `engine/build/`, which is gitignored.

**The Wasm output is committed** (`src/renderer/src/engine/wasm/`, about 240 KB of wasm, about 95 KB gzipped, plus 30 KB of glue). `docs/engine.md` §1.6 wants it gitignored and rebuilt by `predev`/`prebuild` hooks, but those hooks are not wired yet. Until they are, committing the output means `npm run dev`, `npm run build` and `npm run typecheck` work without emsdk. When the hooks land, add `src/renderer/src/engine/wasm/engine.*` to `.gitignore` and keep `engine.d.mts`. **Rebuild `wasm-release` before committing**: a debug build overwrites the same files.

## Layout

```
engine/
  CMakeLists.txt, CMakePresets.json, EMSDK_VERSION
  cmake/Flags.cmake          C++20, -fno-exceptions -fno-rtti, -Wall -Wextra -Wpedantic -Werror, sanitizers
  cmake/Emscripten.cmake     link flags (MODULARIZE + EXPORT_ES6, ENVIRONMENT=web, ALLOW_MEMORY_GROWTH,
                             MAXIMUM_MEMORY=4GB, WebGL 2 only, FILESYSTEM=0, STRICT, explicit exports)
  api/exports.txt            EXPORTED_FUNCTIONS (hand-kept until apigen)
  tools/build.mjs, watch.mjs
  src/base/                  Guid, FractionalIndex (docs/schema.md §10), Json (interim encoding)
  src/math/Math.h            Vec2, Mat2x3, Rect, SDFs (rounded box with per-corner radii, ellipse)
  src/scene/                 Node (types, fields, defaults), Document (flat GUID table, derived children,
                             world transforms, bounds), ChangeSet (forward Message per commit), CodecJson
  src/editor/                Editor (transactions, selection, commands, keys, camera), Undo, Selection,
                             Keys.h (keyCode table), Commands.h (command ids)
  src/tools/Gestures.cpp     pan, press/click, move, resize, rotate, draw, marquee, hover, cursors
  src/hit/                   HitTest (geometry), Picking (picking.ts rules), Marquee
  src/render/                Renderer (scene → batched shapes), Overlay, OverlayStyle, Camera, ShapeInstance
  src/gfx/                   Device.h (explicit-argument interface), gl/ (WebGL2), null/ (records, for tests)
  src/api/Api.cpp            the C ABI
  tests/                     doctest: unit/*.test.cpp, data/fractional-index-vectors.txt
  third_party/doctest/       doctest 2.4.11 (MIT)
src/renderer/src/engine/
  wasm/engine.mjs + .wasm    build output; engine.d.mts types it
  EngineExports.ts           typed C ABI + marshalling (stand-in for EngineExports.generated.ts)
  codec.ts                   the TS twin of CodecJson: payload types and encode/decode
  abi.ts, keyCodes.ts        ABI numbers (tools, commands, flags, statuses), KeyboardEvent.code table
  loadEngine.ts, Engine.ts   module loader, facade (event pump, frame loop)
  EngineStore.ts, hooks.ts   external store + useSyncExternalStore hooks
  CanvasController.ts        DOM → engine wiring; cursors.ts, shortcuts.ts
  EngineCanvas.tsx, Playground.tsx, sampleDocument.ts, dev/ (standalone Vite entry)
scripts/engine-dev.mjs, scripts/engine-shot.mjs
```

## What works (E0 + E1)

**Scene graph.** A flat table of nodes keyed by GUID (`"s:l"`). Each node has these typed properties, named as in the schema:
- `type`, `name`, `visible`, `locked`, `opacity`
- `transform` (2×3, relative to the parent), `size`
- `fillPaints` and `strokePaints` (solid colours, list-shaped), `strokeWeight`, `strokeAlign`
- the four `rectangle*CornerRadius` fields plus `cornerRadius`
- `frameMaskDisabled`, `resizeToFit`
- `parentIndex {guid, position}`
- on CANVAS only: `backgroundColor`, `backgroundEnabled`, `internalOnly`

Rules:
- Children are derived by sorting `position`, ties broken by GUID.
- Node types: DOCUMENT, CANVAS, FRAME, ROUNDED_RECTANGLE, ELLIPSE. RECTANGLE and GROUP are accepted on import. A group is FRAME + `resizeToFit`.
- A change is a node id plus the fields it touches. `apply()` returns the inverse.
- CREATED for a live GUID replaces the node.
- Cycles are refused.
- An orphan waits until its parent arrives.

**Transactions and undo** (docs/engine.md §9). Every edit runs inside a transaction (USER, GESTURE, UNDO, REDO, REMOTE or LOAD):
- Writing an equal value does nothing.
- A committed USER, GESTURE, UNDO or REDO transaction emits exactly one `DOCUMENT_CHANGED` Message. That Message holds one NodeChange per node with only its changed fields; creations carry their full state and removals come children first.
- A gesture is one undo step: inverses fold, so the first value wins. Key-repeat nudges merge into one step.
- Undo and redo restore the selection.
- Esc, blur and pointer-cancel roll the gesture back exactly and emit nothing.
- Panel scrubs use `txnBegin`/`txnCommit`.
- When a key would grow past 24 characters, the siblings are rebalanced inside the same transaction (§10.3).
- The undo stack is capped at 1,000 steps.

**Renderer** (ours, over `gfx::Device`):
- Shapes are instanced SDF quads with analytic AA: rect, rounded rect with per-corner radii, ellipse. Fill and stroke (inside, centre or outside) are drawn in one pass, premultiplied, with opacity.
- Geometry is composed in doubles on the CPU, camera included, so the GPU only sees screen-space floats.
- Frame clipping uses scissor when the frame is axis-aligned and square, and stencil (nested) when it is rounded or rotated.
- Render on demand: nothing runs while idle.
- DPR uses the canvas's real backing size.
- Strokes draw over a frame's content.
- Off-screen nodes are culled.
- The page colour is used, or the theme's when the page uses Figma's default `#F5F5F5`. Dark is `#1E1E1E`.
- 10,000 rects are drawn in one draw call.

**Overlays** (§6.11):
- Hover outline is 2 px and follows the shape.
- Selection box is 1 px and drawn along the rotated box. Multi-selection shows each layer's box plus the combined box.
- 8×8 white handles with the selection-colour border. They are hidden when the box is under 24 px on screen.
- The size badge is a 16 px pill placed 6 px below the box. Its `W × H` text comes with E3.
- Marquee is a 10% fill with a 1 px border.
- The selection colour is `#0D99FF` in light and `#0C8CE9` in dark (§6.11).
- 1 px lines snap to device pixels.

**Camera:**
- The wheel pans; ⇧ pans sideways.
- Pinch, or ctrl/⌘ + wheel, zooms around the pointer by `exp(−dy·0.01)`.
- Space-drag, middle-drag and the H tool pan.
- Zoom range is 0.02–256.
- Zoom to fit (⇧1), to the selection (⇧2), 100% (⇧0 / ⌘0), ⌘+ and ⌘−. These commands land the page on whole device pixels.

**Hit-testing and picking** (§8.2, ported from `picking.ts`):
- Geometry-accurate for rounded rects and ellipses.
- A stroke counts within max(half its width, 4 CSS px).
- A frame is hit by its box only when it shows a fill or stroke, or is top-level.
- A group is hit only through its children.
- Clipped children outside their frame don't hit.
- Hidden nodes are skipped, and the path is cut at the first locked node.
- Picking: a top-level frame's child first. A selected layer opens to its children, and siblings of the selection are picked at their own level. ⌘ picks the innermost layer.
- Click, ⇧-click (toggle) and marquee: live, ⇧ additive. A partly covered frame contributes its children, and a marquee started on a frame's background works among that frame's children.

**Gestures and tools:**
- Move: 3 px threshold, ⇧ locks the axis, whole pixels.
- Resize from 4 corners plus edge zones: ⇧ keeps the ratio, ⌥ resizes from the centre, dragging past zero flips the node (negative scale). Several layers scale as one box, and a group resizes its children.
- Rotate from 16 px zones outside the corners; ⇧ snaps to 15°.
- Draw with F/A (frame), R (rectangle) and O (ellipse): ⇧ makes a square, ⌥ draws from the centre, and a click makes a 100×100 shape inside the innermost frame under the press. Figma's defaults apply: a frame gets a white fill and the name "Frame N"; rectangles and ellipses get `#D9D9D9` and the names "Rectangle N" / "Ellipse N"; all get a 1 px inside stroke weight. After drawing, the tool goes back to Move.
- Keys the engine handles itself: arrows (nudge, ⇧ ×10), Esc (cancel, then parent, then deselect), Enter (children), ⇧Enter (parent), Tab / ⇧Tab (siblings), Space.
- Every other key goes to TS's shortcut table (`shortcuts.ts`): V F A R O H, ⌘Z, ⇧⌘Z, ⌘Y, ⌫, ⌘A, ⇧0/1/2, ⌘0, ⌘+, ⌘−, ⌘], ⌘[, ⌥⌘], ⌥⌘[, ⇧⌘L, ⇧⌘H.

## The C ABI

Calls are flat `extern "C"` functions; there is no embind. The ABI version is 1, and `api/exports.txt` lists everything. In wasm32, pointers and handles are u32; natively they are `uintptr_t`, so the native tests can call the same functions. Payloads are UTF-8 JSON in the shapes of `schema/document.kiwi` (see below).

| Function | Notes |
|---|---|
| `engine_abi_version`, `engine_alloc/free`, `engine_result_ptr/len`, `engine_events_flag_ptr`, `engine_last_error` | Module. Results go to one result slot, valid until the next result. The events flag is a u32 in memory, non-zero while events are queued. |
| `engine_create(selector, opts, len)` / `engine_destroy` | `"#engine-canvas"`, or 0 for headless. `opts` is `{sessionID, theme}`. |
| `engine_load(h, msg)`, `engine_apply_changes(h, msg, flags)`, `engine_encode_document`, `engine_pages`, `engine_set_current_page` | A Message is `{type, sessionID, nodeChanges}`. Flags: `APPLY_USER` 1, `APPLY_REMOTE` 2, `APPLY_LOAD` 4. |
| `engine_set_viewport(h, cssW, cssH, dpr, pxW, pxH)`, `engine_set_camera`, `engine_get_camera`, `engine_set_theme` | The engine sets the canvas's backing size. |
| `engine_pointer(h, type, x, y, button, buttons, mods, pressure, clicks, pointerType, t)` | Type: DOWN 0, MOVE 1, UP 2, CANCEL 3, ENTER 4, LEAVE 5. Returns HANDLED 1 \| CAPTURE 2. |
| `engine_wheel(h, x, y, dx, dy, deltaMode, mods, flags)` | `PINCH` = 1 |
| `engine_key(h, type, keyCode, codepoint, mods, repeat)`, `engine_modifiers`, `engine_blur` | `keyCode` is the index into `Keys.h` / `keyCodes.ts`. Returns HANDLED 1. |
| `engine_set_tool(h, tool)`, `engine_set_hover(h, refs)` | Tools follow §8.4's order. |
| `engine_tick`, `engine_render`, `engine_needs_frame`, `engine_next_frame_delay`, `engine_gl_context_lost/restored` | Render on demand. |
| `engine_get_selection`, `engine_set_selection`, `engine_read_nodes(h, refs, flags)`, `engine_hit_test` | `INCLUDE_CHILD_IDS` = 1 |
| `engine_set_props(h, refs, change, flags)`, `engine_txn_begin/commit/cancel`, `engine_command(h, id, args)`, `engine_command_state` | Commands are in `Commands.h` / `abi.ts`. |
| `engine_has_events`, `engine_take_events`, `engine_stats` | Events: `{events:[…]}` |

Mods are bit flags: SHIFT 1, ALT 2, CTRL 4, META 8, PRIMARY 16 (⌘ on a Mac, Ctrl elsewhere). Status codes follow §10.3: OK 0, E_HANDLE −1, E_DECODE −2, E_INVALID −3, E_NOT_FOUND −5, E_BUSY −7, E_UNSUPPORTED −8.

Events follow §10.4: `DOCUMENT_CHANGED {kind, label, message}`, `NODES_CHANGED {refs, fieldGroupMask}` (live, for panels), `STRUCTURE_CHANGED`, `PAGES_CHANGED`, `CURRENT_PAGE_CHANGED`, `SELECTION_CHANGED {pageId, refs}`, `CAMERA_CHANGED`, `TOOL_CHANGED`, `CURSOR {kind, angleDeg}`, `HOVER_CHANGED`, `UNDO_STATE`.

## The TS API

```ts
const engine = await Engine.create(canvas, { sessionID, theme: "DARK" }); // canvas null = headless
engine.load(message);                         // or loadDocument()
engine.applyChanges(message, "user" | "remote" | "load");
engine.pointer(...) / wheel(...) / key("down", e.code, e.key, mods, e.repeat) / modifiers() / blur();
engine.setTool("RECTANGLE"); engine.undo(); engine.redo(); engine.command("ZOOM_TO_FIT");
engine.getSelection(); engine.setSelection(["1:5"]); engine.readNode("1:5", { childIds: true });
engine.setProps(["1:5"], { opacity: 0.5 }); engine.txnBegin("Opacity"); …; engine.txnCommit();
engine.onDocumentChanged((changes, e) => persist(e.message));   // one Message per commit
engine.onSelectionChanged((s) => …); engine.onCursor((kind, angle) => …); engine.on("CAMERA_CHANGED", …);
engine.encodeDocument(); engine.hitTest(x, y); engine.stats(); engine.destroy();
```

- **Event pump.** After every call, the facade reads the events flag from memory. If it is set, the facade drains the queue and dispatches the events synchronously after the engine has returned. A handler may call the engine again: its events are queued behind the current ones.
- **Frames.** Any call that leaves the engine wanting a frame schedules one `requestAnimationFrame`, which runs tick and then render.
- **`CanvasController`** (used by `EngineCanvas`) forwards pointer events (with pointer capture), wheel events (`passive: false`, `ctrlKey` → PINCH), keys (the engine first, then `shortcuts.ts`), focus and blur. It sizes the canvas with `ResizeObserver` (device-pixel-content-box when it is consistent), sets cursors (angle → CSS resize cursor; an SVG rotate cursor) and handles WebGL context loss.
- **`EngineStore` + `hooks.ts`** expose `useSelection`, `useTool`, `useUndoState`, `useHover`, `useCurrentPage`, `useCamera` and `useNode(store, id)` through `useSyncExternalStore`. Each snapshot is immutable per topic, and a node is re-read only after a change touches it.

## The wire encoding (interim) and the switch to kiwi

The payloads are JSON, but they use the schema's field names and meanings:
- Absent fields mean the absence value (§3.4).
- A CREATED change carries only the fields that differ from absence, plus `type` and `parentIndex`.
- `clearedFields` (kiwi field ids) is read on updates.
- Cleared fields are read as their defaults, and the engine's inverse writes the default value back rather than `clearedFields`, because the interim node model doesn't track absence separately.

Exactly two modules know the encoding: `engine/src/scene/CodecJson.{h,cpp}` and `src/renderer/src/engine/codec.ts`. When `engine/tools/schemagen` emits the kiwi codecs:
1. Replace those two modules with the generated codecs.
2. Swap the `Message`/`NodeChange` types in `codec.ts` for the generated ones.
3. Change the C++ `Field` bitmask to kiwi field ids. `kiwiFieldId()` and `fieldsOfKiwiId()` already map them.

The ABI does not change.

## Deviations from docs/engine.md (interim, on purpose)

**Scene and transactions**
- The node store is one struct per node with a field bitmask. §2.2's SoA `NodeTable` with facets, interned strings and opaque-field round-trip is not built yet. Coordinates are doubles in the engine and floats on the wire and GPU.
- Undo inverses are field values, not kiwi bytes.
- No spatial index: hit-testing and culling walk the tree. This is fine at E1 sizes; §8.1's AABB tree comes with the 100k-node work.
- No render tree or tiles: the renderer draws directly from the scene.
- (Round 2) Groups now store their box, kept by layout (see the status section).
- Group opacity multiplies down instead of compositing a layer (E5).

**Graphics**
- `gfx::Device` is a subset of §6.1: buffers, pipelines over one built-in shader, and one pass on the default framebuffer. There are no textures, targets, MSAA or readback yet. Shaders are hand-written GLSL ES 3.00 (`gfx/gl/Shaders.h`); shadergen and naga come later.
- The WebGL context has `stencil: true`, because clip masks use the default framebuffer until the engine has its own targets. §6.1 asks for `stencil: false` once those exist.

**Bindings and build**
- The bindings, export list, key-code table and command ids are kept by hand. Vitest checks that the TS and C++ copies agree.
- Payloads are JSON, not kiwi (see above).
- Not yet in the ABI: `engine_layer_rows`, `engine_read_derived`, `engine_set_geometry`, `engine_copy`/`engine_paste`, `engine_find`, `engine_export`.
- Tests are named `tests/unit/<area>.test.cpp`. There is no `wasm-node` preset: the vitest integration test runs the web build in Node with `document`/`window` stubs.

**Editing**
- Missing gestures: ⌥-drag duplicate, reparenting on drop, snapping and smart guides, double-click into layers, and frame titles (they need text).

## Next

- **E2:** auto layout, constraints, group geometry written into the document, sections, auto-layout gestures.
- **E3:** text — HarfBuzz, line breaking, glyphs (path renderer, MaskAtlas), editing with IME. This also unlocks the size-badge text, frame titles and measurement labels.
- **Alongside:**
  - the generated kiwi codec and bindings (schemagen and apigen);
  - the NodeTable with facets;
  - a spatial index;
  - `engine_layer_rows` for the Layers panel;
  - copy and paste;
  - drag-to-reparent;
  - the 100k-rect performance target;
  - golden-image tests (`engine:golden`);
  - `predev`/`prebuild` hooks, after which the Wasm output can be gitignored.
