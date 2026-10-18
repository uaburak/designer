# 04 — Canvas, viewport, selection, snapping, measurement

Figma Design desktop 126.9.13, read statically on 2026-10-16. This chapter covers canvas **interaction**. The rendering core (tiles, AA, culling, render worker, undo internals) is in [`../rea/canvas.md`](../rea/canvas.md); §1.3 summarises it.

## 1. Scope and sources

### 1.1 Sources read

| Source | What was read | How |
|---|---|---|
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (52 MB editor C++) | String table (`strings -n 6`, 104 k lines). The **keyboard shortcut table**, a 63,956-byte JSON at file offset `0x2d1017b`. The **name section** (53,192 entries; every function is `wasm-function[N]`, so names are stripped). The code section, through a small disassembler written for this round: string cross-references (`i32.const <data addr>`), float constants, and call graphs of about 40 functions | Python byte scans and `llvm-objdump` (emsdk). The wasm was not opened in an REA analysis session |
| `figma_app.min.js`, `5904.min.js` (zoom menu), `3653.min.js` (shortcuts panel), `7621.min.js` (Preferences toggles), `4752.min.js` / `7362.min.js` / `5519.min.js` (UI constants) | Wheel and touch input, zoom menu, nudge picker, Preferences toggles, the shortcuts panel's modifier entries, UI size constants | `rg -o` windows |
| `fullscreen__fullscreen-wasm__compiled_wasm.js` (glue) | Colour-token struct (`_StructParser_parseUInt(e+N)`), exports (`_Fullscreen_pinchToZoomExponent` = `zW`) | `rg -o` |
| Prior repo research | [`../rea/canvas.md`](../rea/canvas.md); `../figma/live/behaviour/{canvas,keys,resize,smart-selection,spacing-handles,autolayout-drag}.md`; `../figma/R7-editor.md`; `docs/engine.md` §8 | read |

### 1.2 Evidence notation

- `wasm fn N @0xOFF` is function index N (imports counted, 1,782 imports) in the editor wasm, at file offset `0xOFF` of the instruction.
- `JSON` is the keyboard-shortcut JSON embedded in the wasm.
- `<chunk>.min.js: "…"` is a snippet of 15 words or fewer.
- **C** = CONFIRMED (read directly). **I** = INFERRED (deduced from structure, names or neighbouring code).

### 1.3 Rendering core, in one line each (from `rea/canvas.md`)

- **Wheel input.** Classified as trackpad or mouse (Chrome: both deltas are integers → trackpad). Windows notch wheels become d/120 × 8, accelerated ×2.5 within 50 ms, and are clamped to a vector of 120, or 40 with ctrl (canvas.md §2.13).
- **Click count.** A press within 500 ms of the last one and < 4 px on each axis counts as the next click (10 px for touch). Modifier bits: alt 256, meta 512, shift 1024, ctrl 2048 (§2.14).
- **Coalescing.** Mouse moves are coalesced in C++. After a scene change the drag is replayed, and redundant replays are elided (§2.14).
- **Behaviours.** About 180 `*Behavior` objects form a mouse-behaviour chain. The first one to accept an event claims it (§2.31).
- **Hit-testing.** A per-container kd-tree (§2.22). Tile rendering, progressive AA, occlusion culling and TSMER are in §2.10–2.12 and §2.30.

---

## 2. Viewport: zoom

### 2.1 Zoom range

The clamp function is `wasm fn 6947 @0x46a586`. It switches on the editor type, a byte at `+80` of the app state. The min/max values are stored as raw doubles; the values below are decoded from their i64 bit patterns.

| Editor type (byte +80) | Min zoom | Max zoom | Evidence | |
|---|---|---|---|---|
| 0 = Design (also the fallback) | **0.015625 (1/64 = 1.5625 %)** | **256 (25,600 %)** | i64 `4580160821035794432` / `4643211215818981376` | C |
| 1 = FigJam | Computed: fit the board's content with 128 / 568 px margins, min(…, 1.0) | 256 | f64 `128.0`, `568.0` @0x46a672 / @0x46a703 | C (values) / I (meaning) |
| 2 = Slides | From the slide view (fn 10698 / 30937), else 1/32 … 16 | — | `0.03125`, `16.0` | C (values) / I (mode) |
| other cases | 1/64 … 4; or 1/64 … 256 / 16 depending on a view object at +484 | — | — | I |

Pan clamp, CONFIRMED (`wasm fn 5305 @0x2c47d9`): after each viewport move, the viewport centre is clamped to **±131,072 × zoom** (2^17 canvas units from the origin on each axis). The same function logs the analytics event `user-viewport-moved` when |dx| or |dy| > 1e-6.

### 2.2 Zoom in and zoom out steps (keyboard, menu, zoom tool)

Action dispatcher: `wasm fn 32493` (`FGCanvasView::handleAction`; its assertion strings name `FGCanvasView.cpp`). Zoom in starts @0x1f847b7. Zoom out is `wasm fn 31288 @0x1e18c8c`. Called functions: fn 5992 = `log`, fn 2933 = `pow`, fn 7577 = `pow` variant (I, from their bit-twiddling prologues).

