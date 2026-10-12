# Draw (contract, Phase 7 round 7; written 2026-10-12, docs only)

Figma Draw finished inside DesignerV2's Design editor: Draw mode's chrome (toolbar, secondary toolbar, illustration sidebar, thumbnail layers), **text on a path** (TEXT_PATH), **transforms** (Figma's transform groups with Linear / Radial repeat), **dynamic strokes**, **brushes** (the built-in set, the Brush tool, custom brushes) and **multi-edit** in vector edit mode. Most of the rest of Draw is already built (§2). This file decides the engine model, the chrome, the brush assets and the shared types. Ownership and merge order are in `docs/roadmap.md` "Round 7".

The owner set aside FigJam / Slides / Buzz / Sites + Make / Weave (2026-10-11). Old item **7c "editor types" is dropped**: Draw is a mode of a Design file in Figma ("Figma Draw is a set of visual design tools within the Figma Design editor"), not a file type. `FileMeta.editorType` stays `"design"`; `EditorType` / `pageType = 397` stay reserved (`docs/schema.md` §15.1).

Marks: **[unverified]** = our decision where Figma's own behaviour, wording or numbers could not be seen. Draw could not be captured live (`research/figma/live/draw/behaviour.md`: the built-in browser was not signed in). Every [unverified] item is listed for the capture in §11.

---

## 1. What Figma does (verified 2026-10-12)

Sources (help.figma.com unless said):
- Figma Draw overview: /hc/en-us/articles/31440394517143
- Draw with illustration tools (Pencil, Brush, custom brushes): /31440438150935
- Create patterns with transforms: /31440427042839
- Hands-on: an illustration with transforms, effects and text on a path: /32588834922391
- Hands-on: pattern fills, vector networks and effects: /33025308147223
- Use patterns as a fill or stroke: /31616030150167
- Edit vector layers (multi-edit, Lasso, Paint, Bend, Cut, Erase, Variable width): /360039957634
- Simplify a vector path: /33792593975575
- Apply and adjust stroke properties (Advanced stroke settings): /360049283914
- Blog "Introducing Figma Draw": https://www.figma.com/blog/introducing-figma-draw/
- Plugin API (Update 123, 2026-01-26): https://developers.figma.com/docs/plugins/updates/2026/01/26/version-1-update-123 — `TextPathNode`, `TextPathStartData`, `TransformGroupNode`, `TransformModifier`, `ComplexStrokeProperties`, `VariableWidthStrokeProperties`, `figma.createTextPath`, `figma.transformGroup`, `figma.loadBrushesAsync`
- Figma's schema: `research/figma/figma-schema-106.kiwi`

**Mode switch.** "Click **Draw** in the toolbar to open Figma Draw." To return, set the toggle to **Design**. Our live capture of the signed-in toolbar lists the switch as **Draw / Design / Motion (Beta) / Dev Mode** (`research/figma/live/README.md`). Anyone with "can edit" access can use Draw, on every plan.

**Toolbar.** Draw's toolbar has the quick-access tools **Pen**, **Brush** and **Pencil**. A secondary toolbar sets the stroke's fill (also worded "color"), weight ("size") and style before you draw. Shift while dragging draws a straight line. ⌘-click (Ctrl on Windows) on an existing stroke samples its fill, weight and style. Brush styles are in the toolbar's **Brush styles** menu and in Advanced stroke settings. The order of the toolbar, its other slots and the Brush tool's key were not seen.

**Right sidebar.** "A streamlined set of illustration-related properties with slider controls"; transforms are reached from it. The hands-on project names the sections it uses: Fill, Dimensions, Appearance, Effects, Alignment, Scale, Arc. The blog adds "sliders, larger previews, an extended stroke panel, and pre-selection of fills, stroke styles, and effects".

**Layers.** "The Layers section shows an enlarged visual preview of each layer's contents." Double-click a layer preview to zoom to that layer. The blog: thumbnails for frames, groups, shapes, vectors and images.

**Pencil and Brush.** Both create vector networks, with points placed automatically along the path; edit them later in vector edit mode. Pencil is for sketches and line work; Brush adds "texture and color for a more hand-painted look".

**Custom brushes.** Right-click a vector layer › **Create brush** › **Stretch brush** ("elongates the style along the stroke's length") or **Scatter brush** ("repeats the style along the stroke's length"). Only closed vector paths can be sources; for an open stroke, use **Outline stroke** first. The source can be "any single vector layer, such as a shape, a custom vector path, or a flattened text layer". Brushes are file-specific "unless you copy and paste a layer using the brush into another file".

**Built-in brushes** (plugin API `brushName`):
- Stretch: HEIST, BLOCKBUSTER, GRINDHOUSE, BIOPIC, SPAGHETTI_WESTERN, SLASHER, HARDBOILED, VERITE, EPIC, SCREWBALL, ROM_COM, NOIR, PROPAGANDA, MELODRAMA, NEW_WAVE (15).
- Scatter: BUBBLEGUM, WITCH_HOUSE, SHOEGAZE, HONKY_TONK, SCREAMO, DRONE, DOO_WOP, SPOKEN_WORD, VAPORWAVE, OI (10).
- A custom brush reads as `CUSTOM`.

25 = 15 + 10 is exactly the number of BRUSH nodes found on the internal canvas `0:2` of the owner's private file: 256 × 16 vectors (`docs/engine-build.md` "BRUSH nodes"). Figma copies its brushes into the file as BRUSH nodes.

**Stroke settings.** Advanced stroke settings have the stroke types **Basic stroke**, **Dynamic stroke** and **Brush stroke**. Our live capture shows the Stroke Type dropdown as Basic / Dynamic / Brush (`docs/editor.md` H40).
- Dynamic: **Frequency**, **Wiggle**, **Smoothen**. Plugin ranges: frequency 0.01–20, wiggle ≥ 0, smoothen 0–1.
- Brush: a **Brush** picker and **Direction** (stretch: FORWARD / BACKWARD).
- Scatter (plugin): gap ≥ 0.25, wiggle ≥ 0, sizeJitter 0–3, angularJitter −180…180, rotation −180…180.
- The Variable width tool is "not available on layers with dynamic or dashed strokes, or on branching vector networks".

**Text on a path.** Hover the edge of a vector object (a shape or brush stroke) with the **Text** tool (T) until the text-on-a-path icon shows by the cursor, then click and type. The text follows the path as you type.
- A handle sets where the text starts.
- Flip the text to the other side in the Typography section of the right sidebar (community answers; wording [unverified]).
- Our live capture also has **Text on path** as the second item of Type tools ▾ (`research/figma/live/README.md`; `ds/components/EditorToolbar.tsx`).
- Plugin: `figma.createTextPath(node, startSegment, startPosition)` accepts a vector, a rectangle / ellipse / polygon / star or a line. "Creating a TextPathNode changes the type of the original node". "The base vector network can't be modified after the TextPathNode is created". `TextPathStartData {segment, position 0–1}`.
- A TextPathNode has a subset of TEXT's properties: characters, font size / name, text case, letter spacing, text style, hyperlink, range styling, horizontal alignment LEFT / CENTER / RIGHT / JUSTIFIED and vertical alignment TOP / CENTER / BOTTOM. It also has `vectorNetwork` / `vectorPaths` (read-only). It has no auto-resize, line height or paragraph properties.

**Transforms.** Select an object, then choose from the right sidebar's **"Additional transform modifier"** menu: **Radial repeat** ("repeats the object around a central point") or **Linear repeat** ("horizontally or vertically in evenly spaced sequences"). Click the transform in the sidebar to open its **Transform** settings: number of repetitions and spacing. The hands-on project shows a **"Repeat"** panel with **Count** and **Gap**, and the group is named **"Repeat group 1"**.
- Transforms are non-destructive "like boolean operations". The object goes into a **transform group**, and the original stays selectable and editable; changes to it apply to every repeat. More objects can be added to the group.
- No layers are created. **"Apply transforms to selection"** turns the arrangement into real layers.
- Plugin: `TransformGroupNode` (`type 'TRANSFORM_GROUP'`, every GroupNode property plus `transformModifiers`); `TransformModifier = {type 'REPEAT' (only supported), count, unitType 'RELATIVE' | 'PIXELS', offset}` plus `repeatType 'LINEAR'` with `axis 'HORIZONTAL' | 'VERTICAL'`, or `repeatType 'RADIAL'`.
  - LINEAR's offset is "the distance along the axis"; RADIAL's is "the distance from the group's center to the repeated nodes".
  - RELATIVE is based on the child's size.
  - `figma.transformGroup(nodes, parent, index, modifiers)`.
- A forum report (April 2026): SVG export of a radial repeat wrote only the source shape. Figma's answer pointed to applying the transform first.

**Pattern fill.** In Fill, add a fill, choose **Pattern**, **Select source** (another layer in the same file), then set tile type, scale, spacing, alignment and opacity. The pattern updates when the source changes. The plugin can also set **pattern strokes**.

**Vector editing.**
- **Multi-edit**: select one or more vector layers and press Enter to edit them together; Shift-click adds a layer; ⌘-click switches to a layer outside the selection. The blog calls it "Multiple node editing".
- **Lasso** (Q) in the secondary toolbar: draw around points and paths, then move or delete them. Shift Delete deletes and heals.
- **Shape builder**, **Paint** (⇧B), **Bend**, **Cut** (X), **Eraser** (⇧E; weight and shape in the right sidebar; right-click › **Split vector** splits).
- **Variable width**: a pink handle on hover, Shift-click to select several, Delete removes, Control disables snapping.
- **Simplify vector** (a slider; destructive) and **Offset vector**: in the Vector menu; a March 2026 forum bug says they sat at the menu's end.
- **Rotation origin** (⌥R).

**Effects.** Noise, Texture, progressive Layer / Background blur.

**Export.** The help pages say nothing. Figma's SVG export of a repeat wrote only the source (above; a bug by Figma's own reply).

