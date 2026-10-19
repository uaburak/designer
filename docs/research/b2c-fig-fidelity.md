# AnexEUI – B2C.fig: what Wecra brings over and what it doesn't (2026-10-16)

The owner's real Figma file `~/Desktop/AnexEUI - B2C.fig` (344 MB, Figma schema 106, 78,523 nodes, 59 pages) is now the project's main fidelity test file. This report takes every feature family the file uses and checks it at three stages:

- **(a) Import**: is the field kept, mapped or dropped (`src/shared/fig/convert.ts` and its `ImportReport`)?
- **(b) Render**: does the engine draw it as Figma does (`engine/src/render`, `engine/src/geometry`, `engine/src/text`, `engine/src/layout`)?
- **(c) Play**: does the prototype player play it? The player is C++ in `engine/src/proto/{Prototype,Player}.cpp`, drawn by `engine/src/render/PresentRender.cpp`. It is not in `src/renderer`.

**Sources.**
- The inventory `inv.json` (made by `inv.ts`): node type counts, every field path with its count and enum values, and our importer's `ImportReport`.
- Three value passes over the decoded file (`stats.ts`, `stats2.ts`, `stats3.ts`, one process at a time with an 8 GB heap): scale factors, background-blur hosts and their ancestors, fonts, text layout versions, image modes, interaction combinations, nested interactive instances, stacking order and corner smoothing.
- The inventory and the scripts are in the session scratchpad (`…/scratchpad/b2cfig/`). They are temporary. Rerun `inv.ts` / `stats*.ts` with `npx vite-node` against the file to regenerate them.
- The code on `main` at `ebe227ca` (Round 17 Batches A, B and C merged), read file by file. Figma's behaviour comes from `docs/research/rea/*.md` and from Figma's own data in this file (for example, the scaled sublayer values Figma stores in `derivedSymbolData`).
- The owner's Wecra workspace, Figma and the app were not opened or run.

**Confidence.** *High*: read in our code, and the file shows the data that triggers it. *Medium*: our code is clear, but Figma's side is inferred and not probed. *Probe*: needs a side-by-side check against Figma.

**Read this first: the owner's app is older than the blur fixes.** The installed Wecra is 1.3.0 (released 2026-10-14). Figma's tent blur, the background blur clamped to the node box, the effect list in array order and the shadow fixes landed in Round 17 Batches A and B on 2026-10-15. They are merged on `main`, but not pushed or released. Much of what the owner saw in background blurs is likely the 1.3.0 renderer (Gaussian σ = R/2 with a 3σ reach, unclamped backdrop). Compare against `npm run dev` before acting on §3.

---

## 1. Inventory summary

