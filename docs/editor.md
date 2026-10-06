# The editor (Figma UI3 chrome around the engine)

`src/renderer/src/editor/` is the new file editor: Figma's UI3 chrome (rail, left panel with Pages and Layers, rulers, the engine canvas, the right Design panel, the bottom toolbar, menus) built from the design system (`src/renderer/src/ds/`) around the C++/Wasm engine (`src/renderer/src/engine/`). Contracts it follows: `docs/engine.md` §10 (binding), `docs/design-system.md` + `docs/design-system-usage.md` (look), `docs/schema.md` (field names), `docs/desktop.md` §13 (clipboard), `docs/research/figma/R7-editor.md` (behaviour), `docs/research/visual-diff.md` (measured metrics).

**Import rule (owner, 2026-10-06):** the editor imports only `src/renderer/src/ds/`, `src/renderer/src/engine/` and `src/shared/` (types). Nothing from the legacy folders (`figma/`, `cv/`, `home/`, `lib/`, `demo/`, `components/`, `context/`, `types/`, `tab/`), which are deleted in the next integration round. Theme: `ds/theme.ts` (`useThemeRoot`, `useTheme`), never `context/ThemeContext`.

---

## Status at handoff (2026-10-07, round 4 — E4 / E5 in the chrome)

Round 4 built the editor's side of the engine's E4 (vectors, pen, booleans, masks) and E5 (gradients, images, effects) against the names `docs/engine-build.md` "E4 + E5 API" publishes. The committed wasm is still E3 (the engine agent was mid-way), so everything the engine hasn't shipped shows disabled — never an error — and lights up by itself when it lands (`engineCompat.ts`: `hasCommand`, `engineMethod`, `keepsField`). `npm run typecheck`, `npm test` (53 files, 459 tests; the editor's: 5 files, 83) and `eslint` on `editor/` + `ds/` are green; `npm run lint` is red only in the engine agent's in-progress `engine/tools/fig.mjs` / `fixtures.mjs` (`Buffer` global). `tools/editor-shot.mjs` passes every check; the new ones run on `?editor&doc=paints` (`EDITOR_ONLY=paints` runs just them).

### Round 4: done