## 2. What DesignerV2 already has (repo, 2026-10-12)

| Feature | Status | Where |
|---|---|---|
| Draw ↔ Design switch | ◐ The toolbar's mode switch and View › "Switch to Draw" set `ui.mode = "draw"` and pick the Pencil; the toolbar, panels and Layers are Design's | `editor/commands.ts` `view.switch-to-draw`, `editor/devmode/devMode.ts` `Mode`, `editor/canvas/BottomToolbar.tsx`, `ds/components/EditorToolbar.tsx` `EDITOR_MODES` |
| Pencil (⇧P) | ✓ Freehand → VECTOR (round caps / joins, weight 2) | `engine/src/editor/VectorEditing.cpp` `pencilFinish`, `tools/Gestures.cpp` |
| Pen, shapes, arc | ✓ | engine.md §8.4 |
| BRUSH nodes, brush strokes drawn | ✓ STRETCH / SCATTER from imported `.fig`s (`strokeBrushGuid`, settings, `scatterBrushTransforms`), canvas + export | `engine/src/geometry/Brush.{h,cpp}`, `engine/tests/unit/render.brush.test.cpp`, `docs/engine-build.md` "BRUSH nodes" |
| Brush tool, built-in brushes, Create brush, Brush stroke UI | ✗ Stroke Type lists Dynamic / Brush but keeps Basic | `editor/panels/design/Stroke.tsx` ~379 |
| Dynamic strokes | ◐ 7a: drawn, bounded, hit and exported (§4.10); the commands and the UI are 7b–7d | `geometry/DynamicStroke.*` |
| Variable width, width profiles | ✓ round 12 | `geometry/VariableWidth.*`, `tools/VariableWidthTool.cpp`, `editor/widthProfile.ts` |
| Shape builder (M) | ✓ round 12 | `tools/ShapeBuilder.cpp` |
| Lasso (Q), Paint, Bend, Cut, Erase | ✓ rounds 8 / 15 | `editor/VectorEditing.cpp`, `canvas/BottomToolbar.tsx VECTOR_TOOL_GROUPS` |
| Multi-edit (several vector layers in edit mode) | ◐ `startVectorEditMany` holds them all but only the edited one shows its points; a click switches | `Editor.h startVectorEditMany`, `docs/editor.md` round 12 |
| Split / Simplify / Offset vector | ✓ | `editor/ArrangeCommands.cpp` (`VECTOR_SPLIT` 282, `VECTOR_SIMPLIFY` 283, `VECTOR_OFFSET` 284) |
| Rotation origin ⌥R | ✓ (view state, not stored) | `tools/CanvasTools.cpp`, `SHOW_ROTATION_ORIGIN` 236 |
| Pattern fill | ✓ round 7 (`PaintType PATTERN = 8`, Select source, tile type, spacing, alignment) | engine.md §6.5, `editor.md` #10 |
| Pattern **stroke** | ✓ 7a: was not drawn on the canvas (`setPaint` refused PATTERN); now drawn through the stroke (§4.10). SVG / PDF skip PATTERN paints | `render/Renderer.cpp drawStrokes` |
| Noise, Texture, progressive blur, Glass | ✓ round 7 | engine.md §6.5 / §6.7 |
| Text on a path | ✗ The Type tools ▾ item is listed but disabled | `ds/components/EditorToolbar.tsx` `text-on-path`; schema drops `TEXT_PATH` |
| Transforms (repeat) | ✗ The schema drops `TRANSFORM` 48 and `transformModifiers` 455 | — |
| Layers thumbnails | ✗ 32 px rows. The engine can render a node thumbnail | `panels/Layers.tsx ROW`, `engine_render_node_thumbnail` / `Engine.renderNodeThumbnailPixels` |
| Plugin API for Draw | ✗ | `editor/plugins/api/convert.ts`, `plugins/runtime/figma.js` |

## 3. Decisions

1. **Draw is a mode, not a file type.** Mode `"draw"` (`ui.mode`) changes the toolbar, the right panel and the Layers rows. The document is the same; Design and Draw edit the same nodes. Dev Mode is unchanged.
2. **Figma's schema, Figma's numbers.** TEXT_PATH and transform groups come back from `figma-schema-106.kiwi` (§4.1). No `@ours` fields this round.
3. **Derived, never journaled.** Repeats (copies), text-path glyph placement, dynamic-stroke and brush outlines are derived data (`engine.md` §3), rebuilt from source fields. Only source fields travel in `NODE_CHANGES`, so multiplayer, branching merges and undo need nothing new.
4. **New layers instead of changing a node's type.** No node changes its `type` (the engine has no type change).
   - The UI's Text on path makes a **new** TEXT_PATH layer and leaves the shape [unverified: Figma's UI "adds a new text layer"].
   - The plugin API's `createTextPath` removes the source and creates a TEXT_PATH in its place, with the same name, parent and index and a new GUID ("use the returned node").
   - "Apply transforms to selection" replaces a transform group with a GROUP in its place.
5. **Brush artwork is ours.** We author our own artwork, procedurally, under Figma's 25 brush names. Brushes enter a file as BRUSH nodes on the internal canvas `0:2`, as Figma's do, but only when first used. A `.fig` from Figma keeps its own BRUSH nodes and artwork; that is the user's file content.
6. **Exports draw what the canvas draws**: repeats as their copies, text on a path as placed glyphs, dynamic and brush strokes as their outlines (§4.8). We do not copy Figma's repeat-export bug.
7. **One undo step per user action**, with the names in §4.7.
8. Calibration against Figma comes from Figma's own stored derived geometry (`strokeGeometry`, `derivedTextData`, sizes) in a Draw `.fig` the owner exports. This is the geometry comparator method of engine.md §11.1. Until that file exists, the constants in §4.3–4.5 are ours and kept in one place each.

## 4. Engine (7a model and render, 7b tools and editing)

### 4.1 Schema (the main session's pre-round commit, §9)

Copied from `figma-schema-106.kiwi` with Figma's numbers, by `docs/schema.md` §15's rule. Each `_rN` placeholder is checked first; no `@ours` name collides (checked 2026-10-12: `_r424`, `_r425`, `_r432`, `_r455` are placeholders; ours are 1000–1002).

```
enum NodeType { … TEXT_PATH = 41; … TRANSFORM = 48; … }   // removed from the "Dropped" comment; the comment gains 59–64

message TextPathStart {          // Figma's
  float tValue = 1;              // where the text starts: segment index + position on it (0–1) [unverified encoding, §4.4]
  bool forward = 2;              // false: the text runs the other way along the path (Flip)
}

enum TransformModifierType { REPEAT = 0; SYMMETRY = 1; SKEW = 2; }
enum RepeatType { LINEAR = 0; RADIAL = 1; }
enum EffectAxis { X = 0; Y = 1; X_AND_Y = 2; }
enum UnitType { PIXELS = 0; RELATIVE = 1; }
enum RepeatOrder { FORWARD = 0; REVERSE = 1; }

message TransformModifier {      // Figma's, complete
  TransformModifierType type = 1;
  Vector offset = 2;             // LINEAR: x = the gap along the axis (y used for X_AND_Y); RADIAL: x = the radius gap
  bool visible = 3;
  uint count = 4;
  RepeatType repeatType = 5;
  EffectAxis axis = 6;
  UnitType unitType = 7;
  RepeatOrder order = 8;
  float skewX = 9;
  float skewY = 10;
}

// NodeChange
Vector rotationOrigin = 424;                 // kept for round trips; the ⌥R origin stays view state [unverified meaning]
uint vectorOperationVersion = 425;           // kept for round trips
TextPathStart textPathStart = 432;           // TEXT_PATH
TransformModifier[] transformModifiers = 455; // TRANSFORM, in order

// Glyph (derivedTextData)
byte _r8 = 8 [deprecated];                   // Figma's emojiImageSet (FigJam), a placeholder
float rotation = 9;                          // a glyph's turn on a text path, radians clockwise [unit unverified, §4.4]
```