| Family | What the file holds |
|---|---|
| Node types | FRAME 28,209 · INSTANCE 18,347 · TEXT 15,048 · SYMBOL 7,755 · VECTOR 5,225 · ROUNDED_RECTANGLE 1,755 · ELLIPSE 1,325 · VARIABLE 335 · BOOLEAN_OPERATION 252 (SUBTRACT 130, UNION 122) · SECTION 134 · CANVAS 63 · VARIABLE_SET 26 · BRUSH 25 (Figma's default brush artwork, internal canvas; **no node strokes with a brush**) · STAR 19 · REGULAR_POLYGON 3 · CODE_LIBRARY 1 (internal canvas) |
| Groups | 666 `resizeToFit` frames (Figma's GROUPs) |
| Effects | DROP_SHADOW 1,683 (radius 24 on 1,330; spread −8 ×2; showShadowBehindNode on 54) · BACKGROUND_BLUR 763 (radius 24 ×370, 48 ×243; 12 carry `blurOpType NORMAL`, **none progressive**) · FOREGROUND_BLUR 78 (68 on vectors) · INNER_SHADOW 26 (20 with radius 0) · 30 hidden |
| Paints | SOLID 44,090 · GRADIENT_LINEAR 440 (+24 strokes) · GRADIENT_RADIAL 4 · IMAGE 1,158 (FILL 1,007, STRETCH 149 of which 122 cropped, FIT 2; 49 with adjustments; 35 with `imageShouldColorManage = false`; 1 animated GIF) · PATTERN 17 · paint blend LIGHTEN 13, OVERLAY 4, MULTIPLY 4 · node blend MULTIPLY 18 |
| Variable bindings on paints | `colorVar` on 25,573 fills and 9,767 strokes. Every library `assetRef` in the file (39,708) resolves to a local copy: **0 unresolved** |
| Strokes | strokeAlign INSIDE 59,649 / OUTSIDE 15,586 / CENTER 2,949 · per-side weights on 3,057 · dashes on 1,233 (VECTOR 897, FRAME 331) · caps ROUND 2,364 · joins ROUND 1,319, BEVEL 87 · vector style table: per-vertex caps 1,503, joins 1,482, `strokeCapSize` 141 |
| Shapes | cornerSmoothing on 234 nodes (0.6 ×206): VECTOR 88, INSTANCE 60, FRAME 48, SYMBOL 22, RECT 16 · independent corner radii 5,477 · arcs 1,366 (11 non-trivial) · stars 19, hexagons 3 · masks 98 (FRAME OUTLINE 90, ALPHA 8) |
| Auto layout | stackMode HORIZONTAL 25,731, VERTICAL 14,088, **GRID 445** (FLEX / HUG / FIXED tracks, anchors, spans) · wrap 217 · SPACE_EVENLY 822, SPACE_BETWEEN 91 · BASELINE 1 · absolute children 3,586 · **stackReverseZIndex true on 1,044** · min / max size 344 / 309 · bordersTakeSpace 19 |
| Constraints | horizontal SCALE 4,887, CENTER 2,856, MAX 503, STRETCH 215 · vertical similar |
| Text | 15,048 texts · truncation ENDING 4,839 (maxLines 1 on 4,792) · leadingTrim CAP_HEIGHT 84 · unordered list lines 152 · decorations (underline, strikethrough, thickness, offset, skip ink) · OT features toggled (46 runs) · SUPER position 4 · lineHeight RAW 43 / PERCENT 233 · letterSpacing PERCENT 11,473 · **textUserLayoutVersion 4 on 8,690, 5 on 6,358** · 2 emoji glyphs |
| Fonts | Inter (12,591 runs), ES Rebond Grotesque (1,625), Matter (1,077; **not installed on this Mac**), Google Sans Code, Roboto Mono, Geist Mono, Proxima Nova, SF Compact, Product Sans |
| Components | 7,755 mains, 301 sets; props BOOL 361, TEXT 359, INSTANCE_SWAP 180, VARIANT 445, SLOT 1 · overrides with overrideLevel 1 / 2 / 3 · **uniformScaleFactor ≠ 1 on 1,688 instances (833 on visible pages; 0.58–1.35)** |
| Variables | 335 variables in 26 collections (17 library copies), modes up to 4 · bindings: FONT_FAMILY / STYLE / SIZE / LINE_HEIGHT ≈ 5,460 each, padding / gap ≈ 190, radii 174, width / height 31 · expressions IS_TRUTHY 120, RESOLVE_VARIANT 37 |
| Prototype | 16,745 interactions. Events: ON_HOVER 7,022, ON_CLICK 5,060, ON_PRESS 3,383, MOUSE_ENTER 996, AFTER_TIMEOUT 126, DRAG 79, MOUSE_LEAVE 79. Actions: SWAP_STATE 16,278, NAVIGATE 262, OVERLAY 78, CLOSE 106, SET_VARIABLE_MODE 34, BACK 8, SET_VARIABLE 5, URL 3, SCROLL_TO 3. Transitions: INSTANT 7,408, SMART_ANIMATE 4,923, DISSOLVE 3,373, PUSH / MOVE 13. Easings: SPRING_PRESET_THREE 15,072, OUT_CUBIC 500, SPRING_PRESET_TWO 58, IN_CUBIC 51, GENTLE 11, ONE 7, LINEAR 3. **5,562 interactive instances are nested in components** (754 top-level). Overflow: HORIZONTAL 435, VERTICAL 37, BOTH 2; STICKY_SCROLLS 143; 3 flows; 1 device preset |
| Other | export settings 1,911 (SVG 1,592) · layout grids 30 · guides 229 · sectionStatusInfo 1,138 · `handoffStatusMap` on 42 pages (4 frames BUILD) · codeSyntax 172 · symbolLinks 36 · annotation categories · page dividers 5 · 250 soft-deleted |

**Import report.** Nodes in 78,523, out 78,522: only the CODE_LIBRARY node is dropped. Dropped fields:
- `userFacingVersion` 18,903, `emojiImageSet` 8,505, `sharedSymbolVersion` 5,069 (local mains only), `ExportSettings.svgAnimated` 1,742;
- `Paint.animationFrame` / `imageShouldColorManage` / `altText` 1,283 each, `strokeCapSize` 141, `handoffStatusMap` 42, `isCollectionExtendable` 3, `Paint.animatedImage` 1;
- the paste fields of the Message (`pasteEditorType`, `pasteAssetType`, `originFileKey`, `publishedAssetGuids`, `nodeChangeOrder`, `annotationCategories`).

95,488 derived values are dropped and recomputed. Mappings applied:
- `targetAspectRatio` → lock 15,070;
- variant defs → set defs 29,698;
- root override paths 10,027;
- `assetRef` → local guid 39,708;
- the GUID sentinel 1,360;
- one slot.

Projection by name keeps everything else. The gaps below are therefore almost all at stages (b) and (c), not (a).

---

## 2. Gaps, ordered by how visible they are on this file

| # | Gap | Stage | Visible on this file? | Size |
|---|---|---|---|---|
| 1 | Scaled instances (`uniformScaleFactor`) draw their sublayers unscaled: strokes, effects, radii, font sizes, paddings | import + render | **yes**: 833 instances on visible pages (1,688 in all) | M–L |
| 2 | `stackReverseZIndex` ("first on top") isn't drawn. Hit-testing honours it, so clicks pick the other layer | render | **yes** where children overlap: 1,044 containers, 521 with absolute children | S |
| 3 | Change to / Dissolve and Smart animate on a **nested** interactive component lose the outgoing state (no cross-fade) | play | **yes, in play**: 5,562 nested interactive instances; 3,373 DISSOLVE + 4,923 SMART_ANIMATE actions | M |
| 4 | Corner smoothing on frames, components and instances: fill, stroke, backdrop and shadow are drawn unsmoothed, while the clip is smoothed | render | yes, subtle: 130 frame-likes (22 mains → all their instances) | S–M |
| 5 | A background blur inside a layer Wecra isolates (an ancestor drawn as a layer for a generic shadow, a mask group…) sees only that layer, not what is behind it | render | yes, local: 25 hosts on this file, plus their instances | M–L |
| 6 | The drop-shadow source is the content's alpha, not Figma's silhouette (a translucent fill casts a faint shadow) | render | probe: 1,683 shadows, most on non-clipping frames that take this path | S–M |
| 7 | Text layout versions (`textUserLayoutVersion` 4 vs 5) aren't read. Their meaning is unknown | render | probe: 8,690 texts are v4 | ? |
| 8 | Corner smoothing on vectors, stars and polygons isn't applied | render | subtle: 88 vectors | S |
| 9 | A vector's per-vertex stroke join (style table) is ignored. The node's join is used | render | rare: 4 vectors | S |
| 10 | Figma's device ids (`APPLE_IPAD_PRO_11_SILVER`) aren't recognised, so the device frame is missing | play | rare: 1 page | S |
| 11 | "Reset component state" (`transitionResetInteractiveComponents`) is read but never applied | play | rare: 6 navigate / scroll actions | S |
| 12 | Frames marked Ready for dev lose the status (`handoffStatusMap` dropped) | import | rare: 4 frames | S |
| 13 | Arrow cap size (`strokeCapSize`) dropped | import | rare: 4 arrow caps | S |
| 14 | `imageShouldColorManage = false` dropped: the image is colour-managed anyway | import + render | rare, subtle: 35 images | S |
| 15 | Animated GIF fill (`animatedImage`) dropped: static frame only, even in play | import + play | rare: 1 image | M |
| 16 | Background blur skipped on layers under 24 device px (LOD) | render | zoom-dependent: none at 100 %; all of them when zoomed far out | S |
| 17 | Background blur with no visible fill but a visible stroke: Figma blurs into the silhouette, Wecra drops it | render | rare: ≤ 28 hosts have no visible fill | S |
| 18 | Colour emoji (Apple set) in text | render | rare: 2 glyphs | M |

### 2.1 Scaled instances — `uniformScaleFactor` (#1)
**Figma.** The Scale tool (K) on an instance sets `symbolData.uniformScaleFactor`. The instance draws its main's layers scaled by that factor: positions, sizes, stroke weights, effect radii and offsets, corner radii, font sizes, line heights, letter spacing, paddings and gaps. The file stores the scaled values per sublayer in `derivedSymbolData`. On the 1,688 scaled instances, the stored entries carry `strokeWeight` + `effects` (1,411), and `cornerRadius`, `stackSpacing`, padding, `fontSize`, `lineHeight` and `letterSpacing` where they apply.

**Wecra.**
- Import keeps only `guidPath`, `size`, `transform` and `derivedTextData` of each entry (`src/shared/fig/convert.ts:228` `SYMBOL_ENTRY_FIELDS`). The scaled weights, effects, radii and text sizes are dropped.
- The engine stores the factor (`engine/src/scene/Node.h:706`, codec `CodecKiwi.cpp:1962`), but nothing reads it.
- The materializer takes the stored boxes as they are (`engine/src/editor/Instances.cpp:900–910`). Without them it lays the sublayers out by constraints (`:912–925`), which resizes rather than scales.
- The Scale tool doesn't descend into instances: "its layers are its main's" (`engine/src/tools/CanvasTools.cpp:217`).

Result: the right boxes, but 1 × stroke weights, shadow and blur radii, corner radii and font sizes. Text is laid out again at the main's size inside a scaled box. At 0.667 (143 instances) a text is 1.5 × too big for its box. Any edit that re-derives the instance loses the stored boxes too.

**Build.**
1. Make the factor part of the instance model: the materializer derives the sublayers at the main's size, then multiplies every length field by the factor (the list Figma stores, above). Text is laid out at the scaled size.
2. Keep the scaled `derivedSymbolData` fields on import, so the first open matches Figma before any re-derive.
3. Have the Scale tool write `uniformScaleFactor` on instances instead of resizing them.
4. Native test: a 0.667-scaled instance's stroke, shadow and text sizes.

### 2.2 `stackReverseZIndex` — "Canvas stacking: first on top" (#2)
**Figma.** An auto-layout frame with this flag paints its children in reverse order (the first child on top). Positions don't change.

**Wecra.**
- `docs/engine.md:412` and `:578` say the render tree reverses the children range. It doesn't: `RenderTree::add` / `addTo` walk `doc.children()` in position order (`engine/src/render/RenderTree.cpp:27–29`, `:45–47`).
- `Renderer::drawChildren` walks that range forwards (`Renderer.cpp:1335`).
- `Document::paintsBefore` does respect the flag (`engine/src/scene/Document.cpp:223–225`), and hit-testing sorts by it (`engine/src/hit/HitTest.cpp:252`).
- So where children overlap, Wecra draws the opposite stacking from Figma, and a click lands on the layer that is drawn underneath.

On this file 1,044 containers set the flag. 521 of them have absolute children: badges, close buttons and overlays over a flow, mostly in components, so every instance shows it. The presentation view and the exporters share the render tree and inherit the bug.

**Build.** In `add` / `addTo` (and in the incremental insert at `:168–171`), iterate the children reversed when the parent is auto layout with the flag. Then check masks, which mask "the layers above" in paint order, and the Smart animate snapshot order. Native test: two overlapping absolute children under a reversed stack, checking the draw order and the hit.

### 2.3 Nested interactive components lose the outgoing state (#3)
**Figma.** Change to with Dissolve cross-fades the old variant into the new one. Smart animate morphs the matched layers, fades the unmatched old layers out and fades the new ones in. Nesting depth doesn't matter.

**Wecra.** `Player::swapInstance` keeps the old state on screen as a "ghost" node (a copy of the instance, faded out), but only for an instance that isn't derived (`engine/src/proto/Player.cpp:1332`). An interactive component nested in another component is a derived instance (a sublayer of the outer instance), so it gets no ghost. `addFrame` then:
- Dissolve: fades the new state in from 0 over nothing (`Player.cpp:2024–2035`), so the component blinks through the background;
- Smart animate: drops the unmatched old layers at once (`:2020–2022`).

On this file 5,562 interactive instances are nested, against 754 top-level: buttons in cards, nav items in headers, fields in forms. ON_HOVER → Dissolve alone is 2,774 interactions.

**Build.** Ghost derived instances too. Either snapshot the outgoing subtree's drawn props and draw them as presentation overrides (no document node), or let the ghost be a sibling copy under the derived parent row. Native test: hover a nested Dissolve button and check that the old state's opacity follows 1 − e.

### 2.4 Corner smoothing on frame-likes (#4)
**Figma.** `cornerSmoothing` (iOS-style "squircle") shapes a frame's fill, stroke, clip, shadow and background-blur mask alike.

**Wecra.**
- `NodeProps::isPathShape` sends a smoothed **rectangle** through the path renderer, but not a frame, component or instance (`engine/src/scene/Node.cpp:57–69`).
- So `drawFills` (`Renderer.cpp:414`), `drawStrokePaints` (`:639`) and `drawBackgroundBlur` (`:1008`) draw a smoothed frame as a plain rounded rect SDF.
- The analytic shadow is skipped, which is right (`:743`). The generic shadow then blurs the unsmoothed fill.
- Yet `pushClip` clips the children to the smoothed outline (`:1093`). The frame's own fill and its clipped content don't share an edge at the corners.

On this file: INSTANCE 60, FRAME 48, SYMBOL 22 (and all instances of those 22 mains), mostly at 0.6.

**Build.** Treat `cornerSmoothing > 0` on frame-likes like rectangles. Draw the fill, stroke and backdrop from `NodeGeometry` (`rectPath(…, smoothing)` already exists, `geometry/NodeGeometry.cpp:143`). Test: a 0.6-smoothed frame's fill coverage equals its clip at a corner (engine-shot).

### 2.5 Background blur inside an isolated layer (#5)
**Figma.**
- Figma's render-tree builder gathers the backdrop for a BACKGROUND_BLUR from what is drawn under the node, over the node's clamp box.
- A pass-through ancestor that only has a drop shadow doesn't isolate its content: Figma builds the shadow from a silhouette, not from a copy of the content (`rea/effects.md` §2.6, §2.10).
- Group opacity and non-normal blend modes do isolate in both apps. Whether Figma's backdrop sees through them needs a probe.

**Wecra.**
- `drawBackgroundBlur` copies the **current layer** (`Renderer.cpp:2400–2432`).
- A node draws its whole subtree into a layer of its own when it needs one (`needsLayer`, `:1623`; `beginLayer` `:1654`). That happens for a generic shadow (any drop shadow not eligible for the analytic path: non-opaque fill, non-clipping frame with children, smoothing; `analyticShadows` `:742–753`), a layer blur, texture or noise, opacity < 1 on a container, a blend mode, or a mask group (`:1351–1363`).
- A blurred child of such a node blurs only its siblings and the parent's own fill. The page behind the parent is missing: a translucent glass card in a shadowed, transparent container shows little or no blur.

On this file 25 of the 758 visible background blurs have such an ancestor (21 drop shadows, 4 with a blurred ancestor), plus their instances. None sit under masks or under ancestors with opacity < 1.

**Build.** Two parts:
1. Generic shadows shouldn't isolate the subtree. Draw the content straight into the parent and the shadow from a separate silhouette draw. This is #6's change too, and it also saves a layer.
2. For the isolations that remain, give `BackdropBlur` the parent chain: composite the layers below up to the page into the copy, or read from the outermost non-isolated target, as Figma's builder does. Probe first which isolations Figma's backdrop crosses.

### 2.6 Drop-shadow silhouette (#6)
Still open from `rea/effects.md` §2.6 (probe 1.2 pending).

**Figma.** Every visible, not fully transparent paint becomes opaque for the shadow, so a 10 % fill casts a full shadow. A clipping frame casts its box.

**Wecra.** The generic path blurs a copy of the content layer (`Renderer.cpp:1712` `S.copyOf = C`), so a translucent card casts a faint shadow.

The 1,401 shadowed frames on this file are mostly non-clipping frames with children (`frameMaskDisabled` is true on 34,327 frames), so they take the generic path. Run the probe and then build the silhouette as effects.md describes. That draw is the same one #5 needs.

### 2.7 Text layout versions (#7)
Figma writes `textUserLayoutVersion` (4 on 8,690 texts, 5 on 6,358), `textExplicitLayoutVersion` (1) and `textBidiVersion` (1). Nothing in `engine/src` reads them (grep: no hits outside the schema). If Figma laid out v4 and v5 texts differently (line height or baseline rules), Wecra's own layout would differ on one of the two groups. Texts whose font is missing draw Figma's stored outlines and aren't affected.

**Probe.** Compare a v4 and a v5 text of the same style in Figma and Wecra (baseline y, line box height). Then decide whether the engine needs a version switch.

### 2.8–2.9 Vector corners and joins (#8, #9)
**Smoothing.** `withRoundedCorners` (`engine/src/geometry/VectorNetwork.cpp:283`) rounds network corners with circular arcs, and the per-vertex `cornerSmoothing` (1,480 style entries, mostly 0) is not read. `VectorStyle` has no such field: it stays in `extra`. Stars and polygons round without smoothing (`geometry/Shapes.cpp:254–257`). 88 vectors set node-level smoothing.

**Joins.** `drawStrokePaints` uses the node's `strokeJoin` for the whole network (`Renderer.cpp:706`). The style table's per-vertex `strokeJoin` (1,482 entries) is ignored. It differs from the node's join on 4 stroked vectors on this file. Per-vertex caps are read (`capOf`, `VectorNetwork.cpp:~277`).

### 2.10 Device preset ids (#10)
Figma writes `presetIdentifier` with the maker and colour, e.g. `APPLE_IPAD_PRO_11_SILVER` (this file). Wecra's table uses `IPAD_PRO_11` and matches it as a prefix (`engine/src/proto/Devices.cpp:43–96`). `findDevice` fails, so `hasDeviceFrame` is false and no device artwork is drawn (`Player.cpp:421`, `:444`). The screen size still comes from `prototypeDevice.size`. Some worktrees under `.claude/worktrees/` already carry `APPLE_…` ids. Merge or redo that.

### 2.11 Reset component state (#11)
`readAction` reads `transitionResetInteractiveComponents` (`engine/src/proto/Prototype.cpp:88`), but `Player::navigate` (`Player.cpp:1115–1149`) only honours `resetScroll`. Instance states changed earlier (`originals_`) carry over into the destination even when the action asks for a reset. On this file it is set on 3 NAVIGATE and 3 SCROLL_TO actions (669 SWAP_STATE actions carry it too, where it has no effect). The fix restores `originals_` for instances under the destination frame.

### 2.12–2.15 Import drops with a visible effect (#12–#15)
- **Ready for dev.** Figma keeps a frame's Dev Mode status in its page's `handoffStatusMap` (guid → status). Ours isn't in the schema and is dropped. Wecra reads `sectionStatusInfo` on the node instead (`src/renderer/src/editor/frameStatus.ts:20–26`). Fix: map each `handoffStatusMap` entry to the frame's `sectionStatusInfo` in `figmaNodeFixups`. 4 BUILD entries here.
- **`strokeCapSize`.** Reserved in the schema (`docs/schema.md:701`, field 497), so dropped. Arrow caps draw at the default size. 141 style entries, 4 arrow caps.
- **`imageShouldColorManage`.** Not in our Paint. Images are decoded with colour conversion (`src/renderer/src/engine/Engine.ts:914–927`). Figma shows these 35 images unconverted. Visible only on images with a non-sRGB profile.
- **`animatedImage`.** Not in our Paint. The GIF shows its static `image` frame on the canvas and in play. Figma plays GIFs in prototypes. 1 image.

### 2.16–2.18 Small render gaps (#16–#18)
- **LOD.** A layer under `kTinyLayerPx = 24` device px (`Renderer.h:542`) is drawn without its offscreen pass, and its background blur is skipped (`Renderer.cpp:1626–1634`). No host here is smaller than 24 px, so this only shows when zoomed far out. It is a performance choice. Compare with Figma at 10–25 %.
- **No fill.** A background blur needs a visible fill (`Renderer.cpp:1588–1593`). Figma's mask is the silhouette of fills and strokes (`rea/effects.md` §2.12). Up to 28 hosts here have no visible fill.
- **Emoji.** `emojiImageSet` is dropped, and the text path has no colour-emoji (sbix / Apple) drawing. 2 glyphs.

---

## 3. Background blur — what the owner reported

The 763 background blurs (758 visible; 344 on the internal canvas as component data) were checked one by one against the code:
- hosts: SYMBOL 536, INSTANCE 113, FRAME 100, RECT 9;
- all ≥ 24 px;
- none combined with another effect;
- none progressive;
- fill α < 0.5 on 375, 0.5–0.999 on 331, opaque 24, no visible fill 28;
- INSIDE strokes on 383;
- opacity < 1 on 5.

**What matches Figma on `main`:**
- the tent kernel of half-width R;
- the backdrop clamped to the node box (grown by OUTSIDE / CENTER strokes × miter, plus a text's ink), so nothing outside the card bleeds in;
- only the first background blur or glass is used;
- the fill-visibility rule;
- the node's opacity on the backdrop;
- instances: effects come through the override stack, and `effects` overrides (34) apply;
- the presentation view uses the same `drawNode` path.

**Where it can still differ, most likely first:**
1. **The released 1.3.0 app.** It still has the Gaussian blur and the unclamped backdrop. Check the same frames with `npm run dev` before anything else.
2. **Scaled instances** (#1). A scaled card's blur radius stays at the main's value. Figma stores the scaled `effects` per sublayer. This is the only cause that touches many blurs at once.
3. **Corner smoothing** (#4). A smoothed glass card's blurred backdrop is a plain rounded rect, slightly off the clip at the corners.
4. **Isolated ancestors** (#5). 25 hosts blur only their parent's layer.
5. **Pan seams.** `backdropReach` (`Renderer.cpp:836–840`) records a known 8-column mismatch between a fresh draw and a panned cached view of a glass at the canvas edge, "a gap … not yet found". It shows only during and after pans.
6. **Zoomed far out** (#16), and **no fill but a stroke** (#17).

**Probe (owner, 10 minutes).** Pick three blurred cards: one plain, one inside a scaled instance and one with corner smoothing. Screenshot each at 100 % in Figma and in `npm run dev`. If the plain card differs on `main`, the kernel or radius semantics for BACKGROUND_BLUR need a live check. Batch A's calibration probe was a LAYER_BLUR.

---

## 4. Works (verified in code)

**Import**
- Every node type except CODE_LIBRARY.
- GROUP → frame + `resizeToFit`; RECTANGLE → ROUNDED_RECTANGLE.
- Library copies' keys and versions; all 39,708 `assetRef`s resolve locally.
- Figma's text layout and instance boxes are kept for the first open (`FIGMA_DERIVED_DATA_VERSION`).
- Slots: the one SLOT prop and its content adopted under its instance.
- `overrideLevel` (Batch C).

**Shapes**
- Booleans (UNION / SUBTRACT).
- Stars (ratio) and polygons.
- Arcs (start, end, inner radius).
- Independent corner radii, and corner smoothing on rectangles.
- Vector networks: per-vertex caps, handle mirroring, per-vertex corner radius.
- Even-odd winding.
- Sections.

**Paints**
- SOLID with colour variables.
- Linear and radial gradients with interpolation space / hue method (Batch C), and stop variables.
- Images: FILL, FIT, STRETCH with crop transform, 90° rotation, ThumbHash placeholder.
- Image adjustments in Figma's pipeline (Batch B; the exact numbers are still probe-pending).
- PATTERN fills (source tiling, spacing, alignment).
- Paint and node blend modes (LIGHTEN, OVERLAY, MULTIPLY).

**Effects**
- Drop shadow: tent and analytic tent CDF, spread on eligible nodes, absolute-space offset, knockout unless `showShadowBehindNode`.
- Inner shadow, including radius 0 with an offset.
- Layer blur in array order.
- Background blur as in §3.
- Hidden effects are skipped.
- Effect styles.

**Strokes**
- INSIDE / OUTSIDE / CENTER.
- Per-side weights on rectangles and frames.
- Figma's fitted dashes on rectangles, frames and straight lines; continuous dashes on vectors.
- Node-level caps and joins, miter limit.
- Gradient strokes.

**Masks and clipping**
- ALPHA, OUTLINE (vector) and LUMINANCE masks.
- Clip content and its absence (`frameMaskDisabled`).

**Auto layout**
- Horizontal, vertical and wrap, with SPACE_EVENLY (Figma's "Space between") and SPACE_BETWEEN.
- Counter spacing, baseline, stretch / align-self, absolute children.
- Min / max size, `bordersTakeSpace`.
- Hug with implicit size.
- **Grid**: FIXED, FLEX and HUG tracks, anchors, spans, child alignment.

**Constraints**: MIN, MAX, CENTER, STRETCH, SCALE.

**Text**
- Fonts: Inter is Figma's own 3.19 (bundled); installed fonts take precedence.
- Missing fonts (Matter here) draw Figma's stored glyph outlines, as Figma does for a collaborator without the font.
- Truncation with maxLines; CAP_HEIGHT leading trim.
- Unordered lists, list spacing, hanging list and punctuation.
- Decorations with style, thickness, offset, skip ink and decoration fills.
- OpenType toggles, numeric and position variants (SUPER), font variations.
- Letter spacing in % and px; line height in RAW, % and px; paragraph spacing and indent.
- Text case; per-run styles and fills; text styles; hyperlinks.

**Components**
- Props BOOL / TEXT / INSTANCE_SWAP (preferred values) / VARIANT / SLOT.
- Overrides by guid path.
- Exposed nested instances (`propsAreBubbled`).
- Variant bindings to variables (RESOLVE_VARIANT), visibility through IS_TRUTHY.
- Instance swap; detached-from links; soft-deleted mains.

**Variables**
- Collections with up to 4 modes; library copies keep their keys.
- Explicit modes on frames.
- Bindings on colour, font family / style / size, line height, padding, gap, radii, stroke weight, width / height and text.
- Scopes, code syntax.

**Prototype**
- Events:
  - ON_CLICK;
  - ON_HOVER and ON_PRESS (reverting on leave / release);
  - MOUSE_ENTER / LEAVE with Figma's `interactionMaintained` delay;
  - DRAG, with the transition scrubbing with the pointer, also for Change to;
  - AFTER_TIMEOUT (0 reads as 0.8 s), including inside instances.
- Actions:
  - NAVIGATE;
  - OVERLAY (positions, manual offset, background, close on click outside);
  - SWAP_STATE (Change to, also hover-held);
  - SCROLL_TO;
  - BACK, CLOSE, URL;
  - SET_VARIABLE, SET_VARIABLE_MODE (both on library-copy collections by key; the 34 + 5 here resolve).
- Transitions: Instant, Dissolve, Smart animate (matching by name and place; position, size, rotation, opacity, fills, strokes, radii and shadows interpolated; changed text dissolves); Push, Move and Slide in Figma's directions (Batch A).
- Easing: Figma's cubic presets; springs GENTLE / ONE / TWO / THREE with Figma's constants and settle time; 0 duration reads as 0.3 s.
- Overflow scrolling H / V / both, nested and inside instances; FIXED and STICKY children; reset scroll position.
- 3 flows and their starting points; the device screen size.
- 423 actions point at nodes that aren't in the file. Figma can't play them either.

**Other**
- Export settings (SVG content-only, PNG / JPG / PDF at 1–3×).
- Layout grids (drawn by default), ruler guides.
- `sectionStatusInfo`, code syntax, symbol links, annotation categories.
- Page dividers, plugin data and relaunch data, locked layers.
- Hidden internal canvas.

---

## 5. Proposed fix order

**Batch 1 — small renderer and player fixes (one wasm build, S each).**
1. `stackReverseZIndex` in the render tree (#2), with tests for the draw order, the hit and the masks.
2. Corner smoothing on frame-likes through `NodeGeometry` for the fill, stroke and backdrop (#4).
3. Per-vertex stroke joins from the style table (#9).
4. Figma's device ids (`APPLE_…`), accepting both forms (#10).
5. Reset component state on navigate (#11).

**Batch 2 — scaled instances (M–L, the most visible gap).**
1. `uniformScaleFactor` in the materializer: lay out at the main's size, then scale every length field (#1).
2. Keep the scaled `derivedSymbolData` fields on import.
3. The Scale tool writes the factor on instances.
4. Native tests on a 0.667 and a 1.148 instance.
5. engine-shot against Figma's stored geometry for a few scaled instances from this file.

**Batch 3 — nested interactive components in play (M).**
1. Ghost the outgoing state of derived instances (#3), for Dissolve and Smart animate.
2. Native test with an interactive button nested in a card instance.

**Batch 4 — shadows and backdrops (M–L, probe first).**
1. Run effects.md probe 1.2, plus a background blur under a shadowed transparent container and under an opacity group.
2. Then the silhouette shadow source without isolating the subtree (#6, the first half of #5).
3. The backdrop through the remaining isolations as the probe shows (#5).
4. The fill-and-stroke mask (#17).
5. Find and fix the 8-column pan seam (§3, point 5).

**Batch 5 — import and schema (S, one schema change).**
1. `handoffStatusMap` → `sectionStatusInfo` (#12).
2. Adopt `strokeCapSize` (497) for arrow caps (#13).
3. `imageShouldColorManage` (#14).
4. `animatedImage`, with GIF playback in presentation (#15).
5. Then a re-import of this file and a rerun of `inv.ts` to confirm that the report's dropped list shrinks to the harmless ones (`userFacingVersion`, `emojiImageSet`, `svgAnimated`, `altText`, `animationFrame`, the paste fields, CODE_LIBRARY).

**Later / probe-driven.**
- Text layout versions (#7) after the v4 / v5 probe.
- Vector and star corner smoothing (#8).
- Colour emoji (#18).
- The LOD threshold for backdrops (#16) after comparing with Figma when zoomed far out.

**How to use this file as the fidelity test.**
- Keep `inv.ts` / `stats*.ts` beside the engine tests: a `scripts/` copy reading the path from an environment variable, never committing the file.
- After each batch, re-import into a scratch workspace (not the owner's) and compare named frames against Figma screenshots:
  - the Avatars and Cards pages for #2 and #4;
  - any K-scaled card for #1;
  - the Header / Filter Button prototypes for #3.