- **Feature detection** (`engineCompat.ts`): `supportsField` (the engine types it), `keepsField` (typed, or round-tripped since E3 — probed once at mount by a cancelled write), `hasCommand` / `runEngineCommand` / `engineCommandEnabled` (abi.ts's CommandId names it), `engineMethod` (the facade has it). E4/E5 controls gate on `keepsField`, so effects, guides, dashes, image paints… are edited, saved, undone and copied today and drawn when E5 lands.
- **Tools**: Pen P, Pencil ⇧P, Line L, Arrow ⇧L, Polygon, Star come from the registry and enable themselves when `setTool` answers OK (probed). **Image/video… ⇧⌘K** (and File ▸ Place image…) is the editor's own (`canvas/ImagePlacer.tsx`): the system file picker (several files); with layers selected the images fill them in order; the rest ride on the pointer (a thumbnail with the count), each click places one at its size, a drag sizes it with its aspect, Esc drops the rest; the toolbar shows the Image tool meanwhile.
- **Vector edit mode** (`vectorEdit.ts` `VectorEditor` on the controller; engine `startVectorEdit` / `endVectorEdit` / `setVectorEditTool` / `VECTOR_EDIT`): the bottom toolbar becomes the vector-edit toolbar — Move V, Lasso Q, Pen P, Bend ⌘, Paint bucket B, then **Done** (Lasso and Paint bucket disabled: the engine has MOVE / PEN / BEND); V / Q / P / B pick them while editing; the header's **Edit object** (↵) enters it for vectors, lines, shapes and booleans. The Design panel adds a **Point(s)** section: X / Y and the point's corner radius (disabled: no engine API yet, see Needed) and **Mirroring** (No mirroring / Mirror angle / Mirror angle and length → `VECTOR_SET_MIRRORING`, "Mixed" when they differ).
- **Booleans, Flatten, Outline stroke, masks**: `vector.union/subtract/intersect/exclude` (⌥⇧U/S/I/E), `vector.flatten` (⌘E), `vector.outline-stroke` (⌥⌘O), `object.use-as-mask` (⌃⌘M, checked on a mask) run `BOOLEAN_*` / `FLATTEN` / `OUTLINE_STROKE` / `USE_AS_MASK`; the main menu's Vector submenu (booleans, then Flatten, Outline stroke) and the canvas menu (Flatten, Outline stroke, Use as mask after Ungroup) list them. **Selection header actions** (UI3, right of the type): Edit object, Create component (disabled until E6), Use as mask, and the **Boolean groups** menu (the four operations with their 16px glyphs, then Flatten); on a boolean group the menu changes its `booleanOperation` (the current one ticked).
- **Fill / Stroke rows** (`panels/design/Paints.tsx`, `model/paints.ts`): every paint type — a solid shows its hex; a gradient its swatch and "Linear" / "Radial" / "Angular" / "Diamond"; an image its thumbnail and "Image" (DS `ColorInput valueLabel`, a button opening the picker). **The picker** offers all six types (Solid, Linear, Radial, Angular, Diamond, Image) mapped 1:1 to the schema's Paint (STRETCH = Crop; a new linear gradient gets Figma's top-to-bottom transform `[[0,1,0],[−1,0,1]]`; a type change drops what the old type had). While it shows a gradient of one layer the engine's **on-canvas gradient handles** are on (`startPaintEdit` / `endPaintEdit`), the picker's stop and the canvas's follow each other (`setPaintEditStop`, `PAINT_EDIT`). An **image paint**: preview, scale mode (Fill / Fit / Crop / Tile), **Choose image…**, **Rotate 90°** (`rotation`), and the sliders **Exposure, Contrast, Saturation, Temperature, Tint, Highlights, Shadows** (`paintFilter`, −100…100 ↔ −1…1, a drag = one undo step, double-click resets) — DS `ColorPicker imageControls`.
- **Images end to end** (`images.ts`, `placeImages.ts`): file / drop / paste → bytes, re-encoded only above Figma's 4096 px cap (aspect kept) → SHA-1 → `DocumentSource.images` (new optional `ImageStore {put, get}`: the store's blobs via `getStoreClient().blobs` for `&file=` sources — `EditorRoute` wraps the store's source —, an in-memory store for the demo documents) → a rectangle its size named after the file, IMAGE fill (Fill mode, `image.hash` as 20 numbers, `originalImageWidth/Height`), pasted through the engine's paste (fresh ids, one undo step, selected): at a point into the innermost frame there (Image tool, drops), else where a paste goes (a paste of an image from the system clipboard). The engine's `REQUEST_IMAGE` is answered from the store (`engine.setImageSource(load)`; without it the event is answered with `addImageBytes` / `addImage` / `imageFailed`). **Thumbnails**: a render that asked for images it didn't have waits for them and renders again.
- **Effects** (`panels/design/Effects.tsx`): "+" adds Figma's drop shadow (0 4 4 0 #000 25%); rows top first: the effect's glyph (opens its settings), the type dropdown (Drop shadow, Inner shadow, Layer blur, Background blur — a change keeps a shadow's numbers, a blur's radius), eye, minus; "Click + to replace mixed effects". The settings popover (titled with the type): Position X / Y, Blur, Spread, the colour + opacity, **Show behind transparent areas** (drop shadows); blurs show Blur only.
- **Layout guide** (frames): "+" adds Figma's Grid 10px (#FF0000 10%); rows: glyph (settings), "Grid 10px" / "Columns 5" / "Rows 5", eye, minus. Popover: Grid / Columns / Rows; Size (grid); Count, Type (Stretch / Left / Center / Right, rows Top / Center / Bottom), Width or Height ("Auto" when stretched), Margin (Offset when not stretched), Gutter; Color.
- **Appearance**: the **blend mode menu** (Pass through, then Figma's groups; the icon turns active off Pass through / Normal; containers default to Pass through, leaves to Normal); **Count** for polygons and stars and **Ratio** for stars (`count`, `starInnerScale`).
- **Stroke** (`panels/design/Stroke.tsx`): **Individual strokes** for frames and rectangles (the row's menu: All / Top / Bottom / Left / Right / Custom → `borderStrokeWeightsIndependent` + `border*Weight`; one side: the weight field edits it; Custom: Top / Bottom / Left / Right fields); **Stroke settings** popover (header button): Stroke style Solid / Dash, Dash and Gap (`dashPattern`), Dash cap — for lines and vectors "Cap" with the arrow ends (Line arrow, Triangle arrow, Reversed triangle, Circle arrow, Diamond arrow) —, Join (Miter / Bevel / Round), Miter angle (`miterLimit`; 4 = 28.96°).
- **Selection colors with gradients** (help.figma.com: solid colours and gradients, no images, hidden fills or masks; forum: stops aren't listed separately): a gradient is one row (its swatch and type), keyed by type + stops + opacity; its picker edits every use keeping each one's handles (`regradient`); masks' paints are left out; the picker's "On this page" stays solid colours.
- **Paste here** works again: the engine refuses a paste inside an open transaction, so the move to the point is now in the Message (`model/clipboard.ts messageAt`: region offsets shifted) and it is pasted in place into the frame under the point — one step.
- **DS additions** (additive): `ColorInput valueLabel`, `ColorPicker imageControls`, icons `24.bend`, `24.lasso`, `24.paint-bucket`, `24.strokes.individual`.
- **Fixture** `?editor&doc=paints` (`fixtures.ts PAINTS_DOCUMENT`): the four gradients in an auto-layout frame, a drop shadow, an inner shadow, a layer blur, a star, a polygon, a line, an arrow-capped line, a Subtract boolean, a dashed stroke, a bottom-only border, a frame with two layout guides.
- **Tests**: `__tests__/paints.test.ts` (17: paint ↔ picker mapping and defaults, row labels and swatches, hashes, the 4096 cap, adjustments, rotation, placed rectangles, Selection colors with gradients and masks, effect / guide defaults and type changes, stroke sides / dashes / miter, Paste here's offsets, the vector-edit state) and five wasm cases (E4/E5 fields round-trip and undo; placing an image into the frame under a point as one step; Paste here; vector commands disabled without the engine's, run with it; image requests answered from the store).
- **Screenshots** (dark, `/tmp/designer-work/editor/`): `25-gradient-row`, `26-gradient-picker`, `27-selection-colors-gradients`, `28-effect-settings`, `29-blend-mode`, `30-layout-guide`, `31-stroke-settings`, `32-individual-strokes`, `33-boolean-menu`, `34-image-placing`, `35-image-placed`, `36-image-picker` (+ `37-vector-edit` once the engine has `startVectorEdit`).

Unverified against Figma (no reference screenshots for these): the header actions' order, the "Point(s)" section's title and place, Lasso's key (Q) and the vector toolbar's order, "Cap" for open paths (Figma has separate Start point / End point — see Needed), the placed-images row gap (20), where a click places an image (its top-left at the pointer), the stroke settings' row order, the dash defaults (2 / 2).

## Status at handoff (2026-10-06, round 3 — Phase 2's Design panel)

Round 3 finished Phase 2 of `roadmap.md` for the editor. `npm run check` is green for the whole repo (51 files, 432 tests; the editor's: 4 files, 61 tests), and `tools/editor-shot.mjs` passes every check (33), the new ones on `?editor&doc=types`.

### Round 3: done

- **Sizing** (`model/sizing.ts`, `panels/design/Sizing.tsx`): W / H read "Hug" / "Fill" (DS `NumericInput valueLabel`, the number while focused; a typed number makes the axis Fixed). Their menu (chevron in the field, on hover): `Fixed width (n)`, `Hug contents` (auto-layout frames; text once the engine keeps `textAutoResize`), `Fill container` (layers in an auto-layout flow), `Add min width…` / `Add max width…` or `Remove min and max` (auto-layout frames and flow children). Hug = the frame's own `stackPrimarySizing` / `stackCounterSizing` (absent primary = Hug); Fill = `stackChildPrimaryGrow` 1 along the parent's flow, `stackChildAlignSelf` STRETCH across it; Fill on an axis the parent hugs turns the parent's axis Fixed; text = `textAutoResize`. min / max rows (`minSize` / `maxSize`, 0 = none) with a minus to remove both; a new limit starts at the current size and a limit the size breaks clamps the size with it (see "Needed").
- **Auto layout section**, UI3's order: flow (Vertical / Horizontal / Wrap) with **Advanced layout settings** (popover "Auto layout settings": Spacing mode Packed / Space between, Strokes Included in / Excluded from layout = `bordersTakeSpace`, Canvas stacking First on top / Last on top = `stackReverseZIndex`, Align text baseline = `stackCounterAlignItems` BASELINE, horizontal only), W / H, alignment + gap (reads "Auto" for Space between; typing a gap packs), padding, Clip content.
- **Ignore auto layout**: a toggle in the X / Y row's 24 column for layers in an auto-layout frame (`stackPositioning` ABSOLUTE / AUTO).
- **Constraints** (`model/constraints.ts`, `panels/design/Constraints.tsx`): a row in Position for children of frames (through groups; not top-level layers; in auto layout only for "Ignore auto layout" children): the widget (56 × 56: inner square, a line from each edge, the cross; click = that side, ⇧-click = both, ⇧ again drops one; on = brand blue, 2px) and Select dropdowns Left / Right / Left and right / Center / Scale, Top / Bottom / Top and bottom / Center / Scale (help.figma.com's wording) → `horizontalConstraint` / `verticalConstraint`. FIXED_MIN / FIXED_MAX read as Left / Right.
- **Selection colors** (`model/selectionColors.ts`, `panels/design/SelectionColors.tsx`), after Stroke: the distinct solid colours (hex + opacity) of the selection's and every visible descendant's fills and strokes, hidden paints left out (help.figma.com "View and adjust colors in a mixed selection"). Shown when the selection has children with colours (frames, groups) or several layers whose colours differ. Each row: ColorInput (hex, opacity, swatch → the picker) + "Select matching layers"; editing recolours every use as one undo step (a picker drag / opacity scrub = one open transaction, rows keyed by place so a scrub doesn't remount). Three rows, then "See all N colors" / "Show less". Subtrees past 5,000 layers aren't read.
- **Real layer types** (`controller.noteSourceTypes` / `withRealType`): the engine reads types it doesn't know (VECTOR, BOOLEAN_OPERATION, TEXT, STAR, REGULAR_POLYGON, LINE…) as NONE; the editor keeps the file's own type (and a boolean's `booleanOperation`) from the loaded document and changes from elsewhere, so Layers draws them (new 16px glyphs `16.vector`, `16.boolean.{union,subtract,intersect,exclude}`, `16.star`, `16.polygon`) and the header names them ("Vector path", "Union" / "Subtract" / "Intersect" / "Exclude", "Text", "Star", "Polygon", "Line", "Component", "Instance", "Slice").
- **Typography** (`panels/design/Typography.tsx`, all text layers): font family (span 2) / style Selects, size (with Figma's size menu), line height ("Auto" = {100, PERCENT}, px, % = RAW multiplier) and letter spacing (% or px), horizontal (left / center / right) and vertical (top / middle / bottom) alignment, and **Type settings** (popover: Resizing Auto width / Auto height / Fixed size, alignment incl. justified, paragraph spacing / indent, Truncate text + Max lines, Case, Decoration, Vertical trim, Hanging punctuation). Every control is behind `supportsField(<its field>)`: with the committed wasm (no E3 yet) the section shows disabled with Figma's defaults (Inter Regular 12, Auto, 0%). New 24px glyphs: `text.align-{top,middle,bottom,justified}`. The **T** tool slot is the registry's `tool.text` (T) and lights up when the engine's `setTool("TEXT")` answers OK (probed at mount).
- **Picker "On this page"**: the DS ColorPicker's document colours are the current page's solid colours (`pageColors`).
- **DS additions** (additive): `NumericInput valueLabel` (text shown instead of the number while not focused); the icons above.
- **Fixture** `?editor&doc=types` (`fixtures.ts TYPES_DOCUMENT`): an auto-layout frame (Fixed, Fill and "Ignore auto layout" children), a frame with constrained children, a vector, a boolean, a text layer.
- **Tests**: `__tests__/panels.test.ts` (sizing, limits, constraints clicks and visibility, Selection colors grouping / visibility / recolouring, line height, type labels and glyphs) and four new wasm cases (real types through the controller, Fill / Hug / max reaching the engine's layout and undo, constraints moving a child on resize and Ignore auto layout, Selection colors on the sample frame recolouring two layers in one step, page colours).
- **Screenshots** (dark): `/tmp/designer-work/editor/16-types-auto-layout`, `17-width-menu`, `18-auto-layout-settings`, `19-fill-child-min-width`, `20-constraints`, `21-selection-colors`, `22-vector`, `23-text`, `24-type-settings` (`-dark.png`).

Unverified against a Figma screenshot (no references in the repo): the "See all N colors" threshold (3), the popover titles "Auto layout settings" / "Type settings" and their row order, the advanced-settings glyph (`24.adjust.small`), the constraints widget's size, "Vector path" (from the owner's reference, per the round's brief).

## Round 2 (2026-10-06), and the lists that still apply (Partial, Needed, Next are current)

The editor UI is built and runs end to end in a browser: `npx vite --config vite.web.config.ts --mode demo --port 5202`, then `http://localhost:5202/?editor` (the engine's sample), `?editor&doc=reference` (the owner's file "burakkoc" as in the reference screenshots), `?editor&doc=empty`, or `?editor&file=<fileKey>` (a file on the store: the desktop's editor tabs; in a browser the dev store's demo files). `npm run typecheck`, `npm run lint` and `npm test` are green for the whole repo at handoff (the editor's: 43 tests; after the round-2 follow-ups `main.tsx`/app may be red while the desktop agent removes legacy code — not the editor).

### Done (built, looked at in screenshots, driven with playwright)

- **Mount** (`EditorApp.tsx`, named + default export, `{ source, onBackToFiles?, onReady?, initialView? }`; public entry `editor/index.ts`): `source.load()` → `Engine.create` → `engine.load` → `EngineStore` → `EditorController` → `CanvasController({ shortcuts: [] })` → every commit to `source.onChanges(message, { kind, label })` → `onExternalChanges` applied as "remote", `onMetaChanged` → the header's name → keyboard, clipboard, canvas menu, desktop hooks, persistence → the file's saved camera/page (else zoom to fit, or `initialView`). The `<canvas>` is one element from the first render on (the panels are placeholders until the engine is up). Theme through `ds/theme.ts` (`useThemeRoot`, `engine.setTheme`). `TooltipManager` + `ToastHost` mounted. ⌘-wheel never zooms the page.
- **Route** (`EditorRoute.tsx`): memory sources for the sample / `doc=reference` / `doc=empty` (`fixtures.ts`); `&file=` opens the store's source (`openDocument` from `@/store`), once per file per page (StrictMode-safe, refcounted), closed after the last mount goes. `&rulers=0`. `window.__designerEditor` for scripts.
- **Layout shell**: rail 48 (Figma main menu, File, Assets, Insert, Resources, Settings), left panel 240 (resizable), canvas, right panel 240 (resizable, `data-panel="right"` for the colour picker), help button (24 from the window's right, centred with the toolbar), toolbar centred on the window (clamped inside the canvas when the panels are wide).
- **Main menu** (`menus.ts`, built from `commands.ts` when it opens, enablement and checks live): Back to files, Actions…, File / Edit / View / Object / Text / Arrange submenus, Preferences (Theme), Help and account.
- **Left panel** (`panels/LeftPanel.tsx`, `Pages.tsx`, `Layers.tsx`): file header (name ▾ → file menu incl. Rename — inline field, `source.rename` —, Save to version history, Show version history, Back to files; location; Minimize UI). Pages: PageRow list, current highlighted, click to switch, double-click rename, context menu (Rename / Duplicate / Delete / Go to page — CREATE/DUPLICATE/DELETE_PAGE with `{ page: "s:l" }`), search, "+", drag to reorder (`engine.moveNodes(…, "0:0", i)`). Layers: VirtualList + LayerRow, top first, type / auto-layout glyphs, strong top-level frames, click / ⇧ range / ⌘ toggle, selection runs, selected-ancestor fill, hover ↔ canvas outline, double-click / ⌘R / Enter rename with Tab to the next row, lock / eye, chevrons (⌥ opens every level), drag reorder/reparent with the drop indicator (`dropTarget` → `engine.moveNodes`), reveal + scroll to a canvas selection, right click → the canvas menu. Assets tab: search + empty state.
- **Rulers** (`canvas/Rulers.tsx`): two 2D canvases redrawn on camera / selection / page / node changes / theme / resize (never React state per frame); colours `canvasChrome.ruler*`, metrics `canvasChromeMetrics.ruler`; labels every `rulerStep(zoom)` centred on 4px ticks; 0 at the selection's top-level frame corner; selection band with blue edge labels, neighbours faded (`labelAlpha`); ⇧R.
- **Right panel** (`panels/RightPanel.tsx`): header 48 (avatar ▾ with Theme, Present ▸ ▾, Share), Design / Prototype tabs, zoom menu ("87% ⌄": zoom in/out/fit/selection/50/100/200, view toggles, Property labels). **Design panel** (`panels/design/`): nothing selected → Page (colour + opacity + eye; the engine's dark default shown as #1E1E1E), Styles, Export; a selection → type header (Frame ▾ with presets / Rectangle / Ellipse / Group / Mixed), Position (6 align buttons, X / Y, rotation + rotate 90° / flip H / flip V), Layout or Auto layout (+ / − ; direction, AlignmentMatrix, gap, horizontal / vertical padding; W / H, Constrain proportions when the engine keeps it, Clip content), Appearance (opacity, corner radius, individual corners, visibility, blend mode), Fill and Stroke (rows top first: ColorInput, eye, minus; "+"; "Click + to replace mixed fills"; stroke position + weight; the DS **ColorPicker**, SOLID only), Effects, Layout guide (frames), Export. Every edit is one undo step; scrubs/picker drags are one open transaction (`ed.edit`), Esc cancels; Mixed fields step each layer (`onStep`); Property labels.
- **Bottom toolbar** (`canvas/BottomToolbar.tsx`): DS `EditorToolbar`; the engine's tool drives the active slot, slots remember their last tool (by click or key); tools the engine doesn't implement are passed as `disabledTools`; modes Draw / Motion / Dev Mode disabled.
- **Canvas context menu** (`canvas/CanvasMenu.tsx`): built from the engine's `CONTEXT_MENU` event (the engine selects what a left click would pick first, also on ⌃-click); Copy, Paste here (at the point), Paste over selection, Copy/Paste as ▸, arrange, Group / Frame selection / Ungroup, Show/Hide, Lock/Unlock, Flip, Add auto layout, Duplicate, Delete, Select layer ▸ (the event's `hits`, flattened, innermost first); empty canvas: Paste here, Show/Hide UI, Rulers, Select all.
- **Shortcuts dialog** (`ShortcutsDialog.tsx`, ⌃⇧? and the help button): the registry's keys by group + the engine's canvas keys. **⌘\\** hides all UI, **⇧\\** minimizes it into two floating cards (`panels/Minimized.tsx`).
- **Version history** (`VersionDialogs.tsx`): ⌥⌘S "Save to version history" (title, description) and "Show version history" (newest first, Restore = `restoreVersion` applied as one "Restore version" edit); enabled when the source has them.
- **Persistence** (`persistence.ts`): restores `source.uiState` (page, camera, selection, panel widths) on open and writes it as it changes; saves a thumbnail of the first page (the engine's offscreen `renderThumbnailPixels`, the content's own aspect, no overlays, within 800 × 600 PNG) 4 s after the last change and on close — the pixels are taken synchronously, so the close-time one is read before the engine goes.
- **Desktop hooks** (`desktop.ts`, only when `window.designer.role === "editor"`): `tab.onFlush` → `source.flush()`; `menu.onCommand` → `runEditorCommand` with the editor's own ids (`edit.*` natively in a focused text field; `file.save` flushes); `menu.setState` patches of every registry command's enabled / checked, at most once a frame after selection / undo / tool / pages / structure / node / UI changes; `tab.report({ title, status })` with the file's name, again on rename; a file trashed or deleted elsewhere closes its tab. "Back to files" = `onBackToFiles`, else `nav.goHome()`.
- **Engine API**: every command (incl. FLIP_*, SELECT_INVERSE ⇧⌘A, page commands with `{ page: "s:l" }`) and `moveNodes` / `encodeSelection` / `paste` / `renderThumbnailPixels` / the `CONTEXT_MENU` event are called directly; `engineCompat.ts` is field detection only (`supportsField`). The TS flip fallback is gone.
- **Registry ↔ app menu**: every id the desktop's menu bar places exists in `commands.ts` (incl. `file.save-version`, `file.export-frames-to-pdf`, `edit.copy-as-text`, `vector.*` with Figma's keys, disabled until implemented); the main menu has a Vector submenu.
- **Tests**: `__tests__/editor.wasm.test.ts` (the real engine headless: Layers tree, reference fixture, labelled edit = one undo step reaching the source, scrub = one step, Esc rollback, registry commands, flip, menus, moveNodes with the panel's drop target, copy/paste, page commands, menu-state patches, select inverse, CONTEXT_MENU → the menu, tool/glyph/type helpers) + the earlier model tests.

### Visual / end-to-end check

`node src/renderer/src/editor/tools/editor-shot.mjs [outDir]` (own Vite server, or `EDITOR_URL=http://localhost:5202`; playwright-core, SwiftShader, 1512 × 945, dark and light). Checks (all ok at handoff): click selects Frame 1; ⇧A auto layout; ⇧\\ / ⌘\\ / ⌃⇧?; F + drag frame; R + drag rectangle inside it; Layers rows; Esc → parent → nothing; ⌘Z / ⇧⌘Z; Layers click selects; double-click rename; X field moves; Delete; the source got every change; a store file opens, ⌥⌘S version listed, thumbnail saved, the change and the camera survive a reload. Screenshots in `/tmp/designer-work/editor/`:

- `01-nothing-{dark,light}.png` (reference file, nothing selected), `02-frame-selected-*`, `03-auto-layout-*`, `04-sample-rectangle-*`, `05-context-menu-*`, `06-main-menu-*` (Object submenu), `07-zoom-menu-*`
- dark only: `08-minimized`, `09-hidden`, `10-shortcuts`, `11-drawn-frame`, `12-drawn-rectangle`, `13-after-edits`, `14-store-file`, `15-version-history`
- dark only, round 3 (`?editor&doc=types`; checks: W reads 320 / H reads Hug, the W menu's items, Hug contents writes the sizing, the settings popover, a Fill child reads Fill, Ignore auto layout shows, Add min width… adds the limit and its row, Constraints show and the widget writes ⇧-both, Selection colors, "Vector path", Typography): `16-types-auto-layout` … `24-type-settings`

Compared with the measurements in `docs/research/visual-diff.md` (no reference images available): rail 48, panels 240, header 64, section headers 40, page pitch 32 / highlight 24 inset 8, layer rows 24, right header 48 + tabs 32 (line at 80), Share ending 8 from the edge, toolbar centred on the window 12 from the bottom, help 24 from the right — match.

### Partial / placeholders

- Prototype tab: an empty state. Assets: search + empty state. Insert / Resources rail items, Actions (⌘K), Present, Share: toasts.
- Export "+" stays disabled until the engine exports (engine_export); its rows aren't built.
- W / H are disabled for groups (the engine refits groups to their children; a group resize from the panel would scale the children — not built).
- The picker's Libraries tab (variables, styles) is empty until E6; "Paste to replace" (⇧⌘R) and image fills copied between files (Image.dataBlob) aren't built.
- Grid auto layout (the flow's fourth option) waits for the engine's GRID; text baseline alignment is written but the engine lays BASELINE out as MIN until E3.
- Typography: the font list is the file's families + Inter and the styles a fixed list until the fonts process (E3) lists them; mixed text runs (`styleOverrideTable`) aren't shown per range.
- Frame titles and the size badge's number on the canvas wait for E3 text (the badge draws empty).
- Versions: no view-only "open version", rename or duplicate-from-version UI.

### Needed from other workstreams

- **Engine (E4/E5, round 4)**:
  - Vector edit: the selected points' **positions and corner radius** (in `VECTOR_EDIT` or a read) and a write for them (`setVectorPoints({x?, y?, cornerRadius?})` or commands) — the panel's X / Y / radius are disabled until then; per-endpoint caps for open paths (Figma's **Start point / End point**: today only the node's `strokeCap`, so the panel shows one "Cap"); **Lasso** and **Paint bucket** tools (`setVectorEditTool` takes MOVE / PEN / BEND).
  - The committed wasm is E3: E4/E5's commands, tools, `startVectorEdit`, `startPaintEdit`, `setImageSource` aren't in it yet; the editor enables each as it appears (re-run `EDITOR_ONLY=paints node …/editor-shot.mjs` after the engine's release build).

- **DS**: the disabled modes don't look disabled in the light theme.
- **Engine**:
  - **A change to `minSize` / `maxSize` alone doesn't run layout** (setting max width 120 on a hugging 700-wide frame leaves it 700 until another layout field changes). The editor writes the clamped `size` with the limit as a workaround (`model/sizing.ts withLimit`); the engine should mark layout dirty for these fields.
  - Types it doesn't know read back as NONE and a duplicate / paste / undo of such a layer is emitted as NONE, so the editor's real-type map (`noteSourceTypes`) only covers what the file and remote changes carry. Keeping unknown types (and `booleanOperation`) as opaque values would fix it for good.
  - Layout doesn't run at load (`?editor&doc=types`'s Fill child stays 100 wide until something changes).
  - E3: when the text fields reach `codec.ts NodeFields`, drop their twins from `panels/design/shared.ts ExtraFields`; the Typography controls and the W / H "Hug" for text enable themselves through `supportsField`. Frame titles and the size badge's number also wait for it. E4 vectors / booleans for the Vector menu; effects / layout guides / export fields.

### Next steps

1. Viewing a reference screenshot again (when the owner re-shares them) and tuning pixel details with `tools/editor-shot.mjs` (the round-3 items listed as unverified above first).
2. Text (E3): re-check `docs/engine-build.md`; when the wasm keeps the text fields, try Typography on `?editor&doc=types` (the Heading layer), wire text editing (double-click / Enter into the engine's text mode), a fonts list from the fonts process, and the Text submenu's commands (`text.*` in `commands.ts`).
3. After the engine's E4/E5 release build: run `EDITOR_ONLY=paints node src/renderer/src/editor/tools/editor-shot.mjs` (Union, vector edit, gradient handles, images drawn), look at the canvas in the screenshots, then wire the vector points' X / Y / radius and Start / End point when the engine publishes them. Export rows with engine_export; Grid flow with the engine's GRID.

---

## Structure

```
editor/
  index.ts             public entry: EditorApp, DocumentSource, memoryDocumentSource
  EditorApp.tsx        the root: engine mount, layout, overlays
  EditorRoute.tsx      ?editor: memory sample / &doc=reference|empty / &file=<fileKey> (store)
  fixtures.ts          the reference and empty documents
  documentSource.ts    DocumentSource, memoryDocumentSource, applyMessage
  engineCompat.ts      feature detection: supportsField / keepsField, hasCommand, engineMethod
  images.ts            ImageStore, import (4096 cap, SHA-1), ImageService (REQUEST_IMAGE, object URLs)
  placeImages.ts       images → rectangles pasted at a point / like a paste
  vectorEdit.ts        VectorEditor (VECTOR_EDIT, tools, mirroring), gradient handles (startPaintEdit)
  controller.ts        EditorController, EditorContext, readTree
  uiStore.ts           Store<T>, UIState
  hooks.ts             useUI, useLayerTree, usePages, useNodes, useTopics
  commands.ts          the command registry (menus, shortcuts, buttons, the app menu)
  menus.ts             main menu and canvas menu entries from the registry
  keyboard.ts          the shortcut layer
  clipboardIO.ts       DOM clipboard events
  actions.ts           TS edits (flip fallback, rotate, zoom), geometry reads
  desktop.ts           window.designer hooks: flush, menu commands and state, tab title
  persistence.ts       UI state per file, thumbnails
  ShortcutsDialog.tsx  VersionDialogs.tsx
  panels/              Rail, LeftPanel, Pages, Layers, RightPanel, Minimized, design/ (DesignPanel, Sections, Sizing,
                       Constraints, Paints, Stroke, Effects, VectorPoints, SelectionColors, Typography, shared)
  canvas/              Rulers, BottomToolbar (+ the vector-edit toolbar), CanvasMenu, ImagePlacer
  tools/editor-shot.mjs  the visual + end-to-end check (playwright-core)
  model/               pure logic: layerTree, mixed, geometry, color, clipboard, rulers, sizing, constraints,
                       selectionColors, paints
  __tests__/           vitest: model, layerTree, panels (Phase 2 rules), paints (E4/E5 rules), the editor on the headless engine
```

## The DocumentSource interface

```ts
export interface DocumentSource {
  readonly fileName: string;          // the left panel's header ("burakkoc")
  readonly location: string;          // "Drafts", a folder's name
  readonly sessionID?: number;        // new nodes' session (storage allocates it); default 1
  load(): Promise<Message>;           // a snapshot Message (DOCUMENT first, parents before children)
  onChanges(changes: Message, info?: { kind?: "USER" | "UNDO" | "REDO" | "SYSTEM"; label?: string }): void;
  flush(): Promise<void>;             // every change handed to onChanges is stored
  rename?(name: string): void | Promise<void>;
  // Optional (round 2; the store's source has them all):
  onExternalChanges?(listener: (changes: Message) => void): () => void;   // applied as "remote"
  onMetaChanged?(listener: (meta: { fileName; location; trashed?; deleted? }) => void): () => void;
  close?(): Promise<void>;
  readonly uiState?: EditorUiState | null;        // page, camera + selection per page, panel widths
  setUiState?(patch: Partial<EditorUiState>): void;
  saveThumbnail?(png: Uint8Array, size: { width: number; height: number }): Promise<void>;
  listVersions?(): Promise<VersionInfo[]>;
  saveVersion?(input?: { title?: string; description?: string }): Promise<VersionInfo>;
  restoreVersion?(id: string, apply: (diff: Message) => void | Promise<void>): Promise<VersionInfo>;
  readonly images?: ImageStore;       // round 4: { put(bytes, mime) → sha1 hex, get(sha1) → bytes | null }
}
```

`memoryDocumentSource(doc, { fileName?, location?, sessionID? })` adds `snapshot(): Message` and `changes: readonly Message[]`. The store integration supplies its own source; nothing else in the editor changes.

## How panels bind to the engine

- **Reads**: `useSelection(store)` (engine/hooks) for the refs, `useNodes(refs)` for their fields (re-read only after NODES_CHANGED/DOCUMENT_CHANGED touched them, so canvas drags update the panel live), `useLayerTree()` for Layers, `usePages()`, `useCamera`/`store.subscribe("camera")` (rulers and the zoom %, imperatively — never React state per frame), `useHover`, `useTool`, `useUndoState`.
- **Writes**: always `setProps` (generic setter), as one labelled undo step (`ed.setProps(refs, fields, label)` / `ed.batch`). Gestures from DS fields (`ChangeInfo.final === false` while scrubbing) go through `ed.edit(label, info, write)`: one open transaction, committed with the final value; `onCancel` → `ed.cancelEdit()`. Multi-selection edits that differ per node (X, rotation, `onStep` deltas) write each node inside one `batch`.
- **Mixed**: derived in TS from every selected node (`model/mixed.ts`).
- **Fields the engine doesn't keep yet**: `supportsField()` — the control shows disabled instead of writing into the void (`engine_set_props` answers E_INVALID when no known field is left).
- **Types the engine doesn't know yet**: panels read nodes through `ed.withRealType` (`useSelectedNodes`, `useParents`, the Layers tree), which puts back the file's own type where the engine reads NONE.

## Keyboard

`CanvasController` gets `shortcuts: []`; `keyboard.ts` is the only table. Order: field / menu / dialog → engine (`engine.key`, which handles Space, Esc, arrows, Enter, ⇧Enter, Tab, ⇧Tab) → `commands.ts`. ⌘C ⌘X ⌘V ⇧⌘V are not prevented, so the browser (and the app menu's Edit roles) fire DOM clipboard events; ⇧⌘V sets `pendingPaste = {mode: "inPlace"}` first.

## Measured layout (references `images/1–4.webp`, 1 CSS px = 1.3228 image px)

- Rail 48 (Figma menu, separator, File, Assets, +, briefcase, separator, settings); left panel 240: header 64 (name 13/22 550 + chevron, "Drafts" below; Minimize-UI icon right), Pages header 40 (search, +), page rows 32 pitch with a 24 highlight inset 8, Layers header 40, layer list starts 8 below the header, rows 24.
- Rulers 20 (top and left, over the canvas); at 100% a label every 50; with a frame selected the ruler's 0 moves to its corner, the band is drawn in `rulerSelectionBand`, edge labels in `rulerSelectionText` outside the band, neighbouring labels faded/hidden.
- Right panel 240: header 48 (avatar + chevron at 16; Present ▸ + chevron; Share 55×32 ending 8 from the edge), tabs row 32 (Design active, Prototype; "100% ⌄" right), divider at 80. Sections: header 40 (title at 16, actions in the 24 column 8 from the right), fields 88/88 + 24 action column; fill rows: field 156, then eye and minus (24 each, 4 apart).
- Toolbar 48, radius 13, 12 from the bottom, centred on the window; help button 32, centred with the toolbar (20 from the bottom), 24 from the right edge of the window (over the right panel).

## Gaps (by design, until the engine or DS has them)

the Text menu's commands, export (engine_export), the vector points' positions / radius and per-end caps (engine), components (E6), prototype tab content, Quick actions (⌘K), group resize from the panel, the pages-panel height splitter.
