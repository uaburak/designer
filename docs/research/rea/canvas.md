# Canvas core — Figma vs Wecra (REA round, 2026-10-15)

This page covers the canvas core: how Figma's editor schedules, renders, takes input, hit-tests, lays out, undoes and attributes changes; what Wecra's engine does today; and the ordered work to close the gap. Paints and effects are in [`effects.md`](effects.md). This page only refers to them where the canvas pipeline touches them (the blur kernel, §2.27).

**Sources.**
- Figma: a clean-room static reading of the current desktop build: the 52 MB editor wasm's strings, the wasm→JS glue of the editor (`fullscreen-wasm`) and of the render worker (`render-worker-wasm`), `render_worker.min.js`, `image_io_worker.min.js`, and chunks `3187`, `2622`, `2108` and `figma_app`. Offsets are quoted as `file @offset`. Only short snippets are quoted. Field numbers come from Figma's own schema (`docs/research/figma/figma-schema-106.kiwi`). The working notes are not in the repo. They cover behaviour and data shapes only.
- Live probes: none ran. The first `use_figma` call (file `2Rh4mZi09rwwECJE0xBG8Z`) was refused with "You've reached the Figma MCP tool call limit on the Starter plan", and nothing was retried. The 13 probes are listed in §5 as still to run. Several also need a manual ⌘Z, a Slides file or a UI iframe.
- Wecra: `docs/engine.md` §3, §6, §8, §9, `schema/document.kiwi`, `engine/src/{render,hit,editor,tools,layout,text,scene,gfx}`, `src/renderer/src/engine/{Engine.ts,CanvasController.ts,EngineStore.ts,gfx.ts}`, `src/renderer/src/editor/{images.ts,agents/nodeSpec.ts,plugins/}`, `src/shared/agents/layerProps.ts`, `src/store/local/`. The live "designer" MCP was not needed: every point here can be read from the source.

**Confidence.** *High*: read directly from code or from schema and string tables that agree. *Medium*: read from names, counters or assertion strings whose controlling code is stripped. The tile pixel sizes, AA pass counts, frame-budget numbers other than TSMER's, the drag threshold, the zoom factor per wheel step and the kd-tree leaf size are not visible statically.

---

## 1. Summary

