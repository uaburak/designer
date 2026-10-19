# 05 — Shapes and vector editing

Figma Design desktop 126.9.13, read 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo) under `~/.cache/figma-rea/BRIEF.md`. No Figma code is copied here. This file records behaviour, numbers, enums
and strings, each with its evidence.

Marks: **C** = CONFIRMED (read directly in the build or in a live capture); **I** = INFERRED (deduced, or known from
help.figma.com / earlier research and not re-read in this build). Evidence is `file @byte-offset` or a short quote.

## 1. Scope and sources

**Scope.** The shape tools (Frame, Section, Slice, Rectangle, Line, Arrow, Ellipse, Polygon, Star, Image/video), their
creation rules and defaults; corner radius and corner smoothing; ellipse arcs; polygon / star parameters; frame presets;
sections; groups and frames; boolean operations; the Pen and vector edit mode; the Pencil; strokes (caps, joins, dashes,
arrowheads). Draw (brushes, Dynamic, variable width, Shape builder, Text on path, Offset / Simplify) is covered in depth
by `docs/research/rea/vector.md`; §12 below only summarises it.

**Sources read**

| Source | What it gave |
|---|---|
| `figma_app.min.js` (8.2 MB) | Frame presets module @1344700–@1349900 (all groups, sizes, the orientation-aware matcher); the toolbar's tool descriptors (`RECTANGLE`, `LINE`, `ARROW`, `ELLIPSE`, `REGULAR_POLYGON`, `STAR`, `IMAGE_OR_VIDEO`, `PEN`, `PENCIL`, `FRAME`, `SECTION`, `SLICE`); the polygon / star row @4081660; the Arc row @4084040; the Mirroring control @4086367; the vector edit secondary toolbelt and the Paint bucket @3214722. |
| `5581.min.js` | The Corner smoothing popover @227981 (slider, "iOS" mark). |
| `9263.min.js` / `1334.min.js` | The stroke end-cap list and its labels @87093 (9263). |
| `858.min.js` | The Object menu definition @97814 (Flatten, Outline stroke, Boolean groups and their order). |
| `1575.min.js` | The "update vector operation" (boolean version upgrade) row @16564. |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | The keyboard-shortcut JSON @47306863–@47313000; behaviour class names (`PenVectorBehavior`, `BendVectorBehavior`, …); i18n keys used by the canvas (`fullscreen.arc_tool.*`, `illustration.*`); assertion / error strings. Read with `strings -n 6` (one dump, ~104 k lines). |
| Repo, live captures | `docs/research/figma/live/design/{rectangle,rectangle-individual-corners,ellipse,polygon,star,line,arrow,section,group,frame,boolean,vector,vector-edit-mode,vector-edit-point-selected}.txt`, `menus/main-object.txt`, `menus/context-shape.txt`, `img/canvas-*.png`. English labels come from these. |
| Repo, prior research | `docs/research/rea/vector.md` (Draw and vector, REA, 2026-10-15) — summarised in §12, not repeated. `docs/research/figma/samples/sections.fig.json` (a real Figma section's fields). |

The build ships i18n **keys**, not English text. English below comes from the live captures unless marked otherwise.

## 2. The tools: list, shortcuts, behaviour classes

### 2.1 Tool list and shortcuts (C, wasm shortcut JSON @47306863)

| Tool | Action id | Design shortcut | Notes |
|---|---|---|---|
| Move | `set-tool-default` | V | |
| Scale | `set-tool-scale` | K | |
| Frame | `set-tool-frame` | F, A | F not in FigJam; A everywhere |
| Section | `set-tool-section` | ⇧S | not in Slides |
| Slice | `set-tool-slice` | S only behind lab `collab-tool-shortcuts-in-design` | in Design S is otherwise free (S = sticky in FigJam) |
| Rectangle | `set-tool-rectangle` | R | Slides: ⇧⌥R |
| Ellipse | `set-tool-ellipse` | O | |
| Line | `set-tool-line` | L | edit modes `GLOBAL,!TEXT,!VECTOR` — not inside vector edit |
| Arrow | `set-tool-arrow` | ⇧L | |
| Polygon | `set-tool-regular-polygon` | — | toolbar flyout only |
| Star | `set-tool-star` | — | toolbar flyout only |
| Image / video | `place` | ⇧⌘K | "Place image/video…" |
| Pen | `set-tool-pen` | P | |
| Pencil | `set-tool-pencil` | ⇧P | (P / M in FigJam) |
| Brush | `set-tool-brush` | B | only with the `illustration` (Draw) flag, not in vector edit |
| Shape builder | `set-tool-shape-builder` | M | not FigJam / Slides |
| Variable width | `set-tool-var-width-point` | ⇧W | |
| Cut (vector edit) | `set-tool-cut` | X | edit mode `VECTOR` only |
| Paint bucket (vector edit) | `set-tool-paint-bucket` | ⇧B | `VECTOR` only |
| Vector eraser (vector edit) | `set-tool-vector-eraser` | ⇧E | `VECTOR` only |

Toolbar order of the shape flyout (C, `figma_app.min.js` tool descriptors): Rectangle, Line, Arrow, Ellipse, Polygon,
Star, Image/video. The creation flyout is Frame, Section, Slice. Bend and Lasso have no global key (Bend is held ⌘ in
vector edit, see §10) (I for Bend-by-⌘; it is help-site knowledge and `BendVectorBehavior` exists).

### 2.2 Object actions in this area (C, same JSON)

| Action | Mac shortcut | Note |
|---|---|---|
| `frame-selection` Frame selection | ⌥⌘G | |
| `group-selection` Group selection | ⌘G | |
| `ungroup-selection` Ungroup selection | ⌘⌫ **and** ⇧⌘G | |
| `create-section-from-selection` Wrap in new section | **⌘S** | edit mode GLOBAL; ⌘S is not Save in Figma (live menu shows "⌘S") |
| `flatten-selection` Flatten | ⌥⇧F **and** ⌘E | |
| `outline-stroke` Outline stroke | ⌥⌘O | ⇧⌘O with pref `use-old-outline-shortcuts` |
| `toggle-outlines` Outline mode | ⇧⌘O | ⇧O with the old-shortcuts pref |
| `mask-selection` Use as mask | ⌃⌘M | |
| `live-boolean-union` / `-subtract` / `-intersect` / `-xor` | ⌥⇧U / ⌥⇧S / ⌥⇧I / ⌥⇧E | not FigJam, Slides-slides or Dev Mode |
| `join-selection` | ⌘J | |
| `smooth-join-selection` | ⇧⌘J | Mac only (no Windows binding) |
| `delete-and-heal-selection` | ⇧⌫ / ⇧Delete | (FigJam uses the same keys for its Eraser) |
| `swap-fill-and-stroke` | ⇧X | |
| `remove-fill` / `remove-stroke` | ⌥/ / ⇧/ (US); `,` and `:` variants per keyboard layout | layout-specific table, 16 layouts |
| `paste-to-replace` | ⇧⌘R (⇧⌥⌘V too) | |

### 2.3 Engine behaviour classes (C, wasm strings)

Creation: `NodeInsertionBehavior`, `QuickAddClickBehavior`, `QuickAddDragBehavior`, `FrameQuickAddBehavior`,
`PlaceImageBehavior`, `RenderGhostNodeUnderCursorBehavior`. Shape handles: `EditShapeBehavior` (radius, arc, count / ratio
handles), `GrabHandleBehavior`, `FGCornerRotationBehavior.cpp`. Vector edit: `PenVectorBehavior`, `PencilVectorBehavior`,
`BendVectorBehavior`, `CutVectorBehavior`, `MidpointInsertionVectorBehavior`, `DeleteAndHealVectorBehavior`,
`BoxSelectionVectorBehavior`, `BoxTransformVectorBehavior` (+`…CursorBehavior`), `ChangeSelectionVectorBehavior`,
`ModifyVectorSelectionBehavior`, `MultiMoveSelectionVectorBehavior`, `VectorLassoBehavior`, `PaintBucketBehavior`,
`VectorEraserVectorBehavior`, `RenderVectorUnderCursorBehavior`, `VectorRedlineRenderBehavior`, `ShapeBuilderBehavior`,
`VarWidthPointBehavior`, `OffsetPathBehavior`, `ConvertTextPathBehavior`, `EditTextPathBehavior`,
`HighlighterVectorBehavior`, `BrushBehavior`. Source files: `fullscreen/lib/geometry/FGVectorNetwork.cpp`,
`scenegraph/FGVectorOperation.cpp` (booleans), `scenegraph/node/facets/FGVectorFacet.cpp`,
`scenegraph/vectordata/FGVectorHelpers.cpp`, `editor-ui/interactions/vector/FGCutVectorBehavior.cpp`.

## 3. Creating shapes

| Item | Value | Mark / evidence |
|---|---|---|
| Click without drag | creates the tool's shape at **100 × 100**, top-left at the click | I (help site; DesignerV2 already does 100 × 100, `Gestures.cpp:2641`) |
| Drag | box from press to pointer | I |
| ⇧ while dragging | square / circle / equal sides; Line and Arrow snap to **45°** steps | I (help) |
| ⌥ while dragging | draw from the centre | I (help) |
| Space while dragging | moves the shape being drawn instead of resizing | I (help) |
| After creation | tool returns to Move (no sticky tools in Design) | I |
| Rectangle / Ellipse / Polygon / Star fill | `#D9D9D9` solid, no stroke paint | C for the colour constant: `figma_app.min.js @3214722` `r:217/255,g:217/255,b:217/255` (the Paint bucket's default); I that shapes use the same (live captures show D9D9D9 shapes) |
| Frame fill | `#FFFFFF` solid, clip content on | I (live `frame.txt`) |
| Line / Arrow | black 1 px centre stroke, no fill; Arrow has end cap `ARROW_LINES` | I (live `line.txt`, `arrow.txt`) |
| Polygon default count | 3 | I (Plugin API default; repo) |
| Star default | count 5, ratio 0.382 | I (Plugin API default) |
| Names | type name + " " + a number, the number one higher than any existing layer of that base name in the file (`Rectangle 11539` style) | C that numbering exists: Figma's own SVG exports embedded in `1503.min.js` carry ids "Rectangle 2157", "Rectangle 11539"; I for the "highest + 1, whole file" rule |
| Boolean names | "Union", "Subtract", "Intersect", "Exclude" (no number) | C live `boolean.txt` / layers |
| Vector names | "Vector" (live), pen paths numbered as other shapes | I |

The Image / video tool (`place`, ⇧⌘K) opens the OS file picker and then places each image on click / drag
(`PlaceImageBehavior`) with an IMAGE fill on a rectangle (I).

## 4. Corner radius and corner smoothing

| Item | Value | Mark / evidence |
|---|---|---|
| Fields | `cornerRadius` (20), `rectangleTopLeft/TopRight/BottomLeft/BottomRight CornerRadius` (145–148), `rectangleCornerRadiiIndependent`, `rectangleCornerToolIndependent` | C schema; `5519.min.js` branching treatments list |
| Invariant | "node cannot have both cornerRadius and rectangleCornerRadii" | C wasm @48696772 |
| Independent-corner button | "Individual corners"; the 4 inputs show TL, TR / BL, BR | C live `rectangle-individual-corners.txt` |
| Corner radius handles on canvas | the 4 inner dots; pill text key `fullscreen.canvas.radius` ("Radius N") | C wasm key; I for the pill text |
| Clamping when drawn | each radius is clamped to half the shorter side; independent radii scaled down together when two neighbours exceed the side | I (help + behaviour; wasm string "Error in rounded corner extension" shows a dedicated routine) |
| Applies to | rectangles, frames, components, polygons, stars, vectors (per-vertex `cornerRadius` in vector edit) | C for vector edit: live `vector-edit-mode.txt` shows "Corner radius" |
| Corner smoothing popover | slider **0–1**, step **0.01**, big step **0.1**, default 0, a hint mark at **0.6** labelled **"iOS"** (key `transform_panel.i_os`); clicking "iOS" sets 0.6; the value is rounded to 2 decimals and committed | C `5581.min.js @227981` |
| Smoothing toggle | an icon button "Corner smoothing" next to the radius field | C same module |
| Smoothing maths | Figma's published squircle construction (smoothing ξ extends each corner's curve by up to (1+ξ)·r along the edges, limited by the free edge length, then 3 cubic segments per corner) | I (Figma engineering blog; not in strings) |

## 5. Ellipse arcs

| Item | Value | Mark / evidence |
|---|---|---|
| Data | `arcData {startingAngle, endingAngle, innerRadius}` (radians, ratio) — "arcData.(startingAngle, endingAngle, innerRadius)" | C wasm string |
| Panel row | label "Arc", three fields: **Start** (degrees), **Sweep** (percent, `min -1`, resolution 0.001), **Ratio** (percent, resolution 0.001) | C `figma_app.min.js @4084040` |
| Sweep sign | negative sweep allowed down to −100 % | C (`min:-1`) |
| Canvas handles | three: the sweep (end) handle, the start handle (⌥? / appears after sweep moves) and the centre ratio handle | C that handles exist (live `img/canvas-ellipse-selected-arc-handle.png`); I for which modifier |
| Canvas pill text keys | `fullscreen.arc_tool.arc`, `…start_s` ("Start %s"), `…sweep_s` ("Sweep %s"), `…ratio` | C wasm @48114640 |
| Snapping | the sweep handle snaps to the 45° / 15° steps with ⇧, and to 0 / full when near | I (help); not settled statically |
| Analytics | `illustration.canvas_arc_data` | C |

## 6. Polygon and star

| Item | Value | Mark / evidence |
|---|---|---|
| Count field | min **3**, max **60**, big nudge **10**, resolution 0.01, scrub multiplier 0.1 × small nudge | C `figma_app.min.js @4081660` |
| Ratio (star) field | percentage, min **0.001**, resolution 0.001 | C same |
| Label | "Count" (`properties.label.count`) and "Ratio" | C |
| Canvas handles | polygon: one count handle; star: count + ratio handle (`illustration.canvas_polygon_count`, `canvas_star_count`, `canvas_star_ratio`) | C keys; live `img/canvas-star-selected-handles.png` |
| Panel shown | only when every selected node is the same type (all STAR or all REGULAR_POLYGON) for analytics; the row shows whenever `countShown` | C |

## 7. Frame presets

C, `figma_app.min.js @1344700`. Each group in order; names are Figma's (each has a `presets.*` i18n key).

| Group (key `presets.group_titles.*`) | Presets (W × H) |
|---|---|
| Phone | iPhone 17 402×874; iPhone 16 & 17 Pro 402×874; iPhone 16 393×852; iPhone 16 & 17 Pro Max 440×956; iPhone 16 Plus 430×932; iPhone Air 420×912; iPhone 14 & 15 Pro Max 430×932; iPhone 14 & 15 Pro 393×852; iPhone 13 & 14 390×844; iPhone 14 Plus 428×926; Android Compact 412×917; Android Medium 700×840 |
| Tablet | iPad mini 8.3 744×1133; Surface Pro 8 1440×960; iPad Pro 11" 834×1194; iPad Pro 12.9" 1024×1366; Android Expanded 1280×800 |
| Desktop | MacBook Air 1280×832; MacBook Pro 14" 1512×982; MacBook Pro 16" 1728×1117; Desktop 1440×1024; Wireframe 1440×1024; TV 1280×720 |
| Presentation | Slide 16:9 1920×1080; Slide 4:3 1024×768 |
| Watch | Apple Watch Series 10 42mm 187×223; Series 10 46mm 208×248; Apple Watch 41mm 176×215; 45mm 198×242; 44mm 184×224; 40mm 162×197 |
| Paper | A4 595×842; A5 420×595; A6 297×420; Letter 612×792; Tabloid 792×1224 |
| Social media | Twitter post 1200×675; Twitter header 1500×500; Facebook post 1200×630; Facebook cover 820×312; Instagram post 1080×1350; Instagram story 1080×1920; Dribbble shot 400×300; Dribbble shot HD 800×600; LinkedIn cover 1584×396 |
| Figma | Plugin icon 128×128; Profile banner 1680×240; Plugin / file cover 1920×1080 |
| Archived | iPhone 13 mini 375×812; iPhone SE 320×568; iPhone 13 Pro Max 428×926; iPhone 13 / 13 Pro 390×844; iPhone 11 Pro Max 414×896; iPhone 11 Pro / X 375×812; iPhone 8 Plus 414×736; iPhone 8 375×667; Android Small 360×640; Android Large 360×800; Google Pixel 2 411×731; Google Pixel 2 XL 411×823; iPad mini 5 768×1024; Surface Pro 4 1368×912; MacBook 1152×700; MacBook Pro 1440×900; Surface Book 1500×1000; Apple Watch 42mm 156×195; Apple Watch 38mm 136×170; iMac 1280×720; Macintosh 128k 512×342 |

- **Preset recognition** (C): for a frame, the first preset with exactly its W × H wins; failing that, the first preset
  whose size matches with W and H swapped (landscape) is returned. This drives the header ("Frame ▾" shows the preset).
- A short list (`$W`) built from Phone + Desktop + Presentation is used for the quick picker (C, `u=_([i,o,s])`).
- Choosing a preset from the Frame tool creates the frame at the viewport centre (I); with a frame selected it resizes it
  (I). Duplicate names (Desktop / Wireframe both 1440×1024): recognition returns "Desktop" (first) (C by order).

## 8. Sections

| Item | Value | Mark / evidence |
|---|---|---|
| Tool | Section ⇧S; Wrap in new section ⌘S | C shortcut JSON |
| Object menu | "Wrap in new section", "Convert to section", "Convert to frame" | C live `main-object.txt`; actions `create-section-from-selection`, `replace-selected-frame-with-section`, `convert_section_to_frame` (wasm) |
| Default look | white fill, black 10 % inside stroke weight 1, radius 2, no clipping; the dark theme shows a different section fill (live capture: fill `444444`, stroke `FFFFFF`) | C sample `sections.fig.json` (light); C live `section.txt` (dark). I that the dark colours are a theme rendering vs stored values — see Open questions |
| Default size by click | 400 × 300 (live capture) | C live `section.txt` W 400, H 300 (I that a click gives it) |
| Panel | header "Section ▾" opens Frame presets; "Toggle ready for dev status"; Layout › "Resize to fit"; Dimensions; Appearance (opacity, corner radius, Individual corners); Fill; Stroke; Export | C live `section.txt` |
| Nesting | a section sits on the canvas or inside another section; not inside frames / groups (frames get "Wrap in new section" around them). Section names render in levels (`UISectionNameLevel`; error "Section title nesting level out of bounds") | C that levels exist; I for the parent rule |
| Contents hidden | `sectionContentsHidden` (283); the toggle's shortcut ⇧⌘H is FigJam only | C |
| Resize to fit on select | wasm action `resize-section-to-fit-on-select` | C name; I behaviour |
| Auto-adoption | dragging a section over layers adopts the top-level layers it fully covers; moving a layer into / out of a section announces `node_moved_into_section` / `node_moved_out_of_section` | C keys; I rule |
| Paste of a section into a place that can't hold it | toast key `visual_bell.sections_aren_t_quite_ready_for_figma_just_yet_we_pasted_your_section_as_a_group` (pasted as a group) | C wasm @48162882 |
| Dev status | `sectionStatusInfo` ("Ready for dev") | C |
| FigJam-only | section presets picker (`SectionPresetBehavior`, `whiteboard.section_preset_picker.*`) | C, out of scope |

## 9. Groups, frames, booleans, flatten

### 9.1 Groups vs frames

| Item | Value | Mark |
|---|---|---|
| Group storage | a FRAME with `resizeToFit` (groups have no fill/clip of their own; their box follows children) | I (repo schema note; Figma .fig samples) |
| Ungroup | ⌘⌫ / ⇧⌘G; children keep their absolute transforms; "Components cannot be ungrouped" | C wasm @48464369 |
| Group across pages | refused: "Grouped nodes must be in the same page as the parent" | C wasm string |
| Group adds auto layout | refused internally: "Attempting to add auto-layout properties on a group node, which does not support them" | C wasm string |
| Frame selection | ⌥⌘G wraps in a frame sized to the selection bounds, white fill | I |
| Selection | click selects the top-most group / frame child at the top level; double-click or ⌘-click deep-selects | I (live `behaviour/canvas.md` covers frames) |
| Remove group from booleans | n/a | — |

### 9.2 Boolean operations

| Item | Value | Mark / evidence |
|---|---|---|
| Ops | Union, Subtract, Intersect, Exclude (enum `UNION, INTERSECT, SUBTRACT, XOR`) | C actions `live-boolean-*`; a11y keys `boolean_operation.{union,subtract,intersect,xor}` |
| Toolbar | "Boolean operations" split button in the selection actions bar; flyout title "Boolean groups" (`fullscreen.flyout.boolean_groups`) | C live `boolean.txt`, i18n key |
| Menu order | Object › Flatten, Outline stroke, **Boolean groups ▸** (Union, Subtract, Intersect, Exclude), then Show/Hide … | C `858.min.js @97814` |
| Live boolean | the result is a BOOLEAN_OPERATION node whose children stay editable; applying another op to a selected boolean changes its operation | C (actions are `live-boolean-*`); I for "changes its op" |
| Operation version | booleans carry `vectorOperationVersion` (425); an older one shows a panel note with an **Update** button (`vector_operation.update_text` with `numNodes`, `…update_button`) calling `upgradeToLatestVectorOperationVersion`; analytics `illustration.upgrade_vector_operation_version` | C `1575.min.js @16564` |
| Subtract order | the bottom-most layer is the base; layers above are subtracted | I (help) |
| Flatten | ⌘E / ⌥⇧F: booleans, groups, shapes → one VECTOR; "Expected one flattened region from group node" (internal) | C shortcut, wasm string |
| Flatten-disabled fields | tooltip key `transform_panel.flattening_property_disabled_tooltip` | C |

## 10. Pen and vector edit mode

| Item | Value | Mark / evidence |
|---|---|---|
| Enter | Enter or double-click a vector (`illustration.vem_doubleclick`); shapes are converted to a vector on first edit | C key; I conversion |
| Leave | Esc / Enter / "Done" — toolbar action `toolLeaveVectorEditMode` | C (`SecondaryToolbeltForVectorEditing`) |
| Secondary toolbar | Select, Lasso │ Paint bucket, Bend, Cut, Vector eraser │ active of Shape builder / Variable width + "More tools" (label key `toolbar.vector_editing.more_tools.label`) │ Close | C, prior `rea/vector.md` §17 |
| Mirroring field | "Mirroring": **No mirroring** (`NONE`), **Mirror angle** (`ANGLE`), **Mirror angle and length** (`ANGLE_AND_LENGTH`) | C `figma_app.min.js @4086367`; live `vector-edit-mode.txt` |
| Panel in VEM | Position X/Y of selected points (disabled with none), Mirroring, Corner radius, Fill, Stroke | C live `vector-edit-mode.txt`, `vector-edit-point-selected.txt` |
| Pen clicks | click = corner point; drag = smooth point with mirrored handles; click the first point closes the path; Esc / Enter ends an open path | I (help) |
| ⌘ in VEM | hold for the Bend tool (drag a segment to curve it; click a point to toggle its handles) | I (help; `BendVectorBehavior`) |
| ⌥ while dragging a handle | breaks the mirroring of that point (moves one handle) | I (help; repo does the same) |
| ⇧ | constrains to 45° steps (points and handles) | I |
| Vector networks | any point may join 3+ segments; actions that need a single path warn with `visual_bell.branching_vector_network_warning` | C key @48297623 |
| Pen preference | `penToolAvoidSingleHandles` | C prior report |
| Split / join | `join-selection` ⌘J, `smooth-join-selection` ⇧⌘J, `delete-and-heal-selection` ⇧⌫, `break-vector-network-into-paths` | C |
| Midpoint insertion | `MidpointInsertionVectorBehavior` — hover a segment's midpoint and drag to add a point | C class; I UX |
| Paint bucket | ⇧B; fills a closed region of the network; its colour chip defaults to **#D9D9D9** solid, takes the vector's last fill when the tool opens; the picker opens automatically the first time, 8 px above the button, solid colours only (no image / pattern / gradient edit), variable scope SHAPE_FILL; click a filled region again to unfill (I) | C `figma_app.min.js @3214722`; analytics `illustration.paint_bucket_used` |
| Cut | X; click a segment to split it (`illustration.cut_tool_used`) | C |
| Snapping in VEM | points snap to other points, segment midpoints and the pixel grid; "Could not convert network to a single segment" (internal) | I for targets |

## 11. Pencil and strokes

### 11.1 Pencil
⇧P. Freehand → B-spline fit; covered in `rea/vector.md` §15 (weights 0.66 / 0.33, distance / angle / pressure filters).
Drawing style shared by Pencil / Brush / Pen in Draw: weight 4, black (white in dark UI) — `rea/vector.md` §12.

### 11.2 Stroke settings

| Item | Value | Mark / evidence |
|---|---|---|
| Align | Inside / Center / Outside (OFFSET exists in the schema, Draw only) | C live `rectangle-with-stroke.txt`; prior §22 |
| End caps (open paths) | None, Line arrow, Triangle arrow, Reversed triangle, Circle arrow, Diamond arrow, Round, Square (enum NONE, ARROW_LINES, ARROW_EQUILATERAL, TRIANGLE_FILLED, CIRCLE_FILLED, DIAMOND_FILLED, ROUND, SQUARE) | C `9263.min.js @87093` (labels `stroke_settings.{none,line_arrow,triangle_arrow,reversed_triangle,circle_arrow,diamond_arrow,round,square}`) |
| Caps hidden from Design | HIGHLIGHT, WASHI_TAPE_1…6, ERD_* (FigJam connectors) | C same |
| Line caps (style) | Butt / Round / Square (`stroke.line_cap.*`) | C keys |
| Joins | Miter / Bevel / Round; "Miter angle" only for Miter; stored as `strokeMiterLimit` 1–16 | C keys; prior §14 |
| Dashes | "Dashes", "Dash", "Gap", "Simple dash"; max 8 entries; Dash cap None / Round / Square | C keys; prior §14 |
| Variable width | disabled with dashed strokes (`width_profile.disabled.dashed`) | C key |
| Remove / swap | ⌥/ remove fill, ⇧/ remove stroke, ⇧X swap | C |

## 12. Draw tools (summary of `docs/research/rea/vector.md`)

Brush / Dynamic stroke defaults 0.75 / 0.3 / 0.5 (§2); variable-width presets (§3); scatter per brush (§5); transform
modifier count 2–40 (§6); Outline stroke / Flatten of Dynamic and Brush (§7); Simplify vector tolerance 10^−t, t −2…3
(§8); Offset path (§10); Text on path Combine / Separate (§13); Shape builder, Bend, Lasso internals matching (§25).
Nothing new added here.

## 13. UI strings

English from live captures (L) or the repo's i18n (R); otherwise the key only.

- Tools (L, `left-rail-tools`, toolbar): Frame, Section, Slice, Rectangle, Line, Arrow, Ellipse, Polygon, Star,
  Image/video, Pen, Pencil.
- Object menu (L): Frame selection, Group selection, Ungroup selection, Wrap in new section, Convert to section, Convert
  to frame, Use as mask, Flatten, Outline stroke, Boolean groups, Remove fill, Remove stroke, Swap fill and stroke.
- Boolean (L): Union, Subtract, Intersect, Exclude, Boolean operations.
- Panel (L): Corner radius, Individual corners, Count, Ratio, Mirroring, No mirroring, Mirror angle, Mirror angle and
  length, Stroke align, Inside, Weight, Advanced stroke settings, Resize to fit, Toggle ready for dev status.
- Keys only (no English attested here): `transform_panel.corner_smoothing` ("Corner smoothing", R), `transform_panel.i_os`
  ("iOS"), `properties.label.arc`, `transform_panel.start`, `.sweep`, `.ratio`, `fullscreen.arc_tool.{arc,start_s,sweep_s,ratio}`,
  `fullscreen.canvas.radius`, `vector_operation.update_text`, `vector_operation.update_button`,
  `transform_panel.flattening_property_disabled_tooltip`, `toolbar.vector_editing.more_tools.label`,
  `stroke_settings.{line_arrow,triangle_arrow,reversed_triangle,circle_arrow,diamond_arrow,dash_cap,miter_angle,simple_dash}`,
  `presets.group_titles.{phone,tablet,desktop,presentation,watch,paper,social_media,figma,archived}`,
  `visual_bell.branching_vector_network_warning`, `visual_bell.sections_aren_t_quite_ready_…_as_a_group`,
  `accessibility.node_moved_into_section` / `node_moved_out_of_section`.

## 14. DesignerV2 today

| Area | State | Where |
|---|---|---|
| Click = 100 × 100, ⇧ square, ⌥ centre, snapping while drawing | matches | `engine/src/tools/Gestures.cpp:2630-2650` |
| Default fills (D9D9D9 shapes, white frame, section white + 10 % black stroke, radius 2) | matches | `engine/src/scene/Node.cpp:540-600` |
| Names "Type N", highest + 1 in the file | matches | `engine/src/editor/Editor.cpp:818` |
| Frame presets (all 9 groups, order, sizes) | matches | `src/renderer/src/editor/panels/design/Header.tsx:45` |
| Preset recognition with swapped W/H (landscape) | **not verified** — check the header's lookup | Header.tsx |
| Corner smoothing popover, iOS mark at 60 % | matches (0–100 % integer steps vs Figma's 0.01 — same) ; no 0.1 big step on the slider | `Sections.tsx:515` |
| Corner smoothing rendered on polygons / stars / vectors | **differs**: engine smooths rectangles and frames only | `Sections.tsx:513` comment |
| Polygon count 3–60 | matches (precision 0; Figma resolution 0.01, big nudge 10) | `Sections.tsx:505` |
| Star ratio | min 0 (Figma 0.001 = 0.1 %) | `Sections.tsx:506` |
| **Arc row (Start / Sweep / Ratio) in the panel** | **missing** — canvas arc handles exist, no panel fields | `Gestures.cpp:434-534`; no `t("Arc")` |
| Arc canvas pills ("Start", "Sweep", "Ratio") | **missing** (I) | — |
| Wrap in new section ⌘S, Convert to section / frame | matches | `commands.ts:556`, `abi.ts:216` |
| Live booleans ⌥⇧U/S/I/E | matches | `abi.ts:67` |
| `vectorOperationVersion` upgrade note + Update button | **missing** (field only kept for round trips) | `schema/document.kiwi:2144` |
| Mirroring control, ⌥ breaks mirroring | matches | `VectorPoints.tsx:77`, `VectorEditing.cpp:889` |
| Paint bucket default colour #D9D9D9, last fill pick-up, auto-open solid-only picker | **partial** — tool exists; colour chip / picker behaviour to check | `VectorEditing.cpp:672` |
| Branching-network warning | matches in spirit ("Figma asks for Split vector first") | `VectorEditing.cpp:408` |
| End caps list (8 entries, Figma order) | to check against `Stroke.tsx` | — |
| Section paste fallback toast (pasted as group) | missing (I) | — |

### As built (2026-10-17, wave 1)

Branch "canvas and shapes" (with chapter 04; tests in `engine/tests/unit/atlas.canvas_shapes.test.cpp` and `src/renderer/src/editor/__tests__/atlas.canvasShapes.test.ts`).

- **Arc row**: Figma's `properties.label.arc` row is Draw's — the live Design panel of an ellipse has none (`live/design/ellipse.txt`), and Draw's sidebar lists an Arc section (`docs/draw.md` §5.3). Built there: in Draw mode an ellipse selection's Appearance shows "Arc" with Start (°), Sweep (%, −100 … 100) and Ratio (%, 0 … 100) in one row (`Sections.tsx` `ArcRow`; the end written from the start and the sweep).
- **Boolean version**: new boolean groups carry `vectorOperationVersion` 1 (the owner's recent Figma files carry 1 on their booleans, older ones none); a selection with booleans at 0 / absent shows the note and **Update** under the header (`VectorOperation.tsx`; the engine's `UPGRADE_VECTOR_OPERATION` 240, one undo step "Update boolean"; Figma's rule: shown while the selection's version is 0 or mixed). The engine computes every version alike, so Update only stamps the field.
- **Star ratio** from 0.1 % (Figma's min 0.001).
- **Corner smoothing slider**: ⇧ + arrow steps 10 % (Figma's big step 0.1).
- **End caps**: the list and its order match Figma's (`NONE, ROUND, SQUARE`, then the five arrows).
- **Polygon count** 3–60 already matched (big nudge 10 is the field's default).

Not done / open:
- **Arc pills** on the canvas ("Start %s", "Sweep %s", "Ratio"): the engine draws no localised words yet (no path for Turkish), and the English format of `%s` is unattested.
- **Paint bucket chip**: where the chip sits and how it looks in the vector edit toolbar is not in the live captures (they show the toolbar with Move active); the engine fills a region with the vector's own fill. Needs a capture of the toolbar with Paint active, then region styles (`styleOverrideTable`) for the chip's colour.
- **Section paste fallback**: the toast's key ("…we pasted your section as a group") reads like FigJam-era text; when Figma Design still fires it (a section pasted into a frame?) is unknown — a live paste with a frame selected settles it. Ours pastes a section into the selected frame as it is.
- **Preset recognition** (exact W × H, else swapped): what it drives in UI3 — the header's title or a check in the presets menu — needs a live look at a preset-sized frame; the live `frame.txt` header says "Frame".
- The note's English for the boolean update is unverified (only `vector_operation.update_text` / `update_button` are shipped); corner smoothing on polygons / stars / vectors stays Open Q4.

**Sweep (2026-10-18)**: nothing on this list can be built without Figma itself — the arc pills' format, the paint
bucket's chip, the section paste fallback, the presets' recognition and corner smoothing beyond rectangles each wait on
the live probe named above. Draw's own open items are in `docs/draw.md` ("Sweep (2026-10-18)").

## 15. Open questions (and the probe that settles each)

1. Arc handle snapping (which angles, with / without ⇧) and how the start handle is reached — live: drag the sweep
   handle of an ellipse with and without ⇧ and read `arcData` through the plugin API.
2. Section fill in dark theme: is `#444444` stored or only displayed? — live: `figma.currentPage.selection[0].fills` on a
   new section in dark UI.
3. Section parent rule (can a section be dropped into a frame?) — live: drag a section into a frame and read `.parent`.
4. Corner smoothing on polygons / stars / vectors — live: set smoothing 60 % on a star, export SVG, compare with 0 %.
5. Line / Arrow ⇧ snap step (45° or 15°) — live: drag with ⇧ at ~20° and read `rotation`.
6. Corner-radius clamping when neighbours overflow (proportional scale vs per-corner min) — live: 100 × 40 rectangle with
   radii 40 / 40 / 0 / 0, export SVG path.
7. Paint bucket "unfill" on a filled region and the region-colour storage per region (`vectorData.styleOverrideTable`) — live:
   two clicks on the same region, then read `vectorNetwork.regions`.
8. Default size of a section created by click (400 × 300 seen, may come from the capture's script) — live: ⇧S click.