- `EffectType REPEAT = 4 / SYMMETRY = 5` and `Effect` 14–18 stay dropped. They are Figma's older encoding, which `TransformModifier` supersedes; a `.fig` that still uses them loses them (counted in the import report).
- **Not adopted** (still reserved, unverified meaning): `multiEditGlueId 462` (it sits among Sites' responsive-set fields 457–461 and belongs to round 12, Sites; `docs/schema.md` §15.1 is corrected), `strokeCapSize 497`, `pathTrim 542`, `strokeOffset 554`, `offsetFillMaskGeometry 564`, `customEffects 569`, `strokeData 571` (`StrokeData` / `Stroke`: several strokes on one layer), `CUSTOM_EFFECT_INSTANCE 63`. Adopt one only when a Draw `.fig` shows it in use.
- Field metadata: all new fields are ordinary overridable fields. `textPathStart` and `transformModifiers` can be instance overrides; nothing is `@own`. `Glyph.rotation` is under `derivedTextData` (`@derived`).
- `.fig` import / export: `src/shared/fig/convert.ts` projects by field name, so TEXT_PATH and TRANSFORM nodes and their fields survive import → export once the schema has them. 7e adds a fidelity test (§8).

### 4.2 Transform groups (TRANSFORM 48)

**Model.** A TRANSFORM node is a group, with the same rules as GROUP (`engine.md` §4.5):
- children in its own space;
- no fills, strokes or clip of its own;
- effects, opacity, blend mode and mask as on a group.

It adds `transformModifiers`, applied in order. Name it "Repeat group N" ([unverified] numbering follows our "Group N" counter).

**Evaluation** (derived, `engine/src/scene` or `geometry/Repeat.{h,cpp}`):
1. Start with the children's content: one instance at identity, with box B = the union of the children's layout boxes in the group's space.
2. For each **visible REPEAT** modifier, replace the instance list with `count` copies of it. Copy k (k = 0 … count−1) is placed by M_k, and B becomes the union of all the copies' boxes:
   - **LINEAR**: M_k = translate(k·step). On axis X, step = (B.w + gap, 0); on Y, step = (0, B.h + gap); on X_AND_Y, step = (B.w + gapX, B.h + gapY). The gap is `offset` in px (PIXELS), or `offset × B.w` (or `× B.h`) for RELATIVE.
   - **RADIAL**: the pivot P = (B.centerX, B.bottom + r), with r = `offset.x` in px or `offset.x × B.h` for RELATIVE. M_k = rotate(k · 360° / count, about P), clockwise. The source stays on top and copies go clockwise around P.
   - `order`: FORWARD draws copy 0 (the source) lowest and the last copy on top; REVERSE draws the opposite.
3. SYMMETRY and SKEW are kept but not evaluated: they pass the content through. Figma's UI and plugin API offer REPEAT only.
4. Limits: `count` is clamped to 1…1000. A group draws at most 10,000 instances; past that it draws the first 10,000 and the layer gets the stroke-warning badge [ours].

All of step 2's geometry is [unverified]: the gap is measured edge to edge (Figma's panel says "Gap"), the radial pivot sits below the content, rotation is clockwise and copy 0 is the source. Calibrate on a sample (§11).

**Group box.** Like a GROUP, the TRANSFORM node's `size` / `transform` are system writes: the bounds of the evaluated instances, in the commit that changed them (`engine.md` §3.3–3.4). The selection box therefore covers the whole repeat. Children keep their own transforms.

**Rendering.** The render tree emits the children's subtree once per instance with M_k prepended. This uses the instanced path (`render/DrawInstance.h`), not real nodes. The content cache and tiles damage the group when any descendant changes (as PATTERN sources do, §6.5 round 8). Nested TRANSFORM groups multiply out under the 10,000 cap.

**Hit-testing.** A hit on any copy is a hit on the TRANSFORM group, as a click inside a group selects the group. Double-click or ⌘-click deep-selects the **source** child under the point: the hit maps back through M_k⁻¹ to the children. Hover outlines draw the group's box. The source child's outline draws at copy 0 only.

**Editing.**
- **ADD_TRANSFORM_MODIFIER** (310):
  - One TRANSFORM selected: append the modifier.
  - Otherwise: wrap the selection in a new TRANSFORM, as Group ⌘G does (same parent and index rules), with that modifier. Undo "Add repeat".
- **SET_TRANSFORM_MODIFIER** (311): a partial modifier at an index. A panel scrub coalesces into one step (`engine.md` §9.4).
- **REMOVE_TRANSFORM_MODIFIER** (312): removes it. A group with no modifiers stays a TRANSFORM and draws as a plain group [unverified].
- **MOVE_TRANSFORM_MODIFIER** (313): reorders.
- **APPLY_TRANSFORMS** (314), "Apply transforms to selection": each selected TRANSFORM is replaced, in place, by a GROUP with the same name. Its content is the source children (unchanged GUIDs, copy 0) plus, for k ≥ 1, duplicates of each child carrying M_k in their transforms. Nested groups are applied inside out. Undo "Apply transforms".
- Ungroup (⇧⌘G) on a TRANSFORM moves its children out and drops the modifiers, as for a group.
- Flatten (⌘E) flattens the evaluated geometry. Outline stroke and booleans read the evaluated geometry too.

**Plugin.** `figma.transformGroup(nodes, parent, index, modifiers)` = create a TRANSFORM at `parent` / `index` with `nodes` moved in and `modifiers`. Figma's doc says "each one applies to the node at the same position in `nodes`". We read that as a doc slip and apply the list to the group in order [unverified].

### 4.3 Dynamic strokes (`dynamicStrokeSettings` 448, `strokeSeed` 482)

**Stroke kind is implicit, as in Figma's schema:**
- **Brush**: `strokeBrushGuid` is set.
- **Dynamic**: `dynamicStrokeSettings` is present.
- **Basic**: neither.

Setting one kind clears the other's fields (`clearedFields`). Dynamic also clears `variableWidthPoints` and `dashPattern`, because Figma does not allow variable width with dynamic or dashed strokes.

**Geometry** (`engine/src/geometry/DynamicStroke.{h,cpp}`, new). `Path dynamicCenterline(const Path& center, double weight, const DynamicStrokeSettings&, uint64_t seed, double tolerance)` displaces each contour of the stroke's centre line along its normal. The ordinary stroker then strokes the result, with the node's caps, joins and alignment.
- Wavelength λ = `kDynWavelengthPx` / frequency, in node px. Knots sit every λ/2 of arc length. Each knot gets a value u ∈ [−1, 1] from a counter-based hash of (seed, contour, knot). Closed contours wrap the knots so the start meets the end.
- Displacement d(s) = `kDynAmplitude` · wiggle · weight · interp(u, s):
  - smoothen 0: linear between knots;
  - smoothen 1: Catmull-Rom between knots;
  - in between: a blend of the two.
