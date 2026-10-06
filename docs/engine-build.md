# Engine: build, run, test, API (milestones E0 + E1 + E2)

## Status at handoff (2026-10-06)

Round 2 is finished, except GRID and the kiwi boundary (see "Not started"). Everything below is green:
- `npm run engine:test`: 109 doctest cases, 72,470 assertions, ASan/UBSan.
- `npm run lint`; `npm test` (49 files, 407 tests across the tree; the engine's own: 3 files, 14 tests); `npm run typecheck` is clean in the engine's folders. The last run showed errors only in the desktop agent's in-progress folders (`app/`, `main.tsx`).
- `npm run engine:shot`: 9/9 browser checks.

The committed **release** wasm in `src/renderer/src/engine/wasm/` matches the source (engine.wasm 457 KB).

### API the editor uses (final names; `engineCompat.ts` detects these)

- **`Engine.ts`, new this round:**
  - `command(name: CommandName, args?: Record<string, number | string>): number`. Page commands take `{ page: "s:l" }`; the engine also accepts `engineCompat.pageArgs`'s numeric form `{ page: localID, pageSession: sessionID }` and `{ sessionID, localID }`. Without `page`, the current page.
  - `moveNodes(refs: readonly Guid[], parent: Guid, index: number): number`. `index` is in the parent's paint order (0 = bottom), counted without the moved layers. They keep their relative order and their place on the page. Pages move under the document `"0:0"`. Returns how many moved; 0 means refused (a cycle, a page under a layer, a layer under the document).
  - `encodeSelection(): Message | null`. The selected subtrees as CREATED with their source ids, parents first, plus `pastePageId` and `clipboardSelectionRegions: [{ parent, nodes, enclosingFrameOffset }]` (docs/schema.md §4.1). `null` when nothing is selected.
  - `paste(message: Message, options?: { inPlace?: boolean }): number`. Fresh ids, selects what was pasted, returns how many top-level layers that was (negative = a `Status`). Rules are in docs/engine.md §8.6.
  - `renderThumbnailPixels(options: { page?: Guid; maxSize: number }): Pixels | null`. `Pixels` = `{ width, height, pixels }`, straight RGBA8, rows top to bottom.
  - `renderThumbnail(options: { page?: Guid; maxSize: number; type?: string }): Promise<Blob | null>`. A PNG by default, encoded through an `OffscreenCanvas` (else a DOM canvas).
  - Both render the page's content (the union of its visible layers' render bounds) fitted into maxSize × maxSize in the content's own aspect. The page colour is behind it and there are no overlays. The current page is used when `page` is absent. They return null for an empty or missing page, or when the GPU can't make the target.
- **`CONTEXT_MENU` event** (`engine.on("CONTEXT_MENU", …)`), typed in `codec.ts` as `{ type: "CONTEXT_MENU"; targetKind: "CANVAS" | "SELECTION"; x; y; hits: Guid[][] }`.
  - It fires on a right-click, or on a ⌃-click when ⌃ isn't the command key (a Mac).
  - First the engine selects what a left click would pick, unless that is already selected; on empty canvas the selection stays.
  - `hits` lists every layer under the point, topmost first. Each is a path innermost first: the layer, then its parents up to the page's child. A frame isn't listed again on its own when its child is listed. This is the data for "Select layer ▸".
  - It comes after `SELECTION_CHANGED` in the same drain.