| Editor | Zoom in | Zoom out | Evidence | |
|---|---|---|---|---|
| Design | **next power of two above z**: `2^floor(log2(2z))`. 100 % → 200 %, 150 % → 200 %, 75 % → 100 % | **previous power of two**: `2^ceil(log2(z/2))`. 100 % → 50 %, 150 % → 100 % | `f64.floor` then `pow`; `f64.const 0.6931…` (ln 2) and `f64.ceil` | C |
| FigJam | half-octave (√2) steps snapped to 2^(k/2): `2^(floor(2·log2(z·√2))/2)` | the same downwards: `2^(ceil(2·log2(z/√2))/2)` | `f64.const 1.4142135623730951` @0x1f84895, `0.5` | C |
| Slides | power of two, clamped by the zoom that fits a 1920 × 1080 slide (or the deck's custom aspect) | the same | `f32.const 1920.0` / `1080.0` @0x1f847ec, `slides_custom_aspect_ratios` | C |

- **Zoom to 100 %** (`zoomReset`): sets zoom 1.0 about the viewport centre (fn 5788 → fn 17897, centre = 0.5 × viewport w/h). C
- **Zoom menu presets** (5904.min.js): Zoom in, Zoom out, Zoom to fit, **Zoom to 50 %** (`setCanvasZoomScale(.5)`), Zoom to 100 %, **Zoom to 200 %** (`setCanvasZoomScale(2)`). The 50 / 100 / 200 entries are checked when `Math.round(100*zoom)` equals them. C
- The toolbar shows the zoom as `Math.round(100*activeCanvasCurrentZoom)` %. C
- **Keyboard zooms into selection** (pref `keyboardZoomToSelection`): keyboard zoom centres on the selection instead of the viewport. C (pref name). The centring point is I.
- No animation for these steps: the code calls set-zoom then set-centre directly, with no timer or tween. I

### 2.3 Zoom to fit, zoom to selection, zoom to rect

| Command | Rule | Evidence | |
|---|---|---|---|
| Zoom to fit (⇧1, ⇧9) | Bounds of the page's content, fitted with **25 px on each side** (zoomToBounds padding 50, halved per side) | `wasm fn 8393`: `f64.const 50.0`, then `fn 17893`, which passes `padding*0.5` four times | C |
| Zoom to fit, Sites webpage / responsive set selected (node type 55 / 39) | insets **top 74, right / bottom / left 50** | `f64.const 74.0; 50.0; 50.0; 50.0` @0x5762e5 | C |
| Zoom to selection (⇧2) | Selection bounds with **40 px on each side** (padding 80, halved) | `wasm fn 9166 @0x6418ff`: `f64.const 80.0`, flag 1 | C |
| Zoom to selection with nothing selected | Falls back to zoom to fit | fn 32493 @0x1f84dc5 (empty-selection branch → fn 8393) | C |
| Zoom to rect (shared by both) | `zoom = min((viewW − l − r)/w, (viewH − t − b)/h)`, clamped to the range in §2.1. **No 100 % cap.** Centred in the inset area; a top offset at `+472` is added (I: a top overlay). Does nothing if the insets alone exceed the viewport. An empty rect (w or h ≤ 0) zooms to 100 % centred (FigJam: one zoom-out step from 100 %). In Sites a 20 px shift is added | `wasm fn 10210 @0x74bcb7` | C |
| FigJam zoom to selection | Bounds grown by a factor of `240/h + 1.25` before fitting | fn 17893 @0xf0cbcf, guarded by fn 6948 (I: is-FigJam) | C (math) / I (mode) |

No animation was found on these paths either: zoom and centre are set directly (fn 6383 / fn 5521). Animated viewport moves exist in JS for navigation (comments, "spotlight", Dev Mode recentre), through an AbortController `navigateTo`. Its jump-on-abort test treats targets within 5 px and 0.1 zoom as "already there" (`figma_app.min.js: "5>Math.abs(n.offsetX-e.centerX)&&5>Math.abs(n.offsetY-e.centerY)&&.1>"`). C

### 2.4 Zoom by wheel, pinch and touch

| Item | Value | Evidence | |
|---|---|---|---|
| ⌘ / ctrl + wheel | Zooms; `preventDefault` when ctrl or meta is held | canvas.md §2.13 | C |
| Plain wheel | Pans. With **Use scroll wheel zoom** (pref `scrollWheelZoom`, action `toggle-use-scroll-wheel-zoom`) a mouse wheel zooms instead | prefs list; JSON | C |
| Invert zoom direction | Pref `invertZoom` (`toggle-invert-zoom`) | wasm strings, 7621.min.js | C |
| Trackpad pinch (Safari / desktop gesture) | `MOUSE_SCALE` with the scale delta since the last gesture event; `MOUSE_SCALE_END` at the end | `figma_app.min.js: "takeIndirectPinchGesture"` | C |
| Touch pinch | `MOUSE_SCALE` with **`log(distance ratio)/log(4)`**; **pinchToZoomExponent = 4.0** | export `zW` = `wasm fn 46064 @0x26c4ab5`: `f32.const 4.0` | C |
| Touch two-finger pan | The centroid's move ÷ devicePixelRatio, sent as `MOUSE_WHEEL` source TOUCH | figma_app.min.js | C |
| Zoom factor per wheel notch / per pixel of trackpad delta | **not located** (stripped) | — | Open Q1 |
| Pinch-zoom fix | Pref `disablePinchZoomFix` (debug) | strings | C |
| Hover deferral | Flag `defer_hover_during_pan_zoom`: hover updates are held during pan or zoom | strings | C (flag) / I (effect) |

**Touch pan / zoom recogniser**, iPad (`wasm fn 48776`, `FGPanZoomGestureRecognizer.cpp`). C, values @0x2983af9 … 0x2984396:
- **Becoming a pinch.** "min change for a pinch": the distance between the two touches must change by **30 px**, or **20 px** in the other branch (I: after pan has locked).
- **Continuous growth or shrinkage.** Checked over samples. "shaky enough" tests the angle between the touch velocities, and a **0.2** fluctuation ratio. A comparison of ratio **0.8** across **10** samples guards the increasing / decreasing count.
- **Becoming a pan.** "min distance for pan": the centroid moves **10 px**, or **5 px**.
- Pan can lock ("Locking pan!").

### 2.5 Zoom tool (Z), shortcuts

- `ZoomToolBehavior` exists, with cursors `zoom-in` and `zoom-out` (⌥ flips to zoom-out). C (names). Click / drag behaviour I (as in engine.md: click zooms about the point, drag zooms to the area).
- Shortcut table (JSON, Mac, US layout). C:

| Action | Keys |
|---|---|
| zoom-in | ⌘= · ⌘⇧= (shown "⌘+") · ⌘+ · ⌘ Num+ · = · ⇧= (shown "+") · Num+ · + |
| zoom-out | ⌘- · ⌘⇧- · ⌘ Num- · - · ⇧- · Num- |
| zoom-reset (100 %) | ⌘0 · ⇧0 (when *Use number keys for opacity* is on, the default) · 0 (when it is off) |
| zoom-to-fit | **⇧1 and ⇧9** (pref on) / 1 and 9 (pref off) |
| zoom-to-selection | ⇧2 (pref on) / 2 (pref off) |
| next-artboard / previous-artboard | N / ⇧N (zoom to the next / previous top-level frame) |
| next-artboard-same-zoom / previous-artboard-same-zoom | **End / Home** (pan to the next frame, zoom kept) |
| page-next / page-previous | Page Down / Page Up |

Live: N goes Parent → AL → SmallFrame at 213 %–527 %; the selection does not change (`live/behaviour/keys.md` §15–18).

---

## 3. Viewport: pan

| Item | Rule | Evidence | |
|---|---|---|---|
| Space + drag | Pans (shortcuts panel `pan: [[␣, drag]]`) | 3653.min.js | C |
| Hand tool | H (`set-tool-hand`), `HandToolBehavior`, cursors `hand-new` / `hand-press` | JSON, strings | C |
| Middle mouse | Pans | engine.md (live); no static string | I |
| Right-click drag | Pans when **Right-click and drag to pan** is on (pref `rightClickPan`, `toggle-right-click-pan`, setting key `mouse-right-click-to-pan`) | wasm fn 32937 strings | C |
| Ctrl-click | Opens the context menu when **Ctrl+click opens right click menus** is on (`ctrlClickContextMenu`) | 7621.min.js | C |
| Wheel / trackpad | Pans; ⇧ swaps the axes off the Mac | canvas.md §2.13 | C |
| Inertia | No inertia code found in the canvas path. Momentum comes from the OS trackpad's wheel events | absence | I |
| Pan limit | ±131,072 canvas units (§2.1) | fn 5305 | C |
| Scroll bars | 6 px (`scrollBarXHeight` / `scrollBarYWidth: "6px"`); `DragScrollbarBehavior` | 4752.min.js | C |

---

## 4. Rulers and guides

### 4.1 Rulers

| Item | Value | Evidence | |
|---|---|---|---|
| Toggle | ⇧R (`toggle-rulers`; toasts `visual_bell.rulers_visible` / `_hidden`) | JSON, fn 32493 | C |
| Thickness | **20 px** (`rulerThickness: "20px"`). The canvas viewport's top inset grows by it when rulers show | 4752.min.js | C |
| Units | **Pixels / Inches / Centimeters** (`fullscreen_actions.ruler-unit-pixels` / `-inches` / `-centimeters`, submenu `ruler-unit-menu`; prefs `renderRulerUnitAsPixels` / `AsInches` / `AsCentimeters`; toasts `visual_bell.ruler_unit_change_*`) | strings, JS keys | C |
| Print marks | `togglePrintMarks`, pref `renderPrintMarks` (toasts `print_marks_visible` / `_hidden`) | fn 32493 | C |
| Behaviours | `RenderRulersBehavior`, `ShowMousePositionBehavior`, `ShowCanvasXYAxisBehavior` | strings | C (names) |

### 4.2 Guides

| Item | Rule | Evidence | |
|---|---|---|---|
| Data | `GuidesData` on a node (`Fig::Guide`; NodeChange field `guides`). Page guides and frame guides | strings, schema | C |
| Create | Drag out of a ruler (`GuidesBehavior`); analytics `guide_created` | wasm fn 50119 | C |
| Delete | Drag back onto the ruler (cursor **`guide-delete`**); ⌫ on a selected guide (`selection.guideSelection()`); context menu **Remove guide** (`remove-guide`) and **remove all horizontal / vertical guides** (`remove-horizontal-guides` / `remove-vertical-guides`; analytics `horizontal_guides_deleted` / `vertical_guides_deleted`) | fn 15217, fn 30529, fn 46768 | C |
| Adjust | `adjust-ruler-guides` (`fullscreen_actions.adjust_ruler_guides`). Arrow keys nudge a selected guide (fn 46768 handles `guideSelection` inside the nudge path) | strings | C (names) / I |
| Rounding | In the nudge path, values are rounded to multiples of **16** (`×0.0625 → round → ×16`) unless the delta equals the current grid size (I: FigJam / Slides grid mode, not Design) | fn 46768 | C (math) / I (mode) |
| Snapping | Guides are snap targets (§5) | — | I |
| Properties-panel mode | `handleRulerGuidesModeToggled` (FGPropertiesPanelHelper.cpp) | fn 28786 | C (name) |

---

## 5. Snapping and smart guides

### 5.1 Preferences and toggles

| Pref (Preferences menu, 7621.min.js) | Action | Default | Shortcut | |
|---|---|---|---|---|
| Snap to geometry | `toggle-snapping-to-geometry` | on (I) | — | C |
| Snap to objects | `toggle-snapping-to-objects` | on (I) | — | C |
| Snap to pixel grid | `toggle-snapping-to-pixels` | on (I) | **⌘⇧'** (JSON; Swedish, German and other layouts have their own) | C |
| Snap to dot grid | `toggle-snapping-to-dots` | FigJam | — | C |
| Snap to frames | setting key `snap-to-frames` | — | — | C (name) |

Ctrl (⌃) held while dragging suspends snapping (help.figma.com; R7). Not visible statically. I

### 5.2 Snap target sources

Each source below is a profiler scope inside its own function (C, names). The rules are I.

| Source | Function | What it contributes |
|---|---|---|
| `cacheSnapTargetsInContainer` | fn 20131 | Edges and centres of the layers in the container (siblings) |
| `cacheTemporarySnapTargetsForGaps` | fn 32511 | **Equal spacing**: gaps between layers, matched by the dragged layer |
| `cacheTemporarySnapTargetsForImpliedFrameMargins` | fn 32510 | **Implied frame margins**: the distance a sibling keeps from the parent's edge, offered as a target on the other sides. **Not in DesignerV2** |
| `cacheTemporarySnapTargetsForLayoutGrids` | fn 20129 | Layout grid columns, rows and gutters |
| `cacheTemporarySnapTargetsForGrids` | fn 28420 | Grid-layout tracks / cells (a 23 k-instruction function) |
| `cacheSnapTargetsForRotationOrigin` | fn 32513 | The ⌥R rotation origin |
| `cacheSnapTargetsForVectorData` / `ForTextPath` / `ForVarWidthPoints` | fn 20132 / 50428 / 14108 | Vector points (Snap to geometry), text-on-path, variable-width points |
| `MutableCanvasSnapper` | fn 45187 / 45211 | Snapper instances: also the table-span and connector snappers (`InteractionCpp_getTableSpanSnapper`, `…getConnectorSnapper`) |

Other snapping facts:
- **Snap overlay colour** is token `fsSnappingOverlay` (colour struct offset 1424). The JS motion timeline uses it as `snapGuide:{stroke: fsSnappingOverlay}`. The hex value lives in the CSS bundle, which is not cached. C (token) / Open Q4
- **Debug.** `debug-toggle-show-all-snap-target-candidates` and pref `showAllSnapTargetCandidates` draw every candidate. C
- **Threshold.** The screen-px snap distance is **not located** statically. No snap-threshold string; the constants of the target functions above carry no candidate value. Other surfaces' thresholds, for comparison: motion timeline `snapThresholdPx = 8`; layers-panel drag `snapThreshold: 120` with `dropPositionThreshold: .5`. Neither is the canvas's. C (those values) / Open Q2
- **Drag start.** `preSnappingTransform is not invertible` (fn 48570): the snapper works on the transform before snapping and solves the snapped one from it. C

### 5.3 Pixel grid and pixel preview

| Item | Value | Evidence | |
|---|---|---|---|
| Pixel grid toggle | **⇧'** and ⌘' (`toggle-grid`); pref `renderGrid` | JSON | C |
| Pixel grid visibility | From **300 %** (faint), clear from 400 %; absent at 200 % | live keys.md §24 | C (live) |
| Pixel preview | **⌘⇧P**, ⌃P, ⌘⌥Y (`toggle-pixel-preview`); 2× via `toggle-retina-mode`; zoom-menu choices **Disabled / 1x / 2x** | JSON, 5904.min.js | C |
| Pixel preview toasts | "Pixel preview enabled (1x)", "Pixel preview disabled" | live keys.md | C (live) |
| Round to pixels | `round-to-pixels` action (Object menu) | strings | C |

---

## 6. Selection

### 6.1 Modifier rules (shortcuts panel table, 3653.min.js — C)

| Entry | Keys | Caption |
|---|---|---|
| `deep-select` | ⌘ + click | while clicking |
| `deep-select-rectangle` | ⌘ + drag | while dragging to select |
| `duplicate` | ⌥ (held while moving) | while moving |
| `center-resize-drag` | ⌥ | while resizing |
| `resize-proportionally` | ⇧ | while resizing |
| `ignore-constraints` | ⌘ ("ignore constraints, frames only": `fullscreen_actions.ignore_constraints_frames_only`) | while resizing |
| `move-while-resizing` | Space | while resizing |
| `measure-to-selection` | ⌥ | — |
| `swap-instance` | ⌥ (drag from Assets onto an instance) | — |
| `crop-image` | ⌥ + double-click | — |
| `deselect-all` | Esc | — |
| `pan` | Space + drag | — |

### 6.2 Keyboard selection (JSON — C)

| Action | Keys |
|---|---|
| select-all | ⌘A |
| select-inverse | ⇧⌘A |
| select-matching (*Select matching layers*) | **⌥⌘A**. Pref `similarIncludesMatching` widens "select similar" |
| select-child | Enter |
| select-parent | **\\** and ⇧Enter |
| select-next-sibling / previous | Tab / ⇧Tab (Design; FigJam uses select-next-node) |
| set-tool-keyboard-select | **⌥Space**: a keyboard-driven selection mode (`KeyboardSelectBehavior`, `keyboardSelectMode`, analytics `fpl.keyboard_selection_mode_changed`). **Not in DesignerV2** |
| unlock-all | ⌥⇧⌘L (toast `visual_bell.all_objects_unlocked`) |
| toggle-locked-for-selected-nodes | ⇧⌘L |
| toggle-shown-for-selected-nodes | ⇧⌘H |
| Edit › Select all with same… | fill, stroke, effect, font, text, style, instance, variant (`select-same-*`); `select-all-hidden-layers-within-selection` |

Toasts (C, keys): `visual_bell.no_more_children_to_select`, `visual_bell.nothing_in_selection`.

### 6.3 Click, double-click, marquee

Live and documented rules are already in `docs/engine.md` §8.2 (`live/behaviour/canvas.md`). Summary:
- **Top-level frame background.** A click there selects nothing (like empty canvas); a press-drag starts a marquee among its children.
- **Frame title.** Click selects, drag moves (the move snapped), double-click renames inline.
- **Nested frame background.** A click selects the nested frame.
- **Marquee partly over a top-level frame.** It selects the touched children.
- **Drop.** A dragged layer nests by the cursor, not by size.

Static additions:
- `MarqueeBehavior`, `ChangeSelectionBehavior`, `ClickDragMultiplexBehavior` and `PressBehavior` exist. Selection is a press / click / drag multiplex. C (names)
- **Lasso** is not a Design-canvas selection. `LassoSelectionBehavior` and `VectorLassoBehavior` (cursor `vector-lasso`, `set-tool-vector-lasso`) are vector edit mode; `ImageLassoBehavior` is the image AI tools. C
- **Deep select cursor.** Cursor `deep-parent` exists (I: shown when ⌘ will pick a parent / deep layer).

### 6.4 Selection colours (tokens; hex not in the cache)

The colour struct sent from CSS to C++ (glue `_StructParser_parseUInt(e+N)`):
- `bgFsSelected` +292, `borderFsSelected` +956, `borderFsSelectedStrong` +960.
- `bgFsComponent` +252, `borderFsComponent` +884.
- `bgFsMeasure` +276, `borderFsMeasure` +900, `textFsMeasure` +2664.
- `fsSnappingOverlay` +1424, `fsCanvasDefaultFill` +1324, `fsFrameDefaultFill` +1360.
- Frame titles: `fsTextOnLightCanvas` / `OnDarkCanvas` +1452 / +1444; `fsTextSelectedOn…Canvas` +1464 / +1460; `fsTextComponentOn…Canvas` +1440 / +1436.

The motion editor's selection uses `fill: borderFsDesignStrong` at **alpha 31/255** and `stroke: borderSelected`. C. That is a hint for the marquee-style fill (I).

### 6.5 Multi-select property mixing

- Panels show **Mixed**: i18n `fullscreen.mixed` (17 uses), `common.mixed`, `inspect_panel.property.mixed`. C
- Numeric fields with a mixed value refuse `incrementBy` (it returns the mixed sentinel) and format arrays as `"a, b"` (`figma_app.min.js: "e.map(e=>this.pixelFormatter.format(e)).join(", ")"`). So scrubbing or arrow-nudging a mixed field does nothing until a value is typed. C (formatter) / I (UI)
- Smart selection: equal-spacing centre marks and the pink gap handles (live `smart-selection.md`, `spacing-handles.md`). The panel gets a **Spacing** field. C (live)

---

## 7. Transform interaction

### 7.1 Resize and scale

| Rule | Evidence | |
|---|---|---|
| ⇧ keeps proportions; ⌥ resizes from the centre; **⌘ ignores constraints (frames only)**; Space moves the box while resizing | shortcuts panel (§6.1) | C |
| Lock aspect ratio (panel toggle) holds proportions on canvas drags too: 60×40 → 87×58 | live `resize.md` | C (live) |
| **Flip objects while resizing** pref (`flipDuringResize`, `toggle-flip-during-resize`) | prefs | C |
| Scale tool **K** (`set-tool-scale`), cursor `resize-scale` | JSON, strings | C |
| `resize-to-fit` ⌥⇧⌘R | JSON | C |
| Toast `visual_bell.unset_aspect_ratio_locking` | strings | C |
| Handle sizes and rotation-zone size | **not located** | Open Q3 |

### 7.2 Rotation

- **Rotation cursor.** Cursor `rotate`, outside the corner handles. C
- **⇧ snaps to 15° steps.** R7 (help). I statically
- **Rotation origin.** ⌥R `show-rotation-origin` (`RotationOriginBehavior`). It is a snap source (§5.2). C
- **Keyboard rotation.** `KeyboardRotationBehavior` behind pref `enableRotationShortcuts` ("Use ⌘⌥↑/↓ to rotate layers", the repo's string). C (names). The step size is not found.
- **Angle field nudge.** The rotation number field's own nudge is **−1° / −15°** (`smallNudgeAmount:-1, bigNudgeAmount:-15`, `allowedUnits: "°|px"`). Values are normalised to (−180, 180]. C (`figma_app.min.js`)

### 7.3 Nudge and duplicate

| Item | Value | Evidence | |
|---|---|---|---|
| Small / big nudge defaults | **1 / 10** (`smallNudgeAmount??1`, `bigNudgeAmount??10`) | figma_app.min.js; prefs `small-nudge-amount` / `big-nudge-amount` (fn 31327) | C |
| Nudge amount dialog | *Preferences › Nudge amount…* (`show-nudge-amount-picker`). A 180 px wide modal at (innerWidth/2 − 90, innerHeight/3), draggable by its header. Fields *Small nudge* (min **0.1**) and *Big nudge* (min **1**). Each field's own arrows step 1 / 10; Enter closes | figma_app.min.js | C |
| Arrow keys | Nudge by the small amount; ⇧ + arrow by the big one (auto-layout children reorder instead: engine.md) | — | C (amounts) |
| ⌘D | `duplicate-in-place`: same place, same name. After the copy is moved, ⌘D repeats that offset (y 30 → 60 → 90) | live keys.md §20 | C (live) |
| ⌥-drag duplicate | ⌥ while moving (§6.1); cursors `duplicate` / `duplicate-snap` | 3653.min.js, strings | C |
| Rename duplicated layers | pref `copyRenaming` (`toggle-copy-renaming`) | 7621.min.js | C |
| Duplicate toasts | `visual_bell.duplicate_selection`, `not_enough_memory_to_duplicate_this_page`, `page_duplicated` | strings | C |

### 7.4 Drag threshold

- **Mouse drag threshold.** Not located statically: it is in stripped C++. Open Q5.
- **Gesture-recogniser pan threshold** (`moved beyond threshold, starting drag`): Euclidean distance **> 5** (I: touch / pen pointer units) — `wasm fn 50551 @0x2b19baa`. C
- **Touch hand-select.** `HandSelectMoveNodeGestureRecognizer` logs "Distance past threshold", "Moved quickly past threshold, discarding potential selection" and "enough time elapsed, selecting". Touch select-and-move uses a distance-and-time rule. C (strings)

---

## 8. Measurement

| Item | Rule | Evidence | |
|---|---|---|---|
| ⌥ hover | Distances from the selection to the hovered layer (`measure-to-selection` = ⌥) | 3653.min.js | C |
| Measure tool | **⇧M** (`set-tool-measure`, Design; not FigJam or Sites) | JSON | C |
| Saved measurements | `AnnotationMeasurement` (start / end node and side, offset): actions `create-annotation-measurement`, `offset-…`, `remove-…`, `purge-unneeded-measurements`; error "Measurement end node not found"; `DevHandoffMeasurementMouseBehavior` | strings | C |
| Redlines | pref `renderRedlines` (`render-redlines`), `VectorRedlineRenderBehavior` | strings | C |
| Colours | tokens `bgFsMeasure` / `borderFsMeasure` / `textFsMeasure` / `iconFsMeasure` (+ Hover / Secondary / Tertiary, `on-measure`) | glue | C (tokens) / Open Q4 (hex) |

---

## 9. Hover, cursors, outlines, frame titles

### 9.1 Hover

- **Highlight layers on hover** (`layerHover`, `toggle-layer-hover`). C
- `HoverBehavior`; overlay kinds `STACK_CHILD_HOVER_OUTLINE`, `LAYOUT_MODE_HOVER`, `RENDER_CANVAS_GRID_CHILD_HOVER_BOX`. C (names)
- **Hide canvas UI during changes** (`temporarilyHideViewportOverlay`, `toggle-viewport-overlay-hiding`). C

### 9.2 Cursors

There are 119 cursor image names; the UI3 set is listed below. C. Hotspots are not in the strings (Open Q3).

`annotate, bend, black, black-move, black-move-h, black-move-v, break, break-move, break-snap, click, comments-next-pin, convert, crosshair, deep-parent, dropper, dropper-pointer, duplicate, duplicate-snap, edit-corners, edit-radius, edit-ratio, eraser, frame, frame-snap, guide-delete, hand-new, hand-press, highlighter, magic-handle, marker, move, not-allowed, paint-bucket(-insert/-remove), pen, pen-insert, pen-remove, pen-snap, pencil, position-absolutely, prototyping, resize, resize-padding, resize-padding-bounded, resize-scale, rotate, snap, stamp, washi-tape, zoom-in, zoom-out`.

Cursor-related prefs and flags (C):
- `customCursor`: a custom cursor pref.
- `cursorHighFiveWiggle`: multiplayer.
- `toggle-multiplayer-cursors`: ⌥⌘\\.

### 9.3 Outline mode, view toggles

| Item | Value | Evidence | |
|---|---|---|---|
| Outlines | **⌘⇧O** (or ⇧O with *Use old shortcuts for outlines*); also ⌘Y and ⌃⇧3 | JSON | C |
| Outline sub-options (zoom menu › Outlines) | **Show hidden layers** (`toggle-outline-mode-hidden-layers`) and **Show object bounds** (`toggle-outline-mode-object-bounds`) | 5904.min.js | C. **Not in DesignerV2** |
| Frame outlines | `show_frame_outlines`, pref `showArtboardOutlines`, toasts `frame_outlines_visible` / `_hidden` | fn 32493 | C |
| Mask outlines, slices | `show_mask_outlines` / `showMasks`; `toggle-show-slices` (toasts `slices_visible` / `_hidden`) | JS keys | C |
| Layout grids | ⇧G, ⌃G, ⌃⇧4 (`toggle-shown-layout-grids`) | JSON | C |
| Hide UI / minimise UI | ⌘\\ and ⌘. / ⇧\\ and ⌘⇧\\ | JSON | C |
| Comments, annotations | ⇧C; ⇧Y | JSON | C |
| Zoom-menu view options (5904.min.js) | pixel preview submenu, outlines (+ hidden layers, object bounds), multiplayer cursors, comments, annotations, **property labels** (`toggle-show-property-labels`) | — | C |

### 9.4 Canvas background and frame titles

- **Canvas background.** Default fill token `fsCanvasDefaultFill`; a frame's default fill is `fsFrameDefaultFill`. The page's own `backgroundColor` overrides the canvas fill (schema). C (tokens)
- **Frame titles.** Light / dark canvas variants of the text tokens (§6.4); section names are a render kind (`RENDER_SECTION_NAMES`). Metrics: see the repo's live measurements (`OverlayStyle.h`). C (tokens)

---

## 10. UI strings

The JS carries i18n **keys**. English is given where the repo attests it: `src/shared/i18n/tr/*.ts` keys, written "(repo)", or live captures, written "(live)".

- **Zoom menu.**
  - `fullscreen_actions.zoom-in` "Zoom in" (repo)
  - `fullscreen_actions.zoom-out` "Zoom out" (repo)
  - `fullscreen_actions.zoom-to-fit` "Zoom to fit" (repo)
  - `fullscreen.toolbar.zoom_menu.zoom_to_50` "Zoom to 50%" (repo)
  - `fullscreen_actions.zoom-reset` "Zoom to 100%" (repo)
  - `fullscreen.toolbar.zoom_menu.zoom_to_200` "Zoom to 200%" (repo)
  - `fullscreen_actions.zoom-to-selection` "Zoom to selection" (repo)
  - `fullscreen_actions.previous-artboard` / `next-artboard` "Zoom to previous frame" / "Zoom to next frame" (repo)
  - `…-same-zoom` variants: English not attested
  - `fullscreen.zoom_menu.zoom_view_options` (+ `.aria_label`): English not attested
- **Pixel preview.**
  - `fullscreen.toolbar.zoom_menu.pixel_preview` "Pixel preview" (repo)
  - `…pixel_preview_disabled` / `_1x` / `_2x`: English not attested; live toasts "Pixel preview enabled (1x)" / "Pixel preview disabled" (live)
- **View.**
  - `fullscreen_actions.show_pixel_grid` "Pixel grid" (repo)
  - `show_layout_guides` "Layout guides" (repo)
  - `show_rulers` "Rulers" (repo)
  - `show_outlines` "Show outlines" (repo)
  - `outline-mode-hidden-layers`, `outline-mode-object-bounds`, `outlines-menu`, `show_frame_outlines`, `show_mask_outlines`, `show_slices`: English not attested beyond the repo's "Frame outlines" / "Mask outlines"
  - Toasts "Outlines visible" / "Outlines hidden" (repo, live)
- **Rulers and guides.**
  - `ruler-unit-menu`, `ruler-unit-pixels` / `-inches` / `-centimeters`: not attested
  - `remove-guide` "Remove guide" (repo)
  - `remove-horizontal-guides` / `remove-vertical-guides` / `adjust_ruler_guides`: not attested
  - `visual_bell.rulers_visible` / `_hidden` / `ruler_unit_change_*`: not attested
- **Preferences** (repo):
  - "Snap to geometry", "Snap to objects", "Snap to pixel grid"
  - "Highlight layers on hover", "Rename duplicated layers"
  - "Hide canvas UI during changes", "Flip objects while resizing"
  - "Keyboard zooms into selection", "Invert zoom direction"
  - "Ctrl+click opens right click menus", "Use number keys for opacity"
  - "Use old shortcuts for outlines", "Use ⌘⌥↑/↓ to rotate layers"
  - "Use scroll wheel zoom", "Right-click and drag to pan"
- **Nudge.**
  - `fullscreen_actions.show-nudge-amount-picker` "Nudge amount…" (repo)
  - `fullscreen.nudge.nudge_amount` "Nudge amount" (repo)
  - `fullscreen.nudge.small_nudge` "Small nudge" (repo)
  - `fullscreen.nudge.big_nudge` "Big nudge" (repo)
- **Selection.**
  - `fullscreen_actions.select-all`, `select-inverse`, `select-matching`, `select-child`, `select-parent`, `select-next-sibling`, `select-previous-sibling`, `select-same-{fill,stroke,effect,font,text,style,instance,variant}`, `select-all-hidden-layers-within-selection`, `deselect-all`, `deep_select`, `deep_select_within_rectangle`, `while_dragging_to_select`, `ignore_constraints_frames_only`, `measure_to_selection`: English not attested in the repo; help.figma.com names "Select matching layers"
  - `fullscreen.mixed` "Mixed" (Figma UI; repo panels)
- **Toasts** (`visual_bell.*`, English not attested):
  - `zoom-to-100`, `zoom-to-fit`, `zoom-to-selection`
  - `no_more_children_to_select`, `nothing_in_selection`, `all_objects_unlocked`
  - `duplicate_selection`, `unset_aspect_ratio_locking`
  - `frame_outlines_visible` / `_hidden`, `slices_visible` / `_hidden`, `comments_visible` / `_hidden`, `annotations_visible` / `_hidden`, `print_marks_visible` / `_hidden`

---

## 11. DesignerV2 today

| Area | Figma | DesignerV2 | Verdict |
|---|---|---|---|
| Max zoom | 256 | `kMaxZoom = 256` (`engine/src/render/Camera.h`) | matches |
| **Min zoom** | **1/64 = 0.015625** | `kMinZoom = 0.02` | **differs** |
| **Zoom in / out step** | next / previous **power of two** (150 % → 200 %, not 300 %) | `zoom*2` / `zoom/2` (`Commands.cpp:155–156`) | **differs** |
| **Zoom to fit padding / cap** | 25 px a side, **no 100 % cap** | 64 px a side, capped at 100 % (`Camera::fit`, `upTo100`) | **differs** |
| **Zoom to selection padding** | 40 px a side | 64 px a side | **differs** |
| Zoom to selection, nothing selected | zooms to fit | returns without doing anything (`Editor::zoomToSelection`) | **differs** |
| Zoom shortcuts | also **⇧9** for fit, ⇧= / + for zoom in, ⇧- for zoom out; the number keys switch with *Use number keys for opacity* | ⌘=, ⌘⇧=, =, Num+; ⇧1; ⇧2; ⌘0 / ⇧0 | partial |
| Next / previous frame at the same zoom | End / Home | commands exist (`objectCommands.ts`); keys not checked | partial |
| **Pan bound** | ±131,072 units (centre clamp) | `kCanvasBound = 130000` (owner's live check) | close; Figma's exact value is 2^17 |
| Wheel / pinch / click count | canvas.md §2.13–2.14 | done in round 17 (engine.md §8.4) | matches |
| Pinch exponent | `log(ratio)/log(4)` for touch | `log(ratio)/log(e^−0.01)` (engine.md §8.4) | differs (touch only) |
| Rulers | 20 px; **units px / in / cm**; print marks | 20 px (`tokens.ts ruler: 20`); px only | **missing units** |
| Guides | create, move, delete, ⌫, Remove guide, **remove all horizontal / vertical** | all but the remove-all pair | partial |
| Snap sources | container, gaps, **implied frame margins**, layout grids, grid tracks, rotation origin, vector, text-path, var-width | siblings, parent, guides, layout grids, equal spacing (`Snapping.cpp`) | **missing implied margins** |
| Snap threshold | not located | 6 CSS px | unverified |
| Nudge | 1 / 10; picker mins 0.1 / 1 | 1 / 10, `engine_set_nudge` | matches (check the picker mins) |
| Rotation field nudge | −1° / −15° (inverted sign), (−180, 180] | not checked | — |
| **Keyboard select (⌥Space)** | `KeyboardSelectBehavior` | absent | **missing** |
| Select matching (⌥⌘A) | yes | `SELECT_MATCHING` exists | matches |
| **Outline mode options** | Show hidden layers, Show object bounds | outlines only (plus mask / frame outlines) | **missing** |
| Pixel preview 1x / 2x, pixel grid ≥ 300 % | yes | yes (`commands.ts:484`) | matches |
| Measure tool ⇧M / saved measurements | yes | Dev Mode measurement exists (`DevMode.cpp`) | partial (check ⇧M in Design) |
| Property labels in the zoom menu | `toggle-show-property-labels` | not checked | — |

### As built (2026-10-17, wave 1)

Branch "canvas and shapes" (`engine/src/render/Camera.h`, `editor/Editor.cpp`, `editor/Snapping.cpp`, `editor/SelectionCommands.cpp`, `render/Renderer.cpp`; native tests `engine/tests/unit/atlas.canvas_shapes.test.cpp`, chrome tests `src/renderer/src/editor/__tests__/atlas.canvasShapes.test.ts`). The wheel and pinch rates, sharp frames, LOD and caches (the owner's "best version so far", handoff 2026-10-15) are untouched; only the discrete rules changed.

- **Zoom range** 1/64 … 256 (`kMinZoom = 1/64`).
- **Zoom in / out** to the next / previous power of two (`Camera::zoomedIn` / `zoomedOut`): ⌘= / ⌘−, the menus, the zoom tool's click (⌥: out).
- **Zoom to fit** 25 px a side, **zoom to selection** 40 px a side, both without the 100 % cap (`Camera::fit(rect, w, h, padding)`; a rect without width or height is shown at 100 %; the padding alone filling the view leaves it as it is). Zoom to selection with nothing selected zooms to fit. The other callers that frame layers — N / ⇧N, the zoom tool's area, paste's zoom out — take the selection's 40 (Figma's padding for them not read).
- **Pan bound**: the visible part's centre stays within ±131,072 (2^17) of the origin, Figma's centre clamp (`Camera::keptOnCanvas`; the owner's ±130,000 seen at the view's edge is that bound less half a view). `agentPresence.ts` mirrors 1/64 and 131,072.
- **Zoom keys** as Figma's table: ⇧9 fits too; + (⇧=), ⌘ Num+, ⇧- and ⌘⇧- and ⌘ Num- zoom; with Preferences › Use number keys for opacity off, 0 / 1 / 9 / 2 alone zoom (`keyboard.ts`).
- **Implied frame margins**: a moving box snaps so its far side keeps a sibling's margin from the parent frame's near side (and the other way round), both margins measured with spacing pills; edge lines win ties (`Snapper::snapBox`, choice kind 4).
- **Guides**: a right click on a ruler opens Figma's ruler menu (its `rulerGuideMenu`): Remove horizontal guides (top ruler) / Remove vertical guides (left ruler) — the guides of the frame or page that ruler adds to (`REMOVE_HORIZONTAL_GUIDES` 238 / `REMOVE_VERTICAL_GUIDES` 239, one undo step) — then Hide rulers (⇧R shown).
- **Outline mode's options**: View › Outlines ▸ Show hidden layers / Show object bounds (`VIEW_OUTLINE_HIDDEN` 524288 / `VIEW_OUTLINE_BOUNDS` 1048576). Drawn over the page each frame (`Renderer::drawOutlineOptions`), not into the cached tiles: hidden layers outlined in the outline ink, each layer's box at half its alpha (look unverified).
- **Rotation field**: ⇧↑↓ steps 15° (Figma's big nudge).
- **Ruler units are not Design's**: the build lists the unit submenu and `toggle-ruler-unit-*` only for Figma Buzz (`flags: ["cooper"]`, feature flag `buzz_print_export`; print marks too), so Design keeps pixels. The table's "missing units" row is not a gap.
- **Touch pinch**: Figma's `log(ratio)/log(4)` with exponent 4 zooms by the fingers' distance ratio, as ours does — the same in effect.
- **Measure tool** ⇧M is bound in Design (`tool.measurement`); **property labels** are View › Additional labels (round 17), not in the zoom menu.

Not done / open:
- **⌥Space keyboard select** (`set-tool-keyboard-select`): the build shows a tool `KEYBOARD_SELECT` with two modes, BOX and PICK (`keyboardSelectMode`; toasts `fullscreen.accessibility.keyboard_box_selection_activated` / `keyboard_pick_selection_activated`, a cursor-focused node), but not which keys move, pick or box in it — a live probe (⌥Space, then arrows / Enter / Space, reading the selection) before building.
- The zoom menu's own Outlines ▸ submenu: the commands exist (`view.outline-hidden-layers`, `view.outline-object-bounds`); the zoom menu (`RightPanel.tsx` `ZoomMenu`) is the chrome branch's.
- Implied margins on resizes and draws (only moves use them); whether a sibling's margin is also offered on the other axis ("the other sides") — fn 32510 not disassembled.
- The rotation field's −1 / −15 sign and the (−180, 180] normalisation; the Nudge amount picker's look and minimums (0.1 / 1) belong with chapter 21's dialog rules.
- Which guides the ruler menu removes in Figma (the page's only, or frames' too) — ours takes the ruler's owner; the English of its two rows is unattested.
- Open questions 1–8 below stand.

**Sweep (2026-10-18)** — branch `worktree-agent-ac2399b6b638fb5ab`:
- **Closed**: the zoom menu's own Outlines ▸ (Outlines, Show hidden layers, Show object bounds); zoom in / out disabled
  at 1/64 and 256 (the engine's `commandState`, native test in `atlas.canvas_shapes.test.cpp`).
- **Already matched**: the rotation field's (−180, 180] (`rotationOf`; Figma's angle formatter only normalises the
  display).
- **Stays open**: ⌥Space keyboard select (a live probe); implied margins on resizes and draws (fn 32510 unread); the
  rotation field's −1 / −15 nudge sign — the formatter shows the value as it is, so whether ↑ lowers the shown angle
  depends on the value the panel hands it (unread); the ruler menu's removal scope.

---

## 12. Open questions (live probes that would settle them)

1. **Wheel / trackpad zoom rate.** Probe: in live Figma at 100 %, send one Mac mouse-wheel notch with ⌘ held and one trackpad pinch of known deltaY (`WheelEvent` dispatched on the canvas). Read `figma.viewport.zoom` before and after. Repeat at 3 deltas to fit `zoom' = zoom·b^(−dy·k)`.
2. **Snap threshold (screen px).** Probe: Plugin API, a 100×100 rect at x=0 and another at x=200. Drag the second with real mouse input in 1 px steps towards x = 100 + t at 100 % and at 200 % zoom, and read where `x` jumps to 100. This gives t in screen px and shows whether it scales with zoom.
3. **Handle sizes, rotation zone, cursor hotspots.** Probe: a 2× screenshot of a selected 200×200 rect at 100 %, measuring corner and edge handles. Hover outward from a corner in 1 px steps to find where the cursor turns into `rotate` and where it stops.
4. **Overlay colour hex values** (`fsSnappingOverlay`, `bg/border/textFsMeasure`, `bgFsSelected`, `fsCanvasDefaultFill`, frame-title tokens). Probe: in the desktop app's devtools, `getComputedStyle(document.documentElement).getPropertyValue('--color-fsSnappingOverlay')` (and the others), in light and dark themes.
5. **Mouse drag threshold** (screen px before a press becomes a move or marquee). Probe: real input, press on a layer, move 1, 2, 3 … px, release; check whether the position changed. Do it at two zooms.
6. **Ctrl suspends snapping; ⌘ forces nesting; Space mid-drag.** These need a tool that can hold keys mid-drag (the browser tool could not): a native drive (`scripts/drive.mjs` against the desktop app, or macOS `CGEvent`).
7. **Keyboard rotation step** (`enableRotationShortcuts`, ⌘⌥↑/↓). Probe: turn the pref on, press once, read `rotation`.
8. **Editor-type indices of the zoom-range switch** (cases 3–6 in fn 6947: Dev Mode? Sites? Buzz?). Probe: read `figma.viewport.zoom` after ⇧0 then 20 × ⌘- in Dev Mode and in Sites.