| # | Feature | Wecra | Size | Prio |
|---|---|---|---|---|
| 1 | Plugin API auto layout / grid setter rules | **partial** (wrong stored enum, missing rules) | S | 1 |
| 2 | Blur kernel (tent) — see effects.md §2.1–2.4 | **different** | M | 1 |
| 3 | Layout enforcement after undo / redo / remote changes | **different** (stored sizes trusted) | M | 2 |
| 4 | Undo: skip batches with no visible effect, dangling filter, page ids | partial | M | 2 |
| 5 | Image downscale rules (area exception, texture clamp, thumbnail mips) | partial | S | 2 |
| 6 | Image decode colour handling (no colour management, sRGB / P3 tag) | **different** | M | 2 |
| 7 | Lazy materialization of invisible content | missing | L | 2 |
| 8 | Occlusion culling (opaque axis-aligned rect hides what is under it) | missing | M | 2 |
| 9 | Edit scopes and `NodeChange.editScopeInfo` (365) | partial (TxnKind + actors) | M | 3 |
| 10 | Time-sliced edit rendering (TSMER budgets) | missing | M | 3 |
| 11 | Per-frame tile budget: mandatory / interruptible / fallback / forced-old | partial | M | 3 |
| 12 | Tile renderer: resolution quadtree, small / large tiles | different (content cache + zoom tiles) | L | 4 |
| 13 | Mouse wheel classification and normalisation | partial | S | 3 |
| 14 | Input: click count, coalesced moves, drag replay, touch pinch | partial | S | 3 |
| 15 | WebGPU compatibility tests and sync readback | partial | S | 3 |
| 16 | NodePacker + `Message.encodedOffsetsIndex` (34) | missing (per-page derivation only) | L | 3 |
| 17 | Volatile property bindings (re-composite, not re-raster, while animating) | missing | L | 3 |
| 18 | Undo history persisted (`localUndoStack` 22 / `localRedoStack` 23) | missing | M | 4 |
| 19 | Threaded rendering: render worker on an OffscreenCanvas | missing | XL | 4 |
| 20 | Canvas frame transport (scene packets, generations, recovery) | missing (part of 19) | L | 4 |
| 21 | Render worker export memory budgets | missing | S | 4 |
| 22 | Hit-testing: per-container cached kd-tree | different (one AABB tree per page) | M | 4 |
| 23 | Immutable copy-on-write field values | partial (blobs only) | M | 4 |
| 24 | Task scheduling (postTask priorities) and invalidation batching | partial | S | 4 |
| 25 | Autosave journal backpressure | partial | S | 4 |
| 26 | Line breaking (UAX #14) | **done** (libunibreak in wasm) | S | 4 |
| 27 | Render worker frame loop (needs-more-frames, device fallback) | done (main thread) | — | — |
| 28 | NODE_CHANGES / JS boundary, panels keyed by revisions | done (TS owns the socket, by contract) | — | — |
| 29 | Path and glyph rasterization (stencil-then-cover Loop-Blinn) | different (keep: analytic curve coverage) | — | 5 |
| 30 | Progressive anti-aliasing of tiles | different (keep: analytic AA) | — | 5 |
| 31 | Mouse behaviour chain (≈180 `*Behavior` objects) | different (keep: gesture switch) | — | 5 |
| 32 | ImmutableFrameObserver | n/a (FigJam, set aside in Phase 7) | — | — |

`engine.md` must change with this work in three places:
- §3.3 and §9.3 say undo "runs stages 1–5". As built, layout runs only for USER / GESTURE transactions (`Editor.cpp:400`) and is cleared for the others (§2.3).
- §9.1 lists `pageId` in the undo batch. `UndoBatch` holds no page id (`Undo.h:22–27`); the page follows the restored selection (`Editor.cpp:1513`).
- §8.1 is correct but should name Figma's per-container kd-tree as the alternative that was not taken (§2.22).

---

## 2. Figma behaviour → Wecra today, per feature

### 2.1 Plugin API auto layout / grid setter rules — **partial**, high
**Figma.** `3187.min.js @3329751`:
- **Alignment storage.** `primaryAxisAlignItems` SPACE_BETWEEN is stored as kiwi `SPACE_EVENLY` (3), SPACE_AROUND as `SPACE_AROUND` (5) and SPACE_EVENLY as `SPACE_EVENLY_CSS` (6). GRID requires MIN for both alignments. `counterAxisAlignItems` BASELINE is allowed only in HORIZONTAL.
- **Sizing and spacing.** Sizing AUTO is stored as `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE`. `layoutGrow` takes only 0 or 1 (any positive integer behind `sts_some_fill`). `itemSpacing` takes any float, negative included. `counterAxisSpacing` takes a positive float or null. Paddings and grid gaps take positive floats.
- **Mode changes.** `layoutMode = "GRID"` also sets both sizings to FIXED, both alignments to MIN, and the grid to 2 × 2 (`setGridRowCount(2)`, `setGridColumnCount(2)`). Leaving HORIZONTAL / VERTICAL resets WRAP to NO_WRAP. GRID is refused on slots. `layoutWrap` WRAP needs HORIZONTAL or VERTICAL.
- **Child rules.** `layoutPositioning` ABSOLUTE throws "Can only set layoutPositioning = ABSOLUTE if the parent node has layoutMode !== NONE". `itemReverseZIndex` and `strokesIncludedInLayout` need a stack mode. `layoutAlign` takes INHERIT (stored as AUTO) or STRETCH; any other value warns and is ignored.
- **Grid.** `layoutSizing` HUG on a GRID turns its FLEX tracks into HUG. `gridRowCount` must be an integer ≥ 1 and is refused while `gridAutoTracks` is ROWS. `relativeTransform` is ignored on SLIDE, SLIDE_ROW and SLIDE_GRID.

**Wecra.** The engine lays out every alignment correctly. `Layout.cpp:375–390` treats kiwi SPACE_BETWEEN and SPACE_EVENLY as Figma's "space between", SPACE_EVENLY_CSS as CSS space-evenly, and SPACE_AROUND as space-around. The Design panel writes Figma's values (`panels/design/Layout.tsx:283–286, 600`). The Plugin API and the agents share `agents/nodeSpec.ts`, and it has these gaps:
- `primaryAxisAlignItems` is a plain enum pass-through (`nodeSpec.ts:467` via `enumProp`, `:358`) over `["MIN","CENTER","MAX","SPACE_BETWEEN"]` (`layerProps.ts:49`). SPACE_BETWEEN is stored as kiwi `SPACE_BETWEEN` (4), not `SPACE_EVENLY` (3), so an exported `.fig` differs from Figma's. The Plugin API values SPACE_AROUND and SPACE_EVENLY are refused.
- `layoutGrow` accepts any number ≥ 0 (`nodeSpec.ts:604`).
- `layoutMode = "GRID"` sets only `stackMode` (`nodeSpec.ts:434–450`).
- BASELINE is not limited to HORIZONTAL.
- No rule checks that the parent has a layout for ABSOLUTE beyond `on: inAutoLayout`.
- `counterAxisSpacing`, paddings and grid gaps take negative values.

**Build.** In `nodeSpec.ts` (the Plugin API and the agents' tools both use it):
1. A Figma ↔ kiwi map for `primaryAxisAlignItems`, applied on write and on read: SPACE_BETWEEN ↔ SPACE_EVENLY, SPACE_AROUND ↔ SPACE_AROUND, SPACE_EVENLY ↔ SPACE_EVENLY_CSS. Read kiwi SPACE_BETWEEN as SPACE_BETWEEN too, so older files still read. Widen `layerProps.ts:49` to the five values.
2. The validation rules above, with Figma's error text: BASELINE only in HORIZONTAL; GRID needs MIN alignments; `layoutGrow` ∈ {0, 1}; non-negative paddings, gaps and counter spacing; ABSOLUTE needs a parent layout; WRAP needs HORIZONTAL / VERTICAL; `gridRowCount` integer ≥ 1.
3. The GRID side effects: sizings FIXED, alignments MIN, 2 × 2 tracks through the existing grid track command.
4. HUG on a grid converts FLEX tracks to HUG.

Tests go in `plugins.wasm.test.ts` and `agentsTools.wasm.test.ts`: each rule, and a round trip of SPACE_BETWEEN through kiwi as `SPACE_EVENLY`. There are no engine or schema changes. Run the live probes of §5 (1–5) when the plan allows, to confirm the visual results.

### 2.2 Blur kernel — **different**, high
**Figma.** The single-axis blur pass (wasm str 11321) samples up to 64 taps along `blurDelta`, weighted `count − k` (a tent). Taps outside `blurClamp` in node space get zero weight, and pairs are merged into one bilinear fetch when `|blurDelta·64| < 1/256`. Blurs run as DOWNSCALE_AND_BLUR_TILE → blur → UPSCALE_TILE. Rounded rectangles have analytic ROUNDED_RECTANGLE_BLUR and ROUNDED_RECTANGLE_INNER_SHADOW shaders.
**Wecra / Build.** Already analysed and planned in [`effects.md`](effects.md) §2.1–2.4 (Gaussian σ = R/2 → tent of half-width R; the analytic shadow's erf → triangle CDF). The one point new here is `blurClamp`: taps outside the node's clamp rectangle get zero weight. Add it to the same change (uniform: the clamp rectangle in node space, and `q == clamp(q, …)` as the weight gate), because it decides what a background blur reads at a node's edge (effects.md §2.12).

### 2.3 Layout enforcement after undo / redo / remote changes — **different**, high
**Figma.** Invariant enforcers keep layout correct. They run on local edits, on remote changes (the `-remote` variants) and after undo / redo:
- `StackingInvariantEnforcer` (`enforce-stack-layout-invariants`, with a LOG_ONLY mode);
- `GroupsAndStacksObserver` (`enforce-groups-and-stacks-layout` / `-remote` / `-fixed`);
- `AspectRatioLockInvariantEnforcer`, `FixedChildrenOrderEnforcer`, `layout-invalidator`, `layout-dirty-text(-remote)`, `grid-reflow-invariant-effect`.

After an undo or redo, the touched fields are marked dirty so stack layout enforcement runs again. The restored sizes are not trusted (wasm strings 15601, 24955, 27594).

**Wecra.** `Editor::flushLayout` runs `Layout::run` only when the open transaction is USER or GESTURE (`Editor.cpp:400–405`). Otherwise it clears `layoutDirty_`, and `commit()` clears it again (`Editor.cpp:469`). Undo, redo, REMOTE and SYSTEM transactions only re-derive instances (`Editor.cpp:440`). An undo therefore restores the stored sizes as they were. That is right when nothing else moved. It is wrong when another actor (agent) or a remote session changed a sibling, a text or a font in between: the auto-layout frame keeps its old size around changed content. `engine.md` §9.3 step 3 claims stages 1–5 run, which does not match the code.

**Build.**
1. In `flushLayout`, run layout for UNDO, REDO and REMOTE transactions too. Mark a layout root dirty for every node whose layout inputs the replayed changes touched. `noteChange` already marks `layoutDirty_` and it is only discarded, so this is mostly removing the `else` branch.
2. Enforcement writes in an UNDO / REDO transaction join that transaction (they land in the redo batch's inverse). In a REMOTE transaction they are system writes that are not emitted, and each peer derives the same result, following Figma's "`-remote`" enforcers.
3. Group bounds (`removeEmptyGroups`, group fit) also run on remote changes.

Native tests: undo of a resize after an agent actor changed a child's text keeps the hug correct; a REMOTE change to a child's size reflows its parent with no emitted message; undo then redo is byte-identical when nothing else changed. NODE_CHANGES: undo messages may now carry extra system-written layout fields, as Figma's do. Fix engine.md §9.3.

### 2.4 Undo: skippable batches, dangling filter, page ids, scopes — **partial**, high
**Figma.** `FGUndoRedo` keeps four stacks: `_undoHistory`, `_untaintedUndoHistory`, `_redoHistory` and `_untaintedRedoHistory`. One ⌘Z skips batches that would have no visible effect ("%d batch(es) would be skipped before applying one"), so a press always undoes something visible. A batch that points at deleted nodes is filtered ("undo batch cleared by dangling-reference filtering"). Each batch records `undoBatchPageIds`. Undo is blocked in read-only mode, in playground mode and while the IMAGE_LASSO and RECOLOR tools are active. `openIgnoreUndoRedoScope` / `closeIgnoreUndoRedoScope` keep changes out of history. In the Plugin API, `commitUndo` runs the fullscreen action "commit" and `triggerUndo` runs "undo" (wasm strings 12172–12180, 41740–41746, 23980–23982; `3187.min.js`). The tainted / untainted split is *medium*: the names show two histories, but the rule that taints a batch is stripped.

**Wecra.**
- One `UndoStack` per actor (`Undo.h`; engine.md §9.5). When another actor commits, the fields it wrote leave this history (`UndoStack::yield`, `Undo.cpp:120–143`), and steps left empty are dropped when they come up (`dropEmpty`, `:145–148`; `Editor.cpp:1502`). That is Figma's last-writer-wins plus a narrow form of "skip what would do nothing".
- Batches carry selection before and after, and no page id (`Undo.h:22–27`). The page follows the restored selection (`Editor.cpp:1513`).
- Plugin runs join one step, and `commitUndo` splits it (`plugins/host.ts:4`; `plugins.wasm.test.ts:189`).
- Nothing skips a batch whose replay changes nothing visible, for example a batch that only touched a hidden layer's fields, or a layer on a page that has since been deleted.
- There is no ignore-undo scope, and no dangling-reference filter: a CHANGED inverse for a node that is gone is applied and silently does nothing.

**Build.**
1. Add `UndoBatch::pageIds`. On undo, switch to the first page among them when the selection is empty.
2. Skip batches with no visible effect: before applying a batch, drop CHANGED inverses whose node is gone (the dangling filter). If what is left changes nothing visible, apply it and continue with the next batch in the same ⌘Z, up to the stack's end. "Nothing visible" means every touched node is hidden, on no page, or only got equal values. Label the step with the batch that did something.
3. An `Editor::ignoreUndo` scope (open / close) for system bookkeeping that must not become a step. The scope is the internal mechanism; plugins keep `commitUndo` / `triggerUndo`.
4. Refuse undo while the tools that Figma blocks are active, once Wecra has them (Draw's lasso).

Native tests in `undo.test.cpp`: a batch on a since-deleted node is skipped; a hidden-only batch is skipped and the next one applied; the page is restored from `pageIds`. Leave the untainted histories until the rule is known (probe §5 #6).

### 2.5 Image downscale rules — **partial**, high
**Figma.** `decodeAsync(bytes, mime, maxW, maxH, allowBitmap, clampToMaxTexture, useWorker)` (`2622.min.js @854472`):
- If the bitmap fits maxW × maxH (0 = no limit), it passes through unchanged; `isRotated` is true for JPEG.
- Otherwise it is drawn scaled to fit into a 2-D canvas (aspect kept, `Math.round`, at least 1 px) and returned as RGBA.
- `clampToMaxTexture` makes the limits min(requested, maxTextureSize).
- **Exception:** an image over the box whose area is below half the box's area (`e*t<r*n*.5`) is not downscaled. A 6000 × 1000 image under a 4096 limit stays 6000 × 1000.
- Thumbnail mips halve with `floor((x+1)/2)` until the longer side is ≤ 512, giving `{w, h, mipsToDrop}`.

**Wecra.**
- `MAX_IMAGE_SIZE = 4096` (`editor/images.ts:46`). An import over it on either side is re-encoded at the fitted size (`:245–247`, `fitImageSize` `:77`), so the area exception is missing. A long strip such as a panorama or a sprite sheet loses resolution that Figma keeps.
- The ≤ 512 px tier is a fitted resize (`:197`, `HIGH_RES_SIZE` `:49`), not repeated halving, so its size can differ from Figma's `imageThumbnail` by a pixel.
- There is no clamp to the GPU's `maxTextureSize`. An image wider than the device's texture limit (16384 on most Macs) can be stored when it is not downscaled.

**Build.** In `images.ts`:
- `shouldDownscale(w, h, maxW, maxH) = (w > maxW || h > maxH) && !(w*h < maxW*maxH*0.5)`;
- the limits clamped to `min(4096, engine maxTextureSize)`, from `engine_stats().gfx`;
- the tier size from repeated `floor((x+1)/2)` halving down to ≤ 512, recording `mipsToDrop`.

Keep the 4096 cap. Unit tests in `images.test.ts` (6000 × 1000 kept; 5000 × 5000 → 4096; 1500 × 1000 → 750 × 500 tier).

### 2.6 Image decode colour handling — **different**, high
**Figma.** `image_io_worker.min.js @90923`:
- **PNG:** the sRGB, gAMA, cHRM and iCCP chunks are stripped before IDAT, so the browser applies no colour management. The iCCP chunk is inflated to classify the profile.
- **JPEG:** the ICC_PROFILE APP2 segments are reassembled.
- **Profile tag:** profiles are compared with reference v2 / v4 sRGB and Display P3 profiles, giving SRGB = 0 or DISPLAY_P3 = 1 (default SRGB).
- **Decode:** `createImageBitmap(blob, {premultiplyAlpha: "none"})` (`@94029`), with the bitmap transferred back.
- **Fallbacks:** SVG never goes to the worker. A null bitmap falls back to `<img>` plus a canvas. HEIC is converted on the server. A GIF is multi-frame when a second image descriptor appears.

Pixels therefore reach the GPU unconverted and un-premultiplied, with a profile tag, and the renderer handles colour against the document's profile.

**Wecra.** `createImageBitmap(blob, {premultiplyAlpha: "premultiply", colorSpaceConversion: "default"})` (`images.ts:655`). The browser converts embedded profiles (Adobe RGB, P3) into its working space. The canvas's `unpackColorSpace` follows the document profile (engine.md §6.12). An sRGB-tagged image and a P3-tagged image with the same bytes therefore differ from Figma's rendering. Premultiplying in the browser loses precision in low-alpha pixels, which Figma's unpremultiplied upload keeps.

**Build.**
1. A small decode module `editor/imageDecode.ts`, run in a Worker. Wecra has only stubs today (`roadmap.md` notes `editor/imageTools/worker.ts`). It does Figma's chunk and segment surgery and profile classification, decodes with `premultiplyAlpha: "none"` and `colorSpaceConversion: "none"`, and transfers the bitmap with `{colorProfile}` and `isMultiFrameGIF`.
2. Engine: `engine_image_add_bitmap` takes the profile. The upload premultiplies in the shader, or at upload, from straight alpha. An image whose profile differs from the document's is converted in the shader (sRGB ↔ P3 matrix).
3. Native test with RGBA inputs (premultiply at upload equals the old path for opaque pixels). An `engine-shot` pair for a P3-tagged PNG in an sRGB document and the reverse.

*Medium* on the visible size of the difference: compare against Figma with a P3 PNG (§5 #10).

### 2.7 Lazy materialization of invisible content — **missing**, medium
**Figma.** Hidden children of instances and of derived subtrees are not materialized until something needs them. Derived flags decide when: `own-should-materialize-invisible-direct-children` / `-all-descendents`, `force-materialize-invisible-children` / `-instance-subtrees`, `culled-via-defer-invisible-children`, `can-maybe-cull-derived-subtree`, `is-visible-and-ancestors-visible`, plus `populate-cache-in-viewport` (wasm strings).
**Wecra.** Pages derive lazily, each on its first show (engine.md §3.4, `Editor::derivePage`). Within a page, every instance's whole blueprint is materialized, hidden variants' layers included (`Instances.cpp`; nothing tests `visible` before expanding). Design systems with many hidden slots, icon swaps or boolean-property layers pay for nodes that are never drawn. The owner's 121k-node file is the case (handoff "Performance").
**Build.**
1. In stage A of materialization, a sublayer whose resolved `visible` is false (after property refs and overrides) and that has no visible-forcing consumer gets a stub: its own node with no derived children, flagged `deferredInvisible`.
2. Expand the stub on demand: when it becomes visible (a property change or an override), when the Layers panel expands it, when `engine_read_nodes` or a Plugin API traversal reaches it, or when export asks for it.
3. Layout already ignores hidden children (engine.md §4.2), so a stub needs no measure.

Native tests: an instance whose hidden variant layer has 1 000 descendants materializes 1 node for it; toggling the boolean property expands it with the same GUIDs as before. Measure the owner's file in `engine-bench` (node count, load ms, heap) before and after.

### 2.8 Occlusion culling — **missing**, medium
**Figma.** The render-tree op `OCCLUSION_SCOPE` (20), together with the node queries `isAxisAlignedRectFill` and `isFirstChildSolidBackground`, skips content under an opaque axis-aligned rectangle. There is a "node occluders" debug view (`toggle-display-node-occluders`).
**Wecra.** Culling is by visual bounds against the part being drawn, plus a quarter-pixel LOD rule (`Renderer.cpp:1507–1509`). A full-bleed opaque frame background over other frames, or a card stack, draws everything under it. `analyticShadows` already knows when a node has an opaque solid fill (`Renderer.cpp:726–738`).
**Build.** In the render tree, mark an *occluder*: a visible node with a SOLID fill at alpha 1, opacity 1, NORMAL / PASS_THROUGH blend, no effects, and an axis-aligned rectangle (no radius, or radius with the inset rectangle used) in world space. While drawing a part, keep the occluders seen later in paint order that cover the part, and skip any earlier subtree whose visual bounds lie inside one of them. Frames are clipped by their own box, so a clipping frame is an occluder of its siblings below it. A backdrop-reading layer (`samplesBackdrop`) above an occluder doesn't count as hidden. Test in `render.cache.test.cpp`: a draw with an opaque frame over 1 000 rectangles issues no instances for them, and the pixels are identical. Benchmark the synthetic page with stacked cards.

### 2.9 Edit scopes and change attribution — **partial**, high
**Figma.** Every write happens inside a typed edit scope: `EditScopeType {INVALID 0, TEST_SETUP 1, USER 2, PLUGIN 3, SYSTEM 4, REST_API 5, ONBOARDING 6, AUTOSAVE 7, AI 8}`, carried in `EditScope{type 1, label 2, editorType 3}`, `EditScopeStack{stack 1}` and `EditScopeSnapshot{frames 1, nodeChangeFieldNumbers 2}`. Each NodeChange carries `EditScopeInfo editScopeInfo = 365` = `{editScopeStacks 1, snapshots 2}` (`figma-schema-106.kiwi:2683, 5384–5410`). The nesting rules come from the error strings (wasm 34597–34630):
- USER is not allowed inside PLUGIN, SYSTEM, REST_API, ONBOARDING or AI.
- PLUGIN is not allowed inside SYSTEM, REST_API or AI.
- REST_API is not allowed inside USER, PLUGIN, SYSTEM, ONBOARDING or AI.
- ONBOARDING is not allowed inside USER, PLUGIN, SYSTEM, REST_API or AI.
- AI is not allowed inside SYSTEM, REST_API or ONBOARDING.
- AUTOSAVE is not allowed inside any scope, and TEST_SETUP may only be first.
- A frame may not hold two scopes of the same type, and only the top scope can be popped.

**Wecra.**
- `TxnKind {USER, GESTURE, UNDO, REDO, SYSTEM, REMOTE, LOAD}` (`Editor.h:82`) decides undo and emission. It is not attribution.
- Actors (engine.md §9.5) attribute agent turns: `DOCUMENT_CHANGED` carries `actor`. Plugin runs are marked by `txn_.run` (`Editor.cpp:455`).
- REST API writes (Phase 7 round 5) go through the same USER path.
- `editInfo` (331) records the last edit for Dev Mode (`document.kiwi:1946`).
- Field 365 is reserved (`document.kiwi:2147` `_r365`). Nothing in the change stream says whether a change came from the user, a plugin, the REST API or an agent.

**Build.**
1. Schema: un-reserve 365 and add `EditScopeInfo editScopeInfo = 365` to NodeChange. Add the messages `EditScopeInfo`, `EditScopeSnapshot`, `EditScopeStack`, `EditScope` and the enum `EditScopeType` with Figma's names and numbers. `EditorType` is already there if Wecra's schema keeps it; otherwise add only the values used. Regenerate (`npm run engine:gen`).
2. Engine: `Editor::scopes_`, a stack pushed by `engine_edit_scope_push(type, label)` / `_pop` with Figma's nesting checks (E_INVALID with the same messages). The defaults: actor 0 in a USER transaction = USER; a plugin run = PLUGIN; an agent actor = AI; REST writes = REST_API; layout, binding and library bookkeeping = SYSTEM.
3. `ChangeSet::build` stamps each NodeChange with the stack, and with a snapshot listing the field numbers each scope frame wrote.
4. The journal and the multiplayer server store it as it is. Dev Mode's "Changed" and version history can later name the source.

NODE_CHANGES grows by a few bytes per node. Native tests: the nesting errors; a plugin run's changes carry PLUGIN, an agent turn's AI; the kiwi round trip.

### 2.10 Time-sliced edit rendering (TSMER) — **missing**, high
**Figma.** Re-rendering after an edit is spread over frames. The internal "TSMER Config" modal (`3187.min.js`) shows:
- an edit-frame budget of 0.016 s + `editFrameExtraSeconds` (range 16–500 ms);
- render-target switches per edit frame = 250 + `editFrameExtraRenderTargetSwitches` (range 250–2000);
- `maxEditTimeSeconds` (0–5 s).

The reset values are `editFrameExtraSeconds = .026` (a 42 ms budget), 0 extra switches (250 in total) and `maxEditTimeSeconds = 1`. A debug dot (`showTimeSlicingEditRenderingDot`) marks a sliced frame. The toggle `allowTimeSlicedEditRenderingOptimization` is tagged "whiteboard" (FigJam), and the flag is `tsmer_with_render_layers`.

**Wecra.** An edit redraws its damage at once: every damaged part in the same frame, or everything when there are more than 16 parts or they cover 60 % of the canvas (engine.md §6.9; `Renderer::renderCached`, `Renderer.cpp:2577`, growth `:2735`). Editing a main component used across a heavy page redraws every instance's region in one frame, however long that takes.

**Build.**
1. In `renderCached`, once the edit's parts are known, draw them in order of distance from the pointer or viewport centre until 42 ms have passed (`kEditFrameBudgetMs = 16 + 26`) or 250 layer target switches have been made (count `beginPass` calls on pooled layer targets).
2. Keep the remaining parts as pending damage. The cache still holds their old pixels, which is Figma's stale-until-refreshed look.
3. Ask for the next frame (`wantsFrameAt` = now), then draw the rest the same way.
4. After `maxEditTimeSeconds` = 1 s of continuous slicing, draw everything left in one frame.
5. A new edit adds its damage to the pending set.

`engine_stats`: `editSliced`, `editPending`. Test: `render.cache.test.cpp` with a forced 0 ms budget slices into ≥ 2 frames and ends identical to a full draw.

### 2.11 Per-frame tile budget classes — **partial**, medium
**Figma.** Tile work per frame is bounded by `frameBudget`, `tileRenderingBudget` and `renderTargetSwitchBudget`. Counters split the work into:
- mandatory tiles, which cover the screen and are always drawn;
- interruptible tiles, which refine, stop at the deadline and resume next frame;
- tiles skipped with a coarser fallback;
- tiles forced over budget because they were stale too long (`_bgtTilesOldForcedOverBudget`).

Other counters cover AA passes and a high-quality render attempt. `CanvasViewState` exposes `deferTileRefinement` and `retainViewportTiles`.

**Wecra.** Tiles are used only for zooms on slow pages:
- `rasterTiles` draws missing tiles of the zoom's level from the centre outward within 6 ms while interacting and 12 ms when idle, at least one per frame (`Renderer.h:540–560`; `Renderer.cpp:2701, 2814, 2956`).
- Coarser levels and the scaled cache stand in.
- There is no "mandatory" class: a part of the screen with no stand-in at all stays empty until its tile comes up.
- There is no forced refresh of old stand-ins and no render-target switch budget.

**Build.** In `rasterTiles`: a first pass over the tiles that have no coverage at any level, drawn whatever the budget (mandatory); then refinement within the budget (interruptible); and a forced redraw of any shown stand-in older than N frames. N = 30 is unverified: Figma's value is stripped, so measure the look. Count layer target switches against 250 as in §2.10. Stats: `tilesMandatory`, `tilesInterruptible`, `tilesForcedOld`. Test: a zoom-out frame never shows an uncovered tile.

### 2.12 Tile renderer form — **different**, medium
**Figma.** `TileTreeRenderer`, `TileGridRenderer` and `HybridTileRenderer` (plus `RTSimpleRenderer`) can switch at run time (`onTileRendererChanged`). The tile tree's statistics (`minTileSharpness`, `numSmallestTilesOutdated`, `numSmallestTilesDefinitelyCovered`) read as a resolution quadtree: coarser tiles stand in until tiles at the target resolution cover the view. Tiles come in small and large sizes depending on the screen, and live in `TileAtlas` textures that grow on demand.
**Wecra.** A canvas-sized content cache for rest, pans and edits. 256² zoom tiles at power-of-two levels exist in 2048² atlases within 128 MB, used only on slow pages during continuous zooms (engine.md §6.9 rounds 3–4). Round 4 recorded why the cache stays the default: its pixels equal a direct draw, and every heavy page drew whole in under 6 ms.
**Build.** Nothing now. The atlas tiles already are a two-level pyramid. Revisit when §2.19 (render worker) or a benchmark shows rest-time rasters over budget. Then make the existing levels a quadtree keyed by (level, tx, ty), with "definitely covered" bookkeeping, and choose small (256) or large (512) tiles by the viewport's device size.

### 2.13 Mouse wheel classification and normalisation — **partial**, high
**Figma.** `figma_app.min.js @2139228`:
- **Listener.** On `document`, `passive: false`, with `preventDefault` when ctrl or meta is held. Deltas are negated. Off the Mac, Shift swaps the axes.
- **Trackpad vs mouse.** An iPad always counts as a trackpad. Chrome and Safari count a trackpad only when both deltas are integers (a Mac mouse wheel gives fractional deltas). Firefox counts a trackpad when the deltas are integers and `dy % 16 != 0`, or when any horizontal delta is present.
- **Platform fixes.** Chrome < 118 divides the deltas by the device pixel ratio. ChromeOS with ctrl and `wheelDeltaY % 120 == 0` multiplies dy by 5.
- **Windows notch wheels** (|d| ≥ 99): d/120 × an acceleration factor of 8, or 2.5 × the previous factor when the last event came under 50 ms ago with the same signs. The vector is clamped to length 120 (40 with ctrl).
- **Output.** `MOUSE_WHEEL(…, dx, dy, 0, TRACKPAD|MOUSE, …)`. A touch pinch sends `MOUSE_SCALE` with `log(ratio)/log(pinchToZoomExponent())`.

**Wecra.** The listener is on the canvas (`CanvasController.ts:81`), and the deltas go to the engine as they are, with `deltaMode` and a pinch flag (`:284–288`). The engine pans by whole device pixels or zooms by `exp(∓dy·0.01)` (0.05 for line deltas) (`Gestures.cpp:874–899`). Shift turns a vertical wheel into horizontal on every platform (`:889`). Nothing classifies trackpad vs mouse. A Mac mouse wheel's fractional deltas pan exactly like a trackpad, and there is no notch normalisation for Windows mice.

**Build.**
1. `CanvasController` classifies the source with Figma's Chrome rule (both deltas integers → trackpad; Electron is Chrome ≥ 118, so no DPR division).
2. Normalise Windows notches with the acceleration and the 120 / 40 clamp. Swap the axes for Shift off the Mac only, which means changing the engine's rule to take a platform flag.
3. Pass `source` in `WheelFlags` (`WHEEL_TRACKPAD = 2`, `WHEEL_MOUSE = 4`).
4. Engine: whether Figma zooms or pans differently per source is stripped. Pass the source through and change nothing until probe §5 #11 says otherwise.

Tests in `CanvasController` unit tests for the classifier and the Windows clamp.

### 2.14 Input: click count, coalescing, drag replay, touch — **partial**, high
**Figma.**
- **Event types.** TEXT 0 … APP_FOCUS_LOST 22, including MOUSE_MOVE_COALESCED 17 and MOUSE_DRAG_COALESCED 18.
- **Coalescing.** Pointer events are captured on `document` and forwarded at once. Coalescing happens in C++ (`fullscreen_coalesce_mouse_moves`, `handleMouseMoveCoalesced`). After a scene change the drag is replayed, and redundant replays are elided (`fullscreen_elide_redundant_drag_replays`).
- **Click count** (`@2162984`): a press within 500 ms of the last one and less than 4 px from it **on each axis** (pageX / pageY). Simulated touch uses 10 px.
- **Modifiers.** alt 256, meta 512, shift 1024, ctrl 2048, right-alt 4096; on Windows AltGr counts as alt + ctrl.

**Wecra.**
- The click count uses Euclidean ≤ 4 px, the same button, and 500 ms (`CanvasController.ts:164–175`). That is a rounder region than Figma's box.
- Every `pointermove` goes to the engine and is handled at once (`:276`). There is no coalescing, so a fast drag on a heavy page runs the gesture (and its layout flush) once per event.
- After the content under a drag changes (an auto-layout reflow), the drag is not replayed at the same pointer.
- There is no touch pinch (`MOUSE_SCALE`), and no app focus events beyond blur cancelling a gesture.
- The modifier bit values are internal (`Editor.h:63`), so they need no change.

**Build.**
1. Click count: `|dx| < 4 && |dy| < 4` (strict, per axis).
2. Coalescing in the engine: `pointerMove` stores the latest position, and `engine_tick` handles one move per frame during a gesture (hover stays immediate). Figma's flag shows coalescing is optional, so keep a switch.
3. After a layout flush that moved the dragged node's surroundings, re-run the last move once (drag replay). Skip it when nothing changed (elision).
4. Touch pinch through PointerEvents (two touches → a scale) into `wheel(…, WHEEL_PINCH)` with `log(ratio)/log(base)`.

Native tests in `editor.gestures.test.cpp`: 10 moves in one tick give the same end state as one; a reflow mid-drag replays once.

### 2.15 WebGPU compatibility tests and sync readback — **partial**, high
**Figma.** Three tests run in parallel (`3187.min.js @9940243`):
1. Compile the composite-tile pipeline asynchronously, from the wasm's own WGSL.
2. Compile the bicubic image sampler pipeline.
3. Render to a 4 × 4 WebGPU OffscreenCanvas (clear green, red quad from −0.5 to 0.5), copy it out with `bytesPerRow 256` and `mapAsync`, and check that byte 520 is red and byte 0 is green, in either BGRA or RGBA order.

Each test pushes error scopes for internal, validation and out-of-memory errors. Sync readback copies into a WebGPU OffscreenCanvas, then does `texImage2D` + `readPixels` on a hidden WebGL context (high-performance, then default). For vendor / architecture pairs listed in a dynamic config, it uses two 2-D canvases instead (RGB from an `alpha:false` context, A from an alpha context).

**Wecra.** After start, one composite at opacity 0.5 into a 4 × 4 target, checked with `mapAsync` without waiting. A mismatch or device loss falls back to WebGL2 (engine.md §6.1 "As built (E9)"; `Engine.ts:297`). The adapter blocklist exists but is empty (`gfx.ts:72–92`). Readback goes through an OffscreenCanvas and a 2-D canvas (`library_engine_wgpu.js`). There are no error scopes and no asynchronous pipeline-compile tests.

**Build.** Add the two compile tests (the Composite and Draw pipelines' WGSL through `createRenderPipelineAsync`) and the basic-render test to the start-up self test, each in `pushErrorScope` × 3, all in parallel. Any failure goes through the existing fallback. Readback: try the 2-D path first, as today, and keep the WebGL `texImage2D` path for when 2-D readback returns zeros. Unit test with a mocked `GPUDevice`.

### 2.16 NodePacker and EncodedOffsetsIndex — **missing**, medium
**Figma.** To save memory, a subtree can be kept as its encoded kiwi NodeChange bytes ("Subtree packed to reduce memory usage", `isPackedSubtreeRoot`) and decoded on demand ("NodePacker: Reading children of packed subtree", `unpack-subtree`). `Message.encodedOffsetsIndex = 34` = `{nodeChangesFieldOffset 1, nodeChangesFieldLength 2, blobsFieldOffset 3, nodeChangeOffsets 4: GUIDAndEncodedOffset[]{guid 1, offset 2}}` (`figma-schema-106.kiwi:4536–4545`). It lets one node be decoded without decoding the whole Message. There is a preference `disableNodePacker`.
**Wecra.** Per-page derivation (engine.md §3.4) keeps unshown pages un-derived. Their nodes are still fully decoded at load (101k nodes at load for the owner's file). Field 34 is reserved (`document.kiwi:127` `_r34`).
**Build.** Two steps.
1. **Index.** Un-reserve 34 and add `EncodedOffsetsIndex` and `GUIDAndEncodedOffset` with Figma's numbers. The encoder writes the index into snapshots. `engine_load` decodes each page's top-level node changes and keeps the rest of an unshown page as byte ranges, decoding them on that page's first show (`derivePage`).
2. **Packer.** On a shown page, a subtree that is off screen and not edited for N minutes is re-encoded into a byte range and its nodes freed. It is unpacked when a read, a draw or a hit-test reaches it.

Step 1 is L and pays at load. Step 2 is L and needs every node lookup to tolerate a packed root, so do it only if memory requires. Native tests: load with the index decodes only the opened page; a read of a node on another page unpacks it and gives the same fields as a full decode.

### 2.17 Volatile property bindings — **missing**, medium
**Figma.** The render tree has 27 ops (METADATA 0 … SPATIAL_COMPOSITION 26; `3187.min.js @9916928`). `VOLATILE_PROPERTY_BINDING` (15) and `VOLATILE_RENDER_EFFECT` (16) bind a subtree's transform, opacity or effect late, so the subtree is rasterized once and only re-composited while that value changes (animation, smart animate, motion). The volatile properties are INVERSE_TRANSFORM, TRANSFORM_ISOLATION, TRANSFORM, MAX_TRANSFORM_SCALE, OPACITY, STATE_SWAP and EFFECT. The content mode is DISABLE_ALL / DEFAULT / INCLUDE_VOLATILE_CONTENT.
**Wecra.** The presentation view redraws every item's subtree each frame with props overrides (`render/PresentScene.h`, `proto/Player.cpp`). A Smart animate of a heavy card re-rasterizes its text and effects at every step. The canvas has no animation yet (Figma Motion is in `docs/motion.md`).
**Build.** In `Renderer::renderScene`: an item whose overrides change only `transform` (translation or scale ≤ `MAX_TRANSFORM_SCALE`) and `opacity` during a transition is drawn once into a layer at its largest scale in the transition, then composited each frame with the animated matrix and opacity. Effects stay in the layer unless an effect is itself animated. Generalise later for Motion (`docs/motion.md`). Test: a 300 ms transition of a 500-node card renders its subtree once (count `drawNode` calls) and matches the direct draw within 1/255 at rest.

### 2.18 Undo history persisted — **missing**, high
**Figma.** `Message.localUndoStack = 22` and `localRedoStack = 23` are `Message[]`: each batch is a NodeChanges Message. They are carried in a saved / autosaved Message, so a reopened file can still undo.
**Wecra.** History lives only in memory (`UndoStack`, `Undo.h`). Fields 22 and 23 are reserved (`document.kiwi:125` `_r22`, `_r23`). Closing a tab loses the history, which Figma's local autosave keeps.
**Build.** Un-reserve 22 and 23. At the tab's flush (`persistence.ts` "flush"), encode actor 0's undo and redo batches as NODE_CHANGES Messages, capped (the last 100 steps or 16 MB), into a per-file UI-state blob in the store. Do not put them in the snapshot, because history is per device. Restore them after `engine_load` when the journal head matches the recorded sequence; otherwise drop them. Needs `engine_undo_export` / `engine_undo_import`. Native test: export, then import into a fresh editor with the same document, gives identical undo results.

### 2.19 Threaded rendering — **missing**, high
**Figma.** With threaded rendering on, a second build of the C++ renderer runs in a Web Worker on an OffscreenCanvas and draws the editor canvas. The main-thread wasm keeps the scene graph, layout, materialization and render-tree generation, encodes a render-tree "forest" and the overlay UI commands, and sends them to the worker. The gate is cached once per session: `Worker && OffscreenCanvas && transferControlToOffscreen && renderWorkerURL && compiled_wasm.{js,wasm}` URLs and the feature gate `fullscreen_use_threaded_rendering` (`3187.min.js @2859105`). A second role, `render-worker-export`, handles exports (`fullscreen_use_threaded_exporter`). The RPC is JSON-RPC over MessageChannel ports. The lifecycle states are spawned, initialized, started and exporting.

The worker runs its own loop: `requestAnimationFrame` → `drainAndRender`. `useInteractiveRenderer` is reset after each drain, and `canvasRenderNeedsMoreFrames()` keeps the loop going. Frame submits are coalesced. On device loss or a WebGPU failure the worker asks to be restarted (`requestWebGLFallbackRestart`, `requestRestartAfterDeviceRestore`) (`render_worker.min.js @490176`).

**Wecra.** One wasm module on the editor view's main thread renders into the canvas (`Engine.ts:624–636`; engine.md §6.12). React, the engine's derivation and the GPU command encoding share that thread. Each file is already its own renderer process (architecture.md), so one heavy file cannot stall another. Within a file, a long raster blocks panel input.

**Build** (behind a setting, default off, after §2.10 and §2.11, which remove most long frames):
1. A second Emscripten target `engine-render` with only `render/`, `gfx/`, `text/` (glyph outlines) and a decoder for the scene packets.
2. A packet format: the render tree's flat array (`RenderTree.h:27–38`) with each node's drawn props encoded (paints, effects, geometry ids, path and glyph curve blobs by hash), sent as kiwi chunks (§2.20).
3. The worker owns the canvas (`transferControlToOffscreen`), the content cache and tiles, and runs its own rAF. Overlays go as a command list each frame.
4. Main keeps hit-testing and gestures.
5. The gfx fallback moves into the worker, which asks main to restart it on WebGL2.

Native tests for the packet codec (encode → decode → `RenderTree::consistent`). `engine:shot --threaded` must match the single-thread shots. Electron 44 has OffscreenCanvas with WebGPU and WebGL2 in workers.

### 2.20 Canvas frame transport — **missing** (part of §2.19), high
**Figma.**
- **Sending.** Each frame the main thread sends `{frame, imageUpdates, videoUpdates, emojiUpdates}`, transferring ImageBitmaps and VideoFrames.
- **Admission.** The worker checks `canEnqueueCanvasScenePacket(transportRevision, sceneGeneration, updateKind)` with `updateKind` COMMIT = 0, CHUNK = 1 or ABORT = 2, so a scene is sent in chunks and closed by a COMMIT. On failure it closes the media and replies `frameApplied:false`. Otherwise it installs the media and enqueues the frame. It keeps a persistent shadow of the forest, updated incrementally.
- **Replies.** Five counters: `lastAppliedTransportRevision`, `lastUICommandsDecodedSceneGeneration`, `lastCommittedSceneGeneration`, `lastPresentedSceneGeneration` and `lastConvergedSceneGeneration`.
- **Recovery.** A transport failure bumps `_canvasFrameRecoveryEpoch` and calls `requestFullFrameAfterTransportFailure()`, so the next frame is a full frame. Main tracks which image hashes are resident in the worker and publishes each image once.
- **Frame fields:** `canvasToPixels`, `viewSpaceTilePixelSize`, `devicePixelRatio`, `backgroundColor`, `pageColor`, `pixelGrid`, `frameBudget`, `allowDeferredRendering`, `useInteractiveRenderer`, `useBicubicSampler`, …

**Build.** With §2.19: packets are deltas of the render tree keyed by the `Document::version()` log that `RenderTree::sync` already reads (structural changes re-place a subtree; others re-send one node's props). Use the same COMMIT / CHUNK / ABORT kinds, the generation counters and full-frame recovery. Images: the registry's hashes, transferred once (`ImageRegistry::changedSince` already tracks arrivals). Codec tests: random edit sequences, then a chunked transfer with injected drops and recovery, give a shadow tree equal to a fresh build.

### 2.21 Render worker export memory budgets — **missing**, high
**Figma.** Worker exports are admitted against memory budgets (`figma_app.min.js @2309254`): an image decode budget of 32 MB (capped by `transactionBudgetBytes` minus the bytes in use), a decode concurrency of 2 (clamped to 1–8) and an image resource cache of 64 MB, all overridable by `render_worker_export_memory_config`. Exports stream the render tree with `begin` / `append` / `finish` / `abortIncrementalExportViaRenderWorker`.
**Wecra.** Exports render offscreen on the main engine (`engine/src/export/`, `editor/exportCore.ts`). There is no decode budget or concurrency limit: an export of many image-heavy frames asks for every image it needs.
**Build.** In `exportCore.ts`: a queue of image decodes for the export with at most 2 in flight and at most 32 MB of decoded bitmaps held, released after each frame's render, plus a 64 MB LRU of decoded export images. This is independent of §2.19. Unit test with fake decoders: peak bytes ≤ budget.

### 2.22 Hit-testing spatial index — **different**, medium
**Figma.** A derived, cached kd-tree of each container's children (`cached-children-spatial-tree`, plus a contiguous-storage variant), held as an `Immutable<ChildrenSpatialIndex>` snapshot and invalidated per container. Click selection and hover use it (`click_selection_kd_tree`), and hover exits early (`hover_hit_test_early_exit`).
**Wecra.** One dynamic AABB tree per page, holding every rendered node with fat boxes and incremental moves (`hit/SpatialIndex.h:1–4`). Picking walks candidates in reverse paint order (engine.md §8.2).
**Build.** Not needed for correctness. If hover gets slow on deep pages, add a per-container index built lazily for containers with more than 64 children and dropped on a structural change to them, and walk containers top-down (early exit at the first opaque hit in paint order). Keep the page tree for the marquee and snapping. Benchmark first (`engine-bench` hover over 20k nodes).

### 2.23 Immutable copy-on-write field values — **partial**, medium
**Figma.** About 80 `Immutable<T>` types (`Immutable<PaintData>`, `Immutable<EffectData>`, `Immutable<LayoutGridData>`, `Immutable<ChildrenSpatialIndex>` …): snapshots, undo and derived caches share compound values without copying.
**Wecra.** Blobs are shared immutable bytes (`scene/Node.h:557–558`). Paints, effects and the other compound fields are held by value (`Node.h:1107–1125`), so each instance sublayer, undo inverse and props override copies them.
**Build.** Make `fillPaints`, `strokePaints`, `effects`, `layoutGrids` and the other vector fields `Cow<std::vector<T>>`: a shared_ptr to const with copy on write in the setters. This touches the generated accessors (`engine/tools/schemagen`). Measure the heap on the owner's file. Do it only if §2.7 leaves memory high.

### 2.24 Task scheduling and invalidation batching — **partial**, high
**Figma.** C++ posts deferred work through `scheduler.postTask(cb, {priority: 'user-blocking' | 'user-visible' | 'background', signal, delay})`, which can be cancelled through a TaskController (`3187.min.js @2341827`). Frames are requested on demand. Bulk writes are wrapped in `openDeferDependencyBusTraversalToFlushScope` / close, so propagation runs once. Async updaters are flushed until empty, with a cycle guard.
**Wecra.** Frames are requested on demand with `nextFrameDelay` (`Engine.ts:624–636`). The pipeline runs once per transaction commit, which is the deferred traversal (engine.md §3.3; `Editor::flushLayout` loops instances, bindings and layout until stable, `Editor.cpp:393–415`). TS uses `requestIdleCallback` for thumbnails, search and images (`persistence.ts:226, 351`; `images.ts:707`). The engine cannot schedule its own background work: deferred page derivation and image batching depend on frames.
**Build.** An `engine_post_task` import backed by `scheduler.postTask` (with a `setTimeout` fallback) with three priorities. Use it for background derivation of the next page in the Pages list and for re-rasterizing tiles at idle. A max-iteration guard on the `flushLayout` loop (log and stop after 64 rounds; Figma's "updater cycle" message). Native test of the guard.

### 2.25 Autosave journal backpressure — **partial**, high
**Figma.** C++ hands encoded changes to JS through `enqueueAutosaveCommit({changes, commitPolicy, fileVersion, fileKey, newSessionID, uncleanRegisters, reason})`. JS commits them to IndexedDB in a serial transaction queue under a Web Lock per session. `readyToAcceptChanges()` is false while restoring or when 10 or more transactions are queued, and C++ checks it before enqueueing. A file-key mismatch ends the session (`figma_app.min.js @1861750`).
**Wecra.** `DOCUMENT_CHANGED` bytes go to the store over the MessagePort and are appended to the open journal segment, with fsyncs on a tick (`src/store/local/fileStore.ts:177`). There is no backpressure: a long burst of changes (an agent writing thousands of nodes) queues messages without bound in the view and the store.
**Build.** The store acknowledges each frame's append. The view keeps a count of unacknowledged appends; at 10 or more, it coalesces the next `DOCUMENT_CHANGED` messages into one kiwi Message (concatenated nodeChanges) until the count drops. That is Figma's back-off in Wecra's shape. Test in `rpc.test.ts` with a slow fake store.

### 2.26 Line breaking — **done** (different place), high
**Figma.** The C++ text layout asks JS for every break opportunity (`JSTextLayout_getAllLineBreakPositions(string) → number[]`). The JS side is a UAX #14 breaker; its state names (LB8a, LB21a, LB30a) match the `linebreak` npm package. HarfBuzz shaping and ICU bidi stay in wasm.
**Wecra.** libunibreak (Unicode 17) inside the engine (`text/Unicode.cpp:105` `set_linebreaks_utf16`; engine.md §7.4). Same standard, no boundary crossing.
**Build.** Nothing, except a parity check when probe §5 #9 can run: Turkish, CJK, emoji + ZWJ, URL-like and number strings, Figma's breaks vs ours. The `linebreak` package may implement an older UAX #14 revision than libunibreak 17, so edge cases (LB30a regional indicators, LB21a Hebrew + hyphen) may differ. Add any mismatch as a `text.parity.test.cpp` case.

### 2.27 Render worker frame loop — **done** (on the main thread)
Figma's worker loop (rAF → drain, `canvasRenderNeedsMoreFrames`, coalesced submits, device-loss restart) corresponds to Wecra's loop: render on demand, `wantsFrameAt` / `nextFrameDelay` for settle frames, tile refinement and image batches, and the WebGPU → WebGL2 fallback (`Engine.ts:624–636`, `Renderer.h:534`, engine.md §6.1, §6.12). It moves into the worker with §2.19.

### 2.28 NODE_CHANGES / JS boundary — **done** (TS owns the socket, by contract)
**Figma.** C++ encodes the multiplayer Messages and drives the WebSocket through `FullscreenWebSocketTsCallbacks` connect / send / disconnect / bufferedAmount; JS only carries bytes. Panels never decode NODE_CHANGES. They re-read through the generated facet bindings when `SceneGraphHookBindings_triggerChange()` fires, and cache by `getRevisionNumber()`.
**Wecra.** The engine encodes and decodes the kiwi Messages (engine.md §10). The socket lives in TS and the store (`docs/multiplayer.md`), which is a deliberate contract choice. Panels read through the generated facets (`engine/facets.generated.ts`) and a per-node version cache (`EngineStore.ts:36–141`), which is finer than Figma's single revision number. No work.

### 2.29 Path and glyph rasterization — **different** (keep)
**Figma.** Stencil-then-cover with Loop-Blinn cubic coordinates: the stencil fragment discards when `k³ > l·m`, and a cover pass paints. There are 16-bit and 32-bit index glyph shaders and cached glyph outlines. A "geopipe" stage declines to rasterize groups for connectors, complex caps, empty geometry and so on. Tessellation is cached by path hash (wasm 10985–10987).
**Wecra.** Analytic curve coverage (Lengyel, quadratics in an RGBA32F texture, +x / +y rays) for paths and glyphs, with no MSAA (engine.md §6.3, §7.5), and `CurveCache` by path. The visible result (crisp, exactly anti-aliased edges at every zoom) matches or beats binary stencil plus progressive AA. Keep it. engine.md §6.3 already records the decision.

### 2.30 Progressive anti-aliasing — **different** (keep)
**Figma.** Coverage is binary per pass. AA builds up per tile over extra passes (`aaPassesCompleted`, `passCountRequested`, `nextPassIndexRequested`, `maxAAPassCount`; assertion `oldTile->aaPassesCompleted() == sorted.request.nextPassIndexRequested()`), and supersampled tiles and a `SUPERSAMPLE_GROUP` op exist. While tiles refine, Figma shows aliased edges for a few frames.
**Wecra.** AA is analytic in one pass. Nothing to build. Figma's intermediate aliased frames are not worth copying.

### 2.31 Mouse behaviour chain — **different** (keep)
**Figma.** About 180 `*Behavior` objects (MoveSelectionBehavior, ResizeSelectionBehavior, MarqueeBehavior, HoverBehavior …), each getting handleMouseDown / Drag / Move / Up / Leave / BeforeFrame / ContextMenuOpen and render calls. The first one to `accept(name)` claims the event, and TypeScript can insert behaviours (`TSMouseBehavior_*`).
**Wecra.** One gesture state machine in C++ (`tools/Gestures.cpp`, `Gesture` enum), with the tools in `CanvasTools.cpp` and `DrawTools.cpp`. The result is the same, and the user sees no difference. Plugins in Figma cannot add behaviours either (`TSMouseBehavior` is Figma's own TS). Keep. Revisit only if a feature needs TS-defined canvas interactions.

### 2.32 ImmutableFrameObserver — **n/a**
FigJam immutable frames (SHAPE_WITH_TEXT, STICKY, CODE_BLOCK, TABLE generated sublayers; `NodeChange.derivedImmutableFrameData = 254`, `derivedImmutableFrameDataVersion = 338`, action `REFLOW_IMMUTABLE_FRAMES`). This is not design reflow. FigJam is set aside (Phase 7 scope, 2026-10-11), and fields 254 / 338 stay reserved.

---

## 3. Integration plan (ordered)

Each step is one branch with its tests. Steps 1–8 are correctness and fidelity; 9–17 performance and robustness; 18–20 the worker.

1. **Plugin API layout rules** (§2.1, S). `nodeSpec.ts` + `layerProps.ts`: the Figma ↔ kiwi alignment map, the validation rules, the GRID side effects, HUG on a grid → FLEX to HUG. Tests: `plugins.wasm.test.ts`, `agentsTools.wasm.test.ts`.
2. **Blur kernel + `blurClamp`** (§2.2, M). With effects.md steps 2.1–2.4 (one change to `gfx/gl/Shaders.h`, `gfx/wgpu/Shaders.h` and `Renderer.cpp`).
3. **Layout after undo / redo / remote** (§2.3, M). `Editor::flushLayout` runs for UNDO, REDO and REMOTE; group fit on remote. Tests: `undo.test.cpp`, `r17.actors.test.cpp`. Fix engine.md §3.3 / §9.3.
4. **Undo skip and dangling filter, page ids** (§2.4, M). `Undo.h` / `Undo.cpp` / `Editor::undoStep`; `Editor::ignoreUndo` scope. Tests in `undo.test.cpp`. Update engine.md §9.1 / §9.3.
5. **Image downscale rules** (§2.5, S). `images.ts`. Tests in `images.test.ts`.
6. **Image colour handling** (§2.6, M). `editor/imageDecode.ts` in a Worker (chunk / segment surgery, profile tag, straight alpha); `engine_image_add_bitmap` + profile; premultiply and convert at upload or in the shader. Tests: a unit test of the profile classifier; `engine:shot` P3 / sRGB pairs. Update engine.md §6.6.
7. **Edit scopes** (§2.9, M). Schema: `NodeChange.editScopeInfo = 365` + `EditScopeInfo`, `EditScopeSnapshot`, `EditScopeStack`, `EditScope`, `EditScopeType` (un-reserve 365 in `document.kiwi:2147`); `npm run engine:gen`; `Editor` scope stack with Figma's nesting errors; stamping in `ChangeSet::build`. Tests: `scene.kiwi.test.cpp`, `scene.txn.test.cpp`. docs/schema.md gets the new messages.
8. **Input fidelity** (§2.13, §2.14, S + S). Wheel source classification and Windows normalisation in `CanvasController.ts`; Shift axis swap off the Mac only; per-axis click box; touch pinch. Engine: `WHEEL_TRACKPAD` / `WHEEL_MOUSE` flags passed through.
9. **Lazy materialization of hidden instance content** (§2.7, L). `Instances.cpp` stubs + expansion on demand. Tests: `components.test.cpp`; measure the owner's file with `engine-bench`.
10. **Occlusion culling** (§2.8, M). Render tree occluder flag; skipping during a part's draw. `render.cache.test.cpp`; bench.
11. **Time-sliced edit rendering** (§2.10, M). `renderCached` budget of 42 ms / 250 switches / 1 s maximum; pending damage. `render.cache.test.cpp`. engine.md §6.9.
12. **Tile budget classes** (§2.11, M). Mandatory / interruptible / forced-old in `rasterTiles`; switch budget shared with step 11.
13. **Pointer move coalescing and drag replay** (§2.14, S/M). `Editor::pointerMove` latest-wins per tick during gestures; one replay after a reflow. `editor.gestures.test.cpp`.
14. **WebGPU start-up tests** (§2.15, S). The pipeline compiles and the basic render test with error scopes; the readback fallback. Unit test with a mocked device.
15. **Encoded offsets index** (§2.16 step 1, L). `Message.encodedOffsetsIndex = 34` (un-reserve `_r34`); partial decode of unshown pages. `scene.kiwi.test.cpp`; load bench.
16. **Undo persistence** (§2.18, M). `Message.localUndoStack = 22`, `localRedoStack = 23` (un-reserve); `engine_undo_export` / `engine_undo_import`; store UI-state blob. `undo.test.cpp`.
17. **Small robustness items** (S each): export decode budgets (§2.21, `exportCore.ts`); journal backpressure (§2.25, store ack + view coalescing); `engine_post_task` + the flush cycle guard (§2.24); a line-break parity table once probes run (§2.26).
18. **Volatile bindings for the presentation view** (§2.17, L). `Renderer::renderScene` caches animated subtrees as layers; generalise for Motion later.
19. **Render worker** (§2.19 + §2.20, XL + L). An `engine-render` target, the packet codec with COMMIT / CHUNK / ABORT and generations, OffscreenCanvas ownership, overlays as commands, full-frame recovery, the gfx fallback in the worker. Behind a setting; `engine:shot --threaded` parity.
20. **Optional, after measurement:** a per-container spatial index (§2.22), copy-on-write compound fields (§2.23), the tile quadtree (§2.12), the NodePacker (§2.16 step 2).

## 4. Contract changes this plan makes

- `schema/document.kiwi` / `docs/schema.md`: NodeChange 365 `editScopeInfo` and its five types (step 7); Message 34 `encodedOffsetsIndex` + `GUIDAndEncodedOffset` (step 15); Message 22 / 23 `localUndoStack` / `localRedoStack` (step 16). All Figma names and numbers, un-reserved from the `_rN` lists.
- `docs/engine.md`: §3.3 / §9.3 (layout runs after undo, redo and remote, step 3); §9.1 / §9.3 (page ids, skipped batches, ignore scope, step 4); §6.6 (decode and colour, steps 5–6); §6.9 (edit time slicing, tile classes, occlusion, steps 10–12); §8.4 (wheel sources, coalescing, click box, steps 8 and 13); §6.1 (start-up tests, step 14); §6.7 blur (with effects.md).
- `docs/data.md`: the per-file undo blob (step 16); journal acknowledgements (step 17).

## 5. Probes still to run (Figma MCP, Starter limit hit before the first call)

1. `primaryAxisAlignItems` SPACE_EVENLY / SPACE_BETWEEN / SPACE_AROUND: child positions vs CSS (§2.1).
2. `layoutMode = "GRID"` alone: sizings, alignments, track counts after (§2.1).
3. `layoutGrow = 2` and negative `itemSpacing`: accepted or thrown (§2.1).
4. The validation error texts for ABSOLUTE without a parent layout, BASELINE in VERTICAL, WRAP in NONE (§2.1).
5. `layoutSizingHorizontal = "HUG"` on a GRID with FLEX columns (§2.1).
6. One ⌘Z after a plugin step on a hidden layer: is that step skipped (§2.4)? Needs the UI.
7. After undo of a child's text change, does the hugging parent re-measure (§2.3)? Needs the UI.
8. A plugin run without `commitUndo` is one step; with it, two (Wecra already matches; confirm) (§2.4).
9. Line-break positions for a fixed set of strings (§2.26).
10. A PNG with a Display P3 iCCP in an sRGB document: the rendered pixel values (§2.6). Needs a UI iframe to decode.
11. Wheel behaviour per source: does a mouse wheel (fractional deltas on Mac) zoom or pan differently from a trackpad (§2.13)? Needs the desktop app, not the MCP.
12. `relativeTransform` on slide nodes (§2.1). Needs a Slides file; low value, since Slides is set aside.
13. Whether packed subtrees or incremental loading show through the Plugin API (§2.16). `loadAllPagesAsync` is not allowed in the MCP.