- **`abi.ts`**: every `CommandId` is implemented now: SELECT_INVERSE 16 (Figma's Select inverse, ⇧⌘A: the selection's siblings, visible and unlocked, instead of it; with nothing selected, the page's layers), GROUP 60, UNGROUP 61, FRAME_SELECTION 62, DUPLICATE 63, FLIP_HORIZONTAL 64, FLIP_VERTICAL 65, ALIGN_LEFT 70, ALIGN_HORIZONTAL_CENTER 71, ALIGN_RIGHT 72, ALIGN_TOP 73, ALIGN_VERTICAL_CENTER 74, ALIGN_BOTTOM 75, DISTRIBUTE_HORIZONTAL 76, DISTRIBUTE_VERTICAL 77, ADD_AUTO_LAYOUT 80, REMOVE_AUTO_LAYOUT 81, CREATE_PAGE 90, DELETE_PAGE 91, DUPLICATE_PAGE 92. New flag: `PASTE_IN_PLACE = 1`.
  - Undo labels are Figma's: "Group selection", "Ungroup selection", "Frame selection", "Duplicate", "Flip horizontal", "Align left" … "Distribute horizontal spacing", "Add auto layout", "Remove auto layout", "Add page", "Delete page", "Duplicate page", "Move layers", "Move page", "Paste", "Reorder".
  - `commandState`: UNGROUP needs a selected group or frame with children. ALIGN_* needs two movable layers, or one inside a frame. DISTRIBUTE_* needs three. REMOVE_AUTO_LAYOUT needs a selected auto-layout frame. DELETE_PAGE needs more than one page (otherwise the command returns `E_INVALID`). The rest need a selection; CREATE_PAGE is always enabled.
- **`codec.ts`**: `NodeFields` now types the auto-layout and constraint fields the engine keeps (`stackMode`, `stackSpacing`, `stackHorizontalPadding` = left, `stackVerticalPadding` = top, `stackPaddingRight`, `stackPaddingBottom`, `stackPrimarySizing`, `stackCounterSizing`, `stackPrimaryAlignItems`, `stackCounterAlignItems`, `stackCounterAlignContent`, `stackWrap`, `stackCounterSpacing`, `stackReverseZIndex`, `bordersTakeSpace`, `stackChildPrimaryGrow`, `stackChildAlignSelf`, `stackPositioning`, `minSize`/`maxSize` `{ value }`, `horizontalConstraint`, `verticalConstraint`, `proportionsConstrained`). `NodeType` adds SYMBOL, INSTANCE and SECTION. `Message` adds `pastePageId?` and `clipboardSelectionRegions?`.
- **`shortcuts.ts`** adds ⇧⌘A, ⌘G, ⇧⌘G, ⌥⌘G, ⌘D, ⇧H, ⇧V, ⌥A/⌥H/⌥D/⌥W/⌥V/⌥S, ⇧A and ⌥⇧A. Distribute (⌃⌥H / ⌃⌥V) is left to the editor's registry, because `Shortcut` has no ⌃ field.
- **C ABI**: `engine_move_nodes(h, refs, refsLen, parentSessionID, parentLocalID, index)`, `engine_encode_selection(h, flags)` (`E_NOT_FOUND` when nothing is selected), `engine_paste(h, msg, len, flags)`, `engine_render_thumbnail(h, pageSessionID, pageLocalID, maxSize, flags)`, and `engine_command` args with `page`.
  - `engine_render_thumbnail`: page `0xffffffff:0xffffffff` = the current page. The result is u32 width, u32 height (little endian), then the RGBA8. It returns `E_NOT_FOUND` for an empty or missing page and `E_UNSUPPORTED` when there is no target. These are in `exports.txt`, `EngineExports.ts` and `USED_EXPORTS`.

### Round 2 follow-ups (the editor's requests): done and verified

- **Flips** answer `Status.OK` through `engine.command` with the committed release wasm. `engine.wasm.test.ts` checks it ("round 2 follow-ups"). An `E_UNSUPPORTED` the editor saw came from an older wasm.
- **SELECT_INVERSE** (16): implemented, and tested natively and in the wasm test.
- **CONTEXT_MENU**: `hit/HitTest` gained `hitPaths` (every layer under a point); `Editor::contextMenu` emits the event.
  - Because ⌃-click is the context menu, ⌃ turns snapping off only once a drag has started, as in Figma.
- **Thumbnails**: `gfx::Device` gained offscreen targets: `createTarget`, `destroyTarget`, `readPixels`, and `PassDesc::target`.
  - On WebGL2 a target is a framebuffer with an RGBA8 and a DEPTH24_STENCIL8 renderbuffer; readback flips the rows to top-down.
  - `NullDevice` records targets and reads back the pass's clear colour.
  - `Renderer::render` takes a target. `engine_render_thumbnail` draws the page with no overlays into a target sized to the fitted content, reads it back, un-premultiplies, and frees the target. The canvas is never touched, so there is no flicker and it works in a hidden tab.
  - The PNG encoding is TS's job (an `OffscreenCanvas`).
  - Checked in headless Chrome: a 480 × 285 PNG of the sample page, the right way up, with the selection not drawn.
  - The design is recorded in docs/engine.md §8.6.

### Round 2: done and verified

- **Model, spatial index, layout**: as described at the previous handoff. That covers 23 auto-layout and constraint fields, the per-page AABB tree, and auto layout with wrap, Hug/Fill/Fixed, min/max, constraints, group fitting and empty-group deletion. All of it is unchanged and still green.
- **Structural commands** (`editor/Commands.cpp`):
  - Group and frame selection wrap at the topmost selected layer's place and keep every layer where it is on the page. They work across parents. A group is FRAME + `resizeToFit` with no fill. Frame selection is a white frame that doesn't clip.
  - Ungroup sends the children to the group's place.
  - Duplicate, flip (about the selection box's own axes), align, distribute, add/remove auto layout (inferred, docs/engine.md §8.6), and pages (create, duplicate, delete; never the last one).
  - `moveNodes`, `copySelection` and `paste`.
  - Arrow keys reorder auto-layout children.
  - Tests: `tests/unit/editor.commands.test.cpp` (12 cases), plus one case in `api.test.cpp` and one in `engine.wasm.test.ts`.
- **Gestures on world transforms** (`tools/Gestures.cpp`):
  - Every move step computes local = inverse(the current parent's world) × the desired world. Layout runs (`flushLayout`) at the end of every move, resize, rotate and draw step, so groups follow live and panels see real numbers.
  - Drag-to-reparent is live: `dropTargetAt` finds the topmost frame under the pointer; ⌘ keeps the parent; a group's layers stay in the group.
  - ⌥-drag duplicates (`setDuplicating`). It toggles mid-drag, the cursor is `MOVE_DUPLICATE`, the drag is one undo step, and Esc leaves nothing behind.
  - Auto layout: reorder by drag with the insertion indicator (`updateInsertion`, which handles wrapped rows), dropping placed at the insertion index (`finishMove`), and dragging out of the flow. A layer dragged inside its own frame keeps its slot (`LayoutHost::placedByGesture`). Newcomers take no space (`excludedFromFlow`).
  - Resizing an auto-layout child fixes the axes it changed (Fill → Fixed, STRETCH → AUTO). Resizing a hugging auto-layout frame sets that axis to FIXED.
  - Tests: `tests/unit/editor.move.test.cpp` (12 cases).
- **Snapping and measurement**:
  - `prepareSnapping` takes the drop parent's children in and around the view plus the parent frame.
  - Move uses `snapBox`: edges, centres and equal spacing. Resize (when the box isn't rotated) and draw (both corners) use `snapPoint`. The threshold is 6 CSS px ÷ zoom. ⌃ or ⌘ turns snapping off. Pixel rounding applies otherwise.
  - ⌥ measurement (`updateMeasure`) measures to the hovered layer, or to the parent frame when hovering the selection or nothing.
  - Auto-layout padding and gap bands on hover (`updateAutoLayoutBands`), for a selected auto-layout frame that isn't rotated.
- **Overlay drawing** (`render/Overlay.cpp`, `OverlayStyle.h`):
  - guides: 1 px `#F24822`;
  - spacings and measures: a line, end ticks, and a red pill sized for its number (the text comes with E3);
  - ⌥ extension lines are dashed, and the measured layer is outlined in red;
  - the insertion line is 2 px in the selection colour;
  - bands are `#FF24BD` at 15%.

  All are pixel-snapped. Test: `render.batching.test.cpp`, last case. Seen in headless Chrome screenshots.
- **Figma golden layout** (§4.7): `node engine/tools/fixtures.mjs [--check]` converts `docs/research/figma/samples/*.fig.json` into `engine/tests/data/figma/*.json`. `tests/unit/layout.figma_golden.test.cpp` scrambles every auto-layout frame and group (flow children to the origin, Hug axes collapsed, group boxes moved off their contents), re-runs layout, and requires every node of `stacks_wrap`, `structure` and `sections` back at Figma's size and transform within 0.01. All three pass.
- **Kiwi**:
  - `kiwi.h` is vendored at `engine/third_party/kiwi/` (MIT, evanw/kiwi `master` @ 2023-09-03, `LICENSE.md` alongside).
  - `engine/cmake/Generators.cmake` runs `schemagen.ts --cpp <build>` as a CMake custom command (it depends on `schema/document.kiwi` and `schemagen.ts`), so nothing generated is committed.
  - `engine/src/schema/KiwiImpl.cpp` is the one TU with `IMPLEMENT_KIWI_H` + `IMPLEMENT_SCHEMA_H`. It includes `node_fields.h` (which brings `document.kiwi.h`) and `document.stream.h`. `document.kiwi.h`'s implementation block isn't include-guarded, so including it twice fails.
  - It is compiled and tested in the **native** build only (`eng_schema`). `tests/unit/scene.kiwi.test.cpp` covers a tree-codec round trip, a byte-identical re-encode through `schema_stream::parseMessage` + `Writer`, and that the engine's `kiwiFieldId` values match `kNodeFields`.

### Not started

- **GRID layout** (§4.3) and BASELINE alignment (which needs text).
- **Kiwi at the TS↔C++ boundary.** `scene/CodecJson` and `codec.ts` still speak JSON, and the Wasm doesn't link `eng_schema` yet.
- **Smaller canvas gaps:**
  - double-click into layers;
  - frame titles and every overlay number (both need E3 text);
  - snapping to page guides and layout grids;
  - ⌥⌘ measurement to locked layers;
  - smart duplicate (repeating the last ⌘D offset).

### Known behaviour (not breakage)

- **`stackCounterSpacing` absent means "the same as `stackSpacing`"**, as Figma's own layout does in `stacks_wrap.fig`, which the golden test now confirms. docs/schema.md §3.4 says absence means 0; the schema owner should align it.
- **The Wasm grew from 312 KB to 457 KB** (release, −O3 + LTO) with this round's code. Watch it; `-Os` for cold code or splitting the gesture lambdas are the levers.
- **Every layout result is a system write in the open transaction**, so a drag inside a group emits the group's refit as part of its one `DOCUMENT_CHANGED`.

### Next steps, in order

1. **Kiwi boundary.**
   - Link `eng_schema` into the Wasm.
   - Replace `scene/CodecJson` with `schema::Message` decode/encode, and use `schema_stream::parseMessage` for `engine_load`.
   - On the TS side, `codec.ts` re-exports the generated types and encodes with `codec` from `src/shared/schema/document.generated.ts`.
   - The ABI stays the same (bytes in, bytes out). The clipboard Message then becomes the fig-kiwi archive of desktop.md §13.
2. **GRID** (§4.3): `gridColumns`/`gridRows` (GUIDPositionMap), track sizing, anchors and spans, gaps, and auto placement. Add the fields to `Node.h` and the codec first.
3. **E3 text.** HarfBuzz shaping, line breaking, glyph rendering, and editing with IME. After that: the overlay numbers (badge, spacing and measure pills), frame titles, and BASELINE alignment.

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
  cmake/Generators.cmake     schemagen --cpp at build time → <build>/generated/schema/*.h; eng_schema (native)
  api/exports.txt            EXPORTED_FUNCTIONS (hand-kept until apigen)
  tools/build.mjs, watch.mjs
  tools/fixtures.mjs         Figma samples → tests/data/figma/*.json (--check)
  src/base/                  Guid, FractionalIndex (docs/schema.md §10), Json (interim encoding)
  src/math/Math.h            Vec2, Mat2x3, Rect, SDFs (rounded box with per-corner radii, ellipse)
  src/scene/                 Node (types, fields, defaults), Document (flat GUID table, derived children,
                             world transforms, bounds), ChangeSet (forward Message per commit), CodecJson
  src/editor/                Editor (transactions, selection, keys, camera), Commands (structural commands,
                             moveNodes, copy/paste), Snapping (snapper, ⌥ measurement), Undo, Selection,
                             Keys.h (keyCode table), Commands.h (command ids)
  src/layout/Layout.cpp      auto layout, constraints, group fitting
  src/schema/KiwiImpl.cpp    the one TU with the kiwi runtime + generated codecs (native only for now)
  src/tools/Gestures.cpp     pan, press/click, move (reparent, ⌥-duplicate, auto-layout insertion, snapping),
                             resize, rotate, draw, marquee, hover (⌥ measurement, auto-layout bands), cursors
  src/hit/                   HitTest (geometry), Picking (picking.ts rules), Marquee
  src/render/                Renderer (scene → batched shapes), Overlay, OverlayStyle, Camera, ShapeInstance
  src/gfx/                   Device.h (explicit-argument interface), gl/ (WebGL2), null/ (records, for tests)
  src/api/Api.cpp            the C ABI
  tests/                     doctest: unit/*.test.cpp, data/fractional-index-vectors.txt, data/figma/*.json
  third_party/doctest/       doctest 2.4.11 (MIT)
  third_party/kiwi/          kiwi.h (MIT, evanw/kiwi)
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

## What works (E0 + E1; E2 is in the status section)

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
| `engine_set_props(h, refs, change, flags)`, `engine_txn_begin/commit/cancel`, `engine_command(h, id, args)`, `engine_command_state` | Commands are in `Commands.h` / `abi.ts`. Args: `{dx, dy}` (NUDGE), `{page: "s:l"}` (DELETE_PAGE, DUPLICATE_PAGE). |
| `engine_move_nodes(h, refs, parentSessionID, parentLocalID, index)` | The Layers panel's drag. Returns how many moved. |
| `engine_encode_selection(h, flags)`, `engine_paste(h, msg, flags)` | The clipboard Message (docs/schema.md §4.1). `PASTE_IN_PLACE` = 1. Paste returns how many top-level layers it pasted. |
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
engine.command("GROUP"); engine.command("DELETE_PAGE", { page: "0:3" });
engine.moveNodes(["1:5"], "1:1", 0);                            // Layers drag: paint order, counted without them
const clip = engine.encodeSelection(); engine.paste(clip!, { inPlace: true });
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
- The spatial index is one AABB tree per page (§8.1). Culling still walks the tree.
- No render tree or tiles: the renderer draws directly from the scene.
- (Round 2) Groups now store their box, kept by layout (see the status section).
- Group opacity multiplies down instead of compositing a layer (E5).

**Graphics**
- `gfx::Device` is a subset of §6.1: buffers, pipelines over one built-in shader, and one pass on the default framebuffer. There are no textures, targets, MSAA or readback yet. Shaders are hand-written GLSL ES 3.00 (`gfx/gl/Shaders.h`); shadergen and naga come later.
- The WebGL context has `stencil: true`, because clip masks use the default framebuffer until the engine has its own targets. §6.1 asks for `stencil: false` once those exist.

**Bindings and build**
- The bindings, export list, key-code table and command ids are kept by hand. Vitest checks that the TS and C++ copies agree.
- Payloads are JSON, not kiwi (see above).
- Not yet in the ABI: `engine_layer_rows`, `engine_read_derived`, `engine_set_geometry`, `engine_find`, `engine_export`. Copy is `engine_encode_selection` (not §10.7's `engine_copy`).
- Tests are named `tests/unit/<area>.test.cpp`. There is no `wasm-node` preset: the vitest integration test runs the web build in Node with `document`/`window` stubs.

**Editing**
- Missing: double-click into layers, frame titles and overlay numbers (they need text), and snapping to guides and layout grids. The E2 decisions taken while building are in docs/engine.md §8.6.

## Next

- **E2 remainder:** GRID (§4.3).
- **E3:** text — HarfBuzz, line breaking, glyphs (path renderer, MaskAtlas), editing with IME. This also unlocks the size-badge text, frame titles and measurement labels.
- **Alongside:**
  - the generated kiwi codec at the boundary (schemagen's C++ compiles and is tested natively), and apigen;
  - the NodeTable with facets;
  - `engine_layer_rows` for the Layers panel;
  - the 100k-rect performance target;
  - golden-image tests (`engine:golden`);
  - `predev`/`prebuild` hooks, after which the Wasm output can be gitignored.
