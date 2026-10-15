# Vector drawing and Figma Draw: Figma vs Wecra (REA, 2026-10-15)

This report maps what Figma's shipped code does for vector drawing and Draw onto Wecra as built after round 7 (7a–7e merged; `docs/draw.md` "As built"). Each section gives:
- **Figma**: the behaviour, with evidence (static analysis of Figma's bundles and wasm, and live plugin-API probes);
- **Wecra today**: the code as it stands, with `file:line` references;
- **Gap**: what to build.

The integration plan at the end is an ordered task list.

**Sources**
- Static analysis: the REA notes (`scratchpad/rea-work/vector/static-notes.md`, from `figma_app.min.js`, `1968 / 2108 / 2131 / 3187 / 1334 / 1540.min.js`, the fullscreen wasm and its glue).
- Live probes: plugin-API calls against a Starter-plan Figma file on 2026-10-15. 12 calls ran before the plan's tool-call limit, so several probes did not run. They are marked **not run**.
- Figma's schema: `docs/research/figma/figma-schema-106.kiwi`.

**Marks**
- **[live]**: confirmed by a live probe.
- **[static]**: read from the code only.
- **[low]**: weak evidence, still to calibrate.

Where this report contradicts `docs/draw.md`, the contract has to change, and the gap lists the section.

---

## 0. Summary

| # | Feature | Wecra | Size | Prio |
|---|---|---|---|---|
| 1 | Stroke type detection (Basic / Dynamic / Brush; the `-1:-1` sentinel; the neutral Dynamic value) | different (bug on Figma files) | S | 1 |
| 2 | Dynamic stroke defaults 0.75 / 0.3 / 0.5; Basic resets to neutral | different | S | 1 |
| 3 | Width profile presets (0.1875), reversed presets, the plugin's `width` = ascent | partial | S | 1 |
| 4 | Changing the stroke type keeps width points and dashes | different | S | 2 |
| 5 | Scatter defaults per brush (the BRUSH node's own settings; base gap 0.9) | different | M | 2 |
| 6 | Transform modifier count 2–40 | different | S | 2 |
| 7 | Outline stroke / Flatten of Dynamic and Brush strokes | missing | M | 2 |
| 8 | Simplify vector as a tool (live preview, threshold −2…3, tolerance 10^−t) | different | M | 2 |
| 9 | Plugin `vectorNetwork` / `vectorPaths` / geometry getters, `setVectorNetworkAsync` normalisation | missing | L | 2 |
| 10 | Offset path as a tool (live preview, engine slider range, Miter / Round) | partial | M | 3 |
| 11 | Built-in brush identity by `assetKey`; `loadBrushesAsync` per type; soft-deleted brushes | partial | M | 3 |
| 12 | Drawing tool default style (weight 4, white in dark theme, shared across files; Eraser 10 / ROUND; Pen shares it) | different | S | 3 |
| 13 | Text on path: Combine / Separate, `createTextPath`'s sources and error, start encoding | partial | M | 3 |
| 14 | Stroke settings limits (dashes ≤ 8, `strokeMiterLimit` 1–16, Dash cap row, cap size) | partial | S | 3 |
| 15 | Pencil fitting (B-spline 0.66 / 0.33, distance / angle / pressure filters) | different | M | 3 |
| 16 | Stylus pressure → variable width points (`enablePressureSensitivity`) | missing | M | 4 |
| 17 | Vector edit toolbar: last-used tool slot, toggle back to Select, break network, pen preference | partial | S | 4 |
| 18 | Flatten / Outline stroke availability gates | partial | S | 4 |
| 19 | Draw's Eraser (area erase with weight and cap) vs vector edit Erase | different | L | 4 |
| 20 | Scatter brushes in SVG export (`<use>`) and import (`data-figma-scatter`) | different | M | 4 |
| 21 | Skew modifier (`ce_il_slant`) | partial | S | 5 |
| 22 | StrokeAlign OFFSET, `strokeOffset` 554, `strokeData` 571 (several strokes) | missing | XL | 5 |
| 23 | `vectorNetworkBlob` layout | done | — | — |
| 24 | Boolean / stroke-expansion backends | done (another backend) | — | — |
| 25 | Shape builder, Bend, Lasso internals | done | — | — |

---

## 1. Stroke type detection

**Figma** [static, high]:
- The type is Brush when `strokeBrushGuid` (446) is set and is not `-1:-1`.
- It is Dynamic when `dynamicStrokeSettings` (448) is present and differs from the neutral `{frequency 1, wiggle 0, smoothen 0}`.
- Otherwise it is Basic. A selection that mixes types reads MIXED.
- Evidence: `1968.min.js @74046` `return r&&(0,y.p3)(d.dI(r))?"Brush":n&&(0,y.m3)(n)?"Dynamic":"Basic"`; `2131.min.js` module 511482 compares against `lF = {1,0,0}`.
- Figma writes `strokeBrushGuid = -1:-1` whenever a stroke becomes Dynamic or Basic, so every Dynamic stroke in a Figma file carries that GUID.

**Wecra today**:
- The engine is right about the sentinel and wrong about the neutral value.
  - `kNoGuid` is `{0xffffffff, 0xffffffff}`, i.e. `-1:-1` (`engine/src/base/Guid.h:60`), so `strokeBrushOf` returns "no brush" (`engine/src/geometry/Brush.cpp:141-149`).
  - `dynamicSettingsOf` returns true for any present `dynamicStrokeSettings`, the neutral value included (`engine/src/geometry/DynamicStroke.cpp:152-177`). Rendering is unaffected, because wiggle 0 returns the centre line unchanged. Everything that asks "is it Dynamic" is wrong, though: `widthProfileAllowed` (`engine/src/geometry/VariableWidth.cpp:176-180`) disables variable width on a neutral Basic stroke.
- The chrome and the plugin API are wrong on both counts.
  - `strokeKindOf` (`src/renderer/src/editor/draw/panels/drawPanel.ts:86-91`) and `complexStrokeOf` (`src/shared/draw/apiShapes.ts:101-113`) read `guidString(strokeBrushGuid)`.
  - For Figma's sentinel that string is `"4294967295:4294967295"` (`src/renderer/src/engine/guids.ts:13-17`, `apiShapes.ts:74-78`).
  - So **every Dynamic stroke imported from Figma shows as Brush** in Stroke settings, REST JSON and the plugin API, with brushName CUSTOM.

**Gap**:
- One shared predicate for both rules (the sentinel and the neutral value), used by the engine (`strokeBrushOf`, `dynamicSettingsOf`, `widthProfileAllowed`) and by TS (`strokeKindOf`, `complexStrokeOf`, `dynamicOf`).
- `docs/draw.md` §4.3's "Stroke kind is implicit" needs these two rules.

## 2. Dynamic stroke defaults and the Basic reset

**Figma**:
- New Dynamic: `{frequency 0.75, wiggle 0.3, smoothen 0.5}` [live: read back `0.75 / 0.30000001192092896 / 0.5`, float32].
- Neutral: `{1, 0, 0}`. Clamps: frequency 0.01–20, wiggle 0–∞, smoothen 0–1.
- UI slider maxima: frequency 2, wiggle 5, smoothen 1 (`1968.min.js` module 326635) [static].
- Setting Basic does not delete the field [static]: a present `dynamicStrokeSettings` is reset to neutral, and `strokeBrushGuid` becomes `-1:-1`. Setting Dynamic also writes `-1:-1` (`3187.min.js @3365736`).
- The plugin reads Basic back as `{type:"BASIC"}` [live]. That the field stays as neutral needs a `.fig` export, which was not run.

**Wecra today**:
- `DYNAMIC_DEFAULTS = {2, 1, 0.5}` (`src/shared/draw/types.ts:90`).
- The engine has its own copy (`engine/src/geometry/DynamicStroke.h:31-35`).
- The Pencil's default dynamic settings come from the same constant (`types.ts:101`).
- `SET_STROKE_KIND` BASIC clears `dynamicStrokeSettings` and `strokeBrushGuid` (`engine/src/editor/DrawCommands.cpp:706-748`; the clear is at 744).
- Wiggle is clamped to 0–100 (ours, `DrawCommands.cpp:733`, `types.ts:81`).
- Draw's Wiggle slider runs 0–10 (`docs/draw.md` "As built (7d)").

**Gap**:
- Defaults → 0.75 / 0.3 / 0.5.
- Basic writes the neutral value when the field is present, plus `strokeBrushGuid = -1:-1`. Dynamic also writes `-1:-1`.
- Wiggle's upper clamp → none (plugin), keeping a sane engine cap for geometry.
- Slider maxima → 2 / 5 / 1.
- The `.fig` round trip then matches Figma byte for byte. The renderer change is the neutral check of §1.

## 3. Variable width presets, Flip and the plugin shape

**Figma** [static + live]:
- Points are `{position, ascent = descent}`. 0.5 is half the stroke weight on each side [live: WEDGE at weight 20 gives a half-height of 10 at x = 0].
- The presets:
  - UNIFORM `[]`
  - WEDGE `[0:.5, 1:0]`
  - TAPER `[0:.5, 1:.1875]`
  - QUARTER_TAPER `[0:.1875, .25:.5, 1:.1875]`
  - EYE `[0:0, .5:.5, 1:0]`
  - MIRRORED_TAPER `[0:.1875, .5:.5, 1:.1875]`
- A reversed preset is still that preset [live: CUSTOM `[0:0, 1:.5]` reads back as WEDGE with the reversed points]. That reversal is what Flip does. Anything else is CUSTOM; a mixed selection is MIXED.
- Plugin getter: `{widthProfile, variableWidthPoints: [{position, width: ascent}]}` for presets too [live].
- Setting CUSTOM writes `ascent = descent = width`, `segmentId 0`, and needs at least one point.
- The setter refuses complex networks ("Cannot set variableWidthStrokeProperties on complex vector nodes"). It does **not** refuse Dynamic, Brush or dashed strokes [live: all three accepted and kept].
- Between two points the width is linear [live: WEDGE's outline steps 9.5 → 0.5 linearly]. The start is a flat butt built from cubic thirds.
- UI availability, in order: Dynamic stroke → complex network (unless `ce_il_var_width_vector_networks`) → dashed. Brush is not in the list [static, `1968.min.js @61086`].

**Wecra today**:
- The presets are ours: `sym(pos, w)` with ascent = w/2 (`src/renderer/src/editor/widthProfile.ts:23-41`; engine `engine/src/geometry/VariableWidth.cpp:56-60`).
  - WEDGE and EYE match.
  - TAPER, QUARTER_TAPER and MIRRORED_TAPER use 0.125 where Figma has 0.1875.
- `matchProfile` does not recognise reversed presets (`widthProfile.ts:54-63`; engine `VariableWidth.cpp:67-76`). A flipped Wedge therefore shows as Custom.
- Between points we use a Fritsch–Carlson monotone cubic (`VariableWidth.cpp:16`). It is linear for two points; for three or more, Figma's curve is unverified.
- Plugin (`src/renderer/src/editor/plugins/api/draw.ts:240-269`):
  - the getter returns `null` for any non-Basic stroke;
  - it omits the points for presets;
  - it reports `width = ascent + descent`, double Figma's;
  - the setter writes `ascent = width / 2`, throws on Dynamic, and has no complex-network check.
- UI: `widthProfileAllowed` disables dashed and Dynamic strokes (`VariableWidth.cpp:176-180`). Branching networks are disabled in `widthCommandState` (`engine/src/tools/VariableWidthTool.cpp:325-337`). The Stroke panel also disables Brush (`src/renderer/src/editor/panels/design/Stroke.tsx:334`), which Figma does not.

**Gap**:
- Presets → 0.1875 (engine and TS).
- Recognise reversed presets.
- Plugin shape → Figma's: `width` = ascent, points always given, and the getter answers for every kind.
- Setter → complex-network refusal only, with Figma's message.
- Panel: allow Brush strokes. The disabled tooltip gives the reason (dynamic / split vector / dashed), as Figma's i18n keys do.

## 4. Changing the stroke type keeps width points and dashes

**Figma** [live]: setting `complexStrokeProperties = {type:"DYNAMIC"}` on a TAPER stroke kept its width points. A `[4,4]` dash survived setting variable width. Nothing is cleared; only the UI hides the tools.

**Wecra today**:
- `SET_STROKE_KIND` DYNAMIC clears `variableWidthPoints` and `dashPattern` (`DrawCommands.cpp:735-741`).
- `SET_STROKE_BRUSH` clears them as well as `scatterBrushTransforms` (`DrawCommands.cpp:760-769`).
- `docs/draw.md` §4.3 / §4.5 say to clear them.

**Gap**:
- Stop clearing. Rendering keeps today's rule: width points are ignored on Dynamic and dashed strokes, as `widthProfileAllowed` already does.
- Whether Figma draws width points under a Brush stroke is unverified; we keep drawing the brush.
- `scatterBrushTransforms` is still dropped on a brush change. It is derived from the old brush.

## 5. Scatter brush defaults per brush

**Figma**:
- Base scatter defaults: `{gap .9, wiggle 0, rotation 0, angularJitter 0, sizeJitter 0}`; stretch `{orientation FORWARD}` [static, `figma_app.min.js` module 258160 `F2` / `Ge`].
- Applying a scatter brush writes `{...F2, ...brushNode.scatterStrokeSettings, ...userValues}` [static, `3187.min.js @3366400`]. Each built-in brush's own settings were read back [live]:

| Brush | gap | wiggle | angularJitter | rotation | sizeJitter |
|---|---|---|---|---|---|
| BUBBLEGUM | 0.25 | 0 | 95 | 45 | 0 |
| WITCH_HOUSE | 0.39 | 0 | 61 | 179 | 0 |
| SHOEGAZE | 0.37 | 0 | 180 | 0 | 0.11 |
| HONKY_TONK | 0.28 | 0 | 180 | 0 | 0.25 |
| SCREAMO | 0.45 | 0 | 180 | 179 | 0 |
| DRONE | 0.51 | 0.06 | 180 | 0 | 0.65 |
| DOO_WOP | 0.31 | 0 | 180 | 0 | 0 |
| SPOKEN_WORD | 0.25 | 0 | 30 | 0 | 0 |
| VAPORWAVE | 0.25 | 0 | 180 | 0 | 0.3 |
| OI | 0.25 | 0 | 95 | 45 | 0 |

- A user value wins over the brush's own value [live: OI with gap 0.5 → 0.5].
- UI slider maxima: gap 0.25–3, wiggle 2, sizeJitter 0–3, angularJitter and rotation ±180.

**Wecra today**:
- `SCATTER_DEFAULTS.gap = 1` (`types.ts:91`).
- `SET_STROKE_BRUSH` writes `gap 1 …` when the layer has no scatter settings, and keeps the old brush's settings when it has some (`DrawCommands.cpp:771-775`).
- `SET_BRUSH_SETTINGS` falls back to gap 1 (`DrawCommands.cpp:795-798`).
- The Brush tool writes gap 1 (`engine/src/tools/DrawTools.cpp:116-118`).
- The geometry already falls back to the BRUSH node's own `scatterStrokeSettings` (`engine/src/geometry/Brush.cpp:192`), but nothing writes them: `brushProps` (`DrawCommands.cpp:342-357`) and the 7e artwork (`src/shared/draw/brushes/`) carry none.
- Wecra's gap upper bound is 20 (ours).

**Gap**:
- Built-in scatter brushes install with the table above as their node's `scatterStrokeSettings` (449). These are Figma's numbers, not artwork.
- Applying a brush writes `{base 0.9 …, ...node, ...user}` and replaces the previous brush's settings.
- Custom scatter brushes (CREATE_BRUSH) get the base defaults on their node.
- Slider maxima → Figma's.
- `docs/draw.md` §4.5 / §9 need correcting.

## 6. Transform modifier limits

**Figma**:
- Plugin: `count` is an integer from 2 to 40 [live: 0, 1 and 41 refused with zod messages such as "Number must be less than or equal to 40 at [0].count"; 2 and 40 accepted].
- LINEAR needs an `axis`; RADIAL takes none; `unitType` is RELATIVE or PIXELS.
- Actions:
  - `add-transform-modifier-to-selection` (radial);
  - `add-linear-repeat-to-selection`;
  - `add-skew-modifier-to-selection` (behind `ce_il_slant`);
  - `apply-transform-modifiers`.

**Wecra today**:
- `count` is clamped to 1…1000 (`engine/src/geometry/Repeat.cpp:33`, `REPEAT_COUNT_RANGE`, `types.ts:130`).
- The panel's Count field uses that range (`src/renderer/src/editor/draw/panels/TransformSection.tsx:111`).
- The plugin accepts ≥ 1 (`plugins/api/draw.ts:97`).

**Gap**:
- Plugin: validate 2–40 with Figma's message.
- Panel: Count 2–40.
- The engine keeps reading any count from files (clamp 1…1000, so we stay lenient on read).
- `docs/draw.md` §4.2 / §9 need correcting.

## 7. Outline stroke and Flatten of Dynamic and Brush strokes

**Figma**:
- `node.outlineStroke()` returns null when there is nothing to outline [static `3187.min.js @3450131`].
- Engine errors: "Expected one flattened region from group node", "Failed to apply flatten operation".
- Whether the result of a Dynamic or Brush stroke is its displaced or brush outline was **not run** live. `docs/draw.md` §4.3 decided it is.

**Wecra today**:
- `Editor::outlineStroke` strokes the plain centre line with the basic stroker (`engine/src/editor/VectorCommands.cpp:248-275`). It ignores `dynamicCenter` and `brushStroke`, although the exporters already use them (`engine/src/export/Scene.cpp:81-90`).
- Flatten has the same gap. `docs/draw.md` §4.10 "For 7b" listed this, and it was not done.

**Gap**:
- Outline stroke and Flatten take the stroke outline from `exporter::strokeOf` (Dynamic: the displaced centre stroked; Brush: the artwork outline).
- One VECTOR filled with the stroke paints.

## 8. Simplify vector

**Figma** [static, high]:
- A tool (`SIMPLIFY_VECTOR`) with a secondary toolbar:
  - a slider from −2 to 3 (step 0.01, big step 0.1, anchor −2), starting at 3;
  - a "simpler" icon on the left and a "more detailed" icon on the right;
  - Cancel and Apply (✓); Enter applies.
- The engine's tolerance is `10^(−threshold)`: 100 at the simple end, 0.001 at the start (practically no change).
- Enabled for one vector-editable node that is not a TEXT_PATH and not in multi-edit.
- Region simplification goes through Skia PathOps (`SimplifySingleRegionVectorNetwork`).
- `SimplifyVectorTsApi`: `setThreshold`, `apply`, `cancel`. The preview is live.

**Wecra today**:
- `VECTOR_SIMPLIFY {amount 0…1}`, with tolerance = `amount × 5 %` of the longer side (`engine/src/editor/ArrangeCommands.cpp:447-466`).
- A 0–100 range input in a popover applies on ✓ only, with no preview (`src/renderer/src/editor/canvas/CommandOverlays.tsx:191-228`).
- It accepts several targets, and TEXT_PATH is not excluded.

**Gap**:
- An engine tool state with a live preview: the original network kept, the simplified one shown, Apply commits one undo step, Cancel restores.
- `threshold` from −2 to 3 and tolerance `10^(−threshold)` in node px.
- Figma's enablement rule.
- The secondary toolbar in Figma's layout, replacing the popover.

## 9. Plugin vector network and geometry

**Figma** [static, high]:
- The `vectorNetworkBlob` decoder and encoder (`3187.min.js` module 70903).
- `setVectorNetwork` normalises:
  - vertex defaults: cap NONE, join MITER, radius 0, mirroring NONE;
  - every vertex gets a nonzero `styleID`, and vertices with equal override sets share one `styleOverrideTable` entry (keyed `cap|join|radius|mirror`);
  - a missing tangent becomes {0,0};
  - the bounds come from the vertices plus the exact cubic extrema;
  - the network is translated to (0,0), `normalizedSize = size = bounds`, and `relativeTransform` moves by the same offset.
- Validation errors cover bad segment indices, regions with no loops, empty loops and loops that do not connect.
- The live probes **did not run**.

**Wecra today**:
- `vectorPaths`, `vectorNetwork`, `fillGeometry` and `strokeGeometry` are stubs that return empty values (`src/renderer/src/editor/plugins/api/nodes.ts:406-410`).
- `handleMirroring` always reads "NONE".
- There is no `setVectorNetworkAsync` or `vectorPaths` setter.
- The engine has the codec (`engine/src/geometry/VectorNetwork.cpp:45-115`) and `writeVector`.

**Gap**:
- Getters through the engine (network JSON, paths as SVG `d`, fill and stroke geometry).
- The setter with Figma's normalisation and validation messages, as one NODE_CHANGES write (`vectorData`, `size`, `transform`).
- These are needed by every vector plugin and by `createTextPath`'s read-only `vectorNetwork`.

## 10. Offset path

**Figma** [static]:
- A tool (`OFFSET_PATH`) with a secondary toolbar:
  - a slider whose min and max come from the engine (`minSliderOffset` / `maxSliderOffset`), step 1, big step 5, starting at 0;
  - a join control, Miter (labelled "square") or Round, default MITER;
  - Cancel and Apply (✓), which returns to the default tool.
- Every change calls `setOffset` / `setJoinType`, then `apply()`: the preview is live, and Cancel reverts.
- Enabled for one vector-editable node that is not a text path, washi tape or stamp.
- A variable-width stroke is offset through its outline (`outlineStrokeForOffsetVWS`).

**Wecra today**:
- `VECTOR_OFFSET {amount, join}` applies once (`ArrangeCommands.cpp:564-604`, `689-693`).
- The popover has a numeric Amount from −1000 to 1000 and Join, applied on ✓ (`CommandOverlays.tsx:191-228`).
- No live preview and no engine-given range. A variable-width stroke is ignored.

**Gap**:
- A tool state like §8's, with `setOffset` / `setJoinType` / `apply` / `cancel`.
- The slider range from the engine: −min(w, h)/2 … a cap of ours, until a live check.
- Width points honoured through `strokePath`'s profile.

## 11. Built-in brushes: identity, loading, deletion

**Figma** [static]:
- A built-in brush is a BRUSH node on the internal canvas, identified by a 40-hex `assetKey` through a fixed name → key map (`2108.min.js @1072538`, e.g. HEIST → `7b23a313…`).
- The getter returns `CUSTOM` for any key outside the map.
- `loadBrushesAsync(type)` resolves at once if any BRUSH of that type is on the internal canvas. Otherwise it fetches one bundle per type and inserts all 15 stretch or 10 scatter brushes together (`insertBrushesFromBuffer`). [live: `loadBrushesAsync('STRETCH')` then HEIST worked.]
- The brush list carries `isSoftDeleted`, so brushes can be deleted and restored. The picker sorts by GUID.
- Create brush (stretch, scatter, and `-qc` quick-create variants) is enabled for exactly one node that uses the geometry cache, excluding frames.

**Wecra today**:
- Built-ins are matched by display name (`brushNameOf`, `src/shared/draw/apiShapes.ts:84-86`; `installedBrush`, `plugins/api/draw.ts`).
  - A Figma file's built-in BRUSH nodes, whose names are unknown to us, read as CUSTOM.
  - Ours would read as CUSTOM in Figma, which has no assetKey for them.
- `listBrushes` sorts by GUID (`DrawCommands.cpp:328-338`) but ignores `isSoftDeleted`.
- There is no delete. The schema already has `key` 319 and `isSoftDeleted` 330 (`schema/document.kiwi:2068`, `:1873`).
- `loadBrushesAsync` installs each built-in of the type (`plugins/api/draw.ts:226-235`). That matches Figma's "all of a type". The chrome installs one on first use.

**Gap**:
- Built-ins carry Figma's `assetKey` in `key` (319), from the name → key map (to extract in full from `2108.min.js`).
- Identity by `key` first, name second.
- Installing from the chrome installs the whole type, as Figma does. This answers `docs/draw.md` §11 question 3.
- Soft delete and restore of custom brushes (Brush menu › Delete; `isSoftDeleted = true`, still drawn for strokes that use it, hidden from the picker).
- Create brush gated as Figma (one node, geometry-backed, not a frame).

## 12. Drawing tool default style

**Figma** [static]:
- Pencil, Brush and Pen in Draw share one drawing style: `strokeWeight 4`, `strokeOpacity 1`, a black paint, or white when the UI theme is dark (`2622.min.js` `qB: 4`).
- The Eraser defaults to weight 10 with a ROUND cap.
- The style object is `{paints, styleId, strokeWeight, strokeOpacity, strokeCap, dashPattern, strokeBrushGuid, scatter/stretch/dynamicStrokeSettings}`.
- It is shared across all files (`SHARE_SAME_VALUE_FOR_ALL_FILES`) and synced with the engine's tool style tracker (`updateDrawingStyle(style, tool)`).

**Wecra today**:
- Pencil weight 2, Brush 4, black in both themes (`types.ts:100-102`).
- Kept per session in `ui.drawTools`.
- The Pen does not take the style.
- Neither style has a cap, dash or style id.

**Gap**:
- Weight 4 for both; theme-aware default colour; persisted per user across files (a main-process preference, like other editor preferences).
- The Pen in Draw mode uses the style.
- The style gains `strokeCap`, `dashPattern` and `styleId`.
- Eraser defaults, with §19.

## 13. Text on path

**Figma**:
- `createTextPath(node, startSegment, startPosition)` accepts vector-like nodes (vector, line, shape, brush) and RECTANGLE / ROUNDED_RECTANGLE.
  - Anything else throws "figma.createTextPath expects a vector, line, shape, or brush node" [live: frame and text refused with exactly that message].
  - The source node is removed and replaced [live: rect, ellipse, star, polygon, line and vector each accepted, then "node … does not exist"].
- `textPathStartData` reads `{segment, position}`, or null outside 0–1. The setter always writes `forward: true`.
- In memory the engine keeps `TextPathStartForSegment {segmentIndex u32, tValue f32, forward}`. The file's `TextPathStart` has only `tValue` and `forward`, so how the segment is packed is **unknown** [low]. The live probe **did not run**.
- UI [static]:
  - a Text path tool (`set-tool-text-path`);
  - **Combine text and path** (`combine-text-path-layers`, gate `canCombineTextAndPath`);
  - **Separate** (`separate-text-path-layers`, exactly one TEXT_PATH selected);
  - a **Flip** button in the Type panel header (`flipTextPathStartForSelection`, undo `flip-text-path-orientation`).

**Wecra today**:
- The tool, the start handle, Flip and CREATE_TEXT_PATH with `replace` are built (`DrawCommands.cpp:487-540`, `:853-891`; `tools/DrawTools.cpp`).
- The tValue encoding is segment + arc-length fraction (`engine/src/text/TextPathLayout.h:58`). Figma's `tValue` is more likely the Bézier parameter.
- Plugin sources: `VECTOR`, the rectangle types, `ELLIPSE`, `REGULAR_POLYGON`, `STAR`, `LINE`. The message is ours (`plugins/api/draw.ts:66`, `:74`).
- No Combine or Separate.
- CREATE_TEXT_PATH's state also accepts BOOLEAN_OPERATION via `vectorLike` (`DrawCommands.cpp:464-467`, `:927`).

**Gap**:
- COMBINE_TEXT_PATH: a TEXT plus a path layer become one TEXT_PATH that keeps the text's characters and styles, removing both sources, in one step.
- SEPARATE_TEXT_PATH: a TEXT_PATH becomes a TEXT plus a VECTOR.
- Figma's error message.
- Calibrate the tValue packing against a Draw `.fig` (`docs/draw.md` §11) before changing it. The encoding sits in one place (`textPathContour` / `textPathProject`, `tValueOf` / `splitTValue`).

## 14. Stroke settings limits

**Figma** [static]:
- The Miter angle row shows only for the MITER join. The UI edits an angle; the file stores the ratio.
- `strokeMiterLimit` accepts 1–16.
- Dash cap is its own control (NONE / SQUARE / ROUND), next to the start and end caps.
- At most 8 dash entries ("A maximum of 8 dash patterns is supported"), each positive.
- Cap size (`strokeCapSize` 497) sits behind `ce_il_stroke_endcap_custom_sizing`.
- The live probes **did not run**.

**Wecra today**:
- Miter angle shows only for MITER (`Stroke.tsx:482-497`, `miterAngle`, `:275-277`).
- Dash cap shows only for closed paths and writes `strokeCap` (`Stroke.tsx:451-465`), so an open dashed path has no dash cap row.
- The dash list has no length cap (`parseDashes`).
- The plugin has no `strokeMiterLimit` / `strokeCap` / `strokeJoin` validation (`nodes.ts:266` `dashPattern` only).
- `strokeCapSize` is a placeholder (`schema/document.kiwi:2163` `_r497`).

**Gap**:
- Dashes ≤ 8 and positive (panel and plugin).
- `strokeMiterLimit` 1–16 in the plugin and as the panel's angle range (16 ⇒ about 7.2°).
- The Dash cap row also for open dashed paths. Calibrate whether it is the same `strokeCap` field (Figma's schema has no separate dash cap field).
- `strokeCapSize` waits for the flag to ship.

## 15. Pencil fitting

**Figma** [static, medium] (`PencilVectorBehavior::bSplineNetworkFromPoints`):
- Each sample is `{x f64, y f64, pressure f32}`.
- A sample is skipped while its screen distance is under a member threshold divided by zoom, with a direction test and a pressure-change test as well.
- The kept samples are uniform cubic B-spline control points, converted to Béziers with the literal weights 0.66 / 0.33 and 0.5 midpoints. The curve smooths rather than interpolates.
- The threshold values were not recovered.

**Wecra today**:
- Ramer–Douglas–Peucker at 1 / zoom, then Catmull-Rom through the kept points (interpolating) (`engine/src/editor/VectorEditing.cpp:1682-1705`).
- No pressure.

**Gap**:
- Replace the fitting with Figma's B-spline conversion.
- The filter thresholds are ours until a sample (`geometry/PencilFit.{h,cpp}`, pure, tested).
- The vertex count and smoothness then match Figma's look; the exact thresholds wait for calibration.

## 16. Stylus pressure

**Figma** [static]: with a stylus and `enablePressureSensitivity` on (action `toggle-pressure-sensitivity`), Pencil strokes get variable-width points from pressure. Analytics: `pressure_sensitive_variable_width_points_added {addedPointsCount}`.

**Wecra today**:
- The chrome passes `ev.pressure` (`src/renderer/src/editor/canvas/Rulers.tsx:204` and the canvas), but the ABI drops it (`engine/src/api/Api.cpp:814` `double /*pressure*/`).
- No preference.

**Gap**:
- Pass pressure into the pencil samples.
- With the preference on and a pen pointer type, write `variableWidthPoints` from the pressure (positions along the fitted path, `ascent = descent = 0.5 × pressure` normalised).
- Add the preference (View or Preferences menu, Figma's wording).

## 17. Vector edit mode secondary toolbar

**Figma** [static]:
- Order: Select, Lasso | Paint bucket, Bend, Cut, Vector eraser (flag) | a button for whichever of Shape builder / Variable width is active, plus a "More tools" dropdown with both | Close.
- Variable width in the dropdown is disabled with the reason as a tooltip. Clicking Variable width again goes back to Select.
- Actions: `join-selection`, `smooth-join-selection`, `delete-and-heal-selection`, `break-vector-network-into-paths` (needs a complex network).
- Preference `penToolAvoidSingleHandles`.

**Wecra today**:
- The groups match live's capture (`src/renderer/src/editor/canvas/BottomToolbar.tsx:140-151`). The More menu is built (`:167-171`, `:198-232`).
- The active tool lights More instead of getting a slot of its own. Variable width's disabled entry has no reason.
- VECTOR_JOIN `{smooth}`, DELETE_AND_HEAL and SPLIT exist (`engine/src/editor/Commands.h:62`, `:158-159`). No break-network action and no pen preference.

**Gap**:
- The active-tool slot.
- The reason tooltip.
- Re-click goes back to Select.
- `break-vector-network-into-paths` (VECTOR_SPLIT's whole-layer form exposed under Figma's name).
- `penToolAvoidSingleHandles`.

## 18. Flatten and Outline stroke availability

**Figma** [static]:
- Flatten:
  - at least one selected node is not a spec node and the selection has geometry;
  - no instance sublayers (slot sublayers allowed);
  - no immutable frames, widgets, stamps, code embeds or JSX;
  - a layout edit mode.
- Outline stroke: the same, but every instance sublayer is forbidden.

**Wecra today**:
- FLATTEN refuses derived INSTANCE nodes only (`engine/src/editor/Commands.cpp:285-291`).
- OUTLINE_STROKE needs a stroke weight (`:292-300`).

**Gap**: refuse instance sublayers (derived GUIDs) for both, keeping slot content for Flatten.

## 19. Draw's Eraser

**Figma**:
- `VECTOR_ERASER` is a drawing tool with its own style: weight 10, ROUND cap.
- It erases the area under a stroked brush and splits paths (help: weight and shape in the right sidebar; right-click › Split vector).

**Wecra today**:
- Vector edit's Erase deletes every segment the trail crosses within `kSegmentReach` (`engine/src/editor/VectorEditing.cpp:1152-1175`).
- It has no weight or cap and does not cut a segment partway.

**Gap**:
- An area eraser: subtract the stroked trail (weight, cap) from each centre line.
- Cut the segments at the boundary and keep the outside pieces, as one VECTOR with a split network.
- Its style comes from §12.

## 20. Scatter brushes in SVG

**Figma** [static, medium]:
- SVG export writes a scatter stroke as one definition plus a `<use xlink:href>` per instance.
- The definition id is `stroke%d_f%s_w%s_aj%s_sj%s_r%s_s%lu_sw%s`: probably gap, wiggle, angular jitter, size jitter, rotation, seed and weight.
- Figma's SVG importer reads `data-figma-scatter` and `data-figma-scatter-ref`, parses that id and rebuilds the brush.

**Wecra today**: a brush stroke is written as its outline path (`engine/src/export/Scene.cpp:81-90`). There is no `<use>`, and the SVG import does not know these attributes.

**Gap**:
- An SVG option to write scatter strokes Figma's way, so files exported from Wecra re-import into Figma as brushes.
- Import of the same attributes. Field order to calibrate.

## 21. Skew modifier

**Figma**: `add-skew-modifier-to-selection`, behind `ce_il_slant`, drawn as a skewX (`ce_il_slant_on_node`).

**Wecra**: SKEW is passed through, not evaluated (`engine/src/geometry/Repeat.cpp`, `docs/draw.md` §4.2.3).

**Gap**: evaluate `skewX` / `skewY` as a shear about the content box when Figma ships the flag. The UI stays hidden until then.

## 22. Stroke align OFFSET and several strokes

**Figma** [static, medium]:
- Schema 106 has `StrokeAlign OFFSET = 3`, `strokeOffset` 554, and `StrokeData strokeData` 571 (`Stroke[]`, each with its own weight, paints, style, align, cap, cap size, join, miter, dashes, `pathTrim`, offset and `isDeleted`).
- The plugin's branching treatments list `pathTrim`, `strokeOffset` and `strokeData`, so they are live in the current build.

**Wecra today**:
- `StrokeAlign` has CENTER / INSIDE / OUTSIDE only (`schema/document.kiwi:404-408`).
- 554 and 571 are placeholders (`:2172`, `:2175`). `pathTrim` 542 is still a placeholder on main (`:2170`; Motion's round adopts it).

**Gap**:
- Adopt them with Figma's numbers when a sample shows them in use (`docs/draw.md` §4.1 rule).
- The stroker gets an offset, and the renderer, hit-testing and exporters iterate strokes.
- The Stroke panel gets per-stroke rows.
- XL; last.

## 23–25. Already matching

- **`vectorNetworkBlob`**: header, vertex, segment and region words, with `(styleID << 1) | NONZERO`, as Figma's (`engine/src/geometry/VectorNetwork.cpp:45-115`).
- **Booleans**: Figma uses Skia PathOps, with Clipper in some cases. Wecra uses Clipper2 with curve recovery (`engine/src/geometry/Boolean.cpp:6-96`). The results are equivalent, so no work. Euler-spiral GPU stroke expansion is Figma's performance path; ours is the CPU stroker (`Stroker.cpp`).
- **Shape builder, Bend, Lasso**: built in rounds 8, 12 and 15 (`engine/src/tools/ShapeBuilder.cpp`, `editor/VectorEditing.cpp`). Figma's internals (lasso regions, "Must be vector object for drag bending") agree.

---

## Integration plan (ordered)

Each step lists:
- **Engine**: the engine work;
- **Schema / NODE_CHANGES**: the fields it writes or adopts;
- **Panel / chrome**: the UI;
- **Tests**: the native tests (`npm run engine:test`) and Vitest.

A C++ change needs `npm run engine:build` before commit (the wasm is committed).

1. **Stroke kind rules** (S, P1; §1, §2):
   - Engine: `geom::isNeutralDynamic`; `dynamicSettingsOf` returns false for neutral; `widthProfileAllowed` uses it; `SET_STROKE_KIND` BASIC writes neutral (when present) and `strokeBrushGuid = kNoGuid`; DYNAMIC writes `kNoGuid` and defaults 0.75 / 0.3 / 0.5; wiggle clamp ≥ 0 only (geometry cap kept internal).
   - TS: `isNoBrushGuid` (`4294967295:4294967295` or `-1:-1`) in `guids.ts`, used by `strokeKindOf`, `complexStrokeOf` and REST; `DYNAMIC_DEFAULTS`; Draw slider maxima 2 / 5 / 1.
   - Schema / NODE_CHANGES: no new fields; the writes are `dynamicStrokeSettings` and `strokeBrushGuid` only.
   - Tests: `r7.draw_edit` (kinds' writes, neutral read as Basic), `draw.test.ts` (sentinel), a `.fig` fixture with Figma's Dynamic encoding.
   - Contract: `docs/draw.md` §4.3, §9.
2. **Width profiles** (S, P1; §3):
   - Engine and TS: presets 0.1875; reversed matching.
   - Plugin: getter for every kind, points always given, `width` = ascent; setter `ascent = descent = width`, complex-network refusal only, Figma's message.
   - Panel: Brush strokes allowed; the disabled reason as tooltip.
   - Tests: preset tables, Flip of each preset reads back as itself, plugin shapes (§3's live values).
3. **Keep width points and dashes across kind changes** (S, P2; §4):
   - Engine: drop the clears in `SET_STROKE_KIND` / `SET_STROKE_BRUSH`; rendering still ignores width points on Dynamic or dashed strokes.
   - Tests: points survive Dynamic → Basic.
   - Contract: `docs/draw.md` §4.3 / §4.5.
4. **Transform count 2–40** (S, P2; §6):
   - Plugin validation and messages; panel Count range; `REPEAT_COUNT_RANGE` for authoring only (the engine stays lenient on read).
   - Tests: plugin 1 / 41 refused, 2 / 40 accepted.
5. **Scatter defaults per brush** (M, P2; §5):
   - Assets: the 10 measured settings join `src/shared/draw/brushes/` (a `settings` field per scatter built-in), written as the BRUSH node's `scatterStrokeSettings` (449) by `installBrush`; base gap 0.9 for custom brushes.
   - Engine: `SET_STROKE_BRUSH` and the Brush tool write `{base, ...node, ...user}` and replace the old brush's settings.
   - Panel: slider maxima.
   - Tests: install carries settings, apply merges, user wins.
6. **Outline stroke and Flatten of Dynamic and Brush** (M, P2; §7, §18):
   - Engine: `VectorCommands.cpp` uses `exporter::strokeOf`; Flatten collects the same outline; instance-sublayer gates.
   - Tests: the outline equals the exported path; gates.
7. **Simplify vector tool** (M, P2; §8):
   - Engine: `Tool::SIMPLIFY_VECTOR` state (source network kept, preview written as a pending, uncommitted change; Apply = one step "Simplify vector", Cancel = none); `tolerance = 10^(−threshold)`; ABI `setThreshold` / `apply` / `cancel`; the enablement rule.
   - Chrome: a secondary toolbar (slider −2…3, step 0.01, start 3, icons, Cancel, ✓, Enter), replacing the popover.
   - Tests: threshold 3 leaves the network unchanged; −2 reduces it; cancel restores; one undo step.
8. **Plugin vector network and geometry** (L, P2; §9):
   - Engine: ABI reads (network JSON with per-vertex styles, `vectorPaths`, fill / stroke geometry as `d`); one write call taking the normalised network.
   - Plugin: Figma's normalisation and validation in `plugins/api/vectors.ts` (new).
   - Tests: Figma's rules (bounds with curve extrema, transform shift, shared `styleID`s, error messages).
   - To verify: the probes that did not run (vertex defaults, bounds).
9. **Offset path tool** (M, P3; §10): the §7 pattern, with `minSliderOffset` / `maxSliderOffset` from the engine, step 1 / 5, Miter "Square" / Round, and variable-width strokes offset through their outline.
10. **Brush identity and lifecycle** (M, P3; §11):
    - Data: the name → `assetKey` map from `2108.min.js` into `src/shared/draw/brushes/` (identifiers, not artwork); `key` (319) written on install; identity by `key`, then name.
    - Behaviour: install a whole type at a time.
    - Engine and chrome: `isSoftDeleted` (330) in `listBrushes`, and DELETE / RESTORE_BRUSH commands (new ids in the Draw block 322–329).
    - Plugin: `brushName` by key.
    - Tests: a Figma-keyed BRUSH reads as its built-in; a soft-deleted brush is hidden but drawn.
11. **Drawing style** (S, P3; §12):
    - Defaults weight 4, black / white by theme.
    - A persisted user preference across files (main-process preferences, through IPC).
    - The Pen in Draw takes the style; the style gains cap, dashes and `styleId`.
    - Tests: defaults per theme; the style reaches the Pen.
12. **Text on path completions** (M, P3; §13):
    - Engine: COMBINE_TEXT_PATH and SEPARATE_TEXT_PATH (one undo step each; the canvas menu and the Object menu with Figma's labels).
    - Plugin: Figma's error message, and BRUSH-stroked layers accepted.
    - The tValue calibration waits for `draw.fig`.
    - Tests: combine / separate round trip, styles kept.
13. **Stroke settings limits** (S, P3; §14): dashes ≤ 8 and > 0; miter 1–16 (plugin, panel angle min); the Dash cap row on open dashed paths.
14. **Pencil fitting** (M, P3; §15):
    - Engine: `geometry/PencilFit.{h,cpp}` (filter + B-spline → Béziers 0.66 / 0.33 / 0.5) replaces `pencilFinish`'s RDP + Catmull-Rom.
    - Tests: control-point conversion exact; vertex counts bounded.
15. **Stylus pressure** (M, P4; §16):
    - ABI: pressure and pointer type reach the pencil samples.
    - Width points from pressure; the `enablePressureSensitivity` preference.
    - Tests: synthetic pressure gives points.
16. **Vector toolbar and actions** (S, P4; §17): the active-tool slot, re-click to Select, the disabled reason, `break-vector-network-into-paths`, `penToolAvoidSingleHandles`.
17. **Draw's Eraser** (L, P4; §19): an area erase with weight and cap that splits segments; its style from step 11.
18. **SVG scatter brushes** (M, P4; §20): export `<defs>` + `<use>` with Figma's id and attributes as an option; import; field order calibrated against a Figma export.
19. **Skew modifier** (S, P5; §21): evaluate it when Figma ships it.
20. **OFFSET align and several strokes** (XL, P5; §22): adopt 554 / 571 (and `StrokeAlign OFFSET = 3`) with a sample; stroker offset; per-stroke rendering, hit-testing and export; Stroke panel rows.

## Still to verify (the probes that did not run, or no Figma sample yet)

- `textPathStartData` ↔ the file's `tValue` (the packing and the clamping), and what the replacement node created by `createTextPath` keeps (parent, index, name).
- `strokeMiterLimit` 1–16 and the 8-dash cap, live.
- `setVectorNetwork`'s normalisation and vertex defaults, live.
- Whether Basic leaves `dynamicStrokeSettings = {1,0,0}` in the file (needs a `.fig` export).
- Whether `outlineStroke` gives a Dynamic stroke's displaced outline or a brush's outline.
- The scatter SVG export's id field order.
- The Brush stroke's UI status for Variable width.
- How the width curve runs between three or more points.
- The Pencil filter thresholds.

All of these need a Professional-plan or fresh-quota Figma session, or the owner's Draw `.fig` (`docs/draw.md` §11).