- Smoothen also low-passes the input polyline. A moving average over a window of smoothen · λ/2 removes the hand jitter of Pencil strokes before displacement.
- First constants [unverified, calibrate on a sample's `strokeGeometry`]: `kDynWavelengthPx` = 100 (frequency 1 → one wave per 100 px) and `kDynAmplitude` = 0.5. No taper at open ends.
- `strokeSeed`: when a layer becomes Dynamic or Brush without a seed, the engine writes a random 64-bit seed in the same step. Duplicates keep their seed, so a copy looks the same.

**Everywhere a stroke outline is used**, dynamic strokes take the same path as brushes already do (`Brush.h brushStroke`):
- render bounds;
- hit-testing (distance to the outline);
- Outline stroke;
- SVG / PDF / PNG export;
- booleans and Flatten.

The outline is cached by (centre-line hash, settings, seed, weight, tolerance level).

### 4.4 Text on a path (TEXT_PATH 41, `textPathStart` 432)

**Model.**
- A TEXT_PATH node carries `vectorData` (its path network, as a VECTOR's: `vectorNetworkBlob`, `normalizedSize`) plus the text fields of TEXT: `textData`, font fields, `fontSize`, `letterSpacing`, `textCase`, `textDecoration`, `textAlignHorizontal`, `textAlignVertical`, run styling, `styleIdForText`, `hyperlink`, fills and strokes (they paint the glyphs). It also carries `textPathStart`.
- Ignored on TEXT_PATH (kept if present): `textAutoResize`, `lineHeight`, paragraph spacing and indent, lists, truncation, `leadingTrim`.
- `size` is the path's box (a VECTOR's rule: `normalizedSize` scaled to `size`). Resizing scales the path, not the type.
- The path itself is never painted. It shows only as a hover / selection overlay: a 1 px selection-colour line [unverified].

**`tValue` encoding** [unverified]: segment index + position on the segment, for example 2.5 = halfway along segment 2 in `vectorNetworkBlob` order. This matches the plugin API's `{segment, position}`. If a Figma sample shows otherwise, only `geometry/TextPath` and the plugin converter change.

**Layout** (`engine/src/text/TextPathLayout.{h,cpp}`, new; HarfBuzz shaping as `TextLayout`):
1. Shape the characters as **one line**. Line breaks become spaces; there is no wrapping. Letter spacing and text case apply; run styles keep their glyphs' fonts and sizes.
2. Walk the contour that holds segment ⌊tValue⌋. Arc length starts at s₀ (the point at tValue) and runs along segment order when `forward`, or against it when not.
3. Horizontal alignment places the line's advance width W relative to s₀:
   - LEFT and JUSTIFIED start at s₀;
   - CENTER centres the line on s₀;
   - RIGHT ends at s₀.
4. Each glyph's centre sits at arc length s = s₀ + x + advance/2. Its position is P(s) + n(s)·v, with tangent angle θ(s) and n the left normal of the travel direction (up from the text). The glyph is drawn rotated by θ, its origin advance/2 back along the tangent.
   - v depends on vertical alignment: **BOTTOM** puts the baseline on the path (v = 0); **CENTER** offsets by (ascent − descent)/2; **TOP** puts the ascent line on the path.
   - The Text on path tool writes `textAlignVertical BOTTOM` [unverified].
5. Overflow:
   - an **open** path does not draw glyphs whose centre falls before 0 or past the length;
   - a **closed** path wraps once and does not draw glyphs that would pass s₀ again.
   - Hidden glyphs keep their characters.
6. The result fills `derivedTextData` as TEXT's does, with `Glyph.rotation` = θ in radians [unit unverified]. Decorations (underline, strikethrough) are **not drawn** on a path; they are kept [ours, first version].

**Rendering.** Glyphs use the existing glyph shader with a per-glyph 2×2 rotation in the instance data (§7.5's instanced glyph path gains a rotation), along with text strokes and effects. Render bounds are the union of the rotated glyph boxes.

**Hit-testing.** The rotated glyph quads hit the node. On hover with the Text or Text on path tool, the node's path within 6 CSS px is a **path hit** (the tool's target).

**Editing.**
- Double-click or Enter edits the text (TextEdit unchanged).
  - The caret is a rotated bar at the glyph boundary.
  - Selection draws rotated quads.
  - Clicks map to the nearest glyph boundary.
- **The start handle**: a selected TEXT_PATH (not editing) shows a handle at s₀ [look unverified; ours: the vector-point handle in the selection colour].
  - Dragging it projects the pointer onto the path and writes `textPathStart.tValue` (gesture `TEXT_PATH_START`). One undo step: "Move text start".
- **FLIP_TEXT_PATH** (320) toggles `forward`.
- **SET_TEXT_PATH_START** (321) takes `{ref, segment, position}`.
- The path is not editable: Enter does not enter vector edit mode (plugin: "can't be modified"). Flatten (⌘E) gives the placed glyph outlines as a VECTOR.
- **Text on path tool** (new `Tool::TEXT_PATH`; also the Text tool's hover, as Figma's tutorial shows):
  - Over a VECTOR, rectangle, ellipse, polygon, star, LINE or brush-stroked layer's edge, the cursor becomes `TEXT_PATH` and the edge highlights.
  - A click creates a TEXT_PATH **above** that layer: same parent, transform and size, and a copy of its path. Shapes become their network: a rectangle starts at its top-left corner going clockwise, an ellipse at its rightmost point.
  - The start is the clicked point. The fill is the text tool's default (black, Inter Regular 12 [unverified]). Text editing starts empty, and the layer is removed if left empty, as TEXT.
  - Undo "Text on path".
  - Elsewhere, the Text on path tool does nothing; the Text tool makes ordinary text.
- **CREATE_TEXT_PATH** (319) takes `{ref, segment, position, replace: bool}`. `replace = true` is the plugin form: the source is removed and the TEXT_PATH takes its place, name, parent and index. It returns the new GUID.

### 4.5 Brushes (BRUSH 46, `strokeBrushGuid` 446, settings 449 / 450, `brushType` 452)

**Already drawn** (`Brush.{h,cpp}`). Added this round:
- **INSTALL_BRUSH** (an ABI call, §4.6): `{name, type, artwork {width, height, d, windingRule}}`.
  - If a BRUSH node with that `name` and `brushType` is already on `0:2`, its GUID comes back.
  - Otherwise a BRUSH node is created on `0:2` (a VECTOR-like network from `d`, `size` = width × height) and its GUID comes back.
  - It is a system write inside the open step (the Brush tool's stroke, or SET_STROKE_BRUSH's), so undoing the stroke removes the brush too.
- **SET_STROKE_BRUSH** (316) takes `{refs?, brush: guid}`. It writes `strokeBrushGuid`, the settings' defaults if absent and `strokeSeed`, and clears Dynamic, `variableWidthPoints` and `dashPattern`.
  - Defaults: stretch `{orientation FORWARD}`; scatter `{gap 1, wiggle 0, angularJitter 0, rotation 0, sizeJitter 0}` [unverified].
  - Undo "Change stroke".
- **SET_STROKE_KIND** (315) takes `{refs?, kind: "BASIC" | "DYNAMIC", dynamic?}`.
- **SET_BRUSH_SETTINGS** (317) takes `{refs?, scatter?: Partial, stretch?: {orientation}}`. A scrub coalesces.
- **CREATE_BRUSH** (318) takes `{ref, brushType}`:
  - The layer must be one vector-like layer whose fill geometry is closed. Otherwise it fails with `E_INVALID`, and the chrome toasts "Only closed paths can be used as brushes" [wording ours].
  - The new BRUSH node on `0:2` has the layer's fill geometry in its own box (its `size`) and the layer's name. The layer stays.
  - Undo "Create brush".
- **Clipboard.** Copy carries the BRUSH nodes the copied layers reference, as the clipboard carries components and styles (`engine.md` §10.7). Paste into a file that has a BRUSH of the same name, type and artwork hash reuses it; otherwise it installs the copy on `0:2` and remaps `strokeBrushGuid`.
- **Deleting brushes**: an unused BRUSH node stays (Figma has no "delete brush" UI that we know of) [unverified].
- **Brush tool** (new `Tool::BRUSH`) draws exactly as the Pencil (`pencilFinish`'s fitting). The finished VECTOR gets:
  - the tool's colour as `strokePaints`;
  - the tool's weight;
  - round caps and joins;
  - `strokeBrushGuid` = the tool's brush and `strokeSeed`.
  
  Shift draws a straight line; this also holds for the Pencil.
- **The tools' settings.** `setDrawToolSettings(DrawToolSettings)` (§9) sets what the Pencil and the Brush make. The Pencil can make Basic or Dynamic strokes [unverified: Figma's Pencil style choices].
- **⌘-click with Pencil or Brush** on a stroked layer samples its colour, weight and style into the tool's settings. The engine emits `DRAW_TOOL_SAMPLED {color, opacity, weight, kind, dynamic?, brush?}` (a new event kind); the chrome updates its settings and sends them back.
- `brushPreview({brush | artwork+type}, width, height, weight) → RGBA` draws the brush along a fixed S-curve, for the chrome's menus.

### 4.6 Multi-edit in vector edit mode

`startVectorEditMany` (round 12) becomes Figma's multi-edit:
- **Every** held layer shows its points and segments.
- Point selection is a set of `(node, vertex)` and `(node, segment)`. A click, Shift-click, marquee or Lasso selects across layers.
- Dragging moves the selection in every layer (each in its own space). Delete, Shift Delete (heal), Join and Split act per layer.
- Bend, Cut, Paint and Erase act on the layer under the pointer.
- Shift-click on a layer outside the held set adds it. ⌘-click on one switches to it alone (Figma).
- The panel's X / Y show Mixed across layers.
- Each gesture is one undo step over all touched layers.
- The `VECTOR_EDIT` event gains `nodes: Guid[]` and `selection: {node, vertices[], segments[]}[]`. Single-layer editing is the one-element case.

### 4.7 Commands, tools, cursors, events, undo names

- **CommandId** (Commands.h, a new block "Round 7 — Draw: 310–329", mirrored in `src/renderer/src/engine/abi.ts`):
  - 310 ADD_TRANSFORM_MODIFIER
  - 311 SET_TRANSFORM_MODIFIER
  - 312 REMOVE_TRANSFORM_MODIFIER
  - 313 MOVE_TRANSFORM_MODIFIER
  - 314 APPLY_TRANSFORMS
  - 315 SET_STROKE_KIND
  - 316 SET_STROKE_BRUSH
  - 317 SET_BRUSH_SETTINGS
  - 318 CREATE_BRUSH
  - 319 CREATE_TEXT_PATH
  - 320 FLIP_TEXT_PATH
  - 321 SET_TEXT_PATH_START
  - 322–329 reserved
  - Command args are as in §4.2–4.5; their JSON shapes are the TS types of §9.
- **Tools**: `Tool::BRUSH` and `Tool::TEXT_PATH`, appended after EYEDROPPER (ABI indices stay stable; `abi.ts TOOLS` appends "BRUSH", "TEXT_PATH").
- **Cursors**: `CursorKind` appends BRUSH and TEXT_PATH.
- **Gestures**: `TEXT_PATH_START` (the start handle), `BRUSH` (as Pencil).
- **ABI** (`engine/src/api/DrawApi.inc` + one `#include` line in `Api.cpp`, `engine/api/exports.txt`):
  - `engine_install_brush(h, json) → {guid}`
  - `engine_list_brushes(h) → [{guid, name, type}]`
  - `engine_brush_preview(h, json, w, h, weight) → RGBA`
  - `engine_set_draw_tool_settings(h, json)`
- **Events**: `DRAW_TOOL_SAMPLED` (§4.5); `VECTOR_EDIT` extended (§4.6).
- **Undo names**: "Add repeat", "Change repeat", "Remove repeat", "Apply transforms", "Change stroke", "Create brush", "Text on path", "Move text start", "Flip text path", "Brush" (a brush stroke; Pencil's is "Pencil" as today).

### 4.8 Export (PNG / JPG / SVG / PDF, REST images, previews)

Every exporter reads the evaluated scene (`export/Scene.cpp`):
- **Repeats** are written as the copies.
  - SVG: a `<g>` for the group; each instance a `<g transform="matrix(…)">` around the children's elements, the source first. No `<use>`, for compatibility.
  - PDF: the content stream with a `cm` per instance.
- **Text on a path**:
  - outlined (SVG's default "Outline text", and PDF): placed glyph outlines;
  - SVG with "Outline text" off: `<text>` with one `<tspan>` per glyph carrying `x`, `y` and `rotate` [ours; `<textPath>` would rely on the viewer's layout].
- **Dynamic and brush strokes**: their outline, a filled `<path>` with the stroke paints. "Simplify stroke" does not apply.
- **Pattern strokes** fill the stroke outline through the pattern (7a checks the canvas and the exporters).
- The developer preview (`docs/data.md` §13) carries derived geometry, so the viewer draws all of this with no new code.

### 4.9 Tests (native, `engine/tests/unit/r7.draw.test.cpp` and siblings)

- **Repeat**:
  - linear X / Y / XY in PIXELS and RELATIVE;
  - radial count 1 / 2 / 8;
  - order;
  - nested groups;
  - the 10,000 cap;
  - group bounds as a system write;
  - hit mapping to the source;
  - APPLY_TRANSFORMS output = the evaluated instances;
  - undo of each command.
- **Dynamic**:
  - determinism by seed;
  - frequency changes the wave count;
  - wiggle 0 equals Basic;
  - smoothen 1 is C¹ at the knots;
  - closed contours meet;
  - bounds and hit-testing use the outline.
- **Text path**:
  - placement on a straight line equals TEXT's baseline glyphs;
  - on a circle, glyph angles follow the tangent;
  - alignments;
  - forward / backward;
  - overflow hidden on open paths;
  - caret positions;
  - start-handle drag;
  - CREATE_TEXT_PATH from each shape type, with `replace` true and false;
  - Flatten.
- **Brushes**:
  - INSTALL_BRUSH is idempotent by name and type;
  - SET_STROKE_BRUSH clears Dynamic and width points;
  - CREATE_BRUSH refuses an open path;
  - copy / paste carries and dedupes BRUSH nodes;
  - the Brush tool's stroke;
  - ⌘-click sampling.
- **Multi-edit**: a marquee across two layers moves both; undo is one step.
- **Export**: SVG / PDF of each (structure and bounds), including a pattern stroke.
- **Wasm** (`src/renderer/src/engine/__tests__/draw.wasm.test.ts`): each ABI call and command through `Engine.ts`.

### 4.10 As built (7a, 2026-10-12)

Derived geometry only; nothing new is journaled. Native tests: `engine/tests/unit/r7.draw.test.cpp` (16 cases). No wasm build (7b builds the round's release wasm).

**Scene** (`scene/Node.{h,cpp}`, `CodecKiwi.cpp`):
- `NodeType::TEXT_PATH = 41` and `TRANSFORM = 48`, named, read from kiwi and JSON.
- `NodeProps::isGroupLike()` includes TRANSFORM, so a transform group is a group everywhere (layout, selection, ungroup, marquee, effects).
- `isTransformGroup()`, and `isTextLike()` (TEXT or TEXT_PATH).
- `defaultProps(TEXT_PATH)`: black fill, OUTSIDE stroke, `textAlignVertical BOTTOM`.

**Transform groups** (`geometry/Repeat.{h,cpp}`):
- `geom::evaluateRepeat(modifiers, contentBox, cap)` → `RepeatResult {instances, bounds, capped}`. It follows §4.2 exactly (LINEAR X / Y / X_AND_Y, RADIAL clockwise about `(B.cx, B.bottom + r)`, PIXELS / RELATIVE, FORWARD / REVERSE, SYMMETRY / SKEW passed through, count clamped to 1…1000, at most 10 000 instances).
- `transformModifiersOf(props)` decodes `transformModifiers` once per distinct bytes.
- `repeatContent(doc, id, box)`: the union of the visible children's layout boxes.
- `repeatOf(doc, id)`: the cached result, keyed by the content box and the modifier bytes.
- `repeatAncestor(doc, id)`: the innermost enclosing TRANSFORM.
- **Bounds**: `Layout::natural` and `Layout::fitGroup` size a TRANSFORM to its instances' bounds (a system write, children shifted as for a group). `Editor::markDirty` lays a TRANSFORM out when its `extra` changes, i.e. its modifiers.
- **Render**: `Renderer::drawRepeat` draws the children once per instance. Each copy is culled on its own; copies other than the source draw with culling off, as pattern tiles do. Nested groups share one budget of 10 000 copies (`repeatScale_`).
  - `RenderTree::bound` unions every copy into the group's visual bounds.
  - `RenderTree::damageRepeats` damages the whole group when anything inside it changes.
- **Hit-testing** (`hit/HitTest.cpp`): a TRANSFORM candidate tests all its copies, topmost first, each point mapped back through M_k⁻¹ to the source layers. Copies the point is outside of are skipped by their content's render bounds. Layers inside a TRANSFORM are not hit on their own. The path ends at the source layer, so `pick` selects the group and ⌘ deep-selects the source.
- **Booleans** read every copy of a TRANSFORM operand (`NodeGeometry` collect).
- **Export**:
  - SVG writes `<g>` around one `<g transform="matrix(…)">` per copy, the source first and bare (element ids repeat in the copies);
  - PDF writes the content once per copy under `q … cm … Q`;
  - export bounds (`contentBounds`) hold every copy.

**Dynamic strokes** (`geometry/DynamicStroke.{h,cpp}`):
- `geom::dynamicCenterline(center, weight, settings, seed, tolerance)` implements §4.3 with `kDynWavelengthPx = 100` and `kDynAmplitude = 0.5`.
  - The contour is resampled every λ/16; the low pass is a moving average over smoothen · λ/2.
  - The knots come from a counter-based hash (splitmix64) of (seed, contour, knot). A closed contour's knots wrap.
  - **Wiggle 0 returns the centre line unchanged** (exactly Basic).
- `geom::dynamicWave(...)` gives the displacement alone (tests, bounds).
- `dynamicSettingsOf(props)` clamps to the plugin ranges; a brush stroke is never dynamic. `strokeSeedOf(props)`.
- `dynamicCenter(props, geometry, tol, out, key)` returns the displaced centre, cached by (centre line, settings, seed, weight, tolerance level).
- **Used by**:
  - the renderer (the ordinary stroker on the displaced centre; rectangles and ellipses leave the SDF path);
  - render bounds (`Document::outerStroke`: the wave's reach, brushes' weight × (1 + wiggle + size jitter));
  - hit-testing (the displaced centre; brushes: inside their outline);
  - the exporters (`exporter::strokeOf`: dynamic → the displaced centre, outline only; brush → the artwork outline as a ring).

**Text on a path** (`text/TextPathLayout.{h,cpp}`):
- `text::layoutTextPath(props, network)` follows §4.4. It shapes one line (line breaks become spaces, offsets kept) with `layoutText` and places each glyph centre at `s₀ + shift + x + advance/2` along the path. Glyphs turn with the path (`LaidGlyph::rotation`, radians clockwise). Glyphs off an open path's ends, or past one turn of a closed one, are dropped from `glyphs` (the characters stay). Decorations and links are cleared.
- The tangent eases across a flattened curve's pieces; a turn sharper than ~15° is a real corner and keeps each side's direction.
- `TextLayout::path` (`TextPathMap`): `frameAt(x)`, `toNode(straight point)`, `arcAt`, `onPath`, `sample`. It maps the straight line's coordinates (`caretXs`, `selectionRects`) onto the path, for 7b's caret, selection and click mapping.
- `textPathStartOf(props)` reads `textPathStart` (absent: 0, forward).
- `textPathContour(net, data, size, tValue, …)` gives where tValue lands (the tValue encoding of §4.4: segment + arc-length fraction, segment direction = forward).
- `textPathProject(net, data, size, point, tValue)` gives the nearest tValue (the start handle and the Text on path tool's click).
- `text::glyphMatrix(glyph)` is used everywhere glyphs become outlines or instances: `TextRender`, `NodeGeometry` (Flatten, strokes), `exporter::glyphPath`, PDF text. `Glyph.rotation` (9) is read and written in `derivedTextData` (`text/DerivedText`), and `Editor::encodeDerivedFields` stores a TEXT_PATH's layout.
- `Editor::textLayout` lays out a TEXT_PATH (cached by its size; falls back to stored derived text while its fonts load). `GeometryCache::setTextPathSource` / `textPathLayout(id)` give the geometry and hit-testing its glyphs (set in `Editor::Editor`).
- Render bounds grow by 1.5 × the largest font size (`Document::derive`). Hit-testing uses the turned glyph boxes (advance × ascent…descent).
- The hover and selection outline draws the path itself (`Overlay` `nodeOutline`).
- SVG with Outline text off writes one `<text><tspan x y rotate>` per glyph; outlined, the placed glyph paths. Greeking is off for path text.
- `hitsEdge(doc, id, local, slop)` (`hit/HitTest.h`) is the Text on path tool's edge target.

**Pattern strokes** were not drawn on the canvas (`setPaint` refused PATTERN). `Renderer::drawStrokes` now sends each PATTERN stroke paint through `drawPattern(…, stroke = true)`: the tiles cover the box plus the stroke's reach and show through the stroke's own outline (`drawStrokePaints` in white as the mask). The vector exporters still skip PATTERN paints, for fills and strokes alike (PNG / JPG draw them); see the open items.

**For 7b** (the internal APIs to call):
- Commands:
  - `transformModifiersOf` / `repeatOf` / `repeatContent` for ADD / SET / REMOVE / MOVE_TRANSFORM_MODIFIER;
  - APPLY_TRANSFORMS: duplicate children with `inst` prepended to their transforms, k ≥ 1;
  - Flatten / Outline stroke: walk `repeatOf` instances, and `dynamicCenter` / `brushStroke` for the stroke outline (`exporter::strokeOf` / `strokeOutline` already do this).
- Text path tools: `textPathProject` (TEXT_PATH_START gesture and the tool's click), `textPathContour`, `TextLayout::path->frameAt` (caret, selection quads), `hitsEdge` (hover target), `layoutTextPath`.
- CREATE_TEXT_PATH from a shape needs the shape's network: `geom::networkFromPath(doc.geometry(id)->stroke.path, …)`. A rectangle's path starts at the top-left, going clockwise; an ellipse's at its rightmost point (`geom::ellipsePath`).
- `RepeatResult::capped` for the layer's stroke-warning badge.

**Open (7a)**:
- SVG / PDF don't write PATTERN paints (fills or strokes) as vectors.
- In SVG, copies repeat the children's `id` attributes.
- Decorations on a path aren't drawn (as decided).
- Every constant in §4.2–4.4 still waits for a Draw `.fig` (§11).

## 5. Draw chrome (7c toolbar and tools, 7d panels and layers)

All wording is Figma's where §1 quotes it, otherwise [unverified]. Colours and sizes come from the DS tokens (`docs/design-system.md`).

### 5.1 Toolbar in Draw mode (7c; `ds/components/EditorToolbar.tsx` gains a Draw tool set)

- **Order**, left to right: Move tools ▾ (Move V, Hand H, Scale K) │ Shape tools ▾ (as Design) │ **Pen** P │ **Pencil** ⇧P │ **Brush** B │ Type tools ▾ (Text T, **Text on path**) │ Comment tools ▾ │ Actions │ the mode switch.
  - Pen, Pencil and Brush are their own slots, not a Creation tools ▾ menu ("quick-access tools").
  - Frame and Section are not in Draw's toolbar [unverified]. ⌘-key shortcuts for frames still work.
  - Brush's key B is [unverified].
- **Text on path** is enabled in Type tools ▾ in both Design and Draw, since it is now built.
- The **Brush styles** menu sits in the secondary toolbar (§5.2) [unverified: Figma says "the Brush styles menu in the toolbar"].

### 5.2 Secondary toolbar (7c; `editor/draw/DrawToolSettings.tsx`, new)

While the Pencil or the Brush is the tool, a secondary toolbar sits above the main toolbar, like vector edit's (`VectorEditToolbar`, same DS `Toolbar secondary`):
- a **colour swatch** (opens the colour picker; opacity included);
- **weight**: a number field with a slider popover, 0.5–100 [ours];
- **style**:
  - Pencil: "Basic" / "Dynamic" (with Frequency / Wiggle / Smoothen in its popover);
  - Brush: the **Brush styles** menu (§5.4), showing the current brush's preview and name.

The settings live in `ui.drawTools` (uiStore) and go to the engine with `setDrawToolSettings` on change and on mode entry. Defaults:
- Pencil: black, weight 2, Basic (today's Pencil);
- Brush: black, weight 4, HEIST [unverified].

They persist per session [ours].

### 5.3 Right panel in Draw mode (7d; `editor/draw/panels/`, `panels/RightPanel.tsx`, `panels/design/DesignPanel.tsx`)

- **No Prototype tab** in Draw [unverified]. The Design tab keeps the order of Figma's hands-on list.
- Sections:
  - Header (layer type and name)
  - Alignment
  - Dimensions (W, H, rotation)
  - Appearance (opacity, corner radius, blend)
  - **Transform** (§5.5)
  - Typography (text and text paths)
  - Fill
  - Stroke
  - Effects
  - Export
- Draw does **not** show:
  - Auto layout
  - Layout grid
  - Constraints and resizing
  - Component properties (instances still show their swap header)
  - Variables modes
  - Selection colors [unverified]
- **Sliders**: next to the number field for opacity, stroke weight, corner radius, effect radius / spread / opacity, noise and texture size / density, and the Dynamic and Scatter fields. A new DS `Slider` component holds a 2 px track, a 10 px thumb and the `--figma-color-*` tokens; the field and the slider show the same value, and dragging scrubs (one undo step).
- **Larger previews** in Fill / Stroke / Effects rows (paint swatches) [blog: "larger previews"; size unverified, ours 24 px].

### 5.4 Stroke settings: Dynamic and Brush (7d; `panels/design/Stroke.tsx`)

- **Stroke Type** sets the kind:
  - Basic → SET_STROKE_KIND BASIC;
  - Dynamic → SET_STROKE_KIND DYNAMIC with the defaults of §9;
  - Brush → SET_STROKE_BRUSH with the last-used brush (installed first through `installBrush` when it is a built-in).
- **Dynamic**: Frequency, Wiggle, Smoothen. Each is a number field with a slider, clamped to the ranges of §9.
- **Brush**: the **Brush** picker (§5.6), then the settings for the brush's type:
  - stretch: **Direction** (Forward / Backward);
  - scatter: **Gap**, **Wiggle**, **Size jitter**, **Angular jitter**, **Rotation** (labels from the plugin field names [unverified]).
- Width profile stays disabled for Dynamic, Brush and dashed strokes (Figma).

### 5.5 Transform section (7d; `editor/draw/panels/TransformSection.tsx`)

- **Title**: "Transform" [unverified]. In Draw it shows for any selection that can be grouped; in Design it shows only when a TRANSFORM is selected [ours].
- **"+" button**: "Additional transform modifier" (its tooltip), a menu with **Linear repeat** and **Radial repeat** → ADD_TRANSFORM_MODIFIER.
- **Rows**: one per modifier, "Linear repeat" / "Radial repeat", each with:
  - an eye (`visible`);
  - "−" to remove;
  - drag to reorder.
- **Clicking a row** opens the **"Repeat"** popover:
  - **Count**;
  - **Gap**, a number with a px / % unit toggle (PIXELS / RELATIVE);
  - Linear only: an **Axis** segmented control (Horizontal / Vertical);
  - **Order** (Forward / Reverse) [unverified].
- **"Apply transforms to selection"**: a button under the rows, also in the canvas menu for a TRANSFORM → APPLY_TRANSFORMS.
- The **Layers** icon for TRANSFORM is the repeat glyph (new icon `16.repeat`).

### 5.6 Brush styles menu and picker (7c owns the component, 7d uses it in Stroke)

`editor/draw/BrushMenu.tsx`:
- A list of 240 × 32 rows [ours], each the brush preview (`brushPreview`, cached per brush and theme) and its name.
- Sections: **Stretch**, **Scatter**, **Custom** (this file's BRUSH nodes that aren't built-ins) [section names unverified].
- The current brush is ticked.

### 5.7 Commands and menus (7c; `editor/commands.ts`, `editor/menus.ts`)

- `tool.brush` "Brush" (B) and `tool.text-on-path` "Text on path" (no key).
- `object.create-brush.stretch` "Stretch brush" and `object.create-brush.scatter` "Scatter brush", in the canvas menu's **Create brush** submenu, enabled for one vector-like layer. Help names the submenu; its position is [unverified]: we put it after Outline stroke.
- `object.apply-transforms` "Apply transforms to selection".
- `text.flip-path`: "Flip" in Typography (§5.8), and the canvas menu for a TEXT_PATH.
- `view.switch-to-draw` stays. It no longer forces the Pencil: Draw starts on Move [unverified].

### 5.8 Typography for a TEXT_PATH (7d; `panels/design/Typography.tsx`)

- The **same section as TEXT**, minus auto resize, line height, paragraph spacing, lists and truncation, plus a **Flip** button (icon `24.text-path-flip`, tooltip "Flip text orientation" [unverified wording, forum]) → FLIP_TEXT_PATH.
- Alignment: Left / Center / Right / Justify and Top / Middle / Bottom (they mean §4.4's placement).

### 5.9 Layers with thumbnails in Draw mode (7d; `panels/Layers.tsx`)

- In Draw, rows are **48 px**, each with a **32 × 32 thumbnail** in place of the type icon [sizes unverified]. The name and the controls (lock and eye) are unchanged.
- **Thumbnail rendering**:
  - drawn by `Engine.renderNodeThumbnailPixels({node, maxSize: 64})` (2× for retina), for visible rows only;
  - cached by the node's content key and refreshed on the engine's `DOCUMENT_CHANGED` for that subtree, at most 8 a frame, while idle;
  - kept as `ImageBitmap`s in an LRU of 512.
- **Double-click on the thumbnail** zooms to the layer (as Zoom to selection; ⇧2). A double-click on the name still renames.
- Design mode keeps 32 px rows.

## 6. Brush assets (7e; `src/shared/draw/brushes/`)

- **Our own artwork, generated.** `src/shared/draw/brushes/generate.ts` builds each brush's `BrushArtwork` from a recipe and a fixed seed. It is deterministic, pure TS and needs no assets. `scripts/brushes.mjs` writes `builtin.generated.json`, which is committed; `index.ts` exports `BUILTIN_BRUSHES: BuiltinBrush[]` from it. Nothing is traced from or modelled on Figma's artwork; only the names are Figma's (the plugin API's enum), so plugins and `.fig` round trips agree.
- **Sizes**:
  - stretch: 256 × 16 (the size of Figma's BRUSH nodes);
  - scatter: 64 × 64.
  - Regions are closed and NONZERO.
  - At most 400 path commands each; the file stays under 120 KB.
- **Display names**: the enum in title case with spaces ("Spaghetti Western", "Rom Com", "Doo Wop", "Witch House", "Oi") [Figma's display forms unverified].
- **Recipes** (stretch; x runs along the stroke, y across, the artwork filling the 16 px height at its thickest):

  | Key | Ours |
  |---|---|
  | HEIST | a calligraphic ink stroke, pointed at both ends, a slight asymmetric swell |
  | BLOCKBUSTER | a broad flat marker, square ends, faint streaks (3 inner gaps) |
  | GRINDHOUSE | a dry brush: ragged edges (noise amplitude 25 %), 4–6 random gaps through the body |
  | BIOPIC | a fine pen: thin (40 % height), a gentle pressure swell in the first third |
  | SPAGHETTI_WESTERN | bristles: 5 parallel streaks of varying width that start and end at random |
  | SLASHER | a fast slash: thick start, long taper to a point |
  | HARDBOILED | charcoal: a full body with a fine noisy edge (high-frequency noise 10 %) |
  | VERITE | pencil grain: a thin body broken into short speckles |
  | EPIC | a thick–thin wave: width varies as a sine over the length |
  | SCREWBALL | a wobbly line whose centre wanders ± 20 % |
  | ROM_COM | a soft round marker: round ends, even width |
  | NOIR | ink with splatter: a tapered body plus 6–10 small blobs beside it |
  | PROPAGANDA | woodcut: a chunky body with notched straight-cut edges |
  | MELODRAMA | a dramatic swell: thin ends, a wide belly at 60 % |
  | NEW_WAVE | a double line: two thin parallel strokes |

  Scatter stamps (64 × 64, centred):

  | Key | Ours |
  |---|---|
  | BUBBLEGUM | a circle |
  | WITCH_HOUSE | a five-point star |
  | SHOEGAZE | a cluster of 3–5 soft dots |
  | HONKY_TONK | a leaf (two arcs) |
  | SCREAMO | a jagged shard |
  | DRONE | a square |
  | DOO_WOP | a ring |
  | SPOKEN_WORD | a short rounded dash |
  | VAPORWAVE | a triangle |
  | OI | an irregular splat blob |

- **Storage.** Installed into a file on first use as BRUSH nodes on `0:2`, named by display name (§4.5). The chrome's menu lists built-ins from `BUILTIN_BRUSHES` and custom brushes from `engine.listBrushes()`. The plugin API's `loadBrushesAsync(type)` installs every built-in of that type.
- **Tests**: determinism (hash of the JSON), every region closed, sizes and command budget, names = the enum.

## 7. Plugin API, REST, Dev Mode (7e)

- **Plugin API** (`editor/plugins/api/`, `plugins/runtime/figma.js`; `docs/plugins.md`), as on developers.figma.com:
  - `TextPathNode` (`type 'TEXT_PATH'`, `textPathStartData {segment, position}`, the text subset of §1, read-only `vectorNetwork` / `vectorPaths`);
  - `figma.createTextPath(node, startSegment, startPosition)` → CREATE_TEXT_PATH with replace;
  - `TransformGroupNode` (`type 'TRANSFORM_GROUP'`, `transformModifiers`; LINEAR `axis HORIZONTAL` ↔ X, `VERTICAL` ↔ Y);
  - `figma.transformGroup`;
  - `node.complexStrokeProperties`: BASIC / DYNAMIC / BRUSH with `brushName` = the BRUSH node's built-in key, else `'CUSTOM'` (setting `CUSTOM` throws, as in Figma);
  - `node.variableWidthStrokeProperties` (round 12's points);
  - `figma.loadBrushesAsync`;
  - pattern strokes in `setStrokesAsync`.
- **REST JSON** (`editor/rest/fileJson.ts`): node types `TEXT_PATH` and `TRANSFORM_GROUP` [Figma's REST names unverified; we use the plugin's], with their fields.
- **Dev Mode** (`editor/devmode/`): a TEXT_PATH inspects as text (Typography); a TRANSFORM as a group. CSS export emits no repeat [ours].

## 8. `.fig` fidelity (7e)

`src/shared/fig/convert.test.ts` (or a sibling) builds a synthetic Figma-schema `.fig` with a TEXT_PATH (`textPathStart`, glyph rotations), a TRANSFORM with LINEAR and RADIAL modifiers, a dynamic stroke, a scatter brush and its BRUSH node, a pattern stroke and `rotationOrigin`. Import → export keeps every field byte for byte. When the owner supplies a real Draw `.fig` (§11), it joins `docs/research/figma/samples/` and the test.

## 9. Shared types — commit verbatim before the round

`src/shared/draw/types.ts`:

```ts
/**
 * Figma Draw (docs/draw.md) — the types the engine bindings, the Draw chrome, the brush assets and the plugin API share.
 * Document shapes (TransformModifier, TextPathStart, DynamicStrokeSettings…) are the generated ones in
 * src/shared/schema/document.generated.ts; these are the shapes around them. [unverified] defaults are ours.
 */

/** A GUID as the engine bindings print it: "sessionID:localID". */
export type GuidString = string;

export type BrushType = "STRETCH" | "SCATTER";

/** Figma's built-in brushes (developers.figma.com ComplexStrokeProperties `brushName`), in Figma's order. */
export const STRETCH_BRUSH_NAMES = [
  "HEIST", "BLOCKBUSTER", "GRINDHOUSE", "BIOPIC", "SPAGHETTI_WESTERN", "SLASHER", "HARDBOILED", "VERITE",
  "EPIC", "SCREWBALL", "ROM_COM", "NOIR", "PROPAGANDA", "MELODRAMA", "NEW_WAVE",
] as const;
export const SCATTER_BRUSH_NAMES = [
  "BUBBLEGUM", "WITCH_HOUSE", "SHOEGAZE", "HONKY_TONK", "SCREAMO", "DRONE", "DOO_WOP", "SPOKEN_WORD", "VAPORWAVE", "OI",
] as const;
export type StretchBrushName = (typeof STRETCH_BRUSH_NAMES)[number];
export type ScatterBrushName = (typeof SCATTER_BRUSH_NAMES)[number];
export type BuiltinBrushName = StretchBrushName | ScatterBrushName;

/** "SPAGHETTI_WESTERN" → "Spaghetti Western" (the shown name and the BRUSH node's name). */
export function brushDisplayName(key: BuiltinBrushName): string {
  return key.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

/** A brush's artwork: closed regions in its own box; the stroke runs along +x. */
export interface BrushArtwork {
  width: number;
  height: number;
  /** SVG path data, absolute commands (M L Q C Z) in the box's coordinates */
  d: string;
  windingRule: "NONZERO" | "ODD";
}

export interface BuiltinBrush {
  key: BuiltinBrushName;
  name: string;
  type: BrushType;
  artwork: BrushArtwork;
}

/** A brush in the menu: the file's BRUSH node, or a built-in not yet installed (guid null). */
export interface BrushEntry {
  guid: GuidString | null;
  name: string;
  type: BrushType;
  builtin: BuiltinBrushName | null;
}

/** engine.installBrush's argument (ABI engine_install_brush). */
export interface InstallBrushInput {
  name: string;
  type: BrushType;
  artwork: BrushArtwork;
}

/** Stroke settings' Stroke Type. Implicit in the document: BRUSH = strokeBrushGuid set, DYNAMIC = dynamicStrokeSettings set. */
export type StrokeKind = "BASIC" | "DYNAMIC" | "BRUSH";

export interface DynamicSettings {
  frequency: number;
  wiggle: number;
  smoothen: number;
}
export interface ScatterSettings {
  gap: number;
  wiggle: number;
  angularJitter: number;
  rotation: number;
  sizeJitter: number;
}
export interface StretchSettings {
  /** Figma's Direction; the document's BrushOrientation FORWARD / REVERSE */
  direction: "FORWARD" | "BACKWARD";
}

/** Ranges from the plugin API (upper bounds marked ours where Figma gives none). */
export const DYNAMIC_RANGE = { frequency: [0.01, 20], wiggle: [0, 100 /* ours */], smoothen: [0, 1] } as const;
export const SCATTER_RANGE = {
  gap: [0.25, 20 /* ours */],
  wiggle: [0, 20 /* ours */],
  sizeJitter: [0, 3],
  angularJitter: [-180, 180],
  rotation: [-180, 180],
} as const;
/** [unverified] defaults (ours until a Figma sample shows its own). */
export const DYNAMIC_DEFAULTS: DynamicSettings = { frequency: 2, wiggle: 1, smoothen: 0.5 };
export const SCATTER_DEFAULTS: ScatterSettings = { gap: 1, wiggle: 0, angularJitter: 0, rotation: 0, sizeJitter: 0 };
export const STRETCH_DEFAULTS: StretchSettings = { direction: "FORWARD" };

/** The Pencil's and the Brush's settings (the secondary toolbar), sent with engine.setDrawToolSettings. */
export interface DrawToolSettings {
  pencil: { color: string; opacity: number; weight: number; kind: "BASIC" | "DYNAMIC"; dynamic: DynamicSettings };
  /** brush: the installed BRUSH node (the chrome installs a built-in before selecting it) */
  brush: { color: string; opacity: number; weight: number; brush: GuidString | null };
}
export const DRAW_TOOL_DEFAULTS: DrawToolSettings = {
  pencil: { color: "#000000", opacity: 1, weight: 2, kind: "BASIC", dynamic: DYNAMIC_DEFAULTS },
  brush: { color: "#000000", opacity: 1, weight: 4, brush: null },
};
export const DRAW_WEIGHT_RANGE = [0.5, 100] as const; // ours

/** The engine's DRAW_TOOL_SAMPLED event (⌘-click on a stroke with the Pencil or the Brush). */
export interface DrawToolSampled {
  tool: "PENCIL" | "BRUSH";
  color: string;
  opacity: number;
  weight: number;
  kind: StrokeKind;
  dynamic?: DynamicSettings;
  brush?: GuidString;
}

/** A transform modifier as the chrome edits it (the document's TransformModifier, type REPEAT). */
export type RepeatKind = "LINEAR" | "RADIAL";
export interface RepeatModifierInput {
  repeatType: RepeatKind;
  count: number;
  /** LINEAR: the gap along the axis; RADIAL: the gap from the content to the centre (docs/draw.md §4.2) */
  offset: number;
  unitType: "PIXELS" | "RELATIVE";
  /** LINEAR only (X_AND_Y kept from files, not offered) */
  axis: "X" | "Y" | "X_AND_Y";
  order: "FORWARD" | "REVERSE";
  visible: boolean;
}
export const REPEAT_COUNT_RANGE = [1, 1000] as const;
export const MAX_REPEAT_INSTANCES = 10_000;
/** [unverified] defaults for "Linear repeat" / "Radial repeat". */
export const REPEAT_DEFAULTS: Record<RepeatKind, RepeatModifierInput> = {
  LINEAR: { repeatType: "LINEAR", count: 3, offset: 16, unitType: "PIXELS", axis: "X", order: "FORWARD", visible: true },
  RADIAL: { repeatType: "RADIAL", count: 8, offset: 0, unitType: "PIXELS", axis: "X", order: "FORWARD", visible: true },
};

/** Command args (CommandId 310–321, docs/draw.md §4.7). `refs` absent = the selection. */
export interface DrawCommandArgs {
  ADD_TRANSFORM_MODIFIER: { refs?: GuidString[]; modifier: RepeatModifierInput };
  SET_TRANSFORM_MODIFIER: { ref: GuidString; index: number; modifier: Partial<RepeatModifierInput> };
  REMOVE_TRANSFORM_MODIFIER: { ref: GuidString; index: number };
  MOVE_TRANSFORM_MODIFIER: { ref: GuidString; from: number; to: number };
  APPLY_TRANSFORMS: { refs?: GuidString[] };
  SET_STROKE_KIND: { refs?: GuidString[]; kind: "BASIC" | "DYNAMIC"; dynamic?: Partial<DynamicSettings> };
  SET_STROKE_BRUSH: { refs?: GuidString[]; brush: GuidString };
  SET_BRUSH_SETTINGS: { refs?: GuidString[]; scatter?: Partial<ScatterSettings>; stretch?: Partial<StretchSettings> };
  CREATE_BRUSH: { ref: GuidString; brushType: BrushType };
  CREATE_TEXT_PATH: { ref: GuidString; segment: number; position: number; replace: boolean };
  FLIP_TEXT_PATH: { refs?: GuidString[] };
  SET_TEXT_PATH_START: { ref: GuidString; segment: number; position: number };
}

/** The plugin API's TextPathStartData ↔ the document's TextPathStart.tValue ([unverified] encoding, §4.4). */
export function tValueOf(segment: number, position: number): number {
  return Math.max(0, Math.floor(segment)) + Math.min(1, Math.max(0, position));
}
export function splitTValue(tValue: number): { segment: number; position: number } {
  const segment = Math.max(0, Math.floor(tValue));
  return { segment, position: tValue - segment };
}
```

**Engine.ts additions** (7b writes them; the main session commits them as **stubs** that throw "not built" so the chrome compiles):
- `installBrush(input: InstallBrushInput): GuidString | null`
- `listBrushes(): { guid: GuidString; name: string; type: BrushType }[]`
- `brushPreview(src: { brush: GuidString } | { artwork: BrushArtwork; type: BrushType }, width: number, height: number, weight: number): Pixels | null`
- `setDrawToolSettings(s: DrawToolSettings): number`
- `runDrawCommand<K extends keyof DrawCommandArgs>(id: K, args: DrawCommandArgs[K]): number`

`abi.ts` gains the CommandIds 310–321, `TOOLS` "BRUSH" / "TEXT_PATH" and the `DRAW_TOOL_SAMPLED` event kind in the same commit.

**Icons** (the main session adds them to `ds/icons/registry.ts`, drawn in the house style, before the round):
- `24.brush`
- `24.text-path-flip`
- `16.repeat` (the layer icon)
- `16.repeat.linear`
- `16.repeat.radial`
- `16.text-path` (the layer icon)
- `24.dynamic-stroke`

## 10. Ownership and merge order — see `docs/roadmap.md` "Round 7"

## 11. Open questions for the owner

**Answered by the owner, 2026-10-12:** (1) build with our own constants now — no sample file / live capture yet; calibrate later when he provides a `draw.fig`; (2) Figma's 25 brush names on our own artwork; (3) not asked — default: brushes are added to a file only when first used; (4) text on path keeps the original shape, the text is a new layer above it.

1. **A Draw sample `.fig` and one live capture.** Everything [unverified] above waits on Figma itself. Two things from the owner would settle most of it:
   - **The sample file**: in Figma Draw, one file with a linear and a radial repeat (default and edited), text on a circle and on an open path (flipped and not), a Dynamic stroke at two settings, one stretch and one scatter built-in brush, and a custom brush. Save it as `.fig` into `docs/research/figma/samples/draw.fig`.
   - **The live capture**: sign in to figma.com in the built-in browser, so an agent can capture Draw's toolbar, secondary toolbar, sidebar and menus (`research/figma/live/draw/`).

   Without them, the round ships with our constants (§4.2–4.5) and our layouts (§5) and gets calibrated later.
2. **Built-in brushes under Figma's names, with our own looks.** Default: yes. The plugin API and `.fig` files name them, and our artwork is our own. The alternative is our own names, which would break plugin `brushName` round trips.
3. **Install brushes into a file only when used** (our default), or all 25 the first time Draw is used, as the owner's Figma file suggests Figma does?
4. **Text on path keeps the shape** (our default: a new text layer above it, the shape untouched), or converts the shape as the plugin API does?
